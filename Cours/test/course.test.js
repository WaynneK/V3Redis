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

test('titleFromFile : noms en majuscules remis en minuscules, sigles courts gardés, photos', () => {
  assert.equal(C.titleFromFile('NOTIONS DE BASE EN ELECTRICITE.pdf'), 'Notions de base en electricite');
  assert.equal(C.titleFromFile('DNS.pdf'), 'DNS');
  assert.equal(C.titleFromFile('double-alimentation-700-watts.JPG'), 'double-alimentation-700-watts');
});

test('isSafeRel : chemins sûrs dans le dossier d\'une partie', () => {
  for (const ok of ['a.pdf', 'Cours/a.pdf', 'Cours/photo.PNG', 'Cours/Condensé/a.pdf']) assert.ok(C.isSafeRel(ok), ok);
  for (const bad of ['../a.pdf', 'Cours/../a.pdf', 'a/b/c/d.pdf', 'Cours/a.txt', 'C:/a.pdf', 'Cours\\a.pdf', '', null, 'Cours/']) assert.ok(!C.isSafeRel(bad), String(bad));
  assert.ok(C.isCondenseFolder('Condensé') && C.isCondenseFolder('Condensée') && C.isCondenseFolder('condenses') && !C.isCondenseFolder('Cours'));
  assert.deepEqual(C.splitAuthor('Architecture_et_Electricite - Mohssine.pdf'), { title: 'Architecture et Electricite', author: 'Mohssine' });
  assert.deepEqual(C.splitAuthor('ALIMENTATION.pdf'), { title: 'Alimentation', author: '' });
});

test('mergeDocuments : cours en dossier (fichiers, photos, condensé, date) et PDF seuls', () => {
  const part = {
    id: 'a-julia',
    documents: [{ folder: 'Alimentation', date: '2026-10-05', description: 'Électricité.', files: { 'ALIM.pdf': 'Alimentation à découpage', 'Fiche - Mohssine.pdf': 'Fiche de révision' } }],
  };
  const docs = C.mergeDocuments(part, {
    files: [{ file: '01 - Seul.pdf', size: 10, mtime: 5 }],
    folders: [
      {
        folder: 'Alimentation',
        files: [
          { file: 'Alimentation/photo.JPG', size: 3, mtime: 1 },
          { file: 'Alimentation/ALIM.pdf', size: 4, mtime: 2 },
          { file: 'Alimentation/b cours.pdf', size: 5, mtime: 9 },
        ],
        condense: [{ file: 'Alimentation/Condensé/Fiche - Mohssine.pdf', size: 6, mtime: 3 }],
      },
      { folder: 'Vide', files: [], condense: [] },
    ],
  });
  // Cours datés d'abord, dossier vide ignoré
  assert.deepEqual(docs.map((d) => `${d.kind}:${d.file}`), ['folder:Alimentation', 'pdf:01 - Seul.pdf']);
  const f = docs[0];
  assert.equal(f.title, 'Alimentation');
  assert.equal(f.description, 'Électricité.');
  assert.equal(f.date, new Date('2026-10-05T12:00:00').getTime());
  assert.deepEqual(f.files.map((x) => `${x.kind}:${x.title}`), ['pdf:Alimentation à découpage', 'pdf:b cours', 'image:photo']);
  assert.deepEqual([f.condense.title, f.condense.author, f.condense.file, f.condense.condense], ['Fiche de révision', 'Mohssine', 'Alimentation/Condensé/Fiche - Mohssine.pdf', true]);
  assert.equal(f.size, 18);
  assert.equal(f.mtime, 9);
  assert.equal(C.coverOf(f), f.condense);
  assert.equal(C.coverOf(docs[1]), docs[1]);
  assert.equal(C.coverOf({ kind: 'folder', files: [{ kind: 'image' }, { kind: 'pdf', file: 'x' }], condense: null }).file, 'x');
  // Ancien format (liste de PDF) toujours accepté
  assert.deepEqual(C.mergeDocuments({ id: 'm' }, [{ file: 'a.pdf', size: 1, mtime: 1 }]).map((d) => d.kind), ['pdf']);
  // Recherche dans les fichiers et le condensé d'un cours en dossier
  assert.deepEqual(C.search([{ id: 'a-julia', name: 'A.Julia', documents: docs }], 'mohssine').map((d) => d.file), ['Alimentation']);
});

