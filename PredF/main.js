/*
 * main.js — Processus principal de PredF.
 *
 * Application locale : la page ne fait aucune requête réseau (CSP « connect-src 'self' » limitée au
 * protocole interne, toute requête http(s)/ws de la page annulée, navigation et permissions bloquées).
 * Seule exception, à la demande de l'utilisateur : l'Assistant IA (lib/ai.js), qui envoie depuis le
 * processus principal les documents choisis à l'API Claude d'Anthropic.
 *
 * Rôle : fenêtres (écran de chargement puis fenêtre principale), préférences, lecture des fichiers choisis
 * ou déposés, et création des PDF avec le moteur (lib/engine.js). L'interface n'a pas accès au disque :
 * elle désigne les fichiers par un identifiant et n'écrit que dans les dossiers choisis par l'utilisateur.
 *
 * La page est servie par le protocole interne « predf:// » (au lieu de file://) : pdf.js a besoin de
 * modules ES et d'un worker, qui exigent une origine propre.
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, session, protocol, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const Engine = require('./lib/engine.js');
const Ranges = require('./lib/ranges.js');
const AI = require('./lib/ai.js');
const LocalAI = require('./lib/localai.js');
const MdPdf = require('./lib/mdpdf.js');
const Markdown = require('./lib/markdown.js');

const IS_WIN = process.platform === 'win32';
const SCHEME = 'predf';
const ORIGIN = `${SCHEME}://app`;
const INDEX_URL = `${ORIGIN}/index.html`;
const SPLASH_URL = `${ORIGIN}/splash.html`;
const ICON_FILE = path.join(__dirname, 'renderer', 'assets', 'icon.png');
const THEMES = ['system', 'light', 'dark'];
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 Go par fichier
const PDF_EXT = ['pdf'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

let mainWindow = null;

// Protocole interne : déclaré avant « ready »
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

// ---------------------------------------------------------------------------
// Préférences
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { theme: 'system', lastDir: null };

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'));
    if (THEMES.includes(parsed.theme)) settings.theme = parsed.theme;
    if (typeof parsed.lastDir === 'string') settings.lastDir = parsed.lastDir;
  } catch {
    // premier lancement
  }
}

let saveChain = Promise.resolve();
function saveSettings() {
  saveChain = saveChain
    .then(async () => {
      const file = settingsFile();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    })
    .catch((err) => console.warn('[predf] préférences non enregistrées :', err.message));
  return saveChain;
}

function applyTheme(mode) {
  nativeTheme.themeSource = mode;
}

// ---------------------------------------------------------------------------
// Protocole interne : page, pdf.js, bibliothèque partagée
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.icc': 'application/octet-stream',
};

const PDFJS_DIR = path.join(__dirname, 'node_modules', 'pdfjs-dist');
/** Préfixe d'URL → dossier sur le disque (rien d'autre n'est servi). */
const ROUTES = [
  ['/vendor/pdfjs/cmaps/', path.join(PDFJS_DIR, 'cmaps')],
  ['/vendor/pdfjs/standard_fonts/', path.join(PDFJS_DIR, 'standard_fonts')],
  ['/vendor/pdfjs/wasm/', path.join(PDFJS_DIR, 'wasm')],
  ['/vendor/pdfjs/iccs/', path.join(PDFJS_DIR, 'iccs')],
  ['/vendor/pdfjs/', path.join(PDFJS_DIR, 'build')],
  ['/lib/ranges.js', path.join(__dirname, 'lib', 'ranges.js')],
  ['/lib/markdown.js', path.join(__dirname, 'lib', 'markdown.js')],
  ['/', path.join(__dirname, 'renderer')],
];

