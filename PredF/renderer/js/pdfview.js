/*
 * pdfview.js — Affichage des PDF avec pdf.js (moteur de Firefox), servi en local par le protocole interne.
 *
 * - Un document pdf.js par fichier ouvert (mis en cache), chargé à partir des octets fournis par le
 *   processus principal.
 * - Miniatures rendues à la demande (quand elles deviennent visibles), deux à la fois au plus.
 * - Rendu en pleine résolution pour l'export en images et la compression ; extraction du texte.
 */

import { api } from './core.js';

let lib = null;

/** Charge pdf.js (module ES et son worker). Appelé au démarrage : l'écran de chargement l'attend. */
export async function initPdf() {
  if (lib) return lib;
  lib = await import('/vendor/pdfjs/pdf.mjs');
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
  return lib;
}

const BASE = {
  cMapUrl: '/vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  wasmUrl: '/vendor/pdfjs/wasm/',
  iccUrl: '/vendor/pdfjs/iccs/',
  isEvalSupported: false,
  enableXfa: false,
  disableAutoFetch: true,
};

const docs = new Map(); // clé → Promise<PDFDocumentProxy>

/** Document pdf.js d'un fichier ouvert (id) ou d'octets fournis (aperçus). */
export function getDocument(key, bytesProvider) {
  if (!docs.has(key)) {
    const p = (async () => {
      await initPdf();
      const bytes = bytesProvider ? await bytesProvider() : await api.bytes(key);
      // Copie : pdf.js transfère le tampon à son worker
      return lib.getDocument({ ...BASE, data: new Uint8Array(bytes) }).promise;
    })();
    docs.set(key, p);
    p.catch(() => docs.delete(key));
  }
  return docs.get(key);
}

export async function forget(key) {
  const p = docs.get(key);
  docs.delete(key);
  if (p) {
    try {
      (await p).destroy();
    } catch {
      // déjà fermé
    }
  }
}

// ---------------------------------------------------------------------------
// File d'attente des rendus (évite de saturer le processeur avec 300 miniatures)
// ---------------------------------------------------------------------------

const queue = [];
let running = 0;
const MAX_PARALLEL = 2;

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const { task, resolve, reject } = queue.shift();
    running++;
    task()
      .then(resolve, reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

/**
 * Dessine une page dans un canvas, à la largeur CSS demandée (densité de l'écran prise en compte).
 * La rotation enregistrée dans le PDF est appliquée ; `extraRotate` ajoute une rotation (0/90/180/270).
 */
export function renderThumb(key, pageIndex, canvas, { width = 160, extraRotate = 0, bytesProvider } = {}) {
  return schedule(async () => {
    const doc = await getDocument(key, bytesProvider);
    const page = await doc.getPage(pageIndex + 1);
    const rotation = (page.rotate + extraRotate) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = (width / base.width) * dpr;
    const viewport = page.getViewport({ scale, rotation });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
    page.cleanup();
  });
}

/** Observe des canvas et les dessine quand ils approchent de la zone visible. */
export function lazyThumbs(root) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        const job = entry.target._thumb;
        if (job) job().catch(() => entry.target.classList.add('failed'));
      }
    },
    { root, rootMargin: '400px' }
  );
  return {
    add(canvas, job) {
      canvas._thumb = job;
      io.observe(canvas);
    },
    disconnect: () => io.disconnect(),
  };
}

/**
 * Rend une page en image (pour l'export ou la compression).
 * Renvoie { bytes, widthPt, heightPt, widthPx, heightPx } ; la taille en points est celle de la page affichée.
 */
export async function renderToImage(key, pageIndex, { dpi = 150, type = 'image/png', quality = 0.85 } = {}) {
  const doc = await getDocument(key);
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  // Limite de taille des canvas : on réduit la résolution pour les très grandes pages
  let scale = dpi / 72;
  const maxSide = 12000;
  const maxArea = 120e6;
  scale = Math.min(scale, maxSide / Math.max(base.width, base.height), Math.sqrt(maxArea / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff', intent: 'print' }).promise;
  page.cleanup();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('Image trop grande pour être créée.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), widthPt: base.width, heightPt: base.height, widthPx: viewport.width, heightPx: viewport.height };
}

/** Texte d'une page (lignes reconstituées à partir des fins de ligne de pdf.js). */
export async function pageText(key, pageIndex) {
  const doc = await getDocument(key);
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  page.cleanup();
  return text.replace(/[ \t]+\n/g, '\n').trim();
}
