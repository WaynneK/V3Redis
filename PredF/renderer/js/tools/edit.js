/*
 * Modifier — édition complète d'un PDF : modifier le texte existant, ajouter du texte, des images, une
 * signature, des formes, des flèches, des dessins, du surlignage, masquer ou caviarder une zone, remplir le
 * formulaire, supprimer / déplacer / dupliquer des pages ou en ajouter des blanches. Annuler / rétablir.
 *
 * Les pages sont affichées par pdf.js ; les ajouts sont des éléments posés par-dessus (repère : points PDF de
 * la page affichée, origine en haut à gauche). À l'enregistrement, le plan est envoyé au processus principal
 * (lib/edit.js) qui modifie le document d'origine. Les textes sont mis en lignes ici (mêmes mesures que la
 * police du PDF) : ce qui s'affiche est ce qui sera écrit.
 */

import { api, h, icon, button, segmented, toggle, plural, baseName, check, showResult, withBusy, formatBytes, toast, pickFiles, fmt } from '../core.js';
import { dropZone, docHeader, actionBar } from '../components.js';
import { initPdf, getDocument, forget, renderThumb, lazyThumbs, renderToImage } from '../pdfview.js';

const PT = 96 / 72; // pixels CSS par point à 100 %
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const STYLE_KEY = 'predf.editStyle';
const SIGN_KEY = 'predf.signature';
const COLORS = ['#000000', '#1f3a5f', '#2b7bd6', '#0e9f6e', '#d64545', '#ea3d5a', '#f59e0b', '#a63ff0', '#ffffff'];
const HIGHLIGHTS = ['#ffe14d', '#9ef01a', '#ff8fab', '#7dd3fc', '#fdba74'];
const MAX_UNDO = 100;

const TOOLS = [
  { id: 'select', name: 'Sélection', key: 'v', icon: 'cursor', tip: 'Sélectionner, déplacer, redimensionner, double-clic pour modifier un texte (V)' },
  { id: 'edittext', name: 'Modifier le texte', key: 'e', icon: 'editText', tip: 'Cliquer sur une ligne du PDF pour la réécrire (E)' },
  { id: 'text', name: 'Texte', key: 't', icon: 'text', tip: 'Cliquer pour écrire un texte (T)' },
  { id: 'image', name: 'Image', key: 'i', icon: 'images', tip: 'Insérer une image ou une photo (I)' },
  { id: 'sign', name: 'Signature', key: 's', icon: 'sign', tip: 'Dessiner ou réutiliser votre signature (S)' },
  { id: 'pen', name: 'Dessin', key: 'd', icon: 'pen', tip: 'Dessiner à main levée (D)' },
  { id: 'highlight', name: 'Surligner', key: 'h', icon: 'highlight', tip: 'Surligner une zone (H)' },
  { id: 'rect', name: 'Rectangle', key: 'r', icon: 'rect', tip: 'Tracer un rectangle (R)' },
  { id: 'ellipse', name: 'Ellipse', key: 'o', icon: 'ellipse', tip: 'Tracer une ellipse ou un cercle (O)' },
  { id: 'line', name: 'Ligne', key: 'l', icon: 'line', tip: 'Tracer une ligne ; Maj : angle droit ou 45° (L)' },
  { id: 'arrow', name: 'Flèche', key: 'f', icon: 'arrow', tip: 'Tracer une flèche ; Maj : angle droit ou 45° (F)' },
  { id: 'whiteout', name: 'Masquer', key: 'm', icon: 'eraser', tip: 'Recouvrir une zone d\'un cache de couleur (M). Le contenu reste dans le fichier : pour le supprimer, caviardez.' },
  { id: 'redact', name: 'Caviarder', key: 'x', icon: 'redact', tip: 'Supprimer définitivement une zone (X) : à l\'enregistrement, la page devient une image' },
  { id: 'form', name: 'Formulaire', key: 'g', icon: 'form', tip: 'Remplir les champs du formulaire (G)', forms: true },
];
const BOX_TYPES = new Set(['image', 'rect', 'ellipse', 'highlight', 'whiteout', 'redact']);

const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v) => Math.round(v * 100) / 100;

function loadStyle() {
  const base = {
    text: { font: 'Arial', size: 12, color: '#000000', bold: false, italic: false, underline: false, align: 'left' },
    shape: { stroke: '#ea3d5a', fill: null, width: 2, opacity: 1 },
    line: { stroke: '#000000', width: 2, opacity: 1 },
    pen: { stroke: '#2b7bd6', width: 2.5, opacity: 1 },
    highlight: { color: '#ffe14d', opacity: 0.4 },
    whiteout: { fill: '#ffffff' },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}');
    for (const k of Object.keys(base)) if (saved[k] && typeof saved[k] === 'object') Object.assign(base[k], saved[k]);
  } catch {
    // préférence indisponible
  }
  return base;
}

function saveStyle(style) {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(style));
  } catch {
    // préférence indisponible
  }
}

// ---------------------------------------------------------------------------
// Mise en lignes des textes (mesures du navigateur, mêmes polices que celles intégrées au PDF)
// ---------------------------------------------------------------------------

const measure = document.createElement('canvas').getContext('2d');
let FONTS = [{ name: 'Arial', css: 'Arial, sans-serif', unicode: true }];
const fontCss = (name) => (FONTS.find((f) => f.name === name) || FONTS[0]).css;
const fontString = (o, size) => `${o.italic ? 'italic ' : ''}${o.bold ? '700' : '400'} ${size}px ${fontCss(o.font)}`;
const lineHeightOf = (o) => o.size * 1.2;

/** Ligne de base dans une ligne de texte (demi-interligne au-dessus et au-dessous, comme en CSS). */
function baselineOf(o) {
  measure.font = fontString(o, 100);
  const m = measure.measureText('Hg');
  const asc = (m.fontBoundingBoxAscent || 80) / 100;
  const desc = (m.fontBoundingBoxDescent || 20) / 100;
  return (lineHeightOf(o) - (asc + desc) * o.size) / 2 + asc * o.size;
}