async function serve(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (url.host !== 'app') return new Response('Not found', { status: 404 });
  const pathname = decodeURIComponent(url.pathname);
  for (const [prefix, base] of ROUTES) {
    if (!pathname.startsWith(prefix)) continue;
    const rest = prefix.endsWith('/') ? pathname.slice(prefix.length) : '';
    const file = path.resolve(base, rest);
    // Pas de sortie du dossier autorisé (« ../ »)
    if (prefix.endsWith('/') && file !== base && !file.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------------------
// Fichiers ouverts (en mémoire, désignés par un identifiant)
// ---------------------------------------------------------------------------

const docs = new Map(); // id → { id, name, path, kind, type, bytes, size }
const writtenFiles = new Set(); // fichiers créés pendant la session (seuls ceux-là s'ouvrent / se montrent)
const exportDirs = new Map(); // jeton → dossier choisi par l'utilisateur

const newId = () => crypto.randomBytes(9).toString('base64url');
const extOf = (p) => path.extname(p).slice(1).toLowerCase();

function describe(d) {
  return { id: d.id, name: d.name, path: d.path, kind: d.kind, type: d.type, size: d.size, pageCount: d.pageCount || null, info: d.info || null, image: d.image || null, needsConversion: Boolean(d.needsConversion) };
}

/** Lit un fichier PDF ou image ; renvoie sa description ou { error }. */
async function addFile(filePath) {
  const name = path.basename(filePath);
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return { name, error: 'Ce n\'est pas un fichier.' };
    if (stat.size > MAX_FILE_BYTES) return { name, error: 'Fichier trop volumineux (plus de 1 Go).' };
    const bytes = new Uint8Array(await fsp.readFile(filePath));
    const type = Engine.detectType(bytes);
    if (!type) return { name, error: 'Format non pris en charge : PDF, JPEG, PNG, WebP, GIF ou BMP attendu.' };
    const d = { id: newId(), name, path: filePath, type, bytes, size: bytes.length, kind: type === 'pdf' ? 'pdf' : 'image' };
    if (d.kind === 'pdf') {
      const info = await Engine.inspect(bytes);
      d.pageCount = info.pageCount;
      d.info = { ...info.info, firstPage: info.pages[0], format: Engine.describeSize(info.pages[0].width, info.pages[0].height) };
    } else if (type === 'jpg' || type === 'png') {
      d.image = Engine.inspectImage(bytes);
    } else {
      d.needsConversion = true; // WebP, GIF, BMP : converties en PNG par l'interface
    }
    docs.set(d.id, d);
    return describe(d);
  } catch (err) {
    return { name, error: err && err.name === 'PdfError' ? err.message : `Lecture impossible : ${err.message}` };
  }
}

function getDoc(id) {
  const d = docs.get(String(id));
  if (!d) throw new Engine.PdfError('Fichier introuvable : rouvrez-le.');
  return d;
}

const sourceOf = (id) => {
  const d = docs.get(String(id));
  return d ? { kind: d.kind, bytes: d.bytes } : null;
};

function defaultDir(hintId) {
  const d = hintId ? docs.get(String(hintId)) : null;
  if (d && d.path) return path.dirname(d.path);
  if (settings.lastDir && fs.existsSync(settings.lastDir)) return settings.lastDir;
  return app.getPath('documents');
}

const safeName = (s) =>
  String(s || 'document')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150) || 'document';

/** Chemin libre : « nom.pdf », sinon « nom (2).pdf »… (jamais d'écrasement silencieux). */
async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, i === 1 ? fileName : `${base} (${i})${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('Impossible de trouver un nom de fichier libre.');
}

async function askSavePath(suggestedName, hintId, filters) {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer',
    defaultPath: path.join(defaultDir(hintId), safeName(suggestedName)),
    filters: filters || [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  settings.lastDir = path.dirname(res.filePath);
  saveSettings();
  return res.filePath;
}

/** Écriture atomique : fichier temporaire puis renommage (pas de PDF à moitié écrit en cas d'erreur). */
async function writeFileSafe(filePath, bytes) {
  const tmp = `${filePath}.${process.pid}.predf-tmp`;
  try {
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    if (err.code === 'EBUSY' || err.code === 'EPERM') throw new Error('Le fichier est ouvert dans un autre logiciel ou protégé en écriture : fermez-le ou choisissez un autre nom.');
    throw err;
  }
  writtenFiles.add(filePath);
}

function sendProgress(done, total, label) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('job:progress', { done, total, label });
}

/** Vérifie et nettoie une liste d'éléments de page envoyée par l'interface. */
function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw new Engine.PdfError('Aucune page à enregistrer.');
  if (items.length > 20000) throw new Engine.PdfError('Trop de pages (20 000 au maximum).');
  return items.map((it) => {
    const rotate = [0, 90, 180, 270].includes(Number(it.rotate)) ? Number(it.rotate) : 0;
    if (it.type === 'page') {
      getDoc(it.src);
      return { type: 'page', src: String(it.src), index: Number(it.index), rotate };
    }
    if (it.type === 'image') {
      const d = getDoc(it.src);
      if (d.needsConversion) throw new Engine.PdfError(`${d.name} : conversion de l'image pas encore terminée.`);
      const l = it.layout || {};
      return {
        type: 'image',
        src: String(it.src),
        rotate,
        layout: {
          size: ['fit', 'A3', 'A4', 'A5', 'Letter', 'Legal'].includes(l.size) ? l.size : 'A4',
          orientation: ['auto', 'portrait', 'landscape'].includes(l.orientation) ? l.orientation : 'auto',
          margin: Math.min(50, Math.max(0, Number(l.margin) || 0)),
        },
      };
    }
    if (it.type === 'blank') return { type: 'blank', width: Number(it.width) || 0, height: Number(it.height) || 0, rotate };
    throw new Engine.PdfError('Élément de page inconnu.');
  });
}

