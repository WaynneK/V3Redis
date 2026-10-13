// Annuaire lu (« Rafraîchir l'AD ») : conversion de la sortie ADSI, index, vérification et lecture par PowerShell.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/agdlp');
const R = require('../lib/runner');

const RAW = {
  base: 'DC=lab,DC=local',
  ous: [
    { distinguishedname: 'OU=Paris,DC=lab,DC=local', description: 'Site de Paris' },
    { distinguishedname: 'OU=Groupes,OU=Paris,DC=lab,DC=local', description: null },
    { distinguishedname: 'OU=R\\2CD,DC=lab,DC=local', description: ['Recherche', 'x'] },
    { distinguishedname: 'OU=Comptabilit\\C3\\A9,DC=lab,DC=local' },
    { distinguishedname: 'OU=Ailleurs,DC=autre,DC=local' },
  ],
  users: [
    { distinguishedname: 'CN=Jean Dupont,OU=Paris,DC=lab,DC=local', samaccountname: 'jdupont', displayname: 'Jean Dupont' },
    { distinguishedname: 'CN=Administrateur,CN=Users,DC=lab,DC=local', samaccountname: 'Administrateur' },
  ],
  groups: [
    { distinguishedname: 'CN=GG_Compta,OU=Groupes,OU=Paris,DC=lab,DC=local', samaccountname: 'GG_Compta', grouptype: '-2147483646', member: 'CN=Jean Dupont,OU=Paris,DC=lab,DC=local' },
    { distinguishedname: 'CN=DL_Compta_RW,OU=Groupes,OU=Paris,DC=lab,DC=local', samaccountname: 'DL_Compta_RW', grouptype: '-2147483644', member: ['CN=GG_Compta,OU=Groupes,OU=Paris,DC=lab,DC=local', 'CN=Inconnu,CN=ForeignSecurityPrincipals,DC=lab,DC=local'] },
    { distinguishedname: 'CN=Administrateurs,CN=Builtin,DC=lab,DC=local', samaccountname: 'Administrateurs', grouptype: '-2147483643' },
  ],
};

test('annuaire : OU en chemins, emplacements, portées, membres par nom', () => {
  const d = A.directoryFromAdsi(RAW, 1000);
  assert.equal(d.at, 1000);
  assert.deepEqual(d.ous.map((o) => o.path), ['Comptabilité', 'Paris', 'Paris/Groupes', 'R,D']);
  assert.equal(d.ous.find((o) => o.path === 'R,D').description, 'Recherche');
  assert.deepEqual(d.users.map((u) => [u.login, u.ou, u.where]), [
    ['Administrateur', '', 'Users'],
    ['jdupont', 'Paris', 'Paris'],
  ]);
  const g = Object.fromEntries(d.groups.map((x) => [x.name, x]));
  assert.equal(g.GG_Compta.scope, 'global');
  assert.equal(g.GG_Compta.security, true);
  assert.deepEqual(g.GG_Compta.members, ['jdupont']);
  assert.equal(g.DL_Compta_RW.scope, 'local');
  assert.deepEqual(g.DL_Compta_RW.members, ['GG_Compta', 'Inconnu']);
  assert.equal(g.Administrateurs.ou, null, 'Builtin : hors OU et hors Users');
});

test('annuaire : sortie vide ou malformée tolérée', () => {
  assert.deepEqual(A.directoryFromAdsi(null, 1), { base: '', at: 1, ous: [], users: [], groups: [] });
  assert.equal(A.directoryFromAdsi({ base: 'DC=a', users: [{}], groups: 'x' }).users.length, 0);
  assert.equal(A.unescapeRdn('a\\,b\\C3\\A9\\ZZ'), 'a,béZZ');
});

test('index : seulement pour le domaine du projet', () => {
  const d = A.directoryFromAdsi(RAW, 1);
  assert.ok(A.directoryIndex(d, { dns: 'lab.local' }));
  assert.ok(A.directoryIndex(d, { dns: 'x', dn: 'dc=LAB, dc=local' }), 'casse et espaces ignorés');
  assert.equal(A.directoryIndex(d, { dns: 'autre.local' }), null);
  assert.equal(A.directoryIndex(null, { dns: 'lab.local' }), null);
});

const project = (extra) => Object.assign({ domain: { dns: 'lab.local', dn: '', netbios: 'LAB' }, options: { defaultPassword: 'Bienvenue2026!' } }, extra);
const msgs = (issues, table) => issues.warnings.concat(issues.errors).filter((i) => !table || i.table === table).map((i) => i.message);

