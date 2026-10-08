'use strict';

// Ajout d'un membre connu par son identifiant : la recherche dsquery est faite par lib/runner.js, puis dsmod
// reçoit le DN trouvé directement (pas de « for /f » : DN accentués intacts même sans console).
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/agdlp.js');
const R = require('../lib/runner.js');

const project = () =>
  A.normalizeProject({
    domain: { dns: 'lab.local', netbios: 'LAB' },
    globals: [{ id: 'g1', name: 'GG_Spé', ou: '', description: '', members: 'p.élodie, absent' }],
  });

test('plan : la recherche du membre est fournie (member.query) et addMemberCommand construit dsmod', () => {
  const m = A.plan(project()).filter((s) => s.kind === 'member');
  assert.equal(m[0].member.query, 'dsquery user -samid p.élodie -limit 1');
  assert.equal(A.lookupQuery('group', 'GG X'), 'dsquery group -samid "GG X" -limit 1');
  assert.equal(A.addMemberCommand('CN=G,DC=a', 'CN=Élodie (RH),DC=a'), 'dsmod group "CN=G,DC=a" -addmbr "CN=Élodie (RH),DC=a"');
});

test('firstDn : guillemets retirés, lignes vides et messages ignorés', () => {
  assert.equal(R.firstDn('\r\n"CN=Élodie,CN=Users,DC=lab,DC=local"\r\n'), 'CN=Élodie,CN=Users,DC=lab,DC=local');
  assert.equal(R.firstDn('dsquery failed: rien\r\n'), '');
  assert.equal(R.firstDn(''), '');
});

test('runSteps : recherche puis dsmod avec le DN trouvé ; introuvable → erreur sans dsmod', async () => {
  const lines = [];
  const run = async (line) => {
    lines.push(line);
    if (/\| findstr "="$/.test(line)) return { exitCode: 1, stdout: '', output: '' }; // tests d'existence : absent
    if (/^dsquery user -samid p\.élodie/.test(line)) return { exitCode: 0, stdout: '"CN=Élodie Petit,CN=Users,DC=lab,DC=local"\r\n', output: '"CN=Élodie Petit,CN=Users,DC=lab,DC=local"\r\n' };
    if (/^dsquery user -samid absent/.test(line)) return { exitCode: 0, stdout: '', output: '' };
    return { exitCode: 0, stdout: 'dsmod succeeded', output: 'dsmod succeeded' };
  };
  const res = [];
  const steps = A.plan(project());
  const sum = await R.runSteps(steps, { run, platform: 'win32', onStep: (i) => res.push(i) });
  const gdn = steps.find((s) => s.kind === 'group').dn;
  assert.ok(lines.includes(`dsmod group "${gdn}" -addmbr "CN=Élodie Petit,CN=Users,DC=lab,DC=local"`));
  assert.ok(!lines.some((l) => /for \/f/.test(l)), 'pas de for /f dans l\'application');
  assert.ok(!lines.some((l) => /-addmbr ""/.test(l)));
  const absent = res.find((i) => /absent/.test(i.step.label));
  assert.equal(absent.status, 'error');
  assert.match(absent.message, /Introuvable dans l'Active Directory : absent/);
  assert.equal(sum.errors, 1);
  assert.equal(sum.ok, 2);
});

test('runSteps : DN contenant un guillemet refusé (aucune commande dsmod)', async () => {
  const lines = [];
  const run = async (line) => {
    lines.push(line);
    if (/\| findstr "="$/.test(line)) return { exitCode: 1, stdout: '', output: '' };
    if (/^dsquery user/.test(line)) return { exitCode: 0, stdout: 'CN=a\\"b,DC=lab,DC=local\r\n', output: '' };
    return { exitCode: 0, stdout: '', output: '' };
  };
  const p = A.normalizeProject({ domain: { dns: 'lab.local' }, globals: [{ id: 'g', name: 'GG_A', ou: '', description: '', members: 'x' }] });
  const res = [];
  await R.runSteps(A.plan(p), { run, platform: 'win32', onStep: (i) => res.push(i) });
  assert.equal(res.find((i) => i.step.kind === 'member').status, 'error');
  assert.ok(!lines.some((l) => /^dsmod/.test(l)));
});
