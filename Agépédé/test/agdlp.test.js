'use strict';
// Tests du moteur AGDLP (aucune commande n'est lancée ici).
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/agdlp');

/** Petit projet de référence : 2 OU, 1 GG avec 2 utilisateurs, 1 DL contenant le GG, 1 permission. */
function sample(extra) {
  return Object.assign(
    {
      version: 1,
      domain: { dns: 'lab.local', dn: '', netbios: 'LAB' },
      options: { createFolders: false },
      ous: [
        { id: 'o2', name: 'Groupes', parent: 'Paris', description: '' },
        { id: 'o1', name: 'Paris', parent: '', description: 'Site de Paris' },
      ],
      globals: [{ id: 'g1', name: 'GG_Compta', ou: 'Paris/Groupes', description: 'Comptables', members: 'jdupont, mmartin' }],
      locals: [{ id: 'l1', name: 'DL_Compta_RW', ou: 'Paris/Groupes', description: 'Modification sur Compta', members: 'GG_Compta' }],
      permissions: [{ id: 'p1', path: 'D:\\Partages\\Compta', group: 'DL_Compta_RW', right: 'RW' }],
    },
    extra || {}
  );
}
const has = (list, re) => list.some((i) => re.test(i.message));
const find = (list, table, field) => list.filter((i) => i.table === table && (!field || i.field === field));

// --- Domaine et DN ----------------------------------------------------------

test('domainToDn / dnToDomain', () => {
  assert.equal(A.domainToDn('lab.local'), 'DC=lab,DC=local');
  assert.equal(A.domainToDn(' corp.example.com. '), 'DC=corp,DC=example,DC=com');
  assert.equal(A.domainToDn(''), '');
  assert.equal(A.dnToDomain('DC=lab,DC=local'), 'lab.local');
  assert.equal(A.dnToDomain('OU=Paris,dc=corp, DC=example,DC=com'), 'corp.example.com');
});

test('escapeRdn : caractères réservés, espaces et # en tête / en fin', () => {
  assert.equal(A.escapeRdn('Ventes, Export'), 'Ventes\\, Export');
  assert.equal(A.escapeRdn('a+b"c\\d<e>f;g=h/i'), 'a\\+b\\"c\\\\d\\<e\\>f\\;g\\=h\\/i');
  assert.equal(A.escapeRdn('#Info'), '\\#Info');
  assert.equal(A.escapeRdn(' x'), '\\ x');
  assert.equal(A.escapeRdn('x '), 'x\\ ');
  assert.equal(A.escapeRdn('a\r\nb'), 'a\\0D\\0Ab');
  assert.equal(A.escapeRdn('Comptabilité Générale'), 'Comptabilité Générale');
});

test('ouPathToDn et containerDn', () => {
  const base = 'DC=lab,DC=local';
  assert.equal(A.ouPathToDn('Paris/Compta', base), 'OU=Compta,OU=Paris,DC=lab,DC=local');
  assert.equal(A.ouPathToDn(' Paris / Compta / ', base), 'OU=Compta,OU=Paris,DC=lab,DC=local');
  assert.equal(A.ouPathToDn('', base), base);
  assert.equal(A.ouPathToDn('Ventes, Export', base), 'OU=Ventes\\, Export,DC=lab,DC=local');
  assert.equal(A.containerDn('', base), 'CN=Users,DC=lab,DC=local');
  assert.equal(A.containerDn('Paris', base), 'OU=Paris,DC=lab,DC=local');
  assert.equal(A.ouFullPath({ name: 'Compta', parent: 'Paris' }), 'Paris/Compta');
});

test('escapeFilter (RFC 4515)', () => {
  assert.equal(A.escapeFilter('CN=GG (Paris),OU=a\\,b'), 'CN=GG \\28Paris\\29,OU=a\\5c,b');
  assert.equal(A.escapeFilter('a*'), 'a\\2a');
});

// --- Membres, droits --------------------------------------------------------

test('splitMembers : séparateurs , ; espace retour ligne, doublons (casse et accents ignorés)', () => {
  assert.deepEqual(A.splitMembers('jdupont, mmartin;pdurand\r\nJDupont\théloïse\nheloise'), ['jdupont', 'mmartin', 'pdurand', 'héloïse']);
  assert.deepEqual(A.splitMembers('  jdupont   mmartin '), ['jdupont', 'mmartin']);
  assert.deepEqual(A.splitMembers('Utilisateurs  du domaine, GG_Compta'), ['Utilisateurs du domaine', 'GG_Compta']);
  assert.deepEqual(A.splitMembers(''), []);
  assert.deepEqual(A.splitMembers(null), []);
  assert.deepEqual(A.splitMembers(['a', 'b', 'A']), ['a', 'b']);
});

