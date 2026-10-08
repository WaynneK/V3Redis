/*
 * main.js — Processus principal d'Agépédé.
 *
 * Agépédé construit, à partir de tableaux (OU, groupes globaux, groupes domaine local, permissions), le script
 * CMD qui crée la structure AGDLP dans Active Directory (dsadd / dsmod / dsquery / icacls), puis peut l'exécuter.
 *
 * Rôle de ce processus : fenêtres, fichiers (projet, CSV, script .bat, journal), détection de l'environnement
 * et exécution. Garanties :
 *  - aucune requête réseau depuis la page (CSP, navigation et permissions bloquées, requêtes http(s) annulées) ;
 *  - l'exécution ne fait jamais confiance aux commandes envoyées par la page : la page envoie le PROJET, ce
 *    processus le revalide (Agdlp.validateProject) et régénère lui-même les étapes (Agdlp.plan), qui sont
 *    exactement celles du script affiché ; refus s'il reste une erreur ;
 *  - confirmation native (domaine + nombre d'objets) avant toute exécution réelle ; une seule exécution à la fois ;
 *  - l'exécution passe uniquement par lib/runner.js (aucune commande lancée ici) ;
 *  - écriture atomique des fichiers (temporaire + renommage) ; un fichier existant n'est remplacé que s'il a été
 *    choisi dans une boîte de dialogue pendant cette session.
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, nativeTheme, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
const Agdlp = require('./lib/agdlp.js');
const Runner = require('./lib/runner.js');
const Elevation = require('./lib/elevation.js');
const crypto = require('node:crypto');

const IS_WIN = process.platform === 'win32';
const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');
const ICON_FILE = path.join(__dirname, 'renderer', 'assets', 'icon.png');
const PROJECT_EXT = '.agepede.json';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Mode de test réservé au développement : exécution simulée (aucune commande lancée), jamais dans l'application installée
const FAKE_RUN = !app.isPackaged && process.env.AGEPEDE_FAKE_RUN === '1';

let mainWindow = null;

// ---------------------------------------------------------------------------
// Préférences (dernier dossier utilisé, démarrage en administrateur)
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { lastDir: null, alwaysAdmin: false };

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'));
    if (typeof parsed.lastDir === 'string') settings.lastDir = parsed.lastDir;
    if (typeof parsed.alwaysAdmin === 'boolean') settings.alwaysAdmin = parsed.alwaysAdmin;
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
    .catch((err) => console.warn('[agepede] préférences non enregistrées :', err.message));
  return saveChain;
}

// ---------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').trim() || 'agepede';
const BOM = '\uFEFF';

// Fichiers choisis dans une boîte de dialogue (ou écrits) pendant cette session : seuls ceux-là peuvent être
// réécrits sans redemander, ou montrés dans l'explorateur
const knownFiles = new Set();
const keyOf = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const remember = (p) => knownFiles.add(keyOf(p));
const isKnown = (p) => typeof p === 'string' && p.length > 0 && knownFiles.has(keyOf(p));

function defaultDir() {
  return settings.lastDir && fs.existsSync(settings.lastDir) ? settings.lastDir : app.getPath('documents');
}

async function askSavePath({ title, defaultName, defaultPath, filters }) {
  const res = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: defaultPath || path.join(defaultDir(), safeName(defaultName)),
    filters,
  });
  if (res.canceled || !res.filePath) return null;
  settings.lastDir = path.dirname(res.filePath);
  saveSettings();
  remember(res.filePath);
  return res.filePath;
}

async function askOpenPath({ title, filters }) {
  const res = await dialog.showOpenDialog(mainWindow, { title, defaultPath: defaultDir(), filters, properties: ['openFile'] });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
  settings.lastDir = path.dirname(res.filePaths[0]);
  saveSettings();
  return res.filePaths[0];
}

/** Écriture atomique : fichier temporaire puis renommage (jamais de fichier à moitié écrit). */
async function writeFileSafe(filePath, content) {
  const tmp = `${filePath}.${process.pid}.agepede-tmp`;
  try {
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
      throw new Error('Le fichier est ouvert dans un autre logiciel ou protégé en écriture : fermez-le ou choisissez un autre nom.');
    }
    throw err;
  }
  remember(filePath);
}