/** Lignes d'un texte : retours à la ligne saisis, et coupure des mots si une largeur est fixée. → { lines, width } */
function layoutText(o) {
  measure.font = fontString(o, o.size);
  const width = (s) => measure.measureText(s).width;
  const paragraphs = String(o.text || '').split('\n');
  if (!o.w) {
    const w = Math.max(0, ...paragraphs.map(width));
    return { lines: paragraphs, width: w };
  }
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/(\s+)/).filter((s) => s !== '');
    let line = '';
    for (const word of words) {
      if (width(line + word) <= o.w || !line.trim()) {
        if (!line.trim() && width(word) > o.w && word.trim()) {
          // Mot plus long que la largeur : coupé
          for (const ch of word) {
            if (width(line + ch) > o.w && line) {
              lines.push(line);
              line = '';
            }
            line += ch;
          }
        } else line += word;
      } else {
        lines.push(line.replace(/\s+$/, ''));
        line = /^\s+$/.test(word) ? '' : word;
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return { lines, width: o.w };
}

/** Rectangle occupé par un objet (points). */
function bbox(o) {
  if (o.type === 'text') {
    const { lines, width } = layoutText(o);
    return { x: o.x, y: o.y, w: Math.max(width, 4), h: Math.max(1, lines.length) * lineHeightOf(o) };
  }
  if (o.type === 'line' || o.type === 'arrow') {
    return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
  }
  if (o.type === 'ink') {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (let i = 0; i + 1 < o.points.length; i += 2) {
      x1 = Math.min(x1, o.points[i]);
      x2 = Math.max(x2, o.points[i]);
      y1 = Math.min(y1, o.points[i + 1]);
      y2 = Math.max(y2, o.points[i + 1]);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

// ---------------------------------------------------------------------------
// Couleurs relevées sur le rendu (texte existant : couleur du texte et du fond)
// ---------------------------------------------------------------------------

/** Point du PDF → repère de la page affichée (matrice du viewport pdf.js). */
function toView(vp, x, y) {
  const [a, b, c, d, e, f] = vp.transform;
  return [a * x + c * y + e, b * x + d * y + f];
}

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** { text, background } dans un rectangle du canvas (pixels) : fond = couleur dominante du pourtour. */
function sampleColors(canvas, x, y, w, h) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const X = clamp(Math.floor(x) - 2, 0, canvas.width - 1);
  const Y = clamp(Math.floor(y) - 2, 0, canvas.height - 1);
  const W = clamp(Math.ceil(w) + 4, 1, canvas.width - X);
  const H = clamp(Math.ceil(h) + 4, 1, canvas.height - Y);
  let data;
  try {
    data = ctx.getImageData(X, Y, W, H).data;
  } catch {
    return { text: '#000000', background: '#ffffff' };
  }
  const counts = new Map();
  const px = (i, j) => (j * W + i) * 4;
  for (let i = 0; i < W; i++) {
    for (const j of [0, 1, H - 2, H - 1]) {
      if (j < 0 || j >= H) continue;
      const k = px(i, j);
      const key = `${data[k] >> 3},${data[k + 1] >> 3},${data[k + 2] >> 3}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const [bgKey] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['31,31,31'];
  const bg = bgKey.split(',').map((v) => Number(v) * 8 + 4);
  let best = 0;
  const dist = [];
  for (let k = 0; k < data.length; k += 4) {
    const d = Math.abs(data[k] - bg[0]) + Math.abs(data[k + 1] - bg[1]) + Math.abs(data[k + 2] - bg[2]);
    dist.push(d);
    if (d > best) best = d;
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  if (best > 40) {
    for (let k = 0, i = 0; k < data.length; k += 4, i++) {
      if (dist[i] >= best * 0.75) {
        r += data[k];
        g += data[k + 1];
        b += data[k + 2];
        n++;
      }
    }
  }
  return { text: n ? hex(r / n, g / n, b / n) : '#000000', background: hex(...bg.map((v) => clamp(v, 0, 255))) };
}

/** Famille, gras, italique d'après le nom de la police du PDF (« ABCDEF+Calibri-BoldItalic »). */
function guessFont(name, family) {
  const n = String(name || '').replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(n);
  const italic = /italic|oblique/i.test(n);
  let font = 'Arial';
  if (/times|roman|garamond|cambria|book|minion|serif(?!.*sans)/i.test(n) && !/sans/i.test(n)) font = 'Times New Roman';
  if (/georgia/i.test(n)) font = 'Georgia';
  if (/calibri|carlito|aptos|segoe|candara/i.test(n)) font = 'Calibri';
  if (/verdana|tahoma|dejavusans/i.test(n)) font = 'Verdana';
  if (/courier|mono|consol|code/i.test(n)) font = 'Courier New';
  if (!n || /^g_d\d|^f\d/i.test(n)) font = family === 'serif' ? 'Times New Roman' : family === 'monospace' ? 'Courier New' : 'Arial';
  return { font, bold, italic };
}

// ---------------------------------------------------------------------------
// Outil
// ---------------------------------------------------------------------------

export function create() {
  const state = {
    file: null,
    pages: [], // { key, src: indice | null, width, height, objects: [] }
    tool: 'select',
    sel: null, // { page: clé, id }
    editing: null, // id du texte en cours de saisie
    zoom: 'fit',
    style: loadStyle(),
    undo: [],
    redo: [],
    images: new Map(), // id → { bytes, url, width, height }
    form: { fields: new Map(), values: new Map(), flatten: false }, // nom → { type, …, initial }
    hasForm: false,
    lines: new Map(), // indice de page d'origine → lignes de texte détectées
    pdfPages: new Map(), // indice → PDFPageProxy
    saved: true,
  };
  let seq = 0;
  const nid = () => `o${++seq}`;
  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner edit-tool' }, body, result);

  // Éléments de l'éditeur (créés à l'ouverture d'un document)
  let viewer = null;
  let pagesWrap = null;
  let thumbsList = null;
  let props = null;
  let toolbar = null;
  let bar = null;
  let pageLabel = null;
  let zoomLabel = null;
  const pageEls = new Map(); // clé de page → { el, canvas, objects, layer, renderedZ, rendering }
  let observer = null;
  let thumbsLazy = null;

  api.editFonts().then((res) => {
    if (res && res.ok && res.fonts.length) FONTS = res.fonts;
  });

  // ---------------------------------------------------------------- Historique

  const snapshot = () => JSON.stringify({ pages: state.pages, values: [...state.form.values], flatten: state.form.flatten });
  function restore(snap) {
    const s = JSON.parse(snap);
    state.pages = s.pages;
    state.form.values = new Map(s.values);
    state.form.flatten = s.flatten;
    state.sel = null;
    state.editing = null;
    buildPages();
    renderThumbs();
    renderProps();
    updateBar();
  }
  function pushUndo(before) {
    state.undo.push(before);
    if (state.undo.length > MAX_UNDO) state.undo.shift();
    state.redo = [];
    state.saved = false;
    result.replaceChildren();
  }
  /** Modification enregistrée dans l'historique. structure : les pages ont changé (ordre, nombre). */
  function change(fn, { structure = false, page = null } = {}) {
    const before = snapshot();
    fn();
    pushUndo(before);
    if (structure) {
      buildPages();
      renderThumbs();
    } else if (page) refreshPage(page);
    else for (const p of state.pages) refreshPage(p.key);
    renderProps();
    updateBar();
  }
  function undo() {
    if (!state.undo.length) return;
    finishEditing();
    state.redo.push(snapshot());
    restore(state.undo.pop());
    state.saved = false;
  }
  function redo() {
    if (!state.redo.length) return;
    finishEditing();
    state.undo.push(snapshot());
    restore(state.redo.pop());
    state.saved = false;
  }

  // ---------------------------------------------------------------- Accès

  const pageOf = (key) => state.pages.find((p) => p.key === key);
  const objOf = (sel) => {
    const p = sel && pageOf(sel.page);
    return p ? p.objects.find((o) => o.id === sel.id) : null;
  };
  const Z = () => (state.zoom === 'fit' ? fitZoom() : state.zoom * PT);

  function fitZoom() {
    if (!viewer || !state.pages.length) return PT;
    const widest = Math.max(...state.pages.map((p) => p.width));
    return clamp((viewer.clientWidth - 48) / widest, 0.3, 4);
  }

  // ---------------------------------------------------------------- Ouverture

  async function open(files) {
    const f = files.find((x) => x.kind === 'pdf');
    if (!f) return;
    if (state.file && !state.saved && !window.confirm('Les modifications non enregistrées de ce document seront perdues. Ouvrir l\'autre PDF ?')) {
      api.release([f.id]);
      return;
    }
    closeDoc();
    state.file = f;
    result.replaceChildren();
    try {
      await withBusy('Ouverture du document…', async () => {
        const lib = await initPdf();
        const doc = await getDocument(f.id);
        const pages = [];
        for (let i = 0; i < doc.numPages; i++) {
          const page = await doc.getPage(i + 1);
          state.pdfPages.set(i, page);
          const vp = page.getViewport({ scale: 1, rotation: page.rotate });
          pages.push({ key: `p${++seq}`, src: i, width: round(vp.width), height: round(vp.height), objects: [] });
          // Champs de formulaire (widgets) : position dans le repère de la page affichée
          let annots = [];
          try {
            annots = await page.getAnnotations({ intent: 'display' });
          } catch {
            annots = [];
          }
          for (const a of annots) {
            if (a.subtype !== 'Widget' || !a.fieldName || a.pushButton || a.hidden) continue;
            if (!['Tx', 'Btn', 'Ch'].includes(a.fieldType)) continue;
            const [x1, y1] = toView(vp, a.rect[0], a.rect[1]);
            const [x2, y2] = toView(vp, a.rect[2], a.rect[3]);
            const widget = { page: i, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), readOnly: Boolean(a.readOnly) };
            let field = state.form.fields.get(a.fieldName);
            if (!field) {
              field = { name: a.fieldName, widgets: [] };
              if (a.fieldType === 'Tx') Object.assign(field, { type: 'text', multiline: Boolean(a.multiLine), maxLen: a.maxLen || 0, initial: String(a.fieldValue ?? '') });
              else if (a.fieldType === 'Btn' && a.checkBox) Object.assign(field, { type: 'check', initial: Boolean(a.fieldValue && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue) });
              else if (a.fieldType === 'Btn' && a.radioButton) Object.assign(field, { type: 'radio', initial: a.fieldValue && a.fieldValue !== 'Off' ? String(a.fieldValue) : '' });
              else if (a.fieldType === 'Ch') {
                const v = Array.isArray(a.fieldValue) ? a.fieldValue : a.fieldValue ? [a.fieldValue] : [];
                Object.assign(field, { type: a.combo ? 'combo' : 'list', multiple: Boolean(a.multiSelect), options: (a.options || []).map((o) => ({ value: String(o.exportValue ?? o.displayValue), label: String(o.displayValue ?? o.exportValue) })), initial: a.combo ? String(v[0] ?? '') : v.map(String) });
              } else continue;
              state.form.fields.set(a.fieldName, field);
            }
            if (field.type === 'radio') widget.value = String(a.buttonValue ?? '');
            field.widgets.push(widget);
          }
        }
        state.pages = pages;
        state.hasForm = state.form.fields.size > 0;
        state.annotationMode = state.hasForm ? lib.AnnotationMode.ENABLE_FORMS : lib.AnnotationMode.ENABLE;
      });
    } catch (err) {
      toast(`Ouverture impossible : ${err.message}`, 'error');
      closeDoc();
      render();
      return;
    }
    state.tool = state.hasForm ? 'form' : 'select';
    state.saved = true;
    render();
    if (state.hasForm) toast(`Ce PDF contient un formulaire (${plural(state.form.fields.size, 'champ')}) : cliquez dans les cases pour le remplir.`);
  }

  function closeDoc() {
    if (state.file) {
      api.release([state.file.id]);
      forget(state.file.id);
    }
    for (const img of state.images.values()) URL.revokeObjectURL(img.url);
    if (observer) observer.disconnect();
    if (thumbsLazy) thumbsLazy.disconnect();
    observer = null;
    thumbsLazy = null;
    pageEls.clear();
    Object.assign(state, { file: null, pages: [], sel: null, editing: null, undo: [], redo: [], saved: true, hasForm: false });
    state.images = new Map();
    state.form = { fields: new Map(), values: new Map(), flatten: false };
    state.lines = new Map();
    state.pdfPages = new Map();
  }

  function close() {
    if (!state.saved && !window.confirm('Fermer sans enregistrer les modifications ?')) return;
    closeDoc();
    result.replaceChildren();
    render();
  }

  // ---------------------------------------------------------------- Rendu général

  function render() {
    if (!state.file) {
      viewer = null;
      body.replaceChildren(dropZone({ kind: 'pdf', title: 'Déposez le PDF à modifier', hint: 'ou cliquez pour le choisir — texte, images, signature, formes, formulaire, pages', onFiles: open }));
      return;
    }
    toolbar = buildToolbar();
    thumbsList = h('div', { class: 'ed-thumbs', role: 'list', 'aria-label': 'Pages' });
    pagesWrap = h('div', { class: 'ed-pages' });
    viewer = h('div', { class: 'ed-viewer', tabindex: '-1' }, pagesWrap);
    props = h('aside', { class: 'ed-props', 'aria-label': 'Propriétés' });
    bar = actionBar('', button('Enregistrer le PDF', { icon: 'check', cls: 'primary', tip: 'Enregistrer une copie modifiée (Ctrl + S)', onClick: save }));
    body.replaceChildren(docHeader(state.file, { onChange: open, onClose: close }), toolbar, h('div', { class: 'ed-main' }, h('div', { class: 'ed-side' }, thumbsList), viewer, props), bar);
    viewer.addEventListener('scroll', onScroll, { passive: true });
    viewer.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        zoomStep(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );
    // Taille de la zone changée : zoom « ajusté » recalculé à l'image suivante (pas pendant la mise en page)
    new ResizeObserver(() => state.zoom === 'fit' && requestAnimationFrame(applyZoom)).observe(viewer);
    requestAnimationFrame(() => {
      buildPages();
      renderThumbs();
      renderProps();
      updateBar();
    });
  }

  // ---------------------------------------------------------------- Barre d'outils

  function buildToolbar() {
    const tools = TOOLS.filter((t) => !t.forms || state.hasForm).map((t) => {
      const b = h('button', { type: 'button', class: 'ed-tool', 'data-tool': t.id, 'data-tip': t.tip, 'aria-label': t.name, 'aria-pressed': String(state.tool === t.id) }, icon(t.icon), h('span', null, t.name));
      b.addEventListener('click', () => setTool(t.id));
      return b;
    });
    pageLabel = h('span', { class: 'ed-pagelabel' });
    zoomLabel = h('button', { type: 'button', class: 'ed-zoomlabel', 'data-tip': 'Ajuster à la largeur (Ctrl + 0)' });
    zoomLabel.addEventListener('click', () => setZoom('fit'));
    return h(
      'div',
      { class: 'ed-toolbar' },
      h('div', { class: 'ed-tools', role: 'toolbar', 'aria-label': 'Outils de modification' }, tools),
      h(
        'div',
        { class: 'ed-view' },
        button('', { icon: 'undo', cls: 'icon-only ghost', tip: 'Annuler (Ctrl + Z)', onClick: undo }),
        button('', { icon: 'redo', cls: 'icon-only ghost', tip: 'Rétablir (Ctrl + Y)', onClick: redo }),
        h('span', { class: 'ed-sep' }),
        button('', { icon: 'zoomOut', cls: 'icon-only ghost', tip: 'Zoom arrière (Ctrl + -)', onClick: () => zoomStep(-1) }),
        zoomLabel,
        button('', { icon: 'zoomIn', cls: 'icon-only ghost', tip: 'Zoom avant (Ctrl + +)', onClick: () => zoomStep(1) }),
        h('span', { class: 'ed-sep' }),
        pageLabel
      )
    );
  }

  async function setTool(id) {
    finishEditing();
    if (id === 'image') return insertImage();
    if (id === 'sign') return insertSignature();
    state.tool = id;
    if (id !== 'select') state.sel = null;
    if (toolbar) toolbar.querySelectorAll('.ed-tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
    if (viewer) viewer.dataset.tool = id;
    for (const p of state.pages) refreshPage(p.key);
    renderProps();
    if (id === 'redact') toast('Caviarder : à l\'enregistrement, chaque page caviardée devient une image. Le contenu masqué est vraiment supprimé, mais le texte de cette page ne sera plus sélectionnable.');
    if (id === 'edittext') loadLinesForVisible();
  }

  // ---------------------------------------------------------------- Zoom

  function setZoom(z) {
    state.zoom = z;
    applyZoom();
  }
  function zoomStep(dir) {
    const cur = Z() / PT;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.01) : [...ZOOMS].reverse().find((z) => z < cur - 0.01);
    if (next) setZoom(next);
  }
  function applyZoom() {
    if (!viewer) return;
    // Garde le même endroit du document à l'écran
    const ratio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
    for (const p of state.pages) sizePage(p);
    for (const p of state.pages) refreshPage(p.key);
    viewer.scrollTop = ratio * viewer.scrollHeight;
    zoomLabel.textContent = `${Math.round((Z() / PT) * 100)} %`;
    clearTimeout(applyZoom.timer);
    applyZoom.timer = setTimeout(() => {
      for (const [key, entry] of pageEls) if (entry.visible) drawCanvas(pageOf(key), entry);
    }, 160);
  }

  // ---------------------------------------------------------------- Pages

  function buildPages() {
    if (!pagesWrap) return;
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const entry = [...pageEls.values()].find((x) => x.el === e.target);
          if (!entry) continue;
          entry.visible = e.isIntersecting;
          if (e.isIntersecting) {
            drawCanvas(pageOf(entry.key), entry);
            if (state.tool === 'edittext') loadLines(pageOf(entry.key));
          }
        }
      },
      { root: viewer, rootMargin: '600px 0px' }
    );
    const keep = new Set(state.pages.map((p) => p.key));
    for (const k of [...pageEls.keys()]) if (!keep.has(k)) pageEls.delete(k);
    const els = state.pages.map((p, i) => {
      let entry = pageEls.get(p.key);
      if (!entry) {
        entry = createPage(p);
        pageEls.set(p.key, entry);
      }
      entry.number.textContent = `Page ${i + 1}`;
      sizePage(p);
      observer.observe(entry.el);
      return entry.wrap;
    });
    pagesWrap.replaceChildren(...els);
    for (const p of state.pages) refreshPage(p.key);
    viewer.dataset.tool = state.tool;
    zoomLabel.textContent = `${Math.round((Z() / PT) * 100)} %`;
    onScroll();
  }

  function createPage(p) {
    const canvas = h('canvas', { class: 'ed-canvas', 'aria-hidden': 'true' });
    const objects = h('div', { class: 'ed-objects' });
    const layer = h('div', { class: 'ed-layer' }); // lignes de texte (Modifier le texte), champs du formulaire
    const sel = h('div', { class: 'ed-selection' });
    const el = h('div', { class: `ed-page${p.src === null ? ' blank' : ''}`, dataset: { key: p.key } }, canvas, objects, layer, sel);
    const number = h('span', { class: 'ed-pagenum' });
    const wrap = h('div', { class: 'ed-pagewrap' }, el, number);
    const entry = { key: p.key, el, wrap, canvas, objects, layer, sel, number, renderedZ: 0, visible: false };
    el.addEventListener('pointerdown', (e) => onPointerDown(e, p.key));
    el.addEventListener('dblclick', (e) => onDoubleClick(e, p.key));
    return entry;
  }

  function sizePage(p) {
    const entry = pageEls.get(p.key);
    if (!entry) return;
    const z = Z();
    entry.el.style.width = `${p.width * z}px`;
    entry.el.style.height = `${p.height * z}px`;
  }

  async function drawCanvas(p, entry) {
    if (!p || p.src === null || !state.file) return;
    const z = Z();
    if (entry.renderedZ === z || entry.rendering === z) return;
    entry.rendering = z;
    const page = state.pdfPages.get(p.src);
    if (!page) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let scale = z * dpr;
    scale = Math.min(scale, Math.sqrt(40e6 / (p.width * p.height)));
    const vp = page.getViewport({ scale, rotation: page.rotate });
    const canvas = document.createElement('canvas');
    canvas.className = 'ed-canvas';
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      if (entry.task) entry.task.cancel();
      entry.task = page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff', annotationMode: state.annotationMode });
      await entry.task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      entry.el.classList.add('failed');
      return;
    } finally {
      if (entry.rendering === z) entry.rendering = null;
    }
    entry.task = null;
    entry.canvas.replaceWith(canvas);
    entry.canvas = canvas;
    entry.renderedZ = z;
  }

  function onScroll() {
    if (!viewer || !pageLabel) return;
    const top = viewer.getBoundingClientRect().top + viewer.clientHeight * 0.3;
    let current = 0;
    state.pages.forEach((p, i) => {
      const entry = pageEls.get(p.key);
      if (entry && entry.el.getBoundingClientRect().top <= top) current = i;
    });
    state.current = current;
    pageLabel.textContent = `Page ${current + 1} / ${state.pages.length}`;
    if (thumbsList) thumbsList.querySelectorAll('.ed-thumb').forEach((t, i) => t.classList.toggle('current', i === current));
  }

  function scrollToPage(i) {
    const p = state.pages[i];
    const entry = p && pageEls.get(p.key);
    if (entry) viewer.scrollTo({ top: entry.wrap.offsetTop - 12, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- Miniatures et actions sur les pages

  function renderThumbs() {
    if (!thumbsList) return;
    if (thumbsLazy) thumbsLazy.disconnect();
    thumbsLazy = lazyThumbs(thumbsList);
    const cards = state.pages.map((p, i) => {
      const canvas = h('canvas', { class: 'ed-thumb-canvas', 'aria-hidden': 'true' });
      if (p.src !== null) thumbsLazy.add(canvas, () => renderThumb(state.file.id, p.src, canvas, { width: 96 }));
      else canvas.classList.add('blank');
      canvas.style.aspectRatio = `${p.width} / ${p.height}`;
      const actions = h(
        'div',
        { class: 'ed-thumb-actions' },
        button('', { icon: 'up', cls: 'icon-only ghost', tip: 'Monter la page', disabled: i === 0, onClick: () => movePage(i, -1) }),
        button('', { icon: 'down', cls: 'icon-only ghost', tip: 'Descendre la page', disabled: i === state.pages.length - 1, onClick: () => movePage(i, 1) }),
        button('', { icon: 'copy', cls: 'icon-only ghost', tip: 'Dupliquer la page (avec ses ajouts)', onClick: () => duplicatePage(i) }),
        button('', { icon: 'blank', cls: 'icon-only ghost', tip: 'Insérer une page blanche après', onClick: () => insertBlank(i) }),
        button('', { icon: 'trash', cls: 'icon-only ghost danger', tip: 'Supprimer la page', onClick: () => deletePage(i) })
      );
      const card = h('div', { class: 'ed-thumb', role: 'listitem' }, h('button', { type: 'button', class: 'ed-thumb-btn', 'aria-label': `Aller à la page ${i + 1}` }, canvas, h('span', null, String(i + 1)), p.objects.length ? h('span', { class: 'ed-thumb-dot', 'data-tip': plural(p.objects.length, 'ajout') }) : null), actions);
      card.querySelector('.ed-thumb-btn').addEventListener('click', () => scrollToPage(i));
      return card;
    });
    thumbsList.replaceChildren(...cards);
    onScroll();
  }

  function movePage(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.pages.length) return;
    change(
      () => {
        const [p] = state.pages.splice(i, 1);
        state.pages.splice(j, 0, p);
      },
      { structure: true }
    );
  }
  function duplicatePage(i) {
    change(
      () => {
        const copy = clone(state.pages[i]);
        copy.key = `p${++seq}`;
        for (const o of copy.objects) {
          o.id = nid();
          // Le cache d'un texte modifié reste lié à la page d'origine : sur la copie, le texte d'origine est aussi caché
        }
        state.pages.splice(i + 1, 0, copy);
      },
      { structure: true }
    );
    toast(`Page ${i + 1} dupliquée.`);
  }
  function insertBlank(i) {
    const ref = state.pages[i];
    change(
      () => {
        state.pages.splice(i + 1, 0, { key: `p${++seq}`, src: null, width: ref.width, height: ref.height, objects: [] });
      },
      { structure: true }
    );
    toast(`Page blanche ajoutée après la page ${i + 1}.`);
  }
  function deletePage(i) {
    if (state.pages.length === 1) {
      toast('Le document doit garder au moins une page.', 'error');
      return;
    }
    change(
      () => {
        const [p] = state.pages.splice(i, 1);
        if (state.sel && state.sel.page === p.key) state.sel = null;
      },
      { structure: true }
    );
    toast(`Page ${i + 1} supprimée (Ctrl + Z pour annuler).`);
  }

  // ---------------------------------------------------------------- Objets à l'écran

  function refreshPage(key) {
    const p = pageOf(key);
    const entry = pageEls.get(key);
    if (!p || !entry) return;
    const z = Z();
    const els = [];
    for (const o of p.objects) {
      if (o.type === 'text' && o.cover) els.push(coverEl(o, z));
    }
    for (const o of p.objects) els.push(objectEl(o, z));
    entry.objects.replaceChildren(...els);
    renderLayer(p, entry);
    renderSelection(p, entry);
  }

  const px = (v, z) => `${v * z}px`;

  function coverEl(o, z) {
    const c = h('div', { class: 'ed-cover' });
    Object.assign(c.style, { left: px(o.cover.x, z), top: px(o.cover.y, z), width: px(o.cover.w, z), height: px(o.cover.h, z), background: o.cover.color });
    return c;
  }

  function objectEl(o, z) {
    let el;
    if (o.type === 'text') {
      const { lines, width } = layoutText(o);
      const L = lineHeightOf(o);
      el = h('div', { class: 'ed-obj ed-text' });
      Object.assign(el.style, { left: px(o.x, z), top: px(o.y, z), width: px(Math.max(width, 4), z), font: fontString(o, o.size * z), lineHeight: px(L, z), color: o.color, opacity: String(o.opacity ?? 1), textAlign: o.align, textDecoration: o.underline ? 'underline' : 'none' });
      if (state.editing === o.id) {
        el = editorEl(o, z);
      } else {
        for (const line of lines) {
          const d = h('div', { class: 'ed-line' }, line || '​');
          d.style.height = px(L, z);
          el.append(d);
        }
        if (!String(o.text).trim()) el.classList.add('empty');
      }
    } else if (o.type === 'image') {
      const img = state.images.get(o.image);
      el = h('img', { class: 'ed-obj ed-image', alt: '', draggable: 'false', src: img ? img.url : '' });
      Object.assign(el.style, { left: px(o.x, z), top: px(o.y, z), width: px(o.w, z), height: px(o.h, z), opacity: String(o.opacity ?? 1) });
    } else if (BOX_TYPES.has(o.type)) {
      el = h('div', { class: `ed-obj ed-box ed-${o.type}` });
      Object.assign(el.style, { left: px(o.x, z), top: px(o.y, z), width: px(o.w, z), height: px(o.h, z) });
      if (o.type === 'rect' || o.type === 'ellipse') {
        Object.assign(el.style, { borderStyle: 'solid', borderWidth: o.stroke && o.width ? px(o.width, z) : '0', borderColor: o.stroke || 'transparent', background: o.fill || 'transparent', opacity: String(o.opacity ?? 1) });
      } else if (o.type === 'highlight') Object.assign(el.style, { background: o.color, opacity: String(o.opacity ?? 0.4) });
      else if (o.type === 'whiteout') el.style.background = o.fill || '#ffffff';
    } else {
      // Lignes, flèches, dessins : un petit SVG à la taille de l'objet (marge pour l'épaisseur)
      const b = bbox(o);
      const pad = (o.width || 2) * 3 + 6;
      const ns = 'http://www.w3.org/2000/svg';
      el = document.createElementNS(ns, 'svg');
      el.setAttribute('class', 'ed-obj ed-vector');
      el.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`);
      Object.assign(el.style, { left: px(b.x - pad, z), top: px(b.y - pad, z), width: px(b.w + 2 * pad, z), height: px(b.h + 2 * pad, z), opacity: String(o.opacity ?? 1) });
      const path = document.createElementNS(ns, 'path');
      let d;
      if (o.type === 'ink') {
        d = `M ${o.points[0]} ${o.points[1]}`;
        for (let i = 2; i + 1 < o.points.length; i += 2) d += ` L ${o.points[i]} ${o.points[i + 1]}`;
        if (o.points.length === 2) d += ` l 0.01 0`;
      } else {
        let { x2, y2 } = o;
        if (o.type === 'arrow') {
          const head = arrowHead(o);
          const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
          if (len > head.back) {
            x2 = o.x2 - ((o.x2 - o.x1) / len) * head.back;
            y2 = o.y2 - ((o.y2 - o.y1) / len) * head.back;
          }
          const tip = document.createElementNS(ns, 'path');
          tip.setAttribute('d', head.path);
          tip.setAttribute('fill', o.stroke);
          el.append(tip);
        }
        d = `M ${o.x1} ${o.y1} L ${x2} ${y2}`;
      }
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', o.stroke);
      path.setAttribute('stroke-width', String(o.width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      el.prepend(path);
      // Zone de clic plus large que le trait
      const hit = path.cloneNode();
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', String(Math.max(o.width, 10 / z)));
      hit.setAttribute('class', 'ed-hit');
      el.append(hit);
    }
    el.dataset.id = o.id;
    if (state.sel && state.sel.id === o.id) el.classList.add('selected');
    return el;
  }

  /** Pointe de flèche (mêmes calculs que lib/edit.js). */
  function arrowHead(o) {
    const len = Math.max(8, o.width * 4.5);
    const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
    const spread = Math.PI / 7;
    const p1 = [o.x2 - len * Math.cos(a - spread), o.y2 - len * Math.sin(a - spread)];
    const p2 = [o.x2 - len * Math.cos(a + spread), o.y2 - len * Math.sin(a + spread)];
    return { path: `M ${o.x2} ${o.y2} L ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]} Z`, back: len * Math.cos(spread) * 0.85 };
  }

  // ---------------------------------------------------------------- Saisie d'un texte

  function editorEl(o, z) {
    const el = h('div', { class: 'ed-obj ed-text editing', contenteditable: 'plaintext-only', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Texte' });
    Object.assign(el.style, {
      left: px(o.x, z),
      top: px(o.y, z),
      font: fontString(o, o.size * z),
      lineHeight: px(lineHeightOf(o), z),
      color: o.color,
      textAlign: o.align,
      textDecoration: o.underline ? 'underline' : 'none',
      whiteSpace: o.w ? 'pre-wrap' : 'pre',
      width: o.w ? px(o.w, z) : 'auto',
      minWidth: px(Math.max(8, o.size), z),
    });
    el.textContent = o.text;
    el.dataset.id = o.id;
    el.addEventListener('input', () => {
      o.text = el.innerText.replace(/\r/g, '').replace(/\n$/, '');
      positionSelectionLater();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finishEditing();
      }
      e.stopPropagation();
    });
    el.addEventListener('blur', () => setTimeout(() => state.editing === o.id && document.activeElement !== el && finishEditing(), 0));
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    requestAnimationFrame(() => {
      if (!el.isConnected) return; // remplacé entre-temps (page redessinée) : le nouvel éditeur prend le relais
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      if (!o.selectAll) s.collapseToEnd();
      o.selectAll = false;
    });
    return el;
  }

  let editBefore = null;
  function startEditing(pageKey, o, { selectAll = false } = {}) {
    finishEditing();
    editBefore = editBefore || snapshot();
    state.sel = { page: pageKey, id: o.id };
    state.editing = o.id;
    o.selectAll = selectAll;
    refreshPage(pageKey);
    renderProps();
  }

  /** Fin de la saisie : texte vide supprimé (sauf texte existant effacé), modification dans l'historique. */
  function finishEditing() {
    if (!state.editing) return;
    const id = state.editing;
    state.editing = null;
    const p = state.pages.find((pg) => pg.objects.some((o) => o.id === id));
    if (p) {
      const o = p.objects.find((x) => x.id === id);
      delete o.selectAll;
      if (!String(o.text).trim() && !o.cover) {
        p.objects = p.objects.filter((x) => x.id !== id);
        if (state.sel && state.sel.id === id) state.sel = null;
      }
      refreshPage(p.key);
    }
    const before = editBefore;
    editBefore = null;
    if (before && before !== snapshot()) pushUndo(before);
    renderProps();
    updateBar();
    if (thumbsList && p) renderThumbs();
  }

  let selTimer = null;
  function positionSelectionLater() {
    cancelAnimationFrame(selTimer);
    selTimer = requestAnimationFrame(() => {
      const sel = state.sel && pageOf(state.sel.page);
      if (sel) renderSelection(sel, pageEls.get(sel.key));
    });
  }

  // ---------------------------------------------------------------- Sélection

  function renderSelection(p, entry) {
    if (!entry) return;
    const o = state.sel && state.sel.page === p.key ? objOf(state.sel) : null;
    entry.sel.replaceChildren();
    if (!o || state.tool !== 'select') return;
    const z = Z();
    if (o.type === 'line' || o.type === 'arrow') {
      for (const [hdl, x, y] of [
        ['p1', o.x1, o.y1],
        ['p2', o.x2, o.y2],
      ]) {
        const d = h('span', { class: 'ed-handle round', dataset: { handle: hdl } });
        Object.assign(d.style, { left: px(x, z), top: px(y, z) });
        entry.sel.append(d);
      }
      return;
    }
    let b = bbox(o);
    if (state.editing === o.id) {
      const ed = entry.objects.querySelector('.editing');
      if (ed) b = { x: o.x, y: o.y, w: ed.offsetWidth / z, h: ed.offsetHeight / z };
    }
    const frame = h('div', { class: `ed-frame${o.type === 'redact' ? ' redact' : ''}` });
    Object.assign(frame.style, { left: px(b.x, z), top: px(b.y, z), width: px(b.w, z), height: px(b.h, z) });
    const handles = o.type === 'text' ? ['w', 'e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    if (state.editing !== o.id) for (const hd of handles) frame.append(h('span', { class: `ed-handle h-${hd}`, dataset: { handle: hd } }));
    entry.sel.append(frame);
  }

  function select(pageKey, id) {
    state.sel = id ? { page: pageKey, id } : null;
    for (const p of state.pages) {
      const entry = pageEls.get(p.key);
      if (!entry) continue;
      entry.objects.querySelectorAll('.ed-obj').forEach((el) => el.classList.toggle('selected', Boolean(state.sel && el.dataset.id === state.sel.id)));
      renderSelection(p, entry);
    }
    renderProps();
  }

  // ---------------------------------------------------------------- Souris, stylet, doigt

  function pointOf(e, key) {
    const entry = pageEls.get(key);
    const r = entry.el.getBoundingClientRect();
    const z = Z();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  }

  function onDoubleClick(e, key) {
    if (state.tool !== 'select') return;
    const target = e.target.closest('.ed-obj');
    const p = pageOf(key);
    const o = target && p.objects.find((x) => x.id === target.dataset.id);
    if (o && o.type === 'text') startEditing(key, o);
  }

  function onPointerDown(e, key) {
    if (e.button !== 0) return;
    const p = pageOf(key);
    if (!p) return;
    if (e.target.closest('.ed-field')) return; // champ du formulaire
    if (state.editing) {
      if (e.target.closest('.editing')) return;
      finishEditing();
      if (state.tool === 'text') return; // un clic hors du texte termine la saisie
    }
    const pt = pointOf(e, key);
    const tool = state.tool;
    if (tool === 'select') return selectPointer(e, p, pt);
    if (tool === 'edittext') return editTextAt(e, p, pt);
    if (tool === 'text') {
      e.preventDefault();
      const t = state.style.text;
      const o = { id: nid(), type: 'text', x: 0, y: 0, w: 0, text: '', ...t, opacity: 1 };
      o.x = round(pt.x);
      o.y = round(pt.y - baselineOf(o) + o.size * 0.25);
      editBefore = snapshot();
      p.objects.push(o);
      setToolQuiet('select');
      startEditing(key, o);
      return;
    }
    if (tool === 'pen') return drawInk(e, p, pt);
    if (['rect', 'ellipse', 'highlight', 'whiteout', 'redact', 'line', 'arrow'].includes(tool)) return drawShape(e, p, pt, tool);
  }

  /** Change d'outil sans tout redessiner (après la création d'un objet). */
  function setToolQuiet(id) {
    state.tool = id;
    if (toolbar) toolbar.querySelectorAll('.ed-tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
    if (viewer) viewer.dataset.tool = id;
  }

  /** Suivi d'un glisser (souris capturée) ; onMove(point, évènement), onUp(point, évènement, déplacé). */
  function drag(e, key, onMove, onUp) {
    const el = pageEls.get(key).el;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev) => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
      if (moved) onMove(pointOf(ev, key), ev);
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onUp(pointOf(ev, key), ev, moved);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function selectPointer(e, p, pt) {
    const handle = e.target.closest('.ed-handle');
    const target = e.target.closest('.ed-obj');
    let o = null;
    if (handle) o = objOf(state.sel);
    else if (target) o = p.objects.find((x) => x.id === target.dataset.id);
    if (!o) {
      select(null, null);
      return;
    }
    e.preventDefault();
    if (!state.sel || state.sel.id !== o.id) select(p.key, o.id);
    const before = snapshot();
    const orig = clone(o);
    const ob = bbox(orig);
    const mode = handle ? handle.dataset.handle : 'move';
    drag(
      e,
      p.key,
      (q, ev) => {
        const dx = q.x - pt.x;
        const dy = q.y - pt.y;
        if (mode === 'move') moveObject(o, orig, dx, dy);
        else if (mode === 'p1' || mode === 'p2') {
          let x = q.x;
          let y = q.y;
          if (ev.shiftKey) [x, y] = snapAngle(mode === 'p1' ? orig.x2 : orig.x1, mode === 'p1' ? orig.y2 : orig.y1, x, y);
          if (mode === 'p1') Object.assign(o, { x1: round(x), y1: round(y) });
          else Object.assign(o, { x2: round(x), y2: round(y) });
        } else resizeObject(o, orig, ob, mode, dx, dy, ev.shiftKey);
        refreshPage(p.key);
      },
      (q, ev, moved) => {
        if (moved && before !== snapshot()) {
          pushUndo(before);
          renderProps();
          updateBar();
        }
      }
    );
  }

  function moveObject(o, orig, dx, dy) {
    if (o.type === 'line' || o.type === 'arrow') Object.assign(o, { x1: round(orig.x1 + dx), y1: round(orig.y1 + dy), x2: round(orig.x2 + dx), y2: round(orig.y2 + dy) });
    else if (o.type === 'ink') o.points = orig.points.map((v, i) => round(v + (i % 2 ? dy : dx)));
    else Object.assign(o, { x: round(orig.x + dx), y: round(orig.y + dy) });
  }

  function resizeObject(o, orig, ob, mode, dx, dy, free) {
    let { x, y, w, h: hh } = ob;
    if (mode.includes('e')) w = ob.w + dx;
    if (mode.includes('s')) hh = ob.h + dy;
    if (mode.includes('w')) {
      x = ob.x + dx;
      w = ob.w - dx;
    }
    if (mode.includes('n')) {
      y = ob.y + dy;
      hh = ob.h - dy;
    }
    const min = 4;
    if (w < min) {
      if (mode.includes('w')) x -= min - w;
      w = min;
    }
    if (hh < min) {
      if (mode.includes('n')) y -= min - hh;
      hh = min;
    }
    // Images et dessins : proportions gardées par les coins (Maj : libre)
    if ((o.type === 'image' || o.type === 'ink') && mode.length === 2 && !free) {
      const ratio = ob.w / Math.max(ob.h, 0.01);
      if (w / hh > ratio) w = hh * ratio;
      else hh = w / ratio;
      if (mode.includes('w')) x = ob.x + ob.w - w;
      if (mode.includes('n')) y = ob.y + ob.h - hh;
    }
    if (o.type === 'text') {
      Object.assign(o, { x: round(x), w: round(Math.max(o.size, w)) });
      return;
    }
    if (o.type === 'ink') {
      const sx = w / Math.max(ob.w, 0.01);
      const sy = hh / Math.max(ob.h, 0.01);
      o.points = orig.points.map((v, i) => round(i % 2 ? y + (v - ob.y) * sy : x + (v - ob.x) * sx));
      return;
    }
    Object.assign(o, { x: round(x), y: round(y), w: round(w), h: round(hh) });
  }

  /** Maj enfoncée : angle arrondi à 45°. */
  function snapAngle(x0, y0, x, y) {
    const a = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(x - x0, y - y0);
    return [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len];
  }

  function drawInk(e, p, pt) {
    e.preventDefault();
    const s = state.style.pen;
    const o = { id: nid(), type: 'ink', points: [round(pt.x), round(pt.y)], stroke: s.stroke, width: s.width, opacity: s.opacity };
    const before = snapshot();
    p.objects.push(o);
    refreshPage(p.key);
    let last = pt;
    drag(
      e,
      p.key,
      (q) => {
        if (Math.hypot(q.x - last.x, q.y - last.y) < 0.6) return;
        last = q;
        o.points.push(round(q.x), round(q.y));
        refreshPage(p.key);
      },
      () => {
        o.points = simplify(o.points, 0.35);
        pushUndo(before);
        refreshPage(p.key);
        updateBar();
        renderThumbs();
      }
    );
  }

  /** Tracé allégé (Ramer-Douglas-Peucker), sans perte visible. */
  function simplify(points, eps) {
    const pts = [];
    for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i], points[i + 1]]);
    if (pts.length < 3) return points;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1;
      let dmax = 0;
      const [x1, y1] = pts[a];
      const [x2, y2] = pts[b];
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((x2 - x1) * (y1 - pts[i][1]) - (x1 - pts[i][0]) * (y2 - y1)) / len;
        if (d > dmax) {
          dmax = d;
          best = i;
        }
      }
      if (dmax > eps && best > 0) {
        keep[best] = 1;
        stack.push([a, best], [best, b]);
      }
    }
    return pts.filter((_, i) => keep[i]).flat();
  }

  function drawShape(e, p, pt, tool) {
    e.preventDefault();
    const st = state.style;
    let o;
    if (tool === 'line' || tool === 'arrow') o = { id: nid(), type: tool, x1: round(pt.x), y1: round(pt.y), x2: round(pt.x), y2: round(pt.y), stroke: st.line.stroke, width: st.line.width, opacity: st.line.opacity };
    else if (tool === 'highlight') o = { id: nid(), type: 'highlight', x: pt.x, y: pt.y, w: 0, h: 0, color: st.highlight.color, opacity: st.highlight.opacity };
    else if (tool === 'whiteout') o = { id: nid(), type: 'whiteout', x: pt.x, y: pt.y, w: 0, h: 0, fill: st.whiteout.fill };
    else if (tool === 'redact') o = { id: nid(), type: 'redact', x: pt.x, y: pt.y, w: 0, h: 0 };
    else o = { id: nid(), type: tool, x: pt.x, y: pt.y, w: 0, h: 0, stroke: st.shape.stroke, fill: st.shape.fill, width: st.shape.width, opacity: st.shape.opacity };
    const before = snapshot();
    p.objects.push(o);
    drag(
      e,
      p.key,
      (q, ev) => {
        if (o.type === 'line' || o.type === 'arrow') {
          const [x, y] = ev.shiftKey ? snapAngle(o.x1, o.y1, q.x, q.y) : [q.x, q.y];
          Object.assign(o, { x2: round(x), y2: round(y) });
        } else {
          let w = q.x - pt.x;
          let hh = q.y - pt.y;
          if (ev.shiftKey && (o.type === 'rect' || o.type === 'ellipse')) {
            const s = Math.max(Math.abs(w), Math.abs(hh));
            w = Math.sign(w || 1) * s;
            hh = Math.sign(hh || 1) * s;
          }
          Object.assign(o, { x: round(Math.min(pt.x, pt.x + w)), y: round(Math.min(pt.y, pt.y + hh)), w: round(Math.abs(w)), h: round(Math.abs(hh)) });
        }
        refreshPage(p.key);
      },
      (q, ev, moved) => {
        const tiny = o.type === 'line' || o.type === 'arrow' ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3 : o.w < 3 || o.h < 3;
        if (!moved || tiny) {
          // Simple clic : forme de taille par défaut (rien pour le surlignage)
          if (o.type === 'highlight') {
            p.objects = p.objects.filter((x) => x !== o);
            refreshPage(p.key);
            return;
          }
          if (o.type === 'line' || o.type === 'arrow') Object.assign(o, { x2: round(o.x1 + 120), y2: o.y1 });
          else Object.assign(o, { w: o.type === 'redact' || o.type === 'whiteout' ? 140 : 120, h: o.type === 'redact' || o.type === 'whiteout' ? 18 : 80 });
        }
        pushUndo(before);
        if (o.type !== 'highlight') {
          setToolQuiet('select');
          for (const pg of state.pages) refreshPage(pg.key);
          select(p.key, o.id);
        } else refreshPage(p.key);
        updateBar();
        renderThumbs();
      }
    );
  }

  // ---------------------------------------------------------------- Modifier le texte existant

  /** Lignes de texte d'une page (pdf.js), regroupées par ligne de base. */
  async function loadLines(p) {
    if (!p || p.src === null || state.lines.has(p.src)) return;
    state.lines.set(p.src, []);
    const page = state.pdfPages.get(p.src);
    let content;
    try {
      content = await page.getTextContent();
    } catch {
      return;
    }
    const lib = await initPdf();
    const vp = page.getViewport({ scale: 1, rotation: page.rotate });
    const items = [];
    for (const it of content.items) {
      if (typeof it.str !== 'string' || !it.str.length) continue;
      const t = lib.Util.transform(vp.transform, it.transform);
      // Texte horizontal, de gauche à droite, à l'écran
      if (!(t[0] > 0) || Math.abs(t[1]) > Math.abs(t[0]) * 0.05) continue;
      const size = Math.hypot(t[2], t[3]);
      if (!(size > 1)) continue;
      const style = content.styles[it.fontName] || {};
      const width = it.width * (vp.scale || 1) * (t[0] / Math.hypot(it.transform[0], it.transform[1]) || 1);
      items.push({ str: it.str, x: t[4], base: t[5], size, w: Math.abs(width) || it.str.length * size * 0.5, fontName: it.fontName, family: style.fontFamily, ascent: style.ascent || 0.8, descent: style.descent || -0.2 });
    }
    items.sort((a, b) => a.base - b.base || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      const gap = last ? it.x - (last.x + last.w) : 0;
      if (last && Math.abs(it.base - last.base) < last.size * 0.3 && Math.abs(it.size - last.size) < last.size * 0.2 && gap < last.size * 1.2 && gap > -last.size * 0.6) {
        const space = gap > last.size * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? ' ' : '';
        last.text += space + it.str;
        last.w = Math.max(last.w, it.x + it.w - last.x);
      } else {
        lines.push({ text: it.str, x: it.x, base: it.base, size: it.size, w: it.w, fontName: it.fontName, family: it.family, ascent: it.ascent, descent: it.descent });
      }
    }
    const list = lines
      .map((l, i) => ({ ...l, id: `${p.src}:${i}`, text: l.text.replace(/\s+$/, ''), top: l.base - l.ascent * l.size, height: (l.ascent - l.descent) * l.size }))
      .filter((l) => l.text.trim());
    state.lines.set(p.src, list);
    for (const pg of state.pages) if (pg.src === p.src) refreshPage(pg.key);
  }

  function loadLinesForVisible() {
    for (const [key, entry] of pageEls) if (entry.visible) loadLines(pageOf(key));
  }

  function editTextAt(e, p, pt) {
    const box = e.target.closest('.ed-textline');
    if (!box) {
      // Un texte déjà modifié : on le reprend
      const target = e.target.closest('.ed-obj');
      const o = target && p.objects.find((x) => x.id === target.dataset.id);
      if (o && o.type === 'text') {
        e.preventDefault();
        setToolQuiet('select');
        startEditing(p.key, o);
      }
      return;
    }
    e.preventDefault();
    const line = (state.lines.get(p.src) || []).find((l) => l.id === box.dataset.line);
    if (!line) return;
    const entry = pageEls.get(p.key);
    // Couleurs relevées sur le rendu de la page
    const k = entry.canvas.width / p.width;
    const colors = sampleColors(entry.canvas, line.x * k, line.top * k, line.w * k, line.height * k);
    let fontInfo = { name: '' };
    try {
      const page = state.pdfPages.get(p.src);
      if (page.commonObjs.has(line.fontName)) fontInfo = page.commonObjs.get(line.fontName) || fontInfo;
    } catch {
      // police inconnue : déduite de la famille
    }
    const guess = guessFont(fontInfo.name || fontInfo.loadedName, line.family);
    if (fontInfo.bold) guess.bold = true;
    if (fontInfo.italic) guess.italic = true;
    const size = round(line.size);
    const o = { id: nid(), type: 'text', source: line.id, x: round(line.x), y: 0, w: 0, text: line.text, size, font: guess.font, bold: guess.bold, italic: guess.italic, underline: false, align: 'left', color: colors.text, opacity: 1 };
    o.y = round(line.base - baselineOf(o));
    const padX = Math.max(1, size * 0.08);
    const padY = Math.max(1, size * 0.12);
    o.cover = { x: round(line.x - padX), y: round(line.top - padY), w: round(line.w + 2 * padX), h: round(line.height + 2 * padY), color: colors.background };
    editBefore = snapshot();
    p.objects.push(o);
    setToolQuiet('select');
    startEditing(p.key, o, { selectAll: false });
    toast('Modifiez le texte, puis cliquez ailleurs. Police, taille et couleur : à droite. Pour l\'effacer, videz-le.');
  }

  // ---------------------------------------------------------------- Calque : lignes de texte, champs du formulaire

  function renderLayer(p, entry) {
    const z = Z();
    const els = [];
    if (state.tool === 'edittext' && p.src !== null) {
      const done = new Set(state.pages.flatMap((pg) => pg.objects.filter((o) => o.source).map((o) => o.source)));
      for (const l of state.lines.get(p.src) || []) {
        if (done.has(l.id)) continue;
        const b = h('div', { class: 'ed-textline', dataset: { line: l.id }, 'data-tip': 'Cliquer pour modifier cette ligne' });
        Object.assign(b.style, { left: px(l.x - 1, z), top: px(l.top - 1, z), width: px(l.w + 2, z), height: px(l.height + 2, z) });
        els.push(b);
      }
    }
    if (state.hasForm && p.src !== null) {
      for (const field of state.form.fields.values()) {
        for (const w of field.widgets) if (w.page === p.src) els.push(fieldEl(field, w, z));
      }
    }
    entry.layer.replaceChildren(...els);
    entry.layer.classList.toggle('active', state.tool === 'form' || state.tool === 'select');
  }

  const fieldValue = (f) => (state.form.values.has(f.name) ? state.form.values.get(f.name) : f.initial);

  function setField(f, value) {
    const before = snapshot();
    if (JSON.stringify(value) === JSON.stringify(f.initial)) state.form.values.delete(f.name);
    else state.form.values.set(f.name, value);
    pushUndo(before);
    // Les autres cases du même champ (autres pages, boutons radio) suivent
    for (const p of state.pages) {
      const entry = pageEls.get(p.key);
      if (!entry || p.src === null || !f.widgets.some((w) => w.page === p.src)) continue;
      entry.layer.querySelectorAll(`[data-field="${CSS.escape(f.name)}"]`).forEach((el) => syncField(el, f));
    }
    updateBar();
  }

  function syncField(el, f) {
    const v = fieldValue(f);
    if (f.type === 'check') el.checked = Boolean(v);
    else if (f.type === 'radio') el.checked = v === el.value;
    else if (f.type === 'list') [...el.options].forEach((o) => (o.selected = v.includes(o.value)));
    else if (document.activeElement !== el) el.value = v;
  }

  function fieldEl(f, w, z) {
    let el;
    const font = `${clamp(Math.min(w.h * 0.62, 12), 6, 12) * z}px Arial, sans-serif`;
    if (f.type === 'text') {
      el = f.multiline ? h('textarea', { class: 'ed-field' }) : h('input', { type: 'text', class: 'ed-field' });
      if (f.maxLen) el.maxLength = f.maxLen;
      el.addEventListener('change', () => setField(f, el.value));
    } else if (f.type === 'check') {
      el = h('input', { type: 'checkbox', class: 'ed-field ed-check' });
      el.addEventListener('change', () => setField(f, el.checked));
    } else if (f.type === 'radio') {
      el = h('input', { type: 'radio', class: 'ed-field ed-check', name: `ed-${f.name}`, value: w.value });
      el.addEventListener('change', () => el.checked && setField(f, w.value));
    } else {
      el = h('select', { class: 'ed-field', multiple: f.type === 'list' && f.multiple ? true : null }, f.type === 'combo' ? h('option', { value: '' }, '') : null, f.options.map((o) => h('option', { value: o.value }, o.label)));
      el.addEventListener('change', () => setField(f, f.type === 'list' ? [...el.selectedOptions].map((o) => o.value) : el.value));
    }
    el.dataset.field = f.name;
    el.disabled = w.readOnly;
    el.title = f.name;
    Object.assign(el.style, { left: px(w.x, z), top: px(w.y, z), width: px(w.w, z), height: px(w.h, z), font });
    syncField(el, f);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('keydown', (e) => e.stopPropagation());
    return el;
  }

  // ---------------------------------------------------------------- Images et signature

  /** Image prête pour le PDF : orientation de l'appareil photo appliquée, 3000 px au plus, PNG ou JPEG. */
  async function prepareImage(blob, keepAlpha) {
    const bitmap = await createImageBitmap(blob);
    const k = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    const ctx = canvas.getContext('2d');
    if (!keepAlpha) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const out = await new Promise((resolve) => canvas.toBlob(resolve, keepAlpha ? 'image/png' : 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await out.arrayBuffer());
    const id = `img${++seq}`;
    state.images.set(id, { bytes, url: URL.createObjectURL(out), width: canvas.width, height: canvas.height });
    return id;
  }

  /** Place une image au centre de la page affichée, à une taille raisonnable. */
  function placeImage(id, { maxW = 0.5, maxH = 0.4, kind = 'image' } = {}) {
    const p = state.pages[state.current || 0];
    const img = state.images.get(id);
    const k = Math.min((p.width * maxW) / img.width, (p.height * maxH) / img.height, kind === 'sign' ? 1 : 0.75);
    const w = round(img.width * k);
    const hh = round(img.height * k);
    // Centre de la partie visible de la page
    const entry = pageEls.get(p.key);
    const r = entry.el.getBoundingClientRect();
    const v = viewer.getBoundingClientRect();
    const z = Z();
    const cy = clamp(((Math.max(r.top, v.top) + Math.min(r.bottom, v.bottom)) / 2 - r.top) / z, hh / 2, p.height - hh / 2);
    const o = { id: nid(), type: 'image', image: id, x: round((p.width - w) / 2), y: round(cy - hh / 2), w, h: hh, opacity: 1 };
    change(() => p.objects.push(o), { page: p.key });
    setToolQuiet('select');
    for (const pg of state.pages) refreshPage(pg.key);
    select(p.key, o.id);
    renderThumbs();
  }

  async function insertImage() {
    const files = await pickFiles('images', false);
    if (!files.length) return;
    const f = files[0];
    try {
      const bytes = await api.bytes(f.id);
      const id = await prepareImage(new Blob([bytes]), f.type === 'png');
      placeImage(id);
    } catch (err) {
      toast(`Image illisible : ${err.message}`, 'error');
    } finally {
      api.release([f.id]);
    }
  }

  async function insertSignature() {
    const dataUrl = await signatureDialog();
    if (!dataUrl) return;
    // data: URL → octets (fetch est réservé au protocole interne)
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    const blob = new Blob([raw], { type: 'image/png' });
    const id = await prepareImage(blob, true);
    placeImage(id, { maxW: 0.32, maxH: 0.12, kind: 'sign' });
  }

  /** Fenêtre de signature : tracé à la souris, au stylet ou au doigt ; signature mémorisée réutilisable. */
  function signatureDialog() {
    return new Promise((resolve) => {
      let saved = null;
      try {
        saved = localStorage.getItem(SIGN_KEY);
      } catch {
        saved = null;
      }
      const canvas = h('canvas', { class: 'sig-pad', width: '1200', height: '400', 'aria-label': 'Zone de signature' });
      const ctx = canvas.getContext('2d');
      let strokes = 0;
      let inkColor = '#1f3a5f';
      const colors = h(
        'div',
        { class: 'swatches' },
        ['#1f3a5f', '#000000', '#2b7bd6'].map((c) => {
          const b = h('button', { type: 'button', class: 'swatch', 'aria-label': c, 'aria-checked': String(c === inkColor), role: 'radio' });
          b.style.background = c;
          b.addEventListener('click', () => {
            inkColor = c;
            colors.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === b)));
          });
          return b;
        })
      );
      const remember = h('input', { type: 'checkbox' });
      remember.checked = true;
      let last = null;
      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        const r = canvas.getBoundingClientRect();
        last = [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
        strokes++;
        ctx.fillStyle = inkColor;
        ctx.beginPath();
        ctx.arc(last[0], last[1], 3, 0, Math.PI * 2);
        ctx.fill();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!last) return;
        const r = canvas.getBoundingClientRect();
        const p = [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
        ctx.strokeStyle = inkColor;
        ctx.lineWidth = e.pressure && e.pointerType === 'pen' ? 3 + e.pressure * 5 : 6;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(...last);
        ctx.lineTo(...p);
        ctx.stroke();
        last = p;
      });
      const end = () => (last = null);
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);

      const dialog = h('dialog', { class: 'ed-dialog', 'aria-label': 'Signature' });
      const finish = (value) => {
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      /** Signature recadrée (fond transparent). */
      const exportPng = () => {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let x1 = canvas.width;
        let y1 = canvas.height;
        let x2 = 0;
        let y2 = 0;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            if (d[(y * canvas.width + x) * 4 + 3] > 10) {
              if (x < x1) x1 = x;
              if (x > x2) x2 = x;
              if (y < y1) y1 = y;
              if (y > y2) y2 = y;
            }
          }
        }
        if (x2 < x1) return null;
        const m = 8;
        const out = document.createElement('canvas');
        out.width = x2 - x1 + 2 * m;
        out.height = y2 - y1 + 2 * m;
        out.getContext('2d').drawImage(canvas, x1 - m, y1 - m, out.width, out.height, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      };
      dialog.append(
        h('h3', null, 'Votre signature'),
        h('p', { class: 'muted' }, 'Signez dans le cadre à la souris, au stylet ou au doigt.'),
        canvas,
        h(
          'div',
          { class: 'sig-row' },
          colors,
          h('label', { class: 'check' }, remember, 'Mémoriser pour les prochaines fois'),
          button('Effacer', {
            cls: 'small ghost',
            onClick: () => {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              strokes = 0;
            },
          })
        ),
        h(
          'div',
          { class: 'sig-actions' },
          saved ? button('Utiliser ma signature enregistrée', { icon: 'sign', cls: 'ghost', onClick: () => finish(saved) }) : null,
          saved
            ? button('', {
                icon: 'trash',
                cls: 'icon-only ghost',
                tip: 'Oublier la signature enregistrée',
                onClick: (e) => {
                  try {
                    localStorage.removeItem(SIGN_KEY);
                  } catch {
                    // préférence indisponible
                  }
                  e.currentTarget.previousSibling?.remove();
                  e.currentTarget.remove();
                },
              })
            : null,
          h('span', { class: 'spacer' }),
          button('Annuler', { cls: 'ghost', onClick: () => finish(null) }),
          button('Placer la signature', {
            icon: 'check',
            cls: 'primary',
            onClick: () => {
              const url = strokes ? exportPng() : null;
              if (!url) {
                toast('Signez d\'abord dans le cadre.', 'error');
                return;
              }
              if (remember.checked) {
                try {
                  localStorage.setItem(SIGN_KEY, url);
                } catch {
                  // trop volumineuse : non mémorisée
                }
              }
              finish(url);
            },
          })
        )
      );
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish(null);
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  // ---------------------------------------------------------------- Propriétés

  function swatchRow(list, value, onPick, { none = false } = {}) {
    const row = h('div', { class: 'swatches', role: 'radiogroup' });
    const pick = (v) => {
      row.querySelectorAll('[role=radio]').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.value === String(v))));
      onPick(v);
    };
    if (none) {
      const b = h('button', { type: 'button', class: 'swatch none', role: 'radio', 'aria-label': 'Aucun', 'data-tip': 'Aucun', 'aria-checked': String(!value), dataset: { value: 'null' } });
      b.addEventListener('click', () => pick(null));
      row.append(b);
    }
    for (const c of list) {
      const b = h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-label': c, 'aria-checked': String(c === value), dataset: { value: c } });
      b.style.background = c;
      b.addEventListener('click', () => pick(c));
      row.append(b);
    }
    const custom = h('input', { type: 'color', class: 'color-input', 'aria-label': 'Autre couleur', 'data-tip': 'Autre couleur', value: value || '#000000' });
    custom.addEventListener('change', () => pick(custom.value));
    row.append(custom);
    return row;
  }

  const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), control);

  function numberInput(value, min, max, step, onSet) {
    const el = h('input', { type: 'number', class: 'num-input', min: String(min), max: String(max), step: String(step), value: String(value) });
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) onSet(clamp(v, min, max));
      else el.value = String(value);
    });
    return el;
  }

  function rangeInput(value, min, max, onSet, format) {
    const el = h('input', { type: 'range', class: 'range', min: String(min), max: String(max), step: '1', value: String(value) });
    const out = h('output', { class: 'muted' }, format(value));
    el.addEventListener('input', () => (out.textContent = format(Number(el.value))));
    el.addEventListener('change', () => onSet(Number(el.value)));
    return h('div', { class: 'range-row' }, el, out);
  }

  /** Change une propriété de l'objet sélectionné (et le style par défaut de l'outil). */
  function setProp(group, key, value) {
    const o = objOf(state.sel);
    if (group) {
      state.style[group][key] = value;
      saveStyle(state.style);
    }
    if (o) {
      const pageKey = state.sel.page;
      if (state.editing === o.id) {
        // Saisie en cours : appliqué tout de suite, l'historique est enregistré à la fin de la saisie
        o[key] = value;
        refreshPage(pageKey);
        return;
      }
      change(() => (o[key] = value), { page: pageKey });
    } else renderProps();
  }

  function textProps(o) {
    const s = o || state.style.text;
    const fonts = h('select', { 'aria-label': 'Police' }, FONTS.map((f) => h('option', { value: f.name }, f.unicode ? f.name : `${f.name} (alphabet latin)`)));
    fonts.value = s.font;
    fonts.addEventListener('change', () => setProp('text', 'font', fonts.value));
    const style = (key, ic, tip) => {
      const b = button('', { icon: ic, cls: `icon-only ghost toggle-btn${s[key] ? ' on' : ''}`, tip, onClick: () => setProp('text', key, !s[key]) });
      b.setAttribute('aria-pressed', String(Boolean(s[key])));
      return b;
    };
    const align = segmented(
      [
        ['left', 'Gauche'],
        ['center', 'Centre'],
        ['right', 'Droite'],
      ],
      s.align,
      (v) => setProp('text', 'align', v),
      { compact: true, label: 'Alignement' }
    );
    return [
      field('Police', fonts),
      h('div', { class: 'ed-row' }, field('Taille', numberInput(s.size, 4, 200, 0.5, (v) => setProp('text', 'size', v))), h('div', { class: 'ed-styles' }, style('bold', 'bold', 'Gras'), style('italic', 'italic', 'Italique'), style('underline', 'underline', 'Souligné'))),
      field('Couleur', swatchRow(COLORS, s.color, (v) => setProp('text', 'color', v))),
      o && o.w ? field('Alignement', align.el) : null,
      o ? h('p', { class: 'hint' }, o.w ? 'Largeur fixe : le texte passe à la ligne. Poignées gauche / droite pour la changer.' : 'Largeur automatique. Tirez une poignée pour fixer une largeur (retour à la ligne automatique).') : null,
    ];
  }

  function renderProps() {
    if (!props) return;
    const o = objOf(state.sel);
    const parts = [];
    const tool = TOOLS.find((t) => t.id === state.tool);
    const title = (t, sub) => h('div', { class: 'ed-props-head' }, h('strong', null, t), sub ? h('span', { class: 'muted' }, sub) : null);
    if (o) {
      const names = { text: o.cover ? 'Texte modifié' : 'Texte', image: 'Image', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Ligne', arrow: 'Flèche', ink: 'Dessin', highlight: 'Surlignage', whiteout: 'Cache', redact: 'Zone caviardée' };
      parts.push(title(names[o.type] || 'Objet', 'sélectionné'));
      if (o.type === 'text') {
        parts.push(...textProps(o));
        if (state.editing !== o.id) parts.push(button('Modifier le texte', { icon: 'edit', cls: 'small', onClick: () => startEditing(state.sel.page, o) }));
        if (o.cover) parts.push(field('Fond du cache', swatchRow(['#ffffff', '#f2f6fa', '#fff8e1'], o.cover.color, (v) => change(() => (o.cover.color = v), { page: state.sel.page }))), h('p', { class: 'hint' }, 'À l\'enregistrement, le texte d\'origine est retiré du fichier (s\'il ne peut pas l\'être, il est recouvert par ce cache). Videz le texte pour effacer la ligne.'));
      } else if (o.type === 'rect' || o.type === 'ellipse') {
        parts.push(field('Contour', swatchRow(COLORS, o.stroke, (v) => setProp('shape', 'stroke', v), { none: true })), field('Remplissage', swatchRow(COLORS, o.fill, (v) => setProp('shape', 'fill', v), { none: true })), field('Épaisseur', numberInput(o.width, 0, 30, 0.5, (v) => setProp('shape', 'width', v))), field('Opacité', rangeInput(Math.round(o.opacity * 100), 10, 100, (v) => setProp('shape', 'opacity', v / 100), (v) => `${v} %`)));
      } else if (o.type === 'line' || o.type === 'arrow') {
        parts.push(field('Couleur', swatchRow(COLORS, o.stroke, (v) => setProp('line', 'stroke', v))), field('Épaisseur', numberInput(o.width, 0.5, 30, 0.5, (v) => setProp('line', 'width', v))), field('Opacité', rangeInput(Math.round(o.opacity * 100), 10, 100, (v) => setProp('line', 'opacity', v / 100), (v) => `${v} %`)));
      } else if (o.type === 'ink') {
        parts.push(field('Couleur', swatchRow(COLORS, o.stroke, (v) => setProp('pen', 'stroke', v))), field('Épaisseur', numberInput(o.width, 0.5, 30, 0.5, (v) => setProp('pen', 'width', v))), field('Opacité', rangeInput(Math.round(o.opacity * 100), 10, 100, (v) => setProp('pen', 'opacity', v / 100), (v) => `${v} %`)));
      } else if (o.type === 'highlight') {
        parts.push(field('Couleur', swatchRow(HIGHLIGHTS, o.color, (v) => setProp('highlight', 'color', v))));
      } else if (o.type === 'whiteout') {
        parts.push(field('Couleur du cache', swatchRow(['#ffffff', '#f2f6fa', '#000000'], o.fill, (v) => setProp('whiteout', 'fill', v))), h('p', { class: 'hint' }, 'Le cache recouvre la zone, mais le contenu reste dans le fichier (copiable). Pour le supprimer vraiment : Caviarder.'));
      } else if (o.type === 'redact') {
        parts.push(h('p', { class: 'hint' }, 'À l\'enregistrement, cette page devient une image : ce qui est sous la zone noire est supprimé du fichier.'));
      } else if (o.type === 'image') {
        parts.push(field('Opacité', rangeInput(Math.round(o.opacity * 100), 10, 100, (v) => setProp(null, 'opacity', v / 100), (v) => `${v} %`)), h('p', { class: 'hint' }, 'Coins : redimensionner en gardant les proportions (Maj : librement).'));
      }
      parts.push(
        h(
          'div',
          { class: 'ed-objactions' },
          button('', { icon: 'copy', cls: 'icon-only ghost', tip: 'Dupliquer (Ctrl + D)', onClick: duplicateSelected }),
          button('', { icon: 'front', cls: 'icon-only ghost', tip: 'Premier plan', onClick: () => reorder(1) }),
          button('', { icon: 'back', cls: 'icon-only ghost', tip: 'Arrière-plan', onClick: () => reorder(-1) }),
          button('Supprimer', { icon: 'trash', cls: 'small ghost danger', tip: 'Supprimer (Suppr)', onClick: removeSelected })
        )
      );
    } else {
      parts.push(title(tool ? tool.name : 'Sélection', null));
      const help = {
        select: 'Cliquez sur un ajout pour le sélectionner, glissez pour le déplacer, tirez les poignées pour le redimensionner. Double-clic sur un texte pour le modifier. Flèches : déplacer finement (Maj : plus vite).',
        edittext: 'Les lignes du PDF qu\'on peut réécrire s\'encadrent au survol : cliquez sur l\'une d\'elles. Le texte d\'origine est recouvert, le nouveau est écrit à sa place (police et couleur reprises au plus près).',
        text: 'Cliquez à l\'endroit où écrire. Entrée : nouvelle ligne ; Échap ou clic ailleurs : terminer.',
        pen: 'Dessinez à main levée en maintenant le bouton. L\'outil reste actif pour plusieurs traits.',
        highlight: 'Tracez un rectangle sur le passage à surligner.',
        rect: 'Tracez le rectangle ; Maj : carré.',
        ellipse: 'Tracez l\'ellipse ; Maj : cercle.',
        line: 'Tracez la ligne ; Maj : horizontale, verticale ou à 45°.',
        arrow: 'Tracez la flèche depuis son départ ; Maj : horizontale, verticale ou à 45°.',
        whiteout: 'Tracez la zone à recouvrir (blanc par défaut). Le contenu reste dans le fichier.',
        redact: 'Tracez les zones à supprimer définitivement. À l\'enregistrement, les pages concernées deviennent des images.',
        form: 'Cliquez dans les champs pour les remplir. Ils restent modifiables dans le PDF, sauf si vous l\'aplatissez.',
      };
      parts.push(h('p', { class: 'hint' }, help[state.tool] || ''));
      if (state.tool === 'text') parts.push(...textProps(null));
      if (state.tool === 'rect' || state.tool === 'ellipse') {
        const s = state.style.shape;
        parts.push(field('Contour', swatchRow(COLORS, s.stroke, (v) => setProp('shape', 'stroke', v), { none: true })), field('Remplissage', swatchRow(COLORS, s.fill, (v) => setProp('shape', 'fill', v), { none: true })), field('Épaisseur', numberInput(s.width, 0, 30, 0.5, (v) => setProp('shape', 'width', v))));
      }
      if (state.tool === 'line' || state.tool === 'arrow') {
        const s = state.style.line;
        parts.push(field('Couleur', swatchRow(COLORS, s.stroke, (v) => setProp('line', 'stroke', v))), field('Épaisseur', numberInput(s.width, 0.5, 30, 0.5, (v) => setProp('line', 'width', v))));
      }
      if (state.tool === 'pen') {
        const s = state.style.pen;
        parts.push(field('Couleur', swatchRow(COLORS, s.stroke, (v) => setProp('pen', 'stroke', v))), field('Épaisseur', numberInput(s.width, 0.5, 30, 0.5, (v) => setProp('pen', 'width', v))));
      }
      if (state.tool === 'highlight') parts.push(field('Couleur', swatchRow(HIGHLIGHTS, state.style.highlight.color, (v) => setProp('highlight', 'color', v))));
      if (state.tool === 'whiteout') parts.push(field('Couleur du cache', swatchRow(['#ffffff', '#f2f6fa', '#000000'], state.style.whiteout.fill, (v) => setProp('whiteout', 'fill', v))));
      if (state.hasForm) {
        const flat = toggle(
          'Aplatir le formulaire',
          state.form.flatten,
          (on) => {
            const before = snapshot();
            state.form.flatten = on;
            pushUndo(before);
            updateBar();
          },
          'Les réponses deviennent du texte définitif : les champs ne sont plus modifiables'
        );
        parts.push(h('div', { class: 'ed-formbox' }, h('strong', null, `Formulaire : ${plural(state.form.fields.size, 'champ')}`), h('span', { class: 'muted' }, state.form.values.size ? `${plural(state.form.values.size, 'champ modifié', 'champs modifiés')}` : 'aucun champ modifié'), flat.el));
      }
    }
    props.replaceChildren(...parts.filter(Boolean));
  }

  // ---------------------------------------------------------------- Actions sur l'objet sélectionné

  function removeSelected() {
    const o = objOf(state.sel);
    if (!o) return;
    const key = state.sel.page;
    state.editing = null;
    editBefore = null;
    change(
      () => {
        const p = pageOf(key);
        p.objects = p.objects.filter((x) => x.id !== o.id);
        state.sel = null;
      },
      { page: key }
    );
    renderThumbs();
  }

  function duplicateSelected() {
    const o = objOf(state.sel);
    if (!o) return;
    finishEditing();
    const key = state.sel.page;
    const copy = clone(o);
    copy.id = nid();
    delete copy.cover; // la copie d'un texte modifié est un texte ordinaire
    delete copy.source;
    moveObject(copy, clone(copy), 12, 12);
    change(() => pageOf(key).objects.push(copy), { page: key });
    select(key, copy.id);
  }

  function reorder(dir) {
    const o = objOf(state.sel);
    if (!o) return;
    const key = state.sel.page;
    change(
      () => {
        const p = pageOf(key);
        p.objects = p.objects.filter((x) => x !== o);
        if (dir > 0) p.objects.push(o);
        else p.objects.unshift(o);
      },
      { page: key }
    );
  }

  let clipboard = null;
  function copySelected() {
    const o = objOf(state.sel);
    if (!o) return false;
    clipboard = clone(o);
    delete clipboard.cover;
    delete clipboard.source;
    toast('Copié : Ctrl + V pour le coller sur la page affichée.');
    return true;
  }
  function paste() {
    if (!clipboard) return false;
    const p = state.pages[state.current || 0];
    const copy = clone(clipboard);
    copy.id = nid();
    moveObject(copy, clone(copy), 12, 12);
    clipboard = clone(copy);
    delete clipboard.id;
    change(() => p.objects.push(copy), { page: p.key });
    select(p.key, copy.id);
    renderThumbs();
    return true;
  }

  function nudge(dx, dy) {
    const o = objOf(state.sel);
    if (!o) return;
    change(() => moveObject(o, clone(o), dx, dy), { page: state.sel.page });
  }

  // ---------------------------------------------------------------- Résumé, enregistrement

  function changesCount() {
    const objects = state.pages.reduce((n, p) => n + p.objects.length, 0);
    const pagesChanged = state.pages.length !== (state.file ? state.file.pageCount : 0) || state.pages.some((p, i) => p.src !== i);
    return { objects, form: state.form.values.size + (state.form.flatten ? 1 : 0), pages: pagesChanged };
  }

  function updateBar() {
    if (!bar) return;
    const c = changesCount();
    const parts = [];
    if (c.objects) parts.push(plural(c.objects, 'ajout'));
    if (state.form.values.size) parts.push(plural(state.form.values.size, 'champ rempli', 'champs remplis'));
    if (state.form.flatten) parts.push('formulaire aplati');
    if (c.pages) parts.push(`${plural(state.pages.length, 'page')} (ordre ou nombre changé)`);
    const redacted = state.pages.filter((p) => p.objects.some((o) => o.type === 'redact')).length;
    if (redacted) parts.push(`${plural(redacted, 'page caviardée', 'pages caviardées')}`);
    bar.querySelector('.action-summary').textContent = parts.length ? parts.join(' · ') : 'Aucune modification pour le moment';
  }

  /** Plan envoyé au processus principal : textes mis en lignes, coordonnées en points de la page affichée. */
  function buildPlan() {
    const usedImages = new Set();
    const pages = state.pages.map((p) => ({
      src: p.src,
      width: p.width,
      height: p.height,
      objects: p.objects
        .map((o) => {
          if (o.type === 'text') {
            const { lines, width } = layoutText(o);
            if (!String(o.text).trim() && !o.cover) return null;
            // Texte du PDF réécrit : l'ancien est retiré du fichier (erase), le cache ne sert que si c'est impossible
            return { type: 'text', x: o.x, y: o.y, w: width, lines, size: o.size, lineHeight: lineHeightOf(o), baseline: baselineOf(o), font: o.font, bold: o.bold, italic: o.italic, underline: o.underline, align: o.align, color: o.color, opacity: o.opacity ?? 1, cover: o.cover || null, erase: Boolean(o.source && o.cover) };
          }
          if (o.type === 'whiteout') return { type: 'rect', x: o.x, y: o.y, w: o.w, h: o.h, fill: o.fill || '#ffffff', stroke: null, width: 0, opacity: 1 };
          if (o.type === 'image') usedImages.add(o.image);
          return { ...o, id: undefined };
        })
        .filter(Boolean),
    }));
    const values = {};
    for (const [k, v] of state.form.values) values[k] = v;
    const form = state.form.values.size || state.form.flatten ? { values, flatten: state.form.flatten } : null;
    const images = {};
    for (const id of usedImages) {
      const img = state.images.get(id);
      if (img) images[id] = img.bytes;
    }
    return { plan: { pages, form }, images };
  }

  async function save() {
    finishEditing();
    if (!state.file) return;
    const { plan, images } = buildPlan();
    const redacted = state.pages.map((p, i) => (p.objects.some((o) => o.type === 'redact') ? i : -1)).filter((i) => i >= 0);
    let pendingId = null;
    try {
      const built = await withBusy('Application des modifications…', async () => {
        const res = await api.editBuild(state.file.id, plan, images);
        if (!res || !res.ok) return res;
        pendingId = res.id;
        if (redacted.length) {
          // Caviardage : les pages concernées du résultat sont rendues en image puis remplacées
          const key = `edit-out-${res.id}`;
          await getDocument(key, () => api.pendingBytes(res.id));
          const list = [];
          for (let k = 0; k < redacted.length; k++) {
            const img = await renderToImage(key, redacted[k], { dpi: 200, type: 'image/jpeg', quality: 0.9 });
            list.push({ index: redacted[k], bytes: img.bytes });
          }
          forget(key);
          const r2 = await api.editRasterize(res.id, list);
          if (!r2 || !r2.ok) return r2;
        }
        return res;
      });
      if (!check(built)) return;
      const res = await api.savePending(pendingId, `${baseName(state.file.name)}_modifie.pdf`, state.file.id);
      if (!check(res)) return;
      state.saved = true;
      showResult(result, res, { title: 'PDF modifié enregistré', detail: `${plural(res.pages, 'page')} · ${formatBytes(res.size)}${redacted.length ? ` · ${plural(redacted.length, 'page caviardée', 'pages caviardées')}` : ''}` });
    } finally {
      if (pendingId) api.releasePending(pendingId);
    }
  }

  // ---------------------------------------------------------------- Clavier

  function onKey(e) {
    if (!state.file) return false;
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    const k = e.key.toLowerCase();
    if (ctrl && k === 's') {
      save();
      return true;
    }
    if (typing) return false;
    if (ctrl && k === 'z') {
      if (e.shiftKey) redo();
      else undo();
      return true;
    }
    if (ctrl && k === 'y') {
      redo();
      return true;
    }
    if (ctrl && k === 'd') {
      duplicateSelected();
      return true;
    }
    if (ctrl && k === 'c') return copySelected();
    if (ctrl && k === 'v') return paste();
    if (ctrl && (k === '+' || k === '=')) {
      zoomStep(1);
      return true;
    }
    if (ctrl && k === '-') {
      zoomStep(-1);
      return true;
    }
    if (ctrl && k === '0') {
      setZoom('fit');
      return true;
    }
    if (ctrl) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) {
      removeSelected();
      return true;
    }
    if (e.key === 'Escape') {
      if (state.sel) select(null, null);
      else if (state.tool !== 'select') setTool('select');
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'F2') && state.sel) {
      const o = objOf(state.sel);
      if (o && o.type === 'text') {
        startEditing(state.sel.page, o);
        return true;
      }
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && state.sel) {
      const [dx, dy] = arrows[e.key];
      const step = e.shiftKey ? 10 : 1;
      nudge(dx * step, dy * step);
      return true;
    }
    const tool = TOOLS.find((t) => t.key === k && (!t.forms || state.hasForm));
    if (tool && !e.shiftKey) {
      setTool(tool.id);
      return true;
    }
    return false;
  }

  render();
  return { el: root, accept: 'pdf', multiple: false, onFiles: open, onKey };
}
