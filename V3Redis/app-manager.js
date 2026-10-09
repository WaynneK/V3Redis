/*
 * app-manager.js — Installer / désinstaller une application livrée avec V3Redis, depuis le HUB (Windows).
 *
 * Installer : liste des paquets de la release de cette version (app-packs.js) → téléchargement du .zip de
 * l'application (progression, annulation) → taille et empreinte SHA-512 vérifiées → extraction (tar.exe de
 * Windows) dans resources/apps/.<id>.partial → contrôle de l'exécutable → renommage en resources/apps/<id>.
 * Puis choix « 1 » dans le registre et raccourci du menu Démarrer (comme l'installeur).
 * Désinstaller : refusé si l'application est ouverte ; dossier renommé puis supprimé, choix « 0 », raccourci retiré.
 *
 * En développement (npm start), HUB_BUNDLE_DIR et V3REDIS_APPS_URL permettent de tout tester localement ;
 * le registre et le menu Démarrer ne sont alors pas touchés.
 */
'use strict';

const { app, net, shell } = require('electron');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
// fs « brut » d'Electron : le fs habituel traite les fichiers .asar comme des dossiers, ce qui ferait échouer la
// suppression ou le déplacement du dossier d'une application (qui contient resources/app.asar)
const fs = require('original-fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const Packs = require('./app-packs.js');

const IS_WIN = process.platform === 'win32';

/**
 * options : { bundleRoot, product, owner, repo, version, launchable(path) → Promise<bool>,
 *             relPath(entry) → chemin de l'exécutable dans le dossier de l'application }
 */
function createManager(options) {
  const o = options;
  let current = null; // { id, controller }

  const supported = () => IS_WIN && Boolean(o.bundleRoot) && (app.isPackaged || Boolean(process.env.HUB_BUNDLE_DIR));
  const base = () => Packs.releaseBase({ owner: o.owner, repo: o.repo, version: o.version, override: app.isPackaged ? null : process.env.V3REDIS_APPS_URL });
  const shortcutPath = (entry) => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', o.product, `${entry.name}.lnk`);

  function run(cmd, args, timeout = 15 * 60 * 1000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
    });
  }

  /** Choix mémorisé pour l'installeur (registre) et raccourci du menu Démarrer : seulement dans V3Redis installé. */
  async function remember(entry, installed) {
    if (!app.isPackaged) return;
    await run('reg', ['add', `HKCU\\${Packs.REG_KEY}`, '/v', entry.id, '/t', 'REG_SZ', '/d', installed ? '1' : '0', '/f'], 10000);
    const lnk = shortcutPath(entry);
    if (installed) {
      await fsp.mkdir(path.dirname(lnk), { recursive: true }).catch(() => {});
      shell.writeShortcutLink(lnk, 'create', { target: path.join(o.bundleRoot, entry.id, o.relPath(entry)), description: entry.name });
    } else {
      await fsp.rm(lnk, { force: true }).catch(() => {});
    }
  }

  async function fetchJson(url, signal) {
    const res = await net.fetch(url, { signal });
    if (!res.ok) throw new Error(res.status === 404 ? 'paquets des applications introuvables dans cette release' : `erreur ${res.status}`);
    return res.json();
  }

  /** Téléchargement en flux vers un fichier, avec progression et empreinte SHA-512 calculée au passage. */
  async function download(url, file, size, signal, onProgress) {
    const res = await net.fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(res.status === 404 ? 'paquet introuvable dans la release' : `téléchargement refusé (erreur ${res.status})`);
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    let received = 0;
    let lastSent = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > size) throw new Error('paquet plus gros que prévu');
        hash.update(value);
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (now - lastSent > 200) {
          lastSent = now;
          onProgress({ phase: 'download', received, total: size });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    onProgress({ phase: 'download', received, total: size });
    return { received, sha512: hash.digest('base64') };
  }

  /** Extraction du .zip : tar.exe (Windows 10 1803 et plus), sinon PowerShell Expand-Archive. */
  async function extract(zip, dir) {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(tar)) {
      const r = await run(tar, ['-xf', zip, '-C', dir]);
      if (r.ok) return;
    }
    const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dir)} -Force`]);
    if (!r.ok) throw new Error(`extraction impossible (${r.err.trim().split(/\r?\n/)[0] || 'erreur inconnue'})`);
  }

  /** Octets déjà écrits dans un dossier (avancement de l'extraction). */
  async function dirBytes(dir) {
    let total = 0;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirBytes(p);
      else total += await fsp.lstat(p).then((s) => s.size, () => 0);
    }
    return total;
  }

  /**
   * Installation en arrière-plan : le HUB reste utilisable pendant ce temps (et, s'il est fermé ou qu'une autre
   * application est lancée, il attend caché la fin de l'installation : voir main.js). Chaque étape est diffusée
   * avec un avancement global « percent » (0 → 100, téléchargement puis extraction).
   */
  async function install(entry, onProgress = () => {}) {
    if (!supported()) return { ok: false, error: 'Disponible dans V3Redis installé sous Windows.' };
    if (current) return { ok: false, error: 'Une installation est déjà en cours.' };
    const controller = new AbortController();
    let markIdle;
    current = { id: entry.id, controller, idle: new Promise((r) => (markIdle = r)) };
    const target = path.join(o.bundleRoot, entry.id);
    const partial = path.join(o.bundleRoot, `.${entry.id}.partial`);
    const zip = path.join(os.tmpdir(), `v3redis-${entry.id}-${process.pid}-${Date.now()}.zip`);
    let unpacked = null;
    const report = (p) => {
      const info = { ...p, unpacked };
      current.last = info;
      onProgress({ ...info, percent: Packs.overallPercent(info) });
    };
    let poll = null;
    try {
      report({ phase: 'prepare' });
      const manifest = await fetchJson(base() + Packs.manifestFileName(o.product, o.version), controller.signal);
      const pack = Packs.findPack(manifest, entry.id, o.version);
      unpacked = pack.unpacked;
      report({ phase: 'download', received: 0, total: pack.size });
      const got = await download(base() + pack.file, zip, pack.size, controller.signal, report);
      if (got.received !== pack.size || got.sha512 !== pack.sha512) throw new Error('paquet corrompu (empreinte différente) : réessayez');
      await fsp.rm(partial, { recursive: true, force: true });
      await fsp.mkdir(partial, { recursive: true });
      report({ phase: 'extract', extracted: 0 });
      // tar ne donne pas d'avancement : la taille déjà extraite est mesurée régulièrement
      let extracting = true;
      poll = setInterval(async () => {
        if (!unpacked) return;
        const extracted = await dirBytes(partial);
        if (extracting && current) report({ phase: 'extract', extracted }); // pas de retour en arrière après la fin
      }, 400);
      await extract(zip, partial);
      extracting = false;
      clearInterval(poll);
      poll = null;
      report({ phase: 'finish' });
      if (!(await o.launchable(path.join(partial, o.relPath(entry))))) throw new Error('paquet incomplet (programme absent)');
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(partial, target);
      await remember(entry, true);
      report({ phase: 'done' });
      return { ok: true, version: pack.version };
    } catch (err) {
      const cancelled = controller.signal.aborted;
      report({ phase: cancelled ? 'cancelled' : 'error' });
      if (cancelled) return { ok: false, cancelled: true, error: 'Installation annulée.' };
      const why = String(err && err.message ? err.message : err).replace(/\.+$/, '');
      return { ok: false, error: `Installation de ${entry.name} impossible : ${why.charAt(0).toLowerCase()}${why.slice(1)}.` };
    } finally {
      if (poll) clearInterval(poll);
      current = null;
      await fsp.rm(zip, { force: true }).catch(() => {});
      await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
      markIdle();
    }
  }

  /** Fin de l'installation en cours (résolu tout de suite s'il n'y en a pas). */
  const whenIdle = () => (current ? current.idle : Promise.resolve());
  /** Dernier avancement de l'installation en cours : { id, phase, percent, … } ou null. */
  const progress = () => (current && current.last ? { id: current.id, ...current.last, percent: Packs.overallPercent(current.last) } : null);

  function cancel() {
    if (current) current.controller.abort();
    return { ok: Boolean(current) };
  }

  /** Désinstalle une application livrée (dossier resources/apps/<id>). runningExe(exe) → Promise<bool>. */
  async function uninstall(entry, runningExe) {
    if (!supported()) return { ok: false, error: 'Disponible dans V3Redis installé sous Windows.' };
    if (current) return { ok: false, error: 'Une installation est en cours.' };
    const target = path.join(o.bundleRoot, entry.id);
    if (!fs.existsSync(target)) return { ok: false, error: `${entry.name} n'est pas installé avec V3Redis.` };
    if (await runningExe(entry)) return { ok: false, error: `Fermez d'abord ${entry.name}.` };
    // Renommer d'abord : échoue tout de suite si un fichier est encore utilisé, sans laisser une moitié d'application
    const trash = path.join(o.bundleRoot, `.${entry.id}.removing-${Date.now()}`);
    try {
      await fsp.rename(target, trash);
    } catch {
      return { ok: false, error: `${entry.name} est encore utilisé : fermez-le puis réessayez.` };
    }
    await fsp.rm(trash, { recursive: true, force: true }).catch(() => {});
    await remember(entry, false);
    return { ok: true };
  }

  /** Restes d'une opération interrompue (V3Redis fermé en pleine installation) : .<id>.partial, .<id>.removing-… */
  async function cleanup() {
    if (!supported()) return;
    let names = [];
    try {
      names = await fsp.readdir(o.bundleRoot);
    } catch {
      return;
    }
    for (const n of names) {
      if (/^\.[\w-]+\.(partial|removing-\d+)$/.test(n)) await fsp.rm(path.join(o.bundleRoot, n), { recursive: true, force: true }).catch(() => {});
    }
  }

  return { supported, install, uninstall, cancel, cleanup, whenIdle, progress, busy: () => (current ? current.id : null) };
}

module.exports = { createManager };