async function readTextFile(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error('Fichier trop volumineux (20 Mo au maximum).');
  const buf = await fsp.readFile(filePath);
  // UTF-8 (avec ou sans BOM) ; à défaut Windows-1252, l'encodage des CSV enregistrés par Excel en français
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  return text.replace(/^\uFEFF/, '');
}

const withCrlf = (text) => String(text).replace(/\r?\n/g, '\r\n');

// ---------------------------------------------------------------------------
// Projet
// ---------------------------------------------------------------------------

function cleanProject(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Projet invalide.');
  return Agdlp.normalizeProject(obj);
}

function projectBaseName(filePath) {
  const base = path.basename(filePath);
  return base.toLowerCase().endsWith(PROJECT_EXT) ? base.slice(0, -PROJECT_EXT.length) : base.replace(/\.json$/i, '');
}

async function openProject() {
  const filePath = await askOpenPath({
    title: 'Ouvrir un projet Agépédé',
    filters: [
      { name: 'Projet Agépédé', extensions: ['agepede.json', 'json'] },
      { name: 'Tous les fichiers', extensions: ['*'] },
    ],
  });
  if (!filePath) return { ok: false, canceled: true };
  let parsed;
  try {
    parsed = JSON.parse(await readTextFile(filePath));
  } catch (err) {
    return { ok: false, error: `Fichier illisible : ${err.message}` };
  }
  const project = cleanProject(parsed);
  remember(filePath);
  return { ok: true, project, filePath, name: projectBaseName(filePath) };
}

async function saveProject(req) {
  const project = cleanProject(req && req.project);
  let filePath = req && !req.saveAs && isKnown(req.filePath) ? req.filePath : null;
  if (!filePath) {
    const suggested = req && typeof req.filePath === 'string' && req.filePath ? req.filePath : null;
    filePath = await askSavePath({
      title: 'Enregistrer le projet',
      defaultName: `${safeName((req && req.name) || (project.domain && project.domain.dns) || 'projet')}${PROJECT_EXT}`,
      defaultPath: suggested && path.isAbsolute(suggested) ? suggested : undefined,
      filters: [{ name: 'Projet Agépédé', extensions: ['agepede.json'] }],
    });
    if (!filePath) return { ok: false, canceled: true };
  }
  if (!/\.json$/i.test(filePath)) filePath += PROJECT_EXT;
  await writeFileSafe(filePath, `${JSON.stringify(project, null, 2)}\n`);
  return { ok: true, filePath, name: projectBaseName(filePath) };
}

// ---------------------------------------------------------------------------
// CSV, script, journal
// ---------------------------------------------------------------------------

const TABLE_NAMES = { ous: 'OU', globals: 'Groupes-globaux', locals: 'Groupes-domaine-local', permissions: 'Permissions' };

async function importCsv(table) {
  if (!TABLE_NAMES[table]) throw new Error('Tableau inconnu.');
  const filePath = await askOpenPath({
    title: 'Importer un fichier CSV',
    filters: [
      { name: 'CSV ou texte', extensions: ['csv', 'txt', 'tsv'] },
      { name: 'Tous les fichiers', extensions: ['*'] },
    ],
  });
  if (!filePath) return { ok: false, canceled: true };
  const text = await readTextFile(filePath);
  return { ok: true, text, fileName: path.basename(filePath) };
}

