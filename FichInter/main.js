/*
 * main.js — Processus principal de FichInter (fiches d'intervention).
 *
 * Application locale : aucune connexion (requêtes http(s) annulées, navigation et permissions bloquées).
 * Rôle : fenêtre, écran de démarrage, préférences ; modèles Word (livrés avec l'application dans modeles/, ou
 * importés dans <données>/Modèles) ; génération de la fiche (.docx) dans le dossier des fiches, relecture,
 * export PDF (Word s'il est installé, sinon rendu de l'aperçu) ; fiches récentes et leurs saisies.
 */
'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, Menu, session, dialog, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const Docx = require('./lib/docx.js');
const Fields = require('./lib/fields.js');

const IS_WIN = process.platform === 'win32';
const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');
const ICON_FILE = path.join(__dirname, 'renderer', 'assets', 'icon.png');
const BUILTIN_DIR = path.join(__dirname, 'modeles');
const THEMES = ['system', 'light', 'dark'];
const MAX_RECENT = 40;

let mainWindow = null;

// ---------------------------------------------------------------------------
// Préférences : thème, dossier des fiches, fiches récentes, numéro de dossier du jour
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { theme: 'system', outDir: '', recent: [], ref: { day: '', n: 0 } };

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'));
    if (THEMES.includes(parsed.theme)) settings.theme = parsed.theme;
    if (typeof parsed.outDir === 'string' && path.isAbsolute(parsed.outDir)) settings.outDir = parsed.outDir;
    if (Array.isArray(parsed.recent)) settings.recent = parsed.recent.filter((r) => r && typeof r.file === 'string' && typeof r.id === 'string').slice(0, MAX_RECENT);
    if (parsed.ref && typeof parsed.ref.day === 'string' && Number.isInteger(parsed.ref.n)) settings.ref = parsed.ref;
  } catch {
    // premier lancement
  }
}

/** Écriture atomique (fichier temporaire puis renommage) : jamais de fichier à moitié écrit. */
async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

let saveChain = Promise.resolve();
function saveSettings() {
  saveChain = saveChain
    .then(() => writeAtomic(settingsFile(), JSON.stringify(settings, null, 2)))
    .catch((err) => console.warn('[fichinter] préférences non enregistrées :', err.message));
  return saveChain;
}

const outDir = () => settings.outDir || path.join(app.getPath('documents'), 'Fiches d\'intervention');
const inputsDir = () => path.join(app.getPath('userData'), 'Saisies');
const userModelsDir = () => path.join(app.getPath('userData'), 'Modèles');

// ---------------------------------------------------------------------------
// Modèles : modeles/ (livrés) et <données>/Modèles (importés). Identifiant : « b:<fichier> » ou « u:<fichier> ».
// ---------------------------------------------------------------------------

const isDocxName = (n) => /\.docx$/i.test(n) && !n.startsWith('~$') && !n.startsWith('.');

function modelPath(id) {
  const m = /^([bu]):(.+)$/.exec(String(id || ''));
  if (!m || !isDocxName(m[2]) || m[2] !== path.basename(m[2]) || /[/\\]/.test(m[2])) throw new Error('Modèle inconnu.');
  return path.join(m[1] === 'b' ? BUILTIN_DIR : userModelsDir(), m[2]);
}

const describeCache = new Map(); // chemin → { stamp, value }

/** Description d'un modèle (mise en cache tant que le fichier ne change pas). */
async function describeModel(id) {
  const file = modelPath(id);
  const st = await fsp.stat(file);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const cached = describeCache.get(file);
  if (cached && cached.stamp === stamp) return cached.value;
  const { schema, hash } = await Docx.describe(await fsp.readFile(file));
  const value = { id, name: path.basename(file).replace(/\.docx$/i, ''), builtin: id.startsWith('b:'), hash, schema, size: st.size, mtime: Math.round(st.mtimeMs) };
  describeCache.set(file, { stamp, value });
  return value;
}

async function listModels() {
  const out = [];
  for (const [prefix, dir] of [['b', BUILTIN_DIR], ['u', userModelsDir()]]) {
    let names = [];
    try {
      names = (await fsp.readdir(dir)).filter(isDocxName).sort((a, b) => a.localeCompare(b, 'fr'));
    } catch {
      continue; // dossier absent
    }
    for (const name of names) {
      const id = `${prefix}:${name}`;
      try {
        const m = await describeModel(id);
        out.push({ id, name: m.name, builtin: m.builtin, hash: m.hash, title: m.schema.title, sections: m.schema.sections.length, fields: m.schema.fieldCount });
      } catch (err) {
        out.push({ id, name: name.replace(/\.docx$/i, ''), builtin: prefix === 'b', error: err.message });
      }
    }
  }
  return out;
}