test('mergeDocuments : cours annoncés dans content.js, sans fichier (« à venir »)', () => {
  const part = { id: 'a', documents: [{ folder: 'BIOS', icon: 'bios' }, { folder: 'CPU', icon: 'cpu', date: '2026-10-12' }, { folder: 'Codage', icon: 'inconnue' }] };
  const docs = C.mergeDocuments(part, { files: [], folders: [{ folder: 'BIOS', files: [], condense: [] }, { folder: 'Autre', files: [], condense: [] }] });
  // BIOS : dossier vide mais déclaré ; CPU : déclaré sans dossier ; Autre : dossier vide non déclaré → ignoré
  assert.deepEqual(docs.map((d) => `${d.file}:${d.empty}:${d.icon}`), ['CPU:true:cpu', 'BIOS:true:bios', 'Codage:true:']);
  assert.equal(C.coverOf(docs[0]), null);
  assert.ok(C.validate({ parts: [{ id: 'a', name: 'A', accent: '#ffffff', documents: [{ folder: 'X', icon: 'inconnue' }] }] }).some((e) => /icône inconnue/.test(e)));
});

test('fichiers d\'un cours : vidéos et documents Office, ordre PDF → Office → photos → vidéos', () => {
  assert.deepEqual(['a.mp4', 'b.webm', 'c.docx', 'd.XLSX', 'e.pptx', 'f.pdf', 'g.png', 'h.exe', 'i.mov'].map(C.kindOf), ['video', 'video', 'office', 'office', 'office', 'pdf', 'image', '', '']);
  assert.deepEqual(['a.docx', 'b.xlsx', 'c.pptx', 'd.odt', 'e.pdf'].map(C.officeApp), ['word', 'excel', 'powerpoint', 'word', '']);
  assert.ok(C.isSafeRel('CPU/film.mp4') && C.isSafeRel('Chipset/doc.docx') && !C.isSafeRel('CPU/setup.exe'));
  assert.equal(C.titleFromFile('chipset et generation.docx'), 'chipset et generation');
  const [d] = C.mergeDocuments({ id: 'a', documents: [{ folder: 'CPU' }] }, {
    folders: [{ folder: 'CPU', files: ['CPU/z.mp4', 'CPU/a.png', 'CPU/b.xlsx', 'CPU/c.pdf'].map((file) => ({ file, size: 1, mtime: 1 })), condense: [] }],
  });
  assert.deepEqual(d.files.map((f) => f.kind), ['pdf', 'office', 'image', 'video']);
  // Cours sans PDF (un document Word seul) : pas de couverture PDF
  const [w] = C.mergeDocuments({ id: 'a', documents: [{ folder: 'Chipset' }] }, { folders: [{ folder: 'Chipset', files: [{ file: 'Chipset/x.docx', size: 1, mtime: 1 }], condense: [] }] });
  assert.equal(C.coverOf(w), null);
  assert.equal(w.empty, false);
});

test('validate : cours en dossier', () => {
  const errors = C.validate({ parts: [{ id: 'a', name: 'A', accent: '#ffffff', documents: [{ folder: '../x' }, { folder: 'Ok', date: '5 octobre' }, { folder: 'Ok' }, { folder: 'Z', files: ['a'] }] }] });
  for (const re of [/« folder » doit être un nom de dossier/, /« date » doit être de la forme/, /« Ok » en double/, /« files » doit associer/]) assert.ok(errors.some((e) => re.test(e)), re);
});

test('formatSize', () => {
  assert.equal(C.formatSize(1258291), '1,2 Mo');
  assert.equal(C.formatSize(348160), '340 Ko');
  assert.equal(C.formatSize(10), '1 Ko');
});