async function exportCsv(req) {
  const table = req && req.table;
  if (!TABLE_NAMES[table]) throw new Error('Tableau inconnu.');
  const text = String((req && req.text) || '');
  if (text.length > MAX_FILE_BYTES) throw new Error('Contenu trop volumineux.');
  const filePath = await askSavePath({
    title: 'Exporter en CSV',
    defaultName: `${safeName(req.name || 'agepede')}_${TABLE_NAMES[table]}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return { ok: false, canceled: true };
  // BOM : Excel reconnaît l'UTF-8 et affiche correctement les accents
  await writeFileSafe(filePath, BOM + withCrlf(text.replace(/^\uFEFF/, '')));
  return { ok: true, filePath };
}

/** Script .bat régénéré ici à partir du projet (mêmes fonctions et mêmes options que l'aperçu). */
function buildScript(project, opts) {
  const steps = Agdlp.plan(project);
  const o = opts && typeof opts === 'object' ? opts : {};
  return Agdlp.toBatch(steps, {
    title: String(o.title || 'Agépédé').slice(0, 200),
    domain: project.domain && project.domain.dns,
    date: String(o.date || new Date().toLocaleString('fr-FR')).slice(0, 100),
  });
}

async function exportScript(req) {
  const project = cleanProject(req && req.project);
  const { errors } = Agdlp.validateProject(project);
  if (errors && errors.length) return { ok: false, error: `Le projet contient ${errors.length} erreur(s) : corrigez-les avant d'exporter le script.` };
  const text = buildScript(project, req && req.options);
  const filePath = await askSavePath({
    title: 'Exporter le script',
    defaultName: `${safeName((req && req.name) || (project.domain && project.domain.dns) || 'agepede')}.bat`,
    filters: [{ name: 'Script de commandes', extensions: ['bat', 'cmd'] }],
  });
  if (!filePath) return { ok: false, canceled: true };
  // UTF-8 SANS BOM (un BOM serait lu par cmd.exe comme une commande) ; fins de ligne CRLF déjà dans le texte
  await writeFileSafe(filePath, Buffer.from(String(text).replace(/^\uFEFF/, ''), 'utf8'));
  return { ok: true, filePath };
}

async function exportLog(req) {
  const text = String((req && req.text) || '');
  if (!text) return { ok: false, error: 'Journal vide.' };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const filePath = await askSavePath({
    title: 'Exporter le journal',
    defaultName: `Agepede_journal_${stamp}.txt`,
    filters: [{ name: 'Texte', extensions: ['txt'] }],
  });
  if (!filePath) return { ok: false, canceled: true };
  await writeFileSafe(filePath, BOM + withCrlf(text)); // BOM : accents lisibles dans le Bloc-notes
  return { ok: true, filePath };
}

// ---------------------------------------------------------------------------
// Environnement et exécution
// ---------------------------------------------------------------------------

const FAKE_ENV = {
  platform: 'win32',
  isWindows: true,
  isServer: true,
  tools: { dsadd: true, dsmod: true, dsquery: true, dsget: true, icacls: true },
  isAdmin: true,
  domain: { dns: 'lab.local', netbios: 'LAB', dn: 'DC=lab,DC=local' },
  joined: true,
  fake: true,
};

let lastEnv = null;

async function detectEnv() {
  if (FAKE_RUN) {
    lastEnv = { ...FAKE_ENV };
    return lastEnv;
  }
  try {
    const env = await Runner.detectEnvironment();
    lastEnv = { ...env, fake: false };
  } catch (err) {
    lastEnv = { platform: process.platform, isWindows: IS_WIN, isServer: false, tools: {}, isAdmin: false, domain: null, joined: false, error: err.message, fake: false };
  }
  return lastEnv;
}

/**
 * Lanceur fictif pour le mode de test (développement uniquement, AGEPEDE_FAKE_RUN=1 hors application installée).
 * Il est injecté dans Runner.runSteps (option `run`) : le vrai enchaînement (tests d'existence, dépendances,
 * annulation, classement des résultats) est utilisé, mais AUCUNE commande n'est lancée.
 * Résultats : un test d'existence sur quatre répond « existe » ; la 3e commande de création échoue.
 */
function makeFakeRun() {
  let checks = 0;
  let commands = 0;
  return (line, { signal } = {}) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (/^if exist /i.test(line)) {
          resolve({ exitCode: 1, stdout: '', output: '' }); // test d'existence d'un dossier : absent
          return;
        }
        // Recherche d'un membre par son identifiant (faite par lib/runner.js avant dsmod) : trouvé
        const lookup = /^dsquery (user|group) -samid "?([^"\s]+)"? -limit 1$/.exec(line);
        if (lookup) {
          const dn = `"CN=${lookup[2]} (MODE TEST),CN=Users,DC=lab,DC=local"\r\n`;
          resolve({ exitCode: 0, stdout: dn, output: dn });
          return;
        }
        const isCheck = /\|\s*findstr\s+"="\s*$/.test(line) && !/\bdsmod\b|\bdsadd\b|\bicacls\b|\bmkdir\b/.test(line);
        if (isCheck) {
          checks += 1;
          if (checks % 4 === 2) resolve({ exitCode: 0, stdout: '"CN=existant (MODE TEST)"\r\n', output: '"CN=existant (MODE TEST)"\r\n' });
          else resolve({ exitCode: 1, stdout: '', output: '' });
          return;
        }
        commands += 1;
        if (commands === 3) {
          const out = "dsadd a échoué :0x80072030:Il n'existe pas d'objet de ce type sur le serveur. (MODE TEST)\r\n";
          resolve({ exitCode: 0x80072030 | 0, stdout: '', output: out });
        } else resolve({ exitCode: 0, stdout: 'réussite (MODE TEST)\r\n', output: 'réussite (MODE TEST)\r\n' });
      }, 80);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve({ exitCode: null, output: 'Commande annulée.', aborted: true });
          },
          { once: true }
        );
      }
    });
}

