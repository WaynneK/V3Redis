/*
 * edit.test.js — Outil « Modifier » : objets ajoutés, pages, formulaire, caviardage, texte d'origine retiré.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { PDFDocument, StandardFonts, PDFName, PDFArray, degrees } = require('pdf-lib');
const Edit = require('../lib/edit.js');
const TR = require('../lib/textremove.js');
const { decodePDFRawStream, PDFRawStream } = require('pdf-lib');

/** PNG 2 × 2 (rouge), sans dépendance. */
function tinyPng() {
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
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Document de test : 3 pages de texte (la 3e pivotée), un formulaire sur la 1re. */
async function sample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`Page ${i + 1} : ligne à modifier`, { x: 60, y: 760, size: 14, font });
    p.drawText(`Reste de la page ${i + 1}`, { x: 60, y: 700, size: 14, font });
  }
  doc.getPage(2).setRotation(degrees(90));
  const form = doc.getForm();
  form.createTextField('nom').addToPage(doc.getPage(0), { x: 60, y: 600, width: 200, height: 22 });
  form.createCheckBox('ok').addToPage(doc.getPage(0), { x: 60, y: 560, width: 14, height: 14 });
  const d = form.createDropdown('ville');
  d.addOptions(['Paris', 'Perpignan']);
  d.addToPage(doc.getPage(0), { x: 60, y: 520, width: 120, height: 20 });
  return doc.save();
}

/** Contenu décodé (texte) de chaque page. */
async function contents(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const c = page.node.Contents();
    const list = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    return list.map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : '')).join('\n');
  });
}

/** Texte tel que pdf-lib l'écrit dans le contenu (chaîne hexadécimale, police standard). */
const hexOf = (text) => `<${Buffer.from(text, 'latin1').toString('hex').toUpperCase()}>`;

const line = (text, y) => ({ type: 'text', x: 60, y, w: 0, lines: [text], size: 14, lineHeight: 16.8, baseline: 13, font: 'Arial', color: '#1f3a5f' });

test('polices proposées : six familles, police du système trouvée ou police standard', () => {
  const fonts = Edit.fonts();
  assert.deepEqual(
    fonts.map((f) => f.name),
    ['Arial', 'Calibri', 'Verdana', 'Times New Roman', 'Georgia', 'Courier New']
  );
  for (const f of fonts) assert.equal(typeof f.unicode, 'boolean');
});

test('objets ajoutés : texte, image, formes, flèche, dessin, surlignage écrits dans la page', async () => {
  const src = await sample();
  const objects = [
    line('Texte ajouté — ŒUVRE €', 40),
    { type: 'image', x: 400, y: 40, w: 60, h: 60, image: 'logo', opacity: 0.8 },
    { type: 'rect', x: 60, y: 200, w: 150, h: 80, stroke: '#ea3d5a', fill: '#ffe6ea', width: 3 },
    { type: 'ellipse', x: 260, y: 200, w: 150, h: 80, stroke: '#2b7bd6', fill: null, width: 2 },
    { type: 'arrow', x1: 60, y1: 320, x2: 300, y2: 380, stroke: '#000000', width: 3 },
    { type: 'ink', points: [60, 450, 80, 470, 100, 450], stroke: '#a63ff0', width: 3 },
    { type: 'highlight', x: 55, y: 64, w: 200, h: 22, color: '#ffe14d' },
  ];
  const out = await Edit.editPdf(src, { pages: [{ src: 0, objects }, { src: 1, objects: [] }, { src: 2, objects: [] }] }, { logo: tinyPng() });
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 3);
  const [c0, c1] = await contents(out);
  assert.match(c0, / Do\b/, 'image dessinée');
  assert.match(c0, /\nh\nB\n/, 'rectangle (contour et fond)');
  assert.match(c0, /\nf\n/, 'surlignage, pointe de flèche');
  assert.ok((c0.match(/\bTj\b/g) || []).length >= 3, 'texte ajouté');
  assert.doesNotMatch(c1, / Do\b/, 'page 2 inchangée');
  // Repère de la page affichée : tout est encadré (q … Q) avec sa matrice
  assert.match(c0, /q\n1 0 0 1 0 0 cm/);
});

