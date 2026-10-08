/*
 * runner.js — Exécution des étapes AGDLP par cmd.exe (processus principal Electron uniquement).
 *
 * Chaque étape produite par Agdlp.plan() est une ligne de commande cmd.exe complète
 * (dsadd, dsmod, dsquery, icacls…). Ce module :
 *   - détecte l'environnement (Windows, serveur, outils AD présents, administrateur, domaine) ;
 *   - lance une ligne dans « cmd.exe /d /s /c " … " » et récupère sa sortie (UTF-8, repli CP850) ;
 *   - enchaîne les étapes : test d'existence d'abord, mode simulation (aucune commande de
 *     création lancée), poursuite après erreur, annulation par AbortSignal.
 *
 * Les tests injectent un faux lanceur (options.run) : aucun outil ds* n'est jamais lancé par eux.
 */
'use strict';

const os = require('os');
const childProcess = require('child_process');
const Agdlp = require('./agdlp');

// ---------------------------------------------------------------------------
// Décodage de la sortie
// ---------------------------------------------------------------------------

/** Page de code OEM 850 (Europe de l'Ouest, console française) : caractères 0x80 à 0xFF. */
const CP850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '­±‗¾¶§÷¸°¨·¹³²■ ';

function decodeCp850(buf) {
  let out = '';
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : CP850_HIGH[b - 0x80];
  return out;
}

/**
 * Octets de sortie → texte. UTF-8 d'abord (chcp 65001) ; si le résultat contient des caractères
 * de remplacement (U+FFFD), l'outil a écrit dans la page OEM : décodage CP850.
 */
function decodeOutput(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!b.length) return '';
  const utf8 = b.toString('utf8');
  return utf8.includes('�') ? decodeCp850(b) : utf8;
}

// ---------------------------------------------------------------------------
// Lancement d'une ligne de commande
// ---------------------------------------------------------------------------

/** Termine le processus et tous ses enfants (dsquery lancé par for /f, etc.). */
function killTree(pid, spawn) {
  if (!pid) return;
  try {
    const k = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    if (k && typeof k.on === 'function') k.on('error', () => {});
  } catch (e) {
    /* processus déjà terminé */
  }
}

/**
 * Lance une ligne cmd.exe telle qu'on la taperait dans l'invite de commandes.
 * cmd /d (sans AutoRun) /s (guillemets externes retirés, le reste laissé tel quel) /c.
 * Ne rejette jamais : { exitCode, output, stdout, stderr, timedOut, aborted, durationMs }.
 * options.spawn (ou options.exec) : remplaçant de child_process.spawn pour les tests.
 */
function runCommand(line, options = {}) {
  const spawn = options.spawn || options.exec || childProcess.spawn;
  const timeoutMs = options.timeoutMs === undefined ? 60000 : options.timeoutMs;
  const signal = options.signal;
  const started = Date.now();
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let done = false;
    let timedOut = false;
    let aborted = false;
    let child;
    let timer = null;
    const finish = (exitCode, extra) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      const stdout = decodeOutput(Buffer.concat(out));
      let stderr = decodeOutput(Buffer.concat(err));
      if (extra) stderr += (stderr && !stderr.endsWith('\n') ? '\n' : '') + extra;
      const output = stdout + (stdout && stderr && !stdout.endsWith('\n') ? '\n' : '') + stderr;
      resolve({ exitCode, output, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    };
    const onAbort = () => {
      aborted = true;
      if (child) killTree(child.pid, spawn);
      finish(null, 'Commande annulée.');
    };
    if (signal && signal.aborted) {
      aborted = true;
      finish(null, 'Commande annulée.');
      return;
    }
    try {
      const comspec = process.env.ComSpec || 'cmd.exe';
      child = spawn(comspec, ['/d', '/s', '/c', `"chcp 65001>nul & ${line}"`], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(null, `Impossible de lancer cmd.exe : ${e.message}`);
      return;
    }
    if (child.stdout) child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    if (child.stderr) child.stderr.on('data', (d) => err.push(Buffer.from(d)));
    child.on('error', (e) => finish(null, `Impossible de lancer cmd.exe : ${e.message}`));
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid, spawn);
        finish(null, `Délai dépassé (${Math.round(timeoutMs / 1000)} s) : commande interrompue.`);
      }, timeoutMs);
    }
  });
}

// ---------------------------------------------------------------------------
// Environnement
// ---------------------------------------------------------------------------

const TOOLS = ['dsadd', 'dsmod', 'dsquery', 'dsget', 'icacls'];

