'use strict';
// Paquets des applications installables depuis le HUB (app-packs.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const Packs = require('../app-packs.js');

const SHA = `${'A'.repeat(86)}==`;
const manifest = (apps, hub = '0.13.2') => ({ hub, apps });
const pack = { id: 'calkip', name: 'CalkIP', version: '1.0.0', file: 'V3Redis-0.13.2-app-calkip-win-x64.zip', size: 1234, sha512: SHA };

test('noms des fichiers et adresse de la release', () => {
  assert.equal(Packs.packFileName('V3Redis', '0.13.2', 'calkip'), 'V3Redis-0.13.2-app-calkip-win-x64.zip');
  assert.equal(Packs.manifestFileName('V3Redis', '0.13.2'), 'V3Redis-0.13.2-apps-win-x64.json');
  assert.equal(Packs.releaseBase({ owner: 'WaynneK', repo: 'V3Redis', version: '0.13.2' }), 'https://github.com/WaynneK/V3Redis/releases/download/v0.13.2/');
  assert.equal(Packs.releaseBase({ owner: 'o', repo: 'r', version: '1', override: 'http://127.0.0.1:9/x' }), 'http://127.0.0.1:9/x/');
  assert.equal(Packs.REG_KEY, 'Software\\V3Redis\\Applications');
});

test('findPack : paquet valide', () => {
  assert.deepEqual(Packs.findPack(manifest([pack]), 'calkip', '0.13.2'), { ...pack, unpacked: null });
  assert.deepEqual(Packs.findPack({ apps: [pack] }, 'calkip', '0.13.2'), { ...pack, unpacked: null }); // liste sans version : acceptée
});

test('findPack : liste altérée ou incomplète refusée (aucun chemin ni adresse hors de la release)', () => {
  assert.throws(() => Packs.findPack(null, 'calkip'), /illisible/);
  assert.throws(() => Packs.findPack(manifest([pack], '0.12.0'), 'calkip', '0.13.2'), /version 0\.12\.0/);
  assert.throws(() => Packs.findPack(manifest([pack]), 'predf', '0.13.2'), /absente/);
  for (const file of ['../evil.zip', 'a/b.zip', 'C:\\x.zip', 'x.exe', 'https://e.vil/x.zip']) {
    assert.throws(() => Packs.findPack(manifest([{ ...pack, file }]), 'calkip'), /Nom de paquet invalide/, file);
  }
  assert.throws(() => Packs.findPack(manifest([{ ...pack, size: -1 }]), 'calkip'), /Taille/);
  assert.throws(() => Packs.findPack(manifest([{ ...pack, sha512: 'abc' }]), 'calkip'), /Empreinte/);
});
test('overallPercent : téléchargement puis extraction, toujours croissant, 100 à la fin', () => {
  const P = Packs.overallPercent;
  const u = 300;
  const seq = [
    P({ phase: 'prepare', unpacked: u }),
    P({ phase: 'download', received: 0, total: 100, unpacked: u }),
    P({ phase: 'download', received: 50, total: 100, unpacked: u }),
    P({ phase: 'download', received: 100, total: 100, unpacked: u }),
    P({ phase: 'extract', extracted: 150, unpacked: u }),
    P({ phase: 'extract', extracted: 300, unpacked: u }),
    P({ phase: 'finish', unpacked: u }),
    P({ phase: 'done', unpacked: u }),
  ];
  assert.deepEqual(seq, [0, 0, 35, 70, 84, 99, 99, 100]);
  // Taille extraite inconnue : le téléchargement compte pour presque tout
  assert.equal(P({ phase: 'download', received: 100, total: 100 }), 95);
  assert.equal(P({ phase: 'extract', extracted: 10 }), 95);
  // Valeurs incohérentes bornées
  assert.equal(P({ phase: 'download', received: 500, total: 100, unpacked: u }), 70);
  assert.equal(P({ phase: 'extract', extracted: 9999, unpacked: u }), 99);
});

