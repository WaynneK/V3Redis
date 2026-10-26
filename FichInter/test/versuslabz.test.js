/*
 * versuslabz.test.js — Modèle livré « Fiche d'intervention VersusLabz » : colonnes titrées, cadres, tableau des
 * pièces, rendez-vous date + heure, signatures des cadres Technicien / Client.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Template = require('../lib/template.js');
const Docx = require('../lib/docx.js');
const F = require('../lib/fields.js');
const { VERSUS, VERSUS_VALUES, signaturePng } = require('./fixtures.js');

const model = fs.readFileSync(VERSUS);
const byKey = (schema) => Object.fromEntries(schema.sections.flatMap((s) => s.fields).map((f) => [f.key, f]));
const textOf = (xml) => xml.replace(/<[^>]+>/g, '').replace(/ /g, ' ');

test('seul le modèle VersusLabz est livré', () => {
  assert.deepEqual(fs.readdirSync(path.join(__dirname, '..', 'modeles')), ['Fiche d\'intervention VersusLabz.docx']);
});

test('VersusLabz : sections du document, colonnes Client | Intervention séparées', async () => {
  const { schema } = await Docx.describe(model);
  assert.equal(schema.title, 'FICHE D\'INTERVENTION');
  assert.deepEqual(
    schema.sections.map((s) => [s.title, s.fields.length]),
    [
      ['Informations générales', 3],
      ['1 CLIENT', 6],
      ['2 INTERVENTION', 8],
      ['3 MATÉRIEL CONCERNÉ', 6],
      ['4 PROBLÈME SIGNALÉ', 4],
      ['5 INTERVENTION RÉALISÉE', 6],
      ['6 OBSERVATIONS ET SUIVI', 3],
      ['7 VALIDATION', 6],
    ]
  );
  assert.equal(schema.fieldCount, 42);
  assert.deepEqual(schema.sections[7].fields.map((f) => f.label), ['Technicien · Nom', 'Technicien · Date', 'Technicien · Signature', 'Client · Nom', 'Client · Date', 'Client · Signature']);
  assert.ok(!/"_[A-Za-z]+":/.test(JSON.stringify(schema)), 'positions internes jamais envoyées à la page');
});

test('VersusLabz : type de chaque case', async () => {
  const f = byKey((await Docx.describe(model)).schema);
  const kinds = {
    't1.r0.c5': 'date',
    't2.r3.c3': 'tel',
    't2.r4.c1': 'textarea', // adresse sur deux lignes pointillées
    't2.r6.c1': 'email',
    't2.r3.c6': 'time',
    't2.r3.c8': 'time', // « Fin » à côté de l'heure d'arrivée
    't4.r2.c0': 'textarea', // cadre « Description de la panne »
    't5.r7.c0': 'table',
    't6.r2.c3': 'blanks',
    't7.r2.c1': 'signature',
  };
  for (const [key, kind] of Object.entries(kinds)) assert.equal(f[key].kind, kind, `${key} (${f[key].label})`);
  assert.equal(f['t2.r4.c1'].rows, 2);
  assert.deepEqual(f['t5.r7.c0'].columns, ['Désignation', 'Référence', 'Qté']);
  assert.equal(f['t5.r7.c0'].rows, 3);
  assert.equal(f['t5.r7.c0'].label, 'Pièces remplacées / fournies');
  assert.deepEqual(f['t6.r2.c3'].blanks, [
    { kind: 'date', label: 'Date' },
    { kind: 'time', label: 'Heure' },
  ]);
  assert.deepEqual(f['t6.r2.c3'].assist.blanks, [{}, {}], 'prochain rendez-vous : pas la date du jour');
  assert.equal(f['t2.r6.c4'].note, 'Ne jamais noter le mot de passe');
  assert.equal(f['t7.r2.c1'].nameless, true, 'le nom a sa propre case');
  assert.deepEqual(f['t1.r0.c1'].assist, { ref: true });
  assert.deepEqual(f['t2.r4.c4'].assist, { duration: true });
  assert.deepEqual(f['t7.r1.c8'].assist, { today: true });
});

test('VersusLabz : options et précisions', async () => {
  const f = byKey((await Docx.describe(model)).schema);
  // Ligne « ☐ Autre : …… » sous la liste des types : même liste, 7 options, plusieurs choix
  assert.equal(f['t5.r0.c1'].options.length, 7);
  assert.equal(f['t5.r0.c1'].multiple, true);
  assert.match(f['t5.r0.c1'].options[6].text, /^Autre : ……+$/);
  assert.deepEqual([f['t5.r0.c1'].options[6].label, f['t5.r0.c1'].options[6].extra], ['Autre', { kind: 'text', label: 'Préciser', mode: 'blank' }]);
  assert.deepEqual(f['t2.r5.c4'].options[1].extra, { kind: 'text', label: 'N°', mode: 'blank' });
  assert.equal(f['t3.r2.c3'].options[1].label, 'Sous garantie');
  assert.deepEqual(f['t3.r2.c3'].options[1].extra, { kind: 'date', label: 'Jusqu\'au', mode: 'blank' });
  assert.deepEqual([f['t4.r0.c1'].options[2].label, f['t4.r0.c1'].options[2].sub], ['Élevé', 'poste ou activité bloqué']);
  assert.equal(f['t5.r10.c1'].options[2].label, 'Non résolu');
});

test('VersusLabz : fiche complète écrite puis relue, une signature par cadre', async () => {
  const sig = signaturePng();
  const values = JSON.parse(JSON.stringify(VERSUS_VALUES));
  values['t7.r2.c1'].image = sig;
  values['t7.r2.c4'].image = sig;
  const { buffer, checks } = await Docx.generate(model, values, { 't7.r2.c1': sig, 't7.r2.c4': sig });
  assert.equal(checks.length, 42);
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.equal(checks.filter((c) => c.filled).length, 42);

  const { xml, zip } = await Docx.open(buffer);
  const text = textOf(xml);
  for (const s of ['INT-20261022-01', '22/10/2026', 'Dupont &amp; Fils &lt;SARL&gt;', '09h05', '10h35', 'Oui – N° MC-2026-118', 'Autre : NAS Synology', 'Sous garantie jusqu\'au 31/03/2027', 'Autre : Remplacement disque', 'Non résolu – préciser : reconstruction en cours', 'Oui : contrôle du RAID', '05/11/2026   à   14h30']) {
    assert.ok(text.includes(s), s);
  }
  // Adresse : une ligne par trait pointillé
  assert.match(xml, /12 avenue de la Gare<\/w:t><\/w:r><\/w:p>/);
  assert.match(xml, /66000 Perpignan<\/w:t><\/w:r><\/w:p>/);
  // Pièces : chaque saisie dans sa case, ligne 2 laissée vide
  const plan = Template.layout(xml).filter((b) => b.type === 'tbl');
  const cell = (r, c) => textOf(xml.slice(plan[5].rows[r].cells[c].start, plan[5].rows[r].cells[c].end));
  assert.deepEqual([cell(7, 0), cell(7, 1), cell(7, 2), cell(8, 0), cell(9, 0), cell(9, 2)], ['Disque dur 4 To WD Red Plus', 'WD40EFZX', '1', '', 'Câble SATA', '2']);
  // Signatures sans nom écrit (les noms ont leur case)
  assert.equal(zip.file(/fichinter-signature/).length, 2);
  // Cases : ☒ pour les choix (12), ☐ pour le reste (32 cases dans le modèle)
  assert.equal((text.match(/☒/g) || []).length, 12);
  assert.equal((text.match(/[☒☐]/g) || []).length, 32);
  // Nom du fichier : la société
  assert.equal(F.fileTitle((await Docx.describe(model)).schema, values), 'Fiche d\'intervention - Dupont & Fils SARL - 22-10-2026');
});

test('VersusLabz : précision en italique gardée, options non choisies inchangées', async () => {
  const { buffer } = await Docx.generate(model, { 't4.r0.c1': { selected: [0] } }, {});
  const { xml } = await Docx.open(buffer);
  assert.match(xml, /<w:b\/><w:bCs\/><w:i\/><w:iCs\/>[^]*?\(gêne légère\)/, 'précision du choix en gras et italique');
  assert.match(xml, /<w:i\/><w:iCs\/><w:color w:val="5B6878"\/><w:sz w:val="15"\/><w:szCs w:val="15"\/><\/w:rPr><w:t xml:space="preserve"> \(travail ralenti\)/);
});

test('VersusLabz : fiche vide, rien n\'est écrit, tout est vérifié', async () => {
  const { buffer, checks } = await Docx.generate(model, {}, {});
  assert.ok(checks.every((c) => c.ok && !c.filled));
  const text = textOf((await Docx.open(buffer)).xml);
  assert.ok(text.includes('___ / ___ / _____   à   ___ h ___'), 'pointillés du rendez-vous gardés');
});

test('nom du fichier : nom du client quand la société est vide', () => {
  const schema = {
    sections: [
      { title: '1 CLIENT', fields: [{ key: 'a', label: 'Nom (M. / Mme)', kind: 'text' }, { key: 'b', label: 'Société / Raison sociale', kind: 'text' }] },
      { title: '7 VALIDATION', fields: [{ key: 'c', label: 'Client · Date', kind: 'date' }, { key: 'd', label: 'Client · Nom', kind: 'text' }] },
    ],
  };
  assert.equal(F.fileTitle(schema, { a: 'M. Jean Dupont', c: '2026-10-22', d: 'J. Dupont' }, new Date(2026, 9, 22)), 'Fiche d\'intervention - Jean Dupont - 22-10-2026');
  assert.equal(F.fileTitle(schema, { d: 'J. Dupont' }, new Date(2026, 9, 22)), 'Fiche d\'intervention - J. Dupont - 22-10-2026');
});

test('pointillés : date et heure en traits bas', () => {
  assert.deepEqual(Template.splitBlanks('___ / ___ / _____   à   ___ h ___'), [
    { blank: 'date', text: '___ / ___ / _____' },
    { text: '   à   ' },
    { blank: 'time', text: '___ h ___' },
  ]);
  assert.equal(Template.parseOption('Oui – N° ………………').label, 'Oui');
  assert.equal(Template.parseOption('Sous garantie jusqu\'au ___ / ___ / _____').extra.label, 'Jusqu\'au');
});