/**
 * Détecte l'environnement. Ne lève jamais d'exception.
 * - outils : « where dsadd dsmod dsquery dsget icacls » (une seule commande, lecture seule) ;
 * - serveur : valeur InstallationType du registre (« Server », « Server Core » ou « Client ») ;
 * - administrateur : « whoami /groups » contient le SID S-1-5-32-544 (Administrateurs) et le
 *   niveau d'intégrité élevé S-1-16-12288 (ou système S-1-16-16384) — SID indépendants de la
 *   langue ; à défaut « net session » (réussit seulement en administrateur) ;
 * - domaine : USERDNSDOMAIN / USERDOMAIN ; DN lu par « dsquery * domainroot -scope base »
 *   si l'outil est présent, sinon déduit du nom DNS.
 * options : { run, exec (alias de run), env, platform, release }.
 */
async function detectEnvironment(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const run = options.run || options.exec || ((line) => runCommand(line, { timeoutMs: 15000 }));
  let release = options.release;
  if (release === undefined) {
    try {
      release = os.release();
    } catch (e) {
      release = '';
    }
  }
  const isWindows = platform === 'win32';
  const dns = String(env.USERDNSDOMAIN || '').toLowerCase();
  const netbios = String(env.USERDOMAIN || '');
  const computer = String(env.COMPUTERNAME || '');
  const joined = !!dns && !!netbios && netbios.toUpperCase() !== computer.toUpperCase();
  const result = {
    platform,
    isWindows,
    osRelease: release || '',
    installationType: '',
    isServer: false,
    tools: Object.fromEntries(TOOLS.map((t) => [t, false])),
    isAdmin: false,
    domain: { dns: joined ? dns : '', netbios: joined ? netbios : '', dn: joined ? Agdlp.domainToDn(dns) : '' },
    joined,
  };
  if (!isWindows) return result;
  const safeRun = async (line) => {
    try {
      const r = await run(line);
      return r || { exitCode: null, output: '', stdout: '' };
    } catch (e) {
      return { exitCode: null, output: '', stdout: '' };
    }
  };

  const where = await safeRun(`where ${TOOLS.join(' ')}`);
  for (const l of String(where.stdout !== undefined ? where.stdout : where.output || '').split(/\r?\n/)) {
    const m = /([^\\/]+?)\.(exe|com)\s*$/i.exec(l.trim());
    if (m && TOOLS.includes(m[1].toLowerCase())) result.tools[m[1].toLowerCase()] = true;
  }

  const reg = await safeRun('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v InstallationType');
  const it = /InstallationType\s+REG_SZ\s+(.+)/i.exec(String(reg.output || ''));
  if (it) {
    result.installationType = it[1].trim();
    result.isServer = /server/i.test(result.installationType);
  }

  const who = await safeRun('whoami /groups');
  const groups = String(who.output || '').toUpperCase();
  if (who.exitCode === 0 && groups.includes('S-1-5-32-544')) {
    result.isAdmin = groups.includes('S-1-16-12288') || groups.includes('S-1-16-16384');
  } else {
    const ns = await safeRun('net session');
    result.isAdmin = ns.exitCode === 0;
  }

  if (result.tools.dsquery && joined) {
    const q = await safeRun('dsquery * domainroot -scope base');
    const m = /"?((?:DC=[^,"\r\n]+,?)+)"?/i.exec(String(q.stdout !== undefined ? q.stdout : q.output || ''));
    if (q.exitCode === 0 && m) result.domain.dn = m[1].replace(/,$/, '');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exécution des étapes
// ---------------------------------------------------------------------------

/** L'objet existe si le test réussit (code 0) ET écrit quelque chose sur la sortie standard. */
function checkSaysExists(r) {
  if (!r || r.exitCode !== 0) return false;
  const text = r.stdout !== undefined ? r.stdout : r.output;
  return String(text || '').trim() !== '';
}

/** Premier DN d'une sortie dsquery (une ligne par objet, en général entre guillemets). */
function firstDn(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim().replace(/^"(.*)"$/, '$1');
    if (/^[A-Za-z]+=/.test(s)) return s;
  }
  return '';
}

/**
 * Exécute les étapes dans l'ordre.
 * options :
 *   dryRun  : simulation — seuls les tests d'existence (lecture seule) sont lancés ;
 *             statut 'todo' (à créer), 'exists' ou 'unknown' (étape sans test) ;
 *   run     : lanceur injectable (line, { signal }) → Promise<{ exitCode, output, stdout? }>
 *             (exec est accepté comme alias) ; par défaut runCommand ;
 *   signal  : AbortSignal pour annuler ; les étapes restantes sont 'cancelled' ;
 *   onStep  : rappel ({ index, total, step, status, message, output, durationMs, code }) ;
 *   platform: pour les tests (par défaut process.platform).
 * Une étape dont une étape préalable (step.needs) a échoué est 'skipped'.
 * Renvoie { total, ok, exists, errors, skipped, cancelled, todo, unknown }.
 */
