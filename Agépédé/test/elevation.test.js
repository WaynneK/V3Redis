'use strict';

// Relance en administrateur : construction de la commande, sans jamais lancer PowerShell ni l'UAC
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const E = require('../lib/elevation.js');

const decode = (b64) => Buffer.from(b64, 'base64').toString('utf16le');

test('quoteArg : guillemets, espaces, barres obliques finales, guillemet refusé', () => {
  assert.equal(E.quoteArg('C:\\Program Files\\Agepede'), '"C:\\Program Files\\Agepede"');
  assert.equal(E.quoteArg('C:\\dossier\\'), '"C:\\dossier\\\\"');
  assert.throws(() => E.quoteArg('a"b'));
});

test('psQuote : apostrophes doublées', () => {
  assert.equal(E.psQuote("l'AD"), "'l''AD'");
});

test('relaunchCommand : application installée = exécutable seul (+ transmission)', () => {
  const c = E.relaunchCommand({ execPath: 'C:\\Apps\\Agepede.exe', isPackaged: true, appPath: 'C:\\x\\app.asar', dev: true, handoffFile: 'C:\\T\\agepede-handoff-abc12345.json' });
  assert.equal(c.file, 'C:\\Apps\\Agepede.exe');
  assert.deepEqual(c.args, ['--agepede-handoff=C:\\T\\agepede-handoff-abc12345.json']);
});

test('relaunchCommand : développement = electron + chemin absolu du projet', () => {
  const c = E.relaunchCommand({ execPath: 'C:\\e\\electron.exe', isPackaged: false, appPath: 'C:\\Users\\X\\Agépédé', dev: true });
  assert.deepEqual(c.args, ['C:\\Users\\X\\Agépédé', '--dev']);
});

test('encodedScript : Start-Process -Verb RunAs, arguments entre guillemets, code 1223 si refus', () => {
  const s = decode(E.encodedScript({ file: "C:\\Program Files\\Agépédé\\Agepede.exe", args: ['C:\\Users\\l\'ami\\projet', '--dev'] }));
  assert.match(s, /Start-Process -FilePath 'C:\\Program Files\\Agépédé\\Agepede\.exe'/);
  assert.match(s, /-ArgumentList @\('"C:\\Users\\l''ami\\projet"', '"--dev"'\)/);
  assert.match(s, /-Verb RunAs/);
  assert.match(s, /exit 1223/);
  assert.doesNotMatch(decode(E.encodedScript({ file: 'C:\\a.exe', args: [] })), /ArgumentList/);
  assert.doesNotMatch(s, /\}\s*;\s*catch/); // « try { } ; catch » serait refusé par PowerShell
});

function fakeSpawn(code, stderr = '') {
  const calls = [];
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
}

test('relaunchElevated : 0 → ok ; 1223 → refus ; autre → erreur ; hors Windows → erreur', async () => {
  const cmd = { file: 'C:\\a.exe', args: [] };
  const ok = fakeSpawn(0);
  assert.deepEqual(await E.relaunchElevated(cmd, { spawn: ok.spawn, platform: 'win32' }), { ok: true });
  assert.equal(ok.calls[0].file, 'powershell.exe');
  assert.ok(ok.calls[0].args.includes('-EncodedCommand'));
  assert.deepEqual(await E.relaunchElevated(cmd, { spawn: fakeSpawn(1223).spawn, platform: 'win32' }), { ok: false, canceled: true });
  const err = await E.relaunchElevated(cmd, { spawn: fakeSpawn(1, 'Accès refusé').spawn, platform: 'win32' });
  assert.equal(err.ok, false);
  assert.equal(err.error, 'Accès refusé');
  assert.equal((await E.relaunchElevated(cmd, { spawn: ok.spawn, platform: 'linux' })).ok, false);
});

test('handoffFromArgv : seulement un fichier agepede-handoff-*.json du dossier temporaire', () => {
  const tmp = path.resolve('C:\\Users\\X\\AppData\\Local\\Temp');
  const good = E.handoffPath(tmp, 'a1b2c3d4e5f6');
  assert.equal(E.handoffFromArgv(['app', `--agepede-handoff=${good}`], tmp), good);
  assert.equal(E.handoffFromArgv(['app'], tmp), null);
  assert.equal(E.handoffFromArgv([`--agepede-handoff=C:\\Windows\\agepede-handoff-a1b2c3d4.json`], tmp), null);
  assert.equal(E.handoffFromArgv([`--agepede-handoff=${path.join(tmp, 'autre.json')}`], tmp), null);
  assert.equal(E.handoffFromArgv([`--agepede-handoff=${path.join(tmp, '..', 'agepede-handoff-a1b2c3d4.json')}`], tmp), null);
});

test('isElevated : faux hors Windows, réponse de fltmc sinon', async () => {
  assert.equal(await E.isElevated({ platform: 'linux' }), false);
  assert.equal(await E.isElevated({ platform: 'win32', execFile: (_f, _a, _o, cb) => cb(null) }), true);
  assert.equal(await E.isElevated({ platform: 'win32', execFile: (_f, _a, _o, cb) => cb(new Error('refusé')) }), false);
});
