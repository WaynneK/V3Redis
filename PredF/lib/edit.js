/*
 * edit.js — Édition d'un PDF (outil « Modifier ») : processus principal, pdf-lib, aucun accès réseau.
 *
 * L'interface décrit les modifications page par page (« plan ») ; ce module les applique AU DOCUMENT
 * D'ORIGINE (signets, liens, formulaires, propriétés conservés) :
 *   - objets ajoutés : textes (avec, pour un texte existant modifié, le cache qui recouvre l'ancien),
 *     images et signatures, rectangles, ellipses, lignes, flèches, dessins à main levée, surlignage, caches ;
 *   - formulaire : valeurs des champs (texte, cases, choix), aplatissement facultatif ;
 *   - pages : ordre, suppression, duplication, pages blanches ;
 *   - caviardage : les pages concernées sont remplacées par leur image (rasterizePages), le contenu masqué
 *     disparaît vraiment du fichier.
 *
 * Coordonnées du plan : points PDF dans le repère de la page TELLE QU'ELLE S'AFFICHE (rotation /Rotate
 * comprise), origine en haut à gauche, y vers le bas — celui de l'aperçu pdf.js à l'échelle 1.
 *
 *   fonts()                                  → familles de polices proposées
 *   editPdf(bytes, plan, images, options)    → octets du PDF modifié
 *   rasterizePages(bytes, pages)             → pages remplacées par des images (caviardage)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
  degrees,
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setLineJoin,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { PdfError, loadPdf, detectType, inspectImage, dropUnreachable } = require('./engine.js');
const { removeTextFromPage } = require('./textremove.js');

// ---------------------------------------------------------------------------
// Polices : fichiers du système (tous les caractères), sinon polices standard des PDF
// ---------------------------------------------------------------------------

/**
 * Familles proposées. files : [normal, gras, italique, gras italique] cherchés dans les dossiers de polices
 * du système ; std : polices standard des PDF (alphabet latin seulement) si les fichiers manquent.
 */
const FAMILIES = [
  {
    name: 'Arial',
    css: "Arial, 'Liberation Sans', 'DejaVu Sans', Helvetica, sans-serif",
    files: [
      ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
      ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf'],
      ['Arial.ttf', 'Arial Bold.ttf', 'Arial Italic.ttf', 'Arial Bold Italic.ttf'],
    ],
    std: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  },
  {
    name: 'Calibri',
    css: "Calibri, Carlito, 'Liberation Sans', sans-serif",
    files: [
      ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
      ['Carlito-Regular.ttf', 'Carlito-Bold.ttf', 'Carlito-Italic.ttf', 'Carlito-BoldItalic.ttf'],
    ],
    std: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  },
  {
    name: 'Verdana',
    css: "Verdana, 'DejaVu Sans', sans-serif",
    files: [
      ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
      ['Verdana.ttf', 'Verdana Bold.ttf', 'Verdana Italic.ttf', 'Verdana Bold Italic.ttf'],
      ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans-Oblique.ttf', 'DejaVuSans-BoldOblique.ttf'],
    ],
    std: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  },
  {
    name: 'Times New Roman',
    css: "'Times New Roman', 'Liberation Serif', 'DejaVu Serif', Times, serif",
    files: [
      ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
      ['LiberationSerif-Regular.ttf', 'LiberationSerif-Bold.ttf', 'LiberationSerif-Italic.ttf', 'LiberationSerif-BoldItalic.ttf'],
      ['Times New Roman.ttf', 'Times New Roman Bold.ttf', 'Times New Roman Italic.ttf', 'Times New Roman Bold Italic.ttf'],
    ],
    std: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  },
  {
    name: 'Georgia',
    css: "Georgia, 'DejaVu Serif', serif",
    files: [
      ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
      ['Georgia.ttf', 'Georgia Bold.ttf', 'Georgia Italic.ttf', 'Georgia Bold Italic.ttf'],
      ['DejaVuSerif.ttf', 'DejaVuSerif-Bold.ttf', 'DejaVuSerif-Italic.ttf', 'DejaVuSerif-BoldItalic.ttf'],
    ],
    std: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  },
  {
    name: 'Courier New',
    css: "'Courier New', 'Liberation Mono', 'DejaVu Sans Mono', Courier, monospace",
    files: [
      ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
      ['LiberationMono-Regular.ttf', 'LiberationMono-Bold.ttf', 'LiberationMono-Italic.ttf', 'LiberationMono-BoldItalic.ttf'],
      ['Courier New.ttf', 'Courier New Bold.ttf', 'Courier New Italic.ttf', 'Courier New Bold Italic.ttf'],
    ],
    std: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  },
];
const DEFAULT_FAMILY = 'Arial';

