'use strict';
// Tests du lanceur : uniquement des faux (aucun dsadd / dsmod / dsquery / icacls réel n'est lancé).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const A = require('../lib/agdlp');
const R = require('../lib/runner');

function sampleSteps() {
  return A.plan({
    domain: { dns: 'lab.local', dn: '', netbios: 'LAB' },
    options: { createFolders: true },
    ous: [{ id: 'o1', name: 'Paris', parent: '', description: '' }],
    globals: [{ id: 'g1', name: 'GG_Compta', ou: 'Paris', description: '', members: 'jdupont' }],
    locals: [{ id: 'l1', name: 'DL_Compta_RW', ou: 'Paris', description: '', members: 'GG_Compta' }],
    permissions: [{ id: 'p1', path: 'D:\\Partages\\Compta', group: 'DL_Compta_RW', right: 'RW' }],
  });
}

/** Faux lanceur : réponses choisies par une fonction, journal des lignes lancées. */
function fakeRun(answer) {
  const calls = [];
  const run = async (line, opts) => {
    calls.push(line);
    const r = answer(line, opts, calls.length);
    return Object.assign({ exitCode: 0, output: '', stdout: '' }, r || {});
  };
  return { run, calls };
}

const isCheck = (steps, line) => steps.some((s) => s.check === line);

// --- runSteps ----------------------------------------------------------------

test('runSteps refuse de fonctionner hors Windows', async () => {
  await assert.rejects(() => R.runSteps(sampleSteps(), { platform: 'linux', run: async () => ({ exitCode: 0 }) }), /que sous Windows/);
});

test('runSteps simulation : aucune commande de création lancée, seulement les tests et recherches', async () => {
  const steps = sampleSteps();
  const ouDn = steps[0].dn;
  const lookup = steps.find((s) => s.member && s.member.lookup);
  const found = `"CN=Jean Dupont,CN=Users,DC=lab,DC=local"\r\n`;
  const f = fakeRun((line) => {
    if (line.includes(`"${ouDn}" -scope base`)) return { stdout: `"${ouDn}"\r\n`, output: `"${ouDn}"\r\n` };
    if (line === lookup.member.query) return { stdout: found, output: found };
    return { exitCode: 1 };
  });
  const events = [];
  const sum = await R.runSteps(steps, { dryRun: true, run: f.run, platform: 'win32', onStep: (e) => events.push(e) });
  const readOnly = (line) => isCheck(steps, line) || steps.some((s) => s.member && s.member.query === line);
  for (const line of f.calls) assert.ok(readOnly(line), `ligne non autorisée en simulation : ${line}`);
  assert.ok(!f.calls.some((l) => steps.some((s) => s.command === l)));
  assert.ok(!f.calls.some((l) => /\bdsmod\b|\bdsadd\b|\bicacls\b|\bmkdir\b/.test(l)));
  assert.equal(f.calls.length, steps.filter((s) => s.check).length + 1);
  assert.equal(events[0].status, 'exists');
  assert.equal(events.find((e) => e.step === lookup).status, 'todo');
  assert.equal(events.find((e) => e.step.kind === 'acl').status, 'unknown');
  assert.deepEqual(sum, { total: steps.length, ok: 0, exists: 1, errors: 0, skipped: 0, cancelled: 0, todo: steps.length - 2, unknown: 1 });
});

test('runSteps : objet déjà présent → commande non lancée', async () => {
  const steps = sampleSteps();
  const f = fakeRun((line) => (isCheck(steps, line) ? { stdout: '"CN=x"', output: '"CN=x"' } : {}));
  const sum = await R.runSteps(steps, { run: f.run, platform: 'win32' });
  // Toutes les étapes avec test sont « déjà faites » ; seule la commande icacls est lancée.
  assert.deepEqual(f.calls.filter((l) => !isCheck(steps, l)), [steps.at(-1).command]);
  assert.equal(sum.exists, steps.length - 1);
  assert.equal(sum.ok, 1);
});

