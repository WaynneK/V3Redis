/*
 * engine.js — Moteur PDF de PredF (processus principal, pdf-lib, aucun accès réseau).
 *
 * Toutes les opérations partent d'octets en mémoire et renvoient des octets : le processus principal
 * lit et écrit les fichiers, l'interface ne fait qu'afficher les pages (pdf.js).
 *
 *   inspect(bytes)                      → nombre de pages, tailles, propriétés
 *   buildPdf(items, getSource, options) → un PDF à partir de pages existantes, d'images ou de pages blanches
 *                                         (fusion, organisation, extraction, découpe, images → PDF)
 *   createRasterJob()                   → PDF fait d'images de pages (compression)
 *   stampPdf(bytes, options)            → numéros de page, filigrane, propriétés
 *   optimizePdf(bytes)                  → réécriture sans perte (objets inutilisés retirés, flux d'objets)
 */
'use strict';

const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

class PdfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfError';
  }
}

const MM = 72 / 25.4; // points par millimètre

/** Formats de page en points (portrait). */
const PAGE_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};

// ---------------------------------------------------------------------------
// Type de fichier et images
// ---------------------------------------------------------------------------

function startsWith(bytes, list, offset = 0) {
  return list.every((b, i) => bytes[offset + i] === b);
}

/** 'pdf' | 'jpg' | 'png' | 'webp' | 'gif' | 'bmp' | null, d'après le contenu (pas l'extension). */
function detectType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  // « %PDF » peut être précédé de quelques octets parasites
  const head = Buffer.from(bytes.subarray(0, Math.min(1024, bytes.length))).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp';
  return null;
}

/** Dimensions en pixels d'un JPEG (segment SOF) ou d'un PNG (IHDR). */
function imageSize(bytes, type) {
  if (type === 'png') {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (type === 'jpg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      i += 2 + len;
    }
  }
  throw new PdfError('Image illisible : dimensions introuvables.');
}

/**
 * Orientation EXIF d'un JPEG (1 = normale, 3 = 180°, 6 = 90° horaire, 8 = 90° antihoraire).
 * Les photos de téléphone sont souvent enregistrées couchées avec cette indication.
 * Les variantes en miroir (2, 4, 5, 7) sont ramenées à la rotation la plus proche.
 */
function jpegOrientation(bytes) {
  let i = 2;
  while (i + 4 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe1 && Buffer.from(bytes.subarray(i + 4, i + 10)).toString('latin1') === 'Exif\0\0') {
      const tiff = i + 10;
      const little = bytes[tiff] === 0x49;
      const u16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const u32 = (o) => (little ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0 : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > bytes.length) return 1;
      const entries = u16(ifd);
      for (let e = 0; e < entries; e++) {
        const entry = ifd + 2 + e * 12;
        if (entry + 12 > bytes.length) break;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return { 1: 1, 2: 1, 3: 3, 4: 3, 5: 8, 6: 6, 7: 6, 8: 8 }[value] || 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) break; // début de l'image : plus d'en-têtes
    i += 2 + len;
  }
  return 1;
}

/** Description d'une image JPEG / PNG : dimensions affichées (orientation EXIF appliquée). */
function inspectImage(bytes) {
  const type = detectType(bytes);
  if (type !== 'jpg' && type !== 'png') throw new PdfError('Seules les images JPEG et PNG peuvent être placées directement dans un PDF.');
  const { width, height } = imageSize(bytes, type);
  const orientation = type === 'jpg' ? jpegOrientation(bytes) : 1;
  const turned = orientation === 6 || orientation === 8;
  return { type, width, height, orientation, displayWidth: turned ? height : width, displayHeight: turned ? width : height };
}

// ---------------------------------------------------------------------------
// Lecture d'un PDF
// ---------------------------------------------------------------------------

async function loadPdf(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    throw new PdfError('Ce PDF est endommagé ou illisible.');
  }
  if (doc.isEncrypted) {
    throw new PdfError('Ce PDF est chiffré (mot de passe ou restrictions) : PredF ne peut pas le modifier. Retirez la protection avec le logiciel qui l\'a créé.');
  }
  let count;
  try {
    count = doc.getPageCount(); // un arbre de pages absent ou cassé lève une erreur ici
  } catch {
    throw new PdfError('Ce PDF est endommagé ou illisible.');
  }
  if (count === 0) throw new PdfError('Ce PDF ne contient aucune page.');
  return doc;
}