/** Dossiers de polices du système (Windows, Linux, macOS). */
function fontDirs() {
  if (process.platform === 'win32') {
    const dirs = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')];
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
    return dirs;
  }
  if (process.platform === 'darwin') return ['/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(process.env.HOME || '', 'Library/Fonts')];
  return [
    '/usr/share/fonts/truetype/msttcorefonts',
    '/usr/share/fonts/truetype/liberation',
    '/usr/share/fonts/truetype/liberation2',
    '/usr/share/fonts/liberation',
    '/usr/share/fonts/truetype/crosextra',
    '/usr/share/fonts/truetype/dejavu',
    '/usr/share/fonts/TTF',
    '/usr/share/fonts/dejavu',
  ];
}

let resolved = null;
/** Pour chaque famille : chemins des 4 variantes trouvées sur cet ordinateur, ou null. */
function resolveFonts() {
  if (resolved) return resolved;
  resolved = new Map();
  const dirs = fontDirs();
  for (const fam of FAMILIES) {
    let found = null;
    for (const set of fam.files) {
      for (const dir of dirs) {
        const files = set.map((f) => path.join(dir, f));
        if (fs.existsSync(files[0])) {
          // Variante absente (gras italique…) : la plus proche disponible
          found = files.map((f, i) => (fs.existsSync(f) ? f : fs.existsSync(files[i & 1]) ? files[i & 1] : files[0]));
          break;
        }
      }
      if (found) break;
    }
    resolved.set(fam.name, found);
  }
  return resolved;
}

/** Familles proposées à l'interface : nom, pile CSS, police du système trouvée (sinon alphabet latin seulement). */
function fonts() {
  const map = resolveFonts();
  return FAMILIES.map((f) => ({ name: f.name, css: f.css, unicode: Boolean(map.get(f.name)) }));
}

const fileCache = new Map(); // chemin → octets

/** Polices intégrées à un document, à la demande (une seule fois par variante). */
function fontStore(doc) {
  const embedded = new Map();
  let kitReady = false;
  return async function get(family, bold, italic) {
    const fam = FAMILIES.find((f) => f.name === family) || FAMILIES.find((f) => f.name === DEFAULT_FAMILY);
    const variant = (bold ? 1 : 0) + (italic ? 2 : 0);
    const key = `${fam.name}:${variant}`;
    if (!embedded.has(key)) {
      const files = resolveFonts().get(fam.name);
      let font = null;
      if (files) {
        try {
          if (!kitReady) {
            doc.registerFontkit(fontkit);
            kitReady = true;
          }
          if (!fileCache.has(files[variant])) fileCache.set(files[variant], fs.readFileSync(files[variant]));
          font = { font: await doc.embedFont(fileCache.get(files[variant]), { subset: true }), unicode: true };
        } catch {
          font = null; // fichier illisible : police standard
        }
      }
      if (!font) font = { font: await doc.embedFont(fam.std[variant]), unicode: false };
      embedded.set(key, font);
    }
    return embedded.get(key);
  };
}

/** Polices de secours (symboles ✓ ★ →, alphabets étendus) pour les caractères absents de la police choisie. */
const FALLBACK_FILES = ['seguisym.ttf', 'segoeui.ttf', 'arialuni.ttf', 'Arial Unicode.ttf', 'DejaVuSans.ttf'];

/** Le glyphe existe-t-il dans cette police intégrée (police du système) ? */
function hasGlyph(entry, cp) {
  try {
    const kit = entry.font.embedder && entry.font.embedder.font;
    return kit ? kit.hasGlyphForCodePoint(cp) : true;
  } catch {
    return true;
  }
}

/** Polices de secours d'un document, intégrées à la première utilisation. */
function fallbackStore(doc) {
  let list = null;
  return async function fallbacks() {
    if (list) return list;
    list = [];
    for (const dir of fontDirs()) {
      for (const name of FALLBACK_FILES) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file) || list.some((f) => f.file === name)) continue;
        try {
          doc.registerFontkit(fontkit);
          if (!fileCache.has(file)) fileCache.set(file, fs.readFileSync(file));
          list.push({ file: name, font: await doc.embedFont(fileCache.get(file), { subset: true }), unicode: true });
        } catch {
          // police illisible : ignorée
        }
      }
    }
    return list;
  };
}

