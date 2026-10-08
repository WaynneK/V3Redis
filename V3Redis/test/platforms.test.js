'use strict';

// Windows / Linux / macOS : chemins des applications livrées, options de compilation
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../platforms.js');
const APPS = require('../apps.js');

const available = APPS.filter((a) => a.status === 'available');

test('chaque application disponible existe pour les trois systèmes', () => {
  for (const a of available) {
    assert.ok(P.bundledEntry(a, 'win32').endsWith('.exe'), `${a.id} : exe Windows`);
    assert.match(P.bundledEntry(a, 'linux'), /^[a-z0-9-]+$/, `${a.id} : exécutable Linux`);
    assert.ok(P.bundledEntry(a, 'darwin').endsWith('.app'), `${a.id} : paquet macOS`);
  }
  assert.equal(P.bundledEntry({ id: 'x' }, 'linux'), null);
  assert.equal(P.bundledEntry(available[0], 'sunos'), null);
});

test('noms Linux et macOS = configuration electron-builder des projets', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const a of available) {
    const file = path.join(__dirname, '..', '..', a.local.project, 'package.json');
    if (!fs.existsSync(file)) continue; // projet absent (SysInfo Lite)
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(a.linux.bin, pkg.build.linux.executableName, `${a.id} : executableName Linux`);
    assert.equal(a.mac.app, `${pkg.build.productName || pkg.productName}.app`, `${a.id} : nom du paquet .app`);
  }
});

test('dossiers et options d\'electron-builder', () => {
  assert.equal(P.unpackedDir('win32', 'x64'), 'win-unpacked');
  assert.equal(P.unpackedDir('linux', 'x64'), 'linux-unpacked');
  assert.equal(P.unpackedDir('darwin', 'arm64'), 'mac-arm64');
  assert.equal(P.unpackedDir('darwin', 'x64'), 'mac');
  assert.deepEqual(P.appBuildArgs('darwin', 'arm64'), ['--mac', 'dir', '--arm64']);
  assert.deepEqual(P.hubBuildArgs('linux', 'x64'), ['--linux', 'AppImage', '--x64']);
  assert.deepEqual(P.hubBuildArgs('win32', 'x64'), ['--win', 'nsis', '--x64']);
  assert.deepEqual(P.hubBuildArgs('darwin', 'x64'), ['--mac', 'dmg', '--x64']);
  assert.throws(() => P.hubBuildArgs('sunos', 'x64'));
});

test('version d\'un paquet macOS (Info.plist)', () => {
  const xml = '<plist><dict><key>CFBundleName</key><string>CalkIP</string><key>CFBundleShortVersionString</key>\n  <string>1.0.0</string></dict></plist>';
  assert.equal(P.plistVersion(xml), '1.0.0');
  assert.equal(P.plistVersion('<plist/>'), null);
});

test('package.json du HUB : paquets Linux et macOS', () => {
  const b = require('../package.json').build;
  assert.deepEqual(b.linux.target, ['AppImage']);
  assert.deepEqual(b.mac.target, ['dmg']);
  assert.match(b.mac.artifactName, /\$\{arch\}/);
  assert.ok(b.files.includes('platforms.js'));
});
