'use strict';
/*
 * Tests de lib/export.js : préparation des exports (compute, header) et écriture sûre des fichiers
 * (fichier temporaire renommé à la fin, cible intacte en cas d'erreur ou d'annulation).
 * Les fichiers sont écrits dans un dossier temporaire supprimé à la fin.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../lib/export.js');

const { describe, it, before, after } = test;

const base = { input: '192.168.1.10/24', mode: 'auto' };

describe('compute', () => {
  it('calcule le réseau et la plage DHCP', () => {
    const d = E.compute({ ...base, dhcp: { gateway: 'first' } });
    assert.equal(d.calc.prefix, 24);
    assert.equal(d.pool.leases, 253);
    assert.equal(d.poolError, null);
  });

  it('réglages DHCP invalides : pool = null et poolError, sans lever (passerelle « Autre » vide)', () => {
    const d = E.compute({ ...base, dhcp: { gateway: 'custom', customGateway: '' } });
    assert.equal(d.pool, null);
    assert.equal(d.poolError.name, 'CalcError');
    assert.equal(d.poolError.field, 'gateway');
    assert.equal(d.calc.usable, 254); // la liste des adresses utilisables reste exportable
  });

  it('exclusion invalide : pool = null, erreur sur le champ exclusions', () => {
    const d = E.compute({ ...base, dhcp: { exclusions: '192.168.1.300' } });
    assert.equal(d.pool, null);
    assert.equal(d.poolError.field, 'exclusions');
  });

  it('une adresse invalide lève toujours une erreur', () => {
    assert.throws(() => E.compute({ input: '300.1.1.1', mode: 'auto' }), { name: 'CalcError' });
  });

  it('saisies trop longues : erreur explicite au lieu d\'une troncature silencieuse', () => {
    const L = E.INPUT_LIMITS;
    assert.throws(() => E.compute({ input: `192.168.1.10${' '.repeat(L.input)}`, mode: 'auto' }), { name: 'CalcError', field: 'ip' });
    assert.throws(() => E.compute({ ...base, dhcp: { exclusions: `192.168.1.50${'\n'.repeat(L.exclusions)}` } }), { name: 'CalcError', field: 'exclusions' });
    assert.throws(() => E.compute({ ...base, dhcp: { limit: '1'.repeat(L.limit + 1) } }), { name: 'CalcError', field: 'limit' });
  });

  it('saisies à la taille maximale : acceptées telles quelles', () => {
    const L = E.INPUT_LIMITS;
    // Exclusion placée à la fin d'un texte de longueur maximale : une troncature l'aurait perdue
    const tail = '192.168.1.50';
    const d = E.compute({ ...base, dhcp: { exclusions: `${'\n'.repeat(L.exclusions - tail.length)}${tail}` } });
    assert.equal(d.pool.excludedCount, 1);
    assert.equal(d.pool.leases, 252);
  });
});

describe('header', () => {
  it('sans plage DHCP (réglages invalides) : pas d\'erreur, une remarque explique l\'absence', () => {
    const d = E.compute({ ...base, dhcp: { gateway: 'custom', customGateway: '' } });
    const lines = E.header('résumé du calcul', d);
    assert.ok(lines.some((l) => l.includes('plage DHCP non calculée')));
    assert.ok(!lines.some((l) => l.includes('BAUX DHCP')));
  });

  it('avec plage DHCP : les remarques de la plage sont reprises', () => {
    const d = E.compute({ ...base, dhcp: { limit: '10' } });
    const lines = E.header('résumé du calcul', d);
    assert.ok(lines.some((l) => l.startsWith('Remarque : Plage limitée aux 10 baux')));
  });
});

describe('writeFileSafely', () => {
  let dir;
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calkip-test-'));
    process.on('uncaughtException', onUncaught);
  });
  after(() => {
    process.removeListener('uncaughtException', onUncaught);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = (name) => path.join(dir, name);
  const leftovers = () => fs.readdirSync(dir).filter((n) => n.endsWith('.part'));

  it('écrit le fichier, sans fichier temporaire restant', async () => {
    const target = file('ok.txt');
    await E.writeFileSafely(target, async (write) => {
      await write('ligne 1\r\n');
      await write('ligne 2\r\n');
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'ligne 1\r\nligne 2\r\n');
    assert.deepEqual(leftovers(), []);
  });

  it('respecte la contre-pression : gros volume écrit en entier', async () => {
    const target = file('gros.txt');
    const chunk = 'x'.repeat(1024 * 1024);
    await E.writeFileSafely(target, async (write) => {
      for (let i = 0; i < 8; i++) await write(chunk);
    });
    assert.equal(fs.statSync(target).size, 8 * chunk.length);
  });

  it('remplace un fichier existant seulement à la fin', async () => {
    const target = file('remplace.txt');
    fs.writeFileSync(target, 'ANCIEN');
    await E.writeFileSafely(target, async (write) => {
      await write('NOUVEAU');
      assert.equal(fs.readFileSync(target, 'utf8'), 'ANCIEN'); // pendant l'écriture, la cible est intacte
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'NOUVEAU');
  });

  it('annulation : le fichier existant (remplacement confirmé) est conservé, le temporaire supprimé', async () => {
    const target = file('annule.txt');
    fs.writeFileSync(target, 'DONNÉES DE L\'UTILISATEUR');
    await assert.rejects(
      E.writeFileSafely(target, async (write) => {
        await write('début de liste\r\n');
        throw Object.assign(new Error('Export annulé.'), { canceled: true });
      }),
      { canceled: true }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'DONNÉES DE L\'UTILISATEUR');
    assert.deepEqual(leftovers(), []);
  });

  it('annulation sans fichier existant : rien n\'est laissé sur le disque', async () => {
    const target = file('annule-neuf.txt');
    await assert.rejects(E.writeFileSafely(target, () => Promise.reject(Object.assign(new Error('Export annulé.'), { canceled: true }))), { canceled: true });
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(leftovers(), []);
  });

  it('erreur d\'ouverture arrivée entre deux écritures : promesse rejetée, aucune exception non interceptée', async () => {
    const target = path.join(dir, 'dossier-absent', 'liste.txt');
    await assert.rejects(
      E.writeFileSafely(target, async (write) => {
        await write('en-tête\r\n'); // mis en mémoire : l'ouverture n'a pas encore échoué
        await new Promise((resolve) => setTimeout(resolve, 50)); // l'erreur arrive ici, sans écriture en attente
        await write('suite\r\n');
      }),
      { code: 'ENOENT' }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(uncaught, []);
  });

  it('erreur d\'ouverture avec une seule écriture : rejet propre (cas du résumé)', async () => {
    const target = path.join(dir, 'dossier-absent', 'resume.txt');
    await assert.rejects(E.writeFileSafely(target, (write) => write('résumé\r\n')), { code: 'ENOENT' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(uncaught, []);
  });

  it('cible protégée en écriture : message clair, cible intacte, temporaire supprimé', { skip: process.platform !== 'win32' && 'renommage par-dessus un fichier en lecture seule : refusé seulement sous Windows' }, async () => {
    const target = file('lecture-seule.txt');
    fs.writeFileSync(target, 'PROTÉGÉ');
    fs.chmodSync(target, 0o444); // attribut « lecture seule » sous Windows
    try {
      await assert.rejects(
        E.writeFileSafely(target, (write) => write('remplacement')),
        (err) => err.code === 'EPERM' && /ouvert dans un autre programme|protégé en écriture/.test(err.message)
      );
      assert.equal(fs.readFileSync(target, 'utf8'), 'PROTÉGÉ');
      assert.deepEqual(leftovers(), []);
      assert.deepEqual(uncaught, []);
    } finally {
      fs.chmodSync(target, 0o666);
    }
  });

  it('erreur de l\'export lui-même : temporaire supprimé, erreur transmise', async () => {
    const target = file('incoherent.txt');
    await assert.rejects(
      E.writeFileSafely(target, async (write) => {
        await write('x');
        throw new Error('Incohérence');
      }),
      /Incohérence/
    );
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(leftovers(), []);
  });
});
