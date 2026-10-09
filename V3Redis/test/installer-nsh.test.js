'use strict';

// Script NSIS de l'installeur (design « Hyperespace », fenêtre entièrement sombre) : contenu généré, échappements
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInstallerNsh, nsisString, frenchList, colorref } = require('../scripts/installer-nsh.js');

const apps = [
  { id: 'sysinfo', name: 'SysInfo Lite', windows: { exe: 'SysInfo Lite.exe' } },
  { id: 'calkip', name: 'CalkIP', windows: { exe: 'CalkIP.exe' } },
  { id: 'predf', name: 'PredF', windows: { exe: 'PredF.exe' } },
  { id: 'agepede', name: 'Agépédé', windows: { exe: 'Agepede.exe' } },
];
const nsh = buildInstallerNsh({ apps, product: 'V3Redis' });
const macro = (name) => {
  const start = nsh.indexOf(`!macro ${name}\r\n`);
  assert.ok(start >= 0, `macro ${name}`);
  return nsh.slice(start, nsh.indexOf('\r\n!macroend', start));
};

test('nsisString / frenchList / colorref', () => {
  assert.equal(nsisString('100 $ "ok"\nfin'), '"100 $$ $\\"ok$\\"$\\r$\\nfin"');
  assert.equal(frenchList(['A', 'B', 'C']), 'A, B et C');
  assert.equal(frenchList(['A']), 'A');
  assert.equal(colorref('070814'), '0x00140807');
});