let currentRun = null; // { controller }

function sendRun(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('run:progress', payload);
}

function countSteps(steps) {
  const c = { ou: 0, group: 0, member: 0, folder: 0, acl: 0 };
  for (const s of steps) if (Object.prototype.hasOwnProperty.call(c, s.kind)) c[s.kind] += 1;
  return c;
}

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

async function startRun(req) {
  if (currentRun) return { ok: false, error: 'Une exécution est déjà en cours.' };
  const dryRun = Boolean(req && req.dryRun);
  const project = cleanProject(req && req.project);
  const { errors } = Agdlp.validateProject(project);
  if (errors && errors.length) return { ok: false, error: `Le projet contient ${errors.length} erreur(s) : exécution refusée.` };
  const steps = Agdlp.plan(project);
  if (!steps.length) return { ok: false, error: 'Rien à faire : les tableaux sont vides.' };

  // Contrôle de l'environnement au moment de l'exécution (pas seulement celui affiché par la page)
  const env = await detectEnv();
  const counts = countSteps(steps);
  if (!env.fake) {
    if (!env.isWindows) return { ok: false, error: "L'exécution n'est possible que sous Windows (contrôleur de domaine ou poste avec RSAT)." };
    if (!env.tools || !env.tools.dsadd || !env.tools.dsquery || !env.tools.dsmod) return { ok: false, error: 'Outils Active Directory introuvables (dsadd, dsmod, dsquery) : installez RSAT « Outils AD DS » ou lancez Agépédé sur un contrôleur de domaine.' };
    if ((counts.acl > 0 || counts.folder > 0) && !(env.tools && env.tools.icacls)) return { ok: false, error: 'icacls introuvable : impossible d\'appliquer les permissions.' };
  }

  if (!dryRun) {
    const dns = (project.domain && project.domain.dns) || '?';
    const dn = (project.domain && project.domain.dn) || '';
    const parts = [plural(counts.ou, 'OU', 'OU'), plural(counts.group, 'groupe', 'groupes'), plural(counts.member, 'appartenance', 'appartenances'), plural(counts.acl, 'permission', 'permissions')];
    if (counts.folder) parts.push(plural(counts.folder, 'dossier', 'dossiers'));
    const warnings = [];
    if (env.domain && env.domain.dns && String(env.domain.dns).toLowerCase() !== String(dns).toLowerCase()) {
      warnings.push(`Attention : cette machine appartient au domaine ${env.domain.dns}, le projet vise ${dns}.`);
    }
    if (!env.isAdmin) warnings.push("Attention : Agépédé n'est pas lancé en administrateur.");
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Exécuter sur Active Directory',
      message: `Créer dans le domaine ${dns} ?`,
      detail: [
        dn ? `Domaine : ${dns} (${dn})` : `Domaine : ${dns}`,
        `${parts.join(', ')} — ${plural(steps.length, 'commande', 'commandes')}.`,
        '',
        'Les commandes exécutées sont exactement celles du script affiché. Les objets déjà existants sont laissés tels quels ; rien n\'est jamais supprimé.',
        ...(warnings.length ? ['', ...warnings] : []),
        ...(env.fake ? ['', 'MODE TEST : exécution simulée, aucune commande ne sera lancée.'] : []),
      ].join('\n'),
      buttons: ['Exécuter', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (res.response !== 0) return { ok: false, canceled: true };
  }

  const controller = new AbortController();
  currentRun = { controller };
  const started = Date.now();
  sendRun({
    type: 'start',
    dryRun,
    fake: Boolean(env.fake),
    total: steps.length,
    steps: steps.map((s) => ({ id: s.id, kind: s.kind, table: s.table, rowId: s.rowId, label: s.label, command: s.command })),
  });
  try {
    const summary = await Runner.runSteps(steps, {
      dryRun,
      signal: controller.signal,
      ...(env.fake ? { run: makeFakeRun(), platform: 'win32' } : {}),
      onStep: (info) => {
        if (!info) return;
        sendRun({
          type: 'step',
          index: info.index,
          total: info.total,
          status: info.status,
          message: info.message == null ? '' : String(info.message),
          output: info.output == null ? '' : String(info.output).slice(0, 20000),
          durationMs: info.durationMs,
        });
      },
    });
    const result = { ...(summary || {}), cancelled: Boolean((summary && summary.cancelled) || controller.signal.aborted), durationMs: Date.now() - started };
    sendRun({ type: 'end', dryRun, summary: result });
    return { ok: true, dryRun, summary: result };
  } catch (err) {
    sendRun({ type: 'end', dryRun, error: err.message });
    throw err;
  } finally {
    currentRun = null;
  }
}

// ---------------------------------------------------------------------------
// Administrateur : relance élevée (fenêtre UAC) et reprise du projet en cours
// ---------------------------------------------------------------------------

let handoff = null; // projet transmis par l'instance précédente (lu une seule fois par la page)
let startupNote = null; // message à afficher par la page au démarrage (ex. élévation refusée)

/**
 * Relance Agépédé en administrateur puis ferme cette instance. Le verrou d'instance unique est libéré avant :
 * sinon la nouvelle instance se fermerait aussitôt. En cas de refus (UAC) ou d'échec, tout est remis en place.
 * current : { project, filePath, name, dirty } à reprendre dans la nouvelle instance (facultatif).
 */
async function relaunchAsAdmin(current) {
  if (!IS_WIN) return { ok: false, error: 'Disponible uniquement sous Windows.' };
  if (FAKE_RUN) return { ok: false, error: 'Indisponible en mode test (exécution simulée).' };
  if (currentRun) return { ok: false, error: 'Une exécution est en cours : attendez la fin avant de relancer.' };
  let handoffFile = null;
  if (current && current.project) {
    handoffFile = Elevation.handoffPath(app.getPath('temp'), crypto.randomBytes(12).toString('hex'));
    const data = {
      project: cleanProject(current.project),
      filePath: typeof current.filePath === 'string' ? current.filePath : null,
      name: typeof current.name === 'string' ? current.name.slice(0, 200) : '',
      dirty: Boolean(current.dirty),
    };
    await fsp.writeFile(handoffFile, JSON.stringify(data), 'utf8');
  }
  const cmd = Elevation.relaunchCommand({
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    dev: process.argv.includes('--dev'),
    handoffFile,
  });
  app.releaseSingleInstanceLock();
  const res = await Elevation.relaunchElevated(cmd);
  if (!res.ok) {
    if (handoffFile) await fsp.unlink(handoffFile).catch(() => {});
    app.requestSingleInstanceLock();
    return res;
  }
  // La nouvelle instance (administrateur) a démarré et reprend le projet : fermeture sans question
  forceClose = true;
  setTimeout(() => app.quit(), 100);
  return { ok: true };
}

/** Projet transmis par l'instance précédente : lu, vérifié puis supprimé. */
async function readHandoff() {
  const file = Elevation.handoffFromArgv(process.argv, app.getPath('temp'));
  if (!file) return;
  try {
    const data = JSON.parse(await readTextFile(file));
    handoff = {
      project: cleanProject(data.project),
      filePath: typeof data.filePath === 'string' && data.filePath ? data.filePath : null,
      name: typeof data.name === 'string' ? data.name : '',
      dirty: Boolean(data.dirty),
    };
    // Fichier choisi par l'utilisateur dans l'instance précédente : « Enregistrer » le réécrit sans redemander
    if (handoff.filePath && fs.existsSync(handoff.filePath)) remember(handoff.filePath);
  } catch (err) {
    console.warn('[agepede] projet transmis illisible :', err.message);
  } finally {
    await fsp.unlink(file).catch(() => {});
  }
}

/**
 * Option « Toujours démarrer en administrateur » : au lancement sans droits, demande l'élévation.
 * Renvoie true si une instance élevée a démarré (celle-ci doit alors se fermer).
 */
async function autoElevate() {
  if (!IS_WIN || FAKE_RUN || !settings.alwaysAdmin || process.argv.some((a) => a.startsWith(Elevation.HANDOFF_ARG))) return false;
  if (await Elevation.isElevated()) return false;
  const res = await relaunchAsAdmin(null);
  if (res.ok) return true;
  startupNote = res.canceled
    ? { kind: 'warn', text: 'Élévation refusée : Agépédé fonctionne sans droits administrateur.' }
    : { kind: 'error', text: `Relance en administrateur impossible : ${res.error}` };
  return false;
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

let dirty = false;
let forceClose = false;

function registerIpc() {
  handle('env:detect', () => detectEnv());
  handle('project:open', () => openProject());
  handle('project:save', (req) => saveProject(req || {}));
  handle('csv:import', (table) => importCsv(String(table || '')));
  handle('csv:export', (req) => exportCsv(req || {}));
  handle('script:export', (req) => exportScript(req || {}));
  handle('log:export', (req) => exportLog(req || {}));
  handle('run:start', (req) => startRun(req || {}));
  handle('run:cancel', async () => {
    if (currentRun) currentRun.controller.abort();
    return { ok: true };
  });
  handle('file:show', async (filePath) => {
    if (!isKnown(filePath) || !fs.existsSync(filePath)) return { ok: false };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });
  handle('clipboard:write', async (text) => {
    await clipboard.writeText(String(text || '').slice(0, 5_000_000));
    return { ok: true };
  });
  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, fakeRun: FAKE_RUN, packaged: app.isPackaged }));
  handle('admin:relaunch', (current) => relaunchAsAdmin(current && typeof current === 'object' ? current : null));
  handle('admin:getAlways', async () => ({ ok: true, value: settings.alwaysAdmin }));
  handle('admin:setAlways', async (value) => {
    settings.alwaysAdmin = Boolean(value);
    await saveSettings();
    return { ok: true, value: settings.alwaysAdmin };
  });
  // Projet repris après une relance et message de démarrage : remis une seule fois
  handle('app:takeStartup', async () => {
    const out = { handoff, note: startupNote };
    handoff = null;
    startupNote = null;
    return out;
  });
  handle('app:close', async () => {
    forceClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return { ok: true };
  });
  ipcMain.on('app:dirty', (event, value) => {
    if (isTrustedSender(event)) dirty = Boolean(value);
  });
  // L'interface a construit sa première vue : l'écran de démarrage peut laisser la place
  ipcMain.on('app:ui-ready', (event) => {
    if (isTrustedSender(event)) resolveUiReady();
  });
}