test('runSteps : un test qui échoue sans sortie standard ne vaut pas « existe »', async () => {
  const steps = sampleSteps().slice(0, 1);
  const f = fakeRun((line) => (isCheck(steps, line) ? { exitCode: 0, stdout: '', output: 'dsquery failed:Directory object not found.' } : { exitCode: 0 }));
  const events = [];
  await R.runSteps(steps, { run: f.run, platform: 'win32', onStep: (e) => events.push(e) });
  assert.equal(events[0].status, 'ok');
  assert.deepEqual(f.calls, [steps[0].check, steps[0].command]);
});

test('runSteps : poursuit après une erreur et ignore les étapes dépendantes', async () => {
  const steps = sampleSteps();
  const ggStep = steps.find((s) => s.label === 'Créer le groupe global GG_Compta');
  const f = fakeRun((line) => {
    if (isCheck(steps, line)) return { exitCode: 1 };
    if (line === ggStep.command) return { exitCode: 0x80072098, output: "dsadd a échoué :Droits d'accès insuffisants." };
    return { exitCode: 0, output: 'succeeded' };
  });
  const events = [];
  const sum = await R.runSteps(steps, { run: f.run, platform: 'win32', onStep: (e) => events.push(e) });
  const by = (label) => events.find((e) => e.step.label === label);
  assert.equal(by('Créer le groupe global GG_Compta').status, 'error');
  assert.match(by('Créer le groupe global GG_Compta').message, /Droits insuffisants/);
  assert.equal(by('Créer le groupe global GG_Compta').code, '0x80072098');
  assert.equal(by('Ajouter jdupont dans GG_Compta').status, 'skipped');
  assert.equal(by('Ajouter GG_Compta dans DL_Compta_RW').status, 'skipped');
  assert.equal(by('Créer le groupe domaine local DL_Compta_RW').status, 'ok');
  assert.equal(by('Donner Modification à DL_Compta_RW sur D:\\Partages\\Compta').status, 'ok');
  assert.equal(sum.errors, 1);
  assert.equal(sum.skipped, 2);
  assert.equal(sum.ok, steps.length - 3);
  assert.ok(!f.calls.some((l) => l.includes('jdupont') && !isCheck(steps, l)), 'aucune commande lancée pour une étape ignorée');
});

test('runSteps : classement des codes (déjà membre → exists ; sAMAccountName pris ailleurs → error)', async () => {
  const steps = sampleSteps();
  const member = steps.find((s) => s.kind === 'member' && s.member.lookup === null);
  const group = steps.find((s) => s.kind === 'group');
  // 1) Le membre est déjà dans le groupe : dsmod répond 0x80070562 (code de sortie signé).
  const f1 = fakeRun((line) => (isCheck(steps, line) ? { exitCode: 1 } : line === member.command ? { exitCode: -2147023518 } : {}));
  const ev1 = [];
  await R.runSteps(steps, { run: f1.run, platform: 'win32', onStep: (e) => ev1.push(e) });
  assert.equal(ev1.find((e) => e.step === member).status, 'exists');
  assert.equal(ev1.find((e) => e.step === member).code, '0x80070562');
  // 2) Le DN du groupe est absent mais dsadd répond « existe déjà » : nom pris ailleurs → erreur,
  //    et les appartenances de ce groupe sont ignorées.
  const f2 = fakeRun((line) => (isCheck(steps, line) ? { exitCode: 1 } : line === group.command ? { exitCode: 0x80071392 } : {}));
  const ev2 = [];
  await R.runSteps(steps, { run: f2.run, platform: 'win32', onStep: (e) => ev2.push(e) });
  const g = ev2.find((e) => e.step === group);
  assert.equal(g.status, 'error');
  assert.match(g.message, /existe déjà ailleurs/);
  assert.equal(ev2.find((e) => e.step === member).status, 'skipped');
  // 3) Une OU dont le test dit « absente » mais que dsadd dit « existe » reste « exists ».
  const ou = steps[0];
  const f3 = fakeRun((line) => (isCheck(steps, line) ? { exitCode: 1 } : line === ou.command ? { exitCode: 0x80071392 } : {}));
  const ev3 = [];
  await R.runSteps(steps.slice(0, 1), { run: f3.run, platform: 'win32', onStep: (e) => ev3.push(e) });
  assert.equal(ev3[0].status, 'exists');
});