test('page pivotée : objets dessinés dans le repère de la page affichée', async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([600, 800]);
  p.setRotation(degrees(90));
  const page = (await PDFDocument.load(await doc.save())).getPage(0);
  assert.deepEqual(Edit.visualMatrix(page), { m: [0, 1, -1, 0, 600, 0], VW: 800, VH: 600 });
  const out = await Edit.editPdf(await doc.save(), { pages: [{ src: 0, objects: [line('Droit sur la page pivotée', 20)] }] }, {});
  const [c] = await contents(out);
  assert.match(c, /0 1 -1 0 600 0 cm/);
});

test('pages : ordre, suppression, duplication (ajouts séparés), page blanche', async () => {
  const src = await sample();
  const plan = {
    pages: [
      { src: 2, objects: [] },
      { src: 0, objects: [line('Sur la page 1', 40)] },
      { src: null, width: 300, height: 400, objects: [line('Page blanche', 40)] },
      { src: 0, objects: [] },
    ],
  };
  const out = await Edit.editPdf(src, plan, {});
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 4);
  assert.deepEqual(
    doc.getPages().map((p) => [Math.round(p.getWidth()), p.getRotation().angle]),
    [
      [595, 90],
      [595, 0],
      [300, 0],
      [595, 0],
    ]
  );
  const c = await contents(out);
  assert.ok(c[0].includes(hexOf('Page 3 : ligne \xe0 modifier')), 'page 3 en premier');
  assert.ok((c[1].match(/\bTj\b/g) || []).length > (c[3].match(/\bTj\b/g) || []).length, 'la copie ne reçoit pas les ajouts de l\'autre');
  // La page 2 d'origine, supprimée, n'est plus dans le fichier
  assert.ok(!c.some((x) => x.includes(hexOf('Reste de la page 2'))));
});

test('formulaire : texte (accents, symboles), case, liste ; aplatissement', async () => {
  const src = await sample();
  const pages = [0, 1, 2].map((i) => ({ src: i, objects: [] }));
  const out = await Edit.editPdf(src, { pages, form: { values: { nom: 'Élodie Ünïcode', ok: true, ville: 'Perpignan', inconnu: 'x' } } }, {});
  const form = (await PDFDocument.load(out)).getForm();
  assert.equal(form.getTextField('nom').getText(), 'Élodie Ünïcode');
  assert.equal(form.getCheckBox('ok').isChecked(), true);
  assert.deepEqual(form.getDropdown('ville').getSelected(), ['Perpignan']);
  const flat = await Edit.editPdf(src, { pages, form: { values: { nom: 'Jean' }, flatten: true } }, {});
  assert.equal((await PDFDocument.load(flat)).getForm().getFields().length, 0);
});

test('texte modifié : l\'ancien texte est retiré du fichier, la suite de la page est intacte', async () => {
  const src = await sample();
  // Ligne « Page 1 : ligne à modifier » (taille 14, ligne de base à 760 → y affiché ≈ 82)
  const edited = { ...line('Ligne réécrite', 69), cover: { x: 58, y: 68, w: 220, h: 18, color: '#ffffff' }, erase: true };
  const out = await Edit.editPdf(src, { pages: [{ src: 0, objects: [edited] }, { src: 1, objects: [] }, { src: 2, objects: [] }] }, {});
  const [c0, c1] = await contents(out);
  assert.ok(!c0.includes(hexOf('Page 1 : ligne \xe0 modifier')), 'texte d\'origine retiré');
  assert.match(c0, /\[-?\d+(\.\d+)?\] TJ/, 'remplacé par un déplacement');
  assert.ok(c0.includes(hexOf('Reste de la page 1')), 'autres lignes gardées');
  assert.ok(c1.includes(hexOf('Page 2 : ligne \xe0 modifier')), 'autres pages intactes');
  // Tout a été retiré : pas de cache blanc dessiné (le fond d'origine reste visible)
  assert.doesNotMatch(c0, /1 1 1 rg/);
});

test('texte modifié, police aux largeurs inconnues : texte gardé, cache dessiné', () => {
  const content = 'BT /F9 12 Tf 60 760 Td (Bonjour) Tj ET';
  const res = TR.removeTextInRects(content, [{ x1: 50, y1: 750, x2: 200, y2: 780 }], () => null);
  assert.equal(res.content, null);
  assert.deepEqual(res.kept, [1]);
});

