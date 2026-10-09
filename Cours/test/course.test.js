'use strict';
// Outils de Cours (lib/course.js) et contenu réel (lib/content.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/course.js');
const CONTENT = require('../lib/content.js');

const sample = {
  parts: [
    {
      id: 'm-julia',
      name: 'M.Julia',
      accent: '#38bdf8',
      description: 'IP, Windows Server, Connexion',
      chapters: [
        {
          id: 'ip',
          title: 'IP',
          keyPoints: ['Une adresse **IPv4** compte 32 bits'],
          sections: [
            { title: 'Masques', blocks: [{ p: 'Le masque `255.255.255.0` vaut /24.' }, { table: { head: ['CIDR', 'Masque'], rows: [['/24', '255.255.255.0']] } }] },
          ],
        },
        { id: 'windows-server', title: 'Windows Server' },
        { id: 'connexion', title: 'Connexion' },
      ],
    },
    { id: 'a-julia', name: 'A.Julia', accent: '#a78bfa', description: 'Hardware', chapters: [{ id: 'cpu', title: 'CPU', subtitle: 'Processeur' }] },
  ],
};

test('contenu réel : valide, deux parties M.Julia et A.Julia', () => {
  assert.deepEqual(C.validate(CONTENT), []);
  assert.deepEqual(CONTENT.parts.map((p) => p.name), ['M.Julia', 'A.Julia']);
  assert.equal(CONTENT.parts[0].description, 'IP, Windows Server, Connexion');
  assert.deepEqual(CONTENT.parts[0].chapters.map((c) => c.title), ['IP', 'Windows Server', 'Connexion']);
  assert.match(CONTENT.parts[1].description, /Hardware : carte mère, CPU, GPU/);
  assert.ok(['Carte mère', 'CPU', 'GPU'].every((t) => CONTENT.parts[1].chapters.some((c) => c.title === t)));
});

test('richTokens : gras et code, sans HTML', () => {
  assert.deepEqual(C.richTokens('a **b** `c` <i>'), [
    { type: 'text', text: 'a ' },
    { type: 'b', text: 'b' },
    { type: 'text', text: ' ' },
    { type: 'code', text: 'c' },
    { type: 'text', text: ' <i>' },
  ]);
  assert.equal(C.plain('**IP** et `ipconfig`'), 'IP et ipconfig');
});

test('validate : identifiants, couleurs, blocs inconnus', () => {
  assert.deepEqual(C.validate({ parts: [] }), ['Aucune partie dans le contenu.']);
  const bad = JSON.parse(JSON.stringify(sample));
  bad.parts[1].id = 'm-julia';
  bad.parts[0].accent = 'bleu';
  bad.parts[0].chapters[1].id = 'ip';
  bad.parts[0].chapters[0].sections[0].blocks.push({ video: 'x' }, { list: 'pas une liste' }, { table: {} });
  const errors = C.validate(bad);
  for (const re of [/identifiant « m-julia » en double/, /couleur invalide/, /identifiant « ip » en double/, /type inconnu/, /« list » doit être une liste/, /tableau sans lignes/]) {
    assert.ok(errors.some((e) => re.test(e)), re);
  }
});

test('partStats et isReady : résumés disponibles, chapitres lus', () => {
  const p = sample.parts[0];
  assert.equal(C.isReady(p.chapters[0]), true);
  assert.equal(C.isReady(p.chapters[1]), false);
  assert.deepEqual(C.partStats(p, new Set(['m-julia/ip', 'a-julia/cpu'])), { chapters: 3, ready: 1, read: 1 });
  assert.deepEqual(C.partStats(p, []), { chapters: 3, ready: 1, read: 0 });
});

test('search : accents et majuscules ignorés, tous les mots, titres d\'abord, extrait', () => {
  const r = C.search(sample.parts, 'masque 255');
  assert.equal(r.length, 1);
  assert.equal(r[0].chapterId, 'ip');
  assert.match(r[0].snippet, /255/);
  assert.equal(C.search(sample.parts, 'PROCESSEUR')[0].chapterId, 'cpu');
  assert.equal(C.search(sample.parts, 'connéxion')[0].chapterId, 'connexion');
  // « IP » est dans le titre du chapitre IP et dans la description de la partie : le titre passe devant
  assert.equal(C.search(sample.parts, 'ip')[0].chapterId, 'ip');
  assert.deepEqual(C.search(sample.parts, '   '), []);
  assert.deepEqual(C.search(sample.parts, 'introuvable'), []);
});

test('neighbours : précédent / suivant', () => {
  const p = sample.parts[0];
  assert.deepEqual(C.neighbours(p, 'ip'), { prev: null, next: p.chapters[1], index: 0 });
  assert.deepEqual(C.neighbours(p, 'connexion'), { prev: p.chapters[1], next: null, index: 2 });
});
