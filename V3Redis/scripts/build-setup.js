/*
 * build-setup.js — Paquet « tout en un » : V3Redis + les applications disponibles de apps.js
 * (aujourd'hui SysInfo Lite, CalkIP, PredF et Agépédé), pour le système sur lequel il est lancé :
 *   - Windows : installeur NSIS   dist/V3Redis-Setup-x.y.z.exe   (+ .blockmap, latest.yml)
 *   - Linux   : AppImage           dist/V3Redis-x.y.z-x86_64.AppImage (+ .blockmap, latest-linux.yml)
 *   - macOS   : image disque       dist/V3Redis-x.y.z-<arch>.dmg (arm64 ou x64 : option --arch)
 * Un paquet macOS ne se construit que sur un Mac, une AppImage que sous Linux : la release complète est
 * construite par GitHub Actions (.github/workflows/release.yml, à la racine du dépôt).
 *
 *   1. Compile chaque application du catalogue (apps.js, champ « local ») dans son projet voisin
 *      (electron-builder --<système> dir). Option --skip-apps : réutilise les dossiers déjà compilés.
 *   2. Copie le résultat dans bundle/<id>/ (dossier de l'application, ou son paquet .app sur macOS) avec un
 *      marqueur hub-bundle.json (SysInfo Lite ne lance alors pas sa propre mise à jour).
 *   3. Windows : écrit build/installer.nsh (pages, apparence « Hyperespace », raccourcis du menu Démarrer).
 *   4. Construit le paquet du HUB ; bundle/ y est copié dans resources/apps/.
 *
 * Projet d'une application introuvable : reprise de la version déjà assemblée dans bundle/<id>/ si elle existe ;
 * sinon erreur, ou, avec --skip-missing (GitHub Actions), paquet construit sans cette application.
 *
 * Usage : npm run build   (options : --skip-apps, --skip-missing, --arch arm64|x64, --publish)
 * --publish (npm run release) : envoie les fichiers dans la release brouillon « vX.Y.Z » de WaynneK/V3Redis
 * (variable GH_TOKEN requise) ; il reste à la publier.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const APPS = require('../apps.js');
const Platforms = require('../platforms.js');
const { buildInstallerNsh } = require('./installer-nsh.js');

const HUB = path.resolve(__dirname, '..');
const PROJECTS = path.resolve(HUB, '..');
const BUNDLE = path.join(HUB, 'bundle');
const PLATFORM = process.platform;
const args = process.argv.slice(2);
const skipApps = args.includes('--skip-apps');
const skipMissing = args.includes('--skip-missing');
const publish = args.includes('--publish');
const archArg = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : null;
const ARCH = archArg || (PLATFORM === 'darwin' ? process.arch : 'x64');

if (!Platforms.SUPPORTED.includes(PLATFORM)) {
  console.error(`Système non pris en charge : ${PLATFORM} (Windows, Linux ou macOS).`);
  process.exit(1);
}
if (!['x64', 'arm64'].includes(ARCH)) {
  console.error(`Architecture inconnue : ${ARCH} (x64 ou arm64).`);
  process.exit(1);
}
if (publish && !process.env.GH_TOKEN) {
  console.error('Publication : définissez la variable GH_TOKEN (jeton GitHub avec le droit « contents: write » sur WaynneK/V3Redis).');
  process.exit(1);
}

function step(message) {
  console.log(`\n=== ${message}`);
}

/** electron-builder du projet indiqué, lancé avec Node (sans shell). */
function electronBuilder(projectDir, builderArgs) {
  const cli = require.resolve('electron-builder/cli.js', { paths: [projectDir] });
  const res = spawnSync(process.execPath, [cli, ...builderArgs], { cwd: projectDir, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`electron-builder a échoué dans ${projectDir} (code ${res.status}).`);
}

/** Copie d'un dossier ou d'un paquet .app, liens symboliques conservés tels quels (frameworks macOS). */
function copyTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (PLATFORM === 'darwin') {
    const res = spawnSync('ditto', [src, dst], { stdio: 'inherit' }); // conserve liens, attributs et signatures
    if (res.status !== 0) throw new Error(`Copie impossible : ${src}`);
  } else {
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  }
}

const rel = (a) => Platforms.bundledEntry(a, PLATFORM); // ce qu'on lance dans bundle/<id>/
const candidates = APPS.filter((a) => a.status === 'available' && a.local && rel(a));

/**
 * Projet introuvable (déplacé, renommé, absent de GitHub Actions…) : reprise de la version déjà assemblée dans
 * bundle/<id>/ lors d'un build précédent ; sinon erreur, ou application ignorée avec --skip-missing.
 */
const reused = new Set();
const skipped = new Set();
for (const a of candidates) {
  const dir = path.join(PROJECTS, a.local.project);
  if (fs.existsSync(path.join(dir, 'package.json'))) continue;
  const previous = path.join(BUNDLE, a.id);
  if (fs.existsSync(path.join(previous, rel(a))) && fs.existsSync(path.join(previous, 'hub-bundle.json'))) {
    reused.add(a.id);
    const { version } = JSON.parse(fs.readFileSync(path.join(previous, 'hub-bundle.json'), 'utf8'));
    console.warn(`ATTENTION : projet de ${a.name} introuvable (${dir}) : reprise de la version ${version} déjà assemblée dans bundle/${a.id}.`);
  } else if (skipMissing) {
    skipped.add(a.id);
    console.warn(`ATTENTION : projet de ${a.name} introuvable (${dir}) : paquet construit SANS ${a.name}.`);
  } else {
    throw new Error(`Projet de ${a.name} introuvable : ${dir} (et aucune version déjà assemblée dans bundle/${a.id}).`);
  }
}
const bundled = candidates.filter((a) => !skipped.has(a.id));

