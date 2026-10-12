/*
 * main.js — Processus principal de Cours (les résumés de la formation).
 *
 * Application 100 % locale : le contenu est dans lib/content.js, rien n'est téléchargé (CSP « connect-src
 * 'none' », navigation et permissions bloquées, toute requête http(s) annulée).
 * Rôle : fenêtre, écran de démarrage, préférence de thème. Les chapitres lus sont gardés par la page.
 */
'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, Menu, session, dialog, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { fileURLToPath, pathToFileURL } = require('node:url');
const Course = require('./lib/course.js');
const Content = require('./lib/content.js');

const IS_WIN = process.platform === 'win32';
const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');
const ICON_FILE = path.join(__dirname, 'renderer', 'assets', 'icon.png');
const THEMES = ['system', 'light', 'dark'];

let mainWindow = null;

// ---------------------------------------------------------------------------
// Préférences
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { theme: 'system' };

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'));
    if (THEMES.includes(parsed.theme)) settings.theme = parsed.theme;
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
    .catch((err) => console.warn('[cours] préférences non enregistrées :', err.message));
  return saveChain;
}

function applyTheme(mode) {
  nativeTheme.themeSource = mode;
}

// ---------------------------------------------------------------------------
// Cours : pdfs/<id de la partie>/*.pdf (un PDF = un cours) et pdfs/<id>/<Cours>/ (PDF, photos, Condensé/)
// ---------------------------------------------------------------------------

/**
 * Dossier des PDF. Application installée : copie hors de l'archive (asarUnpack), lisible par le lecteur PDF.
 * Développement : pdfs/ du projet, ou COURS_PDF_DIR (tests).
 */
function pdfRoot() {
  if (!app.isPackaged && process.env.COURS_PDF_DIR) return path.resolve(process.env.COURS_PDF_DIR);
  return path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'pdfs');
}

/**
 * Chemin d'un fichier d'une partie (« x.pdf », « Cours/x.png », « Cours/Condensé/x.pdf »), en refusant tout ce qui
 * sortirait du dossier de la partie.
 */
function docPath(partId, rel) {
  const part = Content.parts.find((p) => p.id === partId);
  if (!part || !Course.isSafeRel(rel)) throw new Error('Document inconnu.');
  const dir = path.resolve(pdfRoot(), part.id);
  const full = path.resolve(dir, ...rel.split('/'));
  if (!full.startsWith(dir + path.sep)) throw new Error('Document inconnu.');
  return full;
}

/** Fichiers (PDF ou photos) d'un dossier : [{ file: 'chemin/relatif', size, mtime }] ; sous-dossiers à part. */
async function readFolder(dir, prefix, accept) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: [], dirs: [] };
  }
  const files = [];
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (Course.isFolderName(e.name)) dirs.push(e.name);
      continue;
    }
    if (!e.isFile() || !accept(e.name)) continue;
    try {
      const st = await fsp.stat(path.join(dir, e.name));
      files.push({ file: prefix + e.name, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {
      // fichier disparu entre-temps
    }
  }
  return { files, dirs };
}

/**
 * Contenu de chaque partie : { [partId]: { files, folders } } (dossier absent = aucun cours).
 *   files   : PDF posés directement dans la partie (un cours chacun) ;
 *   folders : un dossier = un cours : ses PDF et photos, et son condensé (sous-dossier « Condensé »).
 */
async function listDocuments() {
  const out = {};
  const isDoc = (n) => Course.kindOf(n) !== '';
  for (const part of Content.parts) {
    const dir = path.join(pdfRoot(), part.id);
    const top = await readFolder(dir, '', Course.isPdfName);
    const folders = [];
    for (const name of top.dirs) {
      const inner = await readFolder(path.join(dir, name), `${name}/`, isDoc);
      let condense = [];
      for (const sub of inner.dirs.filter(Course.isCondenseFolder)) condense = condense.concat((await readFolder(path.join(dir, name, sub), `${name}/${sub}/`, Course.isPdfName)).files);
      folders.push({ folder: name, files: inner.files, condense });
    }
    out[part.id] = { files: top.files, folders };
  }
  return out;
}

const MAX_PREVIEW_BYTES = 80 * 1024 * 1024; // aperçu : PDF lus entièrement par la page (pdf.js)

/** Contenu d'un PDF (aperçu de sa première page) ou d'une photo (miniature). */
async function readDocument(partId, file) {
  const full = docPath(partId, file);
  if (!['pdf', 'image'].includes(Course.kindOf(path.basename(full)))) return { ok: false, error: 'Pas d\'aperçu pour ce type de fichier.' };
  const st = await fsp.stat(full);
  if (st.size > MAX_PREVIEW_BYTES) return { ok: false, error: 'Fichier trop volumineux pour l\'aperçu.' };
  const buf = await fsp.readFile(full);
  return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

/**
 * Visionneuse : fenêtre avec le lecteur PDF intégré (zoom, recherche, impression, téléchargement), ou la photo.
 * page : ouvre directement à cette page (sommaire), dans la fenêtre déjà ouverte s'il y en a une.
 */
const viewers = new Map(); // chemin → fenêtre déjà ouverte
async function openDocument(partId, file, title, page) {
  const full = docPath(partId, file);
  await fsp.access(full);
  // Document Office (Word, Excel…) : ouvert avec le programme de l'ordinateur
  if (Course.kindOf(path.basename(full)) === 'office') {
    const error = await shell.openPath(full);
    return error ? { ok: false, error: `Ouverture impossible : ${error}` } : { ok: true, external: true };
  }
  const n = Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 0;
  const url = pathToFileURL(full).href + (n ? `#page=${n}` : '');
  const open = viewers.get(full);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    // Fenêtre déjà ouverte : un simple changement de « #page » n'est pas suivi par le lecteur PDF ; le paramètre
    // ?v= (ignoré pour un fichier) force un vrai chargement à la bonne page
    if (n) await open.loadURL(`${pathToFileURL(full).href}?v=${Date.now()}#page=${n}`);
    open.focus();
    return { ok: true };
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 480,
    minHeight: 400,
    title: `${String(title || file).slice(0, 120)} — Cours`,
    icon: ICON_FILE,
    backgroundColor: Course.kindOf(path.basename(full)) === 'video' ? '#000000' : '#525659', // vidéo : fond noir
    autoHideMenuBar: true,
    webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: !app.isPackaged },
  });
  viewers.set(full, win);
  win.on('page-title-updated', (e) => e.preventDefault()); // garde le titre du résumé
  win.on('closed', () => viewers.delete(full));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL(url);
  return { ok: true };
}

