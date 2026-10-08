/*
 * main.js — Processus principal de CalkIP.
 *
 * Application 100 % locale : aucune requête réseau n'est faite, ni par ce processus ni par la page
 * (CSP « connect-src 'none' », navigation et permissions bloquées, toute requête http(s) annulée).
 *
 * Rôle : fenêtre, préférences (thème), presse-papiers, et surtout l'export .txt des listes d'adresses.
 * L'export refait le calcul à partir de la saisie (il ne fait pas confiance aux nombres envoyés par la
 * page) et écrit le fichier par blocs, avec progression et annulation : un /8 représente 16,7 millions
 * de lignes (~230 Mo).
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, nativeTheme, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
const IPCalc = require('./lib/ipcalc.js');
const IPBinary = require('./lib/binary.js');

const IS_WIN = process.platform === 'win32';
const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');
const ICON_FILE = path.join(__dirname, 'renderer', 'assets', 'icon.png');
const THEMES = ['system', 'light', 'dark'];
const EOL = '\r\n'; // fins de ligne Windows : lisibles partout, y compris dans le Bloc-notes

let mainWindow = null;

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
    .catch((err) => console.warn('[calkip] préférences non enregistrées :', err.message));
  return saveChain;
}

function applyTheme(mode) {
  nativeTheme.themeSource = mode;
}

// ---------------------------------------------------------------------------
// Calcul côté processus principal (mêmes fonctions que la page)
// ---------------------------------------------------------------------------

/** Requête de la page → { calc, pool, reason, input } ; lève une CalcError si la saisie est invalide. */
function compute(req) {
  const input = String((req && req.input) || '').slice(0, 200);
  const parsed = IPCalc.parseInput(input);
  const { prefix, reason } = IPCalc.resolvePrefix(parsed, req.mode === 'auto' ? 'auto' : Number(req.mode));
  const calc = IPCalc.calculate(parsed.ip, prefix);
  const d = req.dhcp || {};
  const pool = IPCalc.dhcpPool(calc, {
    gateway: ['first', 'last', 'none', 'custom'].includes(d.gateway) ? d.gateway : 'first',
    customGateway: String(d.customGateway || ''),
    reserveStart: d.reserveStart,
    reserveEnd: d.reserveEnd,
    exclusions: String(d.exclusions || '').slice(0, 100000),
    limit: d.limit === undefined || d.limit === null ? '' : String(d.limit).slice(0, 12),
  });
  return { calc, pool, reason, input };
}

const stamp = () => new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const rule = '='.repeat(64);

function header(title, data) {
  return [
    `CalkIP — ${title}`,
    `Généré le ${stamp()} (calcul local, hors ligne)`,
    rule,
    ...IPCalc.summaryLines(data.calc, data.pool, { input: data.input, reason: data.reason }),
    ...(data.pool.notes.length ? ['', ...data.pool.notes.map((n) => `Remarque : ${n}`)] : []),
    rule,
  ];
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-');

async function askSavePath(defaultName) {
  const dir = settings.lastDir && fs.existsSync(settings.lastDir) ? settings.lastDir : app.getPath('documents');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer la liste',
    defaultPath: path.join(dir, defaultName),
    filters: [{ name: 'Texte', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return null;
  settings.lastDir = path.dirname(res.filePath);
  saveSettings();
  return res.filePath;
}

// Fichiers écrits pendant cette session : seuls ceux-là peuvent être montrés dans l'explorateur
const writtenFiles = new Set();

// ---------------------------------------------------------------------------
// Export de la liste d'adresses (écriture par blocs, progression, annulation)
// ---------------------------------------------------------------------------

let currentExport = null; // { canceled: boolean }

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('export:progress', payload);
}

/** Écrit `chunk` en respectant la contre-pression du flux. */
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    stream.once('error', onError);
    if (stream.write(chunk)) {
      stream.removeListener('error', onError);
      resolve();
    } else {
      stream.once('drain', () => {
        stream.removeListener('error', onError);
        resolve();
      });
    }
  });
}