const safeGet = (fn) => {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch {
    return null;
  }
};

/** Taille affichée d'une page (rotation comprise), en points. */
function visualSize(page) {
  const box = page.getCropBox();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  return angle === 90 || angle === 270 ? { width: box.height, height: box.width, rotation: angle } : { width: box.width, height: box.height, rotation: angle };
}

async function inspect(bytes) {
  const doc = await loadPdf(bytes);
  const pages = doc.getPages().map((p) => {
    const v = visualSize(p);
    return { width: Math.round(v.width * 100) / 100, height: Math.round(v.height * 100) / 100, rotation: v.rotation };
  });
  const keywords = safeGet(() => doc.getKeywords());
  return {
    pageCount: pages.length,
    pages,
    info: {
      title: safeGet(() => doc.getTitle()) || '',
      author: safeGet(() => doc.getAuthor()) || '',
      subject: safeGet(() => doc.getSubject()) || '',
      keywords: keywords || '',
      creator: safeGet(() => doc.getCreator()) || '',
      producer: safeGet(() => doc.getProducer()) || '',
      created: safeGet(() => doc.getCreationDate()?.toISOString()),
      modified: safeGet(() => doc.getModificationDate()?.toISOString()),
    },
  };
}

/** Nom courant d'un format de page (« A4 portrait »), sinon les dimensions en mm. */
function describeSize(width, height) {
  const w = Math.min(width, height);
  const h = Math.max(width, height);
  const name = Object.entries(PAGE_SIZES).find(([, [a, b]]) => Math.abs(a - w) < 3 && Math.abs(b - h) < 3);
  const orientation = width > height ? 'paysage' : 'portrait';
  if (name) return `${name[0]} ${orientation}`;
  return `${Math.round(width / MM)} × ${Math.round(height / MM)} mm`;
}

// ---------------------------------------------------------------------------
// Construction d'un PDF
// ---------------------------------------------------------------------------

const norm = (angle) => ((Math.round(angle / 90) * 90) % 360 + 360) % 360;

/** Format d'une page qui accueille une image, en points. */
function imagePageSize(info, layout) {
  const iw = info.displayWidth;
  const ih = info.displayHeight;
  const landscapeImage = iw > ih;
  if (!layout.size || layout.size === 'fit') {
    // Même proportions que l'image, grand côté = grand côté d'un A4 (marges ajoutées autour)
    const m = (layout.margin || 0) * MM;
    const long = PAGE_SIZES.A4[1] - 2 * m;
    const s = long / Math.max(iw, ih);
    return [iw * s + 2 * m, ih * s + 2 * m];
  }
  const [a, b] = PAGE_SIZES[layout.size] || PAGE_SIZES.A4;
  const landscape = layout.orientation === 'landscape' || (layout.orientation !== 'portrait' && landscapeImage);
  return landscape ? [b, a] : [a, b];
}

/** Dessine une image centrée dans un rectangle (proportions gardées), orientation EXIF appliquée. */
function drawImageIn(page, embedded, info, box) {
  const { displayWidth: dw0, displayHeight: dh0, orientation } = info;
  const s = Math.min(box.width / dw0, box.height / dh0);
  const dw = dw0 * s;
  const dh = dh0 * s;
  const X = box.x + (box.width - dw) / 2;
  const Y = box.y + (box.height - dh) / 2;
  // Taille de l'image telle qu'elle est stockée (avant rotation)
  const turned = orientation === 6 || orientation === 8;
  const w = turned ? dh : dw;
  const h = turned ? dw : dh;
  if (orientation === 6) page.drawImage(embedded, { x: X, y: Y + dh, width: w, height: h, rotate: degrees(-90) });
  else if (orientation === 8) page.drawImage(embedded, { x: X + dw, y: Y, width: w, height: h, rotate: degrees(90) });
  else if (orientation === 3) page.drawImage(embedded, { x: X + dw, y: Y + dh, width: w, height: h, rotate: degrees(180) });
  else page.drawImage(embedded, { x: X, y: Y, width: w, height: h });
}

