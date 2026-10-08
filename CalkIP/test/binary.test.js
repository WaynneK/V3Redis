'use strict';
/*
 * Tests de lib/binary.js (calcul binaire, explication pas à pas, exercices).
 * Les valeurs attendues viennent d'un calcul indépendant (BigInt / chaînes) ou sont écrites à la main.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/ipcalc.js');
const B = require('../lib/binary.js');

const { describe, it } = test;

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const refNetwork = (ip, prefix) => Number((BigInt(ip) >> BigInt(32 - prefix)) << BigInt(32 - prefix));

describe('decompose / sumText', () => {
  it('donne les bons bits et la bonne somme pour les 256 octets', () => {
    for (let v = 0; v <= 255; v++) {
      const d = B.decompose(v);
      assert.equal(d.bits, v.toString(2).padStart(8, '0'));
      assert.equal(d.terms.reduce((a, b) => a + b, 0), v);
      assert.equal(d.steps.length, 8);
      assert.equal(d.steps[7].after, 0, `reste final nul pour ${v}`);
      d.steps.forEach((s, i) => {
        assert.equal(s.weight, 128 >> i);
        assert.equal(s.bit, Number(d.bits[i]));
        assert.equal(s.after, s.before - (s.bit ? s.weight : 0));
      });
    }
  });

  it('écrit les sommes', () => {
    assert.equal(B.sumText(192), '128 + 64');
    assert.equal(B.sumText(168), '128 + 32 + 8');
    assert.equal(B.sumText(0), '0');
    assert.equal(B.sumText(1), '1');
  });

  it('refuse ce qui n\'est pas un octet', () => {
    for (const bad of [-1, 256, 1.5, NaN, '12']) assert.throws(() => B.decompose(bad), C.CalcError);
  });

  it('reconnaît les octets de masque', () => {
    assert.deepEqual(B.MASK_OCTETS.map(B.maskOctetBits), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const bad of [1, 64, 191, 253]) assert.equal(B.maskOctetBits(bad), null);
  });
});

describe('parseBinaryIp', () => {
  const expected = C.parseIp('192.168.1.10');
  it('accepte les écritures courantes', () => {
    for (const s of [
      '11000000.10101000.00000001.00001010',
      '11000000 10101000 00000001 00001010',
      '11000000101010000000000100001010',
      '1100_0000 1010_1000 0000_0001 0000_1010'.replace(/ /g, '.'),
      '11000000.10101000.1.1010',
      '  11000000.10101000.00000001.00001010  ',
    ]) {
      assert.equal(B.parseBinaryIp(s), expected, s);
    }
  });

  it('refuse les saisies invalides', () => {
    for (const s of ['', '1100000010101000', '11000000.10101000.00000001', '11000000.10101000.00000001.000010102', '11000000.10101000.00000001.000010a0', '110000001010100000000001000010100', '1.2.3.4.5']) {
      assert.throws(() => B.parseBinaryIp(s), C.CalcError, s);
    }
  });

  it('fait l\'aller-retour avec toBinary', () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(r() * 2 ** 32);
      assert.equal(B.parseBinaryIp(C.toBinary(n)), n);
      assert.equal(B.parseBinaryIp(B.bits32(n)), n);
    }
  });
});

describe('parseAnyIp / formats', () => {
  it('détecte le format', () => {
    const ip = C.parseIp('192.168.1.10');
    assert.deepEqual(B.parseAnyIp('192.168.1.10'), { value: ip, format: 'decimal' });
    assert.deepEqual(B.parseAnyIp('11000000.10101000.00000001.00001010'), { value: ip, format: 'binary' });
    assert.deepEqual(B.parseAnyIp('0xC0A8010A'), { value: ip, format: 'hex' });
    assert.deepEqual(B.parseAnyIp('0xc0a8010a'), { value: ip, format: 'hex' });
    assert.deepEqual(B.parseAnyIp('C0.A8.01.0A'), { value: ip, format: 'hex' });
    assert.deepEqual(B.parseAnyIp('3232235786'), { value: ip, format: 'integer' });
  });

  it('lit « 1.1.1.1 » et « 10.0.0.1 » en décimal (pas en binaire)', () => {
    assert.deepEqual(B.parseAnyIp('1.1.1.1'), { value: C.parseIp('1.1.1.1'), format: 'decimal' });
    assert.deepEqual(B.parseAnyIp('10.0.0.1'), { value: C.parseIp('10.0.0.1'), format: 'decimal' });
    assert.deepEqual(B.parseAnyIp('0'), { value: 0, format: 'integer' });
    assert.deepEqual(B.parseAnyIp('4294967295'), { value: 4294967295, format: 'integer' });
  });

  it('refuse les saisies invalides', () => {
    for (const s of ['', '4294967296', '0x123456789', 'abc', '256.1.1.1', '192.168.1']) assert.throws(() => B.parseAnyIp(s), C.CalcError, s);
  });

  it('donne toutes les représentations', () => {
    assert.deepEqual(B.formats(C.parseIp('192.168.1.10')), {
      decimal: '192.168.1.10',
      binary: '11000000.10101000.00000001.00001010',
      hex: '0xC0A8010A',
      hexDotted: 'C0.A8.01.0A',
      integer: '3232235786',
    });
    assert.equal(B.formats(0).hex, '0x00000000');
    assert.equal(B.formats(0xffffffff).integer, '4294967295');
  });

  it('chaque représentation se relit en la même adresse', () => {
    const r = rng(11);
    for (let i = 0; i < 1000; i++) {
      const n = Math.floor(r() * 2 ** 32);
      const f = B.formats(n);
      for (const key of ['decimal', 'binary', 'hex', 'integer']) assert.equal(B.parseAnyIp(f[key]).value, n, `${key} ${f[key]}`);
    }
  });
});

describe('magic (nombre magique)', () => {
  it('rien à calculer pour les multiples de 8', () => {
    for (const p of [0, 8, 16, 24, 32]) assert.equal(B.magic(C.parseIp('10.1.2.3'), p), null);
  });

  it('exemples écrits à la main', () => {
    const m = B.magic(C.parseIp('192.168.1.10'), 26);
    assert.equal(m.index, 3);
    assert.equal(m.maskOctet, 192);
    assert.equal(m.block, 64);
    assert.equal(m.netOctet, 0);
    assert.equal(m.lastOctet, 63);
    const m2 = B.magic(C.parseIp('172.16.45.3'), 20);
    assert.equal(m2.index, 2);
    assert.equal(m2.maskOctet, 240);
    assert.equal(m2.block, 16);
    assert.equal(m2.quotient, 2);
    assert.equal(m2.remainder, 13);
    assert.equal(m2.netOctet, 32);
    assert.equal(m2.lastOctet, 47);
  });

  it('donne le même réseau que le calcul binaire (tous préfixes, adresses aléatoires)', () => {
    const r = rng(3);
    for (let i = 0; i < 400; i++) {
      const ip = Math.floor(r() * 2 ** 32);
      for (let p = 1; p < 32; p++) {
        const m = B.magic(ip, p);
        if (p % 8 === 0) continue;
        const net = refNetwork(ip, p);
        assert.equal(B.octets(net)[m.index], m.netOctet, `${C.toIp(ip)}/${p}`);
        assert.equal(B.octets(C.calculate(ip, p).lastAddress)[m.index], m.lastOctet);
        assert.equal(m.block, 2 ** (8 - (p % 8)));
      }
    }
  });
});

describe('explain', () => {
  const ip = C.parseIp('192.168.1.10');

  it('9 étapes, pour tous les préfixes', () => {
    for (let p = 0; p <= 32; p++) {
      const { steps } = B.explain(ip, p);
      assert.deepEqual(
        steps.map((s) => s.key),
        ['bases', 'ip', 'mask', 'network', 'broadcast', 'range', 'count', 'magic', 'summary']
      );
      for (const s of steps) {
        assert.ok(s.title && s.short && s.blocks.length, `${p} ${s.key}`);
      }
    }
  });

  it('les lignes de bits « résultat » sont justes', () => {
    const r = rng(5);
    for (let i = 0; i < 150; i++) {
      const n = Math.floor(r() * 2 ** 32);
      const p = Math.floor(r() * 33);
      const c = C.calculate(n, p);
      const { steps } = B.explain(n, p);
      const bits = (key) => steps.find((s) => s.key === key).blocks.filter((b) => b.type === 'bits');
      const net = bits('network')[0].rows;
      assert.equal(net[2].value, refNetwork(n, p));
      assert.equal(net[2].value, (net[0].value & net[1].value) >>> 0);
      const [notRows, orRows] = bits('broadcast').map((b) => b.rows);
      assert.equal(notRows[1].value, ~notRows[0].value >>> 0);
      assert.equal(orRows[2].value, (orRows[0].value | orRows[1].value) >>> 0);
      assert.equal(orRows[2].value, c.lastAddress);
    }
  });

  it('les décompositions de l\'étape 2 sont celles des 4 octets', () => {
    const d = B.explain(ip, 24).steps[1].blocks.filter((b) => b.type === 'decompose');
    assert.deepEqual(d.map((b) => b.value), [192, 168, 1, 10]);
    assert.deepEqual(d.map((b) => b.bits), ['11000000', '10101000', '00000001', '00001010']);
  });

  it('cas particuliers /31 et /32', () => {
    const s31 = B.explain(ip, 31).steps;
    assert.ok(s31.find((s) => s.key === 'range').blocks.some((b) => b.type === 'p' && b.text.includes('RFC 3021')));
    const s32 = B.explain(ip, 32).steps;
    assert.ok(s32.find((s) => s.key === 'range').blocks.some((b) => b.type === 'result' && b.items[0].value === '192.168.1.10'));
  });

  it('signale une adresse réseau ou de diffusion', () => {
    const note = (text, p) => B.explain(C.parseIp(text), p).steps.at(-1).blocks.find((b) => b.type === 'note');
    assert.equal(note('192.168.1.0', 24).level, 'warn');
    assert.equal(note('192.168.1.255', 24).level, 'warn');
    assert.equal(note('192.168.1.7', 24).level, 'tip');
  });
});

describe('explainLines (texte)', () => {
  it('texte complet, sans valeur manquante, pour tous les préfixes', () => {
    const r = rng(9);
    for (let p = 0; p <= 32; p++) {
      const n = Math.floor(r() * 2 ** 32);
      const text = B.explainLines(n, p).join('\n');
      assert.ok(!/undefined|NaN|\[object|null/.test(text), `/${p} : ${text.match(/undefined|NaN|\[object|null/)}`);
      assert.ok(!text.includes('**'), 'pas de marque de gras dans le texte');
      assert.equal((text.match(/^Étape \d\/9 — /gm) || []).length, 9);
      assert.ok(text.includes(`${C.toIp(C.calculate(n, p).network)}/${p}`));
    }
  });

  it('accords au singulier et au pluriel', () => {
    // Lignes recollées : le texte est coupé à 92 colonnes
    const t26 = B.explainLines(C.parseIp('192.168.1.10'), 26).join(' ');
    assert.ok(t26.includes('26 premiers bits'));
    assert.ok(t26.includes('6 derniers bits'));
    const t31 = B.explainLines(C.parseIp('192.168.1.10'), 31).join(' ');
    assert.ok(t31.includes('1 dernier bit '));
  });

  it('marque la limite réseau / hôte', () => {
    assert.equal(B.bitsText(C.parseIp('192.168.1.10'), 26, true), '11000000.10101000.00000001.00|001010');
    assert.equal(B.bitsText(C.parseIp('192.168.1.10'), 24, true), '11000000.10101000.00000001.|00001010');
    assert.equal(B.bitsText(C.parseIp('192.168.1.10'), 26, false), '11000000.10101000.00000001.00001010');
  });
});

describe('exercices', () => {
  it('respectent le niveau demandé', () => {
    const r = rng(1);
    for (let i = 0; i < 500; i++) {
      const f = B.makeExercise('facile', r);
      assert.ok([8, 16, 24].includes(f.prefix));
      const m = B.makeExercise('moyen', r);
      assert.ok(m.prefix >= 17 && m.prefix <= 30);
      assert.equal(C.addressType(m.ip).kind, 'private', C.toIp(m.ip));
      const e = B.makeExercise('expert', r);
      assert.ok(e.prefix >= 9 && e.prefix <= 30);
      assert.ok(['A', 'B', 'C'].includes(C.ipClass(e.ip)));
      assert.notEqual(e.ip >>> 24, 127);
      for (const ex of [f, m, e]) assert.equal(C.calculate(ex.ip, ex.prefix).role, 'host');
    }
  });

  it('corrige les réponses', () => {
    const ex = { ip: C.parseIp('172.16.45.3'), prefix: 20 };
    const good = { mask: '255.255.240.0', network: '172.16.32.0', broadcast: '172.16.47.255', first: '172.16.32.1', last: '172.16.47.254', hosts: '4 094' };
    const res = B.checkExercise(ex, good);
    assert.equal(res.score, 6);
    assert.equal(res.total, 6);
    const bad = B.checkExercise(ex, { ...good, network: '172.16.0.0', hosts: '4096', first: '' , last: '300.1.1.1' });
    assert.equal(bad.score, 2);
    assert.equal(bad.fields.network.ok, false);
    assert.equal(bad.fields.network.expected, '172.16.32.0');
    assert.equal(bad.fields.first.empty, true);
    assert.ok(bad.fields.last.error);
    assert.equal(bad.fields.hosts.expected, '4 094');
  });
});