test('runSteps : annulation par AbortSignal', async () => {
  const steps = sampleSteps();
  const ctrl = new AbortController();
  let commands = 0;
  const f = fakeRun((line) => {
    if (isCheck(steps, line)) return { exitCode: 1 };
    commands++;
    if (commands === 2) ctrl.abort();
    return { exitCode: 0 };
  });
  const events = [];
  const sum = await R.runSteps(steps, { run: f.run, platform: 'win32', signal: ctrl.signal, onStep: (e) => events.push(e) });
  assert.equal(commands, 2);
  assert.equal(events.length, steps.length, 'chaque étape est signalée');
  assert.equal(sum.ok, 2);
  assert.equal(sum.cancelled, steps.length - 2);
  assert.ok(events.slice(2).every((e) => e.status === 'cancelled'));
});

test('runSteps : onStep reçoit index, total, durée ; un lanceur qui lève une exception → erreur, on continue', async () => {
  const steps = sampleSteps().slice(0, 2);
  let n = 0;
  const run = async (line) => {
    n++;
    if (line === steps[0].command) throw new Error('boum');
    return { exitCode: line === steps[0].check || line === steps[1].check ? 1 : 0, output: '' };
  };
  const events = [];
  const sum = await R.runSteps(steps, { run, platform: 'win32', onStep: (e) => events.push(e) });
  assert.equal(events[0].index, 0);
  assert.equal(events[0].total, 2);
  assert.equal(typeof events[0].durationMs, 'number');
  assert.equal(events[0].status, 'error');
  assert.match(events[0].output, /boum/);
  assert.equal(events[1].status, 'skipped', "l'OU n'a pas été créée : le groupe qui en dépend est ignoré");
  assert.equal(sum.errors, 1);
  assert.equal(n, 2);
});

test('runSteps accepte « exec » comme alias du lanceur', async () => {
  const steps = sampleSteps().slice(-1);
  const calls = [];
  await R.runSteps(steps, { exec: async (l) => (calls.push(l), { exitCode: 0, output: '' }), platform: 'win32' });
  assert.deepEqual(calls, [steps[0].command]);
});

test('checkSaysExists', () => {
  assert.equal(R.checkSaysExists({ exitCode: 0, stdout: '"OU=x"' }), true);
  assert.equal(R.checkSaysExists({ exitCode: 0, stdout: '  \r\n' }), false);
  assert.equal(R.checkSaysExists({ exitCode: 1, stdout: '"OU=x"' }), false);
  assert.equal(R.checkSaysExists({ exitCode: 0, output: '"OU=x"' }), true);
  assert.equal(R.checkSaysExists(null), false);
});

// --- Décodage ---------------------------------------------------------------

test('decodeOutput : UTF-8 si valide, sinon repli CP850', () => {
  assert.equal(R.decodeOutput(Buffer.from('Créé à côté', 'utf8')), 'Créé à côté');
  // « dsadd a échoué : Accès refusé » écrit en page OEM 850 : é = 0x82, è = 0x8A, É = 0x90
  const cp850 = Buffer.from([0x64, 0x73, 0x61, 0x64, 0x64, 0x20, 0x61, 0x20, 0x82, 0x63, 0x68, 0x6f, 0x75, 0x82, 0x20, 0x3a, 0x20, 0x41, 0x63, 0x63, 0x8a, 0x73, 0x20, 0x90, 0x74, 0x65]);
  assert.equal(R.decodeOutput(cp850), 'dsadd a échoué : Accès Éte');
  assert.equal(R.decodeOutput(Buffer.alloc(0)), '');
});