test('findPack : taille extraite facultative, ignorée si invalide', () => {
  const p = { id: 'calkip', file: 'a.zip', size: 10, sha512: `${'A'.repeat(86)}==` };
  assert.equal(Packs.findPack({ apps: [{ ...p, unpacked: 1234 }] }, 'calkip').unpacked, 1234);
  assert.equal(Packs.findPack({ apps: [{ ...p, unpacked: -3 }] }, 'calkip').unpacked, null);
  assert.equal(Packs.findPack({ apps: [p] }, 'calkip').unpacked, null);
});

// --- pipeToFile : téléchargement → fichier (lecteur et flux d'écriture simulés, aucun accès réseau) ---------
const { Writable } = require('node:stream');

/** Lecteur de ReadableStream simulé : morceaux donnés, puis fin (ou erreur). */
function fakeReader(chunks, { failAt = -1 } = {}) {
  let i = 0;
  const r = {
    cancelled: null,
    async read() {
      if (i === failAt) throw new Error('connexion perdue');
      if (i >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: Buffer.from(chunks[i++]) };
    },
    async cancel(reason) {
      r.cancelled = reason || true;
    },
  };
  return r;
}

/** Flux d'écriture : conserve les octets, ou échoue à la n-ième écriture (disque plein). */
function sink({ failOnWrite = 0, highWaterMark = 16 } = {}) {
  let n = 0;
  const out = new Writable({
    highWaterMark,
    write(chunk, _enc, cb) {
      n++;
      if (failOnWrite && n >= failOnWrite) return setImmediate(() => cb(Object.assign(new Error('ENOSPC: plus de place'), { code: 'ENOSPC' })));
      out.data = Buffer.concat([out.data, chunk]);
      setImmediate(cb);
    },
  });
  out.data = Buffer.alloc(0);
  return out;
}

test('pipeToFile : copie complète, progression et nombre d\'octets', async () => {
  const out = sink({ highWaterMark: 2 }); // contre-pression : attente de « drain »
  const seen = [];
  const got = await Packs.pipeToFile(fakeReader(['abc', 'defg', 'hi']), out, 9, (chunk, received) => seen.push([String(chunk), received]));
  assert.equal(got, 9);
  assert.equal(String(out.data), 'abcdefghi');
  assert.deepEqual(seen, [['abc', 3], ['defg', 7], ['hi', 9]]);
});

test('pipeToFile : erreur d\'écriture → rejet (pas d\'exception non gérée, pas d\'attente sans fin), lecture annulée, fichier fermé', { timeout: 5000 }, async () => {
  const reader = fakeReader(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd']);
  const out = sink({ failOnWrite: 2, highWaterMark: 4 });
  await assert.rejects(Packs.pipeToFile(reader, out, 1000), /ENOSPC/);
  assert.ok(reader.cancelled, 'téléchargement arrêté');
  assert.ok(out.destroyed && out.closed, 'fichier fermé');
});

test('pipeToFile : erreur à la fermeture du fichier → rejet', { timeout: 5000 }, async () => {
  const out = new Writable({
    write: (_c, _e, cb) => cb(),
    final: (cb) => cb(new Error('EIO: écriture finale impossible')),
  });
  await assert.rejects(Packs.pipeToFile(fakeReader(['abc']), out, 10), /EIO/);
});

test('pipeToFile : paquet plus gros que prévu, ou lecture interrompue → rejet, fichier fermé', { timeout: 5000 }, async () => {
  const big = fakeReader(['12345', '67890']);
  const out = sink();
  await assert.rejects(Packs.pipeToFile(big, out, 6), /plus gros que prévu/);
  assert.ok(big.cancelled);
  assert.ok(out.destroyed);
  const lost = sink();
  await assert.rejects(Packs.pipeToFile(fakeReader(['abc', 'def'], { failAt: 1 }), lost, 100), /connexion perdue/);
  assert.ok(lost.destroyed);
});