/** Télécharger : copie du fichier (PDF, photo, vidéo, document) à l'endroit choisi (Téléchargements par défaut). */
const SAVE_LABELS = { pdf: ['Enregistrer le PDF', 'Document PDF'], image: ['Enregistrer la photo', 'Image'], video: ['Enregistrer la vidéo', 'Vidéo'], office: ['Enregistrer le document', 'Document'] };
async function saveDocument(partId, file) {
  const full = docPath(partId, file);
  const name = path.basename(full);
  const ext = path.extname(name).slice(1).toLowerCase();
  const [title, label] = SAVE_LABELS[Course.kindOf(name)] || ['Enregistrer', 'Fichier'];
  const res = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: label, extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await fsp.copyFile(full, res.filePath);
  return { ok: true, filePath: res.filePath };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  try {
    const url = event.senderFrame && event.senderFrame.url;
    if (!url || !url.startsWith('file:')) return false;
    const a = path.resolve(fileURLToPath(url.split('#')[0].split('?')[0]));
    const b = path.resolve(INDEX_FILE);
    return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
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
      console.error(`[ipc] ${channel} :`, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle('theme:get', async () => ({ mode: settings.theme }));
  handle('theme:set', async (mode) => {
    if (!THEMES.includes(mode)) throw new Error('Thème inconnu');
    settings.theme = mode;
    applyTheme(mode);
    await saveSettings();
    return { ok: true, mode };
  });
  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, dev: !app.isPackaged }));
  handle('docs:list', () => listDocuments());
  handle('docs:read', (partId, file) => readDocument(String(partId), String(file)));
  handle('docs:open', (partId, file, title, page) => openDocument(String(partId), String(file), String(title || ''), Number(page) || 0));
  handle('docs:save', (partId, file) => saveDocument(String(partId), String(file)));
  handle('docs:folder', async (partId) => {
    // Développement : ouvre le dossier où déposer les PDF d'une partie (créé au besoin)
    const part = Content.parts.find((p) => p.id === partId);
    if (!part || app.isPackaged) return { ok: false };
    const dir = path.join(pdfRoot(), part.id);
    await fsp.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true };
  });
  ipcMain.on('app:ui-ready', (event) => {
    if (isTrustedSender(event)) resolveUiReady();
  });
}

// ---------------------------------------------------------------------------
// Écran de démarrage (comme les autres applications V3Redis)
// ---------------------------------------------------------------------------

const SPLASH_FILE = path.join(__dirname, 'renderer', 'splash.html');
const SPLASH_MIN_MS = 2400;
const SPLASH_MAX_MS = 15000;
const SPLASH_OUT_MS = 230;
const LOAD_STEPS = 3; // préférences, contenu des cours, interface

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

/** Contrôle du fichier de contenu : une erreur de saisie dans un résumé est signalée dans la console. */
function checkContent() {
  const errors = Course.validate(Content);
  if (errors.length) console.error('[cours] contenu des cours :', errors);
  return errors.length === 0;
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 300,
    height: 340,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: 'Cours',
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
  splashWindow.loadFile(SPLASH_FILE);
  return shown;
}

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
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Cours',
    icon: ICON_FILE,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1a1a' : '#f4f8f7',
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
  });
  mainWindow.loadFile(INDEX_FILE);
  if (process.argv.includes('--dev') && !app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return painted;
}

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.focus();
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // Hors ligne garanti : toute requête réseau sortante est annulée (seuls les fichiers locaux passent)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (app.isPackaged) Menu.setApplicationMenu(null);
    registerIpc();
    await loadSettings();
    applyTheme(settings.theme);
    const splashShown = createSplash();
    splashProgress(1, 'Chargement des cours…');
    checkContent();
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
