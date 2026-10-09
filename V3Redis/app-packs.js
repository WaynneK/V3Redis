/*
 * app-packs.js — Applications installables « à la carte » (Windows).
 *
 * L'installeur de V3Redis contient toutes les applications ; une page de l'installeur laisse choisir
 * lesquelles garder. Une application écartée (ou désinstallée plus tard depuis le HUB) peut être ajoutée
 * ensuite depuis le HUB : il télécharge son paquet dans la release GitHub de SA version (même version que
 * le paquet installé, donc les mêmes fichiers que l'installeur), vérifie son empreinte, puis l'extrait dans
 * resources/apps/<id>/.
 *
 * Fichiers produits par scripts/build-setup.js (Windows) et joints à la release :
 *   - V3Redis-<version>-app-<id>-win-x64.zip : le dossier resources/apps/<id>/ de l'installeur ;
 *   - V3Redis-<version>-apps-win-x64.json     : liste des paquets { id, name, version, file, size, sha512 }.
 * Choix mémorisé dans le registre (HKCU\Software\V3Redis\Applications, valeur <id> = "1" ou "0") : l'installeur
 * le relit, y compris lors des mises à jour silencieuses, et n'y remet pas une application désinstallée.
 */
'use strict';

const REG_KEY = 'Software\\V3Redis\\Applications';
const ARCH = 'x64';

const packFileName = (product, version, id) => `${product}-${version}-app-${id}-win-${ARCH}.zip`;
const manifestFileName = (product, version) => `${product}-${version}-apps-win-${ARCH}.json`;

/** Adresse des fichiers d'une version : release GitHub « v<version> » (ou serveur de test, V3REDIS_APPS_URL). */
function releaseBase({ owner, repo, version, override }) {
  if (override) return override.endsWith('/') ? override : `${override}/`;
  return `https://github.com/${owner}/${repo}/releases/download/v${version}/`;
}

/**
 * Paquet de l'application « id » dans la liste téléchargée. Vérifie tout ce qui servira à construire un
 * chemin ou une adresse : une liste altérée ne peut rien écrire ailleurs que prévu.
 */
function findPack(manifest, id, hubVersion) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.apps)) throw new Error('Liste des applications illisible.');
  if (hubVersion && manifest.hub && manifest.hub !== hubVersion) throw new Error(`Liste des applications de la version ${manifest.hub} (V3Redis ${hubVersion} attendu).`);
  const pack = manifest.apps.find((a) => a && a.id === id);
  if (!pack) throw new Error('Application absente de cette version de V3Redis.');
  if (typeof pack.file !== 'string' || !/^[\w.-]+\.zip$/.test(pack.file)) throw new Error('Nom de paquet invalide.');
  if (!Number.isSafeInteger(pack.size) || pack.size <= 0) throw new Error('Taille du paquet invalide.');
  if (typeof pack.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(pack.sha512)) throw new Error('Empreinte du paquet invalide.');
  // Taille une fois extrait (facultative) : sert seulement à la barre de progression de l'extraction
  const unpacked = Number.isSafeInteger(pack.unpacked) && pack.unpacked > 0 ? pack.unpacked : null;
  return { id: pack.id, name: String(pack.name || id), version: String(pack.version || ''), file: pack.file, size: pack.size, sha512: pack.sha512, unpacked };
}

/**
 * Avancement global d'une installation, de 0 à 100 : téléchargement puis extraction (au prorata des octets,
 * quand la taille extraite est connue), le dernier pour cent étant la mise en place.
 */
function overallPercent({ phase, received = 0, total = 0, extracted = 0, unpacked = null }) {
  const dl = unpacked ? 70 : 95; // part du téléchargement dans la barre
  const ratio = (a, b) => (b > 0 ? Math.max(0, Math.min(1, a / b)) : 0);
  switch (phase) {
    case 'prepare':
      return 0;
    case 'download':
      return Math.floor(ratio(received, total) * dl);
    case 'extract':
      return Math.min(99, dl + Math.floor(ratio(extracted, unpacked || 0) * (99 - dl)));
    case 'finish':
      return 99;
    case 'done':
      return 100;
    default:
      return 0;
  }
}

/** « 132 Mo » */
const mo = (bytes) => `${Math.max(1, Math.round((bytes || 0) / 1048576))} Mo`;

module.exports = { REG_KEY, ARCH, packFileName, manifestFileName, releaseBase, findPack, overallPercent, mo };
