/*
 * main.js — Processus principal du HUB.
 *
 * Le HUB liste les applications du catalogue (apps.js), détecte celles qui sont installées et les lance.
 * Détection, dans l'ordre :
 *   1. chemin choisi à la main par l'utilisateur (mémorisé dans settings.json) ;
 *   2. Windows : registre « Applications installées » (HKCU puis HKLM) → dossier d'installation ;
 *      Linux : AppImage dans ~/Applications, ~/Bureau, ~/Desktop, ~/Téléchargements, ~/Downloads ;
 *   3. Windows : dossier par défaut de l'installeur ;
 *   4. version livrée avec le HUB (installeur « 2 en 1 » : <HUB>\resources\apps\<id>\) ;
 *   5. version compilée dans le dossier du projet voisin (ex. ..\CalkIP\dist\win-unpacked\CalkIP.exe),
 *      avec, si l'installeur y est aussi, un bouton « Installer ».
 *
 * Mises à jour (updater.js) : V3Redis et les applications livrées avec lui forment un seul paquet, mis à jour
 * ensemble depuis les releases GitHub de V3Redis.
 *
 * Sécurité : renderer isolé (contextIsolation, sandbox, CSP stricte), émetteur IPC vérifié, seuls les
 * liens du catalogue peuvent être ouverts, et seuls des exécutables existants sont lancés (sans shell).
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const APPS = require('./apps.js');
const Updater = require('./updater.js');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');

let mainWindow = null;

// ---------------------------------------------------------------------------
// Préférences : chemins choisis à la main ({ paths: { id: chemin } })
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { paths: {} };

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    if (parsed && typeof parsed.paths === 'object' && parsed.paths) settings.paths = parsed.paths;
  } catch {
    // premier lancement ou fichier illisible
  }
}

async function saveSettings() {
  const file = settingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Détection des applications installées
// ---------------------------------------------------------------------------

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function runCommand(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Valeurs d'une clé de registre : { nom: valeur }. */
function parseRegValues(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].trim();
  }
  return values;
}

/**
 * Windows : cherche l'application dans « Applications installées » (clés Uninstall écrites par
 * l'installeur). Le nom affiché contient la version (« SysInfo Lite 1.0.0 ») : on compare le début.
 */
async function findInRegistry(spec) {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    const out = await runCommand('reg', ['query', root, '/s', '/f', spec.displayName, '/d']);
    if (!out) continue;
    const keys = out.split(/\r?\n/).filter((l) => /^HKEY_/i.test(l.trim())).map((l) => l.trim());
    for (const key of keys) {
      const values = parseRegValues(await runCommand('reg', ['query', key]));
      const name = values.DisplayName || '';
      if (name !== spec.displayName && !name.startsWith(`${spec.displayName} `)) continue;
      // Dossier d'installation : InstallLocation, sinon celui du désinstalleur (« "C:\…\Uninstall X.exe" /currentuser »)
      let dir = values.InstallLocation ? values.InstallLocation.replace(/^"|"$/g, '') : null;
      if (!dir && values.UninstallString) {
        const m = /^"([^"]+)"/.exec(values.UninstallString) || /^(\S+)/.exec(values.UninstallString);
        if (m) dir = path.dirname(m[1]);
      }
      if (!dir) continue;
      const exe = path.join(dir, spec.exe);
      if (await isFile(exe)) return { path: exe, version: values.DisplayVersion || null, source: 'registre' };
    }
  }
  return null;
}

/** Linux : AppImage la plus récente dans les dossiers habituels. */
async function findAppImage(spec) {
  const home = app.getPath('home');
  const dirs = ['Applications', 'Bureau', 'Desktop', 'Téléchargements', 'Downloads', '.local/bin'].map((d) => path.join(home, d));
  let best = null;
  // Dossier lui-même + un niveau de sous-dossiers (ex. ~/Téléchargements/SysInfo-Lite-Linux/) :
  // une recherche récursive complète serait trop lente sur un dossier de téléchargements chargé
  const scan = async (dir, depth) => {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) await scan(file, depth - 1);
      else if (e.name.startsWith(spec.appImagePrefix) && e.name.endsWith('.AppImage')) {
        try {
          const st = await fs.stat(file);
          if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs };
        } catch {
          // fichier disparu entre-temps
        }
      }
    }
  };
  for (const dir of dirs) await scan(dir, 1);
  if (!best) return null;
  const version = (/-(\d+\.\d+\.\d+)/.exec(path.basename(best.file)) || [])[1] || null;
  return { path: best.file, version, source: 'recherche' };
}