test('lecture des instructions : chaînes, échappements, tableaux, dictionnaires, image en ligne', () => {
  const content = [
    '/P <</MCID 0 /Alt (a\\)b <c>)>> BDC',
    'BT /F1 10 Tf 1 0 0 1 10 20 Tm (Paren\\(the\\)se \\061\\n) Tj [(A) -250 (B)] TJ ET',
    'BI /W 2 /H 1 /CS /G /BPC 8 ID \x00\xffEI\x00 EI',
    'EMC 0.5 g 10 10 50 50 re f % commentaire',
  ].join('\n');
  const ops = TR.parseContent(content);
  assert.deepEqual(
    ops.map((o) => o.op),
    ['BDC', 'BT', 'Tf', 'Tm', 'Tj', 'TJ', 'ET', 'BI', 'EMC', 'g', 're', 'f']
  );
  assert.equal(ops.find((o) => o.op === 'Tj').args[0].str, 'Paren(the)se 1\n');
  assert.deepEqual(ops.find((o) => o.op === 'TJ').args[0], [{ str: 'A' }, -250, { str: 'B' }]);
  assert.throws(() => TR.parseContent('BT (non fermée Tj'), TR.ParseError);
});

test('suppression : seule l\'instruction entièrement dans la zone, la suite garde sa place', () => {
  const metrics = { glyphs: (s) => [...s].map((ch) => ({ w: 500, space: ch === ' ' })) };
  // « AAAA » de x = 100 à 120 (taille 10, largeur 500 ‰), puis « BB » enchaîné de 120 à 130
  const content = 'BT /F1 10 Tf 100 700 Td (AAAA) Tj (BB) Tj ET';
  const res = TR.removeTextInRects(content, [{ x1: 98, y1: 695, x2: 121, y2: 712 }], () => metrics);
  assert.equal(res.content, 'BT /F1 10 Tf 100 700 Td [-2000] TJ (BB) Tj ET');
  assert.deepEqual(res.removed, [1]);
  // « BB » déborde de la zone : gardé (et signalé)
  const wide = TR.removeTextInRects(content, [{ x1: 98, y1: 695, x2: 125, y2: 712 }], () => metrics);
  assert.deepEqual([wide.removed, wide.kept], [[1], [1]]);
});

test('caviardage : contenu de la page remplacé par son image, annotations retirées', async () => {
  const src = await sample();
  const out = await Edit.rasterizePages(src, [{ index: 0, bytes: tinyPng() }]);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 3);
  const page = doc.getPage(0);
  const annots = page.node.lookup(PDFName.of('Annots'));
  assert.ok(!annots || annots.size() === 0, 'annotations (champs) retirées de la page');
  const [c0, c1] = await contents(out);
  assert.ok(!c0.includes(hexOf('Page 1 : ligne \xe0 modifier')), 'texte de la page supprimé');
  assert.match(c0, / Do\b/);
  assert.ok(c1.includes(hexOf('Page 2 : ligne \xe0 modifier')));
});

test('plan vérifié : pages inexistantes, document vide, valeurs bornées', () => {
  assert.throws(() => Edit.cleanPlan({ pages: [] }, 3), /au moins une page/);
  assert.throws(() => Edit.cleanPlan({ pages: [{ src: 5 }] }, 3), /inexistante/);
  const plan = Edit.cleanPlan({ pages: [{ src: 0, objects: [{ type: 'rect', x: 1e9, y: 0, w: -5, h: 10, stroke: 'red', opacity: 9 }, { type: 'inconnu' }] }] }, 3);
  assert.deepEqual(plan.pages[0].objects, [{ type: 'rect', x: 20000, y: 0, w: 0, h: 10, stroke: null, fill: null, width: 2, opacity: 1 }]);
});

test('caractères hors de la police : police de secours (symboles) quand elle existe', async () => {
  const src = await sample();
  const out = await Edit.editPdf(src, { pages: [{ src: 0, objects: [line('Coché ✓', 40)] }, { src: 1, objects: [] }, { src: 2, objects: [] }] }, {});
  assert.ok(out.length > src.length);
});