async function exportList(req) {
  if (currentExport) return { ok: false, error: 'Un export est déjà en cours.' };
  const data = compute(req);
  const { calc, pool } = data;
  const scope = req.scope === 'usable' ? 'usable' : 'pool';
  const numbered = Boolean(req.numbered);

  // Plage à écrire : baux DHCP (plage distribuable, exclusions retirées) ou toutes les adresses utilisables
  const range = scope === 'pool' ? { start: pool.start, end: pool.end, excluded: pool.skip, count: pool.leases } : { start: calc.firstHost, end: calc.lastHost, excluded: [], count: calc.usable };
  if (range.count === 0) return { ok: false, error: 'La liste est vide : aucune adresse à exporter avec ces réglages.' };
  if (range.count > IPCalc.EXPORT_LIMIT) {
    return { ok: false, error: `Liste trop grande (${IPCalc.formatNumber(range.count)} adresses) : l'export est limité à un /8 (${IPCalc.formatNumber(IPCalc.EXPORT_LIMIT)} adresses). Exportez le résumé ou découpez le réseau.` };
  }

  const net = `${IPCalc.toIp(calc.network)}-${calc.prefix}`;
  const filePath = await askSavePath(`CalkIP_${safeName(net)}_${scope === 'pool' ? 'baux-DHCP' : 'adresses'}.txt`);
  if (!filePath) return { ok: false, canceled: true };

  const job = { canceled: false };
  currentExport = job;
  const started = Date.now();
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  let written = 0;
  let lastSent = 0;
  try {
    const title = scope === 'pool' ? 'baux DHCP disponibles' : 'adresses IP utilisables';
    const head = [
      ...header(`liste des ${title}`, data),
      scope === 'pool'
        ? `Liste : ${IPCalc.formatNumber(range.count)} adresses distribuables (passerelle, réservations et exclusions retirées${pool.limit !== null ? ', limitée au nombre de baux demandé' : ''})`
        : `Liste : ${IPCalc.formatNumber(range.count)} adresses utilisables (de ${IPCalc.toIp(range.start)} à ${IPCalc.toIp(range.end)})`,
      rule,
      '',
    ];
    // BOM UTF-8 : le Bloc-notes affiche correctement les accents de l'en-tête
    await writeChunk(stream, `﻿${head.join(EOL)}${EOL}`);

    // Parcours par blocs de 50 000 adresses : chaque bloc reprend après la dernière adresse écrite
    const width = String(range.count).length;
    const BLOCK = 50000;
    let nextStart = range.start;
    let emittedTotal = 0;
    const emitBlock = () => {
      const lines = [];
      let last = null;
      IPCalc.forEachAddress(nextStart, range.end, range.excluded, (ip) => {
        emittedTotal += 1;
        lines.push(numbered ? `${String(emittedTotal).padStart(width, ' ')}  ${IPCalc.toIp(ip)}` : IPCalc.toIp(ip));
        last = ip;
        return lines.length < BLOCK;
      });
      if (last !== null) nextStart = last + 1;
      return lines.length ? lines.join(EOL) + EOL : null;
    };

    for (;;) {
      if (job.canceled) throw Object.assign(new Error('Export annulé.'), { canceled: true });
      if (nextStart > range.end) break;
      const block = emitBlock();
      if (!block) break;
      await writeChunk(stream, block);
      written = emittedTotal;
      const now = Date.now();
      if (now - lastSent > 80) {
        lastSent = now;
        sendProgress({ written, total: range.count });
      }
      // Laisse respirer la boucle d'événements (annulation, rafraîchissement de la fenêtre)
      await new Promise((resolve) => setImmediate(resolve));
    }

    await writeChunk(stream, `${EOL}${rule}${EOL}Total : ${IPCalc.formatNumber(written)} adresses${EOL}`);
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
    if (written !== range.count) throw new Error(`Incohérence : ${written} adresses écrites pour ${range.count} attendues.`);
    sendProgress({ written, total: range.count, done: true });
    writtenFiles.add(filePath);
    const bytes = (await fsp.stat(filePath)).size;
    return { ok: true, filePath, count: written, bytes, ms: Date.now() - started };
  } catch (err) {
    stream.destroy();
    await fsp.unlink(filePath).catch(() => {}); // pas de fichier incomplet laissé sur le disque
    sendProgress({ written, total: range.count, aborted: true });
    if (err && err.canceled) return { ok: false, canceled: true, error: 'Export annulé : le fichier incomplet a été supprimé.' };
    throw err;
  } finally {
    currentExport = null;
  }
}