async function runSteps(steps, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') throw new Error("Agépédé ne peut exécuter les commandes que sous Windows (contrôleur de domaine ou poste avec RSAT). Exportez le script .bat à la place.");
  const list = Array.isArray(steps) ? steps : [];
  const run = options.run || options.exec || ((line, o) => runCommand(line, o));
  const signal = options.signal;
  const dryRun = !!options.dryRun;
  const onStep = typeof options.onStep === 'function' ? options.onStep : () => {};
  const summary = { total: list.length, ok: 0, exists: 0, errors: 0, skipped: 0, cancelled: 0, todo: 0, unknown: 0 };
  const statusById = new Map();
  const labelById = new Map(list.map((s) => [s.id, s.label]));
  const count = { ok: 'ok', exists: 'exists', error: 'errors', skipped: 'skipped', cancelled: 'cancelled', todo: 'todo', unknown: 'unknown' };

  const report = (index, step, status, message, output, started, code) => {
    statusById.set(step.id, status);
    summary[count[status]]++;
    try {
      onStep({ index, total: list.length, step, status, message, output: output || '', durationMs: Date.now() - started, code: code || null });
    } catch (e) {
      /* une erreur d'affichage ne doit pas arrêter l'exécution */
    }
  };
  const runOne = async (line) => {
    try {
      const r = await run(line, { signal });
      return r || { exitCode: null, output: '' };
    } catch (e) {
      return { exitCode: null, output: `Erreur de lancement : ${e && e.message ? e.message : e}` };
    }
  };

  for (let index = 0; index < list.length; index++) {
    const step = list[index];
    const started = Date.now();
    if (signal && signal.aborted) {
      report(index, step, 'cancelled', 'Annulé.', '', started);
      continue;
    }
    if (!dryRun) {
      const failedDep = (step.needs || []).find((id) => ['error', 'skipped', 'cancelled'].includes(statusById.get(id)));
      if (failedDep) {
        report(index, step, 'skipped', `Étape ignorée : l'étape préalable « ${labelById.get(failedDep) || failedDep} » n'a pas abouti.`, '', started);
        continue;
      }
    }

    let checked = false;
    if (step.check) {
      const r = await runOne(step.check);
      if (signal && signal.aborted) {
        report(index, step, 'cancelled', 'Annulé.', r.output, started);
        continue;
      }
      if (checkSaysExists(r)) {
        report(index, step, 'exists', step.kind === 'member' ? 'Déjà membre : étape ignorée.' : 'Déjà présent : étape ignorée.', r.output, started);
        continue;
      }
      checked = true;
    }

    if (dryRun) {
      if (checked) report(index, step, 'todo', 'À faire.', '', started);
      else report(index, step, 'unknown', step.kind === 'acl' ? 'Droit appliqué à l\'exécution (pas de vérification préalable).' : 'Non vérifiable avant exécution.', '', started);
      continue;
    }

    // Membre connu seulement par son identifiant : la recherche dsquery est faite ici, puis dsmod reçoit le DN
    // trouvé directement. Avec « for /f », cmd.exe sans console peut mal décoder un DN accentué.
    let line = step.command;
    let lookupOutput = '';
    if (step.kind === 'member' && step.member && step.member.lookup && step.member.query) {
      const q = await runOne(step.member.query);
      if (signal && signal.aborted) {
        report(index, step, 'cancelled', 'Annulé.', q.output, started);
        continue;
      }
      const dn = firstDn(q.stdout != null ? q.stdout : q.output);
      if (!dn) {
        report(index, step, 'error', `Introuvable dans l'Active Directory : ${step.member.name}`, q.output, started);
        continue;
      }
      if (/["%\r\n]/.test(dn)) {
        report(index, step, 'error', `DN non pris en charge (caractère " ou %) : ${dn}`, q.output, started);
        continue;
      }
      line = Agdlp.addMemberCommand(step.dn, dn);
      lookupOutput = `> ${line}\n`;
    }

    const r = await runOne(line);
    if (lookupOutput) r.output = lookupOutput + (r.output || '');
    if (signal && signal.aborted && r.exitCode !== 0) {
      report(index, step, 'cancelled', 'Annulé pendant la commande.', r.output, started);
      continue;
    }
    let cls = Agdlp.classifyResult({ exitCode: r.exitCode, output: r.output, kind: step.kind });
    // Le test disait « absent » mais dsadd répond « existe déjà » : le nom est pris ailleurs
    // (même sAMAccountName dans une autre OU). Les étapes suivantes échoueraient : c'est une erreur.
    if (cls.status === 'exists' && checked && step.kind === 'group') {
      cls = { status: 'error', message: "Un groupe portant ce nom (sAMAccountName) existe déjà ailleurs dans le domaine.", code: cls.code };
    }
    if (r.timedOut) cls = { status: 'error', message: 'Délai dépassé : commande interrompue.', code: null };
    report(index, step, cls.status, cls.message, r.output, started, cls.code);
  }
  return summary;
}

module.exports = { runCommand, runSteps, detectEnvironment, decodeOutput, decodeCp850, killTree, checkSaysExists, firstDn, TOOLS };