test('accueil : couleurs, police et GUIINIT avant la première page, textes français', () => {
  const w = macro('customWelcomePage');
  const first = w.indexOf('MUI_PAGE_WELCOME');
  for (const s of ['MUI_BGCOLOR "070814"', 'MUI_TEXTCOLOR "E9ECFF"', 'SetFont "Segoe UI" 8', 'MUI_CUSTOMFUNCTION_GUIINIT v3GuiInit']) {
    assert.ok(w.indexOf(s) >= 0 && w.indexOf(s) < first, `${s} avant la page d'accueil`);
  }
  assert.match(w, /Bienvenue dans l'installation de V3Redis/);
  assert.match(w, /installer V3Redis \$\{VERSION\} et les applications de votre choix : SysInfo Lite, CalkIP, PredF et Agépédé\.\$\\r\$\\n/);
  assert.match(w, /skipPageIfUpdated/, 'pas de page d\'accueil lors d\'une mise à jour');
  assert.match(w, /MUI_PAGE_CUSTOMFUNCTION_SHOW v3FullPageShow\r\n  !insertmacro MUI_PAGE_WELCOME/);
  assert.ok(!/\$mui\./.test(nsh), 'aucune variable $mui.* (pas encore déclarées à cet endroit du script)');
});

test('fenêtre sombre : fond, boutons, barre de titre, contrôles des pages', () => {
  const w = macro('customWelcomePage');
  assert.match(w, /SetCtlColors \$HWNDPARENT E9ECFF 070814/);
  assert.match(w, /DarkMode_Explorer/);
  assert.match(w, /DwmSetWindowAttribute\(p \$HWNDPARENT, i 20, \*i 1, i 4\)/);
  assert.match(w, /DwmSetWindowAttribute\(p \$HWNDPARENT, i 35, \*i 0x00140807, i 4\)/);
  for (const cls of ['Static', 'Edit', 'Button', 'msctls_progress32', 'SysListView32']) assert.ok(w.includes(`$R2 == "${cls}"`), `contrôles ${cls}`);
  assert.match(w, /CreateFont \$R2 "Segoe UI Semibold" 15 600/);
  assert.ok(!/un\.v3_/.test(nsh), 'étiquettes sans préfixe un.');
  // Pages nsDialogs (accueil, fin) : la page visible est une seconde fenêtre dans la page intérieure
  assert.match(w, /Function v3InnerShow[\s\S]*Call v3StyleDialog[\s\S]*FindWindow \$R0 "#32770" "" \$R0[\s\S]*Call v3StyleDialog/);
  assert.match(w, /Function v3FullPageShow[\s\S]*FindWindow \$R1 "#32770" "" \$R0/);
});

test('pages dossier, progression, fin ; désinstallation ; raccourcis', () => {
  const d = macro('customPageAfterChangeDir');
  assert.ok(d.indexOf('MUI_PAGE_CUSTOMFUNCTION_SHOW v3InnerShow') < d.indexOf('MUI_PAGE_DIRECTORY'));
  assert.match(d, /MUI_PAGE_DIRECTORY[\s\S]*MUI_PAGE_CUSTOMFUNCTION_PRE v3InstFilesPre[\s\S]*MUI_PAGE_CUSTOMFUNCTION_SHOW v3InnerShow/);
  assert.match(macro('customInstallMode'), /isForceCurrentInstall "1"/);
  assert.match(macro('customFinishPage'), /MUI_FINISHPAGE_RUN_FUNCTION "StartApp"[\s\S]*MUI_PAGE_FINISH/);
  const u = macro('customUnWelcomePage');
  assert.ok(u.indexOf('MUI_CUSTOMFUNCTION_UNGUIINIT un.v3GuiInit') < u.indexOf('MUI_UNPAGE_WELCOME'));
  assert.match(u, /Function un\.v3InnerShow/);
  assert.match(macro('customUninstallPage'), /MUI_PAGE_CUSTOMFUNCTION_SHOW un\.v3FullPageShow/);
  // Page de progression stylée dès le début (avant la vérification « application ouverte », qui est conservée)
  const c = macro('customCheckAppRunning');
  assert.ok(c.indexOf('Call un.v3InnerShow') < c.indexOf('_CHECK_APP_RUNNING'));
  assert.ok(c.indexOf('Call v3InnerShow') < c.indexOf('_CHECK_APP_RUNNING'));
  assert.match(c, /IS_POWERSHELL_AVAILABLE[\s\S]*_CHECK_APP_RUNNING/);
  assert.match(nsh, /MUI_INSTFILESPAGE_COLORS "9F8BFF 14163A"/);
  assert.match(nsh, /MUI_INSTFILESPAGE_PROGRESSBAR "smooth colored"/);
  assert.match(nsh, /CreateShortCut "\$SMPROGRAMS\\V3Redis\\Agépédé\.lnk" "\$INSTDIR\\resources\\apps\\agepede\\Agepede\.exe"/);
  assert.ok(!/[^\r]\n/.test(nsh), 'fins de ligne CRLF');
});

test('page « Applications » : cases, choix précédent (registre), applications écartées supprimées', () => {
  const d = macro('customPageAfterChangeDir');
  // La page vient avant la page « dossier », elle est sautée lors d'une mise à jour, stylée comme les autres
  assert.ok(d.indexOf('Page custom v3AppsPage v3AppsLeave') < d.indexOf('MUI_PAGE_DIRECTORY'));
  assert.match(d, /Function v3AppsPage\r\n    \$\{if\} \$\{isUpdated\}\r\n      Abort/);
  assert.match(d, /MUI_HEADER_TEXT "Applications" "Choisissez les applications à installer avec V3Redis\."/);
  assert.match(d, /Call v3InnerShow\r\n    nsDialogs::Show/);
  for (const a of apps) {
    assert.match(d, new RegExp(`NSD_CreateCheckbox\\} [^\\r]*"${a.name}`));
    assert.match(d, new RegExp(`NSD_GetState\\} \\$v3Chk_${a.id} \\$0`));
  }
  // Variables de l'installeur seulement (le désinstalleur ne les connaît pas)
  assert.match(nsh, /!ifndef BUILD_UNINSTALLER\r\n  Var v3App_sysinfo\r\n  Var v3Chk_sysinfo/);
  // Démarrage : « 0 » dans le registre = écartée, sinon cochée
  assert.match(macro('customInit'), /ReadRegStr \$0 HKCU "Software\\V3Redis\\Applications" "calkip"\r\n  \$\{If\} \$0 == "0"\r\n    StrCpy \$v3App_calkip "0"\r\n  \$\{Else\}\r\n    StrCpy \$v3App_calkip "1"/);
  // Fin de l'installation : écartée → dossier et raccourci supprimés ; choisie → raccourci ; choix mémorisé
  const i = macro('customInstall');
  assert.match(i, /\$\{If\} \$v3App_predf == "0"\r\n    RMDir \/r "\$INSTDIR\\resources\\apps\\predf"\r\n    Delete "\$SMPROGRAMS\\V3Redis\\PredF\.lnk"\r\n    WriteRegStr HKCU "Software\\V3Redis\\Applications" "predf" "0"/);
  assert.match(i, /CreateShortCut "\$SMPROGRAMS\\V3Redis\\PredF\.lnk"[^\r]*\r\n    WriteRegStr HKCU "Software\\V3Redis\\Applications" "predf" "1"/);
  // Vraie désinstallation : le choix est oublié ; mise à jour : conservé
  assert.match(macro('customUnInstall'), /\$\{ifNot\} \$\{isUpdated\}\r\n    DeleteRegKey HKCU "Software\\V3Redis\\Applications"/);
  // Identifiant qui casserait un nom de variable NSIS : refusé
  assert.throws(() => buildInstallerNsh({ apps: [{ id: 'bad-id', name: 'X', windows: { exe: 'x.exe' } }], product: 'V3Redis' }), /Identifiant/);
});

test('package.json : installeur français, images Hyperespace, page « dossier » fournie par installer.nsh', () => {
  const nsis = require('../package.json').build.nsis;
  assert.deepEqual(nsis.installerLanguages, ['fr_FR']);
  assert.equal(nsis.installerSidebar, 'build/installerSidebar.bmp');
  assert.equal(nsis.installerHeader, 'build/installerHeader.bmp');
  assert.equal(nsis.allowToChangeInstallationDirectory, false);
});
