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
const Platforms = require('./platforms.js');
const Mode = require('./mode.js');
const AppManager = require('./app-manager.js');
const os = require('node:os');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';
const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');

let mainWindow = null;

// ---------------------------------------------------------------------------
// Préférences : chemins choisis à la main ({ paths: { id: chemin } }) et mode ('full' | 'light')
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { paths: {} };

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    if (parsed && typeof parsed.paths === 'object' && parsed.paths) settings.paths = parsed.paths;
    if (parsed && Mode.MODES.includes(parsed.mode)) settings.mode = parsed.mode;
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

/** Application lançable : un fichier (Windows, Linux) ou un paquet .app, qui est un dossier (macOS). */
async function isLaunchable(target) {
  try {
    const st = await fs.stat(target);
    return IS_MAC && /\.app$/i.test(target) ? st.isDirectory() : st.isFile();
  } catch {
    return false;
  }
}

/** macOS : version d'un paquet .app (Contents/Info.plist). */
async function macAppVersion(appPath) {
  try {
    return Platforms.plistVersion(await fs.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8'));
  } catch {
    return null;
  }
}

/** macOS : application installée dans /Applications ou ~/Applications. */
async function findMacApp(spec) {
  for (const dir of ['/Applications', path.join(app.getPath('home'), 'Applications')]) {
    const target = path.join(dir, spec.app);
    if (await isLaunchable(target)) return { path: target, version: await macAppVersion(target), source: 'défaut' };
  }
  return null;
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
  if (manual && (await isLaunchable(manual))) return { installed: true, path: manual, version: null, source: 'manuel' };
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
  if ((IS_LINUX && entry.linux) || (IS_MAC && entry.mac)) {
    const found = IS_LINUX ? await findAppImage(entry.linux) : await findMacApp(entry.mac);
    if (found) {
      const bundled = await findBundled(entry);
      if (bundled && isNewer(bundled.version, found.version)) return { installed: true, ...bundled };
      return { installed: true, ...found };
    }
  }
  // Livrée avec le HUB (paquet « tout en un ») : resources/apps/<id>/
  const bundled = await findBundled(entry);
  if (bundled) return { installed: true, ...bundled };
  // Pas installée : version compilée dans le dossier de son projet (à côté du HUB)
  const build = await findLocalBuild(entry);
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

/** Applications installables / désinstallables depuis le HUB (Windows) : voir app-manager.js. */
const manager = AppManager.createManager({
  bundleRoot: BUNDLE_ROOT,
  product: 'V3Redis',
  owner: Updater.OWNER,
  repo: Updater.REPO,
  version: app.getVersion(),
  launchable: (file) => isLaunchable(file),
  relPath: (entry) => Platforms.bundledEntry(entry, process.platform),
});

/** L'exécutable de l'application tourne-t-il ? (tasklist : sans dépendre de la langue ni des droits) */
function exeRunning(entry) {
  const exe = entry.windows && entry.windows.exe;
  if (!IS_WIN || !exe) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(!err && Updater.parseTasklist(stdout).has(exe.toLowerCase()));
    });
  });
}

/** Installe depuis le HUB l'application (paquet de la release de cette version), avec progression. */
async function addApp(id) {
  const entry = findEntry(id);
  if (!entry || entry.status !== 'available' || !Platforms.bundledEntry(entry, process.platform)) return { ok: false, error: 'Application inconnue.' };
  const send = (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('apps:progress', { id, ...p });
  };
  const res = await manager.install(entry, send);
  detected.delete(id);
  return res;
}

/** Désinstalle l'application livrée avec V3Redis, après confirmation. */
async function removeApp(id) {
  const entry = findEntry(id);
  if (!entry || entry.status !== 'available') return { ok: false, error: 'Application inconnue.' };
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: `Désinstaller ${entry.name}`,
    message: `Désinstaller ${entry.name} ?`,
    detail: `${entry.name} est retiré de V3Redis et de cet ordinateur (menu Démarrer compris). Ses réglages sont conservés.\n\nVous pourrez le réinstaller à tout moment depuis V3Redis.`,
    buttons: ['Désinstaller', 'Annuler'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0) return { ok: false, canceled: true };
  const res = await manager.uninstall(entry, exeRunning);
  detected.delete(id);
  return res;
}

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
  const rel = Platforms.bundledEntry(entry, process.platform);
  if (!BUNDLE_ROOT || !rel) return null;
  const dir = path.join(BUNDLE_ROOT, entry.id);
  const exe = path.join(dir, rel);
  if (!(await isLaunchable(exe))) return null;
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

