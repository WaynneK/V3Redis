/*
 * build-setup.js — Installeur Windows « tout en un » : V3Redis + les applications disponibles de apps.js
 * (aujourd'hui SysInfo Lite, CalkIP, PredF et Agépédé).
 *
 *   1. Compile chaque application du catalogue (apps.js, champ « local ») dans son projet voisin
 *      (electron-builder --win dir → dist\win-unpacked). Option --skip-apps : réutilise les dossiers existants.
 *   2. Copie ces dossiers dans bundle\<id>\ avec un marqueur hub-bundle.json (l'application sait alors
 *      qu'elle est livrée avec le HUB : SysInfo Lite ne lance pas sa propre mise à jour).
 *   3. Écrit build\installer.nsh (raccourcis « Menu Démarrer > HUB > … » créés et supprimés par l'installeur).
 *   4. Construit l'installeur du HUB ; bundle\ y est copié dans resources\apps\.
 *
 * Usage : npm run build   (ou : node scripts/build-setup.js --skip-apps)
 *
 * Mise à jour (updater.js) : le build produit aussi dist\latest.yml et dist\V3Redis-Setup-x.y.z.exe.blockmap.
 * Pour publier une mise à jour (V3Redis ET toutes ses applications), joindre ces 3 fichiers à une release
 * GitHub « vX.Y.Z » de WaynneK/V3Redis — ou « npm run release » (--publish) avec la variable GH_TOKEN :
 * electron-builder crée alors la release en brouillon et y envoie les fichiers ; il reste à la publier.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const APPS = require('../apps.js');
const { buildInstallerNsh } = require('./installer-nsh.js');

const HUB = path.resolve(__dirname, '..');
const PROJECTS = path.resolve(HUB, '..');
const BUNDLE = path.join(HUB, 'bundle');
const skipApps = process.argv.includes('--skip-apps');
const publish = process.argv.includes('--publish');

if (process.platform !== 'win32') {
  console.error('L\'installeur « tout en un » est un installeur Windows : lancez ce script sous Windows.');
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
function electronBuilder(projectDir, args) {
  const cli = require.resolve('electron-builder/cli.js', { paths: [projectDir] });
  const res = spawnSync(process.execPath, [cli, ...args], { cwd: projectDir, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`electron-builder a échoué dans ${projectDir} (code ${res.status}).`);
}

const bundled = APPS.filter((a) => a.status === 'available' && a.local && a.windows);

/**
 * Projet introuvable (déplacé, renommé…) : on réutilise la version déjà assemblée dans bundle\<id>\ lors d'un
 * build précédent, avec un avertissement. Sans elle, le build s'arrête.
 */
const reused = new Set();
for (const a of bundled) {
  const dir = path.join(PROJECTS, a.local.project);
  if (fs.existsSync(path.join(dir, 'package.json'))) continue;
  const previous = path.join(BUNDLE, a.id);
  if (!fs.existsSync(path.join(previous, a.windows.exe)) || !fs.existsSync(path.join(previous, 'hub-bundle.json'))) {
    throw new Error(`Projet de ${a.name} introuvable : ${dir} (et aucune version déjà assemblée dans bundle\\${a.id}).`);
  }
  reused.add(a.id);
  const { version } = JSON.parse(fs.readFileSync(path.join(previous, 'hub-bundle.json'), 'utf8'));
  console.warn(`ATTENTION : projet de ${a.name} introuvable (${dir}) : reprise de la version ${version} déjà assemblée dans bundle\\${a.id}.`);
}

// 1) Compilation des applications
for (const a of bundled) {
  const dir = path.join(PROJECTS, a.local.project);
  if (reused.has(a.id) || skipApps) continue;
  step(`Compilation de ${a.name} (${dir})`);
  if (!fs.existsSync(path.join(dir, 'node_modules'))) throw new Error(`Dépendances absentes dans ${dir} : lancez « npm install » dans ce projet.`);
  electronBuilder(dir, ['--win', 'dir', '--x64', '--publish', 'never']);
}

