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
// Résumés PDF : pdfs/<id de la partie>/*.pdf
// ---------------------------------------------------------------------------

/**
 * Dossier des PDF. Application installée : copie hors de l'archive (asarUnpack), lisible par le lecteur PDF.
 * Développement : pdfs/ du projet, ou COURS_PDF_DIR (tests).
 */
function pdfRoot() {
  if (!app.isPackaged && process.env.COURS_PDF_DIR) return path.resolve(process.env.COURS_PDF_DIR);
  return path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'pdfs');
}

/** Chemin d'un PDF d'une partie, en refusant tout ce qui sortirait du dossier de la partie. */
function pdfPath(partId, file) {
  const part = Content.parts.find((p) => p.id === partId);
  if (!part || !Course.isPdfName(file)) throw new Error('Document inconnu.');
  const dir = path.join(pdfRoot(), part.id);
  const full = path.join(dir, file);
  if (path.dirname(full) !== dir) throw new Error('Document inconnu.');
  return full;
}

/** Fichiers PDF de chaque partie : { [partId]: [{ file, size, mtime }] } (dossier absent = aucun document). */
async function listDocuments() {
  const out = {};
  for (const part of Content.parts) {
    const dir = path.join(pdfRoot(), part.id);
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const files = [];
    for (const e of entries) {
      if (!e.isFile() || !Course.isPdfName(e.name)) continue;
      try {
        const st = await fsp.stat(path.join(dir, e.name));
        files.push({ file: e.name, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch {
        // fichier disparu entre-temps
      }
    }
    out[part.id] = files;
  }
  return out;
}

const MAX_PREVIEW_BYTES = 80 * 1024 * 1024; // aperçu : PDF lus entièrement par la page (pdf.js)

/** Contenu d'un PDF pour l'aperçu de sa première page. */
async function readDocument(partId, file) {
  const full = pdfPath(partId, file);
  const st = await fsp.stat(full);
  if (st.size > MAX_PREVIEW_BYTES) return { ok: false, error: 'Fichier trop volumineux pour l\'aperçu.' };
  const buf = await fsp.readFile(full);
  return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

/**
 * Visionneuse : fenêtre avec le lecteur PDF intégré (zoom, recherche, impression, téléchargement).
 * page : ouvre directement à cette page (sommaire), dans la fenêtre déjà ouverte s'il y en a une.
 */
const viewers = new Map(); // chemin → fenêtre déjà ouverte
async function openDocument(partId, file, title, page) {
  const full = pdfPath(partId, file);
  await fsp.access(full);
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
    backgroundColor: '#525659',
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

/** Télécharger : copie du PDF à l'endroit choisi (Téléchargements par défaut). */
async function saveDocument(partId, file) {
  const full = pdfPath(partId, file);
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le résumé',
    defaultPath: path.join(app.getPath('downloads'), file),
    filters: [{ name: 'Document PDF', extensions: ['pdf'] }],
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