async function findLocalBuild(entry) {
  const local = entry.local;
  if (!PROJECTS_ROOT || !local) return null;
  const dir = path.join(PROJECTS_ROOT, local.project);
  const candidates = [];
  if (IS_WIN) {
    for (const rel of local.winExe || []) candidates.push(path.join(dir, rel));
    candidates.push(await newestInDist(dir, local.winPortable));
  } else if (IS_LINUX) {
    if (entry.linux && entry.linux.bin) {
      for (const arch of ['x64', 'arm64']) candidates.push(path.join(dir, 'dist', Platforms.unpackedDir('linux', arch), entry.linux.bin));
    }
    candidates.push(await newestInDist(dir, local.appImage));
  } else if (IS_MAC && entry.mac) {
    for (const arch of ['arm64', 'x64', 'universal']) candidates.push(path.join(dir, 'dist', Platforms.unpackedDir('darwin', arch), entry.mac.app));
  }
  for (const file of candidates) {
    if (file && (await isLaunchable(file))) return { path: file, version: await projectVersion(dir), source: 'build' };
  }
  return null;
}

/** Installeur Windows compilé dans le projet voisin (proposé quand l'application n'est pas installée). */
async function findLocalInstaller(local) {
  if (!IS_WIN || !PROJECTS_ROOT || !local) return null;
  return newestInDist(path.join(PROJECTS_ROOT, local.project), local.winInstaller);
}

/** Dernière détection de chaque application (listApps) : le lancement la réutilise au lieu de tout refaire. */
const detected = new Map();