// 2) Copie dans bundle\<id>\
step('Assemblage des applications');
// Le dossier est vidé, sauf les versions reprises faute de projet (et rien d'autre que les applications du paquet)
fs.mkdirSync(BUNDLE, { recursive: true });
for (const entry of fs.readdirSync(BUNDLE)) {
  if (!reused.has(entry)) fs.rmSync(path.join(BUNDLE, entry), { recursive: true, force: true });
}
for (const a of bundled) {
  if (reused.has(a.id)) {
    const { version } = JSON.parse(fs.readFileSync(path.join(BUNDLE, a.id, 'hub-bundle.json'), 'utf8'));
    console.log(`  • ${a.name} ${version} → bundle\\${a.id} (reprise : projet introuvable)`);
    continue;
  }
  const dir = path.join(PROJECTS, a.local.project);
  const unpacked = path.join(dir, 'dist', 'win-unpacked');
  const exe = path.join(unpacked, a.windows.exe);
  if (!fs.existsSync(exe)) throw new Error(`${exe} introuvable : compilez ${a.name} (relancez sans --skip-apps).`);
  const target = path.join(BUNDLE, a.id);
  fs.cpSync(unpacked, target, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(target, 'hub-bundle.json'), JSON.stringify({ app: a.name, version, bundledAt: new Date().toISOString() }, null, 2));
  const size = du(target);
  console.log(`  • ${a.name} ${version} → bundle\\${a.id} (${(size / 1048576).toFixed(0)} Mo)`);
}

// 3) Pages, apparence et raccourcis du menu Démarrer (script NSIS inclus par electron-builder)
step('Pages et raccourcis de l\'installeur');
const pkg = JSON.parse(fs.readFileSync(path.join(HUB, 'package.json'), 'utf8'));
const product = pkg.build.productName || pkg.productName; // nom du dossier du menu Démarrer
fs.mkdirSync(path.join(HUB, 'build'), { recursive: true });
// BOM UTF-8 : sans lui, NSIS lit le fichier dans la page de code ANSI et les accents seraient déformés
fs.writeFileSync(path.join(HUB, 'build', 'installer.nsh'), '﻿' + buildInstallerNsh({ apps: bundled, product }));
for (const img of ['installerSidebar.bmp', 'installerHeader.bmp']) {
  if (!fs.existsSync(path.join(HUB, 'build', img))) throw new Error(`build\\${img} absent : lancez « npm run installer:art ».`);
}
console.log(`  • build\\installer.nsh (${bundled.map((a) => a.name).join(', ')}) — design « Hyperespace »`);

// 4) Installeur du HUB
step(`Construction de l'installeur de ${product}`);
electronBuilder(HUB, ['--win', 'nsis', '--x64', '--publish', publish ? 'always' : 'never']);

const setup = path.join(HUB, 'dist', `${product}-Setup-${pkg.version}.exe`);
if (fs.existsSync(setup)) {
  console.log(`\nInstalleur prêt : ${path.relative(HUB, setup)} (${(fs.statSync(setup).size / 1048576).toFixed(0)} Mo) — ${product} + ${bundled.map((a) => a.name).join(' + ')}`);
  const files = [setup, `${setup}.blockmap`, path.join(HUB, 'dist', 'latest.yml')];
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) console.warn(`Attention, fichiers de mise à jour absents : ${missing.map((f) => path.basename(f)).join(', ')}`);
  else if (publish) console.log(`Release brouillon v${pkg.version} créée sur github.com/WaynneK/V3Redis : vérifiez-la puis cliquez sur « Publish release ».`);
  else console.log(`Mise à jour : joindre ${files.map((f) => path.basename(f)).join(', ')} à une release GitHub « v${pkg.version} » de WaynneK/V3Redis.`);
}

function du(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return total;
}