test('RIGHTS et normalizeRight', () => {
  assert.deepEqual(A.RIGHTS.R, { label: 'Lecture', icacls: '(OI)(CI)RX' });
  assert.deepEqual(A.RIGHTS.RW, { label: 'Modification', icacls: '(OI)(CI)M' });
  assert.deepEqual(A.RIGHTS.F, { label: 'Contrôle total', icacls: '(OI)(CI)F' });
  assert.equal(A.normalizeRight('Lecture'), 'R');
  assert.equal(A.normalizeRight('rx'), 'R');
  assert.equal(A.normalizeRight('Modification'), 'RW');
  assert.equal(A.normalizeRight('M'), 'RW');
  assert.equal(A.normalizeRight('Contrôle total'), 'F');
  assert.equal(A.normalizeRight('controle  total'), 'F');
  assert.equal(A.normalizeRight('xyz'), '');
});

// --- validateName -----------------------------------------------------------

test('validateName ou : accents, espaces autorisés ; caractères cmd et / refusés', () => {
  assert.equal(A.validateName('ou', 'Comptabilité Générale'), null);
  assert.equal(A.validateName('ou', 'Ventes, Export'), null);
  for (const bad of ['a"b', 'a%b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a!b', 'Paris/Compta', 'a\\b', ' Paris', 'Paris ', '', 'a\nb']) {
    assert.ok(A.validateName('ou', bad), `devrait refuser ${JSON.stringify(bad)}`);
  }
  assert.ok(A.validateName('ou', 'x'.repeat(65)));
  assert.equal(A.validateName('ou', 'x'.repeat(64)), null);
});

test('validateName group / user : règles du sAMAccountName', () => {
  assert.equal(A.validateName('group', 'GG_Compta-Paris.2'), null);
  assert.equal(A.validateName('group', 'Équipe Comptabilité'), null);
  for (const bad of ['GG@x', 'GG,x', 'GG[1]', 'GG*', 'GG?', 'GG:x', 'GG;x', 'GG=x', 'GG+x', 'GG/x', 'GG\\x', 'GG"x', 'GG%x', '...']) {
    assert.ok(A.validateName('group', bad), `devrait refuser ${bad}`);
  }
  assert.ok(A.validateName('group', 'G'.repeat(65)));
  assert.equal(A.validateName('group', 'G'.repeat(21)), null);
  assert.equal(A.nameWarnings('group', 'G'.repeat(21)).length, 1);
  assert.equal(A.nameWarnings('group', 'GG_Compta').length, 0);
  assert.ok(A.validateName('user', 'u'.repeat(21)));
  assert.equal(A.validateName('user', 'jean.dupont'), null);
});

test('validateName path : absolu local ou UNC, sans caractères dangereux', () => {
  assert.equal(A.validateName('path', 'D:\\Partages\\Compta'), null);
  assert.equal(A.validateName('path', 'D:\\Partages\\Compta\\'), null);
  assert.equal(A.validateName('path', '\\\\srv01\\Partages\\Compta'), null);
  assert.equal(A.validateName('path', 'E:\\Données (2026)\\Équipe'), null);
  for (const bad of ['Partages\\Compta', 'D:/Partages', 'D:\\a"b', 'D:\\100%', 'D:\\a&b', 'D:\\', 'D:', 'D:\\a\\..\\b', 'D:\\a*', '\\\\srv', 'D:\\a:b', '']) {
    assert.ok(A.validateName('path', bad), `devrait refuser ${bad}`);
  }
  assert.equal(A.cleanPath('D:\\Partages\\Compta\\\\'), 'D:\\Partages\\Compta');
});

test('validateName desc : vide accepté, guillemets et % refusés', () => {
  assert.equal(A.validateName('desc', ''), null);
  assert.equal(A.validateName('desc', 'Service comptabilité & paie (Paris)'), null);
  assert.ok(A.validateName('desc', 'dit "bonjour"'));
  assert.ok(A.validateName('desc', '100%'));
});

// --- validateProject --------------------------------------------------------