/** Catalogue + état de chaque application. */
async function listApps() {
  return Promise.all(
    APPS.map(async (entry) => {
      const state = entry.status === 'available' ? await detect(entry) : { installed: false };
      detected.set(entry.id, state);
      // Installation proposée si l'application n'est pas réellement installée (absente ou simple build local)
      const notReallyInstalled = !state.installed || state.source === 'build';
      const installer = entry.status === 'available' && notReallyInstalled ? await findLocalInstaller(entry.local) : null;
      // Gestion depuis le HUB (Windows) : ajout depuis la release de cette version, retrait du dossier livré
      const manageable = entry.status === 'available' && manager.supported() && Boolean(Platforms.bundledEntry(entry, process.platform));
      const inBundle = manageable && (state.source === 'hub' || Boolean(await findBundled(entry)));
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
        canAdd: manageable && !inBundle && notReallyInstalled,
        canRemove: inBundle,
        // Installation en cours (une fenêtre recréée, par exemple en passant en mode Light, reprend la barre)
        installing: manager.busy() === entry.id ? manager.progress() || { id: entry.id, phase: 'prepare', percent: 0 } : null,
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
  // Détection déjà faite par l'affichage de la liste (recherche dans le registre : plusieurs secondes) :
  // réutilisée si le programme est toujours là, sinon refaite
  const cached = detected.get(id);
  const state = cached && cached.installed && (await isLaunchable(cached.path)) ? cached : await detect(entry);
  if (!state.installed) return { ok: false, error: `${entry.name} n'est pas installé (ou introuvable).` };
  if (IS_LINUX && state.source !== 'hub') await fs.chmod(state.path, 0o755).catch(() => {}); // AppImage copiée sans droit d'exécution
  // Linux : une application livrée avec le HUB vit dans le système de fichiers monté par l'AppImage du HUB,
  // qui disparaît quand le HUB se ferme. Le HUB reste donc ouvert (caché) tant qu'elle tourne.
  const fromHubMount = IS_LINUX && Boolean(process.env.APPIMAGE) && state.source === 'hub';
  // macOS : un paquet .app s'ouvre avec « open » (l'application devient indépendante du HUB)
  const [cmd, args] = IS_MAC && /\.app$/i.test(state.path) ? ['open', [state.path]] : [state.path, []];
  // Appelé par l'interface À LA FIN de l'animation de lancement : l'application démarre seulement maintenant
  return new Promise((resolve) => {
    try {
      // Processus indépendant : l'application continue après la fermeture de V3Redis
      const child = spawn(cmd, args, { cwd: path.dirname(state.path), detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (err) => resolve({ ok: false, error: `Lancement impossible : ${err.message}` }));
      child.once('spawn', () => {
        child.unref();
        const launchId = ++launchCounter;
        const exited = new Promise((r) => child.once('exit', r));
        // Surveillance de la fenêtre de l'application : V3Redis ne se ferme qu'une fois qu'elle est affichée
        pendingLaunches.set(launchId, { shown: waitForWindow(child.pid), exited, fromHubMount });
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
  // Light : pas de fondu, la fenêtre disparaît tout de suite
  const steps = currentMode.mode === 'light' ? 0 : 30;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    win.setOpacity(1 - t * t * (3 - 2 * t)); // fondu adouci (~0,6 s)
    await new Promise((r) => setTimeout(r, 20));
  }
  revived = false;
  win.hide();
  const waiting = pendingLaunches.get(launchId);
  pendingLaunches.delete(launchId);
  if (waiting) await waiting.shown;
  // Linux, application livrée dans l'AppImage du HUB : on attend qu'elle se ferme (sinon ses fichiers disparaîtraient)
  if (waiting && waiting.fromHubMount) {
    let done = false;
    waiting.exited.then(() => (done = true));
    while (!revived && !done) await new Promise((r) => setTimeout(r, 1000));
  }
  // Mise à jour en cours de téléchargement : V3Redis (caché) la termine avant de se fermer (20 min au plus)
  const deadline = Date.now() + 20 * 60 * 1000;
  while (!revived && Updater.getStatus().state === 'downloading' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  // Application en cours d'installation depuis le HUB : terminée (cachée) avant la fermeture
  while (!revived && manager.busy()) await new Promise((r) => setTimeout(r, 1000));
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
  const filters = IS_WIN
    ? [{ name: 'Programme', extensions: ['exe'] }]
    : IS_LINUX
      ? [{ name: 'AppImage', extensions: ['AppImage'] }, { name: 'Tous les fichiers', extensions: ['*'] }]
      : IS_MAC
        ? [{ name: 'Application', extensions: ['app'] }]
        : [];
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
  // Applications du paquet V3Redis : ajout (téléchargement) et retrait depuis le HUB
  handle('apps:add', (id) => addApp(String(id)));
  handle('apps:cancelAdd', async () => manager.cancel());
  handle('apps:remove', (id) => removeApp(String(id)));
  handle('hub:retreat', (launchId) => retreat(Number(launchId)));
  // Boutons de la barre de titre (fenêtre sans cadre)
  handle('window:minimize', async () => mainWindow && mainWindow.minimize());
  handle('window:close', async () => mainWindow && mainWindow.close());
  handle('apps:choose', (id) => chooseExecutable(String(id)));
  handle('apps:forget', (id) => forgetExecutable(String(id)));
  handle('apps:download', (id) => openDownload(String(id)));
  handle('hub:info', () => ({ version: app.getVersion(), platform: process.platform, mode: currentMode.mode }));
  handle('hub:setMode', (mode) => setMode(String(mode)));
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
  const bundled = APPS.filter((a) => a.status === 'available' && a.windows && a.windows.exe).map((a) => ({ name: a.name, exe: a.windows.exe, id: a.id }));
  Updater.setBundleRoot(BUNDLE_ROOT);
  Updater.start((s) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', s);
  }, bundled);
}

// ---------------------------------------------------------------------------
// Fenêtre et cycle de vie
// ---------------------------------------------------------------------------

/** Mode de cette session : { mode: 'full' | 'light', auto } (voir mode.js). */
let currentMode = { mode: 'full', auto: false };

function createWindow() {
  const win = new BrowserWindow({
    ...Mode.windowOptions(currentMode.mode),
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      // Le mode est connu de la page avant son premier rendu (lu par preload.js)
      additionalArguments: [`--v3redis-mode=${currentMode.mode}`, ...(currentMode.auto ? ['--v3redis-auto'] : [])],
    },
  });
  mainWindow = win;
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => {
    win.show();
    startUpdater();
  });
  // Fermeture pendant l'installation d'une application : la fenêtre disparaît, l'installation se termine en
  // arrière-plan, puis V3Redis se ferme (sauf s'il a été rouvert entre-temps)
  win.on('close', (event) => {
    if (!manager.busy() || win !== mainWindow) return;
    event.preventDefault();
    revived = false;
    win.hide();
    manager.whenIdle().then(() => {
      if (!revived && !win.isDestroyed() && !win.isVisible()) app.quit();
    });
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(INDEX_FILE);
  if (process.argv.includes('--dev') && !app.isPackaged) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

/**
 * Passe de V3Redis complet à V3Redis Light (ou l'inverse) : le choix est enregistré, puis la fenêtre est
 * recréée (le cadre d'une fenêtre ne peut pas changer une fois créée). La nouvelle s'ouvre au même endroit.
 */
async function setMode(mode) {
  if (!Mode.MODES.includes(mode)) return { ok: false, error: 'Mode inconnu.' };
  settings.mode = mode;
  await saveSettings();
  if (mode === currentMode.mode) return { ok: true, mode };
  const old = mainWindow;
  const bounds = old && !old.isDestroyed() ? old.getBounds() : null;
  currentMode = { mode, auto: false };
  const win = createWindow();
  if (bounds) {
    // Même centre que l'ancienne fenêtre, à la taille par défaut du nouveau mode
    const o = Mode.windowOptions(mode);
    win.setBounds({ x: Math.round(bounds.x + (bounds.width - o.width) / 2), y: Math.round(bounds.y + (bounds.height - o.height) / 2), width: o.width, height: o.height });
  }
  win.once('ready-to-show', () => {
    if (old && !old.isDestroyed()) old.destroy();
  });
  return { ok: true, mode };
}

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    // Raccourci « V3Redis Light » (ou --full) alors que V3Redis est ouvert dans l'autre mode : on bascule
    const wanted = argv.includes('--light') ? 'light' : argv.includes('--full') ? 'full' : null;
    if (wanted && wanted !== currentMode.mode && mainWindow.isVisible()) {
      setMode(wanted);
      return;
    }
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
    currentMode = Mode.resolveMode({ argv: process.argv, saved: settings.mode, totalMem: os.totalmem(), cpus: os.cpus().length });
    registerIpc();
    manager.cleanup(); // restes d'une installation interrompue
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
