/*
 * binary.js — Calcul binaire de CalkIP : conversions, explication pas à pas, exercices.
 *
 * Même principe que ipcalc.js : chargé par l'interface (<script>, objet global « IPBinary », après
 * ipcalc.js) et par le processus principal (require) pour l'export .txt des étapes.
 *
 * explain(ip, prefix) décrit chaque étape sous forme de blocs (paragraphe, tableau, bits alignés,
 * formule…) : l'interface les dessine, explainLines() les écrit en texte. Une seule source pour les deux.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./ipcalc.js') : root.IPCalc);
  if (isNode) module.exports = api;
  else root.IPBinary = api;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  const { CalcError, toIp, toBinary, prefixToMask, calculate, usableCount } = C;
  const fmt = C.formatNumber;

  /** Poids des 8 bits d'un octet, de gauche à droite. */
  const WEIGHTS = [128, 64, 32, 16, 8, 4, 2, 1];
  /** Seules valeurs possibles pour un octet de masque (les 1 sont collés à gauche). */
  const MASK_OCTETS = [0, 128, 192, 224, 240, 248, 252, 254, 255];
  const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

  const sup = (n) => String(n).replace(/\d/g, (d) => SUPERSCRIPT[d]);

  // ---------------------------------------------------------------------------
  // Conversions
  // ---------------------------------------------------------------------------

  function octets(n) {
    n = n >>> 0;
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }

  function fromOctets(list) {
    return list.reduce((acc, v) => acc * 256 + v, 0) >>> 0;
  }

  function octetBits(v) {
    return (v & 255).toString(2).padStart(8, '0');
  }

  function bits32(n) {
    return (n >>> 0).toString(2).padStart(32, '0');
  }

  function assertOctet(value) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new CalcError(`« ${value} » n'est pas un octet : choisissez un nombre de 0 à 255.`, 'octet');
  }

  /**
   * Méthode des soustractions : pour chaque poids (128 → 1), le bit vaut 1 si le reste est supérieur
   * ou égal au poids, et on retire alors le poids du reste.
   */
  function decompose(value) {
    assertOctet(value);
    let rest = value;
    const steps = [];
    const terms = [];
    for (const weight of WEIGHTS) {
      const before = rest;
      const bit = rest >= weight ? 1 : 0;
      if (bit) {
        rest -= weight;
        terms.push(weight);
      }
      steps.push({ weight, before, bit, after: rest });
    }
    return { value, bits: octetBits(value), steps, terms };
  }

  /** « 128 + 64 » pour 192, « 0 » pour 0. */
  function sumText(value) {
    const { terms } = decompose(value);
    return terms.length ? terms.join(' + ') : '0';
  }

  /** Nombre de bits à 1 d'un octet de masque valide, sinon null. */
  function maskOctetBits(value) {
    const i = MASK_OCTETS.indexOf(value);
    return i === -1 ? null : i;
  }

  /**
   * Adresse écrite en binaire : « 11000000.10101000.00000001.00001010 », « 11000000 10101000 … »
   * (4 groupes de 1 à 8 bits) ou 32 bits d'un seul tenant (espaces et « _ » ignorés).
   */
  function parseBinaryIp(text) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) throw new CalcError('Saisissez une adresse en binaire (ex. 11000000.10101000.00000001.00001010).', 'binary');
    let groups = null;
    if (s.includes('.')) groups = s.replace(/[\s_]/g, '').split('.');
    else if (s.split(/\s+/).length === 4) groups = s.split(/\s+/);
    if (groups) {
      if (groups.length !== 4 || groups.some((g) => !/^[01]{1,8}$/.test(g))) {
        throw new CalcError('Adresse binaire invalide : il faut 4 groupes de 1 à 8 bits (0 ou 1), séparés par des points.', 'binary');
      }
      return fromOctets(groups.map((g) => parseInt(g, 2)));
    }
    const compact = s.replace(/[\s_]/g, '');
    if (!/^[01]+$/.test(compact)) throw new CalcError('Une adresse binaire ne contient que des 0 et des 1.', 'binary');
    if (compact.length !== 32) throw new CalcError(`Adresse binaire de ${compact.length} bits : il en faut exactement 32 (ou 4 groupes séparés par des points).`, 'binary');
    return parseInt(compact, 2) >>> 0;
  }

  /**
   * Reconnaît le format d'une adresse et la convertit en entier.
   * Formats : décimal pointé (192.168.1.10), binaire (pointé ou 32 bits), hexadécimal (0xC0A8010A,
   * C0.A8.01.0A), entier (3232235786).
   */
  function parseAnyIp(text) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) throw new CalcError('Saisissez une adresse : décimale, binaire, hexadécimale ou entière.', 'convert');
    if (/^0x[0-9a-f]{1,8}$/i.test(s)) return { value: parseInt(s.slice(2), 16) >>> 0, format: 'hex' };
    const groups = s.replace(/[\s_]/g, '').split('.');
    // Binaire : uniquement des 0/1 et au moins un groupe trop long pour du décimal (sinon « 1.1.1.1 » serait ambigu)
    if (/^[01.\s_]+$/.test(s) && (groups.some((g) => g.length > 3) || (groups.length === 1 && groups[0].length === 32))) {
      return { value: parseBinaryIp(s), format: 'binary' };
    }
    if (groups.length === 4 && groups.every((g) => /^[0-9a-f]{1,2}$/i.test(g)) && groups.some((g) => /[a-f]/i.test(g))) {
      return { value: fromOctets(groups.map((g) => parseInt(g, 16))), format: 'hex' };
    }
    if (s.includes('.')) return { value: C.parseIp(s, 'convert'), format: 'decimal' };
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n > C.MAX) throw new CalcError(`${s} dépasse la plus grande adresse IPv4 (4 294 967 295).`, 'convert');
      return { value: n >>> 0, format: 'integer' };
    }
    throw new CalcError(`« ${s} » : format non reconnu (ex. 192.168.1.10, 11000000.10101000.00000001.00001010, 0xC0A8010A).`, 'convert');
  }

  function formats(n) {
    n = n >>> 0;
    return {
      decimal: toIp(n),
      binary: toBinary(n),
      hex: `0x${n.toString(16).toUpperCase().padStart(8, '0')}`,
      hexDotted: octets(n)
        .map((v) => v.toString(16).toUpperCase().padStart(2, '0'))
        .join('.'),
      integer: String(n),
    };
  }

  // ---------------------------------------------------------------------------
  // Méthode rapide : le « nombre magique »
  // ---------------------------------------------------------------------------

  /**
   * Octet significatif (celui où le masque ne vaut ni 255 ni 0) et pas des réseaux (256 − octet du masque).
   * null quand le préfixe est un multiple de 8 : il n'y a alors rien à calculer.
   */
  function magic(ip, prefix) {
    prefixToMask(prefix); // valide le préfixe (0 à 32)
    if (prefix % 8 === 0) return null;
    const index = Math.floor(prefix / 8);
    const maskOctet = octets(prefixToMask(prefix))[index];
    const block = 256 - maskOctet;
    const value = octets(ip)[index];
    const quotient = Math.floor(value / block);
    const netOctet = quotient * block;
    return { index, maskOctet, block, value, quotient, remainder: value - netOctet, netOctet, lastOctet: netOctet + block - 1, blocks: 256 / block };
  }

  // ---------------------------------------------------------------------------
  // Explication pas à pas
  // ---------------------------------------------------------------------------

  const P = (text) => ({ type: 'p', text });
  const NOTE = (text, level = 'tip') => ({ type: 'note', text, level });
  const FORMULA = (...lines) => ({ type: 'formula', lines: lines.filter(Boolean) });
  const TABLE = (head, rows, options = {}) => ({ type: 'table', head, rows, ...options });
  /** rows : { label, value, sign: '' | 'ET' | 'OU' | '=' | 'NON', kind: 'result' | undefined } */
  const BITS = (rows, prefix, options = {}) => ({ type: 'bits', rows, prefix, split: true, focus: null, ...options });
  const DECOMPOSE = (index, value) => ({ type: 'decompose', index, ...decompose(value) });
  const RESULT = (...items) => ({ type: 'result', items: items.filter(Boolean) });

  const TRUTH_AND = TABLE(['A', 'B', 'A ET B'], [['0', '0', '0'], ['0', '1', '0'], ['1', '0', '0'], ['1', '1', '1']], { compact: true, highlight: 3 });
  const TRUTH_OR = TABLE(['A', 'B', 'A OU B'], [['0', '0', '0'], ['0', '1', '1'], ['1', '0', '1'], ['1', '1', '1']], { compact: true });

  function explain(ip, prefix) {
    ip = ip >>> 0;
    const c = calculate(ip, prefix);
    const h = 32 - prefix;
    const ipO = octets(ip);
    const maskO = octets(c.mask);
    const m = magic(ip, prefix);
    const cidr = `${toIp(c.network)}/${prefix}`;
    const steps = [];
    // « 26 premiers bits », « 1 bit » : chaque mot prend la marque du pluriel
    const plural = (n, words) => `${n} ${n > 1 ? words.replace(/(\S+)/g, '$1s') : words}`;

    // 1. Les bases
    const sample = ipO.find((v) => v > 0 && v < 255) ?? 168;
    steps.push({
      key: 'bases',
      short: 'Les bases',
      title: 'Les bases : 32 bits, 4 octets',
      blocks: [
        P('Une adresse IPv4 est un nombre de **32 bits** (32 chiffres valant 0 ou 1). Pour la lire, on la coupe en **4 octets** de 8 bits, convertis chacun en décimal (de 0 à 255) et séparés par des points.'),
        P('Dans un octet, chaque bit a un **poids**, une puissance de 2 : 2⁷ = 128 à gauche, jusqu\'à 2⁰ = 1 à droite. La valeur de l\'octet est la **somme des poids des bits à 1**.'),
        TABLE(['Bit', '7', '6', '5', '4', '3', '2', '1', '0'], [['Puissance', ...WEIGHTS.map((_, i) => `2${sup(7 - i)}`)], ['Poids', ...WEIGHTS.map(String)]], { firstColHead: true }),
        FORMULA(`Exemple : ${octetBits(sample)} = ${sumText(sample)} = ${sample}`),
        NOTE('Avec 8 bits on va de 00000000 = 0 à 11111111 = 128 + 64 + 32 + 16 + 8 + 4 + 2 + 1 = 255 : voilà pourquoi un octet ne dépasse jamais 255.'),
        P(`Le **préfixe** /${prefix} (notation CIDR) indique combien de bits, en partant de la gauche, forment la **partie réseau** : ici ${plural(prefix, 'bit')}. Les ${plural(h, 'bit')} restants forment la **partie hôte**, qui numérote les machines du réseau.`),
        BITS([{ label: 'Adresse', value: ip }], prefix),
      ],
    });

    // 2. L'adresse en binaire
    steps.push({
      key: 'ip',
      short: 'Adresse',
      title: 'Convertir l\'adresse en binaire',
      blocks: [
        P(`Adresse : **${toIp(ip)}**. On convertit chaque octet séparément, par **soustractions** : on teste les poids de 128 à 1. Si le reste est **supérieur ou égal** au poids, on écrit **1** et on retire le poids du reste ; sinon on écrit **0** et le reste ne change pas.`),
        ...ipO.map((v, i) => DECOMPOSE(i, v)),
        NOTE('Raccourcis : 0 = 00000000 et 255 = 11111111. Un octet pair finit toujours par 0, un octet impair par 1. Un octet inférieur à 128 commence toujours par 0.'),
        BITS([{ label: 'Adresse', value: ip }], prefix, { split: false }),
      ],
    });

    // 3. Le masque
    steps.push({
      key: 'mask',
      short: 'Masque',
      title: 'Écrire le masque en binaire',
      blocks: [
        P(`Le préfixe **/${prefix}** se lit : les **${plural(prefix, 'premier bit')}** du masque valent 1 (partie réseau), les **${plural(h, 'dernier bit')}** valent 0 (partie hôte).`),
        BITS([{ label: 'Masque', value: c.mask }], prefix),
        TABLE(
          ['Octet', 'Binaire', 'Calcul', 'Décimal'],
          maskO.map((v, i) => [`n° ${i + 1}`, octetBits(v), v === 0 ? 'aucun bit à 1' : v === 255 ? 'les 8 bits à 1' : sumText(v), String(v)]),
          { mono: [1, 2, 3], highlight: m ? m.index : null }
        ),
        RESULT({ label: 'Masque', value: toIp(c.mask) }, { label: 'Préfixe', value: `/${prefix}` }),
        NOTE('Un octet de masque ne peut valoir que 0, 128, 192, 224, 240, 248, 252, 254 ou 255 : ses 1 sont toujours collés à gauche. Dans l\'autre sens, pour retrouver le préfixe d\'un masque, on additionne ses bits à 1 : 255 = 8, 254 = 7, 252 = 6, 248 = 5, 240 = 4, 224 = 3, 192 = 2, 128 = 1.'),
      ],
    });

    // 4. Adresse réseau (ET)
    const networkBlocks = [
      P('On pose l\'adresse et le masque l\'un sous l\'autre et on applique le **ET logique** (AND) bit par bit : le résultat vaut 1 **seulement si les deux bits valent 1**.'),
      TRUTH_AND,
      BITS(
        [
          { label: 'Adresse', value: ip },
          { label: 'Masque', value: c.mask, sign: 'ET' },
          { label: 'Réseau', value: c.network, sign: '=', kind: 'result' },
        ],
        prefix,
        { focus: m ? m.index : null }
      ),
      P('Autrement dit : sous les 1 du masque, on **recopie** les bits de l\'adresse ; sous les 0, on écrit **0**. La partie réseau est gardée, la partie hôte est remise à zéro.'),
    ];
    if (m) {
      networkBlocks.push(
        FORMULA(
          `Octet n° ${m.index + 1} : ${octetBits(m.value)} ET ${octetBits(m.maskOctet)} = ${octetBits(m.netOctet)}`,
          `soit ${m.value} → ${m.netOctet}`
        ),
        P(`Seul l'octet n° ${m.index + 1} demande un vrai calcul. Les octets avant lui sont recopiés (masque 255), ceux d'après passent à 0 (masque 0).`)
      );
    }
    networkBlocks.push(RESULT({ label: 'Adresse réseau', value: cidr }));
    steps.push({ key: 'network', short: 'Réseau', title: 'Adresse réseau : le ET logique', blocks: networkBlocks });

    // 5. Diffusion (NON puis OU)
    const broadcastBlocks = [
      P('D\'abord le **masque inversé** (wildcard) : on applique le **NON logique** (NOT) au masque, chaque bit est retourné (0 devient 1, 1 devient 0).'),
      BITS(
        [
          { label: 'Masque', value: c.mask },
          { label: 'Wildcard', value: c.wildcard, sign: 'NON', kind: 'result' },
        ],
        prefix
      ),
      FORMULA(`Astuce en décimal : 255 − chaque octet du masque → ${maskO.map((v) => `255 − ${v} = ${255 - v}`).join(' ; ')}`),
      P('Puis le **OU logique** (OR) entre l\'adresse réseau et le wildcard : le résultat vaut 1 **dès qu\'un des deux bits vaut 1**. La partie réseau ne change pas et la partie hôte passe entièrement à 1.'),
      TRUTH_OR,
      BITS(
        [
          { label: 'Réseau', value: c.network },
          { label: 'Wildcard', value: c.wildcard, sign: 'OU' },
          { label: prefix <= 30 ? 'Diffusion' : 'Dernière', value: c.lastAddress, sign: '=', kind: 'result' },
        ],
        prefix,
        { focus: m ? m.index : null }
      ),
    ];
    if (prefix <= 30) {
      broadcastBlocks.push(RESULT({ label: 'Adresse de diffusion', value: toIp(c.broadcast) }));
    } else {
      broadcastBlocks.push(
        NOTE(
          prefix === 31
            ? 'En /31 (liaison point à point, RFC 3021) il n\'y a pas d\'adresse de diffusion : ce calcul donne simplement la dernière des deux adresses, utilisable par un hôte.'
            : 'En /32 il n\'y a qu\'une adresse : pas de partie hôte, donc pas d\'adresse de diffusion.',
          'warn'
        )
      );
    }
    steps.push({ key: 'broadcast', short: 'Diffusion', title: 'Adresse de diffusion : NON puis OU', blocks: broadcastBlocks });

    // 6. Première et dernière adresse
    let rangeBlocks;
    if (prefix <= 30) {
      rangeBlocks = [
        P('Deux adresses du réseau sont réservées : l\'**adresse réseau** (partie hôte entièrement à 0) désigne le réseau lui-même, l\'**adresse de diffusion** (partie hôte entièrement à 1) sert à joindre toutes les machines. Les hôtes prennent les adresses **entre les deux**.'),
        BITS(
          [
            { label: 'Réseau', value: c.network },
            { label: 'Première', value: c.firstHost, kind: 'result' },
            { label: 'Dernière', value: c.lastHost, kind: 'result' },
            { label: 'Diffusion', value: c.broadcast },
          ],
          prefix
        ),
        FORMULA(
          `Première = réseau + 1     → ${toIp(c.firstHost)}   (partie hôte 0…01)`,
          `Dernière = diffusion − 1  → ${toIp(c.lastHost)}   (partie hôte 1…10)`
        ),
        RESULT({ label: 'Plage utilisable', value: `${toIp(c.firstHost)} – ${toIp(c.lastHost)}` }),
      ];
    } else if (prefix === 31) {
      rangeBlocks = [
        P('En **/31** (liaison point à point entre deux routeurs, RFC 3021), il n\'y a ni adresse réseau ni adresse de diffusion : **les deux adresses** sont utilisables.'),
        BITS([{ label: 'Première', value: c.firstHost, kind: 'result' }, { label: 'Dernière', value: c.lastHost, kind: 'result' }], prefix),
        RESULT({ label: 'Plage utilisable', value: `${toIp(c.firstHost)} – ${toIp(c.lastHost)}` }),
      ];
    } else {
      rangeBlocks = [
        P('En **/32**, le réseau ne contient qu\'**une seule adresse** : celle de la machine elle-même (route d\'hôte, adresse de bouclage d\'un routeur…).'),
        BITS([{ label: 'Adresse', value: c.firstHost, kind: 'result' }], prefix),
        RESULT({ label: 'Adresse unique', value: toIp(c.firstHost) }),
      ];
    }
    steps.push({ key: 'range', short: 'Plage', title: 'Première et dernière adresse utilisable', blocks: rangeBlocks });

    // 7. Nombre d'adresses et d'hôtes
    const rows = [];
    for (let k = Math.max(0, h - 3); k <= Math.min(32, h + 3); k++) {
      rows.push([String(k), `/${32 - k}`, `2${sup(k)} = ${fmt(2 ** k)}`, fmt(usableCount(32 - k))]);
    }
    steps.push({
      key: 'count',
      short: 'Hôtes',
      title: 'Nombre d\'adresses et d\'hôtes',
      blocks: [
        P(`Il reste **${plural(h, 'bit')} pour la partie hôte**. Chaque bit en plus double le nombre de combinaisons possibles : avec h bits, on obtient **2^h adresses**.`),
        FORMULA(
          `h = 32 − ${prefix} = ${h}`,
          `Adresses = 2${sup(h)} = ${fmt(c.total)}`,
          prefix <= 30 ? `Hôtes utilisables = 2${sup(h)} − 2 = ${fmt(c.usable)}   (on retire le réseau et la diffusion)` : `Hôtes utilisables = ${fmt(c.usable)}   (${prefix === 31 ? '/31 : les 2 adresses, RFC 3021' : '/32 : une seule adresse'})`
        ),
        TABLE(['Bits hôte', 'Préfixe', 'Adresses', 'Hôtes utilisables'], rows, { mono: [0, 1, 2, 3], highlight: rows.findIndex((r) => r[0] === String(h)) }),
        NOTE('Dans l\'autre sens, pour N machines : prendre le plus petit h tel que 2^h − 2 ≥ N, puis préfixe = 32 − h. Exemple : 50 machines → 2⁶ − 2 = 62 ≥ 50 → h = 6 → /26 (255.255.255.192).'),
      ],
    });

    // 8. Méthode rapide
    let magicBlocks;
    if (!m) {
      const kept = prefix / 8;
      magicBlocks = [
        P(
          prefix === 0
            ? 'Avec /0, le masque vaut 0.0.0.0 : le « réseau » contient toutes les adresses IPv4.'
            : prefix === 32
              ? 'Avec /32, le masque vaut 255.255.255.255 : le réseau se réduit à l\'adresse elle-même.'
              : `Avec /${prefix}, le masque ne contient que des octets à 255 ou à 0 : aucun calcul. On recopie les ${plural(kept, 'premier octet')} de l'adresse ; les autres valent **0** pour le réseau et **255** pour la diffusion.`
        ),
        FORMULA(`Réseau    : ${toIp(c.network)}`, `Diffusion : ${toIp(c.lastAddress)}`),
        NOTE('La méthode du « nombre magique » sert quand le préfixe n\'est pas un multiple de 8 (ex. /20, /26, /29). Essayez avec 192.168.1.10/26 ou 172.16.45.3/20.'),
      ];
    } else {
      const ipBefore = ipO.slice(0, m.index);
      const at = (octetValue, fill) => toIp(fromOctets([...ipBefore, octetValue, ...Array(3 - m.index).fill(fill)]));
      const blockRows = [];
      const addRow = (q) => blockRows.push([`n° ${q + 1}`, at(q * m.block, 0), at(q * m.block + m.block - 1, 255)]);
      if (m.blocks <= 16) {
        for (let q = 0; q < m.blocks; q++) addRow(q);
      } else {
        const from = Math.max(0, m.quotient - 2);
        const to = Math.min(m.blocks - 1, m.quotient + 2);
        if (from > 0) blockRows.push(['…', '…', '…']);
        for (let q = from; q <= to; q++) addRow(q);
        if (to < m.blocks - 1) blockRows.push(['…', '…', '…']);
      }
      magicBlocks = [
        P('Sans écrire les 32 bits, on trouve le réseau directement en décimal. On ne regarde que l\'**octet significatif** : celui où le masque ne vaut **ni 255 ni 0**.'),
        FORMULA(
          `Octet significatif : n° ${m.index + 1} (masque ${m.maskOctet}, adresse ${m.value})`,
          `Nombre magique = 256 − ${m.maskOctet} = ${m.block}   (taille de chaque bloc)`,
          `Les réseaux commencent tous les ${m.block} : 0, ${m.block}, ${m.block * 2}, ${m.block * 3}, …`,
          `${m.value} ÷ ${m.block} = ${m.quotient} reste ${m.remainder}   →   ${m.quotient} × ${m.block} = ${m.netOctet}`,
          `Diffusion : ${m.netOctet} + ${m.block} − 1 = ${m.lastOctet}`
        ),
        P(`Les octets avant l'octet significatif sont recopiés ; ceux d'après valent **0** pour le réseau et **255** pour la diffusion. Le réseau compte ${fmt(m.blocks)} blocs de ce type dans l'octet n° ${m.index + 1} :`),
        TABLE(['Bloc', 'Réseau', 'Diffusion'], blockRows, { mono: [1, 2], highlight: blockRows.findIndex((r) => r[0] === `n° ${m.quotient + 1}`) }),
        RESULT({ label: 'Réseau', value: cidr }, { label: prefix <= 30 ? 'Diffusion' : 'Dernière', value: toIp(c.lastAddress) }),
        NOTE(`Le nombre magique est aussi le poids du dernier bit à 1 du masque (${octetBits(m.maskOctet)} → ${m.block}) : c'est exactement le calcul binaire, en plus rapide.`),
      ];
    }
    steps.push({ key: 'magic', short: 'Méthode rapide', title: 'Méthode rapide : le nombre magique', blocks: magicBlocks });

    // 9. Récapitulatif
    const recap = [
      ['Adresse', toIp(ip), toBinary(ip)],
      ['Masque', toIp(c.mask), toBinary(c.mask)],
      ['Wildcard', toIp(c.wildcard), toBinary(c.wildcard)],
      ['Réseau', toIp(c.network), toBinary(c.network)],
      prefix <= 30 ? ['Diffusion', toIp(c.broadcast), toBinary(c.broadcast)] : null,
      ['Première', toIp(c.firstHost), toBinary(c.firstHost)],
      ['Dernière', toIp(c.lastHost), toBinary(c.lastHost)],
    ].filter(Boolean);
    const roleNote = {
      network: `Attention : ${toIp(ip)} est l'adresse réseau elle-même, elle ne peut pas être donnée à une machine.`,
      broadcast: `Attention : ${toIp(ip)} est l'adresse de diffusion, elle ne peut pas être donnée à une machine.`,
      host: `Vérification : ${toIp(ip)} est bien comprise entre ${toIp(c.network)} et ${toIp(c.lastAddress)}. C'est l'hôte n° ${fmt(prefix >= 31 ? c.offset + 1 : c.offset)} du réseau.`,
    }[c.role];
    steps.push({
      key: 'summary',
      short: 'Récapitulatif',
      title: 'Récapitulatif',
      blocks: [
        TABLE(['', 'Décimal', 'Binaire'], recap, { mono: [1, 2], firstColHead: true }),
        RESULT({ label: 'Réseau', value: cidr }, { label: 'Adresses', value: fmt(c.total) }, { label: 'Hôtes utilisables', value: fmt(c.usable) }),
        NOTE(roleNote, c.role === 'host' ? 'tip' : 'warn'),
      ],
    });

    return { calc: c, steps };
  }

  // ---------------------------------------------------------------------------
  // Version texte (copie et export .txt)
  // ---------------------------------------------------------------------------

  const plain = (s) => String(s).replace(/\*\*/g, '');

  function wrap(text, width = 92, indent = '') {
    const words = plain(text).split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      if (line && (line + ' ' + w).length > width) {
        lines.push(indent + line);
        line = w;
      } else line = line ? `${line} ${w}` : w;
    }
    if (line) lines.push(indent + line);
    return lines;
  }

  /** « 11000000.10101000.00000001.00|001010 » : « | » marque la limite réseau / hôte. */
  function bitsText(value, prefix, split) {
    const b = bits32(value);
    let out = '';
    for (let i = 0; i < 32; i++) {
      if (i && i % 8 === 0) out += '.';
      if (split && i === prefix && prefix > 0 && prefix < 32) out += '|';
      out += b[i];
    }
    if (split && (prefix === 0 || prefix === 32)) out = prefix === 0 ? `|${out}` : `${out}|`;
    return out;
  }

  function blockLines(block) {
    const pad = (s, n) => String(s).padEnd(n, ' ');
    switch (block.type) {
      case 'p':
        return wrap(block.text);
      case 'note':
        return wrap(`${block.level === 'warn' ? '/!\\ ' : '> '}${block.text}`, 92, '');
      case 'formula':
        return block.lines.map((l) => `    ${l}`);
      case 'result':
        return [`  => ${block.items.map((i) => `${i.label} : ${i.value}`).join('   |   ')}`];
      case 'table': {
        const all = [block.head, ...block.rows];
        const widths = block.head.map((_, col) => Math.max(...all.map((r) => String(r[col] ?? '').length)));
        const line = (r, mark) => `  ${mark ? '>' : ' '} ${r.map((v, col) => pad(v ?? '', widths[col])).join('   ')}`.trimEnd();
        return [line(block.head), `    ${widths.map((w) => '-'.repeat(w)).join('   ')}`, ...block.rows.map((r, i) => line(r, i === block.highlight))];
      }
      case 'bits': {
        const lw = Math.max(...block.rows.map((r) => r.label.length));
        const out = [];
        for (const r of block.rows) {
          const bits = bitsText(r.value, block.prefix, block.split);
          if (r.sign === '=' || r.sign === 'NON') out.push(`    ${' '.repeat(lw)}     ${'-'.repeat(bits.length)}`);
          out.push(`    ${pad(r.label, lw)} ${pad(r.sign || '', 3)} ${bits}   = ${toIp(r.value)}`);
        }
        if (block.split && block.prefix > 0 && block.prefix < 32) out.push(`    (« | » sépare les ${block.prefix} bits réseau des ${32 - block.prefix} bits hôte)`);
        return out;
      }
      case 'decompose': {
        const cells = (list) => list.map((v) => String(v).padStart(4, ' ')).join('');
        return [
          `  Octet n° ${block.index + 1} : ${block.value}`,
          `    Poids        ${cells(block.steps.map((s) => s.weight))}`,
          `    Reste avant  ${cells(block.steps.map((s) => s.before))}`,
          `    Bit          ${cells(block.steps.map((s) => s.bit))}`,
          `    → ${block.value} = ${block.bits}${block.terms.length ? ` (${block.terms.join(' + ')})` : ''}`,
        ];
      }
      default:
        return [];
    }
  }

  function explainLines(ip, prefix) {
    const { calc, steps } = explain(ip, prefix);
    const lines = [`Calcul binaire de ${toIp(calc.ip)}/${prefix} — étape par étape`, ''];
    steps.forEach((s, i) => {
      const title = `Étape ${i + 1}/${steps.length} — ${s.title}`;
      lines.push(title, '-'.repeat(title.length));
      for (const b of s.blocks) {
        lines.push(...blockLines(b), '');
      }
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  // ---------------------------------------------------------------------------
  // Exercices
  // ---------------------------------------------------------------------------

  const LEVELS = {
    facile: { label: 'Facile', help: 'Préfixes /8, /16 et /24 : on recopie ou on met à zéro des octets entiers.' },
    moyen: { label: 'Moyen', help: 'Préfixes /17 à /30 dans des réseaux privés : un octet à calculer.' },
    expert: { label: 'Expert', help: 'Préfixes /9 à /30 sur n\'importe quelle adresse de classe A, B ou C.' },
  };

  const EXERCISE_FIELDS = [
    { key: 'mask', label: 'Masque', kind: 'ip' },
    { key: 'network', label: 'Adresse réseau', kind: 'ip' },
    { key: 'broadcast', label: 'Diffusion', kind: 'ip' },
    { key: 'first', label: 'Première adresse', kind: 'ip' },
    { key: 'last', label: 'Dernière adresse', kind: 'ip' },
    { key: 'hosts', label: 'Hôtes utilisables', kind: 'count' },
  ];

  function makeExercise(level = 'moyen', rng = Math.random) {
    const int = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const lvl = LEVELS[level] ? level : 'moyen';
    for (let attempt = 0; ; attempt++) {
      let prefix;
      let first;
      let second;
      if (lvl === 'facile') prefix = [8, 16, 24][int(0, 2)];
      else if (lvl === 'moyen') prefix = int(17, 30);
      else prefix = int(9, 30);

      if (lvl === 'expert') {
        do first = int(1, 223);
        while (first === 127);
        second = int(0, 255);
      } else {
        // Réseaux privés (RFC 1918) dont le préfixe est compatible avec celui de l'exercice
        const choices = [() => [10, int(0, 255)]];
        if (prefix >= 12) choices.push(() => [172, int(16, 31)]);
        if (prefix >= 16) choices.push(() => [192, 168]);
        [first, second] = choices[int(0, choices.length - 1)]();
      }
      const ip = fromOctets([first, second, int(0, 255), int(1, 254)]);
      const c = calculate(ip, prefix);
      // Une adresse d'hôte (pas l'adresse réseau ni la diffusion), sauf malchance répétée
      if (c.role === 'host' || attempt > 20) return { ip, prefix, level: lvl };
    }
  }

  function exerciseAnswers(ex) {
    const c = calculate(ex.ip, ex.prefix);
    return {
      mask: c.mask,
      network: c.network,
      broadcast: c.broadcast === null ? c.lastAddress : c.broadcast,
      first: c.firstHost,
      last: c.lastHost,
      hosts: c.usable,
    };
  }

  /** answers : { mask: '255.255.255.0', …, hosts: '254' } → résultat par champ. */
  function checkExercise(ex, answers) {
    const expected = exerciseAnswers(ex);
    const fields = {};
    let score = 0;
    for (const f of EXERCISE_FIELDS) {
      const raw = String((answers && answers[f.key]) ?? '').trim();
      const want = expected[f.key];
      const shown = f.kind === 'ip' ? toIp(want) : fmt(want);
      if (!raw) {
        fields[f.key] = { ok: false, empty: true, expected: shown };
        continue;
      }
      let value;
      try {
        if (f.kind === 'ip') value = C.parseIp(raw, f.key);
        else {
          const digits = raw.replace(/[\s  .]/g, ''); // « 16 382 », « 16.382 » acceptés
          if (!/^\d+$/.test(digits)) throw new CalcError('Un nombre entier est attendu.', f.key);
          value = Number(digits);
        }
      } catch (err) {
        fields[f.key] = { ok: false, error: err.message, expected: shown };
        continue;
      }
      const ok = value === want;
      if (ok) score++;
      fields[f.key] = { ok, expected: shown };
    }
    return { fields, score, total: EXERCISE_FIELDS.length };
  }

  return {
    WEIGHTS,
    MASK_OCTETS,
    LEVELS,
    EXERCISE_FIELDS,
    octets,
    fromOctets,
    octetBits,
    bits32,
    decompose,
    sumText,
    maskOctetBits,
    parseBinaryIp,
    parseAnyIp,
    formats,
    magic,
    explain,
    explainLines,
    bitsText,
    makeExercise,
    exerciseAnswers,
    checkExercise,
  };
});