// 1) Compilation des applications
for (const a of bundled) {
  const dir = path.join(PROJECTS, a.local.project);
  if (reused.has(a.id) || skipApps) continue;
  step(`Compilation de ${a.name} (${dir}) — ${PLATFORM} ${ARCH}`);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) throw new Error(`Dépendances absentes dans ${dir} : lancez « npm install » dans ce projet.`);
  electronBuilder(dir, [...Platforms.appBuildArgs(PLATFORM, ARCH), '--publish', 'never']);
}

// 2) Copie dans bundle/<id>/
step('Assemblage des applications');
// Le dossier est vidé, sauf les versions reprises faute de projet (et rien d'autre que les applications du paquet)
fs.mkdirSync(BUNDLE, { recursive: true });
for (const entry of fs.readdirSync(BUNDLE)) {
  if (!reused.has(entry)) fs.rmSync(path.join(BUNDLE, entry), { recursive: true, force: true });
}
for (const a of bundled) {
  if (reused.has(a.id)) {
    const { version } = JSON.parse(fs.readFileSync(path.join(BUNDLE, a.id, 'hub-bundle.json'), 'utf8'));
    console.log(`  • ${a.name} ${version} → bundle/${a.id} (reprise : projet introuvable)`);
    continue;
  }
  const dir = path.join(PROJECTS, a.local.project);
  const unpacked = path.join(dir, 'dist', Platforms.unpackedDir(PLATFORM, ARCH));
  const launchable = path.join(unpacked, rel(a));
  if (!fs.existsSync(launchable)) throw new Error(`${launchable} introuvable : compilez ${a.name} (relancez sans --skip-apps).`);
  const target = path.join(BUNDLE, a.id);
  // macOS : le paquet .app seul ; Windows / Linux : tout le dossier de l'application
  if (PLATFORM === 'darwin') copyTree(launchable, path.join(target, rel(a)));
  else copyTree(unpacked, target);
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(target, 'hub-bundle.json'), JSON.stringify({ app: a.name, version, platform: PLATFORM, arch: ARCH, bundledAt: new Date().toISOString() }, null, 2));
  console.log(`  • ${a.name} ${version} → bundle/${a.id} (${(du(target) / 1048576).toFixed(0)} Mo)`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(HUB, 'package.json'), 'utf8'));
const product = pkg.build.productName || pkg.productName;

// 3) Windows : pages, apparence et raccourcis du menu Démarrer (script NSIS inclus par electron-builder)
if (PLATFORM === 'win32') {
  step('Pages et raccourcis de l\'installeur');
  fs.mkdirSync(path.join(HUB, 'build'), { recursive: true });
  // BOM UTF-8 : sans lui, NSIS lit le fichier dans la page de code ANSI et les accents seraient déformés
  fs.writeFileSync(path.join(HUB, 'build', 'installer.nsh'), '﻿' + buildInstallerNsh({ apps: bundled, product }));
  for (const img of ['installerSidebar.bmp', 'installerHeader.bmp']) {
    if (!fs.existsSync(path.join(HUB, 'build', img))) throw new Error(`build/${img} absent : lancez « npm run installer:art ».`);
  }
  console.log(`  • build/installer.nsh (${bundled.map((a) => a.name).join(', ')}) — design « Hyperespace »`);
}

// 4) Paquet du HUB
step(`Construction du paquet de ${product} — ${PLATFORM} ${ARCH}`);
electronBuilder(HUB, [...Platforms.hubBuildArgs(PLATFORM, ARCH), '--publish', publish ? 'always' : 'never']);

const dist = path.join(HUB, 'dist');
const outputs = {
  win32: [`${product}-Setup-${pkg.version}.exe`, `${product}-Setup-${pkg.version}.exe.blockmap`, 'latest.yml'],
  linux: [`${product}-${pkg.version}-x86_64.AppImage`, 'latest-linux.yml'],
  darwin: [`${product}-${pkg.version}-${ARCH}.dmg`],
}[PLATFORM].map((f) => path.join(dist, f));
const main = outputs[0];
if (fs.existsSync(main)) {
  console.log(`\nPaquet prêt : dist/${path.basename(main)} (${(fs.statSync(main).size / 1048576).toFixed(0)} Mo) — ${product} + ${bundled.map((a) => a.name).join(' + ')}`);
  const missing = outputs.filter((f) => !fs.existsSync(f));
  if (missing.length) console.warn(`Attention, fichiers attendus absents : ${missing.map((f) => path.basename(f)).join(', ')}`);
  else if (publish) console.log(`Fichiers envoyés dans la release brouillon v${pkg.version} de github.com/WaynneK/V3Redis : vérifiez-la puis cliquez sur « Publish release ».`);
  else console.log(`Mise à jour : joindre ${outputs.map((f) => path.basename(f)).join(', ')} à la release GitHub « v${pkg.version} » de WaynneK/V3Redis.`);
}
if (skipped.size) console.warn(`Paquet construit sans : ${[...skipped].join(', ')} (projet introuvable).`);

function du(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? du(p) : e.isSymbolicLink() ? 0 : fs.statSync(p).size;
  }
  return total;
}