/**
 * Construit un PDF.
 * items : [{ type: 'page', src, index, rotate }, { type: 'image', src, layout }, { type: 'blank', width, height }]
 * getSource(src) → { kind: 'pdf', bytes } | { kind: 'image', bytes }
 * options : { title, onProgress(done, total) }
 */
async function buildPdf(items, getSource, options = {}) {
  if (!Array.isArray(items) || !items.length) throw new PdfError('Aucune page à enregistrer.');
  const out = await PDFDocument.create();
  const loaded = new Map(); // src → PDFDocument
  const images = new Map(); // src → { embedded, info }

  const pdfOf = async (src) => {
    if (!loaded.has(src)) {
      const s = getSource(src);
      if (!s || s.kind !== 'pdf') throw new PdfError('Fichier introuvable : rouvrez-le.');
      loaded.set(src, await loadPdf(s.bytes));
    }
    return loaded.get(src);
  };
  const imageOf = async (src) => {
    if (!images.has(src)) {
      const s = getSource(src);
      if (!s || s.kind !== 'image') throw new PdfError('Image introuvable : rouvrez-la.');
      const info = inspectImage(s.bytes);
      const embedded = info.type === 'jpg' ? await out.embedJpg(s.bytes) : await out.embedPng(s.bytes);
      images.set(src, { embedded, info });
    }
    return images.get(src);
  };

  // Pages copiées : un appel copyPages par fichier et par « tour » (une page utilisée deux fois doit être
  // copiée deux fois, sinon le PDF contiendrait deux fois le même objet page)
  const plan = new Map(); // src → [[indices du tour 0], [tour 1], …]
  const seen = new Map(); // `${src}:${index}` → nombre d'utilisations
  const rounds = items.map((it) => {
    if (it.type !== 'page') return null;
    const key = `${it.src}:${it.index}`;
    const round = seen.get(key) || 0;
    seen.set(key, round + 1);
    if (!plan.has(it.src)) plan.set(it.src, []);
    const list = plan.get(it.src);
    while (list.length <= round) list.push([]);
    list[round].push(it.index);
    return round;
  });
  const copied = new Map(); // `${src}:${round}` → file de pages copiées
  for (const [src, list] of plan) {
    const doc = await pdfOf(src);
    const count = doc.getPageCount();
    for (let r = 0; r < list.length; r++) {
      for (const index of list[r]) {
        if (!Number.isInteger(index) || index < 0 || index >= count) throw new PdfError(`Page ${index + 1} inexistante (le document a ${count} pages).`);
      }
      copied.set(`${src}:${r}`, await out.copyPages(doc, list[r]));
    }
  }

  let lastSize = PAGE_SIZES.A4;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'page') {
      const page = copied.get(`${it.src}:${rounds[i]}`).shift();
      if (it.rotate) page.setRotation(degrees(norm(page.getRotation().angle + it.rotate)));
      out.addPage(page);
      const box = page.getCropBox();
      lastSize = [box.width, box.height];
    } else if (it.type === 'image') {
      const { embedded, info } = await imageOf(it.src);
      const layout = it.layout || {};
      const [pw, ph] = imagePageSize(info, layout);
      const page = out.addPage([pw, ph]);
      const m = (layout.margin || 0) * MM;
      drawImageIn(page, embedded, info, { x: m, y: m, width: pw - 2 * m, height: ph - 2 * m });
      if (it.rotate) page.setRotation(degrees(norm(it.rotate)));
      lastSize = [pw, ph];
    } else if (it.type === 'blank') {
      const w = Number(it.width) > 0 ? Number(it.width) : lastSize[0];
      const h = Number(it.height) > 0 ? Number(it.height) : lastSize[1];
      const page = out.addPage([w, h]);
      if (it.rotate) page.setRotation(degrees(norm(it.rotate)));
    } else {
      throw new PdfError('Élément de page inconnu.');
    }
    if (options.onProgress && (i % 20 === 19 || i === items.length - 1)) options.onProgress(i + 1, items.length);
  }

  // Propriétés : reprises du premier PDF source, sauf titre imposé
  const firstPdf = items.find((it) => it.type === 'page');
  if (firstPdf) {
    const src = loaded.get(firstPdf.src);
    const title = safeGet(() => src.getTitle());
    const author = safeGet(() => src.getAuthor());
    if (title) out.setTitle(title);
    if (author) out.setAuthor(author);
  }
  if (options.title) out.setTitle(options.title);
  out.setCreator('PredF');
  out.setProducer('PredF (pdf-lib)');
  return out.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------------------