/** Nom libre dans un dossier : « Nom.docx », « Nom (2).docx »… */
async function freeName(dir, base, ext) {
  for (let i = 1; i < 1000; i++) {
    const name = `${base}${i > 1 ? ` (${i})` : ''}${ext}`;
    try {
      await fsp.access(path.join(dir, name));
    } catch {
      return name;
    }
  }
  throw new Error('Trop de fichiers portent ce nom.');
}

async function importModel() {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Importer un modèle de fiche',
    properties: ['openFile'],
    filters: [{ name: 'Document Word', extensions: ['docx'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  const src = res.filePaths[0];
  const buf = await fsp.readFile(src);
  const { schema } = await Docx.describe(buf);
  if (!schema.fieldCount) {
    return { ok: false, error: 'Aucune case à remplir n\'a été trouvée dans ce document. Un modèle se compose de tableaux « intitulé | case » (cases vides, cases à cocher, pointillés).' };
  }
  const dir = userModelsDir();
  await fsp.mkdir(dir, { recursive: true });
  const base = Fields.safeFileName(path.basename(src).replace(/\.docx$/i, ''), 70) || 'Modèle';
  const name = await freeName(dir, base, '.docx');
  await writeAtomic(path.join(dir, name), buf);
  return { ok: true, id: `u:${name}`, fields: schema.fieldCount, sections: schema.sections.length };
}

/** Retire un modèle importé (mis à la corbeille : récupérable). */
async function removeModel(id) {
  if (!String(id).startsWith('u:')) throw new Error('Les modèles livrés avec FichInter ne peuvent pas être retirés.');
  const file = modelPath(id);
  await shell.trashItem(file);
  describeCache.delete(file);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Saisies reçues de la page : contrôle de forme (les valeurs inattendues sont ignorées)
// ---------------------------------------------------------------------------

const MAX_TEXT = 20000;
const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');

function cleanValues(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, v] of Object.entries(raw)) {
    if (!/^t\d{1,3}\.r\d{1,4}\.c\d{1,3}$/.test(key)) continue;
    if (typeof v === 'string') out[key] = str(v);
    else if (typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(v)) out[key] = v.slice(0, 20).map(str);
    else if (v && typeof v === 'object') {
      if (Array.isArray(v.selected)) {
        const extra = {};
        if (v.extra && typeof v.extra === 'object') for (const [i, t] of Object.entries(v.extra)) if (/^\d{1,3}$/.test(i)) extra[i] = str(t);
        out[key] = { selected: v.selected.filter((i) => Number.isInteger(i) && i >= 0 && i < 200).slice(0, 200), extra };
      } else if ('name' in v || 'image' in v) {
        out[key] = { name: str(v.name), image: typeof v.image === 'string' && v.image.length < 4.5 * 1024 * 1024 ? v.image : '' };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Génération, fiches récentes, ouverture, PDF
// ---------------------------------------------------------------------------

/** Fiche récente d'après son identifiant (seuls ces fichiers peuvent être ouverts ou relus par la page). */
function recentById(id) {
  const r = settings.recent.find((x) => x.id === id);
  if (!r) throw new Error('Fiche inconnue.');
  return r;
}

/**
 * Génère la fiche : .docx dans le dossier des fiches, relu et vérifié.
 * replace : identifiant d'une fiche récente à remplacer (modification d'une fiche déjà générée).
 */
async function generate(modelId, rawValues, replace) {
  const model = await describeModel(String(modelId));
  const values = cleanValues(rawValues);
  const signatures = {};
  for (const [k, v] of Object.entries(values)) if (v && typeof v === 'object' && v.image) signatures[k] = v.image;
  const { buffer, checks } = await Docx.generate(await fsp.readFile(modelPath(model.id)), values, signatures);

  let entry = null;
  // Seule une fiche du même modèle peut être remplacée (sinon : nouvelle fiche)
  if (replace) entry = settings.recent.find((x) => x.id === replace && x.modelId === model.id) || null;
  let file;
  if (entry) {
    file = entry.file;
  } else {
    const dir = outDir();
    await fsp.mkdir(dir, { recursive: true });
    file = path.join(dir, await freeName(dir, Fields.fileTitle(model.schema, values), '.docx'));
  }
  try {
    await writeAtomic(file, buffer);
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) throw new Error(`Le fichier « ${path.basename(file)} » est ouvert dans un autre programme (Word ?) : fermez-le puis recommencez.`);
    throw err;
  }

  const filled = checks.filter((c) => c.filled).length;
  const ok = checks.every((c) => c.ok);
  const id = entry ? entry.id : crypto.randomBytes(8).toString('hex');
  const record = { id, file, name: path.basename(file), modelId: model.id, modelName: model.name, hash: model.hash, createdAt: entry ? entry.createdAt : Date.now(), updatedAt: Date.now(), filled, total: checks.length, ok };
  const all = [record, ...settings.recent.filter((x) => x.id !== id)];
  settings.recent = all.slice(0, MAX_RECENT);
  await saveSettings();
  // Fiches sorties de la liste : leurs saisies ne servent plus (le .docx, lui, reste dans le dossier des fiches)
  for (const old of all.slice(MAX_RECENT)) await fsp.rm(path.join(inputsDir(), `${old.id}.json`), { force: true }).catch(() => {});
  // Saisies gardées pour « Reprendre » la fiche plus tard (signatures comprises)
  await writeAtomic(path.join(inputsDir(), `${id}.json`), JSON.stringify({ modelId: model.id, hash: model.hash, values }));

  return { ok: true, record, checks, data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

async function listRecent() {
  const out = [];
  for (const r of settings.recent) {
    let exists = true;
    try {
      await fsp.access(r.file);
    } catch {
      exists = false;
    }
    out.push({ ...r, exists, dir: path.dirname(r.file) });
  }
  return out;
}

async function readRecent(id) {
  const r = recentById(id);
  const buf = await fsp.readFile(r.file);
  let inputs = null;
  try {
    inputs = JSON.parse(await fsp.readFile(path.join(inputsDir(), `${r.id}.json`), 'utf8'));
  } catch {
    // saisies absentes (fiche d'une version précédente)
  }
  // Nouvelle relecture du fichier (il a pu être modifié dans Word depuis sa génération)
  let checks = null;
  let model = null;
  if (inputs && inputs.values) {
    try {
      model = await describeModel(r.modelId);
      if (model.hash === inputs.hash) checks = await Docx.check(await fsp.readFile(modelPath(r.modelId)), buf, cleanValues(inputs.values));
    } catch {
      model = null; // modèle retiré ou modifié : pas de vérification possible
    }
  }
  return { ok: true, record: r, inputs, checks, modelAvailable: Boolean(model && model.hash === (inputs && inputs.hash)), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

/** Retire une fiche de la liste (le fichier .docx reste dans le dossier des fiches). */
async function forgetRecent(id) {
  const r = recentById(id);
  settings.recent = settings.recent.filter((x) => x.id !== r.id);
  await saveSettings();
  await fsp.rm(path.join(inputsDir(), `${r.id}.json`), { force: true });
  return { ok: true };
}

function run(cmd, args, { timeout = 90000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

let wordAvailable = null;
async function hasWord() {
  if (!IS_WIN) return false;
  if (wordAvailable === null) wordAvailable = (await run('reg', ['query', 'HKCR\\Word.Application\\CurVer'], { timeout: 8000 })).ok;
  return wordAvailable;
}

/** Conversion PDF par Word (fidèle à 100 %) ; chemins passés par l'environnement (accents, apostrophes). */
const WORD_PDF_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$word = New-Object -ComObject Word.Application',
  '$word.Visible = $false',
  '$word.DisplayAlerts = 0',
  'try {',
  '  $doc = $word.Documents.Open($env:FICHINTER_IN, $false, $true, $false)',
  '  $doc.ExportAsFixedFormat($env:FICHINTER_OUT, 17)',
  '  $doc.Close(0)',
  '} finally {',
  // Word déjà ouvert par l'utilisateur (même instance) : ses documents restent ouverts, Word n'est pas fermé
  '  if ($word.Documents.Count -eq 0) { $word.Quit() }',
  '  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)',
  '}',
].join('\n');

function pdfTarget(r) {
  return r.file.replace(/\.docx$/i, '.pdf');
}

/** Export PDF : par Word ; { ok:false, fallback:true } si Word est absent ou échoue (la page imprime son aperçu). */
async function exportPdf(id) {
  const r = recentById(id);
  const out = pdfTarget(r);
  if (!(await hasWord())) return { ok: false, fallback: true };
  const env = { ...process.env, FICHINTER_IN: r.file, FICHINTER_OUT: out };
  const res = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WORD_PDF_SCRIPT], { timeout: 120000, env });
  try {
    await fsp.access(out);
    if (res.ok) return { ok: true, file: out, by: 'word' };
  } catch {
    // pas de PDF produit
  }
  console.warn('[fichinter] export PDF par Word impossible :', res.err.trim().slice(0, 300));
  return { ok: false, fallback: true };
}

/** Export PDF de secours : impression de l'aperçu affiché par la page (sans Word). */
async function printPdf(id) {
  const r = recentById(id);
  if (!mainWindow) throw new Error('Fenêtre fermée.');
  const data = await mainWindow.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true });
  const out = pdfTarget(r);
  try {
    await writeAtomic(out, data);
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) throw new Error(`Le PDF « ${path.basename(out)} » est ouvert dans un autre programme : fermez-le puis recommencez.`);
    throw err;
  }
  return { ok: true, file: out, by: 'apercu' };
}

async function chooseOutDir() {
  const res = await dialog.showOpenDialog(mainWindow, { title: 'Dossier des fiches', defaultPath: outDir(), properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  settings.outDir = res.filePaths[0];
  await saveSettings();
  return { ok: true, dir: settings.outDir };
}

/** Référence de dossier du jour : INT-AAAAMMJJ-01, -02… */
async function nextRef() {
  const now = new Date();
  const day = Fields.isoToday(now);
  settings.ref = settings.ref.day === day ? { day, n: settings.ref.n + 1 } : { day, n: 1 };
  await saveSettings();
  return { ok: true, ref: Fields.makeRef(now, settings.ref.n) };
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
    nativeTheme.themeSource = mode;
    await saveSettings();
    return { ok: true, mode };
  });
  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, dev: !app.isPackaged, outDir: outDir(), word: await hasWord() }));
  handle('models:list', () => listModels());
  handle('models:get', async (id) => {
    const m = await describeModel(String(id));
    return { ok: true, model: m };
  });
  handle('models:bytes', async (id) => {
    const buf = await fsp.readFile(modelPath(String(id)));
    return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
  handle('models:import', () => importModel());
  handle('models:remove', (id) => removeModel(String(id)));
  handle('fiche:generate', (modelId, values, replace) => generate(String(modelId), values, replace ? String(replace) : null));
  handle('fiche:recent', () => listRecent());
  handle('fiche:read', (id) => readRecent(String(id)));
  handle('fiche:forget', (id) => forgetRecent(String(id)));
  handle('fiche:open', async (id) => {
    const error = await shell.openPath(recentById(String(id)).file);
    return error ? { ok: false, error: `Ouverture impossible : ${error}` } : { ok: true };
  });
  handle('fiche:show', async (id) => {
    shell.showItemInFolder(recentById(String(id)).file);
    return { ok: true };
  });
  handle('fiche:pdf', (id) => exportPdf(String(id)));
  handle('fiche:print-pdf', (id) => printPdf(String(id)));
  handle('fiche:open-pdf', async (file) => {
    // Seulement un PDF exporté d'une fiche récente
    const r = settings.recent.find((x) => pdfTarget(x) === file);
    if (!r) throw new Error('Fichier inconnu.');
    const error = await shell.openPath(file);
    return error ? { ok: false, error } : { ok: true };
  });
  handle('settings:out-dir', () => chooseOutDir());
  handle('settings:open-out-dir', async () => {
    await fsp.mkdir(outDir(), { recursive: true });
    const error = await shell.openPath(outDir());
    return error ? { ok: false, error } : { ok: true };
  });
  handle('ref:next', () => nextRef());
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
const LOAD_STEPS = 3; // préférences, modèles, interface

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
    title: 'FichInter',
    icon: ICON_FILE,
    webPreferences: { preload: path.join(__dirname, 'preload-splash.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: false },
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
    width: 1260,
    height: 840,
    minWidth: 860,
    minHeight: 580,
    show: false,
    title: 'FichInter',
    icon: ICON_FILE,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1320' : '#f3f6fb',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: true, devTools: !app.isPackaged },
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
    // Hors ligne garanti : toute requête réseau sortante est annulée
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    try {
      session.defaultSession.setSpellCheckerLanguages(['fr']); // sans effet sous macOS (correcteur du système)
    } catch {
      // langue indisponible : correcteur par défaut
    }
    if (app.isPackaged) Menu.setApplicationMenu(null);
    registerIpc();
    await loadSettings();
    nativeTheme.themeSource = settings.theme;
    const splashShown = createSplash();
    splashProgress(1, 'Lecture des modèles…');
    await listModels().catch(() => []); // analyse des modèles en avance (cache)
    splashProgress(2, 'Préparation de l\'interface…');
    const mainPainted = createWindow({ deferShow: true });
    revealMainWhenReady(splashShown, mainPainted);
    hasWord(); // détection de Word en arrière-plan (export PDF)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
