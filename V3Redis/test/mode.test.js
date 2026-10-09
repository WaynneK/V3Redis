'use strict';
// Choix du mode V3Redis / V3Redis Light (mode.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const Mode = require('../mode.js');

const GB = 1024 ** 3;
const strong = { totalMem: 16 * GB, cpus: 8 };

test('resolveMode : argument, puis choix enregistré, puis détection du matériel', () => {
  assert.deepEqual(Mode.resolveMode({ ...strong, argv: ['V3Redis.exe', '--light'], saved: 'full' }), { mode: 'light', auto: false });
  assert.deepEqual(Mode.resolveMode({ totalMem: 2 * GB, cpus: 2, argv: ['--full'] }), { mode: 'full', auto: false });
  assert.deepEqual(Mode.resolveMode({ totalMem: 2 * GB, cpus: 2, saved: 'full' }), { mode: 'full', auto: false });
  assert.deepEqual(Mode.resolveMode({ ...strong, saved: 'light' }), { mode: 'light', auto: false });
  assert.deepEqual(Mode.resolveMode({ ...strong, saved: 'bizarre' }), { mode: 'full', auto: false });
});

test('resolveMode : PC peu puissant (4 Go ou 2 cœurs) → Light d\'office', () => {
  assert.deepEqual(Mode.resolveMode({ totalMem: 3.9 * GB, cpus: 8 }), { mode: 'light', auto: true });
  assert.deepEqual(Mode.resolveMode({ totalMem: 16 * GB, cpus: 2 }), { mode: 'light', auto: true });
  assert.deepEqual(Mode.resolveMode({ totalMem: 8 * GB, cpus: 4 }), { mode: 'full', auto: false });
  assert.deepEqual(Mode.resolveMode({}), { mode: 'full', auto: false }); // matériel inconnu : complet
});

test('windowOptions : Light = fenêtre classique avec cadre, complet = sans cadre', () => {
  const light = Mode.windowOptions('light');
  const full = Mode.windowOptions('full');
  assert.equal(light.frame, true);
  assert.equal(light.maximizable, true);
  assert.equal(light.title, 'V3Redis Light');
  assert.equal(full.frame, false);
  assert.ok(light.minWidth < full.minWidth && light.width < full.width);
});