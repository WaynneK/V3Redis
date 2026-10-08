'use strict';

// Fonctions pures de updater.js (Electron remplacé par un module minimal : aucun accès réseau)
const test = require('node:test');
const assert = require('node:assert/strict');

require.cache[require.resolve('electron')] = {
  id: 'electron',
  filename: require.resolve('electron'),
  loaded: true,
  exports: { app: { getVersion: () => '0.1.2', isPackaged: false }, net: {}, shell: {} },
};
const U = require('../updater.js');

test('isNewer : comparaison des versions', () => {
  assert.equal(U.isNewer('0.1.3', '0.1.2'), true);
  assert.equal(U.isNewer('v0.2.0', '0.1.9'), true);
  assert.equal(U.isNewer('1.0.0', '0.9.99'), true);
  assert.equal(U.isNewer('0.1.2', '0.1.2'), false);
  assert.equal(U.isNewer('0.1.1', '0.1.2'), false);
  assert.equal(U.isNewer('0.1.10', '0.1.9'), true);
  assert.equal(U.isNewer('0.1.3-beta', '0.1.2'), true);
  assert.equal(U.isNewer('', '0.1.2'), false);
});

test('plainNotes : HTML de GitHub → texte court', () => {
  assert.equal(U.plainNotes('<h2>Nouveautés</h2><ul><li>Agépédé 1.0.2</li><li>PredF &amp; IA</li></ul>'), 'Nouveautés\n• Agépédé 1.0.2\n• PredF & IA');
  assert.equal(U.plainNotes([{ note: 'a' }, { note: 'b' }]), 'a\nb');
  assert.equal(U.plainNotes(null), null);
  assert.ok(U.plainNotes('x'.repeat(5000)).length <= 2000);
});

test('parseTasklist : noms des exécutables (CSV, sans en-tête)', () => {
  const out = '"System Idle Process","0","Services","0","8 Ko"\r\n"SysInfo Lite.exe","1234","Console","1","90 000 Ko"\r\n"Agepede.exe","42","Console","1","80 000 Ko"\r\n';
  const s = U.parseTasklist(out);
  assert.ok(s.has('sysinfo lite.exe'));
  assert.ok(s.has('agepede.exe'));
  assert.ok(!s.has('predf.exe'));
  assert.equal(U.parseTasklist('').size, 0);
});

test('dépôt des mises à jour', () => {
  assert.equal(U.OWNER, 'WaynneK');
  assert.equal(U.REPO, 'V3Redis');
  const pkg = require('../package.json');
  const pub = pkg.build.publish[0];
  assert.equal(pub.provider, 'github');
  assert.equal(pub.owner, U.OWNER);
  assert.equal(pub.repo, U.REPO);
  assert.ok(pkg.build.files.includes('updater.js'), 'updater.js inclus dans l\'application');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater en dépendance');
});
