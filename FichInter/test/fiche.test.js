/*
 * fiche.test.js — Analyse du modèle livré, remplissage, relecture et vérification des fiches.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const JSZip = require('jszip');
const Template = require('../lib/template.js');
const Docx = require('../lib/docx.js');
const { MODEL, VALUES, signaturePng } = require('./fixtures.js');

const model = fs.readFileSync(MODEL);
const byKey = (schema) => Object.fromEntries(schema.sections.flatMap((s) => s.fields).map((f) => [f.key, f]));

test('modèle livré : 6 sections, 52 champs, titres repris du document', async () => {
  const { schema } = await Docx.describe(model);
  assert.equal(schema.title, 'FICHE INTERVENTION');
  assert.deepEqual(
    schema.sections.map((s) => [s.title, s.fields.length]),
    [
      ['1. Identité', 12],
      ['2. Identification du problème', 11],
      ['3. Détail de l’intervention', 11],
      ['4. Information sur le matériel', 9],
      ['5. Notation pendant l’intervention (suivi)', 4],
      ['6. Validation de l’intervention', 5],
    ]
  );
  assert.equal(schema.fieldCount, 52);
});

test('modèle livré : type de chaque case déduit du document', async () => {
  const f = byKey((await Docx.describe(model)).schema);
  const kinds = {
    't0.r0.c1': 'text',
    't0.r2.c1': 'email',
    't0.r3.c1': 'tel',
    't0.r8.c1': 'date',
    't0.r10.c1': 'choice',
    't1.r0.c1': 'time',
    't1.r2.c1': 'textarea',
    't1.r3.c1': 'datetime',
    't2.r4.c1': 'check',
    't5.r2.c1': 'blanks',
    't5.r3.c1': 'signature',
    't5.r4.c1': 'signature',
  };
  for (const [key, kind] of Object.entries(kinds)) assert.equal(f[key].kind, kind, `${key} (${f[key].label})`);
  assert.equal(f['t0.r0.c1'].prefix, 'Mr. / Mme :');
  assert.equal(f['t2.r0.c1'].multiple, true, 'type d\'intervention : plusieurs choix');
  assert.equal(f['t0.r10.c1'].multiple, false);
  assert.match(f['t2.r4.c1'].note, /^Le technicien s’engage/);
  assert.deepEqual(f['t5.r2.c1'].blanks, [
    { kind: 'text', label: 'Lieu' },
    { kind: 'date', label: 'Date' },
  ]);
  // Positions internes jamais envoyées à la page
  assert.ok(!JSON.stringify(f).includes('"_'));
});

test('options : libellé court, précision demandée (« : » ou pointillés)', async () => {
  const f = byKey((await Docx.describe(model)).schema);
  assert.deepEqual(f['t0.r11.c1'].options[0], { text: 'Oui – N° de contrat :', label: 'Oui', sub: '', extra: { kind: 'text', label: 'N° de contrat', mode: 'append' } });
  assert.deepEqual(f['t2.r0.c1'].options[7].extra, { kind: 'text', label: 'Préciser', mode: 'append' });
  assert.deepEqual(f['t3.r7.c1'].options[0].extra, { kind: 'date', label: 'Jusqu’au', mode: 'blank' });
  assert.equal(f['t3.r7.c1'].options[0].label, 'Sous garantie');
  assert.deepEqual([f['t1.r4.c1'].options[0].label, f['t1.r4.c1'].options[0].sub], ['Faible', 'gêne légère']);
});

test('parseOption et splitBlanks', () => {
  assert.deepEqual(Template.parseOption('Si oui, préciser :').extra, { kind: 'text', label: 'Préciser', mode: 'append' });
  assert.equal(Template.parseOption('Si oui, préciser :').label, 'Si oui');
  assert.equal(Template.parseOption('Non résolu (préciser) :').label, 'Non résolu');
  assert.equal(Template.parseOption('Permanente').extra, null);
  assert.deepEqual(Template.splitBlanks('…………………, le ……/……/…………'), [
    { blank: 'text', text: '…………………' },
    { text: ', le ' },
    { blank: 'date', text: '……/……/…………' },
  ]);
  // Un « … » isolé (fin de phrase) n'est pas un blanc
  assert.equal(Template.splitBlanks('coupure de courant…)').length, 1);
});

test('fiche complète : chaque saisie est écrite puis relue dans le fichier', async () => {
  const sig = signaturePng();
  const values = JSON.parse(JSON.stringify(VALUES));
  values['t5.r3.c1'].image = sig;
  const { buffer, checks } = await Docx.generate(model, values, { 't5.r3.c1': sig });
  assert.equal(checks.length, 52);
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.equal(checks.filter((c) => c.filled).length, 51); // « Logiciels installés » laissé vide

  const { xml } = await Docx.open(buffer);
  const text = xml.replace(/<[^>]+>/g, '');
  for (const s of ['Mr. / Mme : Jean Dupont', '13/10/2026', '09h05', '12/10/2026 à 17h40', 'Oui – N° de contrat : MC-2026-118', 'Sous garantie (jusqu’au : 31/03/2027 )', 'Perpignan, le 13/10/2026', 'Autre (Préciser) : Alimentation']) {
    assert.ok(text.replace(/ /g, ' ').includes(s), s);
  }
  // Cases : ☒ pour les choix (15 cases cochées), ☐ pour le reste (44 cases dans le modèle)
  assert.equal((text.match(/☒/g) || []).length, 15);
  assert.equal((text.match(/[☒☐]/g) || []).length, 44);
  assert.ok(!/<w:t>o<\/w:t>/.test(xml), 'plus de « o » du modèle');
  // Texte échappé (« & », « < ») et retours à la ligne
  assert.ok(xml.includes('Dupont &amp; Fils &lt;SARL&gt;'));
  assert.ok(/Écran noir au démarrage\.<\/w:t><w:br\/><w:t xml:space="preserve">Le ventilateur/.test(xml));
});

test('signature : image PNG, relation et type de contenu ajoutés', async () => {
  const sig = signaturePng();
  const { buffer } = await Docx.generate(model, { 't5.r4.c1': { name: 'Jean Dupont', image: sig } }, { 't5.r4.c1': sig });
  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('word/media/fichinter-signature-1.png'));
  assert.match(await zip.file('word/_rels/document.xml.rels').async('string'), /Id="rIdFichInter1"[^>]*Target="media\/fichinter-signature-1\.png"/);
  assert.match(await zip.file('[Content_Types].xml').async('string'), /Extension="png"/);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<a:blip r:embed="rIdFichInter1"\/>/);
  // 3,6 × 0,9 cm au plus
  const [, cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml.slice(xml.indexOf('rIdFichInter1') - 1500));
  assert.ok(Number(cx) <= 3.6 * 360000 && Number(cy) <= 0.9 * 360000);
});

test('signature invalide (pas un PNG) : ignorée, le nom reste écrit', async () => {
  const { buffer, checks } = await Docx.generate(model, { 't5.r3.c1': { name: 'Waynne', image: 'data:image/png;base64,AAAA' } }, { 't5.r3.c1': 'data:image/png;base64,AAAA' });
  const zip = await JSZip.loadAsync(buffer);
  assert.equal(zip.file(/fichinter-signature/).length, 0);
  assert.ok(checks.find((c) => c.key === 't5.r3.c1').ok);
});

test('fiche vide : rien n\'est écrit, tout est vérifié', async () => {
  const { buffer, checks } = await Docx.generate(model, {}, {});
  assert.ok(checks.every((c) => c.ok && !c.filled));
  const { xml } = await Docx.open(buffer);
  assert.ok(xml.includes('……/……/…………'), 'pointillés gardés');
});

test('relecture : une fiche modifiée après coup est signalée', async () => {
  const { buffer } = await Docx.generate(model, VALUES, {});
  assert.ok((await Docx.check(model, buffer, VALUES)).every((c) => c.ok));
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file('word/document.xml').async('string')).replace('C-0042', 'C-9999');
  zip.file('word/document.xml', xml);
  const changed = await zip.generateAsync({ type: 'nodebuffer' });
  const bad = (await Docx.check(model, changed, VALUES)).filter((c) => !c.ok);
  assert.deepEqual(bad.map((c) => c.key), ['t0.r6.c1']);
});

test('dernier paragraphe vide réduit (pas de page blanche en plus)', async () => {
  const { buffer } = await Docx.generate(model, VALUES, {});
  const { xml } = await Docx.open(buffer);
  assert.match(xml, /<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"\/><w:rPr><w:sz w:val="2"\/><w:szCs w:val="2"\/><\/w:rPr><\/w:pPr><\/w:p><w:sectPr/);
});

test('choix unique : une seule case cochée même si plusieurs sont envoyées', async () => {
  const { buffer, checks } = await Docx.generate(model, { 't1.r5.c1': { selected: [0, 2] } }, {});
  assert.ok(checks.every((c) => c.ok));
  const { xml } = await Docx.open(buffer);
  const plan = Template.layout(xml).filter((b) => b.type === 'tbl');
  const cell = plan[1].rows[5].cells[1];
  const marks = cell.paragraphs.flatMap((p) => Template.tokens(xml, p)).filter((t) => t.type === 'mark');
  assert.deepEqual(marks.map((m) => m.checked), [true, false, false]);
});

test('fichiers refusés : pas un .docx, archive endommagée', async () => {
  await assert.rejects(Docx.open(Buffer.from('bonjour')), /pas un document Word/);
  await assert.rejects(Docx.open(Buffer.from('PK\u0003\u0004 abîmé')), /illisible/);
  const zip = new JSZip();
  zip.file('a.txt', 'x');
  await assert.rejects(Docx.open(await zip.generateAsync({ type: 'nodebuffer' })), /pas un document Word/);
});

test('modèle sans tableau : aucun champ', async () => {
  const xml = '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Bonjour</w:t></w:r></w:p><w:sectPr/></w:body></w:document>';
  const schema = Template.analyze(xml);
  assert.equal(schema.fieldCount, 0);
});

test('modèles importés : suivi des modifications, <w:rPr/>, tabulation, amorce dans un 2e paragraphe', () => {
  const rPr = '<w:rPr><w:sz w:val="16"/><w:rPrChange w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z"><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrChange></w:rPr>';
  const cell = (inner) => `<w:tc>${inner}</w:tc>`;
  const p = (inner) => `<w:p>${inner}</w:p>`;
  const r = (t, props = '') => `<w:r>${props}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const xml =
    '<w:document><w:body>' + p(r('Titre')) + '<w:tbl>' +
    `<w:tr><w:tblPrEx><w:tblBorders/></w:tblPrEx><w:trPr><w:trHeight w:val="1500"/></w:trPr>${cell(p(r('Nom')))}${cell(p(r('Mr : ', rPr)))}</w:tr>` +
    `<w:tr>${cell(p(r('Choix')))}${cell(p(r('☐ Oui ☐ Non', '<w:rPr/>')))}</w:tr>` +
    `<w:tr>${cell(p(r('Note')))}${cell('<w:p/>' + p(r('Remarque :')))}</w:tr>` +
    '</w:tbl><w:p/></w:body></w:document>';
  const schema = Template.analyze(xml);
  assert.equal(schema.sections[0].fields[0].kind, 'textarea', 'hauteur de ligne lue après w:tblPrEx');
  const v = { 't0.r0.c1': 'Paul', 't0.r1.c1': { selected: [1] }, 't0.r2.c1': 'a\tb' };
  const out = Template.fill(xml, v);
  const count = (re) => (out.match(re) || []).length;
  assert.equal(count(/<w:rPr>/g), count(/<\/w:rPr>/g), 'XML équilibré');
  assert.equal(count(/<w:rPrChange/g), 1, 'suivi des modifications non recopié dans la saisie');
  assert.match(out, /<w:b\/><w:bCs\/>/, 'choix en gras');
  assert.match(out, /a<\/w:t><w:tab\/><w:t xml:space="preserve">b/);
  assert.match(out.replace(/<[^>]+>/g, ''), /Remarque : a\s*b$/, 'saisie après l\'amorce');
  assert.ok(Template.verify(xml, out, v).every((c) => c.ok));
});

test('tableau à cases à cocher Unicode (☐) et lignes à 4 cellules', () => {
  const cell = (inner) => `<w:tc><w:p>${inner}</w:p></w:tc>`;
  const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const xml =
    '<w:document><w:body><w:p>' + run('Réparation') + '</w:p><w:tbl>' +
    `<w:tr>${cell(run('Nom'))}${cell('')}${cell(run('Date'))}${cell('')}</w:tr>` +
    `<w:tr>${cell(run('Garantie'))}${cell(run('☐ Oui ☐ Non'))}</w:tr>` +
    '</w:tbl><w:p/><w:sectPr/></w:body></w:document>';
  const schema = Template.analyze(xml);
  assert.equal(schema.sections[0].title, 'Réparation');
  assert.deepEqual(schema.sections[0].fields.map((f) => [f.key, f.label, f.kind]), [
    ['t0.r0.c1', 'Nom', 'text'],
    ['t0.r0.c3', 'Date', 'date'],
    ['t0.r1.c1', 'Garantie', 'choice'],
  ]);
  const out = Template.fill(xml, { 't0.r0.c1': 'Paul', 't0.r0.c3': '2026-01-02', 't0.r1.c1': { selected: [1] } });
  assert.ok(Template.verify(xml, out, { 't0.r0.c1': 'Paul', 't0.r0.c3': '2026-01-02', 't0.r1.c1': { selected: [1] } }).every((c) => c.ok));
  assert.match(out.replace(/<[^>]+>/g, ''), /Paul.*02\/01\/2026.*☐ Oui.*☒ Non/);
});
