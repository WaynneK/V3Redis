/*
 * elevation.js — Relancer Agépédé en administrateur (processus principal Electron uniquement).
 *
 * Electron ne sait pas demander l'élévation lui-même : on passe par PowerShell
 * « Start-Process -Verb RunAs », qui affiche la fenêtre de contrôle de compte d'utilisateur (UAC).
 *   - le script PowerShell est transmis encodé (-EncodedCommand) : aucun problème de guillemets ni d'injection ;
 *   - code de sortie 0 = la nouvelle instance est lancée ; 1223 = l'utilisateur a refusé l'élévation ;
 *   - le projet en cours est transmis à la nouvelle instance par un fichier temporaire (« handoff »),
 *     dont le chemin est passé en argument et vérifié à la lecture.
 */
'use strict';

const path = require('path');
const childProcess = require('child_process');

const HANDOFF_ARG = '--agepede-handoff=';
const HANDOFF_RE = /^agepede-handoff-[a-z0-9]{8,40}\.json$/;
const CANCELED_CODE = 1223; // ERROR_CANCELLED : élévation refusée dans la fenêtre UAC

/**
 * Le processus a-t-il les droits administrateur (jeton élevé) ? « fltmc » (System32, toutes versions de
 * Windows) répond 0 uniquement avec un jeton élevé, sans dépendre de la langue ni du service Serveur.
 */
function isElevated({ execFile = childProcess.execFile, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile('fltmc', [], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/** Chaîne littérale PowerShell (apostrophes doublées). */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Argument pour Start-Process -ArgumentList : PowerShell 5.1 joint les éléments par des espaces SANS
 * guillemets, on entoure donc chaque argument de guillemets doubles (refusés à l'intérieur).
 */
function quoteArg(arg) {
  const s = String(arg);
  if (s.includes('"')) throw new Error('Argument de relance invalide.');
  return `"${s.replace(/(\\+)$/, '$1$1')}"`; // barres obliques finales doublées : sinon elles échapperaient le guillemet
}

/**
 * Exécutable et arguments de la nouvelle instance. Application installée : l'exécutable seul.
 * Développement : electron.exe + chemin ABSOLU du projet (une instance élevée démarre dans System32).
 */
function relaunchCommand({ execPath, isPackaged, appPath, dev = false, handoffFile = null }) {
  const args = [];
  if (!isPackaged) args.push(appPath);
  if (dev && !isPackaged) args.push('--dev');
  if (handoffFile) args.push(`${HANDOFF_ARG}${handoffFile}`);
  return { file: execPath, args };
}

/** Script PowerShell encodé en base64 UTF-16LE (format attendu par -EncodedCommand). */
function encodedScript({ file, args }) {
  const list = args.length ? ` -ArgumentList @(${args.map((a) => psQuote(quoteArg(a))).join(', ')})` : '';
  const script = [
    '$ErrorActionPreference = "Stop"',
    `try { Start-Process -FilePath ${psQuote(file)}${list} -Verb RunAs | Out-Null; exit 0 }`,
    // Refus dans la fenêtre UAC : Win32Exception 1223, souvent enveloppée dans une InvalidOperationException
    `catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq ${CANCELED_CODE}) { exit ${CANCELED_CODE} }; $e = $e.InnerException }; [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
  ].join('\n'); // retours à la ligne : un « ; » entre try et catch est une erreur de syntaxe
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Lance la nouvelle instance élevée. Résout { ok } ; { ok: false, canceled: true } si l'élévation est refusée ;
 * { ok: false, error } sinon. Ne rejette jamais.
 */
function relaunchElevated(cmd, { spawn = childProcess.spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve({ ok: false, error: 'Disponible uniquement sous Windows.' });
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript(cmd)], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    if (child.stderr) child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else if (code === CANCELED_CODE) resolve({ ok: false, canceled: true });
      else resolve({ ok: false, error: stderr.trim() || `PowerShell a répondu ${code}.` });
    });
  });
}

/** Nom du fichier de transmission : aléatoire, dans le dossier temporaire. */
function handoffPath(tmpDir, random) {
  return path.join(tmpDir, `agepede-handoff-${random}.json`);
}

/** Chemin de transmission lu dans les arguments, accepté seulement s'il a la forme attendue et est dans tmpDir. */
function handoffFromArgv(argv, tmpDir) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith(HANDOFF_ARG));
  if (!arg) return null;
  const p = path.resolve(arg.slice(HANDOFF_ARG.length));
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (!HANDOFF_RE.test(path.basename(p)) || !same(path.dirname(p), tmpDir)) return null;
  return p;
}

module.exports = { isElevated, psQuote, quoteArg, relaunchCommand, encodedScript, relaunchElevated, handoffPath, handoffFromArgv, HANDOFF_ARG, CANCELED_CODE };