async function detect(entry) {
  if (entry.status !== 'available') return { installed: false };
  const manual = settings.paths[entry.id];
  if (manual && (await isFile(manual))) return { installed: true, path: manual, version: null, source: 'manuel' };
  if (IS_WIN && entry.windows) {
    let found = await findInRegistry(entry.windows);
    if (!found) {
      const [envVar, ...rest] = entry.windows.defaultDir;
      const exe = process.env[envVar] ? path.join(process.env[envVar], ...rest, entry.windows.exe) : null;
      if (exe && (await isFile(exe))) found = { path: exe, version: null, source: 'défaut' };
    }
    if (found) {
      // Installée à part ET livrée avec le HUB : on lance la plus récente des deux
      const bundled = await findBundled(entry);
      if (bundled && isNewer(bundled.version, found.version)) return { installed: true, ...bundled };
      return { installed: true, ...found };
    }
  }
  if (IS_LINUX && entry.linux) {
    const found = await findAppImage(entry.linux);
    if (found) return { installed: true, ...found };
  }
  // Livrée avec le HUB (installeur « 2 en 1 ») : resources\apps\<id>\
  const bundled = await findBundled(entry);
  if (bundled) return { installed: true, ...bundled };
  // Pas installée : version compilée dans le dossier de son projet (à côté du HUB)
  const build = await findLocalBuild(entry.local);
  if (build) return { installed: true, ...build };
  return { installed: false };
}

// ---------------------------------------------------------------------------
// Projets voisins : les applications compilées dans le même dossier parent que le HUB
// (C:\…\SysInfoLite\V3Redis = HUB, C:\…\SysInfoLite\CalkIP, C:\…\SysInfoLite\SysInfoLite).
// HUB empaqueté : dossier donné par la variable d'environnement HUB_PROJECTS_DIR (sinon désactivé).
// ---------------------------------------------------------------------------

const PROJECTS_ROOT = app.isPackaged ? process.env.HUB_PROJECTS_DIR || null : path.resolve(__dirname, '..');

// Applications embarquées par l'installeur du HUB (scripts/build-setup.js) : <HUB>\resources\apps\<id>\.
// En développement, HUB_BUNDLE_DIR permet de pointer vers un dossier « apps » pour tester.
const BUNDLE_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'apps') : process.env.HUB_BUNDLE_DIR || null;

/** « 1.0.1 » plus récent que « 1.0.0 » ; une version inconnue (null) est considérée plus ancienne. */
function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function findBundled(entry) {
  if (!IS_WIN || !BUNDLE_ROOT || !entry.windows) return null;
  const dir = path.join(BUNDLE_ROOT, entry.id);
  const exe = path.join(dir, entry.windows.exe);
  if (!(await isFile(exe))) return null;
  let version = null;
  try {
    version = JSON.parse(await fs.readFile(path.join(dir, 'hub-bundle.json'), 'utf8')).version || null;
  } catch {
    // marqueur absent ou illisible : version inconnue
  }
  return { path: exe, version, source: 'hub' };
}

