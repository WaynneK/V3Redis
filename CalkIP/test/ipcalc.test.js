'use strict';
/*
 * Suite de tests indépendante et « adversariale » pour lib/ipcalc.js.
 *
 * Les valeurs attendues sont calculées à la main ou par une petite implémentation de
 * référence en BigInt définie ci-dessous (jamais recopiées depuis la sortie de la bibliothèque).
 * Lancement : npm test (ou node --test) depuis le dossier CalkIP
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/ipcalc.js');

const { describe, it } = test;

// ---------------------------------------------------------------------------
// Implémentation de référence (BigInt), indépendante de la bibliothèque
// ---------------------------------------------------------------------------
const ALL = (1n << 32n) - 1n;

/** « a.b.c.d » → nombre, sans aucune tolérance (référence stricte). */
function refIp(s) {
  const p = s.split('.').map((x) => BigInt(parseInt(x, 10)));
  return Number((p[0] << 24n) | (p[1] << 16n) | (p[2] << 8n) | p[3]);
}
/** nombre → « a.b.c.d » */
function refStr(n) {
  const b = BigInt(n);
  return [(b >> 24n) & 255n, (b >> 16n) & 255n, (b >> 8n) & 255n, b & 255n].join('.');
}
/** Masque du préfixe p (0..32) */
function refMask(p) {
  return Number(ALL ^ ((1n << BigInt(32 - p)) - 1n));
}
/** Réseau, dernière adresse, taille d'un bloc */
function refNet(ip, p) {
  const m = BigInt(refMask(p));
  const net = BigInt(ip) & m;
  const last = net | (ALL ^ m);
  return { network: Number(net), last: Number(last), size: Number(1n << BigInt(32 - p)) };
}

/** Vérifie qu'une fonction lève bien une CalcError */
function throwsCalc(fn, msg) {
  assert.throws(fn, (e) => {
    assert.equal(e.name, 'CalcError', `nom d'erreur inattendu : ${e && e.name} (${e && e.message})`);
    assert.ok(e instanceof C.CalcError);
    assert.ok(e instanceof Error);
    return true;
  }, msg);
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) pour les tests de propriétés */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

/** Compte les adresses émises par forEachAddress */
function countEmitted(start, end, excluded) {
  let n = 0;
  C.forEachAddress(start, end, excluded, () => { n++; });
  return n;
}

const ip = (s) => refIp(s);

// ---------------------------------------------------------------------------
describe('parseIp', () => {
  it('lit des adresses valides', () => {
    assert.equal(C.parseIp('192.168.1.10'), 3232235786); // 192*2^24 + 168*2^16 + 1*256 + 10
    assert.equal(C.parseIp('10.0.0.1'), 167772161);
    assert.equal(C.parseIp('172.16.5.4'), 2886731012); // 172*2^24 + 16*2^16 + 5*256 + 4
    assert.equal(C.parseIp('1.2.3.4'), 16909060);
  });

  it('accepte 0.0.0.0 et 255.255.255.255', () => {
    assert.equal(C.parseIp('0.0.0.0'), 0);
    assert.equal(C.parseIp('255.255.255.255'), 4294967295);
  });

  it('renvoie toujours un entier non signé (jamais négatif)', () => {
    for (const s of ['128.0.0.0', '200.1.2.3', '255.255.255.254']) {
      const v = C.parseIp(s);
      assert.ok(v >= 0 && Number.isInteger(v), `${s} → ${v}`);
      assert.equal(v, refIp(s));
    }
  });

  it('lit les zéros en tête en décimal (pas en octal)', () => {
    assert.equal(C.parseIp('010.001.1.1'), 10 * 2 ** 24 + 1 * 2 ** 16 + 256 + 1);
    assert.equal(C.toIp(C.parseIp('010.001.1.1')), '10.1.1.1');
    assert.equal(C.parseIp('000.000.000.000'), 0);
    assert.equal(C.toIp(C.parseIp('192.168.001.008')), '192.168.1.8'); // « 008 » serait invalide en octal
  });

  it('tolère les espaces autour de l\'adresse', () => {
    assert.equal(C.parseIp('  192.168.1.10\t'), 3232235786);
  });

  const invalides = [
    ['3 octets', '1.2.3'],
    ['5 octets', '1.2.3.4.5'],
    ['octet 256', '256.1.1.1'],
    ['dernier octet 256', '1.2.3.256'],
    ['octet négatif', '-1.2.3.4'],
    ['octet négatif à la fin', '1.2.3.-4'],
    ['lettres', 'a.b.c.d'],
    ['une lettre', '1.2.3.x'],
    ['chaîne vide', ''],
    ['espaces seuls', '   '],
    ['espace interne', '1. 2.3.4'],
    ['espace entre deux nombres', '1.2.3.4 5'],
    ['IPv6 ::1', '::1'],
    ['IPv6 mappée', '::ffff:1.2.3.4'],
    ['point final', '1.2.3.4.'],
    ['point initial', '.1.2.3'],
    ['octet vide', '1..2.3'],
    ['signe plus', '1.2.3.+4'],
    ['notation exponentielle', '1e2.1.1.1'],
    ['hexadécimal', '0x1.1.1.1'],
    ['4 chiffres', '0001.1.1.1'],
    ['nombre seul', '3232235786'],
    ['chiffres non ASCII (arabes)', '١.2.3.4'],
    ['chiffres pleine largeur', '１.2.3.4'],
    ['décimal', '1.2.3.4.5e0'],
  ];
  for (const [nom, v] of invalides) {
    it(`refuse : ${nom} (« ${v} »)`, () => throwsCalc(() => C.parseIp(v)));
  }

  it('refuse null et undefined', () => {
    throwsCalc(() => C.parseIp(null));
    throwsCalc(() => C.parseIp(undefined));
  });
});

// ---------------------------------------------------------------------------
describe('toIp / parseIp (aller-retour)', () => {
  const bords = [
    [0, '0.0.0.0'],
    [1, '0.0.0.1'],
    [255, '0.0.0.255'],
    [256, '0.0.1.0'],
    [2 ** 31 - 1, '127.255.255.255'],
    [2 ** 31, '128.0.0.0'],
    [2 ** 32 - 1, '255.255.255.255'],
  ];
  for (const [n, s] of bords) {
    it(`${n} ↔ ${s}`, () => {
      assert.equal(C.toIp(n), s);
      assert.equal(C.parseIp(s), n);
      assert.equal(C.parseIp(C.toIp(n)), n);
    });
  }

  it('aller-retour sur 2000 valeurs pseudo-aléatoires (contre la référence BigInt)', () => {
    const rnd = prng(42);
    for (let k = 0; k < 2000; k++) {
      const n = rnd();
      assert.equal(C.toIp(n), refStr(n));
      assert.equal(C.parseIp(refStr(n)), n);
    }
  });
});

// ---------------------------------------------------------------------------
describe('prefixToMask / maskToPrefix', () => {
  for (let p = 0; p <= 32; p++) {
    it(`/${p} → ${refStr(refMask(p))} → /${p}`, () => {
      const m = C.prefixToMask(p);
      assert.equal(m, refMask(p));
      assert.ok(m >= 0, 'le masque doit être non signé');
      assert.equal(C.maskToPrefix(m), p);
      assert.equal(C.maskToPrefix(C.parseIp(refStr(refMask(p)))), p);
    });
  }

  it('valeurs connues', () => {
    assert.equal(C.toIp(C.prefixToMask(24)), '255.255.255.0');
    assert.equal(C.toIp(C.prefixToMask(26)), '255.255.255.192');
    assert.equal(C.toIp(C.prefixToMask(12)), '255.240.0.0');
    assert.equal(C.toIp(C.prefixToMask(0)), '0.0.0.0');
    assert.equal(C.toIp(C.prefixToMask(32)), '255.255.255.255');
  });

  for (const m of ['255.0.255.0', '255.255.255.1', '0.255.255.255', '255.255.0.255', '128.0.0.1', '254.255.255.255', '0.0.0.1']) {
    it(`refuse le masque non contigu ${m}`, () => throwsCalc(() => C.maskToPrefix(C.parseIp(m))));
  }

  it('refuse tous les masques non contigus d\'un octet variable (exhaustif sur le 2e octet)', () => {
    const contigus = new Set([0, 128, 192, 224, 240, 248, 252, 254, 255]);
    for (let b = 0; b < 256; b++) {
      const m = ip(`255.${b}.0.0`);
      if (contigus.has(b)) assert.equal(C.maskToPrefix(m), 8 + [0, 128, 192, 224, 240, 248, 252, 254, 255].indexOf(b));
      else throwsCalc(() => C.maskToPrefix(m));
    }
  });
});

