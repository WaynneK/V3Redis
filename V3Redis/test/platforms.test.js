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

test('« Applications installées » : sortie PowerShell (ASCII, \\uXXXX) → entrées, accents compris', () => {
  // Sortie réelle de uninstallScript() : caractères non ASCII échappés, indépendante de la page de code
  const out = '\uFEFF[{"DisplayName":"Ag\\u00e9p\\u00e9d\\u00e9 1.0.2","DisplayVersion":"1.0.2","InstallLocation":"C:\\\\Users\\\\R\\u00e9mi\\\\AppData\\\\Local\\\\Programs\\\\Agepede","UninstallString":null},'
    + '{"DisplayName":"SysInfo Lite 1.0.0","DisplayVersion":"1.0.0","InstallLocation":"","UninstallString":"\\"C:\\\\Apps\\\\SysInfo Lite\\\\Uninstall SysInfo Lite.exe\\" /currentuser"},'
    + '{"DisplayName":"SysInfo Lite Pro","InstallLocation":"C:\\\\Autre"},{"DisplayName":null},"bizarre"]\r\n';
  const list = P.parseUninstallList(out);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { name: 'Agépédé 1.0.2', version: '1.0.2', location: 'C:\\Users\\Rémi\\AppData\\Local\\Programs\\Agepede', uninstall: null });
  // Nom affiché exact ou suivi d'un espace (version) ; dans l'ordre de lecture (main.js vérifie ensuite l'exécutable)
  assert.deepEqual(P.matchUninstall(list, 'Agépédé').map((x) => x.version), ['1.0.2']);
  assert.deepEqual(P.matchUninstall(list, 'SysInfo Lite').map((x) => x.name), ['SysInfo Lite 1.0.0', 'SysInfo Lite Pro']);
  assert.deepEqual(P.matchUninstall(list, 'SysInfo Li'), []);
  assert.deepEqual(P.matchUninstall(list, 'Age\u0301pe\u0301de\u0301').length, 1); // forme Unicode décomposée
  assert.deepEqual(P.matchUninstall(list, 'CalkIP'), []);
  assert.deepEqual(P.matchUninstall(list, ''), []);
  // Dossier : InstallLocation, sinon celui du désinstalleur
  assert.equal(P.uninstallDir(list[0]), 'C:\\Users\\Rémi\\AppData\\Local\\Programs\\Agepede');
  assert.equal(P.uninstallDir(list[1]), 'C:\\Apps\\SysInfo Lite');
  assert.equal(P.uninstallDir({ location: '"C:\\Quoted"' }), 'C:\\Quoted');
  assert.equal(P.uninstallDir({ uninstall: 'C:\\Simple\\unins000.exe /SILENT' }), 'C:\\Simple');
  assert.equal(P.uninstallDir({}), null);
  // Un seul objet (PowerShell sans tableau), vide ou illisible
  assert.equal(P.parseUninstallList('{"DisplayName":"CalkIP 1.0.0"}')[0].name, 'CalkIP 1.0.0');
  assert.deepEqual(P.parseUninstallList(''), []);
  assert.deepEqual(P.parseUninstallList(null), []);
  assert.deepEqual(P.parseUninstallList('Get-ItemProperty : erreur'), []);
});

test('« Applications installées » : script PowerShell (HKCU, HKLM 64 et 32 bits, sortie ASCII)', () => {
  const s = P.uninstallScript();
  assert.match(s, /'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\Software\\WOW6432Node\\/);
  assert.match(s, /ConvertTo-Json -InputObject \$list -Compress/);
  assert.match(s, /\[\^\\x00-\\x7e\]/); // échappement \uXXXX de tout caractère non ASCII
  assert.ok(!/reg(\.exe)? query/i.test(s));
});