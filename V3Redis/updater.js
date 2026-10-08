/*
 * updater.js — Mises à jour de V3Redis via les releases GitHub (WaynneK/V3Redis).
 *
 * UN SEUL PAQUET : l'installeur de V3Redis contient aussi les applications (SysInfo Lite, CalkIP, PredF,
 * Agépédé, dans resources/apps). Mettre à jour V3Redis met donc à jour toutes les applications livrées avec lui.
 * Publier une release GitHub avec les fichiers produits par « npm run build » (V3Redis-Setup-x.y.z.exe, son
 * .blockmap et latest.yml) suffit : V3Redis la détecte au démarrage puis toutes les 4 h.
 *
 *   - Windows installé (NSIS) : mode « auto » (electron-updater). Téléchargement en arrière-plan, différentiel
 *     grâce au .blockmap (seuls les blocs modifiés sont téléchargés), empreinte SHA-512 vérifiée.
 *     L'installation se fait sur demande (« Installer et redémarrer »), JAMAIS à la fermeture : V3Redis se ferme
 *     juste après avoir lancé une application, et une application en cours d'exécution ne peut pas être remplacée.
 *     Avant d'installer, on vérifie qu'aucune application livrée n'est ouverte.
 *   - Autres cas (Linux hors AppImage…) : mode « notify ». La nouvelle version est signalée, la page de la
 *     release s'ouvre ; l'installation reste manuelle.
 *   - Développement (npm start) : désactivé, sauf V3REDIS_UPDATE_URL=<adresse> (serveur de test « generic »),
 *     qui permet de tester la vérification et le téléchargement sans rien installer.
 *
 * L'état est diffusé à l'interface par l'événement IPC « update:status ».
 */
'use strict';

const { app, net, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OWNER = 'WaynneK';
const REPO = 'V3Redis';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 6000;

let send = () => {};
let autoUpdater = null;
let timer = null;
let checking = null;
let bundledExes = []; // [{ name, exe }] : applications livrées dans le paquet (vérifiées avant l'installation)

const status = {
  mode: 'disabled', // 'auto' | 'notify' | 'disabled'
  state: 'idle', // 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  current: app.getVersion(),
  version: null,
  percent: null,
  transferred: null,
  total: null,
  notes: null,
  releaseUrl: RELEASES_URL,
  error: null,
  checkedAt: null,
  manual: false, // vérification demandée par l'utilisateur (l'interface confirme « à jour »)
  test: false,
};

function publish(patch) {
  Object.assign(status, patch);
  send({ ...status });
}

function detectMode() {
  if (!app.isPackaged) return process.env.V3REDIS_UPDATE_URL ? 'auto' : 'disabled';
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'notify' : 'auto';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'auto' : 'notify';
  return 'notify';
}

/** « 1.2.0 » > « 1.1.9 » ; les suffixes (-beta…) sont ignorés. */
function isNewer(remote, local) {
  const parts = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const a = parts(remote);
  const b = parts(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** Notes de version : electron-updater les fournit en HTML ou en tableau ; on garde du texte brut court. */
function plainNotes(notes) {
  const text = Array.isArray(notes) ? notes.map((n) => (n && n.note) || '').join('\n') : String(notes || '');
  return (
    text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|h\d)>/gi, '\n')
      .replace(/<li>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 2000) || null
  );
}

function describeError(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ERR_INTERNET|net::ERR/i.test(msg)) return 'Pas de connexion au serveur de mises à jour.';
  if (/latest(-linux)?\.yml|\b404\b/i.test(msg)) return 'Aucune mise à jour publiée pour le moment (ou publication en cours).';
  if (/sha512|checksum/i.test(msg)) return 'Fichier téléchargé corrompu (empreinte incorrecte) : nouvel essai à la prochaine vérification.';
  if (/ENOSPC/i.test(msg)) return 'Espace disque insuffisant pour télécharger la mise à jour.';
  return msg.split('\n')[0].slice(0, 200) || 'Erreur inconnue';
}

// --- Mode « notify » : simple lecture de la dernière release publiée ---------------------------------

async function checkNotify() {
  const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `V3Redis/${status.current}` },
  });
  if (res.status === 404) return publish({ state: 'not-available', checkedAt: Date.now(), error: null });
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  const release = await res.json();
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (version && isNewer(version, status.current)) {
    publish({ state: 'available', version, notes: plainNotes(release.body), releaseUrl: release.html_url || RELEASES_URL, checkedAt: Date.now(), error: null });
  } else {
    publish({ state: 'not-available', checkedAt: Date.now(), error: null });
  }
}

// --- Mode « auto » : electron-updater -------------------------------------------------------------------

