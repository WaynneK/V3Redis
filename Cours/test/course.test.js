'use strict';
// Outils de Cours (lib/course.js) et contenu réel (lib/content.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/course.js');
const CONTENT = require('../lib/content.js');

test('contenu réel : valide, parties M.Julia, A.Julia et Microsoft Office', () => {
  assert.deepEqual(C.validate(CONTENT), []);
  assert.deepEqual(CONTENT.parts.map((p) => p.name), ['M.Julia', 'A.Julia', 'Microsoft Office']);
  assert.equal(CONTENT.parts[2].description, 'Word, Excel, PowerPoint, Outlook');
  assert.equal(CONTENT.parts[0].description, 'IP, Windows Server, Connexion');
  assert.match(CONTENT.parts[1].description, /Hardware : carte mère, CPU, GPU/);
});

test('titleFromFile : sans extension ni numéro d\'ordre', () => {
  assert.equal(C.titleFromFile('01 - Adressage IP.pdf'), 'Adressage IP');
  assert.equal(C.titleFromFile('2. Windows_Server.PDF'), 'Windows Server');
  assert.equal(C.titleFromFile('10) CPU et GPU.pdf'), 'CPU et GPU');
  assert.equal(C.titleFromFile('Carte mère.pdf'), 'Carte mère');
  assert.equal(C.titleFromFile('2026.pdf'), '2026'); // rien d'autre qu'un nombre : gardé
});

test('isPdfName : noms de fichiers sûrs uniquement', () => {
  assert.ok(C.isPdfName('Cours 1.pdf'));
  for (const bad of ['a.txt', '../x.pdf', 'dir/x.pdf', 'C:\\x.pdf', 'a?.pdf', '', null]) assert.ok(!C.isPdfName(bad), String(bad));
});

test('mergeDocuments : ordre naturel, informations de content.js, sujet du PDF en repli', () => {
  const part = { id: 'm-julia', documents: [{ file: '02 - DNS.pdf', title: 'Le DNS', description: 'Noms et résolution.' }] };
  const docs = C.mergeDocuments(part, [
    { file: '10 - VPN.pdf', size: 2048, mtime: 3 },
    { file: '02 - DNS.pdf', size: 1024, mtime: 2 },
    { file: '01 - IP.pdf', size: 512, mtime: 1, pdfSubject: 'Adressage IPv4' },
    { file: 'notes.txt', size: 1, mtime: 1 },
  ]);
  assert.deepEqual(docs.map((d) => d.file), ['01 - IP.pdf', '02 - DNS.pdf', '10 - VPN.pdf']);
  assert.deepEqual(docs.map((d) => d.title), ['IP', 'Le DNS', 'VPN']);
  assert.equal(docs[0].description, 'Adressage IPv4');
  assert.equal(docs[1].description, 'Noms et résolution.');
  assert.equal(docs[2].description, '');
  assert.equal(docs[1].partId, 'm-julia');
});

test('validate : identifiants, couleurs, fichiers des documents', () => {
  assert.deepEqual(C.validate({ parts: [] }), ['Aucune partie dans le contenu.']);
  const errors = C.validate({
    parts: [
      { id: 'a', name: 'A', accent: 'bleu', documents: [{ file: '../x.pdf' }, { file: 'b.pdf' }, { file: 'B.pdf' }] },
      { id: 'a', name: 'B', accent: '#ffffff', documents: 'non', logo: 'apple' },
    ],
  });
  for (const re of [/logo inconnu/,/couleur invalide/, /nom de fichier \.pdf/, /« B\.pdf » en double/, /identifiant « a » en double/, /« documents » doit être une liste/]) {
    assert.ok(errors.some((e) => re.test(e)), re);
  }
});

test('search : titres et descriptions, accents ignorés, titres d\'abord', () => {
  const parts = [
    { id: 'm', name: 'M.Julia', description: 'IP', documents: [
      { partId: 'm', file: '1.pdf', title: 'Adressage IP', description: 'Masques et sous-réseaux' },
      { partId: 'm', file: '2.pdf', title: 'DHCP', description: 'Attribution des adresses IP' },
    ] },
    { id: 'a', name: 'A.Julia', description: 'Hardware', documents: [{ partId: 'a', file: '3.pdf', title: 'Carte mère', description: 'Chipset, sockets' }] },
  ];
  assert.deepEqual(C.search(parts, 'adresse').map((d) => d.file), ['2.pdf']);
  assert.deepEqual(C.search(parts, 'adressage').map((d) => d.file), ['1.pdf']);
  assert.equal(C.search(parts, 'CARTE MERE')[0].title, 'Carte mère');
  assert.equal(C.search(parts, 'carte mere')[0].partName, 'A.Julia');
  assert.deepEqual(C.search(parts, '  '), []);
});

