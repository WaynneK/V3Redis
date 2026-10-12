/*
 * platforms.js — Ce qui change d'un système à l'autre pour les applications livrées avec le HUB.
 *
 * Le HUB embarque les applications dans resources/apps/<id>/ (Windows, Linux) ou dans
 * V3Redis.app/Contents/Resources/apps/<id>/ (macOS), et les lance depuis là :
 *   - Windows : le dossier « win-unpacked » de l'application, lancé par son .exe ;
 *   - Linux   : le dossier « linux-unpacked », lancé par son exécutable (executableName Linux) ;
 *   - macOS   : le paquet <productName>.app, ouvert avec « open ».
 * Utilisé par main.js (détection, lancement) et scripts/build-setup.js (compilation, assemblage).
 * Aussi : lecture des « Applications installées » de Windows (détection d'une application installée à part).
 */
'use strict';

const path = require('node:path');

const SUPPORTED = ['win32', 'linux', 'darwin'];

/** Ce qu'on lance dans bundle/<id>/ (chemin relatif), ou null si l'application n'existe pas pour ce système. */
function bundledEntry(entry, platform) {
  if (platform === 'win32') return (entry.windows && entry.windows.exe) || null;
  if (platform === 'linux') return (entry.linux && entry.linux.bin) || null;
  if (platform === 'darwin') return (entry.mac && entry.mac.app) || null;
  return null;
}

/** Dossier de dist/ produit par « electron-builder --<système> dir ». */
function unpackedDir(platform, arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'universal' ? 'mac-universal' : 'mac';
  throw new Error(`Système non pris en charge : ${platform}`);
}

/** Options d'electron-builder pour compiler une application sans installeur. */
function appBuildArgs(platform, arch) {
  const os = { win32: '--win', linux: '--linux', darwin: '--mac' }[platform];
  if (!os) throw new Error(`Système non pris en charge : ${platform}`);
  return [os, 'dir', `--${arch}`];
}

/** Options d'electron-builder pour le paquet du HUB : installeur NSIS, AppImage ou image disque. */
function hubBuildArgs(platform, arch) {
  if (platform === 'win32') return ['--win', 'nsis', `--${arch}`];
  if (platform === 'linux') return ['--linux', 'AppImage', `--${arch}`];
  if (platform === 'darwin') return ['--mac', 'dmg', `--${arch}`];
  throw new Error(`Système non pris en charge : ${platform}`);
}

/** Version d'un paquet macOS (CFBundleShortVersionString de Contents/Info.plist, au format XML). */
function plistVersion(xml) {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(String(xml || ''));
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Windows : « Applications installées » (clés Uninstall du registre)
// ---------------------------------------------------------------------------

const UNINSTALL_KEYS = [
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/**
 * Script PowerShell qui lit toutes les entrées en une fois (HKCU, puis HKLM 64 et 32 bits) → JSON.
 * reg.exe écrit dans la page de code OEM de la console (850…) : « Agépédé » ou C:\Users\Rémi\ arrivaient
 * déformés. Ici, tout caractère non ASCII est écrit en \uXXXX : le résultat ne dépend d'aucune page de code.
 */
function uninstallScript() {
  return [
    `$list = @(foreach ($root in @(${UNINSTALL_KEYS.map((k) => `'${k}'`).join(', ')})) {`,
    '  Get-ItemProperty -Path "$root\\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } |',
    '    Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString',
    '})',
    '$json = ConvertTo-Json -InputObject $list -Compress',
    String.raw`[regex]::Replace($json, '[^\x00-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })`,
  ].join('\n');
}

/** Sortie de uninstallScript() → [{ name, version, location, uninstall }] (liste vide si illisible). */
function parseUninstallList(text) {
  let list;
  try {
    list = JSON.parse(String(text || '').replace(/^\uFEFF/, '').trim() || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) list = list && typeof list === 'object' ? [list] : [];
  const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  return list
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ name: str(x.DisplayName).normalize('NFC'), version: str(x.DisplayVersion) || null, location: str(x.InstallLocation) || null, uninstall: str(x.UninstallString) || null }))
    .filter((x) => x.name);
}

/** Entrées de l'application : le nom affiché contient la version (« SysInfo Lite 1.0.0 »), on compare le début. */
function matchUninstall(list, displayName) {
  const wanted = String(displayName || '').normalize('NFC');
  if (!wanted) return [];
  return (list || []).filter((x) => x.name === wanted || x.name.startsWith(`${wanted} `));
}

/** Dossier d'installation : InstallLocation, sinon celui du désinstalleur (« "C:\…\Uninstall X.exe" /currentuser »). */
function uninstallDir(item) {
  if (item.location) return item.location.replace(/^"|"$/g, '') || null;
  if (!item.uninstall) return null;
  const m = /^"([^"]+)"/.exec(item.uninstall) || /^(\S+)/.exec(item.uninstall);
  return m ? path.win32.dirname(m[1]) : null;
}

module.exports = { SUPPORTED, bundledEntry, unpackedDir, appBuildArgs, hubBuildArgs, plistVersion, uninstallScript, parseUninstallList, matchUninstall, uninstallDir };