test('vérification : objets trouvés dans l\'annuaire, plus d\'avertissement « supposé existant »', () => {
  const p = project({
    users: [{ login: 'pdurand', firstName: 'Paul', lastName: 'Durand', ou: 'Paris/Groupes' }],
    globals: [{ name: 'GG_RH', ou: 'Paris/Groupes', members: 'pdurand, jdupont' }],
    locals: [{ name: 'DL_RH_RW', ou: 'Paris', members: 'GG_RH, GG_Compta' }],
    permissions: [{ path: 'D:\\RH', group: 'DL_Compta_RW', right: 'RW' }],
  });
  const without = A.validateProject(p);
  assert.ok(msgs(without).some((m) => /GG_Compta.*supposé existant/.test(m)));
  assert.ok(msgs(without).some((m) => /Paris\/Groupes.*doit déjà exister/.test(m)));
  const withAd = A.validateProject(p, { directory: A.directoryFromAdsi(RAW, 1) });
  const all = msgs(withAd).join('\n');
  assert.doesNotMatch(all, /supposé existant|doit déjà exister/);
  assert.doesNotMatch(all, /GG_Compta|jdupont|Paris\/Groupes/);
});

test('vérification : absent de l\'annuaire et conflits signalés précisément', () => {
  const p = project({
    users: [{ login: 'jdupont', firstName: 'Jean', lastName: 'Dupont', ou: 'Lyon' }],
    globals: [{ name: 'GG_Compta', ou: 'Lyon', members: 'fantome' }],
    locals: [{ name: 'DL_X', ou: '', members: 'GG_Absent, jdupont' }],
    permissions: [{ path: 'D:\\X', group: 'DL_Absent', right: 'R' }],
  });
  const all = msgs(A.validateProject(p, { directory: A.directoryFromAdsi(RAW, 1) })).join('\n');
  assert.match(all, /L'OU « Lyon » n'est ni dans le tableau des OU ni dans l'Active Directory \(lu à/);
  assert.match(all, /« jdupont » existe déjà dans l'Active Directory \(« Jean Dupont », Paris\)/);
  assert.match(all, /Le groupe « GG_Compta » existe déjà dans l'Active Directory \(Paris\/Groupes\)/);
  assert.match(all, /« fantome » n'est ni dans le tableau des utilisateurs ni dans l'Active Directory/);
  assert.match(all, /« GG_Absent » n'est ni dans le tableau des groupes globaux ni dans l'Active Directory/);
  assert.match(all, /« DL_Absent » n'est ni dans le tableau des groupes domaine local ni dans l'Active Directory/);
});

test('vérification : nom déjà pris par un objet d\'un autre type = erreur', () => {
  const p = project({ users: [{ login: 'GG_Compta', lastName: 'X' }], globals: [{ name: 'jdupont', members: '' }] });
  const errs = A.validateProject(p, { directory: A.directoryFromAdsi(RAW, 1) }).errors.map((e) => e.message).join('\n');
  assert.match(errs, /« GG_Compta » est déjà le nom d'un groupe dans l'Active Directory/);
  assert.match(errs, /« jdupont » est déjà l'identifiant d'un compte dans l'Active Directory/);
});

test('vérification : annuaire d\'un autre domaine ignoré, mêmes erreurs qu\'à l\'exécution (sans annuaire)', () => {
  const p = project({ domain: { dns: 'autre.local' }, globals: [{ name: 'GG_A', members: 'jdupont' }] });
  const a = A.validateProject(p);
  const b = A.validateProject(p, { directory: A.directoryFromAdsi(RAW, 1) });
  assert.deepEqual(b, a);
});

test('lecture PowerShell : JSON relu, erreurs claires', async () => {
  let call = null;
  const ok = await R.readDirectory({
    exec: async (file, args) => {
      call = { file, args };
      return { code: 0, stdout: '\uFEFF' + JSON.stringify(RAW) + '\r\n', stderr: '' };
    },
  });
  assert.equal(call.file, 'powershell.exe');
  assert.ok(call.args.includes('-NonInteractive'));
  assert.match(call.args[call.args.length - 1], /DirectorySearcher/);
  assert.doesNotMatch(R.READ_DIRECTORY_SCRIPT, /\b(Set-|Remove-|New-AD|Add-AD|\.Put\(|CommitChanges)/, 'lecture seule');
  assert.equal(ok.ok, true);
  assert.equal(ok.directory.users.length, 2);

  const down = await R.readDirectory({ exec: async () => ({ code: 1, stdout: '', stderr: "Exception : Le serveur n'est pas opérationnel.\r\nAu caractère Ligne:2\r\n" }) });
  assert.equal(down.ok, false);
  assert.match(down.error, /^Annuaire injoignable : .*serveur n'est pas opérationnel/);
  const slow = await R.readDirectory({ exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: true }) });
  assert.match(slow.error, /trop longue/);
  const junk = await R.readDirectory({ exec: async () => ({ code: 0, stdout: '{pas du json', stderr: '' }) });
  assert.match(junk.error, /illisible/);
});
