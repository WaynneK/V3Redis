/*
 * platforms.js — Ce qui change d'un système à l'autre pour les applications livrées avec le HUB.
 *
 * Le HUB embarque les applications dans resources/apps/<id>/ (Windows, Linux) ou dans
 * V3Redis.app/Contents/Resources/apps/<id>/ (macOS), et les lance depuis là :
 *   - Windows : le dossier « win-unpacked » de l'application, lancé par son .exe ;
 *   - Linux   : le dossier « linux-unpacked », lancé par son exécutable (executableName Linux) ;
 *   - macOS   : le paquet <productName>.app, ouvert avec « open ».
 * Utilisé par main.js (détection, lancement) et scripts/build-setup.js (compilation, assemblage).
 */
'use strict';

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

module.exports = { SUPPORTED, bundledEntry, unpackedDir, appBuildArgs, hubBuildArgs, plistVersion };