// ---------------------------------------------------------------------------
describe('parseInput', () => {
  const ref = ip('192.168.1.10');

  it('adresse seule', () => {
    const r = C.parseInput('192.168.1.10');
    assert.equal(r.ip, ref);
    assert.equal(r.prefix, null);
  });

  it('notation CIDR « /26 »', () => {
    const r = C.parseInput('192.168.1.10/26');
    assert.equal(r.ip, ref);
    assert.equal(r.prefix, 26);
    assert.equal(r.source, 'cidr');
  });

  it('CIDR avec espace avant le « / »', () => {
    const r = C.parseInput('192.168.1.10 /26');
    assert.equal(r.ip, ref);
    assert.equal(r.prefix, 26);
  });

  it('CIDR avec espaces autour du « / »', () => {
    const r = C.parseInput('  192.168.1.10 / 26  ');
    assert.equal(r.ip, ref);
    assert.equal(r.prefix, 26);
  });

  it('masque séparé par un espace', () => {
    const r = C.parseInput('192.168.1.10 255.255.255.192');
    assert.equal(r.ip, ref);
    assert.equal(r.prefix, 26);
    assert.equal(r.source, 'mask');
  });

  it('masque après un « / »', () => {
    const r = C.parseInput('192.168.1.10/255.255.255.192');
    assert.equal(r.ip, ref);
    assert.equal(r.prefix, 26);
    assert.equal(r.source, 'mask');
  });

  it('préfixes extrêmes /0 et /32', () => {
    assert.equal(C.parseInput('1.2.3.4/0').prefix, 0);
    assert.equal(C.parseInput('1.2.3.4/32').prefix, 32);
    assert.equal(C.parseInput('1.2.3.4 0.0.0.0').prefix, 0);
    assert.equal(C.parseInput('1.2.3.4 255.255.255.255').prefix, 32);
  });

  for (const bad of ['192.168.1.10/33', '192.168.1.10/-1', '192.168.1.10/abc', '192.168.1.10/99',
    '192.168.1.10/255.0.255.0', '192.168.1.10/256.255.255.0', '192.168.1.10/24/25', '', '   ',
    '300.1.1.1/24', '::1/128', '192.168.1.10/2 4']) {
    it(`refuse « ${bad} »`, () => throwsCalc(() => C.parseInput(bad)));
  }
});

// ---------------------------------------------------------------------------
describe('ipClass / classfulPrefix', () => {
  const cas = [
    ['0.0.0.0', 'A', 8],
    ['127.255.255.255', 'A', 8],
    ['128.0.0.0', 'B', 16],
    ['191.255.255.255', 'B', 16],
    ['192.0.0.0', 'C', 24],
    ['223.255.255.255', 'C', 24],
    ['224.0.0.0', 'D', null],
    ['239.255.255.255', 'D', null],
    ['239.1.2.3', 'D', null],
    ['240.0.0.0', 'E', null],
    ['255.255.255.255', 'E', null],
  ];
  for (const [s, cls, p] of cas) {
    it(`${s} → classe ${cls}, /${p}`, () => {
      assert.equal(C.ipClass(ip(s)), cls);
      assert.equal(C.classfulPrefix(ip(s)), p);
    });
  }
});