async function buildFromItems(items, title) {
  return Engine.buildPdf(cleanItems(items), sourceOf, {
    title,
    onProgress: (done, total) => sendProgress(done, total, 'Assemblage des pages…'),
  });
}

// Assistant IA : clé chiffrée (créée après « ready », safeStorage en a besoin) et traitements en cours
let keyStoreInstance = null;
const keyStore = () => (keyStoreInstance ||= AI.createKeyStore({ safeStorage, userDataDir: app.getPath('userData') }));
const aiJobs = new Map(); // id → { abort }
// Serveur Ollama de cet ordinateur (variable PREDF_OLLAMA_URL pour les tests ; toujours une adresse locale)
const localAiUrl = () => (!app.isPackaged && process.env.PREDF_OLLAMA_URL) || LocalAI.DEFAULT_URL;
const EXTERNAL_LINKS = ['https://ollama.com/download', 'https://console.anthropic.com/settings/keys', 'https://console.anthropic.com/settings/billing'];

// Résultats calculés en attente d'enregistrement (compression, optimisation)
const pending = new Map(); // id → { bytes, pages, name }
const rasterJobs = new Map(); // id → job

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  try {
    const url = event.senderFrame && event.senderFrame.url;
    if (!url) return false;
    // URL.origin vaut « null » pour un protocole non standard côté Node : on compare protocole et hôte
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && u.host === 'app' && u.pathname === '/index.html';
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('Émetteur IPC non autorisé');
    try {
      return await fn(...args);
    } catch (err) {
      if (err && (err.name === 'PdfError' || err.name === 'RangeError')) return { ok: false, error: err.message };
      console.error(`[ipc] ${channel} :`, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

const FILTERS = {
  pdf: [{ name: 'PDF', extensions: PDF_EXT }],
  images: [{ name: 'Images', extensions: IMAGE_EXT }],
  all: [
    { name: 'PDF et images', extensions: [...PDF_EXT, ...IMAGE_EXT] },
    { name: 'PDF', extensions: PDF_EXT },
    { name: 'Images', extensions: IMAGE_EXT },
  ],
};

function registerIpc() {
  // --- Fichiers ---
  handle('files:open', async (opts = {}) => {
    const kind = FILTERS[opts.kind] ? opts.kind : 'all';
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Ouvrir',
      defaultPath: defaultDir(),
      properties: ['openFile', ...(opts.multiple ? ['multiSelections'] : [])],
      filters: FILTERS[kind],
    });
    if (res.canceled || !res.filePaths.length) return { ok: true, files: [] };
    settings.lastDir = path.dirname(res.filePaths[0]);
    saveSettings();
    const files = [];
    for (const p of res.filePaths) files.push(await addFile(p));
    return { ok: true, files };
  });
  // Fichiers déposés dans la fenêtre (chemins fournis par le preload)
  handle('files:add', async (paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, 500);
    const files = [];
    for (const p of list) files.push(await addFile(p));
    return { ok: true, files };
  });
  handle('files:bytes', async (id) => getDoc(id).bytes);
  handle('files:release', async (ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) docs.delete(String(id));
    return { ok: true };
  });
  // Image WebP / GIF / BMP convertie en PNG par l'interface
  handle('files:replaceImage', async (id, pngBytes) => {
    const d = getDoc(id);
    const bytes = new Uint8Array(pngBytes);
    if (Engine.detectType(bytes) !== 'png') throw new Engine.PdfError('Conversion de l\'image impossible.');
    Object.assign(d, { bytes, type: 'png', needsConversion: false, image: Engine.inspectImage(bytes) });
    return { ok: true, file: describe(d) };
  });

  // --- Création de PDF ---
  handle('pdf:save', async (req = {}) => {
    const filePath = await askSavePath(req.suggestedName || 'document.pdf', req.hintId);
    if (!filePath) return { ok: false, canceled: true };
    sendProgress(0, 1, 'Assemblage des pages…');
    const bytes = await buildFromItems(req.items, req.title);
    await writeFileSafe(filePath, bytes);
    return { ok: true, filePath, size: bytes.length, pages: req.items.length };
  });

  handle('pdf:split', async (req = {}) => {
    const groups = Array.isArray(req.groups) ? req.groups : [];
    if (!groups.length) throw new Engine.PdfError('Aucun fichier à créer.');
    if (groups.length > 5000) throw new Engine.PdfError('Trop de fichiers (5 000 au maximum).');
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Dossier où enregistrer les fichiers', defaultPath: defaultDir(req.hintId), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const dir = res.filePaths[0];
    settings.lastDir = dir;
    saveSettings();
    const files = [];
    for (let i = 0; i < groups.length; i++) {
      sendProgress(i, groups.length, `Fichier ${i + 1} sur ${groups.length}…`);
      const bytes = await Engine.buildPdf(cleanItems(groups[i].items), sourceOf);
      const filePath = await uniquePath(dir, `${safeName(groups[i].name)}.pdf`);
      await writeFileSafe(filePath, bytes);
      files.push({ filePath, size: bytes.length, pages: groups[i].items.length });
    }
    sendProgress(groups.length, groups.length, 'Terminé');
    return { ok: true, dir, files };
  });

  // --- Compression : pages rendues en JPEG par l'interface, assemblées ici ---
  handle('raster:start', async () => {
    const id = newId();
    rasterJobs.set(id, await Engine.createRasterJob());
    return { ok: true, id };
  });
  handle('raster:add', async (id, jpegBytes, widthPt, heightPt) => {
    const job = rasterJobs.get(String(id));
    if (!job) throw new Engine.PdfError('Traitement interrompu.');
    await job.addPage(new Uint8Array(jpegBytes), widthPt, heightPt);
    return { ok: true, pages: job.pages };
  });
  handle('raster:finish', async (id, meta = {}) => {
    const job = rasterJobs.get(String(id));
    if (!job) throw new Engine.PdfError('Traitement interrompu.');
    rasterJobs.delete(String(id));
    const bytes = await job.finish({ title: meta.title, author: meta.author });
    const out = newId();
    pending.set(out, { bytes, pages: job.pages });
    return { ok: true, id: out, size: bytes.length, pages: job.pages };
  });
  handle('raster:cancel', async (id) => {
    rasterJobs.delete(String(id));
    return { ok: true };
  });
  handle('optimize:run', async (docId) => {
    const d = getDoc(docId);
    const bytes = await Engine.optimizePdf(d.bytes);
    const out = newId();
    pending.set(out, { bytes, pages: d.pageCount });
    return { ok: true, id: out, size: bytes.length, pages: d.pageCount };
  });
  handle('pending:save', async (id, suggestedName, hintId) => {
    const p = pending.get(String(id));
    if (!p) throw new Engine.PdfError('Résultat introuvable : relancez le traitement.');
    const filePath = await askSavePath(suggestedName || 'document.pdf', hintId);
    if (!filePath) return { ok: false, canceled: true };
    await writeFileSafe(filePath, p.bytes);
    return { ok: true, filePath, size: p.bytes.length, pages: p.pages };
  });
  handle('pending:release', async (id) => {
    pending.delete(String(id));
    return { ok: true };
  });

  // --- Finitions ---
  const cleanStamp = (o = {}) => ({
    numbers: o.numbers && o.numbers.enabled ? { ...o.numbers } : null,
    watermark: o.watermark && o.watermark.enabled ? { ...o.watermark } : null,
    props: o.props && o.props.enabled ? { ...o.props } : null,
  });
  handle('stamp:preview', async (docId, options, pageIndex) => {
    const d = getDoc(docId);
    return { ok: true, bytes: await Engine.stampPdf(d.bytes, { ...cleanStamp(options), onlyPage: Number(pageIndex) || 0 }) };
  });
  handle('stamp:save', async (docId, options, suggestedName) => {
    const d = getDoc(docId);
    const opts = cleanStamp(options);
    if (!opts.numbers && !opts.watermark && !opts.props) throw new Engine.PdfError('Activez au moins une finition (numéros, filigrane ou propriétés).');
    const filePath = await askSavePath(suggestedName, docId);
    if (!filePath) return { ok: false, canceled: true };
    sendProgress(0, 1, 'Application des finitions…');
    const bytes = await Engine.stampPdf(d.bytes, opts);
    await writeFileSafe(filePath, bytes);
    return { ok: true, filePath, size: bytes.length, pages: d.pageCount };
  });

  // --- Export : images et texte ---
  handle('export:chooseDir', async (hintId) => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Dossier où enregistrer les images', defaultPath: defaultDir(hintId), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const token = newId();
    exportDirs.set(token, res.filePaths[0]);
    settings.lastDir = res.filePaths[0];
    saveSettings();
    return { ok: true, token, dir: res.filePaths[0] };
  });
  handle('export:write', async (token, fileName, bytes) => {
    const dir = exportDirs.get(String(token));
    if (!dir) throw new Engine.PdfError('Dossier d\'export introuvable : choisissez-le à nouveau.');
    const name = safeName(path.basename(String(fileName)));
    if (!/\.(png|jpe?g)$/i.test(name)) throw new Engine.PdfError('Type de fichier refusé.');
    const filePath = await uniquePath(dir, name);
    await writeFileSafe(filePath, new Uint8Array(bytes));
    return { ok: true, filePath };
  });
  handle('export:text', async (suggestedName, text, hintId) => {
    const filePath = await askSavePath(suggestedName, hintId, [{ name: 'Texte', extensions: ['txt'] }]);
    if (!filePath) return { ok: false, canceled: true };
    // BOM et fins de ligne Windows : lisible tel quel dans le Bloc-notes
    const body = `﻿${String(text || '').replace(/\r?\n/g, IS_WIN ? '\r\n' : '\n')}`;
    await writeFileSafe(filePath, Buffer.from(body, 'utf8'));
    return { ok: true, filePath };
  });

  // --- Assistant IA (seule fonction qui utilise Internet, à la demande) ---
  handle('ai:status', async () => ({ ok: true, key: await keyStore().describe(), canStore: keyStore().available(), models: AI.MODELS }));
  handle('ai:saveKey', async (key) => {
    await keyStore().save(key);
    return { ok: true, key: await keyStore().describe() };
  });
  handle('ai:removeKey', async () => {
    await keyStore().remove();
    return { ok: true };
  });
  // IA locale gratuite (Ollama) : état, téléchargement d'un modèle
  handle('ai:localStatus', async () => ({ ok: true, ...(await LocalAI.status(localAiUrl())), recommended: LocalAI.RECOMMENDED }));
  handle('ai:localPull', async (model) => {
    const name = String(model || '');
    if (!/^[\w.-]+(:[\w.-]+)?$/.test(name)) throw new Engine.PdfError('Nom de modèle invalide.');
    const jobId = newId();
    const send = (channel, payload) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send(channel, { jobId, ...payload });
    let last = 0;
    const { job, done } = LocalAI.pull({
      url: localAiUrl(),
      model: name,
      onProgress: (p) => {
        const now = Date.now();
        if (now - last > 150 || p.status === 'success') {
          last = now;
          send('ai:pullProgress', p);
        }
      },
    });
    aiJobs.set(jobId, job);
    done.then((res) => {
      aiJobs.delete(jobId);
      send('ai:pullDone', res);
    });
    return { ok: true, jobId };
  });

  handle('ai:run', async (req = {}) => {
    const local = req.engine === 'local';
    const apiKey = local ? null : await keyStore().load();
    if (!local && !apiKey) throw new Engine.PdfError('Ajoutez d\'abord votre clé API Anthropic, ou choisissez l\'IA locale gratuite.');
    const instruction = String(req.instruction || '').trim().slice(0, 20000);
    if (!instruction) throw new Engine.PdfError('Écrivez une consigne (ex. « Fusionne ces documents et simplifie-les »).');
    const ids = Array.isArray(req.fileIds) ? req.fileIds.slice(0, 20) : [];
    if (!ids.length) throw new Engine.PdfError('Ajoutez au moins un document.');
    const files = ids.map((id) => {
      const d = getDoc(id);
      if (d.needsConversion) throw new Engine.PdfError(`${d.name} : conversion de l'image pas encore terminée.`);
      return { id: d.id, name: d.name, kind: d.kind, type: d.type, bytes: d.bytes, pageCount: d.pageCount };
    });
    const jobId = newId();
    const send = (channel, payload) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send(channel, { jobId, ...payload });
    // Texte regroupé toutes les 60 ms : moins de messages, aperçu fluide
    let buffer = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (buffer) send('ai:delta', { text: buffer });
      buffer = '';
    };
    const onText = (t) => {
      buffer += t;
      if (!timer) timer = setTimeout(flush, 60);
    };
    // Étape en cours (envoi, réflexion, chargement du modèle) et résumé de la réflexion, 4 fois par seconde au plus
    let phase = null;
    let thought = '';
    let phaseTimer = null;
    const onPhase = (p) => {
      const changed = p.phase !== phase;
      phase = p.phase;
      if (p.thought) thought = (thought + p.thought).slice(-600);
      if (changed) send('ai:phase', { phase, thought });
      else if (!phaseTimer) {
        phaseTimer = setTimeout(() => {
          phaseTimer = null;
          send('ai:phase', { phase, thought });
        }, 250);
      }
    };
    let started;
    if (local) {
      // Texte des PDF extrait par l'interface (pdf.js) ; images envoyées seulement aux modèles « vision »
      const texts = new Map((Array.isArray(req.texts) ? req.texts : []).map((t) => [String(t.id), String(t.text || '').slice(0, 2_000_000)]));
      const docs = files.filter((f) => f.kind === 'pdf' || !req.vision).map((f) => ({ name: f.name, text: f.kind === 'pdf' ? texts.get(f.id) || '' : '(image : non lue par ce modèle)' }));
      const images = req.vision ? files.filter((f) => f.kind === 'image').map((f) => Buffer.from(f.bytes).toString('base64')) : [];
      started = LocalAI.run({ url: localAiUrl(), model: String(req.model || ''), system: AI.SYSTEM_PROMPT, docs, images, instruction, onText, onPhase });
    } else {
      started = AI.run({
        apiKey,
        baseURL: !app.isPackaged ? process.env.PREDF_AI_BASE_URL : undefined, // tests : serveur simulé
        model: req.model,
        files,
        instruction,
        onText,
        onPhase,
      });
    }
    const { job, done } = started;
    aiJobs.set(jobId, job);
    done.then((res) => {
      clearTimeout(timer);
      clearTimeout(phaseTimer);
      flush();
      aiJobs.delete(jobId);
      send('ai:done', { ...res, text: undefined, length: res.text ? res.text.length : 0 });
    });
    return { ok: true, jobId };
  });
  handle('ai:cancel', async (jobId) => {
    const job = aiJobs.get(String(jobId));
    if (job) job.abort();
    return { ok: true };
  });
  handle('ai:savePdf', async (req = {}) => {
    const markdown = String(req.markdown || '');
    if (!markdown.trim()) throw new Engine.PdfError('Rien à enregistrer.');
    const filePath = await askSavePath(req.suggestedName || 'document.pdf', req.hintId);
    if (!filePath) return { ok: false, canceled: true };
    const bytes = await MdPdf.markdownToPdf(markdown);
    await writeFileSafe(filePath, bytes);
    const pages = (await Engine.inspect(bytes)).pageCount;
    return { ok: true, filePath, size: bytes.length, pages };
  });
  handle('ai:saveText', async (req = {}) => {
    const md = req.format === 'md';
    const filePath = await askSavePath(req.suggestedName || `document.${md ? 'md' : 'txt'}`, req.hintId, md ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'Texte', extensions: ['txt'] }]);
    if (!filePath) return { ok: false, canceled: true };
    const text = md ? String(req.markdown || '') : Markdown.toPlain(req.markdown);
    await writeFileSafe(filePath, Buffer.from(`﻿${text.replace(/\r?\n/g, IS_WIN ? '\r\n' : '\n')}`, 'utf8'));
    return { ok: true, filePath };
  });

  // --- Divers ---
  // Liens utiles de l'Assistant (liste fermée : la page ne peut pas ouvrir d'autres adresses)
  handle('app:openUrl', async (url) => {
    if (!EXTERNAL_LINKS.includes(url)) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });
  handle('file:open', async (filePath) => {
    if (!writtenFiles.has(filePath)) return { ok: false };
    const err = await shell.openPath(filePath);
    return err ? { ok: false, error: err } : { ok: true };
  });
  handle('file:show', async (filePath) => {
    // Seulement un fichier créé pendant la session, ou un dossier où PredF a écrit
    const known = writtenFiles.has(filePath) || [...exportDirs.values()].includes(filePath) || [...writtenFiles].some((f) => path.dirname(f) === filePath);
    if (!known) return { ok: false };
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) await shell.openPath(filePath);
    else shell.showItemInFolder(filePath);
    return { ok: true };
  });
  handle('clipboard:write', async (text) => {
    clipboard.writeText(String(text || '').slice(0, 5_000_000));
    return { ok: true };
  });
  handle('ranges:check', async (text, count) => {
    try {
      return { ok: true, pages: Ranges.parsePageList(text, Number(count)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('theme:get', async () => ({ mode: settings.theme }));
  handle('theme:set', async (mode) => {
    if (!THEMES.includes(mode)) throw new Error('Thème inconnu');
    settings.theme = mode;
    applyTheme(mode);
    await saveSettings();
    return { ok: true, mode };
  });
  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform }));
  handle('app:pendingOpen', async () => {
    const list = pendingOpen.splice(0);
    const files = [];
    for (const p of list) files.push(await addFile(p));
    return { ok: true, files };
  });
  ipcMain.on('app:ui-ready', (event) => {
    if (isTrustedSender(event)) resolveUiReady();
  });
}

// Fichiers passés au lancement (« Ouvrir avec PredF », glisser sur l'icône)
const pendingOpen = [];
function collectArgFiles(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && path.isAbsolute(a) && [...PDF_EXT, ...IMAGE_EXT].includes(extOf(a)) && fs.existsSync(a));
}