// Pages en images (compression)
// ---------------------------------------------------------------------------

/** PDF construit page par page à partir d'images JPEG (une image = une page, à sa taille d'origine). */
async function createRasterJob() {
  const doc = await PDFDocument.create();
  return {
    pages: 0,
    async addPage(jpegBytes, widthPt, heightPt) {
      if (detectType(jpegBytes) !== 'jpg') throw new PdfError('Image de page invalide.');
      const w = Number(widthPt);
      const h = Number(heightPt);
      if (!(w > 0 && h > 0 && w < 20000 && h < 20000)) throw new PdfError('Taille de page invalide.');
      const img = await doc.embedJpg(jpegBytes);
      const page = doc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
      this.pages += 1;
    },
    async finish(meta = {}) {
      if (!this.pages) throw new PdfError('Aucune page.');
      if (meta.title) doc.setTitle(meta.title);
      if (meta.author) doc.setAuthor(meta.author);
      doc.setCreator('PredF');
      doc.setProducer('PredF (pdf-lib)');
      return doc.save({ useObjectStreams: true });
    },
  };
}

/** Réécriture sans perte : pages recopiées dans un document neuf (objets orphelins retirés), flux d'objets. */
async function optimizePdf(bytes) {
  const src = await loadPdf(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  for (const [get, set] of [
    ['getTitle', 'setTitle'],
    ['getAuthor', 'setAuthor'],
    ['getSubject', 'setSubject'],
    ['getCreator', 'setCreator'],
  ]) {
    const v = safeGet(() => src[get]());
    if (v) out[set](v);
  }
  const kw = safeGet(() => src.getKeywords());
  if (kw) out.setKeywords([kw]);
  out.setProducer('PredF (pdf-lib)');
  return out.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------------------
// Finitions : numéros de page, filigrane, propriétés
// ---------------------------------------------------------------------------

const COLORS = {
  gris: rgb(0.45, 0.45, 0.5),
  noir: rgb(0.1, 0.1, 0.12),
  rouge: rgb(0.85, 0.15, 0.2),
  bleu: rgb(0.15, 0.35, 0.85),
  violet: rgb(0.45, 0.25, 0.85),
};

const NUMBER_FORMATS = {
  n: (n) => `${n}`,
  page: (n) => `Page ${n}`,
  slash: (n, t) => `${n} / ${t}`,
  sur: (n, t) => `Page ${n} sur ${t}`,
  dash: (n) => `- ${n} -`,
};

/**
 * Écrit un texte à une position « visuelle » (repère de la page telle qu'elle s'affiche, rotation /Rotate
 * comprise), avec un angle visuel : les numéros restent droits même sur une page pivotée.
 */
function drawVisualText(page, text, { vx, vy, angle = 0, size, font, color, opacity }) {
  const box = page.getCropBox();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const W = box.width;
  const H = box.height;
  let x;
  let y;
  if (r === 90) [x, y] = [W - vy, vx];
  else if (r === 180) [x, y] = [W - vx, H - vy];
  else if (r === 270) [x, y] = [vy, H - vx];
  else [x, y] = [vx, vy];
  page.drawText(text, { x: box.x + x, y: box.y + y, size, font, color, opacity, rotate: degrees(angle + r) });
}

function checkEncodable(font, text, label) {
  try {
    font.encodeText(text);
    font.widthOfTextAtSize(text, 10);
  } catch {
    const bad = [...text].find((ch) => {
      try {
        font.encodeText(ch);
        return false;
      } catch {
        return true;
      }
    });
    throw new PdfError(`${label} : le caractère « ${bad || '?'} » ne peut pas être écrit avec la police standard des PDF. Retirez-le (les lettres accentuées françaises sont acceptées).`);
  }
}

/**
 * options : {
 *   numbers:   { position: 'bottom-center'|…, format: 'n'|'page'|'slash'|'sur'|'dash', start, size, skipFirst },
 *   watermark: { text, size: 'small'|'medium'|'large', opacity, color, angle: 'diagonal'|'horizontal' },
 *   props:     { title, author, subject, keywords, clear },
 *   onlyPage:  indice (aperçu : seule cette page est traitée et renvoyée)
 * }
 */
async function stampPdf(bytes, options = {}) {
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  const total = pages.length;
  const only = Number.isInteger(options.onlyPage) ? Math.min(Math.max(0, options.onlyPage), total - 1) : null;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const num = options.numbers;
  if (num && num.enabled !== false) {
    const format = NUMBER_FORMATS[num.format] || NUMBER_FORMATS.n;
    const start = Number.isInteger(Number(num.start)) ? Number(num.start) : 1;
    const size = Math.min(36, Math.max(6, Number(num.size) || 10));
    const margin = 24 + size;
    const position = String(num.position || 'bottom-center');
    pages.forEach((page, i) => {
      if (only !== null && i !== only) return;
      if (num.skipFirst && i === 0) return;
      const text = format(start + i, start + total - 1);
      const { width: VW, height: VH } = visualSize(page);
      const w = font.widthOfTextAtSize(text, size);
      const vy = position.startsWith('top') ? VH - margin : margin - size * 0.3;
      const vx = position.endsWith('left') ? margin : position.endsWith('right') ? VW - margin - w : (VW - w) / 2;
      drawVisualText(page, text, { vx, vy, size, font, color: rgb(0.2, 0.2, 0.24), opacity: 1 });
    });
  }

  const wm = options.watermark;
  if (wm && wm.enabled !== false && String(wm.text || '').trim()) {
    const text = String(wm.text).trim().slice(0, 80);
    checkEncodable(bold, text, 'Filigrane');
    const fraction = { small: 0.4, medium: 0.6, large: 0.8 }[wm.size] || 0.6;
    const opacity = Math.min(0.9, Math.max(0.05, Number(wm.opacity) || 0.18));
    const color = COLORS[wm.color] || COLORS.gris;
    pages.forEach((page, i) => {
      if (only !== null && i !== only) return;
      const { width: VW, height: VH } = visualSize(page);
      const diagonal = wm.angle !== 'horizontal';
      const angle = diagonal ? (Math.atan2(VH, VW) * 180) / Math.PI : 0;
      const length = diagonal ? Math.hypot(VW, VH) : VW;
      const unit = bold.widthOfTextAtSize(text, 1);
      const size = Math.min((length * fraction) / unit, VH * 0.4);
      const w = unit * size;
      const a = (angle * Math.PI) / 180;
      // Centre visuel ; on recule de la moitié du texte le long de l'angle, et d'un tiers de hauteur en travers
      const vx = VW / 2 - (w / 2) * Math.cos(a) + size * 0.33 * Math.sin(a);
      const vy = VH / 2 - (w / 2) * Math.sin(a) - size * 0.33 * Math.cos(a);
      drawVisualText(page, text, { vx, vy, angle, size, font: bold, color, opacity });
    });
  }

  const props = options.props;
  if (props) {
    if (props.clear) {
      doc.setTitle('');
      doc.setAuthor('');
      doc.setSubject('');
      doc.setKeywords([]);
      doc.setCreator('');
      doc.setProducer('');
    } else {
      if (props.title !== undefined) doc.setTitle(String(props.title).slice(0, 500));
      if (props.author !== undefined) doc.setAuthor(String(props.author).slice(0, 500));
      if (props.subject !== undefined) doc.setSubject(String(props.subject).slice(0, 1000));
      if (props.keywords !== undefined) {
        doc.setKeywords(
          String(props.keywords)
            .split(/[,;]+/)
            .map((k) => k.trim())
            .filter(Boolean)
            .slice(0, 50)
        );
      }
      doc.setProducer('PredF (pdf-lib)');
    }
    doc.setModificationDate(new Date());
  }

  if (only !== null) {
    // Aperçu : un PDF d'une seule page
    const preview = await PDFDocument.create();
    const [p] = await preview.copyPages(doc, [only]);
    preview.addPage(p);
    return preview.save();
  }
  return doc.save({ useObjectStreams: true });
}

module.exports = {
  PdfError,
  PAGE_SIZES,
  MM,
  detectType,
  imageSize,
  jpegOrientation,
  inspectImage,
  loadPdf,
  inspect,
  describeSize,
  buildPdf,
  createRasterJob,
  optimizePdf,
  stampPdf,
  NUMBER_FORMATS,
};