test('mergeDocuments : auteur donné dans content.js', () => {
  const part = { id: 'a', documents: [{ file: 'x.pdf', author: ' Julia ' }] };
  const docs = C.mergeDocuments(part, [{ file: 'x.pdf', size: 1, mtime: 1 }, { file: 'y.pdf', size: 1, mtime: 1 }]);
  assert.deepEqual(docs.map((d) => d.author), ['Julia', '']);
});

test('pdfDate : dates enregistrées dans les PDF', () => {
  assert.equal(C.pdfDate("D:20261010150248+00'00'"), Date.UTC(2026, 9, 10, 15, 2, 48));
  assert.equal(C.pdfDate("D:20261010170248+02'00'"), Date.UTC(2026, 9, 10, 15, 2, 48));
  assert.equal(C.pdfDate('D:20261010150248Z'), Date.UTC(2026, 9, 10, 15, 2, 48));
  assert.equal(C.pdfDate('D:2026'), Date.UTC(2026, 0, 1));
  assert.equal(C.pdfDate(''), null);
  assert.equal(C.pdfDate('hier'), null);
});

test('splitCode : codes de section en tête des titres', () => {
  assert.deepEqual(C.splitCode('A1Les définitions de base'), { code: 'A1', title: 'Les définitions de base' });
  assert.deepEqual(C.splitCode('B12 - Synthèse'), { code: 'B12', title: 'Synthèse' });
  assert.deepEqual(C.splitCode('2.3 Le DNS'), { code: '2.3', title: 'Le DNS' });
  assert.deepEqual(C.splitCode('2. Introduction'), { code: '2', title: 'Introduction' });
  assert.deepEqual(C.splitCode('3 types de clients'), { code: '', title: '3 types de clients' });
  assert.deepEqual(C.splitCode('  Glossaire  '), { code: '', title: 'Glossaire' });
});

test('sections : signets → sommaire (page de garde retirée, lettre des parties)', () => {
  const toc = C.sections([
    { title: 'Logiciels, client-serveur', page: 1 },
    { title: 'Applications & logiciels', page: 2, items: [{ title: 'A1Les définitions', page: 2 }, { title: 'A2Typologie', page: 3 }] },
    { title: 'Client-serveur', page: 6, items: [{ title: 'B1Le principe', page: 6 }] },
    { title: 'Glossaire', page: 13 },
    { title: '   ', page: 4 },
  ]);
  assert.deepEqual(toc.map((s) => `${s.code}|${s.title}|${s.page}`), ['A|Applications & logiciels|2', 'B|Client-serveur|6', '|Glossaire|13']);
  assert.deepEqual(toc[0].items, [{ code: 'A1', title: 'Les définitions', page: 2, items: [] }, { code: 'A2', title: 'Typologie', page: 3, items: [] }]);
  // Signets à plat : rien n'est retiré, page inconnue = null
  assert.deepEqual(C.sections([{ title: 'Intro', page: 1 }, { title: 'Suite', page: 'x' }]).map((s) => s.page), [1, null]);
  assert.deepEqual(C.sections(null), []);
});

test('changelog : première entrée = version de l\'application, entrées complètes', () => {
  const LOG = require('../lib/changelog.js');
  const pkg = require('../package.json');
  assert.equal(LOG[0].version, pkg.version, 'ajouter les nouveautés de cette version en tête de lib/changelog.js');
  for (const e of LOG) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.title && e.changes.length && e.changes.every((c) => typeof c === 'string' && c.trim()), e.version);
  }
  assert.equal(new Set(LOG.map((e) => e.version)).size, LOG.length, 'versions en double');
});

test('formatSize', () => {
  assert.equal(C.formatSize(1258291), '1,2 Mo');
  assert.equal(C.formatSize(348160), '340 Ko');
  assert.equal(C.formatSize(10), '1 Ko');
});
