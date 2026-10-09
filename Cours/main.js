/*
 * main.js — Processus principal de Cours (les résumés de la formation).
 *
 * Application 100 % locale : le contenu est dans lib/content.js, rien n'est téléchargé (CSP « connect-src
 * 'none' », navigation et permissions bloquées, toute requête http(s) annulée).
 * Rôle : fenêtre, écran de démarrage, préférence de thème. Les chapitres lus sont gardés par la page.
 */
'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, Menu, session } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
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
  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform }));
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