/** Résumé seul (et, si demandé, la liste des sous-réseaux d'un découpage). */
async function exportSummary(req) {
  const data = compute(req);
  const lines = header('résumé du calcul', data);
  let splitInfo = null;
  if (req.split && Number.isFinite(Number(req.split))) {
    splitInfo = IPCalc.splitSubnets(data.calc, Number(req.split), 0);
    if (splitInfo.count > 2 ** 20) {
      return { ok: false, error: `Découpage trop grand pour un fichier texte (${IPCalc.formatNumber(splitInfo.count)} sous-réseaux, limite ${IPCalc.formatNumber(2 ** 20)}).` };
    }
  }
  const name = `CalkIP_${safeName(`${IPCalc.toIp(data.calc.network)}-${data.calc.prefix}`)}_${splitInfo ? `decoupage-${splitInfo.prefix}` : 'resume'}.txt`;
  const filePath = await askSavePath(name);
  if (!filePath) return { ok: false, canceled: true };

  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  try {
    await writeChunk(stream, `﻿${lines.join(EOL)}${EOL}`);
    if (splitInfo) {
      await writeChunk(
        stream,
        [
          '',
          `Découpage en /${splitInfo.prefix} : ${IPCalc.formatNumber(splitInfo.count)} sous-réseaux de ${IPCalc.formatNumber(splitInfo.size)} adresses (${IPCalc.formatNumber(splitInfo.usablePerSubnet)} utilisables chacun)`,
          '',
          `${'N°'.padEnd(10)}${'Réseau'.padEnd(20)}${'Première'.padEnd(17)}${'Dernière'.padEnd(17)}Diffusion`,
          '',
        ].join(EOL)
      );
      const per = 4096;
      for (let offset = 0; offset < splitInfo.count; offset += per) {
        const part = IPCalc.splitSubnets(data.calc, splitInfo.prefix, per, offset).subnets;
        const block = part
          .map((s, i) =>
            `${String(offset + i + 1).padEnd(10)}${`${IPCalc.toIp(s.network)}/${s.prefix}`.padEnd(20)}${IPCalc.toIp(s.firstHost).padEnd(17)}${IPCalc.toIp(s.lastHost).padEnd(17)}${s.broadcast === null ? '—' : IPCalc.toIp(s.broadcast)}`
          )
          .join(EOL);
        await writeChunk(stream, block + EOL);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
    writtenFiles.add(filePath);
    return { ok: true, filePath };
  } catch (err) {
    stream.destroy();
    await fsp.unlink(filePath).catch(() => {});
    throw err;
  }
}

/** Calcul binaire expliqué étape par étape (refait ici à partir de l'adresse et du préfixe). */
async function exportBinary(req) {
  const ip = IPCalc.parseIp(String((req && req.ip) || '').slice(0, 40));
  const prefix = IPCalc.parsePrefix(String(req && req.prefix));
  const filePath = await askSavePath(`CalkIP_${safeName(`${IPCalc.toIp(ip)}-${prefix}`)}_calcul-binaire.txt`);
  if (!filePath) return { ok: false, canceled: true };
  const lines = [`CalkIP — calcul binaire`, `Généré le ${stamp()} (calcul local, hors ligne)`, rule, '', ...IPBinary.explainLines(ip, prefix), '', rule];
  await fsp.writeFile(filePath, `﻿${lines.join(EOL)}${EOL}`, 'utf8'); // BOM : accents lisibles dans le Bloc-notes
  writtenFiles.add(filePath);
  return { ok: true, filePath };
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
      if (err && err.name === 'CalcError') return { ok: false, error: err.message, field: err.field };
      console.error(`[ipc] ${channel} :`, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle('export:list', (req) => exportList(req || {}));
  handle('export:summary', (req) => exportSummary(req || {}));
  handle('export:binary', (req) => exportBinary(req || {}));
  handle('export:cancel', async () => {
    if (currentExport) currentExport.canceled = true;
    return { ok: true };
  });
  handle('file:show', async (filePath) => {
    if (!writtenFiles.has(filePath)) return { ok: false };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
  handle('clipboard:write', async (text) => {
    await clipboard.writeText(String(text || '').slice(0, 1_000_000));
    return { ok: true };
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
  // L'interface a construit sa première vue : l'écran de démarrage peut laisser la place
  ipcMain.on('app:ui-ready', (event) => {
    if (isTrustedSender(event)) resolveUiReady();
  });
}

// ---------------------------------------------------------------------------
// Écran de démarrage (comme SysInfo Lite) : petite fenêtre animée pendant le chargement, puis fenêtre principale
// ---------------------------------------------------------------------------

const SPLASH_FILE = path.join(__dirname, 'renderer', 'splash.html');
const SPLASH_MIN_MS = 2400; // laisse l'animation (logo → montée → nom → progression) se jouer en entier
const SPLASH_MAX_MS = 15000; // sécurité : la fenêtre principale s'ouvre quoi qu'il arrive
const SPLASH_OUT_MS = 230; // durée de l'animation de sortie de l'écran de démarrage
const LOAD_STEPS = 3; // préférences, moteur de calcul, interface

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
 * Vérification du moteur de calcul au démarrage : quelques résultats connus (réseau, diffusion, hôtes,
 * baux DHCP). Un écart est journalisé : il signalerait un fichier lib/ipcalc.js endommagé.
 */
function selfTestEngine() {
  const checks = [];
  const c24 = IPCalc.calculate(IPCalc.parseIp('192.168.1.10'), 24);
  checks.push(IPCalc.toIp(c24.network) === '192.168.1.0', IPCalc.toIp(c24.broadcast) === '192.168.1.255', c24.usable === 254);
  checks.push(IPCalc.dhcpPool(c24, { gateway: 'first' }).leases === 253);
  checks.push(IPCalc.dhcpPool(IPCalc.calculate(IPCalc.parseIp('10.0.0.1'), 26), { gateway: 'none', limit: '50' }).leases === 50);
  checks.push(IPCalc.calculate(IPCalc.parseIp('10.0.0.1'), 8).usable === 16777214, IPCalc.usableCount(31) === 2, IPCalc.usableCount(32) === 1);
  checks.push(IPCalc.resolvePrefix(IPCalc.parseInput('172.16.5.4'), 'auto').prefix === 16);
  // Calcul binaire : conversion, nombre magique, explication complète
  checks.push(IPBinary.parseBinaryIp('11000000.10101000.00000001.00001010') === IPCalc.parseIp('192.168.1.10'));
  checks.push(IPBinary.magic(IPCalc.parseIp('172.16.45.3'), 20).netOctet === 32, IPBinary.explain(IPCalc.parseIp('192.168.1.10'), 26).steps.length === 9);
  const ok = checks.every(Boolean);
  if (!ok) console.error('[calkip] vérification du moteur de calcul : résultats inattendus', checks);
  return ok;
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
    title: 'CalkIP',
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
  // Résolu quand l'écran de démarrage est visible (ou s'il ne peut pas s'afficher)
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

/**
 * Ouvre la fenêtre principale quand : l'animation de l'écran de démarrage a eu le temps de se jouer,
 * la page principale est peinte et sa première vue est construite. Au-delà de 15 s, on l'ouvre quand même.
 */
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

/**
 * Crée la fenêtre principale. deferShow : elle reste cachée (l'écran de démarrage décide quand l'afficher) ;
 * la fonction renvoie une promesse résolue quand la page est peinte.
 */
function createWindow({ deferShow = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 600,
    show: false,
    title: 'CalkIP',
    icon: ICON_FILE,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14122e' : '#f4f3fb',
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
    if (currentExport) currentExport.canceled = true;
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
    // Pendant le démarrage, c'est l'écran de chargement qui est au premier plan
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
    // Thème appliqué avant l'écran de démarrage : il s'affiche directement en clair ou en sombre
    await loadSettings();
    applyTheme(settings.theme);
    const splashShown = createSplash();
    splashProgress(1, 'Vérification du moteur de calcul…');
    selfTestEngine();
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