/** Fermeture : modifications non enregistrées ou exécution en cours → confirmation. */
async function onCloseRequested(event) {
  if (forceClose) return;
  if (!dirty && !currentRun) return;
  event.preventDefault();
  const win = mainWindow;
  if (currentRun) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Agépédé',
      message: 'Une exécution est en cours.',
      detail: 'Arrêter maintenant ? Les commandes déjà exécutées ne sont pas annulées.',
      buttons: ['Arrêter et quitter', 'Continuer'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (r.response !== 0) return;
    if (currentRun) currentRun.controller.abort();
    if (!dirty) {
      forceClose = true;
      if (win && !win.isDestroyed()) win.close();
      return;
    }
  }
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Agépédé',
    message: 'Enregistrer les modifications du projet ?',
    detail: 'Vos modifications seront perdues si vous ne les enregistrez pas.',
    buttons: ['Enregistrer', 'Ne pas enregistrer', 'Annuler'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (!win || win.isDestroyed()) return;
  if (r.response === 0) {
    // La page enregistre (boîte de dialogue si besoin) puis demande la fermeture (app:close)
    win.webContents.send('app:save-then-close');
  } else if (r.response === 1) {
    forceClose = true;
    win.webContents.send('app:discard-draft');
    setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, 80);
  }
}