function setupAutoUpdater() {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true; // téléchargement en arrière-plan (différentiel quand c'est possible)
  autoUpdater.autoInstallOnAppQuit = false; // voir l'en-tête : installation uniquement sur demande
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (m) => console.log('[update]', m),
    warn: (m) => console.warn('[update]', m),
    error: (m) => console.error('[update]', m),
    debug: () => {},
  };
  // Test en développement : serveur local « generic » (aucune installation possible hors application installée).
  // electron-updater lit alors sa configuration dans un fichier, écrit ici dans le dossier des données.
  if (!app.isPackaged && process.env.V3REDIS_UPDATE_URL) {
    const url = String(process.env.V3REDIS_UPDATE_URL);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) throw new Error('V3REDIS_UPDATE_URL : serveur local uniquement (http://127.0.0.1:port/).');
    const file = path.join(app.getPath('userData'), 'dev-app-update.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `provider: generic\nurl: ${url}\nupdaterCacheDirName: v3redis-updater-test\n`);
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = file;
    status.test = true;
  }
  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) =>
    publish({ state: 'downloading', version: info.version, notes: plainNotes(info.releaseNotes), percent: 0, transferred: 0, total: null, releaseUrl: `${RELEASES_URL}/tag/v${info.version}` })
  );
  autoUpdater.on('update-not-available', () => publish({ state: 'not-available', checkedAt: Date.now(), percent: null }));
  autoUpdater.on('download-progress', (p) =>
    publish({ state: 'downloading', percent: Math.floor(p.percent || 0), transferred: p.transferred || 0, total: p.total || null })
  );
  autoUpdater.on('update-downloaded', (info) =>
    publish({ state: 'downloaded', version: info.version, percent: 100, checkedAt: Date.now(), notes: plainNotes(info.releaseNotes) || status.notes })
  );
  autoUpdater.on('error', (err) => publish({ state: 'error', error: describeError(err), percent: null }));
}

// --- Applications ouvertes (elles bloqueraient le remplacement de leurs fichiers) -------------------------

/** Noms des exécutables en cours (tasklist, sans dépendre de la langue ni des droits). */
function runningExeNames() {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  return new Promise((resolve) => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(new Set());
      resolve(parseTasklist(stdout));
    });
  });
}

/** Sortie CSV de tasklist → ensemble des noms d'exécutables en minuscules. */
function parseTasklist(text) {
  const names = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

async function openBundledApps() {
  const running = await runningExeNames();
  return bundledExes.filter((a) => running.has(String(a.exe).toLowerCase())).map((a) => a.name);
}

// --- API -------------------------------------------------------------------------------------------------

/** Lance une vérification (ignorée si une autre est en cours ou si la mise à jour est déjà téléchargée). */
function check({ manual = false } = {}) {
  if (status.mode === 'disabled') return Promise.resolve({ ...status });
  if (status.state === 'downloaded' || status.state === 'downloading') return Promise.resolve({ ...status });
  if (checking) return checking;
  publish({ state: 'checking', error: null, manual });
  checking = (async () => {
    try {
      if (status.mode === 'auto') {
        const result = await autoUpdater.checkForUpdates();
        // Téléchargement en arrière-plan : son échec est déjà signalé par l'événement « error »
        if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
      } else await checkNotify();
    } catch (err) {
      publish({ state: 'error', error: describeError(err) });
    } finally {
      checking = null;
    }
    return { ...status };
  })();
  return checking;
}

/**
 * Installe la mise à jour téléchargée : refuse si une application livrée est ouverte (ses fichiers seraient
 * verrouillés), sinon ferme V3Redis, lance l'installation silencieuse puis relance V3Redis.
 */
async function install({ force = false } = {}) {
  if (status.mode !== 'auto' || status.state !== 'downloaded') return { ok: false, error: 'Aucune mise à jour prête.' };
  if (status.test) return { ok: false, error: 'Mode test : l\'installation n\'est possible que dans V3Redis installé.' };
  if (!force) {
    const open = await openBundledApps();
    if (open.length) return { ok: false, open, error: `Fermez d'abord ${open.join(', ')} : ${open.length > 1 ? 'ces applications sont mises à jour' : 'cette application est mise à jour'} avec V3Redis.` };
  }
  setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silencieux, puis relance de V3Redis
  return { ok: true };
}

function openReleasePage() {
  const url = String(status.releaseUrl || RELEASES_URL);
  if (!url.startsWith(`https://github.com/${OWNER}/${REPO}/`)) return { ok: false }; // pages du dépôt uniquement
  shell.openExternal(url);
  return { ok: true };
}

function getStatus() {
  return { ...status };
}

/**
 * À appeler une fois, quand la fenêtre est prête.
 * sendStatus(status) : diffusion à l'interface ; apps : [{ name, exe }] des applications livrées.
 */
function start(sendStatus, apps) {
  send = typeof sendStatus === 'function' ? sendStatus : () => {};
  bundledExes = Array.isArray(apps) ? apps.filter((a) => a && a.exe) : [];
  status.mode = detectMode();
  if (status.mode === 'disabled') {
    send({ ...status });
    return;
  }
  if (status.mode === 'auto') {
    try {
      setupAutoUpdater();
    } catch (err) {
      console.warn('[update] electron-updater indisponible :', err && err.message);
      status.mode = app.isPackaged ? 'notify' : 'disabled';
    }
  }
  send({ ...status });
  if (status.mode === 'disabled') return;
  setTimeout(() => check(), FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => check(), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, check, install, openReleasePage, getStatus, isNewer, plainNotes, parseTasklist, OWNER, REPO };