test('decodeCp850 : table complète 0x80-0xFF', () => {
  const all = R.decodeCp850(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  assert.equal(all.length, 256);
  assert.equal(all[0x41], 'A');
  assert.equal(all[0x80], 'Ç');
  assert.equal(all[0x85], 'à');
  assert.equal(all[0x87], 'ç');
  assert.equal(all[0xb7], 'À');
  assert.equal(all[0xd4], 'È');
  assert.equal(all[0xe1], 'ß');
  assert.equal(all[0xff], '\u00A0');
});

// --- runCommand avec un faux spawn -------------------------------------------

function fakeSpawn(behaviour) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    if (file !== 'taskkill') setImmediate(() => behaviour(child, file, args));
    return child;
  };
  return { spawn, calls };
}

test('runCommand : arguments cmd.exe, sorties fusionnées, code de sortie', async () => {
  const f = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('dsadd succeeded:OU=Société,DC=lab\r\n', 'utf8'));
    child.stderr.emit('data', Buffer.from('avertissement'));
    child.emit('close', 0);
  });
  const r = await R.runCommand('dsadd ou "OU=Société,DC=lab"', { spawn: f.spawn });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].file, /cmd(\.exe)?$/i);
  assert.deepEqual(f.calls[0].args, ['/d', '/v:off', '/s', '/c', '"chcp 65001>nul & dsadd ou "OU=Société,DC=lab""']);
  assert.equal(f.calls[0].options.windowsVerbatimArguments, true);
  assert.equal(f.calls[0].options.windowsHide, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'dsadd succeeded:OU=Société,DC=lab\r\n');
  assert.equal(r.stderr, 'avertissement');
  assert.equal(r.output, 'dsadd succeeded:OU=Société,DC=lab\r\navertissement');
});