// ---------------------------------------------------------------------------
describe('addressType', () => {
  const cas = [
    ['10.0.0.0', 'private'],
    ['10.255.255.255', 'private'],
    ['9.255.255.255', 'public'],
    ['11.0.0.0', 'public'],
    ['172.16.0.0', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.0', 'public'],
    ['172.15.255.255', 'public'],
    ['192.168.0.0', 'private'],
    ['192.168.255.255', 'private'],
    ['192.169.0.0', 'public'],
    ['192.167.255.255', 'public'],
    ['100.63.255.255', 'public'],
    ['100.64.0.0', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.128.0.0', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['169.254.0.1', 'linklocal'],
    ['169.254.255.255', 'linklocal'],
    ['169.253.255.255', 'public'],
    ['169.255.0.0', 'public'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.0', 'reserved'],
    ['255.255.255.254', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['192.0.2.1', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.255', 'documentation'],
    ['192.0.3.0', 'public'],
    ['203.0.114.0', 'public'],
    ['198.18.0.0', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['198.17.255.255', 'public'],
    ['198.20.0.0', 'public'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['0.0.0.0', 'thisnetwork'],
    ['0.255.255.255', 'thisnetwork'],
    ['1.0.0.0', 'public'],
  ];
  for (const [s, kind] of cas) {
    it(`${s} → ${kind}`, () => {
      const t = C.addressType(ip(s));
      assert.equal(t.kind, kind);
      assert.equal(typeof t.label, 'string');
      if (kind === 'public') assert.equal(t.range, null);
      else assert.equal(typeof t.range, 'string');
    });
  }

  it('la plage annoncée contient bien l\'adresse', () => {
    for (const s of ['172.20.1.1', '100.100.1.1', '198.19.0.1', '192.0.2.200', '10.1.2.3']) {
      const t = C.addressType(ip(s));
      const [base, p] = t.range.split('/');
      assert.equal(refNet(ip(s), Number(p)).network, ip(base), `${s} hors de ${t.range}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('resolvePrefix', () => {
  it('auto + préfixe saisi', () => {
    assert.equal(C.resolvePrefix(C.parseInput('10.1.2.3/20'), 'auto').prefix, 20);
  });
  it('auto + masque saisi', () => {
    assert.equal(C.resolvePrefix(C.parseInput('10.1.2.3 255.255.252.0'), 'auto').prefix, 22);
  });
  it('auto sans préfixe : classe A, B, C', () => {
    assert.equal(C.resolvePrefix(C.parseInput('10.1.2.3'), 'auto').prefix, 8);
    assert.equal(C.resolvePrefix(C.parseInput('172.16.5.4'), 'auto').prefix, 16);
    assert.equal(C.resolvePrefix(C.parseInput('192.168.1.10'), 'auto').prefix, 24);
  });
  it('mode absent (undefined / null) = auto', () => {
    assert.equal(C.resolvePrefix(C.parseInput('172.16.5.4')).prefix, 16);
    assert.equal(C.resolvePrefix(C.parseInput('172.16.5.4'), null).prefix, 16);
  });
  it('auto refusé pour les classes D et E', () => {
    throwsCalc(() => C.resolvePrefix(C.parseInput('224.0.0.1'), 'auto'));
    throwsCalc(() => C.resolvePrefix(C.parseInput('239.255.255.255'), 'auto'));
    throwsCalc(() => C.resolvePrefix(C.parseInput('240.0.0.0'), 'auto'));
    throwsCalc(() => C.resolvePrefix(C.parseInput('255.255.255.255'), 'auto'));
  });
  it('classe D acceptée si un préfixe est saisi', () => {
    assert.equal(C.resolvePrefix(C.parseInput('224.0.0.1/4'), 'auto').prefix, 4);
  });
  it('modes numériques 8, 16, 24, 32 (priment sur le préfixe saisi)', () => {
    for (const p of [8, 16, 24, 32]) {
      assert.equal(C.resolvePrefix(C.parseInput('192.168.1.10/26'), p).prefix, p);
    }
    assert.equal(C.resolvePrefix(C.parseInput('224.0.0.1'), 0).prefix, 0);
  });
  it('modes en texte « 24 » et « /24 »', () => {
    assert.equal(C.resolvePrefix(C.parseInput('10.0.0.1'), '24').prefix, 24);
    assert.equal(C.resolvePrefix(C.parseInput('10.0.0.1'), '/24').prefix, 24);
  });
  it('modes invalides', () => {
    for (const m of [33, -1, '33', 'abc', '', 24.5, '/'] ) {
      throwsCalc(() => C.resolvePrefix(C.parseInput('10.0.0.1'), m), `mode ${m}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('calculate', () => {
  /** Vérifie les champs principaux contre des valeurs écrites en clair */
  function check(input, prefix, exp) {
    const c = C.calculate(ip(input), prefix);
    for (const [k, v] of Object.entries(exp)) {
      const got = c[k];
      const isAddr = ['network', 'broadcast', 'firstHost', 'lastHost', 'wildcard', 'mask', 'previousNetwork', 'nextNetwork', 'lastAddress'].includes(k);
      if (isAddr && v !== null) assert.equal(got, ip(v), `${input}/${prefix} ${k} : attendu ${v}, obtenu ${got === null ? null : C.toIp(got)}`);
      else assert.equal(got, v, `${input}/${prefix} ${k}`);
    }
    return c;
  }

  it('192.168.1.10/24', () => {
    check('192.168.1.10', 24, {
      network: '192.168.1.0', broadcast: '192.168.1.255', firstHost: '192.168.1.1', lastHost: '192.168.1.254',
      total: 256, usable: 254, wildcard: '0.0.0.255', mask: '255.255.255.0', role: 'host', offset: 10,
      previousNetwork: '192.168.0.0', nextNetwork: '192.168.2.0',
      reverseZone: '1.168.192.in-addr.arpa', reverseZoneExact: true, ipClass: 'C', classfulPrefix: 24,
    });
  });

  it('192.168.1.0/24 : adresse réseau', () => {
    check('192.168.1.0', 24, { role: 'network', offset: 0, reverseZone: '1.168.192.in-addr.arpa' });
  });
  it('192.168.1.255/24 : adresse de diffusion', () => {
    check('192.168.1.255', 24, { role: 'broadcast', offset: 255 });
  });

  it('10.20.30.40/8', () => {
    check('10.20.30.40', 8, {
      network: '10.0.0.0', broadcast: '10.255.255.255', firstHost: '10.0.0.1', lastHost: '10.255.255.254',
      total: 16777216, usable: 16777214, wildcard: '0.255.255.255', role: 'host', offset: 20 * 65536 + 30 * 256 + 40,
      previousNetwork: '9.0.0.0', nextNetwork: '11.0.0.0', reverseZone: '10.in-addr.arpa', reverseZoneExact: true,
    });
  });

  it('172.16.5.4/16', () => {
    const c = check('172.16.5.4', 16, {
      network: '172.16.0.0', broadcast: '172.16.255.255', firstHost: '172.16.0.1', lastHost: '172.16.255.254',
      total: 65536, usable: 65534, wildcard: '0.0.255.255', role: 'host', offset: 5 * 256 + 4,
      previousNetwork: '172.15.0.0', nextNetwork: '172.17.0.0', reverseZone: '16.172.in-addr.arpa', reverseZoneExact: true,
    });
    assert.equal(c.type.kind, 'private');
  });

  it('192.168.1.10/32 : un seul hôte, sans diffusion', () => {
    check('192.168.1.10', 32, {
      network: '192.168.1.10', broadcast: null, firstHost: '192.168.1.10', lastHost: '192.168.1.10',
      total: 1, usable: 1, wildcard: '0.0.0.0', role: 'host', offset: 0,
      previousNetwork: '192.168.1.9', nextNetwork: '192.168.1.11',
      reverseZone: '10.1.168.192.in-addr.arpa', reverseZoneExact: true,
    });
  });

  it('192.168.1.10/31 : liaison point à point (RFC 3021)', () => {
    check('192.168.1.10', 31, {
      network: '192.168.1.10', broadcast: null, firstHost: '192.168.1.10', lastHost: '192.168.1.11',
      total: 2, usable: 2, wildcard: '0.0.0.1', role: 'host', offset: 0,
      previousNetwork: '192.168.1.8', nextNetwork: '192.168.1.12', reverseZoneExact: false,
    });
    check('192.168.1.11', 31, { network: '192.168.1.10', role: 'host', offset: 1, broadcast: null });
  });

  it('/30 : .8/.9/.10/.11', () => {
    check('192.168.1.9', 30, {
      network: '192.168.1.8', broadcast: '192.168.1.11', firstHost: '192.168.1.9', lastHost: '192.168.1.10',
      total: 4, usable: 2, wildcard: '0.0.0.3', role: 'host', offset: 1,
      previousNetwork: '192.168.1.4', nextNetwork: '192.168.1.12', reverseZoneExact: false,
    });
    check('192.168.1.8', 30, { role: 'network' });
    check('192.168.1.11', 30, { role: 'broadcast', offset: 3 });
  });

  it('/0 : tout l\'espace IPv4', () => {
    check('192.168.1.10', 0, {
      network: '0.0.0.0', broadcast: '255.255.255.255', firstHost: '0.0.0.1', lastHost: '255.255.255.254',
      total: 2 ** 32, usable: 2 ** 32 - 2, wildcard: '255.255.255.255', mask: '0.0.0.0', role: 'host',
      offset: ip('192.168.1.10'), previousNetwork: null, nextNetwork: null, reverseZone: 'in-addr.arpa', reverseZoneExact: true,
    });
    check('0.0.0.0', 0, { role: 'network' });
    check('255.255.255.255', 0, { role: 'broadcast', offset: 2 ** 32 - 1 });
  });

  it('255.255.255.255/32 : dernière adresse', () => {
    check('255.255.255.255', 32, {
      network: '255.255.255.255', broadcast: null, firstHost: '255.255.255.255', lastHost: '255.255.255.255',
      total: 1, usable: 1, role: 'host', offset: 0, previousNetwork: '255.255.255.254', nextNetwork: null,
      reverseZone: '255.255.255.255.in-addr.arpa', reverseZoneExact: true,
    });
  });

  it('0.0.0.0/8 : premier bloc', () => {
    const c = check('0.0.0.0', 8, {
      network: '0.0.0.0', broadcast: '0.255.255.255', firstHost: '0.0.0.1', lastHost: '0.255.255.254',
      total: 2 ** 24, usable: 2 ** 24 - 2, role: 'network', offset: 0,
      previousNetwork: null, nextNetwork: '1.0.0.0', reverseZone: '0.in-addr.arpa', reverseZoneExact: true,
    });
    assert.equal(c.type.kind, 'thisnetwork');
  });

  it('255.255.255.0/24 : nextNetwork null, previousNetwork 255.255.254.0', () => {
    check('255.255.255.7', 24, { nextNetwork: null, previousNetwork: '255.255.254.0', broadcast: '255.255.255.255' });
  });

  it('toutes les valeurs numériques sont des entiers non signés', () => {
    const c = C.calculate(ip('200.1.2.3'), 1);
    for (const k of ['ip', 'mask', 'wildcard', 'network', 'broadcast', 'lastAddress', 'firstHost', 'lastHost', 'previousNetwork']) {
      assert.ok(Number.isInteger(c[k]) && c[k] >= 0 && c[k] <= 2 ** 32 - 1, `${k} = ${c[k]}`);
    }
    assert.equal(c.network, ip('128.0.0.0'));
    assert.equal(c.previousNetwork, 0);
    assert.equal(c.nextNetwork, null);
  });

  it('propriétés : 300 adresses aléatoires × tous les préfixes (référence BigInt)', () => {
    const rnd = prng(7);
    for (let k = 0; k < 300; k++) {
      const a = rnd();
      for (let p = 0; p <= 32; p++) {
        const r = refNet(a, p);
        const c = C.calculate(a, p);
        const tag = `${refStr(a)}/${p}`;
        assert.equal(c.network, r.network, tag);
        assert.equal(c.lastAddress, r.last, tag);
        assert.equal(c.total, r.size, tag);
        assert.equal(c.mask, refMask(p), tag);
        assert.equal(c.wildcard, Number(ALL ^ BigInt(refMask(p))), tag);
        assert.equal(c.offset, a - r.network, tag);
        assert.equal(c.broadcast, p <= 30 ? r.last : null, tag);
        assert.equal(c.firstHost, p <= 30 ? r.network + 1 : r.network, tag);
        assert.equal(c.lastHost, p <= 30 ? r.last - 1 : r.last, tag);
        assert.equal(c.previousNetwork, r.network === 0 ? null : r.network - r.size, tag);
        assert.equal(c.nextNetwork, r.last === 2 ** 32 - 1 ? null : r.last + 1, tag);
        const role = p >= 31 ? 'host' : a === r.network ? 'network' : a === r.last ? 'broadcast' : 'host';
        assert.equal(c.role, role, tag);
        assert.equal(c.reverseZoneExact, p % 8 === 0, tag);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('usableCount', () => {
  for (let p = 0; p <= 32; p++) {
    const exp = p === 32 ? 1 : p === 31 ? 2 : Number((1n << BigInt(32 - p)) - 2n);
    it(`/${p} → ${exp}`, () => assert.equal(C.usableCount(p), exp));
  }
});

// ---------------------------------------------------------------------------
describe('prefixForHosts', () => {
  const cas = [
    [1, 32], [2, 31], [3, 29], [6, 29], [7, 28], [14, 28], [15, 27], [62, 26], [63, 25],
    [254, 24], [255, 23], [510, 23], [511, 22], [65534, 16], [65535, 15],
    [16777214, 8], [16777215, 7], [2 ** 31 - 2, 1], [2 ** 31 - 1, 0], [2 ** 32 - 2, 0],
  ];
  for (const [h, p] of cas) {
    it(`${h} hôte(s) → /${p}`, () => assert.equal(C.prefixForHosts(h), p));
  }

  it('cohérent avec usableCount : plus petit réseau suffisant (exhaustif sur les puissances de 2 ± 1)', () => {
    // Référence : plus grand p tel que usable(p) ≥ h
    const usable = (p) => (p === 32 ? 1 : p === 31 ? 2 : 2 ** (32 - p) - 2);
    const refP = (h) => { for (let p = 32; p >= 0; p--) if (usable(p) >= h) return p; return null; };
    for (let e = 1; e < 32; e++) {
      for (const h of [2 ** e - 3, 2 ** e - 2, 2 ** e - 1, 2 ** e, 2 ** e + 1]) {
        if (h < 1) continue;
        assert.equal(C.prefixForHosts(h), refP(h), `${h} hôtes`);
      }
    }
  });

  it('accepte un nombre sous forme de texte', () => {
    assert.equal(C.prefixForHosts('254'), 24);
  });

  for (const bad of [0, -1, 1.5, 'abc', 2 ** 32, 2 ** 32 - 1, NaN, Infinity, '', null, undefined]) {
    it(`refuse ${String(bad)}`, () => throwsCalc(() => C.prefixForHosts(bad)));
  }
});

// ---------------------------------------------------------------------------
describe('parseExclusions', () => {
  it('adresse unique', () => {
    assert.deepEqual(C.parseExclusions('192.168.1.50'), [[ip('192.168.1.50'), ip('192.168.1.50')]]);
  });
  it('plage complète avec « - »', () => {
    assert.deepEqual(C.parseExclusions('192.168.1.50-192.168.1.60'), [[ip('192.168.1.50'), ip('192.168.1.60')]]);
    assert.deepEqual(C.parseExclusions('192.168.1.50 - 192.168.1.60'), [[ip('192.168.1.50'), ip('192.168.1.60')]]);
  });
  it('plage courte « 192.168.1.50-60 »', () => {
    assert.deepEqual(C.parseExclusions('192.168.1.50-60'), [[ip('192.168.1.50'), ip('192.168.1.60')]]);
  });
  it('plage courte sur le dernier octet uniquement (pas d\'effet de bord sur les autres)', () => {
    assert.deepEqual(C.parseExclusions('10.200.255.0-255'), [[ip('10.200.255.0'), ip('10.200.255.255')]]);
    assert.deepEqual(C.parseExclusions('255.255.255.250-255'), [[ip('255.255.255.250'), ip('255.255.255.255')]]);
  });
  it('plage traversant plusieurs octets', () => {
    assert.deepEqual(C.parseExclusions('10.0.0.250-10.0.1.5'), [[ip('10.0.0.250'), ip('10.0.1.5')]]);
  });
  it('séparateurs : retour à la ligne, virgule, point-virgule, CRLF', () => {
    const exp = [[ip('10.0.0.1'), ip('10.0.0.1')], [ip('10.0.0.5'), ip('10.0.0.5')], [ip('10.0.0.9'), ip('10.0.0.9')], [ip('10.0.0.20'), ip('10.0.0.20')]];
    assert.deepEqual(C.parseExclusions('10.0.0.1\n10.0.0.5,10.0.0.9;10.0.0.20'), exp);
    assert.deepEqual(C.parseExclusions('10.0.0.1\r\n10.0.0.5\r\n10.0.0.9 ; 10.0.0.20\r\n'), exp);
  });
  it('commentaires « # » (ligne entière et fin de ligne)', () => {
    assert.deepEqual(C.parseExclusions('# imprimantes\n10.0.0.1 # copieur\n\n#10.0.0.99'), [[ip('10.0.0.1'), ip('10.0.0.1')]]);
  });
  it('un commentaire contenant une virgule ou un point-virgule reste un commentaire', () => {
    // Un « # » commente jusqu'à la fin de la ligne, quels que soient les caractères qui suivent
    assert.deepEqual(C.parseExclusions('10.0.0.1 # copieur, étage 2\n10.0.0.2'), [[ip('10.0.0.1'), ip('10.0.0.2')]]);
    assert.deepEqual(C.parseExclusions('# serveurs ; ne pas toucher\n10.0.0.3'), [[ip('10.0.0.3'), ip('10.0.0.3')]]);
  });
  it('vide, null, undefined → aucune exclusion', () => {
    assert.deepEqual(C.parseExclusions(''), []);
    assert.deepEqual(C.parseExclusions(null), []);
    assert.deepEqual(C.parseExclusions(undefined), []);
    assert.deepEqual(C.parseExclusions(' \n ,, ;\n# rien'), []);
  });
  it('fusion des plages qui se chevauchent', () => {
    assert.deepEqual(C.parseExclusions('10.0.0.10-20, 10.0.0.15-30'), [[ip('10.0.0.10'), ip('10.0.0.30')]]);
    assert.deepEqual(C.parseExclusions('10.0.0.10-50, 10.0.0.20-30'), [[ip('10.0.0.10'), ip('10.0.0.50')]]);
  });
  it('fusion des plages adjacentes', () => {
    assert.deepEqual(C.parseExclusions('10.0.0.10-20, 10.0.0.21-30'), [[ip('10.0.0.10'), ip('10.0.0.30')]]);
    assert.deepEqual(C.parseExclusions('10.0.0.5\n10.0.0.6\n10.0.0.7'), [[ip('10.0.0.5'), ip('10.0.0.7')]]);
  });
  it('pas de fusion avec un trou d\'une adresse', () => {
    assert.deepEqual(C.parseExclusions('10.0.0.10-20, 10.0.0.22-30'), [[ip('10.0.0.10'), ip('10.0.0.20')], [ip('10.0.0.22'), ip('10.0.0.30')]]);
  });
  it('tri des plages dans le désordre (comparaison numérique, pas textuelle)', () => {
    assert.deepEqual(C.parseExclusions('200.0.0.1, 10.0.0.1, 9.0.0.1, 100.0.0.1'),
      [[ip('9.0.0.1'), ip('9.0.0.1')], [ip('10.0.0.1'), ip('10.0.0.1')], [ip('100.0.0.1'), ip('100.0.0.1')], [ip('200.0.0.1'), ip('200.0.0.1')]]);
  });
  it('doublons', () => {
    assert.deepEqual(C.parseExclusions('10.0.0.1,10.0.0.1'), [[ip('10.0.0.1'), ip('10.0.0.1')]]);
  });
  it('plage inversée refusée', () => {
    throwsCalc(() => C.parseExclusions('192.168.1.60-192.168.1.50'));
    throwsCalc(() => C.parseExclusions('192.168.1.60-50'));
  });
  it('fin courte > 255 refusée', () => {
    throwsCalc(() => C.parseExclusions('192.168.1.50-256'));
    throwsCalc(() => C.parseExclusions('192.168.1.50-999'));
  });
  it('entrées invalides refusées', () => {
    for (const bad of ['abc', '192.168.1', '192.168.1.300', '192.168.1.1-', '-192.168.1.1', '192.168.1.1-192.168.1', '::1']) {
      throwsCalc(() => C.parseExclusions(bad), bad);
    }
  });
});

// ---------------------------------------------------------------------------
describe('dhcpPool', () => {
  const c24 = C.calculate(ip('192.168.1.0'), 24);

  it('passerelle « first » : .1, plage .2 → .254, 253 baux', () => {
    const p = C.dhcpPool(c24, { gateway: 'first' });
    assert.equal(p.gateway, ip('192.168.1.1'));
    assert.equal(p.start, ip('192.168.1.2'));
    assert.equal(p.end, ip('192.168.1.254'));
    assert.equal(p.rangeCount, 253);
    assert.equal(p.leases, 253);
    assert.equal(p.excludedCount, 0);
  });

  it('options absentes = passerelle « first »', () => {
    const p = C.dhcpPool(c24);
    assert.equal(p.gateway, ip('192.168.1.1'));
    assert.equal(p.leases, 253);
  });

  it('passerelle « last » : .254, plage .1 → .253', () => {
    const p = C.dhcpPool(c24, { gateway: 'last' });
    assert.equal(p.gateway, ip('192.168.1.254'));
    assert.equal(p.start, ip('192.168.1.1'));
    assert.equal(p.end, ip('192.168.1.253'));
    assert.equal(p.leases, 253);
  });

  it('passerelle « none » : 254 baux', () => {
    const p = C.dhcpPool(c24, { gateway: 'none' });
    assert.equal(p.gateway, null);
    assert.equal(p.start, ip('192.168.1.1'));
    assert.equal(p.end, ip('192.168.1.254'));
    assert.equal(p.leases, 254);
  });

  it('passerelle personnalisée dans le réseau : retirée de la plage', () => {
    const p = C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.100' });
    assert.equal(p.gateway, ip('192.168.1.100'));
    assert.equal(p.start, ip('192.168.1.1'));
    assert.equal(p.end, ip('192.168.1.254'));
    assert.equal(p.leases, 253);
    let vu = false;
    C.forEachAddress(p.start, p.end, p.skip, (a) => { if (a === ip('192.168.1.100')) vu = true; });
    assert.equal(vu, false, 'la passerelle ne doit pas être distribuée');
  });

  it('passerelle personnalisée aux bords de la plage (.1 et .254)', () => {
    assert.equal(C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.1' }).leases, 253);
    assert.equal(C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.254' }).leases, 253);
  });

  it('passerelle personnalisée hors du réseau ou non utilisable : refusée', () => {
    for (const gw of ['192.168.2.1', '192.168.1.0', '192.168.1.255', '10.0.0.1']) {
      throwsCalc(() => C.dhcpPool(c24, { gateway: 'custom', customGateway: gw }), gw);
    }
    throwsCalc(() => C.dhcpPool(c24, { gateway: 'custom', customGateway: 'abc' }));
    throwsCalc(() => C.dhcpPool(c24, { gateway: 'custom' }));
  });

  it('réservations en début et en fin de plage', () => {
    const p = C.dhcpPool(c24, { gateway: 'first', reserveStart: 10, reserveEnd: 5 });
    // .1 passerelle, .2–.11 réservées, .250–.254 réservées → .12 → .249
    assert.equal(p.start, ip('192.168.1.12'));
    assert.equal(p.end, ip('192.168.1.249'));
    assert.equal(p.leases, 249 - 12 + 1);
    assert.equal(p.reserveStart, 10);
    assert.equal(p.reserveEnd, 5);
  });

  it('réservations : valeurs texte, négatives ou décimales', () => {
    assert.equal(C.dhcpPool(c24, { gateway: 'none', reserveStart: '4' }).leases, 250);
    assert.equal(C.dhcpPool(c24, { gateway: 'none', reserveStart: -5 }).leases, 254);
    assert.equal(C.dhcpPool(c24, { gateway: 'none', reserveStart: 2.9 }).leases, 252);
    assert.equal(C.dhcpPool(c24, { gateway: 'none', reserveStart: 'abc' }).leases, 254);
  });

  it('exclusions entièrement dans la plage', () => {
    const p = C.dhcpPool(c24, { gateway: 'first', exclusions: '192.168.1.10\n192.168.1.20-30' });
    assert.equal(p.excludedCount, 1 + 11);
    assert.equal(p.leases, 253 - 12);
  });

  it('exclusion à cheval sur la fin de plage : seule la partie commune compte', () => {
    const p = C.dhcpPool(c24, { gateway: 'first', exclusions: '192.168.1.250-192.168.1.255' });
    // plage .2–.254 ∩ .250–.255 = .250–.254 → 5 adresses
    assert.equal(p.excludedCount, 5);
    assert.equal(p.leases, 248);
    assert.deepEqual(p.excluded, [[ip('192.168.1.250'), ip('192.168.1.254')]]);
  });

  it('exclusion à cheval sur le début de plage (passerelle et réservations)', () => {
    const p = C.dhcpPool(c24, { gateway: 'first', reserveStart: 3, exclusions: '192.168.1.0-10' });
    // plage .5–.254 ∩ .0–.10 = .5–.10 → 6 adresses
    assert.equal(p.start, ip('192.168.1.5'));
    assert.equal(p.excludedCount, 6);
    assert.equal(p.leases, 250 - 6);
  });

  it('exclusion entièrement hors plage : note, baux inchangés', () => {
    const p = C.dhcpPool(c24, { gateway: 'first', exclusions: '10.0.0.1' });
    assert.equal(p.leases, 253);
    assert.equal(p.excludedCount, 0);
    assert.ok(p.notes.length >= 1, 'une note doit signaler l\'exclusion sans effet');
    assert.ok(p.notes.some((n) => n.includes('10.0.0.1')));
  });

  it('exclure la passerelle « first » : sans effet, note', () => {
    const p = C.dhcpPool(c24, { gateway: 'first', exclusions: '192.168.1.1' });
    assert.equal(p.leases, 253);
    assert.ok(p.notes.length >= 1);
  });

  it('exclusion hors plage adjacente à une passerelle personnalisée : la note reste présente', () => {
    // .255 (diffusion) n'est pas dans la plage .1–.254 : l'exclusion est sans effet et doit être signalée,
    // même si elle touche la passerelle personnalisée .254.
    const p = C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.254', exclusions: '192.168.1.255' });
    assert.equal(p.leases, 253);
    assert.ok(p.notes.some((n) => n.includes('192.168.1.255')), `notes : ${JSON.stringify(p.notes)}`);
  });

  it('passerelle personnalisée + exclusion qui la contient : pas de double comptage', () => {
    const p = C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.100', exclusions: '192.168.1.95-105' });
    // .1–.254 (254) moins .95–.105 (11, passerelle incluse)
    assert.equal(p.leases, 254 - 11);
  });

  it('exclusions qui recouvrent toute la plage → 0 bail', () => {
    const p = C.dhcpPool(c24, { gateway: 'none', exclusions: '192.168.1.0-255' });
    assert.equal(p.leases, 0);
  });

  it('réservations trop grandes : 0 bail, début et fin null', () => {
    for (const opts of [{ reserveStart: 200, reserveEnd: 100 }, { reserveStart: 253 }, { reserveEnd: 1000 }, { reserveStart: 1e9 }]) {
      const p = C.dhcpPool(c24, { gateway: 'first', ...opts });
      assert.equal(p.leases, 0, JSON.stringify(opts));
      assert.equal(p.rangeCount, 0);
      assert.equal(p.start, null);
      assert.equal(p.end, null);
      assert.ok(p.notes.length >= 1);
    }
  });

  it('réservations laissant exactement 1 bail', () => {
    const p = C.dhcpPool(c24, { gateway: 'first', reserveStart: 252 });
    assert.equal(p.leases, 1);
    assert.equal(p.start, ip('192.168.1.254'));
    assert.equal(p.end, ip('192.168.1.254'));
  });

  it('/32 : note, pas de plantage', () => {
    const c = C.calculate(ip('192.168.1.10'), 32);
    for (const g of ['first', 'last', 'none']) {
      const p = C.dhcpPool(c, { gateway: g });
      assert.ok(p.notes.length >= 1, g);
      assert.ok(p.leases >= 0 && p.leases <= 1, g);
    }
    assert.equal(C.dhcpPool(c, { gateway: 'none' }).leases, 1);
    assert.equal(C.dhcpPool(c, { gateway: 'first' }).leases, 0);
    assert.equal(C.dhcpPool(c, { gateway: 'custom', customGateway: '192.168.1.10' }).leases, 0);
  });

  it('/31 : note, pas de plantage', () => {
    const c = C.calculate(ip('192.168.1.10'), 31);
    const p = C.dhcpPool(c, { gateway: 'first' });
    assert.ok(p.notes.length >= 1);
    assert.equal(p.gateway, ip('192.168.1.10'));
    assert.equal(p.start, ip('192.168.1.11'));
    assert.equal(p.end, ip('192.168.1.11'));
    assert.equal(p.leases, 1);
    assert.equal(C.dhcpPool(c, { gateway: 'none' }).leases, 2);
  });

  it('/8 : grands nombres', () => {
    const c = C.calculate(ip('10.20.30.40'), 8);
    const p = C.dhcpPool(c, { gateway: 'first' });
    assert.equal(p.gateway, ip('10.0.0.1'));
    assert.equal(p.start, ip('10.0.0.2'));
    assert.equal(p.end, ip('10.255.255.254'));
    assert.equal(p.leases, 16777213);
    assert.equal(C.dhcpPool(c, { gateway: 'none' }).leases, 16777214);
  });

  it('/0 : passerelle « last », valeurs non signées', () => {
    const c = C.calculate(0, 0);
    const p = C.dhcpPool(c, { gateway: 'last' });
    assert.equal(p.gateway, 2 ** 32 - 2);
    assert.equal(p.start, 1);
    assert.equal(p.end, 2 ** 32 - 3);
    assert.equal(p.leases, 2 ** 32 - 3);
  });
});

// ---------------------------------------------------------------------------
describe('forEachAddress', () => {
  it('émet la bonne séquence en sautant les exclusions', () => {
    const out = [];
    C.forEachAddress(ip('10.0.0.1'), ip('10.0.0.10'), [[ip('10.0.0.3'), ip('10.0.0.4')], [ip('10.0.0.8'), ip('10.0.0.8')]], (a) => { out.push(C.toIp(a)); });
    assert.deepEqual(out, ['10.0.0.1', '10.0.0.2', '10.0.0.5', '10.0.0.6', '10.0.0.7', '10.0.0.9', '10.0.0.10']);
  });

  it('exclusions qui débordent avant le début et après la fin', () => {
    const out = [];
    C.forEachAddress(10, 20, [[0, 12], [18, 100]], (a) => { out.push(a); });
    assert.deepEqual(out, [13, 14, 15, 16, 17]);
  });

  it('exclusions entièrement avant ou après la plage', () => {
    const out = [];
    C.forEachAddress(10, 13, [[0, 5], [50, 60]], (a) => { out.push(a); });
    assert.deepEqual(out, [10, 11, 12, 13]);
  });

  it('s\'arrête quand la fonction renvoie false', () => {
    const out = [];
    C.forEachAddress(100, 200, [], (a) => { out.push(a); return out.length < 5; });
    assert.deepEqual(out, [100, 101, 102, 103, 104]);
  });

  it('ne s\'arrête pas sur une valeur « falsy » autre que false', () => {
    let n = 0;
    C.forEachAddress(1, 10, [], () => { n++; return 0; });
    assert.equal(n, 10);
  });

  it('plage finissant à 255.255.255.255 : pas de boucle infinie', () => {
    const out = [];
    C.forEachAddress(2 ** 32 - 3, 2 ** 32 - 1, [], (a) => { out.push(a); if (out.length > 10) return false; });
    assert.deepEqual(out, [2 ** 32 - 3, 2 ** 32 - 2, 2 ** 32 - 1]);
  });

  it('exclusion finissant à 255.255.255.255 : pas de boucle infinie', () => {
    const out = [];
    C.forEachAddress(2 ** 32 - 5, 2 ** 32 - 1, [[2 ** 32 - 2, 2 ** 32 - 1]], (a) => { out.push(a); if (out.length > 10) return false; });
    assert.deepEqual(out, [2 ** 32 - 5, 2 ** 32 - 4, 2 ** 32 - 3]);
  });

  it('début ou fin null : rien n\'est émis', () => {
    let n = 0;
    C.forEachAddress(null, null, [], () => { n++; });
    C.forEachAddress(null, 10, [], () => { n++; });
    C.forEachAddress(10, null, [], () => { n++; });
    assert.equal(n, 0);
  });

  it('début > fin : rien n\'est émis', () => {
    assert.equal(countEmitted(10, 5, []), 0);
  });

  it('commence par 0.0.0.0 (0 n\'est pas confondu avec null)', () => {
    const out = [];
    C.forEachAddress(0, 2, [], (a) => { out.push(a); });
    assert.deepEqual(out, [0, 1, 2]);
  });

  it('valeurs émises non signées au-delà de 2^31', () => {
    const out = [];
    C.forEachAddress(2 ** 31 - 1, 2 ** 31 + 1, [], (a) => { out.push(a); });
    assert.deepEqual(out, [2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1]);
  });
});

// ---------------------------------------------------------------------------
describe('contrôle croisé dhcpPool × forEachAddress', () => {
  const configs = [
    ['192.168.1.0/24', {}],
    ['192.168.1.0/24', { gateway: 'last', reserveStart: 5, reserveEnd: 5 }],
    ['192.168.1.0/24', { gateway: 'custom', customGateway: '192.168.1.77', exclusions: '192.168.1.70-80, 192.168.1.200-192.168.1.255, 10.0.0.1' }],
    ['192.168.1.0/24', { gateway: 'custom', customGateway: '192.168.1.5', reserveStart: 10, exclusions: '192.168.1.4-6' }],
    ['192.168.1.0/24', { gateway: 'none', exclusions: '192.168.1.0-255' }],
    ['192.168.1.0/24', { gateway: 'first', reserveStart: 300 }],
    ['192.168.1.10/31', { gateway: 'first' }],
    ['192.168.1.10/32', { gateway: 'none' }],
    ['192.168.1.10/32', { gateway: 'custom', customGateway: '192.168.1.10' }],
    ['255.255.255.0/24', { gateway: 'none', exclusions: '255.255.255.250-255' }],
    ['10.0.0.0/16', { gateway: 'first', reserveStart: 20, reserveEnd: 30, exclusions: '10.0.1.0-10.0.2.255\n10.0.100.1-50; 10.0.255.0-255 # fin\n10.1.0.0' }],
    ['172.16.0.0/16', { gateway: 'custom', customGateway: '172.16.128.1', exclusions: '172.16.128.0-10, 172.16.0.0-172.16.0.255' }],
  ];
  for (const [cidr, opts] of configs) {
    it(`${cidr} ${JSON.stringify(opts)}`, () => {
      const pi = C.parseInput(cidr);
      const calc = C.calculate(pi.ip, pi.prefix);
      const pool = C.dhcpPool(calc, opts);
      const n = countEmitted(pool.start, pool.end, pool.skip);
      assert.equal(n, pool.leases);
      // La passerelle ne doit jamais être distribuée, et toutes les adresses émises sont des hôtes du réseau
      C.forEachAddress(pool.start, pool.end, pool.skip, (a) => {
        assert.notEqual(a, pool.gateway);
        assert.ok(a >= calc.firstHost && a <= calc.lastHost);
      });
    });
  }

  it('/16 parcouru rapidement (< 1 s)', () => {
    const calc = C.calculate(ip('10.1.0.0'), 16);
    const pool = C.dhcpPool(calc, { gateway: 'first' });
    const t0 = Date.now();
    const n = countEmitted(pool.start, pool.end, pool.skip);
    assert.equal(n, 65533);
    assert.equal(pool.leases, 65533);
    assert.ok(Date.now() - t0 < 1000);
  });
});

// ---------------------------------------------------------------------------
describe('splitSubnets', () => {
  const c24 = C.calculate(ip('192.168.1.10'), 24);

  it('/24 en /26 : 4 sous-réseaux de 62 hôtes', () => {
    const r = C.splitSubnets(c24, 26);
    assert.equal(r.prefix, 26);
    assert.equal(r.count, 4);
    assert.equal(r.size, 64);
    assert.equal(r.usablePerSubnet, 62);
    assert.deepEqual(r.subnets.map((s) => C.toIp(s.network)), ['192.168.1.0', '192.168.1.64', '192.168.1.128', '192.168.1.192']);
    assert.deepEqual(r.subnets.map((s) => C.toIp(s.broadcast)), ['192.168.1.63', '192.168.1.127', '192.168.1.191', '192.168.1.255']);
    for (const s of r.subnets) assert.equal(s.prefix, 26);
  });

  it('préfixe en texte « /26 »', () => {
    assert.equal(C.splitSubnets(c24, '/26').count, 4);
  });

  it('même préfixe : un seul sous-réseau', () => {
    const r = C.splitSubnets(c24, 24);
    assert.equal(r.count, 1);
    assert.equal(r.subnets[0].network, ip('192.168.1.0'));
  });

  it('/24 en /32 : 256 adresses', () => {
    const r = C.splitSubnets(c24, 32);
    assert.equal(r.count, 256);
    assert.equal(r.usablePerSubnet, 1);
    assert.equal(r.subnets.length, 256);
    assert.equal(r.subnets[255].network, ip('192.168.1.255'));
  });

  it('paramètres limit et offset', () => {
    const r = C.splitSubnets(c24, 28, 3, 2);
    assert.equal(r.count, 16);
    assert.deepEqual(r.subnets.map((s) => C.toIp(s.network)), ['192.168.1.32', '192.168.1.48', '192.168.1.64']);
    assert.equal(C.splitSubnets(c24, 28, 100, 14).subnets.length, 2); // il ne reste que 14 et 15
    assert.equal(C.splitSubnets(c24, 28, 100, 16).subnets.length, 0);
    assert.equal(C.splitSubnets(c24, 28, 0).subnets.length, 0);
  });

  it('préfixe plus court que le réseau : refusé', () => {
    throwsCalc(() => C.splitSubnets(c24, 16));
    throwsCalc(() => C.splitSubnets(c24, 23));
    throwsCalc(() => C.splitSubnets(c24, 33));
    throwsCalc(() => C.splitSubnets(c24, 'abc'));
  });

  it('/8 en /24 : 65 536 au total, seulement `limit` renvoyés', () => {
    const c8 = C.calculate(ip('10.20.30.40'), 8);
    const r = C.splitSubnets(c8, 24, 10);
    assert.equal(r.count, 65536);
    assert.equal(r.subnets.length, 10);
    assert.equal(r.subnets[9].network, ip('10.0.9.0'));
    const d = C.splitSubnets(c8, 24);
    assert.equal(d.subnets.length, 256);
    const fin = C.splitSubnets(c8, 24, 10, 65535);
    assert.equal(fin.subnets.length, 1);
    assert.equal(fin.subnets[0].network, ip('10.255.255.0'));
  });

  it('/0 en /32 : 2^32 sous-réseaux, derniers sans débordement', () => {
    const c0 = C.calculate(0, 0);
    const r = C.splitSubnets(c0, 32, 2, 2 ** 32 - 2);
    assert.equal(r.count, 2 ** 32);
    assert.deepEqual(r.subnets.map((s) => s.network), [2 ** 32 - 2, 2 ** 32 - 1]);
  });

  it('réseau haut (240.0.0.0/4 en /8) : adresses non signées', () => {
    const c = C.calculate(ip('240.0.0.0'), 4);
    const r = C.splitSubnets(c, 8);
    assert.equal(r.count, 16);
    assert.equal(r.subnets[15].network, ip('255.0.0.0'));
    for (const s of r.subnets) assert.ok(s.network >= ip('240.0.0.0'));
  });
});

// ---------------------------------------------------------------------------
describe('summaryLines', () => {
  const calc = C.calculate(ip('192.168.1.10'), 24);

  it('tableau de chaînes contenant le réseau', () => {
    const lines = C.summaryLines(calc);
    assert.ok(Array.isArray(lines));
    assert.ok(lines.length > 0);
    for (const l of lines) assert.equal(typeof l, 'string');
    assert.ok(lines.some((l) => l.includes('192.168.1.0/24')));
    assert.ok(lines.some((l) => l.includes('255.255.255.0')));
    assert.ok(lines.some((l) => l.includes('192.168.1.255')));
    assert.ok(!lines.some((l) => /BAUX/.test(l)), 'sans pool, pas de ligne de baux');
  });

  it('avec un pool : ligne des baux', () => {
    const pool = C.dhcpPool(calc, { gateway: 'first' });
    const lines = C.summaryLines(calc, pool, { input: '192.168.1.10/24', reason: 'préfixe saisi (/24)' });
    assert.ok(lines.some((l) => /BAUX DHCP MAXIMUM\s*:\s*253$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('192.168.1.2') && l.includes('192.168.1.254')));
    assert.ok(lines.some((l) => l.includes('192.168.1.10/24')));
  });

  it('grands nombres : séparateurs de milliers en espaces ordinaires', () => {
    const c8 = C.calculate(ip('10.0.0.0'), 8);
    const lines = C.summaryLines(c8, C.dhcpPool(c8, { gateway: 'first' }));
    const baux = lines.find((l) => l.includes('BAUX'));
    assert.ok(baux.endsWith('16 777 213'), JSON.stringify(baux));
    assert.ok(lines.some((l) => l.endsWith('16 777 216')));
  });

  it('/32 : diffusion « aucune », pool vide', () => {
    const c = C.calculate(ip('192.168.1.10'), 32);
    const lines = C.summaryLines(c, C.dhcpPool(c, { gateway: 'first' }));
    assert.ok(lines.some((l) => /aucune/.test(l)));
    assert.ok(lines.some((l) => /BAUX DHCP MAXIMUM\s*:\s*0$/.test(l)));
  });
});

// ---------------------------------------------------------------------------
// Corrections faites après la première passe de cette suite (non-régression)
// ---------------------------------------------------------------------------
describe('non-régression des corrections', () => {
  const c24 = C.calculate(C.parseIp('192.168.1.10'), 24);
  const throwsCalc = (fn) => assert.throws(fn, (e) => e.name === 'CalcError');

  it('commentaire « # » contenant une virgule ou un point-virgule', () => {
    assert.deepEqual(C.parseExclusions('10.0.0.1 # copieur, étage 2\n10.0.0.2'), [[C.parseIp('10.0.0.1'), C.parseIp('10.0.0.2')]]);
    assert.deepEqual(C.parseExclusions('# serveurs ; ne pas toucher\n10.0.0.9'), [[C.parseIp('10.0.0.9'), C.parseIp('10.0.0.9')]]);
  });

  it('passerelle personnalisée : n\'est plus comptée comme exclusion, la remarque « sans effet » reste', () => {
    const p = C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.254', exclusions: '192.168.1.255' });
    assert.equal(p.leases, 253);
    assert.equal(p.excludedCount, 0);
    assert.ok(p.notes.some((n) => n.includes('192.168.1.255')));
    // passerelle au bord : la plage se resserre (fin .253) au lieu de la contenir
    assert.equal(p.gatewayInPool, false);
    assert.equal(p.end, C.parseIp('192.168.1.253'));
    const mid = C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.100' });
    assert.equal(mid.gatewayInPool, true);
    assert.equal(mid.leases, 253);
    const q = C.dhcpPool(c24, { gateway: 'custom', customGateway: '192.168.1.100', exclusions: '192.168.1.100' });
    assert.equal(q.leases, 253, 'passerelle déjà exclue : pas de double décompte');
    assert.equal(q.gatewayInPool, false);
  });

  it('mode de passerelle inconnu refusé', () => {
    throwsCalc(() => C.dhcpPool(c24, { gateway: 'foo' }));
  });

  it('splitSubnets : position et limite validées', () => {
    throwsCalc(() => C.splitSubnets(c24, 26, 10, -1));
    throwsCalc(() => C.splitSubnets(c24, 26, 10, 1.5));
    throwsCalc(() => C.splitSubnets(c24, 26, -1, 0));
  });

  it('zone DNS inverse au-delà d\'un /8 : racine in-addr.arpa', () => {
    assert.equal(C.calculate(C.parseIp('192.168.1.10'), 4).reverseZone, 'in-addr.arpa');
    assert.equal(C.calculate(C.parseIp('192.168.1.10'), 4).reverseZoneExact, false);
  });

  it('prefixForHosts : entier décimal uniquement', () => {
    throwsCalc(() => C.prefixForHosts(true));
    throwsCalc(() => C.prefixForHosts('0x10'));
    throwsCalc(() => C.prefixForHosts('1e2'));
    assert.equal(C.prefixForHosts(' 50 '), 26);
  });

  it('parseInput : « / » sans préfixe refusé, zéros en tête acceptés', () => {
    throwsCalc(() => C.parseInput('192.168.1.10/'));
    assert.equal(C.parseInput('192.168.1.10/024').prefix, 24);
    throwsCalc(() => C.parseInput('192.168.1.10/033'));
  });

  it('préfixes hors 0–32 refusés par les fonctions internes', () => {
    throwsCalc(() => C.usableCount(33));
    throwsCalc(() => C.prefixToMask(-1));
    throwsCalc(() => C.calculate(0, 40));
  });
});
// ---------------------------------------------------------------------------
// Nombre de baux souhaité (limit) : la plage s'arrête au nombre demandé
// ---------------------------------------------------------------------------
describe('dhcpPool : nombre de baux souhaité', () => {
  const ip = (s) => C.parseIp(s);
  const c26 = C.calculate(ip('10.0.0.1'), 26);
  const count = (p) => {
    let n = 0;
    C.forEachAddress(p.start, p.end, p.skip, () => { n++; });
    return n;
  };

  it('50 appareils sur un /26 sans passerelle : exactement 50 baux, 12 libres', () => {
    const p = C.dhcpPool(c26, { gateway: 'none', limit: '50' });
    assert.equal(p.leases, 50);
    assert.equal(count(p), 50);
    assert.equal(p.start, ip('10.0.0.1'));
    assert.equal(p.end, ip('10.0.0.50'));
    assert.equal(p.available, 62);
    assert.equal(p.free, 12);
    assert.equal(p.shortage, 0);
  });

  it('avec passerelle et exclusions dans la plage : la fin recule pour garder 50 baux', () => {
    const p = C.dhcpPool(c26, { gateway: 'first', exclusions: '10.0.0.10-14\n10.0.0.30', limit: 50 });
    assert.equal(p.leases, 50);
    assert.equal(count(p), 50);
    assert.equal(p.start, ip('10.0.0.2'));
    // de .2 à X, moins 6 exclues (.10-.14 et .30) = 50 baux → X - 2 + 1 - 6 = 50 → fin à .57
    assert.equal(p.end, ip('10.0.0.57'));
    assert.equal(p.free, 61 - 6 - 50);
  });

  it('passerelle personnalisée au milieu : sautée et décomptée', () => {
    const p = C.dhcpPool(c26, { gateway: 'custom', customGateway: '10.0.0.5', limit: 10 });
    assert.equal(p.leases, 10);
    assert.equal(count(p), 10);
    assert.equal(p.end, ip('10.0.0.11'));
  });

  it('demande supérieure au disponible : tout est distribué, le manque est signalé', () => {
    const p = C.dhcpPool(c26, { gateway: 'first', limit: 100 });
    assert.equal(p.leases, 61);
    assert.equal(p.shortage, 39);
    assert.ok(p.notes.some((n) => n.includes('100 demandés')));
  });

  it('limite égale au disponible, vide ou 0 : pas de limite effective', () => {
    assert.equal(C.dhcpPool(c26, { gateway: 'first', limit: 61 }).free, 0);
    assert.equal(C.dhcpPool(c26, { gateway: 'first', limit: '' }).limit, null);
    assert.equal(C.dhcpPool(c26, { gateway: 'first', limit: 0 }).limit, null);
    assert.equal(C.dhcpPool(c26, { gateway: 'first', limit: '' }).leases, 61);
  });

  it('limite invalide refusée', () => {
    for (const bad of ['abc', '-5', '1.5', '1e3']) {
      assert.throws(() => C.dhcpPool(c26, { limit: bad }), (e) => e.name === 'CalcError', bad);
    }
  });

  it('/8 limité à 1 000 baux : rapide et exact', () => {
    const p = C.dhcpPool(C.calculate(ip('10.0.0.1'), 8), { gateway: 'first', limit: 1000 });
    assert.equal(p.leases, 1000);
    assert.equal(p.end, ip('10.0.3.233'));
  });

  it('le résumé indique les baux demandés et les adresses libres', () => {
    const p = C.dhcpPool(c26, { gateway: 'none', limit: '50' });
    const text = C.summaryLines(c26, p).join('\n');
    assert.match(text, /Baux demandés\s+: 50/);
    assert.match(text, /Libres \(hors plage DHCP\)\s+: 12/);
  });
});