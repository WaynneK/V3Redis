'use strict';
// Découpage réel des arguments : les lignes produites par plan() sont lancées comme le fait lib/runner.js
// (cmd.exe /d /v:off /s /c), mais « dsadd » est remplacé par un petit script node qui affiche ses arguments.
// Aucun outil Active Directory n'est lancé. Windows uniquement.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/agdlp');
const R = require('../lib/runner');

const skip = process.platform !== 'win32' && 'cmd.exe uniquement sous Windows';
const PRINT = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))"`;

/** Lance la ligne avec l'afficheur d'arguments à la place de l'outil, renvoie les arguments reçus. */
async function argvOf(command, tool) {
  assert.ok(command.startsWith(tool + ' '), command);
  const r = await R.runCommand(PRINT + command.slice(tool.length), { timeoutMs: 20000 });
  assert.equal(r.exitCode, 0, r.output);
  return JSON.parse(r.stdout);
}

test('dsadd : description finissant par « \\ » et mot de passe avec & | < > ^ ! reçus intacts', { skip }, async () => {
  const steps = A.plan({
    domain: { dns: 'lab.local', netbios: 'LAB' },
    options: { defaultPassword: 'Az&r|ty <9>!^' },
    ous: [{ name: 'Paris', description: 'Partage D:\\Compta\\' }],
    users: [{ login: 'jdupont', firstName: 'Jean', lastName: 'Du\\pont', ou: 'Paris' }],
    globals: [{ name: 'GG_A', ou: 'Paris', description: 'a & b \\\\', members: 'jdupont' }],
  });
  const ou = steps.find((s) => s.kind === 'ou');
  assert.deepEqual(await argvOf(ou.command, 'dsadd'), ['ou', 'OU=Paris,DC=lab,DC=local', '-desc', 'Partage D:\\Compta\\']);
  const g = steps.find((s) => s.kind === 'group');
  assert.deepEqual(await argvOf(g.command, 'dsadd'), ['group', 'CN=GG_A,OU=Paris,DC=lab,DC=local', '-secgrp', 'yes', '-scope', 'g', '-samid', 'GG_A', '-desc', 'a & b \\\\']);
  const u = steps.find((s) => s.kind === 'user');
  const argv = await argvOf(u.command, 'dsadd');
  assert.equal(argv[argv.indexOf('-pwd') + 1], 'Az&r|ty <9>!^');
  assert.equal(argv[argv.indexOf('-ln') + 1], 'Du\\pont');
  assert.deepEqual(argv.slice(-4), ['-mustchpwd', 'yes', '-disabled', 'no'], 'aucun argument avalé');
});

test('mot de passe ou nom finissant par « \\ » : refusé (il avalerait les arguments suivants)', { skip }, async () => {
  // Preuve du problème : avec « "Azerty12\" », la fin de ligne est collée au mot de passe
  const raw = 'dsadd user "CN=x,DC=lab" -pwd "Azerty12\\" -mustchpwd yes -disabled no';
  const argv = await argvOf(raw, 'dsadd');
  assert.ok(!argv.includes('-disabled'), JSON.stringify(argv));
  // … d'où le refus par la validation
  assert.ok(A.validatePassword('Azerty12\\'));
  assert.ok(A.validateName('person', 'Martin\\'));
});