async function projectVersion(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** Fichier de dist/ correspondant au motif (le plus récent s'il y en a plusieurs). */
async function newestInDist(dir, pattern) {
  if (!pattern) return null;
  let names = [];
  try {
    names = (await fs.readdir(path.join(dir, 'dist'))).filter((n) => pattern.test(n));
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    const file = path.join(dir, 'dist', name);
    try {
      const st = await fs.stat(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs };
    } catch {
      // fichier disparu entre-temps
    }
  }
  return best ? best.file : null;
}

async function findLocalBuild(local) {
  if (!PROJECTS_ROOT || !local) return null;
  const dir = path.join(PROJECTS_ROOT, local.project);
  const candidates = [];
  if (IS_WIN) {
    for (const rel of local.winExe || []) candidates.push(path.join(dir, rel));
    candidates.push(await newestInDist(dir, local.winPortable));
  } else if (IS_LINUX) {
    candidates.push(await newestInDist(dir, local.appImage));
  }
  for (const file of candidates) {
    if (file && (await isFile(file))) return { path: file, version: await projectVersion(dir), source: 'build' };
  }
  return null;
}

/** Installeur Windows compilé dans le projet voisin (proposé quand l'application n'est pas installée). */
async function findLocalInstaller(local) {
  if (!IS_WIN || !PROJECTS_ROOT || !local) return null;
  return newestInDist(path.join(PROJECTS_ROOT, local.project), local.winInstaller);
}

/** Catalogue + état de chaque application. */
async function listApps() {
  return Promise.all(
    APPS.map(async (entry) => {
      const state = entry.status === 'available' ? await detect(entry) : { installed: false };
      // Installation proposée si l'application n'est pas réellement installée (absente ou simple build local)
      const installer = entry.status === 'available' && (!state.installed || state.source === 'build') ? await findLocalInstaller(entry.local) : null;
      return {
        id: entry.id,
        name: entry.name,
        tagline: entry.tagline || '',
        description: entry.description,
        icon: /^[\w-]+\.svg$/.test(entry.icon || '') ? entry.icon : null,
        accent: /^#[0-9a-f]{6}$/i.test(entry.accent || '') ? entry.accent : '#8b6dff',
        features: Array.isArray(entry.features) ? entry.features.slice(0, 6).map(String) : [],
        status: entry.status,
        canDownload: Boolean(entry.downloadUrl),
        canInstall: Boolean(installer),
        installerName: installer ? path.basename(installer) : null,
        ...state,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const findEntry = (id) => APPS.find((a) => a.id === id) || null;

async function launch(id) {
  const entry = findEntry(id);
  if (!entry || entry.status !== 'available') return { ok: false, error: 'Application inconnue ou pas encore disponible.' };
  const state = await detect(entry);
  if (!state.installed) return { ok: false, error: `${entry.name} n'est pas installé (ou introuvable).` };
  if (IS_LINUX) await fs.chmod(state.path, 0o755).catch(() => {}); // AppImage copiée sans droit d'exécution
  // Appelé par l'interface À LA FIN de l'animation de lancement : l'application démarre seulement maintenant
  return new Promise((resolve) => {
    try {
      // Processus indépendant : l'application continue après la fermeture de V3Redis
      const child = spawn(state.path, [], { cwd: path.dirname(state.path), detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (err) => resolve({ ok: false, error: `Lancement impossible : ${err.message}` }));
      child.once('spawn', () => {
        child.unref();
        const launchId = ++launchCounter;
        // Surveillance de la fenêtre de l'application : V3Redis ne se ferme qu'une fois qu'elle est affichée
        pendingLaunches.set(launchId, waitForWindow(child.pid));
        resolve({ ok: true, name: entry.name, launchId });
      });
    } catch (err) {
      resolve({ ok: false, error: `Lancement impossible : ${err.message}` });
    }
  });
}

let launchCounter = 0;
const pendingLaunches = new Map(); // launchId → promesse de l'apparition de la fenêtre
const LAUNCH_WAIT_MS = 12000;

/**
 * Attend que le processus lancé affiche une fenêtre visible.
 * Windows : un seul script PowerShell surveille MainWindowHandle (non nul = fenêtre visible) ;
 * Linux / macOS : pas de moyen simple sans dépendance native, on suppose la fenêtre prête après 2 s.
 * Résultat : 'shown' (fenêtre visible), 'exited' (le processus s'est arrêté : application déjà
 * ouverte et mise au premier plan, ou erreur au démarrage) ou 'timeout'.
 */
function waitForWindow(pid) {
  if (!IS_WIN || !Number.isInteger(pid)) return new Promise((resolve) => setTimeout(() => resolve('shown'), 2000));
  const script = [
    `$deadline = (Get-Date).AddMilliseconds(${LAUNCH_WAIT_MS})`,
    'while ((Get-Date) -lt $deadline) {',
    `  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "  if (-not $p) { 'exited'; exit }",
    "  if ($p.MainWindowHandle -ne 0) { 'shown'; exit }",
    '  Start-Sleep -Milliseconds 120',
    '}',
    "'timeout'",
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: LAUNCH_WAIT_MS + 5000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '').trim();
      resolve(['shown', 'exited', 'timeout'].includes(out) ? out : 'timeout');
    });
  });
}

/**
 * Fin d'un lancement (animation terminée, application démarrée) : V3Redis s'efface en fondu et disparaît
 * de l'écran, puis se ferme dès que la fenêtre de l'application est affichée (12 s au plus).
 * L'application lancée est un processus indépendant : elle continue après la fermeture de V3Redis.
 */
async function retreat(launchId) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false };
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    win.setOpacity(1 - t * t * (3 - 2 * t)); // fondu adouci (~0,6 s)
    await new Promise((r) => setTimeout(r, 20));
  }
  revived = false;
  win.hide();
  const waiting = pendingLaunches.get(launchId);
  pendingLaunches.delete(launchId);
  if (waiting) await waiting;
  // Mise à jour en cours de téléchargement : V3Redis (caché) la termine avant de se fermer (20 min au plus)
  const deadline = Date.now() + 20 * 60 * 1000;
  while (!revived && Updater.getStatus().state === 'downloading' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  if (revived) return { ok: true, revived: true }; // rouvert entre-temps : on reste ouvert
  setTimeout(() => app.quit(), 50); // laisse la réponse IPC partir avant la fermeture
  return { ok: true };
}

let revived = false; // V3Redis rouvert pendant qu'il attendait, caché, de se fermer

/** Lance l'installeur compilé localement (assistant d'installation de l'application). */
async function install(id) {
  const entry = findEntry(id);
  if (!entry || entry.status !== 'available') return { ok: false, error: 'Application inconnue.' };
  const installer = await findLocalInstaller(entry.local);
  if (!installer) return { ok: false, error: `Aucun installeur de ${entry.name} trouvé (compilez-le avec « npm run build:win » dans son projet).` };
  return new Promise((resolve) => {
    const child = spawn(installer, [], { cwd: path.dirname(installer), detached: true, stdio: 'ignore' });
    child.once('error', (err) => resolve({ ok: false, error: `Installation impossible : ${err.message}` }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, name: entry.name });
    });
  });
}

async function chooseExecutable(id) {
  const entry = findEntry(id);
  if (!entry || entry.status !== 'available') return { ok: false, error: 'Application inconnue.' };
  const filters = IS_WIN ? [{ name: 'Programme', extensions: ['exe'] }] : IS_LINUX ? [{ name: 'AppImage', extensions: ['AppImage'] }, { name: 'Tous les fichiers', extensions: ['*'] }] : [];
  const res = await dialog.showOpenDialog(mainWindow, { title: `Où se trouve ${entry.name} ?`, properties: ['openFile'], filters });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  settings.paths[id] = res.filePaths[0];
  await saveSettings();
  return { ok: true };
}

async function forgetExecutable(id) {
  if (!findEntry(id)) return { ok: false };
  delete settings.paths[id];
  await saveSettings();
  return { ok: true };
}

async function openDownload(id) {
  const entry = findEntry(id);
  if (!entry || !entry.downloadUrl || !/^https:\/\//.test(entry.downloadUrl)) return { ok: false, error: 'Aucune page de téléchargement.' };
  await shell.openExternal(entry.downloadUrl);
  return { ok: true };
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
  handle('apps:list', () => listApps());
  handle('apps:launch', (id) => launch(String(id)));
  handle('apps:install', (id) => install(String(id)));
  handle('hub:retreat', (launchId) => retreat(Number(launchId)));
  // Boutons de la barre de titre (fenêtre sans cadre)
  handle('window:minimize', async () => mainWindow && mainWindow.minimize());
  handle('window:close', async () => mainWindow && mainWindow.close());
  handle('apps:choose', (id) => chooseExecutable(String(id)));
  handle('apps:forget', (id) => forgetExecutable(String(id)));
  handle('apps:download', (id) => openDownload(String(id)));
  handle('hub:info', () => ({ version: app.getVersion(), platform: process.platform }));
  // Mises à jour du paquet V3Redis (+ applications livrées)
  handle('update:status', async () => Updater.getStatus());
  handle('update:check', () => Updater.check({ manual: true }));
  handle('update:install', () => Updater.install());
  handle('update:open', async () => Updater.openReleasePage());
}

/** Démarre la vérification des mises à jour (une fois, quand la fenêtre est affichée). */
let updaterStarted = false;
function startUpdater() {
  if (updaterStarted) return;
  updaterStarted = true;
  const bundled = APPS.filter((a) => a.status === 'available' && a.windows && a.windows.exe).map((a) => ({ name: a.name, exe: a.windows.exe }));
  Updater.start((s) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', s);
  }, bundled);
}

// ---------------------------------------------------------------------------
// Fenêtre et cycle de vie
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: 'V3Redis',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    backgroundColor: '#05060f', // pas de flash blanc avant le premier rendu
    frame: false, // barre de titre dessinée par l'interface (en-tête déplaçable + boutons réduire / fermer)
    maximizable: false, // pas de bouton agrandir : le double-clic sur l'en-tête n'agrandit pas non plus
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    startUpdater();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(INDEX_FILE);
  if (process.argv.includes('--dev') && !app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) {
      // Caché après un lancement (téléchargement de mise à jour en cours) : il réapparaît et reste ouvert
      revived = true;
      mainWindow.setOpacity(1);
      mainWindow.show();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (app.isPackaged) Menu.setApplicationMenu(null);
    nativeTheme.themeSource = 'dark'; // interface sombre : barre de titre et boîtes de dialogue assorties
    await loadSettings();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