// ---------------------------------------------------------------------------
// Écran de démarrage : petite fenêtre animée pendant le chargement, puis fenêtre principale
// ---------------------------------------------------------------------------

const SPLASH_FILE = path.join(__dirname, 'renderer', 'splash.html');
const SPLASH_MIN_MS = 2400; // laisse l'animation (logo → montée → nom → progression) se jouer en entier
const SPLASH_MAX_MS = 15000; // sécurité : la fenêtre principale s'ouvre quoi qu'il arrive
const SPLASH_OUT_MS = 230; // durée de l'animation de sortie de l'écran de démarrage
const LOAD_STEPS = 3; // préférences, moteur AGDLP, interface

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
 * Vérification du moteur au démarrage : un petit projet connu doit donner les bonnes étapes (OU, groupes,
 * appartenances, permission) et un nom invalide doit être signalé. Un écart est journalisé : il signalerait
 * un fichier lib/agdlp.js endommagé.
 */
function selfTestEngine() {
  try {
    const p = Agdlp.normalizeProject({
      version: 1,
      domain: { dns: 'lab.local', dn: 'DC=lab,DC=local', netbios: 'LAB' },
      options: { createFolders: false },
      ous: [{ name: 'Paris', parent: '', description: '' }],
      globals: [{ name: 'GG_Compta', ou: 'Paris', description: '', members: 'jdupont' }],
      locals: [{ name: 'DL_Compta_RW', ou: 'Paris', description: '', members: 'GG_Compta' }],
      permissions: [{ path: 'D:\\Partages\\Compta', group: 'DL_Compta_RW', right: 'RW' }],
    });
    const checks = [];
    checks.push(Agdlp.domainToDn('lab.local') === 'DC=lab,DC=local');
    checks.push(Agdlp.validateProject(p).errors.length === 0);
    const steps = Agdlp.plan(p);
    const kinds = new Set(steps.map((s) => s.kind));
    checks.push(['ou', 'group', 'member', 'acl'].every((k) => kinds.has(k)));
    checks.push(steps.some((s) => /dsadd\s+ou/i.test(s.command) && /OU=Paris,DC=lab,DC=local/i.test(s.command)));
    checks.push(steps.every((s) => !/\bds(rm|move)\b/i.test(s.command))); // jamais de suppression
    checks.push(/\r\n/.test(Agdlp.toBatch(steps, { title: 'test', domain: 'lab.local', date: '' })));
    const bad = Agdlp.normalizeProject({ ...p, globals: [{ name: 'GG,bad"', ou: '', description: '', members: '' }] });
    checks.push(Agdlp.validateProject(bad).errors.length > 0);
    const ok = checks.every(Boolean);
    if (!ok) console.error('[agepede] vérification du moteur AGDLP : résultats inattendus', checks);
    return ok;
  } catch (err) {
    console.error('[agepede] vérification du moteur AGDLP impossible :', err);
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
    title: 'Agépédé',
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
  forceClose = false;
  dirty = false;
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Agépédé',
    icon: ICON_FILE,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1d' : '#f6f6f4',
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
  mainWindow.on('close', (event) => {
    onCloseRequested(event).catch((err) => console.error('[agepede] fermeture :', err));
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (currentRun) currentRun.controller.abort();
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
    // Aucune requête réseau depuis les pages (seuls les fichiers locaux passent)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (app.isPackaged) Menu.setApplicationMenu(null);
    nativeTheme.themeSource = 'system'; // le thème suit Windows (clair / sombre)
    registerIpc();
    await loadSettings();
    // « Toujours démarrer en administrateur » : la fenêtre UAC passe avant l'écran de démarrage
    if (await autoElevate()) return;
    await readHandoff();
    splashProgress(0, 'Chargement des préférences…');
    const splashShown = createSplash();
    splashProgress(1, 'Vérification du moteur AGDLP…');
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
