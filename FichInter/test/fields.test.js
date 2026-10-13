/*
 * fields.test.js — Règles des champs : type d'après l'intitulé, dates, durées, aides, nom du fichier.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/fields.js');

test('type d\'un champ d\'après son intitulé', () => {
  const cases = [
    ['Mail', 'email'],
    ['Adresse e-mail', 'email'],
    ['Numéro Tel', 'tel'],
    ['Téléphone portable', 'tel'],
    ['Date de l’intervention', 'date'],
    ['Date / heure d’apparition de la panne', 'datetime'],
    ['Heure arrivée', 'time'],
    ['Heure de fin', 'time'],
    ['Diagnostic établi', 'textarea'],
    ['Nom et signature du technicien', 'signature'],
    ['Adresse Entreprise', 'text'],
    ['N° de série', 'text'],
  ];
  for (const [label, kind] of cases) assert.equal(F.guessKind(label), kind, label);
  // Pièges : mots qui ressemblent à une date, une heure ou un téléphone
  for (const label of ['Besoin du suivi', 'Nombre d\'heures', 'Heures facturées', 'Ordinateur portable', 'Hôtel']) assert.equal(F.guessKind(label), 'text', label);
  assert.equal(F.guessKind('N° de portable'), 'tel');
  assert.equal(F.guessKind('Remarques', 0), 'textarea');
  assert.equal(F.guessKind('Marque', 1200), 'textarea', 'ligne haute dans le modèle');
});

test('dates et heures écrites à la française', () => {
  assert.equal(F.frDate('2026-10-13'), '13/10/2026');
  assert.equal(F.frTime('9:05'), '09h05');
  assert.equal(F.frDateTime('2026-10-12T17:40'), '12/10/2026 à 17h40');
  assert.equal(F.formatValue('text', '  a \r\nb  \n\n'), '  a\nb');
  assert.equal(F.formatValue('date', ''), '');
  assert.equal(F.formatValue('text', 42), '');
});

test('durée entre deux heures', () => {
  assert.equal(F.duration('09:05', '10:35'), '1h30');
  assert.equal(F.duration('09:00', '10:00'), '1h');
  assert.equal(F.duration('09:00', '09:45'), '45 min');
  assert.equal(F.duration('23:30', '00:15'), '45 min');
  assert.equal(F.duration('', '10:00'), '');
});

test('champ rempli et résumé lisible', () => {
  const choice = { kind: 'choice', options: [{ label: 'Oui', extra: { kind: 'text' } }, { label: 'Non', extra: null }] };
  assert.equal(F.isFilled(choice, { selected: [] }), false);
  assert.equal(F.display(choice, { selected: [0], extra: { 0: 'MC-1' } }), 'Oui : MC-1');
  assert.equal(F.display({ kind: 'check', options: [{ label: 'Lue' }] }, true), 'Lue');
  assert.equal(F.display({ kind: 'blanks', blanks: [{ kind: 'text' }, { kind: 'date' }] }, ['Perpignan', '2026-10-13']), 'Perpignan · 13/10/2026');
  assert.equal(F.display({ kind: 'signature' }, { name: 'Paul', image: 'data:x' }), 'Paul · signature manuscrite');
  assert.equal(F.isFilled({ kind: 'text' }, '   '), false);
});

test('aides : date du jour, mémoire, référence, durée', () => {
  assert.deepEqual(F.assistOf({ kind: 'date', label: 'Date de l’intervention' }), { today: true });
  assert.deepEqual(F.assistOf({ kind: 'text', label: 'Technicien intervenant' }), { remember: true });
  assert.deepEqual(F.assistOf({ kind: 'text', label: 'Ref du dossier' }), { ref: true });
  assert.deepEqual(F.assistOf({ kind: 'text', label: 'Ref Fabriquant' }), {});
  assert.deepEqual(F.assistOf({ kind: 'text', label: 'Temps / Tarif' }), { duration: true });
  assert.equal(F.makeRef(new Date(2026, 9, 3), 7), 'INT-20261003-07');
});

test('nom du fichier généré', () => {
  const schema = { sections: [{ fields: [{ key: 'a', label: 'Client', kind: 'text' }, { key: 'b', label: 'Date de l’intervention', kind: 'date' }] }] };
  assert.equal(F.fileTitle(schema, { a: 'Mme Martin', b: '2026-10-13' }), 'Fiche d\'intervention - Martin - 13-10-2026');
  assert.equal(F.fileTitle(schema, { a: 'A/B: "C"?' , b: '2026-10-13' }), 'Fiche d\'intervention - A B C - 13-10-2026');
  assert.equal(F.fileTitle(schema, {}, new Date(2026, 0, 2)), 'Fiche d\'intervention - 02-01-2026');
  assert.equal(F.safeFileName('CON'), '_CON');
  assert.equal(F.safeFileName('fin. . '), 'fin');
});