/** Ligne découpée en passages d'une même police (police choisie, ou de secours pour les caractères absents). */
async function textRuns(entry, text, fallbacks) {
  if (!entry.unicode) return [{ font: entry.font, text }];
  const runs = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let font = entry.font;
    if (cp > 32 && !hasGlyph(entry, cp)) {
      const alt = (await fallbacks()).find((f) => hasGlyph(f, cp));
      if (alt) font = alt.font;
    }
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += ch;
    else runs.push({ font, text: ch });
  }
  return runs;
}

/** Texte écrivable avec cette police ; sinon erreur claire (police standard : alphabet latin seulement). */
function encodable(entry, text, family) {
  if (entry.unicode) {
    // Sous-ensembles fontkit : glyphes absents remplacés ; seuls les caractères de contrôle sont retirés
    return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  }
  for (const ch of text) {
    try {
      entry.font.encodeText(ch);
    } catch {
      throw new PdfError(`Le caractère « ${ch} » ne peut pas être écrit avec la police ${family} sur cet ordinateur (police standard des PDF, alphabet latin seulement). Choisissez une autre police ou retirez-le.`);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Vérification du plan envoyé par l'interface
// ---------------------------------------------------------------------------

const num = (v, min, max, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const color = (v, def = null) => (typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : def);
const toRgb = (hex) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
const COORD = 20000; // points : bien au-delà de la plus grande page autorisée

function cleanObject(o) {
  if (!o || typeof o !== 'object') return null;
  const box = () => ({ x: num(o.x, -COORD, COORD), y: num(o.y, -COORD, COORD), w: num(o.w, 0, COORD), h: num(o.h, 0, COORD) });
  const opacity = num(o.opacity, 0.05, 1, 1);
  switch (o.type) {
    case 'text': {
      const lines = (Array.isArray(o.lines) ? o.lines : []).slice(0, 2000).map((l) => String(l).slice(0, 5000));
      const cover = o.cover && typeof o.cover === 'object' ? { x: num(o.cover.x, -COORD, COORD), y: num(o.cover.y, -COORD, COORD), w: num(o.cover.w, 0, COORD), h: num(o.cover.h, 0, COORD), color: color(o.cover.color, '#ffffff') } : null;
      const size = num(o.size, 1, 500, 12);
      return {
        type: 'text',
        x: num(o.x, -COORD, COORD),
        y: num(o.y, -COORD, COORD),
        w: num(o.w, 0, COORD),
        lines,
        size,
        lineHeight: num(o.lineHeight, size * 0.5, size * 5, size * 1.2),
        baseline: num(o.baseline, 0, size * 5, size * 0.95),
        font: FAMILIES.some((f) => f.name === o.font) ? o.font : DEFAULT_FAMILY,
        bold: Boolean(o.bold),
        italic: Boolean(o.italic),
        underline: Boolean(o.underline),
        align: ['left', 'center', 'right'].includes(o.align) ? o.align : 'left',
        color: color(o.color, '#000000'),
        opacity,
        cover,
        erase: Boolean(o.erase && cover), // texte d'origine retiré du contenu de la page
      };
    }
    case 'image':
      return { type: 'image', ...box(), image: String(o.image || ''), opacity };
    case 'rect':
    case 'ellipse':
      return { type: o.type, ...box(), stroke: color(o.stroke), fill: color(o.fill), width: num(o.width, 0, 50, 2), opacity };
    case 'line':
    case 'arrow':
      return { type: o.type, x1: num(o.x1, -COORD, COORD), y1: num(o.y1, -COORD, COORD), x2: num(o.x2, -COORD, COORD), y2: num(o.y2, -COORD, COORD), stroke: color(o.stroke, '#000000'), width: num(o.width, 0.25, 50, 2), opacity };
    case 'ink': {
      const pts = (Array.isArray(o.points) ? o.points : []).slice(0, 40000).map((v) => num(v, -COORD, COORD));
      return pts.length >= 2 ? { type: 'ink', points: pts.length % 2 ? pts.slice(0, -1) : pts, stroke: color(o.stroke, '#000000'), width: num(o.width, 0.25, 50, 2), opacity } : null;
    }
    case 'highlight':
      return { type: 'highlight', ...box(), color: color(o.color, '#ffe14d'), opacity: num(o.opacity, 0.05, 1, 0.4) };
    case 'redact':
      return { type: 'redact', ...box() };
    default:
      return null;
  }
}

/**
 * plan : {
 *   pages: [{ src: indice de la page d'origine | null (page blanche), width, height, objects: [...] }],
 *   form:  { values: { nom du champ: texte | true/false | [choix] }, flatten } | null
 * }
 */
function cleanPlan(plan, pageCount) {
  if (!plan || !Array.isArray(plan.pages) || !plan.pages.length) throw new PdfError('Le document doit garder au moins une page.');
  if (plan.pages.length > 20000) throw new PdfError('Trop de pages (20 000 au maximum).');
  let objects = 0;
  const pages = plan.pages.map((p) => {
    const blank = p.src === null || p.src === undefined;
    const src = blank ? null : Number(p.src);
    if (!blank && (!Number.isInteger(src) || src < 0 || src >= pageCount)) throw new PdfError('Page inexistante dans le document.');
    const list = (Array.isArray(p.objects) ? p.objects : []).map(cleanObject).filter(Boolean);
    objects += list.length;
    return { src, width: num(p.width, 36, 14400, 595.28), height: num(p.height, 36, 14400, 841.89), objects: list };
  });
  if (objects > 50000) throw new PdfError('Trop de modifications (50 000 objets au maximum).');
  let form = null;
  if (plan.form && plan.form.values && typeof plan.form.values === 'object') {
    const values = {};
    for (const [k, v] of Object.entries(plan.form.values).slice(0, 5000)) {
      values[String(k).slice(0, 500)] = typeof v === 'boolean' ? v : Array.isArray(v) ? v.slice(0, 500).map((x) => String(x).slice(0, 2000)) : String(v ?? '').slice(0, 20000);
    }
    form = { values, flatten: Boolean(plan.form.flatten) };
  }
  return { pages, form };
}

// ---------------------------------------------------------------------------
// Dessin dans le repère « page affichée »
// ---------------------------------------------------------------------------

/**
 * Matrice du repère visuel (y vers le haut, origine en bas à gauche de la page AFFICHÉE) vers le repère
 * du PDF : rotation /Rotate et décalage de la zone visible (CropBox). Un texte dessiné droit dans ce repère
 * s'affiche droit, quelle que soit la rotation de la page.
 */
function visualMatrix(page) {
  const box = page.getCropBox();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const { x: bx, y: by, width: W, height: H } = box;
  if (r === 90) return { m: [0, 1, -1, 0, W + bx, by], VW: H, VH: W };
  if (r === 180) return { m: [-1, 0, 0, -1, W + bx, H + by], VW: W, VH: H };
  if (r === 270) return { m: [0, -1, 1, 0, bx, H + by], VW: H, VH: W };
  return { m: [1, 0, 0, 1, bx, by], VW: W, VH: H };
}

/** Pointe de flèche (triangle) au bout (x2, y2), en coordonnées visuelles (y vers le bas). */
function arrowHead(x1, y1, x2, y2, width) {
  const len = Math.max(8, width * 4.5);
  const a = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const p1 = [x2 - len * Math.cos(a - spread), y2 - len * Math.sin(a - spread)];
  const p2 = [x2 - len * Math.cos(a + spread), y2 - len * Math.sin(a + spread)];
  return { path: `M ${x2} ${y2} L ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]} Z`, back: len * Math.cos(spread) * 0.85 };
}

/**
 * Texte modifié : l'ancien texte est retiré du contenu de la page quand c'est possible (sinon il reste sous le
 * cache). Une zone vidée sans reste n'a plus besoin de son cache : le fond d'origine reste visible.
 */
function eraseOriginalText(page, objects) {
  const erasing = objects.filter((o) => o.type === 'text' && o.erase && o.cover && o.cover.w > 0 && o.cover.h > 0);
  if (!erasing.length) return;
  const { m, VH } = visualMatrix(page);
  const at = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const rects = erasing.map(({ cover: c }) => {
    const [ax, ay] = at(c.x, VH - c.y - c.h);
    const [bx, by] = at(c.x + c.w, VH - c.y);
    return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
  });
  const res = removeTextFromPage(page, rects);
  erasing.forEach((o, k) => {
    if (res.removed[k] > 0 && res.kept[k] === 0) o.skipCover = true;
  });
}

/** Dessine les objets d'une page. */
async function drawObjects(page, objects, ctx) {
  if (!objects.length) return;
  eraseOriginalText(page, objects);
  const { m, VH } = visualMatrix(page);
  // Repère visuel pour tout ce qui suit ; le contenu d'origine est isolé par pdf-lib (q … Q)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), setLineJoin(LineJoinStyle.Round));
  const Y = (v) => VH - v; // y visuel (vers le bas) → y du repère (vers le haut)
  for (const o of objects) {
    switch (o.type) {
      case 'text': {
        if (o.cover && !o.skipCover && o.cover.w > 0 && o.cover.h > 0) {
          page.drawRectangle({ x: o.cover.x, y: Y(o.cover.y + o.cover.h), width: o.cover.w, height: o.cover.h, color: toRgb(o.cover.color) });
        }
        const entry = await ctx.font(o.font, o.bold, o.italic);
        const col = toRgb(o.color);
        for (let i = 0; i < o.lines.length; i++) {
          const line = encodable(entry, o.lines[i], o.font);
          if (!line) continue;
          const runs = await textRuns(entry, line, ctx.fallbacks);
          const widths = runs.map((r) => r.font.widthOfTextAtSize(r.text, o.size));
          const tw = widths.reduce((a, b) => a + b, 0);
          const x = o.align === 'center' ? o.x + (o.w - tw) / 2 : o.align === 'right' ? o.x + o.w - tw : o.x;
          const base = o.y + i * o.lineHeight + o.baseline;
          let cx = x;
          runs.forEach((r, k) => {
            page.drawText(r.text, { x: cx, y: Y(base), size: o.size, font: r.font, color: col, opacity: o.opacity });
            cx += widths[k];
          });
          if (o.underline) {
            const t = Math.max(0.5, o.size / 16);
            page.drawLine({ start: { x, y: Y(base + o.size * 0.12) }, end: { x: x + tw, y: Y(base + o.size * 0.12) }, thickness: t, color: col, opacity: o.opacity });
          }
        }
        break;
      }
      case 'image': {
        const img = await ctx.image(o.image);
        page.drawImage(img, { x: o.x, y: Y(o.y + o.h), width: o.w, height: o.h, opacity: o.opacity });
        break;
      }
      case 'rect':
      case 'redact':
      case 'highlight': {
        const opts = { x: o.x, y: Y(o.y + o.h), width: o.w, height: o.h };
        if (o.type === 'redact') Object.assign(opts, { color: rgb(0, 0, 0) });
        else if (o.type === 'highlight') Object.assign(opts, { color: toRgb(o.color), opacity: o.opacity, blendMode: BlendMode.Multiply });
        else {
          if (!o.fill && !(o.stroke && o.width)) break;
          // Bordure dessinée à l'intérieur du cadre (comme à l'écran)
          const half = o.stroke && o.width ? o.width / 2 : 0;
          Object.assign(opts, { x: o.x + half, y: Y(o.y + o.h) + half, width: Math.max(0, o.w - 2 * half), height: Math.max(0, o.h - 2 * half) });
          if (o.fill) Object.assign(opts, { color: toRgb(o.fill), opacity: o.opacity });
          if (o.stroke && o.width) Object.assign(opts, { borderColor: toRgb(o.stroke), borderWidth: o.width, borderOpacity: o.opacity });
        }
        page.drawRectangle(opts);
        break;
      }
      case 'ellipse': {
        if (!o.fill && !(o.stroke && o.width)) break;
        const half = o.stroke && o.width ? o.width / 2 : 0;
        const opts = { x: o.x + o.w / 2, y: Y(o.y + o.h / 2), xScale: Math.max(0, o.w / 2 - half), yScale: Math.max(0, o.h / 2 - half) };
        if (o.fill) Object.assign(opts, { color: toRgb(o.fill), opacity: o.opacity });
        if (o.stroke && o.width) Object.assign(opts, { borderColor: toRgb(o.stroke), borderWidth: o.width, borderOpacity: o.opacity });
        page.drawEllipse(opts);
        break;
      }
      case 'line':
      case 'arrow': {
        const col = toRgb(o.stroke);
        let { x2, y2 } = o;
        if (o.type === 'arrow') {
          const head = arrowHead(o.x1, o.y1, o.x2, o.y2, o.width);
          page.drawSvgPath(head.path, { x: 0, y: VH, color: col, opacity: o.opacity });
          // Le trait s'arrête dans la pointe (pas de bout carré qui dépasse)
          const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
          if (len > head.back) {
            x2 = o.x2 - ((o.x2 - o.x1) / len) * head.back;
            y2 = o.y2 - ((o.y2 - o.y1) / len) * head.back;
          }
        }
        page.drawLine({ start: { x: o.x1, y: Y(o.y1) }, end: { x: x2, y: Y(y2) }, thickness: o.width, color: col, opacity: o.opacity, lineCap: LineCapStyle.Round });
        break;
      }
      case 'ink': {
        const p = o.points;
        let d = `M ${p[0]} ${p[1]}`;
        for (let i = 2; i + 1 < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`;
        if (p.length === 2) d += ` L ${p[0] + 0.01} ${p[1]}`; // simple point
        page.drawSvgPath(d, { x: 0, y: VH, borderColor: toRgb(o.stroke), borderWidth: o.width, borderOpacity: o.opacity, borderLineCap: LineCapStyle.Round });
        break;
      }
      default:
        break;
    }
  }
  page.pushOperators(popGraphicsState());
}

// ---------------------------------------------------------------------------
// Formulaire
// ---------------------------------------------------------------------------

/** Libellé pdf-lib d'une option de liste (l'interface envoie la valeur d'export). */
function optionLabel(field, value) {
  try {
    const raw = field.acroField.getOptions();
    const match = raw.find((o) => o.value.decodeText() === value);
    return match ? (match.display || match.value).decodeText() : value;
  } catch {
    return value;
  }
}

async function fillForm(doc, form, ctx) {
  let pdfForm;
  try {
    pdfForm = doc.getForm();
  } catch {
    return;
  }
  const font = (await ctx.font(DEFAULT_FAMILY, false, false)).font;
  let changed = false;
  for (const [name, value] of Object.entries(form.values)) {
    const field = pdfForm.getFieldMaybe(name);
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) {
        const text = String(value);
        const max = field.getMaxLength();
        field.setText(max !== undefined ? text.slice(0, max) : text);
      } else if (field instanceof PDFCheckBox) {
        if (value === true) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        const v = String(value);
        if (!v) field.clear();
        else if (field.getOptions().includes(v)) field.select(v);
      } else if (field instanceof PDFDropdown) {
        const v = optionLabel(field, Array.isArray(value) ? String(value[0] ?? '') : String(value));
        if (!v) field.clear();
        else if (field.getOptions().includes(v) || field.isEditable()) field.select(v);
      } else if (field instanceof PDFOptionList) {
        const list = (Array.isArray(value) ? value : [value]).map((v) => optionLabel(field, String(v))).filter((v) => field.getOptions().includes(v));
        if (!list.length) field.clear();
        else field.select(list.length > 1 && field.isMultiselect() ? list : list[0]);
      } else {
        continue;
      }
      changed = true;
    } catch (err) {
      throw new PdfError(`Champ « ${name} » : ${err.message}`);
    }
  }
  // Apparences recalculées avec une police qui couvre tous les caractères saisis
  if (changed || form.flatten) {
    try {
      pdfForm.updateFieldAppearances(font);
    } catch {
      // apparences gardées : les lecteurs PDF les recalculent (NeedAppearances)
    }
  }
  if (form.flatten) pdfForm.flatten({ updateFieldAppearances: false });
}

// ---------------------------------------------------------------------------
// Édition
// ---------------------------------------------------------------------------

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

/** Attributs hérités recopiés sur la page elle-même (elle peut alors changer de place dans l'arbre des pages). */
function pinInherited(page) {
  for (const key of INHERITABLE) {
    const name = PDFName.of(key);
    if (page.node.get(name) !== undefined) continue;
    const v = page.node.getInheritableAttribute(name);
    if (v !== undefined) page.node.set(name, v);
  }
}

/**
 * Applique un plan au document. images : { id: octets PNG/JPEG }.
 * Renvoie les octets du PDF modifié.
 */
async function editPdf(bytes, rawPlan, images = {}, { onProgress } = {}) {
  const doc = await loadPdf(bytes);
  const original = doc.getPages();
  const plan = cleanPlan(rawPlan, original.length);
  const font = fontStore(doc);
  const embedded = new Map();
  const ctx = {
    font,
    fallbacks: fallbackStore(doc),
    async image(id) {
      if (!embedded.has(id)) {
        const data = images[id];
        if (!data) throw new PdfError('Image introuvable : ajoutez-la à nouveau.');
        const b = new Uint8Array(data);
        const type = detectType(b);
        if (type !== 'png' && type !== 'jpg') throw new PdfError('Image non prise en charge (PNG ou JPEG attendu).');
        inspectImage(b); // dimensions lisibles
        embedded.set(id, type === 'png' ? await doc.embedPng(b) : await doc.embedJpg(b));
      }
      return embedded.get(id);
    },
  };

  // Formulaire d'abord (avant les copies de pages : les copies gardent les valeurs)
  if (plan.form) await fillForm(doc, plan.form, ctx);

  // Pages de sortie : page d'origine, copie (page utilisée plusieurs fois) ou page blanche.
  // Les copies sont faites AVANT tout dessin : une page dupliquée ne reçoit pas les ajouts de l'autre.
  const used = new Set();
  const out = [];
  for (const p of plan.pages) {
    if (p.src === null) {
      out.push(doc.addPage([p.width, p.height]));
    } else if (!used.has(p.src)) {
      used.add(p.src);
      out.push(original[p.src]);
    } else {
      const [copy] = await doc.copyPages(doc, [p.src]);
      out.push(copy); // ajoutée au document à la remise en ordre
    }
  }

  for (let i = 0; i < plan.pages.length; i++) {
    await drawObjects(out[i], plan.pages[i].objects, ctx);
    if (onProgress && (i % 10 === 9 || i === plan.pages.length - 1)) onProgress(i + 1, plan.pages.length);
  }

  // Ordre des pages : le document est réordonné seulement si besoin (pages supprimées, déplacées, ajoutées)
  const current = doc.getPages();
  const same = current.length === out.length && current.every((pg, i) => pg === out[i]);
  if (!same) {
    for (const pg of new Set([...current, ...out])) pinInherited(pg);
    for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
    for (const pg of out) doc.addPage(pg);
  }

  doc.setModificationDate(new Date());
  doc.setProducer('PredF (pdf-lib)');
  // Pages supprimées, anciennes versions : retirées du fichier (rien de supprimé ne doit y rester)
  dropUnreachable(doc);
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

/**
 * Caviardage : le contenu de certaines pages est remplacé par leur image (rendue par l'interface, caches noirs
 * compris). pages : [{ index, bytes: JPEG/PNG }].
 * La page reste le même objet (signets et liens qui y mènent gardés, taille et rotation aussi) ; son ancien
 * contenu, ses ressources et ses annotations (liens, commentaires, champs) disparaissent du fichier.
 */
async function rasterizePages(bytes, pages) {
  const doc = await loadPdf(bytes);
  const count = doc.getPageCount();
  for (const { index, bytes: img } of pages) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new PdfError('Page inexistante dans le document.');
    const b = new Uint8Array(img);
    const type = detectType(b);
    if (type !== 'png' && type !== 'jpg') throw new PdfError('Image de page invalide.');
    const page = doc.getPage(index);
    pinInherited(page);
    page.node.set(PDFName.of('Contents'), doc.context.obj([]));
    page.node.set(PDFName.of('Resources'), doc.context.obj({}));
    for (const key of ['Annots', 'Group', 'Thumb', 'PieceInfo', 'Metadata']) page.node.delete(PDFName.of(key));
    const image = type === 'png' ? await doc.embedPng(b) : await doc.embedJpg(b);
    const { m, VW, VH } = visualMatrix(page);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
    page.drawImage(image, { x: 0, y: 0, width: VW, height: VH });
    page.pushOperators(popGraphicsState());
  }
  dropUnreachable(doc);
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

module.exports = { fonts, editPdf, rasterizePages, cleanPlan, visualMatrix, FAMILIES };
