/*
 * fixtures.js — Données de test : saisies complètes pour le modèle livré, signature PNG minimale.
 */
'use strict';

const path = require('node:path');
const zlib = require('node:zlib');

const MODEL = path.join(__dirname, '..', 'modeles', 'Fiche d\'intervention (test).docx');

/** PNG valide (trait noir sur fond transparent), sans dépendance. */
function signaturePng(width = 240, height = 80) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 6; // RVBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onLine = Math.abs(y - (height / 2 + Math.sin(x / 18) * height * 0.3)) < 2;
      if (onLine) raw[y * (width * 4 + 1) + 1 + x * 4 + 3] = 255;
    }
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Saisies d'une fiche complète pour le modèle livré (clés : t<tableau>.r<ligne>.c<case>). */
const VALUES = {
  't0.r0.c1': 'Jean Dupont',
  't0.r1.c1': '12 avenue de la Gare, 66000 Perpignan',
  't0.r2.c1': 'j.dupont@exemple.fr',
  't0.r3.c1': '06 12 34 56 78',
  't0.r4.c1': 'Comptabilité',
  't0.r5.c1': 'Dupont & Fils <SARL>',
  't0.r6.c1': 'C-0042',
  't0.r7.c1': 'Mme Martin',
  't0.r8.c1': '2026-10-13',
  't0.r9.c1': 'Waynne K.',
  't0.r10.c1': { selected: [0] },
  't0.r11.c1': { selected: [0], extra: { 0: 'MC-2026-118' } },
  't1.r0.c1': '09:05',
  't1.r1.c1': 'Le poste ne démarre plus.',
  't1.r2.c1': 'Écran noir au démarrage.\nLe ventilateur tourne, aucun bip.\nVoyant d\'alimentation orange.',
  't1.r3.c1': '2026-10-12T17:40',
  't1.r4.c1': { selected: [2] },
  't1.r5.c1': { selected: [0] },
  't1.r6.c1': 'Aucun',
  't1.r7.c1': 'Coupure de courant la veille au soir.',
  't1.r8.c1': 'Débranché / rebranché le câble secteur.',
  't1.r9.c1': '1 poste',
  't1.r10.c1': { selected: [0] },
  't2.r0.c1': { selected: [0, 7], extra: { 7: 'Alimentation' } },
  't2.r1.c1': '10:35',
  't2.r2.c1': '1h30 — 90 € HT',
  't2.r3.c1': 'INT-20261013-01',
  't2.r4.c1': true,
  't2.r5.c1': 'Bloc d\'alimentation hors service (condensateurs gonflés).',
  't2.r6.c1': 'Remplacement du bloc d\'alimentation, tests de charge.',
  't2.r7.c1': 'Alimentation 500 W 80+ Bronze, réf. ALI-500B, ×1',
  't2.r8.c1': '',
  't2.r9.c1': { selected: [2] },
  't2.r10.c1': { selected: [0] },
  't3.r0.c1': 'Dell',
  't3.r1.c1': 'OptiPlex 7090',
  't3.r2.c1': 'D13M',
  't3.r3.c1': { selected: [0] },
  't3.r4.c1': 'OptiPlex 7090 Tour',
  't3.r5.c1': '7XK2Q93',
  't3.r6.c1': 'Windows 11 Pro 24H2',
  't3.r7.c1': { selected: [0], extra: { 0: '2027-03-31' } },
  't3.r8.c1': { selected: [1] },
  't4.r0.c1': 'Poussière importante dans le boîtier.',
  't4.r1.c1': { selected: [1], extra: { 1: 'contrôle dans 1 mois' } },
  't4.r2.c1': 'Installer un onduleur.',
  't4.r3.c1': '2026-11-13',
  't5.r0.c1': { selected: [0] },
  't5.r1.c1': 'Intervention rapide, merci.',
  't5.r2.c1': ['Perpignan', '2026-10-13'],
  't5.r3.c1': { name: 'Waynne K.', image: '' },
  't5.r4.c1': { name: 'Jean Dupont', image: '' },
};

module.exports = { MODEL, VALUES, signaturePng };
