/*
 * ipcalc.js — Calculs IPv4 de CalkIP (aucune dépendance, aucun accès réseau).
 *
 * Chargé tel quel par l'interface (<script>, objet global « IPCalc ») et par le processus principal
 * (require) pour l'export des listes : les deux utilisent exactement les mêmes calculs.
 *
 * Les adresses sont manipulées comme des entiers non signés 32 bits (0 … 4 294 967 295).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IPCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX = 0xffffffff;
  /** Taille maximale d'une liste exportée : un /8 complet (16 777 216 adresses, ~230 Mo). */
  const EXPORT_LIMIT = 2 ** 24;
  /** Préfixes proposés directement (les autres passent par « Autre »). */
  const PRESETS = [8, 16, 24, 32];

  class CalcError extends Error {
    constructor(message, field) {
      super(message);
      this.name = 'CalcError';
      this.field = field || null; // 'ip' | 'mask' | 'prefix' | 'exclusions' | 'hosts'
    }
  }

  // ---------------------------------------------------------------------------
  // Conversions
  // ---------------------------------------------------------------------------

  /** « a.b.c.d » → entier. Les zéros en tête sont lus en décimal (« 010 » = 10). */
  function parseIp(text, field = 'ip') {
    const s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) throw new CalcError('Saisissez une adresse IPv4 (ex. 192.168.1.10).', field);
    if (s.includes(':')) throw new CalcError('Adresse IPv6 : CalkIP ne calcule que l\'IPv4.', field);
    const parts = s.split('.');
    if (parts.length !== 4) throw new CalcError(`« ${s} » n'est pas une adresse IPv4 : il faut 4 nombres séparés par des points.`, field);
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const p = parts[i];
      if (!/^\d{1,3}$/.test(p)) throw new CalcError(`« ${s} » : l'octet n° ${i + 1} (« ${p} ») doit être un nombre de 0 à 255.`, field);
      const n = Number(p);
      if (n > 255) throw new CalcError(`« ${s} » : l'octet n° ${i + 1} (${n}) dépasse 255.`, field);
      value = value * 256 + n;
    }
    return value >>> 0;
  }

  function toIp(n) {
    n = n >>> 0;
    return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  }

  function assertPrefix(prefix) {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new CalcError(`Préfixe ${prefix} invalide : il doit être compris entre 0 et 32.`, 'prefix');
  }

  function prefixToMask(prefix) {
    assertPrefix(prefix);
    return prefix === 0 ? 0 : (MAX << (32 - prefix)) >>> 0;
  }

  /** Masque « 255.255.255.0 » → préfixe ; refuse les masques non contigus (255.0.255.0). */
  function maskToPrefix(mask) {
    const m = mask >>> 0;
    const inverted = ~m >>> 0;
    if ((inverted & (inverted + 1)) !== 0) {
      throw new CalcError(`Masque ${toIp(m)} invalide : les bits à 1 doivent être contigus (ex. 255.255.255.0).`, 'mask');
    }
    let prefix = 0;
    for (let bit = 31; bit >= 0 && (m >>> bit) & 1; bit--) prefix++;
    return prefix;
  }

  function parsePrefix(value) {
    const s = String(value).trim().replace(/^\//, '');
    // Zéros en tête acceptés comme pour les octets (« /024 » = /24)
    if (!/^\d{1,3}$/.test(s) || Number(s) > 32) throw new CalcError(`Préfixe « ${value} » invalide : choisissez un nombre de 0 à 32.`, 'prefix');
    return Number(s);
  }

  function toBinary(n) {
    const b = (n >>> 0).toString(2).padStart(32, '0');
    return `${b.slice(0, 8)}.${b.slice(8, 16)}.${b.slice(16, 24)}.${b.slice(24)}`;
  }

  function toHex(n) {
    return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Saisie : « 192.168.1.10 », « 192.168.1.10/26 », « 192.168.1.10 255.255.255.192 »,
  // « 192.168.1.10/255.255.255.192 »
  // ---------------------------------------------------------------------------

  function parseInput(text) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) throw new CalcError('Saisissez une adresse IPv4 (ex. 192.168.1.10 ou 192.168.1.10/24).', 'ip');
    const m = /^([^\s/]+)(\s*\/\s*|\s+)?(.*)$/.exec(s);
    const ip = parseIp(m[1]);
    const rest = (m[3] || '').trim();
    if (!rest) {
      if (m[2] && m[2].includes('/')) throw new CalcError('Préfixe manquant après « / » (ex. 192.168.1.10/24).', 'prefix');
      return { ip, prefix: null, source: null };
    }
    if (/^\d{1,3}$/.test(rest)) return { ip, prefix: parsePrefix(rest), source: 'cidr' };
    if (rest.includes('.')) return { ip, prefix: maskToPrefix(parseIp(rest, 'mask')), source: 'mask' };
    throw new CalcError(`« ${rest} » : indiquez un préfixe (/24) ou un masque (255.255.255.0) après l'adresse.`, 'mask');
  }

  // ---------------------------------------------------------------------------
  // Classes et plages réservées
  // ---------------------------------------------------------------------------

  function ipClass(ip) {
    const first = ip >>> 24;
    if (first < 128) return 'A';
    if (first < 192) return 'B';
    if (first < 224) return 'C';
    if (first < 240) return 'D';
    return 'E';
  }

  /** Préfixe « historique » de la classe (A → /8, B → /16, C → /24) ; null pour D et E. */
  function classfulPrefix(ip) {
    return { A: 8, B: 16, C: 24 }[ipClass(ip)] || null;
  }

  // Registre IANA des adresses à usage spécial (RFC 6890 et suivantes), du plus précis au plus large
  const SPECIAL = [
    ['255.255.255.255', 32, 'broadcast', 'Diffusion limitée', 'Adresse de diffusion sur le réseau local (255.255.255.255) : jamais attribuée à un hôte.'],
    ['192.0.0.0', 24, 'reserved', 'Réservée (IETF)', 'Réservée aux protocoles de l\'IETF (RFC 6890).'],
    ['192.0.2.0', 24, 'documentation', 'Documentation (TEST-NET-1)', 'Réservée aux exemples et à la documentation (RFC 5737) : non routée sur Internet.'],
    ['198.51.100.0', 24, 'documentation', 'Documentation (TEST-NET-2)', 'Réservée aux exemples et à la documentation (RFC 5737) : non routée sur Internet.'],
    ['203.0.113.0', 24, 'documentation', 'Documentation (TEST-NET-3)', 'Réservée aux exemples et à la documentation (RFC 5737) : non routée sur Internet.'],
    ['192.88.99.0', 24, 'reserved', 'Relais 6to4 (obsolète)', 'Ancienne plage anycast des relais 6to4 (RFC 7526).'],
    ['169.254.0.0', 16, 'linklocal', 'Lien local (APIPA)', 'Adresse automatique attribuée quand aucun serveur DHCP ne répond (RFC 3927) : non routée.'],
    ['192.168.0.0', 16, 'private', 'Privée (RFC 1918)', 'Réseau privé : utilisable librement en interne, non routé sur Internet.'],
    ['198.18.0.0', 15, 'reserved', 'Tests de performance', 'Réservée aux bancs de test réseau (RFC 2544).'],
    ['172.16.0.0', 12, 'private', 'Privée (RFC 1918)', 'Réseau privé : utilisable librement en interne, non routé sur Internet.'],
    ['100.64.0.0', 10, 'cgnat', 'Partagée (CGNAT)', 'Espace partagé des opérateurs pour le NAT à grande échelle (RFC 6598) : non routé sur Internet.'],
    ['0.0.0.0', 8, 'thisnetwork', '« Ce réseau »', 'Plage 0.0.0.0/8 : désigne « ce réseau » (RFC 1122), pas attribuable à un hôte.'],
    ['10.0.0.0', 8, 'private', 'Privée (RFC 1918)', 'Réseau privé : utilisable librement en interne, non routé sur Internet.'],
    ['127.0.0.0', 8, 'loopback', 'Boucle locale (loopback)', 'Adresse de bouclage : désigne la machine elle-même, jamais le réseau.'],
    ['224.0.0.0', 4, 'multicast', 'Multidiffusion (classe D)', 'Adresse de groupe multicast : pas d\'attribution à un hôte ni de plage DHCP.'],
    ['240.0.0.0', 4, 'reserved', 'Réservée (classe E)', 'Plage expérimentale réservée (RFC 1112) : non utilisable en pratique.'],
  ].map(([base, prefix, kind, label, help]) => ({ base: parseIp(base), prefix, mask: prefixToMask(prefix), kind, label, help }));

  function addressType(ip) {
    const hit = SPECIAL.find((r) => ((ip & r.mask) >>> 0) === r.base);
    if (hit) return { kind: hit.kind, label: hit.label, help: hit.help, range: `${toIp(hit.base)}/${hit.prefix}` };
    return { kind: 'public', label: 'Publique', help: 'Adresse publique, routée sur Internet.', range: null };
  }

  // ---------------------------------------------------------------------------
  // Choix du préfixe
  // ---------------------------------------------------------------------------

  /**
   * mode : 'auto' | nombre (0–32).
   * Automatique : le préfixe ou le masque saisi avec l'adresse, sinon celui de la classe (A/B/C).
   */
  function resolvePrefix(parsed, mode) {
    if (mode === 'auto' || mode === undefined || mode === null) {
      if (parsed.prefix !== null) {
        return { prefix: parsed.prefix, reason: parsed.source === 'mask' ? `masque saisi (${toIp(prefixToMask(parsed.prefix))})` : `préfixe saisi (/${parsed.prefix})` };
      }
      const prefix = classfulPrefix(parsed.ip);
      const cls = ipClass(parsed.ip);
      if (prefix === null) {
        throw new CalcError(
          `Mode automatique impossible : ${toIp(parsed.ip)} est une adresse de classe ${cls} (${cls === 'D' ? 'multicast' : 'réservée'}), qui n'a pas de masque par défaut. Choisissez un préfixe.`,
          'prefix'
        );
      }
      return { prefix, reason: `classe ${cls} → /${prefix}` };
    }
    const prefix = parsePrefix(mode);
    return { prefix, reason: `choisi manuellement (/${prefix})` };
  }

  /** Plus petit sous-réseau (plus grand préfixe) contenant `hosts` adresses utilisables. */
  function prefixForHosts(hosts) {
    // Entier décimal uniquement (pas de « 0x10 », « 1e2 » ni booléen)
    const ok = typeof hosts === 'number' ? Number.isInteger(hosts) : typeof hosts === 'string' && /^\s*\d+\s*$/.test(hosts);
    const n = ok ? Number(hosts) : NaN;
    if (!Number.isInteger(n) || n < 1) throw new CalcError('Indiquez un nombre d\'hôtes entier, au moins 1.', 'hosts');
    if (n > 2 ** 32 - 2) throw new CalcError('Aucun réseau IPv4 ne peut contenir autant d\'hôtes.', 'hosts');
    if (n === 1) return 32;
    if (n === 2) return 31;
    for (let prefix = 30; prefix >= 0; prefix--) {
      if (2 ** (32 - prefix) - 2 >= n) return prefix;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Calcul d'un sous-réseau
  // ---------------------------------------------------------------------------

  /** Nombre d'adresses utilisables par des hôtes pour un préfixe (RFC 3021 pour /31). */
  function usableCount(prefix) {
    assertPrefix(prefix);
    if (prefix === 32) return 1;
    if (prefix === 31) return 2;
    return 2 ** (32 - prefix) - 2;
  }

  function calculate(ip, prefix) {
    ip = ip >>> 0;
    const mask = prefixToMask(prefix);
    const wildcard = ~mask >>> 0;
    const network = (ip & mask) >>> 0;
    const last = (network | wildcard) >>> 0;
    const total = 2 ** (32 - prefix);
    // /31 : liaison point à point, les deux adresses sont des hôtes ; /32 : une seule adresse (hôte)
    const hasBroadcast = prefix <= 30;
    const firstHost = hasBroadcast ? network + 1 : network;
    const lastHost = hasBroadcast ? last - 1 : last;
    const usable = usableCount(prefix);
    const type = addressType(ip);

    let role = 'host';
    if (hasBroadcast && ip === network) role = 'network';
    else if (hasBroadcast && ip === last) role = 'broadcast';

    const reverseOctets = [network >>> 24, (network >>> 16) & 255, (network >>> 8) & 255, network & 255].slice(0, Math.floor(prefix / 8));

    return {
      ip,
      prefix,
      mask,
      wildcard,
      network,
      broadcast: hasBroadcast ? last : null,
      lastAddress: last,
      firstHost: firstHost >>> 0,
      lastHost: lastHost >>> 0,
      total,
      usable,
      role, // 'host' | 'network' | 'broadcast'
      offset: ip - network, // position de l'adresse saisie dans le sous-réseau (0 = adresse réseau)
      ipClass: ipClass(ip),
      classfulPrefix: classfulPrefix(ip),
      type,
      // Zone DNS inverse : octets entiers du réseau, à l'envers (« 1.168.192.in-addr.arpa » pour un /24) ;
      // plus large qu'un /8 : la racine « in-addr.arpa »
      reverseZone: reverseOctets.length ? `${reverseOctets.slice().reverse().join('.')}.in-addr.arpa` : 'in-addr.arpa',
      reverseZoneExact: prefix % 8 === 0,
      previousNetwork: network === 0 ? null : (network - total) >>> 0,
      nextNetwork: last === MAX ? null : (last + 1) >>> 0,
      binary: { ip: toBinary(ip), mask: toBinary(mask), network: toBinary(network) },
      hex: { ip: toHex(ip), mask: toHex(mask) },
    };
  }

  // ---------------------------------------------------------------------------
  // Baux DHCP : plage distribuable après passerelle, réservations et exclusions
  // ---------------------------------------------------------------------------

  /**
   * Exclusions : une par ligne ou séparées par des virgules. Formats : « 192.168.1.50 »,
   * « 192.168.1.50-192.168.1.60 », « 192.168.1.50-60 ». Renvoie des plages [début, fin] fusionnées.
   */
  function parseExclusions(text) {
    const ranges = [];
    // Commentaires « # … » retirés ligne par ligne AVANT le découpage sur « , » et « ; »
    const items = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const item of items) {
      const m = /^([\d.]+)\s*(?:-|–|à)\s*([\d.]+)$/.exec(item);
      if (m) {
        const start = parseIp(m[1], 'exclusions');
        let end;
        if (/^\d{1,3}$/.test(m[2])) {
          const n = Number(m[2]);
          if (n > 255) throw new CalcError(`Exclusion « ${item} » : ${n} dépasse 255.`, 'exclusions');
          end = ((start & 0xffffff00) | n) >>> 0;
        } else {
          end = parseIp(m[2], 'exclusions');
        }
        if (end < start) throw new CalcError(`Exclusion « ${item} » : la fin de la plage précède son début.`, 'exclusions');
        ranges.push([start, end]);
      } else {
        const ip = parseIp(item, 'exclusions');
        ranges.push([ip, ip]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const prev = merged[merged.length - 1];
      if (prev && r[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  const GATEWAY_MODES = ['first', 'last', 'none', 'custom'];

  /**
   * options : {
   *   gateway: 'first' | 'last' | 'none' | 'custom',  customGateway: '192.168.1.254',
   *   reserveStart: n — adresses fixes en début de plage (après la passerelle quand elle est la première
   *                 adresse, sinon à partir de la première adresse utilisable),
   *   reserveEnd: n — en fin de plage (avant la passerelle quand elle est la dernière),
   *   exclusions: texte libre (voir parseExclusions),
   *   limit: nombre de baux souhaité (vide = le maximum) — la plage s'arrête dès qu'il est atteint
   * }
   * Résultat : {
   *   gateway, start, end, rangeCount (taille de la plage start–end),
   *   excluded: [[a, b]…] exclusions de l'utilisateur ramenées à la plage, excludedCount,
   *   gatewayInPool: passerelle personnalisée située dans la plage (retirée des baux),
   *   skip: [[a, b]…] adresses à sauter dans la plage (exclusions + passerelle) — pour forEachAddress,
   *   leases: nombre maximum de baux DHCP distribuables, notes: []
   * }
   */
  function dhcpPool(calc, options = {}) {
    const notes = [];
    let low = calc.firstHost;
    let high = calc.lastHost;
    let gateway = null;
    const mode = options.gateway === undefined || options.gateway === null ? 'first' : options.gateway;
    if (!GATEWAY_MODES.includes(mode)) throw new CalcError(`Mode de passerelle « ${mode} » inconnu.`, 'gateway');
    const reserveStart = Math.max(0, Math.floor(Number(options.reserveStart) || 0));
    const reserveEnd = Math.max(0, Math.floor(Number(options.reserveEnd) || 0));

    if (calc.prefix >= 31) notes.push(calc.prefix === 32 ? 'Un /32 désigne une seule machine : il n\'y a pas de plage DHCP à proprement parler.' : 'Un /31 est une liaison point à point (RFC 3021) : deux adresses, sans réseau ni diffusion.');

    if (mode === 'first') {
      gateway = low;
      low += 1;
    } else if (mode === 'last') {
      gateway = high;
      high -= 1;
    } else if (mode === 'custom') {
      const gw = parseIp(options.customGateway, 'gateway');
      if (gw < calc.firstHost || gw > calc.lastHost) throw new CalcError(`La passerelle ${toIp(gw)} n'est pas une adresse utilisable de ce réseau (${toIp(calc.firstHost)} – ${toIp(calc.lastHost)}).`, 'gateway');
      gateway = gw;
    }

    low += reserveStart;
    high -= reserveEnd;
    // Passerelle personnalisée au bord de la plage : la plage se resserre plutôt que de la contenir
    if (mode === 'custom' && low <= high) {
      if (gateway === high) high -= 1;
      else if (gateway === low) low += 1;
    }
    const userRanges = parseExclusions(options.exclusions); // validée même si la plage est vide
    const limit = parseLimit(options.limit);

    // Exclusions et passerelle personnalisée ramenées à une plage [lo, hi]
    const clip = (lo, hi) => {
      const excluded = [];
      let excludedCount = 0;
      for (const [a, b] of userRanges) {
        const s = Math.max(a, lo);
        const e = Math.min(b, hi);
        if (s <= e) {
          excluded.push([s, e]);
          excludedCount += e - s + 1;
        }
      }
      // Passerelle personnalisée au milieu de la plage : une adresse de moins (sauf si déjà exclue)
      const gatewayInPool = mode === 'custom' && gateway >= lo && gateway <= hi && !excluded.some(([a, b]) => gateway >= a && gateway <= b);
      const skip = gatewayInPool ? mergeRanges(excluded.concat([[gateway, gateway]])) : excluded.map((r) => [r[0], r[1]]);
      const rangeCount = Math.max(0, hi - lo + 1);
      return { excluded, excludedCount, gatewayInPool, skip, rangeCount, leases: Math.max(0, rangeCount - excludedCount - (gatewayInPool ? 1 : 0)) };
    };

    let pool = clip(low, high);
    if (pool.rangeCount === 0) notes.push('Plus aucune adresse distribuable : réduisez les réservations ou choisissez un réseau plus grand.');
    else {
      const ignored = userRanges.filter(([a, b]) => b < low || a > high).map(([a, b]) => (a === b ? toIp(a) : `${toIp(a)}-${toIp(b)}`));
      if (ignored.length) notes.push(`Exclusion(s) hors de la plage DHCP, sans effet : ${ignored.slice(0, 5).join(', ')}${ignored.length > 5 ? '…' : ''}.`);
    }

    // Nombre de baux souhaité : la plage s'arrête dès qu'il est atteint, le reste du réseau reste libre
    const available = pool.leases;
    let free = 0;
    if (limit !== null && pool.leases > limit) {
      let remaining = limit;
      let cursor = low;
      let end = null;
      for (const [a, b] of pool.skip) {
        const gap = a - cursor; // adresses distribuables entre cursor et a - 1
        if (gap >= remaining) {
          end = cursor + remaining - 1;
          break;
        }
        remaining -= Math.max(0, gap);
        cursor = b + 1;
      }
      if (end === null) end = cursor + remaining - 1;
      high = end;
      pool = clip(low, high);
      free = available - pool.leases;
      notes.push(`Plage limitée aux ${fmt(limit)} baux demandés : ${fmt(free)} adresse(s) distribuable(s) laissée(s) libre(s) après ${toIp(high)}.`);
    } else if (limit !== null && pool.leases < limit) {
      notes.push(`Seulement ${fmt(pool.leases)} baux disponibles pour ${fmt(limit)} demandés : choisissez un réseau plus grand (assistant « nombre d'appareils »).`);
    }

    return {
      gateway,
      start: pool.rangeCount > 0 ? low >>> 0 : null,
      end: pool.rangeCount > 0 ? high >>> 0 : null,
      rangeCount: pool.rangeCount,
      reserveStart,
      reserveEnd,
      excluded: pool.excluded,
      excludedCount: pool.excludedCount,
      gatewayInPool: pool.gatewayInPool,
      skip: pool.skip,
      leases: pool.leases,
      limit,
      available, // baux possibles sans la limite
      free, // adresses distribuables laissées hors de la plage à cause de la limite
      shortage: limit !== null && available < limit ? limit - available : 0,
      notes,
    };
  }

  /** Nombre de baux souhaité : vide = pas de limite, sinon entier ≥ 1. */
  function parseLimit(value) {
    if (value === undefined || value === null || String(value).trim() === '' || Number(value) === 0) return null;
    const s = String(value).trim();
    if (!/^\d+$/.test(s)) throw new CalcError('Nombre de baux souhaité invalide : indiquez un entier (ou laissez vide).', 'limit');
    return Number(s);
  }

  function mergeRanges(ranges) {
    const sorted = ranges.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of sorted) {
      const prev = merged[merged.length - 1];
      if (prev && r[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], r[1]);
      else merged.push(r);
    }
    return merged;
  }

  /**
   * Parcourt les adresses d'une plage [start, end] en sautant les exclusions (triées, fusionnées).
   * Appelle emit(ip) pour chacune ; s'arrête si emit renvoie false.
   */
  function forEachAddress(start, end, excluded, emit) {
    if (start === null || end === null) return;
    let i = 0;
    for (let ip = start; ip <= end; ip++) {
      while (i < excluded.length && excluded[i][1] < ip) i++;
      if (i < excluded.length && ip >= excluded[i][0] && ip <= excluded[i][1]) {
        ip = excluded[i][1];
        continue;
      }
      if (emit(ip >>> 0) === false) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Découpage en sous-réseaux
  // ---------------------------------------------------------------------------

  /**
   * Découpe le réseau de `calc` en sous-réseaux /newPrefix. Renvoie { count, subnets (au plus `limit`) }.
   */
  function splitSubnets(calc, newPrefix, limit = 256, offset = 0) {
    const p = parsePrefix(newPrefix);
    if (p < calc.prefix) throw new CalcError(`Le découpage doit utiliser un préfixe ≥ /${calc.prefix} (taille du réseau actuel).`, 'split');
    if (!Number.isInteger(offset) || offset < 0) throw new CalcError('Position de départ du découpage invalide.', 'split');
    if (!Number.isInteger(limit) || limit < 0) throw new CalcError('Nombre de sous-réseaux à lister invalide.', 'split');
    const count = 2 ** (p - calc.prefix);
    const size = 2 ** (32 - p);
    const subnets = [];
    for (let i = offset; i < count && subnets.length < limit; i++) {
      const net = calc.network + i * size;
      subnets.push(calculate(net, p));
    }
    return { prefix: p, count, size, usablePerSubnet: usableCount(p), subnets };
  }

  // ---------------------------------------------------------------------------
  // Résumé texte (copie et en-tête des exports)
  // ---------------------------------------------------------------------------

  const fmt = (n) => Number(n).toLocaleString('fr-FR').replace(/ | /g, ' ');

  function summaryLines(calc, pool, meta = {}) {
    const lines = [];
    const row = (label, value) => lines.push(`${label.padEnd(28, ' ')}: ${value}`);
    if (meta.input) row('Adresse saisie', meta.input);
    if (meta.reason) row('Préfixe', `/${calc.prefix} — ${meta.reason}`);
    row('Réseau', `${toIp(calc.network)}/${calc.prefix}`);
    row('Masque', `${toIp(calc.mask)} (/${calc.prefix})`);
    row('Masque générique (wildcard)', toIp(calc.wildcard));
    row('Diffusion (broadcast)', calc.broadcast === null ? 'aucune (/31 ou /32)' : toIp(calc.broadcast));
    row('Première adresse utilisable', toIp(calc.firstHost));
    row('Dernière adresse utilisable', toIp(calc.lastHost));
    row('Adresses au total', fmt(calc.total));
    row('Hôtes utilisables', fmt(calc.usable));
    row('Classe', `${calc.ipClass}${calc.classfulPrefix ? ` (masque par défaut /${calc.classfulPrefix})` : ''}`);
    row('Type', calc.type.label);
    if (pool) {
      lines.push('');
      row('Passerelle', pool.gateway === null ? 'aucune réservée' : toIp(pool.gateway));
      if (pool.reserveStart) row('Réservées en début de plage', fmt(pool.reserveStart));
      if (pool.reserveEnd) row('Réservées en fin de plage', fmt(pool.reserveEnd));
      row('Plage DHCP', pool.start === null ? 'vide' : `${toIp(pool.start)} → ${toIp(pool.end)}`);
      if (pool.excludedCount) row('Adresses exclues', fmt(pool.excludedCount));
      if (pool.limit !== null && pool.limit !== undefined) {
        row('Baux demandés', fmt(pool.limit));
        if (pool.free) row('Libres (hors plage DHCP)', fmt(pool.free));
        row('BAUX DHCP', `${fmt(pool.leases)}${pool.shortage ? ` (il en manque ${fmt(pool.shortage)})` : ''}`);
      } else {
        row('BAUX DHCP MAXIMUM', fmt(pool.leases));
      }
    }
    return lines;
  }

  return {
    CalcError,
    MAX,
    EXPORT_LIMIT,
    PRESETS,
    parseIp,
    toIp,
    prefixToMask,
    maskToPrefix,
    parsePrefix,
    parseInput,
    toBinary,
    toHex,
    ipClass,
    classfulPrefix,
    addressType,
    resolvePrefix,
    prefixForHosts,
    usableCount,
    calculate,
    parseExclusions,
    mergeRanges,
    dhcpPool,
    forEachAddress,
    splitSubnets,
    summaryLines,
    formatNumber: fmt,
  };
});