test('runCommand : délai dépassé → arbre de processus tué (taskkill /t /f)', async () => {
  const f = fakeSpawn(() => {}); // ne se termine jamais
  const r = await R.runCommand('dsquery * domainroot', { spawn: f.spawn, timeoutMs: 20 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.match(r.output, /Délai dépassé/);
  const kill = f.calls.find((c) => c.file === 'taskkill');
  assert.deepEqual(kill.args, ['/pid', '4242', '/t', '/f']);
});

test('runCommand : annulation (AbortSignal) et erreur de lancement', async () => {
  const f = fakeSpawn(() => {});
  const ctrl = new AbortController();
  const p = R.runCommand('dsquery *', { spawn: f.spawn, signal: ctrl.signal, timeoutMs: 0 });
  ctrl.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  assert.ok(f.calls.some((c) => c.file === 'taskkill'));

  const pre = new AbortController();
  pre.abort();
  const f2 = fakeSpawn(() => {});
  const r2 = await R.runCommand('x', { spawn: f2.spawn, signal: pre.signal });
  assert.equal(r2.aborted, true);
  assert.equal(f2.calls.length, 0, 'rien lancé si déjà annulé');

  const f3 = fakeSpawn((child) => child.emit('error', new Error('ENOENT')));
  const r3 = await R.runCommand('x', { spawn: f3.spawn });
  assert.equal(r3.exitCode, null);
  assert.match(r3.output, /ENOENT/);
});

// --- detectEnvironment -------------------------------------------------------

test('detectEnvironment hors Windows : tout à faux, aucune commande', async () => {
  const f = fakeRun(() => ({}));
  const env = await R.detectEnvironment({ platform: 'linux', run: f.run, env: {}, release: '6.0' });
  assert.equal(env.isWindows, false);
  assert.equal(env.isServer, false);
  assert.equal(env.isAdmin, false);
  assert.deepEqual(env.tools, { dsadd: false, dsmod: false, dsquery: false, dsget: false, icacls: false });
  assert.equal(f.calls.length, 0);
});

test('detectEnvironment : contrôleur de domaine administrateur', async () => {
  const f = fakeRun((line) => {
    if (line.startsWith('where ')) {
      const out = 'C:\\Windows\\System32\\dsadd.exe\r\nC:\\Windows\\System32\\dsmod.exe\r\nC:\\Windows\\System32\\dsquery.exe\r\nC:\\Windows\\System32\\dsget.exe\r\nC:\\Windows\\System32\\icacls.exe\r\n';
      return { stdout: out, output: out };
    }
    if (line.startsWith('reg query')) return { output: '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    InstallationType    REG_SZ    Server\r\n' };
    if (line === 'whoami /groups') return { output: 'BUILTIN\\Administrateurs  Alias  S-1-5-32-544  Groupe obligatoire, Activé\r\nÉtiquette obligatoire\\Niveau obligatoire élevé  Étiquette  S-1-16-12288\r\n' };
    if (line === 'dsquery * domainroot -scope base') return { stdout: '"DC=lab,DC=local"\r\n', output: '"DC=lab,DC=local"\r\n' };
    return { exitCode: 1 };
  });
  const env = await R.detectEnvironment({ platform: 'win32', run: f.run, env: { USERDNSDOMAIN: 'LAB.LOCAL', USERDOMAIN: 'LAB', COMPUTERNAME: 'DC01' }, release: '10.0.20348' });
  assert.equal(env.isWindows, true);
  assert.equal(env.isServer, true);
  assert.equal(env.installationType, 'Server');
  assert.equal(env.isAdmin, true);
  assert.deepEqual(env.tools, { dsadd: true, dsmod: true, dsquery: true, dsget: true, icacls: true });
  assert.equal(env.joined, true);
  assert.deepEqual(env.domain, { dns: 'lab.local', netbios: 'LAB', dn: 'DC=lab,DC=local' });
  assert.ok(!f.calls.some((l) => /dsadd|dsmod|icacls/.test(l) && !l.startsWith('where')), 'aucun outil de modification lancé');
});

test('detectEnvironment : poste client non élevé, hors domaine, outils absents', async () => {
  const f = fakeRun((line) => {
    if (line.startsWith('where ')) return { exitCode: 1, stdout: 'C:\\Windows\\System32\\icacls.exe\r\n', output: 'C:\\Windows\\System32\\icacls.exe\r\nINFO: ...' };
    if (line.startsWith('reg query')) return { output: '    InstallationType    REG_SZ    Client\r\n' };
    if (line === 'whoami /groups') return { output: 'BUILTIN\\Administrateurs S-1-5-32-544 Groupe utilisé pour refuser uniquement\r\nS-1-16-8192\r\n' };
    if (line === 'net session') return { exitCode: 2 };
    return { exitCode: 1 };
  });
  const env = await R.detectEnvironment({ platform: 'win32', run: f.run, env: { USERDOMAIN: 'PC01', COMPUTERNAME: 'PC01' } });
  assert.equal(env.isServer, false);
  assert.equal(env.isAdmin, false);
  assert.equal(env.joined, false);
  assert.deepEqual(env.tools, { dsadd: false, dsmod: false, dsquery: false, dsget: false, icacls: true });
  assert.deepEqual(env.domain, { dns: '', netbios: '', dn: '' });
  assert.ok(!f.calls.includes('dsquery * domainroot -scope base'));
});

test('detectEnvironment : whoami indisponible → repli « net session » ; lanceur qui lève → pas d’exception', async () => {
  const f = fakeRun((line) => (line === 'net session' ? { exitCode: 0 } : { exitCode: 1 }));
  const env = await R.detectEnvironment({ platform: 'win32', run: f.run, env: {} });
  assert.equal(env.isAdmin, true);
  const env2 = await R.detectEnvironment({ platform: 'win32', run: async () => { throw new Error('x'); }, env: {} });
  assert.equal(env2.isAdmin, false);
  assert.equal(env2.tools.dsadd, false);
});

test('runSteps : utilisateur absent de son OU mais identifiant pris ailleurs → erreur, appartenance ignorée', async () => {
  const steps = A.plan({
    domain: { dns: 'lab.local', dn: '', netbios: 'LAB' },
    options: { defaultPassword: 'Bienvenue2026!' },
    users: [{ id: 'u1', login: 'jdupont', firstName: 'Jean', lastName: 'Dupont', ou: '', password: '' }],
    globals: [{ id: 'g1', name: 'GG_Compta', ou: '', description: '', members: 'jdupont' }],
  });
  const f = fakeRun((line) => {
    if (isCheck(steps, line)) return { exitCode: 1 };
    if (/^dsadd user/.test(line)) return { exitCode: 0x80070524 | 0, output: 'dsadd a échoué :0x80070524:' };
    return {};
  });
  const events = [];
  await R.runSteps(steps, { run: f.run, platform: 'win32', onStep: (e) => events.push(e) });
  const user = events.find((e) => e.step.kind === 'user');
  assert.equal(user.status, 'error');
  assert.match(user.message, /Un compte portant ce nom/);
  assert.equal(events.find((e) => e.step.kind === 'member').status, 'skipped');
});

test('runSteps simulation : héritage cassé non vérifiable à l\'avance', async () => {
  const steps = A.plan({ domain: { dns: 'lab.local' }, folders: [{ id: 'f1', path: 'D:\\Partages\\Compta', inheritance: 'break' }] });
  const events = [];
  await R.runSteps(steps, { dryRun: true, run: fakeRun(() => ({ exitCode: 1 })).run, platform: 'win32', onStep: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => [e.step.kind, e.status]), [['folder', 'todo'], ['inherit', 'unknown']]);
});

// --- Correctifs ----------------------------------------------------------------

test('garde-fou : une étape au DN suspect bloque tout, simulation comprise (rien n\'est lancé)', async () => {
  const bad = 'OU=Paris,DC=lab,DC=local" & whoami & "';
  const evil = [{ id: 'ou-1', kind: 'ou', label: 'x', dn: bad, command: `dsadd ou "${bad}"`, check: `dsquery * "${bad}" -scope base 2>nul | findstr "="`, needs: [] }];
  for (const dryRun of [true, false]) {
    const f = fakeRun(() => ({ exitCode: 1 }));
    await assert.rejects(() => R.runSteps(sampleSteps().concat(evil), { dryRun, run: f.run, platform: 'win32' }), /Exécution refusée/);
    assert.deepEqual(f.calls, [], 'aucune ligne envoyée à cmd.exe');
  }
  assert.match(R.unsafeStep({ kind: 'ou', dn: 'OU=a,DC=%x%' }), /DN refusé/);
  assert.match(R.unsafeStep({ kind: 'member', dn: 'CN=G', member: { dn: 'CN=a"b' } }), /DN refusé/);
  assert.match(R.unsafeStep({ kind: 'acl', dn: null, command: 'icacls "D:\\a /grant x' }), /guillemets non appariés/);
  assert.match(R.unsafeStep({ kind: 'acl', dn: null, command: 'icacls "D:\\a"\r\nwhoami' }), /plusieurs lignes/);
  // Toutes les étapes produites par plan() passent le garde-fou (lignes de recherche, filtres, dossiers…)
  const full = A.plan({
    domain: { dns: 'lab.local', netbios: 'LAB' },
    options: { createFolders: true, defaultPassword: 'Az&r|ty <9>!^' },
    ous: [{ name: 'Ventes, Export', description: 'Partage D:\\Ventes\\' }],
    users: [{ login: 'jdupont', firstName: 'Jean', lastName: 'Dupont (RH)', ou: 'Ventes, Export' }],
    globals: [{ name: 'GG Ventes', ou: 'Ventes, Export', description: 'a & b | c', members: 'jdupont, autre compte' }],
    locals: [{ name: 'DL_Ventes', members: 'GG Ventes, Utilisateurs du domaine' }],
    folders: [{ path: 'D:\\Données (2026)\\Ventes', inheritance: 'break' }],
    permissions: [{ path: 'D:\\Données (2026)\\Ventes', group: 'DL_Ventes', right: 'RW' }],
  });
  assert.ok(full.length > 8);
  for (const s of full) assert.equal(R.unsafeStep(s), null, s.command);
});

test('délais : pas de délai pour icacls / mkdir (droits, héritage, dossiers), délai par défaut pour le reste', async () => {
  const steps = A.plan({
    domain: { dns: 'lab.local', netbios: 'LAB' },
    ous: [{ id: 'o1', name: 'Paris' }],
    folders: [{ id: 'f1', path: 'D:\\Partages', inheritance: 'break' }],
    permissions: [{ id: 'p1', path: 'D:\\Partages', group: 'DL_Existant', right: 'R' }],
  });
  const seen = [];
  const run = async (line, opts) => {
    seen.push([line, opts]);
    return { exitCode: /findstr "="$|^if exist/.test(line) ? 1 : 0, output: '', stdout: '' };
  };
  await R.runSteps(steps, { run, platform: 'win32' });
  const optsOf = (step) => seen.find(([l]) => l === step.command)[1];
  for (const s of steps) {
    const o = optsOf(s);
    if (['acl', 'inherit', 'folder'].includes(s.kind)) assert.equal(o.timeoutMs, 0, s.kind);
    else assert.equal(o.timeoutMs, undefined, s.kind);
    assert.ok('signal' in o);
  }
  // Les tests d'existence gardent le délai par défaut
  for (const [l, o] of seen) if (steps.some((s) => s.check === l)) assert.equal(o.timeoutMs, undefined);
  assert.equal(R.timeoutFor({ kind: 'acl' }), 0);
  assert.equal(R.timeoutFor({ kind: 'user' }), undefined);
  // runCommand : 0 = aucun minuteur (le faux processus ne se termine jamais seul ; annulation par le signal)
  const ctrl = new AbortController();
  const child = new EventEmitter();
  child.pid = 1;
  const spawn = (file) => (file === 'taskkill' ? { on() {} } : child);
  const p = R.runCommand('icacls "D:\\Partages" /grant x', { spawn, timeoutMs: 0, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 30));
  ctrl.abort();
  const r = await p;
  assert.equal(r.timedOut, false);
  assert.equal(r.aborted, true);
});

test('simulation : membre recherché (lecture seule) et signalé introuvable, sans dsmod', async () => {
  const steps = A.plan({
    domain: { dns: 'lab.local', netbios: 'LAB' },
    globals: [{ id: 'g1', name: 'GG_A', ou: '', description: '', members: 'present, absent' }],
  });
  const f = fakeRun((line) => {
    if (/^dsquery user -samid present /.test(line)) return { stdout: '"CN=Présent,CN=Users,DC=lab,DC=local"\r\n', output: '' };
    return { exitCode: 1, stdout: '' };
  });
  const events = [];
  const sum = await R.runSteps(steps, { dryRun: true, run: f.run, platform: 'win32', onStep: (e) => events.push(e) });
  const by = (name) => events.find((e) => e.step.member && e.step.member.name === name);
  assert.equal(by('present').status, 'todo');
  assert.equal(by('absent').status, 'error');
  assert.match(by('absent').message, /Introuvable dans l'Active Directory : absent/);
  assert.ok(!f.calls.some((l) => /\bdsmod\b|\bdsadd\b/.test(l)), 'lecture seule');
  assert.ok(f.calls.includes('dsquery user -samid absent -limit 1'));
  assert.equal(sum.errors, 1);
});