// ---------------------------------------------------------------------------
// Écran de chargement (comme SysInfo Lite et CalkIP)
// ---------------------------------------------------------------------------

const SPLASH_MIN_MS = 2400; // laisse l'animation (logo → montée → nom → progression) se jouer en entier
const SPLASH_MAX_MS = 15000; // sécurité : la fenêtre principale s'ouvre quoi qu'il arrive
const SPLASH_OUT_MS = 230;
const LOAD_STEPS = 3; // préférences, moteur PDF, interface (pdf.js)

let splashWindow = null;
let lastSplashProgress = null;

let resolveUiReady = () => {};
const uiReady = new Promise((resolve) => {
  resolveUiReady = resolve;
});

function splashProgress(done, label) {
  lastSplashProgress = { done, total: LOAD_STEPS, label };
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('splash:progress', lastSplashProgress);
}

/**
 * Vérification du moteur PDF au démarrage : un petit document est créé, fusionné, numéroté et relu.
 * Un échec est journalisé (il signalerait une installation endommagée).
 */
async function selfTestEngine() {
  try {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    doc.addPage([300, 200]);
    const bytes = await doc.save();
    const merged = await Engine.buildPdf(
      [
        { type: 'page', src: 'a', index: 1 },
        { type: 'page', src: 'a', index: 0, rotate: 90 },
      ],
      () => ({ kind: 'pdf', bytes })
    );
    const stamped = await Engine.stampPdf(merged, { numbers: { format: 'slash' } });
    const info = await Engine.inspect(stamped);
    const ok = info.pageCount === 2 && info.pages[0].width === 300 && info.pages[1].rotation === 90 && Ranges.parsePageList('1-2', 2).length === 2;
    if (!ok) console.error('[predf] vérification du moteur PDF : résultat inattendu', info);
    return ok;
  } catch (err) {
    console.error('[predf] vérification du moteur PDF impossible :', err);
    return false;
  }
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 300,
    height: 340,
    frame: false,
    transparent: true, // coins arrondis : la boîte est dessinée par la page
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: 'PredF',
    icon: ICON_FILE,
    webPreferences: {
      preload: path.join(__dirname, 'preload-splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: false,
    },
  });
  splashWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  splashWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splashWindow.webContents.on('did-finish-load', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.webContents.send('splash:init', { version: app.getVersion() });
    if (lastSplashProgress) splashWindow.webContents.send('splash:progress', lastSplashProgress);
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
  const shown = new Promise((resolve) => {
    splashWindow.once('ready-to-show', () => {
      splashWindow.show();
      resolve();
    });
    splashWindow.webContents.once('did-fail-load', () => resolve());
    setTimeout(resolve, 3000);
  });
  splashWindow.loadURL(SPLASH_URL);
  return shown;
}