test('validateProject : projet de référence sans erreur ni avertissement', () => {
  const r = A.validateProject(sample());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('validateProject : projet vide → « Rien à créer »', () => {
  const r = A.validateProject(A.emptyProject());
  assert.ok(has(r.errors, /Rien à créer/));
  assert.ok(find(r.errors, 'domain', 'dns').length, 'domaine manquant signalé');
});

test('validateProject : domaine invalide, DN incohérent, NetBIOS absent', () => {
  let r = A.validateProject(sample({ domain: { dns: 'lab_local!', dn: '', netbios: 'LAB' } }));
  assert.ok(find(r.errors, 'domain', 'dns').length);
  r = A.validateProject(sample({ domain: { dns: 'lab.local', dn: 'DC=autre,DC=local', netbios: 'LAB' } }));
  assert.ok(find(r.warnings, 'domain', 'dn').length);
  r = A.validateProject(sample({ domain: { dns: 'lab.local', dn: 'OU=x', netbios: 'LAB' } }));
  assert.ok(find(r.errors, 'domain', 'dn').length);
  r = A.validateProject(sample({ domain: { dns: 'lab.local', dn: '', netbios: '' } }));
  assert.ok(has(find(r.warnings, 'domain', 'netbios'), /« LAB »/));
});

test('validateProject : OU en double (casse et accents ignorés) → erreur', () => {
  const p = sample();
  p.ous.push({ id: 'o3', name: 'groupes', parent: 'PARIS', description: '' });
  p.ous.push({ id: 'o4', name: 'Société', parent: '', description: '' }, { id: 'o5', name: 'SOCIETE', parent: '', description: '' });
  const r = A.validateProject(p);
  assert.deepEqual(find(r.errors, 'ous', 'name').map((e) => e.id), ['o3', 'o5']);
});

test("validateProject : OU parente / OU d'un groupe absente du tableau → avertissement", () => {
  const p = sample();
  p.ous.push({ id: 'o3', name: 'Compta', parent: 'Lyon', description: '' });
  p.globals[0].ou = 'Marseille/Groupes';
  const r = A.validateProject(p);
  assert.ok(has(find(r.warnings, 'ous', 'parent'), /« Lyon ».*doit déjà exister dans l'Active Directory/));
  assert.ok(has(find(r.warnings, 'globals', 'ou'), /Marseille\/Groupes.*doit déjà exister/));
});

test('validateProject : même nom dans les GG et les DL → erreur', () => {
  const p = sample();
  p.locals.push({ id: 'l2', name: 'gg_compta', ou: '', description: '', members: '' });
  const r = A.validateProject(p);
  assert.ok(find(r.errors, 'locals', 'name').some((e) => e.id === 'l2'));
});

test('validateProject : un GG ne peut pas contenir un DL (erreur), GG imbriqué (avertissement), lui-même (erreur)', () => {
  const p = sample();
  p.globals.push({ id: 'g2', name: 'GG_Direction', ou: '', description: '', members: 'DL_Compta_RW, GG_Compta, GG_Direction' });
  p.locals[0].members = 'GG_Compta, GG_Direction';
  const r = A.validateProject(p);
  const errs = find(r.errors, 'globals', 'members');
  assert.ok(has(errs, /DL_Compta_RW.*ne peut pas contenir de groupe domaine local/));
  assert.ok(has(errs, /membre de lui-même/));
  assert.ok(has(find(r.warnings, 'globals', 'members'), /GG_Compta.*hors du schéma AGDLP/));
});

test('validateProject : membres de GG qui ressemblent à des groupes absents → avertissement', () => {
  const p = sample();
  p.globals[0].members = 'jdupont, DL_Inconnu, GG_Inconnu';
  const r = A.validateProject(p);
  const w = find(r.warnings, 'globals', 'members');
  assert.ok(has(w, /DL_Inconnu/));
  assert.ok(has(w, /GG_Inconnu.*cherchés comme comptes utilisateurs/));
});

test('validateProject : membres des DL (DL imbriqué, groupe supposé existant, boucle)', () => {
  const p = sample();
  p.locals.push({ id: 'l2', name: 'DL_Compta_R', ou: '', description: '', members: 'DL_Compta_RW, Utilisateurs du domaine' });
  p.locals[0].members = 'GG_Compta, DL_Compta_R';
  p.permissions.push({ id: 'p2', path: 'D:\\Partages\\Compta', group: 'DL_Compta_R', right: 'R' });
  const r = A.validateProject(p);
  assert.deepEqual(r.errors, []);
  const w = find(r.warnings, 'locals', 'members');
  assert.ok(has(w, /DL_Compta_RW.*imbriqué/));
  assert.ok(has(w, /Utilisateurs du domaine.*supposé existant dans l'Active Directory/));
  assert.ok(has(w, /Imbrication circulaire/));
});

test('validateProject : permissions (GG → avertissement AGDLP, groupe inconnu, droit invalide, chemin invalide)', () => {
  const p = sample();
  p.permissions.push(
    { id: 'p2', path: 'D:\\Partages\\Compta', group: 'GG_Compta', right: 'R' },
    { id: 'p3', path: 'D:\\Partages\\RH', group: 'DL_Existant', right: 'R' },
    { id: 'p4', path: 'D:\\Partages\\RH', group: 'DL_Compta_RW', right: 'X' },
    { id: 'p5', path: 'Partages', group: 'DL_Compta_RW', right: 'R' }
  );
  const r = A.validateProject(p);
  assert.ok(has(find(r.warnings, 'permissions', 'group'), /en AGDLP, les droits se donnent aux groupes domaine local/));
  assert.ok(has(find(r.warnings, 'permissions', 'group'), /DL_Existant.*supposé existant/));
  assert.ok(find(r.errors, 'permissions', 'right').some((e) => e.id === 'p4'));
  assert.ok(find(r.errors, 'permissions', 'path').some((e) => e.id === 'p5'));
});

test('validateProject : conventions GG_ / DL_ et esprit AGDLP', () => {
  const p = sample();
  p.globals.push({ id: 'g2', name: 'Comptables', ou: '', description: '', members: '' });
  p.locals.push({ id: 'l2', name: 'Lecteurs', ou: '', description: '', members: 'Comptables' });
  const r = A.validateProject(p);
  assert.ok(has(find(r.warnings, 'globals', 'name'), /commence d'habitude par « GG_ »/));
  assert.ok(has(find(r.warnings, 'locals', 'name'), /commence d'habitude par « DL_ »/));
  assert.ok(has(find(r.warnings, 'locals', 'name'), /Lecteurs.*ne reçoit aucune permission/));
  assert.ok(has(find(r.warnings, 'globals', 'members'), /Comptables.*aucun membre/));
  assert.equal(A.PREFIXES.global, 'GG_');
  assert.equal(A.PREFIXES.local, 'DL_');
});

test('validateProject : nom invalide signalé avec table, id et champ', () => {
  const p = sample();
  p.globals[0].name = 'GG&Compta';
  const r = A.validateProject(p);
  const e = r.errors.find((x) => x.table === 'globals' && x.id === 'g1' && x.field === 'name');
  assert.ok(e && /« & »/.test(e.message));
});

// --- plan -------------------------------------------------------------------

test('plan : commandes exactes du projet de référence', () => {
  const steps = A.plan(sample());
  const G = 'CN=GG_Compta,OU=Groupes,OU=Paris,DC=lab,DC=local';
  const D = 'CN=DL_Compta_RW,OU=Groupes,OU=Paris,DC=lab,DC=local';
  assert.deepEqual(
    steps.map((s) => s.command),
    [
      'dsadd ou "OU=Paris,DC=lab,DC=local" -desc "Site de Paris"',
      'dsadd ou "OU=Groupes,OU=Paris,DC=lab,DC=local"',
      `dsadd group "${G}" -secgrp yes -scope g -samid GG_Compta -desc "Comptables"`,
      `dsadd group "${D}" -secgrp yes -scope l -samid DL_Compta_RW -desc "Modification sur Compta"`,
      `(dsquery user -samid jdupont -limit 1 | findstr "=" >nul || (echo    Introuvable dans l'Active Directory : jdupont& cmd /c exit 1)) && for /f "delims=" %u in ('dsquery user -samid jdupont -limit 1') do @dsmod group "${G}" -addmbr "%~u"`,
      `(dsquery user -samid mmartin -limit 1 | findstr "=" >nul || (echo    Introuvable dans l'Active Directory : mmartin& cmd /c exit 1)) && for /f "delims=" %u in ('dsquery user -samid mmartin -limit 1') do @dsmod group "${G}" -addmbr "%~u"`,
      `dsmod group "${D}" -addmbr "${G}"`,
      'icacls "D:\\Partages\\Compta" /grant "LAB\\DL_Compta_RW:(OI)(CI)M"',
    ]
  );
  assert.deepEqual(
    steps.map((s) => s.label),
    [
      "Créer l'OU Paris",
      "Créer l'OU Paris/Groupes",
      'Créer le groupe global GG_Compta',
      'Créer le groupe domaine local DL_Compta_RW',
      'Ajouter jdupont dans GG_Compta',
      'Ajouter mmartin dans GG_Compta',
      'Ajouter GG_Compta dans DL_Compta_RW',
      'Donner Modification à DL_Compta_RW sur D:\\Partages\\Compta',
    ]
  );
  assert.equal(steps[0].check, 'dsquery * "OU=Paris,DC=lab,DC=local" -scope base 2>nul | findstr "="');
  assert.equal(steps[6].check, `dsquery * "${G}" -scope base -filter "(memberOf=${D})" 2>nul | findstr "="`);
  assert.equal(steps[4].check, `dsquery * domainroot -filter "(&(objectCategory=person)(objectClass=user)(sAMAccountName=jdupont)(memberOf=${G}))" 2>nul | findstr "="`);
  assert.equal(steps[7].check, null);
  assert.equal(steps[2].dn, G);
  assert.deepEqual(steps.map((s) => s.kind), ['ou', 'ou', 'group', 'group', 'member', 'member', 'member', 'acl']);
  for (const s of steps) assert.deepEqual(Object.keys(s).filter((k) => ['id', 'kind', 'table', 'rowId', 'label', 'dn', 'command', 'check'].includes(k)).length, 8);
});

test('plan : ordre parents d’abord, puis GG, DL, appartenances, dossiers, droits ; dépendances', () => {
  const p = sample({ options: { createFolders: true } });
  p.ous.unshift({ id: 'o0', name: 'Compta', parent: 'Paris/Groupes', description: '' }); // petit-enfant en premier
  const steps = A.plan(p);
  const ous = steps.filter((s) => s.kind === 'ou').map((s) => s.label);
  assert.deepEqual(ous, ["Créer l'OU Paris", "Créer l'OU Paris/Groupes", "Créer l'OU Paris/Groupes/Compta"]);
  const order = steps.map((s) => s.kind);
  assert.deepEqual(order, ['ou', 'ou', 'ou', 'group', 'group', 'member', 'member', 'member', 'folder', 'acl']);
  const folder = steps.find((s) => s.kind === 'folder');
  assert.equal(folder.command, 'if not exist "D:\\Partages\\Compta" mkdir "D:\\Partages\\Compta"');
  const acl = steps.find((s) => s.kind === 'acl');
  assert.ok(acl.needs.includes(folder.id));
  const ggToDl = steps.find((s) => s.label === 'Ajouter GG_Compta dans DL_Compta_RW');
  assert.equal(ggToDl.needs.length, 2);
  const child = steps.find((s) => s.label === "Créer l'OU Paris/Groupes/Compta");
  assert.deepEqual(child.needs, [steps[1].id]);
});

test('plan : groupe existant (hors tableau) dans un DL → dsquery group ; NetBIOS déduit du DNS', () => {
  const p = sample({ domain: { dns: 'corp.lab.local', dn: '', netbios: '' } });
  p.locals[0].members = 'GG_Compta, GG Existant';
  p.globals[0].ou = '';
  const steps = A.plan(p);
  const m = steps.find((s) => s.label === 'Ajouter GG Existant dans DL_Compta_RW');
  assert.match(m.command, /^\(dsquery group -samid "GG Existant" -limit 1 \| findstr "=" >nul/);
  assert.match(m.check, /\(objectCategory=group\)\(sAMAccountName=GG Existant\)/);
  const g = steps.find((s) => s.label === 'Créer le groupe global GG_Compta');
  assert.equal(g.dn, 'CN=GG_Compta,CN=Users,DC=corp,DC=lab,DC=local');
  assert.match(steps.at(-1).command, /"CORP\\DL_Compta_RW:\(OI\)\(CI\)M"$/);
});

test('plan : lignes invalides et appartenances interdites ignorées (aucune commande dangereuse)', () => {
  const p = sample();
  p.globals.push({ id: 'g2', name: 'GG&del', ou: '', description: '', members: 'x' });
  p.globals[0].members = 'jdupont, DL_Compta_RW, bad"name';
  p.permissions.push({ id: 'p2', path: 'D:\\a"b', group: 'DL_Compta_RW', right: 'R' });
  const steps = A.plan(p);
  assert.ok(!steps.some((s) => s.rowId === 'g2'));
  assert.ok(!steps.some((s) => s.label === 'Ajouter DL_Compta_RW dans GG_Compta'));
  assert.ok(!steps.some((s) => /bad"name|a"b/.test(s.command)));
  assert.equal(steps.filter((s) => s.kind === 'acl').length, 1);
});

test('plan : DN échappé, guillemets selon besoin, domaine invalide → aucune étape', () => {
  const p = sample();
  p.ous.push({ id: 'o3', name: 'Ventes, Export', parent: '', description: '' });
  p.globals.push({ id: 'g2', name: 'GG Ventes', ou: 'Ventes, Export', description: '', members: '' });
  const steps = A.plan(p);
  assert.ok(steps.some((s) => s.command === 'dsadd ou "OU=Ventes\\, Export,DC=lab,DC=local"'));
  assert.ok(steps.some((s) => s.command === 'dsadd group "CN=GG Ventes,OU=Ventes\\, Export,DC=lab,DC=local" -secgrp yes -scope g -samid "GG Ventes"'));
  assert.deepEqual(A.plan(sample({ domain: { dns: '', dn: '', netbios: '' } })), []);
  assert.equal(A.plan(sample({ domain: { dns: '', dn: 'DC=lab,DC=local', netbios: '' } })).at(-1).command, 'icacls "D:\\Partages\\Compta" /grant "LAB\\DL_Compta_RW:(OI)(CI)M"');
});

// --- toBatch ----------------------------------------------------------------

test('toBatch : en-tête, CRLF, chcp, %% doublés, comptage et code de sortie', () => {
  const steps = A.plan(sample());
  const bat = A.toBatch(steps, { title: 'Projet Compta', domain: { dns: 'lab.local', netbios: 'LAB' }, date: new Date(2026, 9, 8, 14, 30) });
  assert.ok(bat.startsWith('@echo off\r\nsetlocal\r\nfor /f "tokens=2 delims=:." %%c in (\'chcp\') do set /a AGP_CP=%%c\r\nif not defined AGP_CP set AGP_CP=850\r\nchcp 65001 >nul\r\n'));
  assert.ok(!/[^\r]\n/.test(bat), 'uniquement des fins de ligne CRLF');
  assert.ok(bat.endsWith('exit /b %ERR%\r\n'));
  assert.ok(!/\bpause\b/i.test(bat.replace(/^rem.*$/gim, '')), 'pas de pause');
  assert.match(bat, /rem  Généré par Agépédé le 2026-10-08 14:30 - domaine lab\.local \(LAB\)/);
  assert.match(bat, /UTF-8 sans BOM/);
  assert.match(bat, /where dsadd >nul 2>&1 \|\| \(echo ERREUR/);
  assert.match(bat, /echo \[1\/8\] Créer l'OU Paris\r\n/);
  assert.match(bat, /echo \[8\/8\] Donner Modification à DL_Compta_RW sur D:\\Partages\\Compta/);
  // Membre cherché par son identifiant : DN et requête en variables (lues en UTF-8), recherche dans la page d'origine
  assert.ok(
    bat.includes(
      [
        'set "AGP_G=CN=GG_Compta,OU=Groupes,OU=Paris,DC=lab,DC=local"',
        'set "AGP_Q=dsquery user -samid jdupont -limit 1"',
        'set "AGP_M=jdupont"',
        'chcp %AGP_CP% >nul',
        `(%AGP_Q% | findstr "=" >nul || (echo    Introuvable dans l'Active Directory : %AGP_M%& cmd /c exit 1)) && for /f "delims=" %%u in ('%AGP_Q%') do @dsmod group "%AGP_G%" -addmbr "%%~u"`,
        'set /a AGP_RC=%errorlevel%',
        'chcp 65001 >nul',
        "if %AGP_RC% neq 0 (set /a ERR+=1 & echo    ECHEC de l'étape 5.)",
      ].join('\r\n')
    )
  );
  assert.ok(!/[^%]%u\b|[^%]%~u/.test(bat), 'aucune variable de for non doublée');
  // Les lignes exécutées dans la page d'origine sont en ASCII (sinon elles seraient mal lues)
  const lines = bat.split('\r\n');
  lines.forEach((l, i) => {
    if (l === 'chcp %AGP_CP% >nul') for (const next of lines.slice(i + 1, i + 4)) assert.ok(/^[\x20-\x7e]*$/.test(next), `ligne non ASCII après chcp : ${next}`);
  });
  assert.equal((bat.match(/if %errorlevel% neq 0 \(set \/a ERR\+=1 & echo {4}ECHEC de l'étape \d+\.\)/g) || []).length, 6);
  assert.equal((bat.match(/if %AGP_RC% neq 0 \(set \/a ERR\+=1 & echo {4}ECHEC de l'étape \d+\.\)/g) || []).length, 2);
  assert.equal((bat.match(/goto :etape_\d+_fin/g) || []).length, 7, 'test d’existence sauf pour icacls');
  assert.match(bat, /echo Terminé : 8 étape\(s\), %DEJA% déjà faite\(s\), %ERR% en échec\./);
});

test('toBatch : dossier → remise à zéro du code ; titre nettoyé ; liste vide', () => {
  const steps = A.plan(sample({ options: { createFolders: true } }));
  const bat = A.toBatch(steps, { title: 'A & B | "C" %PATH%', domain: 'lab.local', date: '2026-10-08' });
  assert.match(bat, /rem  A  B  C PATH\r\n/);
  assert.match(bat, /cmd \/c exit 0\r\nif not exist "D:\\Partages\\Compta" mkdir "D:\\Partages\\Compta"\r\n/);
  assert.match(bat, /where icacls/);
  const empty = A.toBatch([], {});
  assert.match(empty, /Terminé : 0 étape/);
  assert.ok(!/where dsadd/.test(empty));
});

// --- CSV --------------------------------------------------------------------

test('toCsv : BOM, séparateur ;, guillemets, CRLF', () => {
  const csv = A.toCsv([{ name: 'Compta; Paie', parent: 'Paris', description: 'Dit "oui"\nligne 2' }], A.COLUMNS.ous);
  assert.equal(csv, '\uFEFFNom;OU parente;Description\r\n"Compta; Paie";Paris;"Dit ""oui""\nligne 2"\r\n');
});

test('CSV aller-retour (accents, ;, guillemets, retours ligne)', () => {
  const rows = [
    { name: 'GG_Comptabilité', ou: 'Paris/Groupes', description: 'Équipe "finance"; paie', members: 'jdupont, mmartin' },
    { name: 'GG_RH', ou: '', description: 'ligne 1\r\nligne 2', members: '' },
  ];
  const back = A.parseCsv(A.toCsv(rows, A.COLUMNS.globals));
  assert.deepEqual(back[0], ['Nom', 'OU', 'Description', 'Membres (utilisateurs)']);
  assert.deepEqual(back[1], ['GG_Comptabilité', 'Paris/Groupes', 'Équipe "finance"; paie', 'jdupont, mmartin']);
  assert.deepEqual(back[2], ['GG_RH', '', 'ligne 1\r\nligne 2', '']);
  const imported = A.rowsFromTable('globals', back);
  assert.equal(imported.length, 2);
  assert.equal(imported[0].description, 'Équipe "finance"; paie');
});

test('parseCsv : détection , et tabulation, lignes vides ignorées, CR seul', () => {
  assert.deepEqual(A.parseCsv('a,b,c\n\n1,"2,5",3\n'), [['a', 'b', 'c'], ['1', '2,5', '3']]);
  assert.deepEqual(A.parseCsv('a\tb\r1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(A.parseCsv('\uFEFFx;y\r\n;\r\n1;2'), [['x', 'y'], ['1', '2']]);
  assert.deepEqual(A.parseCsv(''), []);
});

test('parsePasted : collage Excel avec cellule multiligne', () => {
  const clip = 'Nom\tOU\tDescription\tMembres (utilisateurs)\r\nGG_Compta\tParis\t"Comptables\r\nde Paris"\t"jdupont\r\nmmartin"\r\nGG_RH\t\tRH\tpdurand\r\n';
  const arr = A.parsePasted(clip);
  assert.equal(arr.length, 3);
  assert.deepEqual(arr[1], ['GG_Compta', 'Paris', 'Comptables\r\nde Paris', 'jdupont\r\nmmartin']);
  const rows = A.rowsFromTable('globals', arr);
  assert.equal(rows[0].members, 'jdupont, mmartin');
  assert.deepEqual(A.parsePasted('a;b\r\nc;d'), [['a', 'b'], ['c', 'd']]);
});

test('rowsFromTable : en-tête reconnu (casse, accents, libellé court), droits en toutes lettres, ids', () => {
  const rows = A.rowsFromTable('permissions', [
    ['DOSSIER', 'groupe dl', 'Droit'],
    ['D:\\Partages\\Compta', 'DL_Compta_R', 'Lecture'],
    ['D:\\Partages\\Compta', 'DL_Compta_RW', 'modification'],
    ['', '', ''],
    ['D:\\Partages\\Compta', 'DL_Compta_CT', 'Contrôle total', 'colonne en trop'],
  ]);
  assert.deepEqual(rows.map((r) => r.right), ['R', 'RW', 'F']);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  const noHeader = A.rowsFromTable('ous', [['Paris', '', 'Site'], ['Compta', 'Paris', '']]);
  assert.equal(noHeader.length, 2);
  assert.equal(noHeader[0].name, 'Paris');
  const hdr = A.rowsFromTable('locals', [['Nom', 'OU', 'Description', 'Membres (groupes globaux)'], ['DL_X', '', '', 'GG_A; GG_B']]);
  assert.deepEqual(hdr.map((r) => r.members), ['GG_A, GG_B']);
  assert.deepEqual(A.rowsFromTable('inconnu', [['a']]), []);
});

// --- Projet -----------------------------------------------------------------

test('emptyProject et newId', () => {
  assert.deepEqual(A.emptyProject(), {
    version: 1,
    domain: { dns: '', dn: '', netbios: '' },
    options: { createFolders: false },
    ous: [],
    globals: [],
    locals: [],
    permissions: [],
  });
  const ids = new Set(Array.from({ length: 2000 }, () => A.newId()));
  assert.equal(ids.size, 2000);
});

test('normalizeProject : ne lève jamais d’exception sur des données invalides', () => {
  for (const garbage of [null, undefined, 42, 'pas du json', '[]', [], { ous: 'x' }, { domain: 5, ous: [null, 3, 'a', []] }, true]) {
    const p = A.normalizeProject(garbage);
    assert.deepEqual(p, A.emptyProject(), `entrée ${JSON.stringify(garbage)}`);
  }
});

test('normalizeProject : complète, convertit les types et corrige les ids', () => {
  const p = A.normalizeProject(
    JSON.stringify({
      domain: { dns: ' lab.local ', netbios: 7 },
      options: { createFolders: 'true' },
      ous: [{ id: 'a', name: 'Paris' }, { id: 'a', name: 'Lyon', parent: null }],
      globals: [{ name: 'GG_X', members: ['u1', 'u2'] }],
      permissions: [{ path: 'D:\\x', group: 'DL_X', right: 'Contrôle total' }, { right: 'rw' }],
      inconnu: 1,
    })
  );
  assert.deepEqual(p.domain, { dns: 'lab.local', dn: '', netbios: '7' });
  assert.equal(p.options.createFolders, true);
  assert.equal(p.ous[0].id, 'a');
  assert.notEqual(p.ous[1].id, 'a');
  assert.deepEqual(p.ous[1], { id: p.ous[1].id, name: 'Lyon', parent: '', description: '' });
  assert.equal(p.globals[0].members, 'u1, u2');
  assert.equal(p.globals[0].ou, '');
  assert.deepEqual(p.permissions.map((r) => r.right), ['F', 'RW']);
  assert.equal(p.inconnu, undefined);
});

// --- classifyResult ---------------------------------------------------------

test('classifyResult : succès (code 0), y compris la sortie normale d’icacls', () => {
  assert.equal(A.classifyResult({ exitCode: 0, output: 'dsadd succeeded:OU=Paris,DC=lab,DC=local', kind: 'ou' }).status, 'ok');
  const ic = A.classifyResult({ exitCode: 0, output: 'processed file: D:\\x\r\nSuccessfully processed 1 files; Failed processing 0 files', kind: 'acl' });
  assert.equal(ic.status, 'ok');
  assert.equal(A.classifyResult({ exitCode: 0, output: 'Traitement réussi de 1 fichiers ; échec du traitement de 0 fichiers', kind: 'acl' }).status, 'ok');
});

test('classifyResult : « existe déjà » par code (signé, non signé, dans le texte)', () => {
  const unsigned = A.classifyResult({ exitCode: 0x80071392, output: '', kind: 'group' });
  assert.equal(unsigned.status, 'exists');
  assert.equal(unsigned.code, '0x80071392');
  assert.equal(A.classifyResult({ exitCode: -2147019886, output: '', kind: 'ou' }).status, 'exists');
  const member = A.classifyResult({ exitCode: 1, output: "dsmod a échoué :CN=DL,DC=lab:Le nom de compte spécifié est déjà membre du groupe. (0x80070562)", kind: 'member' });
  assert.equal(member.status, 'exists');
  assert.match(member.message, /Déjà membre/);
  assert.equal(A.classifyResult({ exitCode: 1, output: 'erreur 0x8007200D', kind: 'member' }).status, 'exists');
  assert.equal(A.classifyResult({ exitCode: 1378, output: '', kind: 'member' }).status, 'exists');
});

test('classifyResult : erreurs connues avec message français', () => {
  const nf = A.classifyResult({ exitCode: -2147016656, output: 'dsadd failed:Directory object not found.', kind: 'group' });
  assert.equal(nf.status, 'error');
  assert.match(nf.message, /Objet introuvable/);
  assert.equal(nf.code, '0x80072030');
  assert.match(A.classifyResult({ exitCode: 1332, output: '', kind: 'acl' }).message, /Aucun mappage/);
  assert.match(A.classifyResult({ exitCode: 0x80072144, output: '', kind: 'member' }).message, /groupe global ne peut pas contenir/);
  assert.match(A.classifyResult({ exitCode: 9009, output: "'dsadd' n'est pas reconnu", kind: 'ou' }).message, /RSAT/);
  assert.match(A.classifyResult({ exitCode: 0x80070524, output: '', kind: 'group' }).message, /existe déjà ailleurs/);
});

test('classifyResult : code 0 mais « dsadd failed » → erreur ; repli texte ; lancement impossible', () => {
  const r = A.classifyResult({ exitCode: 0, output: 'dsadd failed:The parameter is incorrect.\r\ntype dsadd /? for help.', kind: 'ou' });
  assert.equal(r.status, 'error');
  assert.match(r.message, /The parameter is incorrect/);
  assert.ok(!/type dsadd/.test(r.message));
  assert.equal(A.classifyResult({ exitCode: 1, output: "dsadd a échoué :L'objet existe déjà.", kind: 'ou' }).status, 'exists');
  assert.equal(A.classifyResult({ exitCode: 1, output: 'The object already exists.', kind: 'group' }).status, 'exists');
  assert.equal(A.classifyResult({ exitCode: null, output: '' }).status, 'error');
  assert.equal(A.classifyResult({ exitCode: 3, output: 'bizarre' }).status, 'error');
});
