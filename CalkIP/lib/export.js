/*
 * export.js — Préparation et écriture sûre des exports .txt (processus principal uniquement, Node).
 *
 * Séparé de main.js pour être testé sans Electron :
 *  - compute() refait le calcul à partir de la saisie de la page (sans confiance dans ses nombres) ;
 *  - writeFileSafely() écrit dans un fichier temporaire placé à côté de la cible, puis le renomme
 *    par-dessus la cible seulement si tout s'est bien passé. En cas d'erreur ou d'annulation, seul ce
 *    fichier temporaire est supprimé : un fichier existant que l'utilisateur a choisi de remplacer
 *    reste intact.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
const IPCalc = require('./ipcalc.js');

// Tailles maximales acceptées : au-delà, erreur explicite plutôt qu'une saisie tronquée en silence
// (l'export différerait alors de ce qu'affiche la page)
const INPUT_LIMITS = { input: 200, exclusions: 100000, limit: 12 };

function checkLength(value, max, label, field) {
  if (value.length > max) {
    throw new IPCalc.CalcError(`${label} trop long (${IPCalc.formatNumber(value.length)} caractères, maximum ${IPCalc.formatNumber(max)}) : raccourcissez la saisie.`, field);
  }
  return value;
}

/**
 * Requête de la page → { calc, pool, poolError, reason, input }.
 * Lève une CalcError si l'adresse est invalide ou si une saisie est trop longue. Des réglages DHCP
 * invalides ne bloquent pas les exports qui n'en ont pas besoin : pool vaut alors null et poolError
 * contient l'erreur (à lever par les exports qui ont besoin de la plage DHCP).
 */
function compute(req) {
  req = req || {};
  const input = checkLength(String(req.input || ''), INPUT_LIMITS.input, 'Adresse saisie', 'ip');
  const parsed = IPCalc.parseInput(input);
  const { prefix, reason } = IPCalc.resolvePrefix(parsed, req.mode === 'auto' ? 'auto' : Number(req.mode));
  const calc = IPCalc.calculate(parsed.ip, prefix);
  const d = req.dhcp || {};
  const exclusions = checkLength(String(d.exclusions || ''), INPUT_LIMITS.exclusions, 'Texte des exclusions', 'exclusions');
  const limit = d.limit === undefined || d.limit === null ? '' : checkLength(String(d.limit), INPUT_LIMITS.limit, 'Nombre de baux souhaité', 'limit');
  let pool = null;
  let poolError = null;
  try {
    pool = IPCalc.dhcpPool(calc, {
      gateway: ['first', 'last', 'none', 'custom'].includes(d.gateway) ? d.gateway : 'first',
      customGateway: String(d.customGateway || ''),
      reserveStart: d.reserveStart,
      reserveEnd: d.reserveEnd,
      exclusions,
      limit,
    });
  } catch (err) {
    if (!err || err.name !== 'CalcError') throw err;
    poolError = err;
  }
  return { calc, pool, poolError, reason, input };
}

const stamp = () => new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const rule = '='.repeat(64);

/** En-tête commun des exports : titre, date, résumé du calcul, remarques sur la plage DHCP. */
function header(title, data) {
  const notes = data.pool ? data.pool.notes : [];
  return [
    `CalkIP — ${title}`,
    `Généré le ${stamp()} (calcul local, hors ligne)`,
    rule,
    ...IPCalc.summaryLines(data.calc, data.pool, { input: data.input, reason: data.reason }),
    ...(notes.length ? ['', ...notes.map((n) => `Remarque : ${n}`)] : []),
    ...(data.poolError ? ['', `Remarque : plage DHCP non calculée, réglages invalides (${data.poolError.message})`] : []),
    rule,
  ];
}

// ---------------------------------------------------------------------------
// Écriture sûre : fichier temporaire, puis renommage par-dessus la cible
// ---------------------------------------------------------------------------

/** Fichier temporaire dans le même dossier que la cible (le renommage reste sur le même disque). */
const tempPathFor = (filePath) => `${filePath}.calkip.part`;

const whenClosed = (stream) => (stream.closed ? Promise.resolve() : new Promise((resolve) => stream.once('close', resolve)));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOCK_CODES = ['EBUSY', 'EPERM', 'EACCES'];

/** Erreur système → message lisible ; l'erreur d'origine reste dans `cause`. */
function friendlyError(err, filePath) {
  const code = err && err.code;
  let message = null;
  if (LOCK_CODES.includes(code)) {
    message = `Impossible d'écrire « ${path.basename(filePath)} » : le fichier est ouvert dans un autre programme (Excel, Word…) ou protégé en écriture. Fermez-le ou choisissez un autre nom ; aucun fichier n'a été modifié.`;
  } else if (code === 'ENOSPC') {
    message = 'Espace disque insuffisant : export interrompu, aucun fichier n\'a été modifié.';
  } else if (code === 'ENOENT') {
    message = `Dossier introuvable : « ${path.dirname(filePath)} ».`;
  }
  return message ? Object.assign(new Error(message), { code, cause: err }) : err;
}

/** Renommage avec quelques nouvelles tentatives : un antivirus ou l'indexation peut verrouiller le fichier un instant. */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (attempt >= 4 || !LOCK_CODES.includes(err.code)) throw err;
      await wait(100 * attempt);
    }
  }
}

/**
 * Écrit `filePath` via produce(write) : write(chunk) renvoie une promesse qui respecte la contre-pression
 * du flux et échoue dès que le flux est en erreur. Si produce échoue (annulation comprise) ou si
 * l'écriture échoue, le fichier temporaire est supprimé et la cible n'est pas touchée.
 */
async function writeFileSafely(filePath, produce) {
  const tmp = tempPathFor(filePath);
  const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
  // Écouteur d'erreur permanent : une erreur d'ouverture (dossier protégé, disque plein…) arrive souvent
  // alors qu'aucune écriture n'est en attente ; sans lui, elle deviendrait une exception non interceptée
  let failure = null;
  stream.on('error', (err) => {
    if (!failure) failure = err;
  });
  const write = async (chunk) => {
    if (failure) throw failure;
    if (!stream.write(chunk)) await once(stream, 'drain'); // once() échoue aussi sur 'error'
    if (failure) throw failure;
  };
  try {
    await produce(write);
    stream.end();
    await finished(stream); // fin d'écriture et fermeture du fichier
    if (failure) throw failure;
    await whenClosed(stream);
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    stream.destroy();
    await whenClosed(stream); // Windows : le fichier doit être fermé pour être supprimé
    await fsp.unlink(tmp).catch(() => {});
    throw err && err.canceled ? err : friendlyError(err, filePath);
  }
}

module.exports = { INPUT_LIMITS, compute, header, rule, stamp, tempPathFor, writeFileSafely, friendlyError };