/** Ouvre la fenêtre principale quand l'animation est jouée, la page peinte et pdf.js prêt (15 s au plus). */
async function revealMainWhenReady(splashShown, mainPainted) {
  const timeout = new Promise((resolve) => setTimeout(resolve, SPLASH_MAX_MS));
  const minDuration = splashShown.then(() => new Promise((resolve) => setTimeout(resolve, SPLASH_MIN_MS)));
  await Promise.race([Promise.all([minDuration, mainPainted, uiReady]), timeout]);
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:done');
    await new Promise((resolve) => setTimeout(resolve, SPLASH_OUT_MS));
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
}

// ---------------------------------------------------------------------------
// Fenêtre et cycle de vie
// ---------------------------------------------------------------------------

function createWindow({ deferShow = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'PredF',
    icon: ICON_FILE,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17121f' : '#f7f4f6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const win = mainWindow;
  const painted = new Promise((resolve) => {
    win.once('ready-to-show', () => {
      if (!deferShow) win.show();
      resolve();
    });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rasterJobs.clear();
    for (const job of aiJobs.values()) job.abort();
    aiJobs.clear();
  });
  mainWindow.loadURL(INDEX_URL);
  if (process.argv.includes('--dev') && !app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return painted;
}

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingOpen.push(...collectArgFiles(process.argv));

  app.on('second-instance', (_event, argv) => {
    const files = collectArgFiles(argv);
    if (files.length && mainWindow && !mainWindow.isDestroyed()) {
      pendingOpen.push(...files);
      mainWindow.webContents.send('app:openFiles');
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.focus();
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // Hors ligne garanti : toute requête réseau sortante est annulée (seul le protocole interne passe)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle(SCHEME, serve);
    if (app.isPackaged) Menu.setApplicationMenu(null);
    registerIpc();
    await loadSettings();
    applyTheme(settings.theme);
    splashProgress(0, 'Chargement des préférences…');
    const splashShown = createSplash();
    splashProgress(1, 'Vérification du moteur PDF…');
    await selfTestEngine();
    splashProgress(2, 'Préparation de l\'interface…');
    const mainPainted = createWindow({ deferShow: true });
    revealMainWhenReady(splashShown, mainPainted);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
