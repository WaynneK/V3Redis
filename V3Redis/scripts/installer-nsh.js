/*
 * installer-nsh.js — Script NSIS inclus dans l'installeur de V3Redis (build/installer.nsh).
 *
 * Apparence « Hyperespace », sur TOUTE la fenêtre :
 *   - pages d'accueil et de fin : volet build/installerSidebar.bmp (164 × 314), fond sombre, texte clair ;
 *   - autres pages : bandeau sombre avec build/installerHeader.bmp (150 × 57), contenu sombre (textes, champ du
 *     dossier, barre de progression, journal) ;
 *   - barre du bas et boutons sombres (thème sombre de Windows), barre de titre sombre (Windows 10 20H1+ / 11) ;
 *   - police Segoe UI (titres en Segoe UI Semibold) ;
 *   - textes en français, liste des applications livrées générée depuis apps.js.
 *
 * Où chaque réglage s'accroche dans le script d'electron-builder (templates/nsis/assistedInstaller.nsh) :
 *   - customWelcomePage : en tête des pages, donc avant la création de l'interface : couleurs, police,
 *     fonction GUIINIT (fenêtre principale), page d'accueil (absente par défaut) ;
 *   - customInstallMode : installation pour l'utilisateur courant, sans la page « pour tous / pour moi » ;
 *   - customPageAfterChangeDir : notre page « dossier » (celle d'electron-builder est désactivée par
 *     allowToChangeInstallationDirectory: false, car on ne peut pas y accrocher de style), puis le style de la
 *     page de progression qui suit ;
 *   - customFinishPage : page de fin (même lancement de l'application que celle d'electron-builder) ;
 *   - désinstallation : customUnWelcomePage, customUnInstall (style de la page de progression, au début de la
 *     désinstallation) et customUninstallPage (page de fin).
 * Les appels Windows (dwmapi, uxtheme) échouent sans conséquence sur un Windows qui ne les connaît pas : la
 * fenêtre reste alors simplement claire à ces endroits.
 * Raccourcis : Menu Démarrer > V3Redis > <application>, supprimés à la désinstallation.
 */
'use strict';

const BG = '070814'; // fond (design « Hyperespace »)
const TEXT = 'E9ECFF'; // texte sur ce fond
const MUTED = '7D82B0'; // texte secondaire (mention « V3Redis x.y.z » en bas à gauche)
const FIELD = '14163A'; // fond des champs, du journal et de la barre de progression
const ACCENT = '9F8BFF'; // barre de progression (et texte du journal d'installation)
const FONT = 'Segoe UI';
const TITLE_FONT = 'Segoe UI Semibold';

/** Couleur « RRGGBB » → COLORREF Windows (0x00BBGGRR). */
function colorref(hex) {
  const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
  return `0x00${b}${g}${r}`;
}

/** Chaîne NSIS entre guillemets : $ doublé, guillemets et retours à la ligne échappés. */
function nsisString(text) {
  return `"${String(text).replace(/\$/g, '$$$$').replace(/"/g, '$\\"').replace(/\r?\n/g, '$\\r$\\n')}"`;
}

/** « A, B, C et D » */
function frenchList(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}

/** Réglages communs, posés avant la première page (installation comme désinstallation). */
function interfaceDefines(un) {
  return [
    `  SetFont "${FONT}" 8`,
    `  !define MUI_BGCOLOR "${BG}"`,
    `  !define MUI_TEXTCOLOR "${TEXT}"`,
    // Page de progression : couleurs du journal et de la barre, posées par l'interface dès le premier affichage
    `  !define MUI_INSTFILESPAGE_COLORS "${ACCENT} ${FIELD}"`,
    '  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth colored"',
    '  !define MUI_WELCOMEPAGE_TITLE_3LINES',
    '  !define MUI_FINISHPAGE_TITLE_3LINES',
    `  !define MUI_CUSTOMFUNCTION_${un ? 'UN' : ''}GUIINIT ${un ? 'un.' : ''}v3GuiInit`,
  ];
}

/** Fonctions de style (préfixe « un. » pour le désinstalleur). */
function styleFunctions(un) {
  const p = un ? 'un.' : '';
  return [
    `  ; Bouton poussoir au theme sombre de Windows (registre attendu : $R1)`,
    `  Function ${p}v3DarkButton`,
    "    System::Call 'uxtheme::#133(p R1, i 1)'",
    "    System::Call 'uxtheme::SetWindowTheme(p R1, w \"DarkMode_Explorer\", p 0)'",
    '  FunctionEnd',
    '',
    `  ; Fenetre principale : fond, mention du bas, boutons, barre de titre`,
    `  Function ${p}v3GuiInit`,
    '    Push $R1',
    `    SetCtlColors $HWNDPARENT ${TEXT} ${BG}`,
    '    GetDlgItem $R1 $HWNDPARENT 1256', // mention « V3Redis x.y.z » (texte)
    `    SetCtlColors $R1 ${MUTED} ${BG}`,
    '    GetDlgItem $R1 $HWNDPARENT 1028', // mention (fond)
    `    SetCtlColors $R1 ${MUTED} ${BG}`,
    "    System::Call 'uxtheme::#135(i 2)'", // SetPreferredAppMode(ForceDark), Windows 10 1903+
    '    GetDlgItem $R1 $HWNDPARENT 1',
    `    Call ${p}v3DarkButton`,
    '    GetDlgItem $R1 $HWNDPARENT 2',
    `    Call ${p}v3DarkButton`,
    '    GetDlgItem $R1 $HWNDPARENT 3',
    `    Call ${p}v3DarkButton`,
    "    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'", // barre de titre sombre
    "    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'", // idem, Windows 10 avant 20H1
    `    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${colorref(BG)}, i 4)'`, // couleur (Windows 11)
    `    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i ${colorref(TEXT)}, i 4)'`,
    '    Pop $R1',
    '  FunctionEnd',
    '',
    `  ; Contenu de la page affichee. Les pages d'accueil et de fin (nsDialogs) sont une seconde fenetre`,
    `  ; « #32770 » DANS la page interieure : les deux niveaux sont traites.`,
    `  Function ${p}v3InnerShow`,
    '    Push $R0',
    '    FindWindow $R0 "#32770" "" $HWNDPARENT',
    '    Push $R0',
    `    Call ${p}v3StyleDialog`,
    '    FindWindow $R0 "#32770" "" $R0',
    '    ${If} $R0 <> 0',
    '      Push $R0',
    `      Call ${p}v3StyleDialog`,
    '    ${EndIf}',
    '    Pop $R0',
    '  FunctionEnd',
    '',
    `  ; Une fenetre de page (sur la pile) : son fond et chacun de ses controles, selon leur type`,
    `  Function ${p}v3StyleDialog`,
    '    Exch $R0',
    '    Push $R1',
    '    Push $R2',
    '    Push $R3',
    `    SetCtlColors $R0 ${TEXT} ${BG}`,
    '    StrCpy $R1 0',
    '    v3_next:', // étiquettes locales à la fonction (sans préfixe « un. »)
    '      FindWindow $R1 "" "" $R0 $R1',
    '      StrCmp $R1 0 v3_done',
    "      System::Call 'user32::GetClassNameW(p R1, w .R2, i 64)'",
    '      ${If} $R2 == "Static"',
    `        SetCtlColors $R1 ${TEXT} ${BG}`,
    '      ${ElseIf} $R2 == "Edit"',
    `        SetCtlColors $R1 ${TEXT} ${FIELD}`,
    '      ${ElseIf} $R2 == "Button"',
    "        System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'",
    '        IntOp $R3 $R3 & 0xF',
    '        ${If} $R3 <= 1', // bouton poussoir (Parcourir, Afficher les détails)
    `          Call ${p}v3DarkButton`,
    '        ${Else}', // case à cocher, bouton radio, cadre : style classique, qui respecte les couleurs
    "          System::Call 'uxtheme::SetWindowTheme(p R1, w \" \", w \" \")'",
    `          SetCtlColors $R1 ${TEXT} ${BG}`,
    '        ${EndIf}',
    '      ${ElseIf} $R2 == "msctls_progress32"',
    "        System::Call 'uxtheme::SetWindowTheme(p R1, w \" \", w \" \")'",
    "        System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'",
    '        IntOp $R3 $R3 | 1', // PBS_SMOOTH : barre continue
    "        System::Call 'user32::SetWindowLongW(p R1, i -16, i R3)'",
    `        SendMessage $R1 0x409 0 ${colorref(ACCENT)}`, // PBM_SETBARCOLOR
    `        SendMessage $R1 0x2001 0 ${colorref(FIELD)}`, // PBM_SETBKCOLOR
    '      ${ElseIf} $R2 == "SysListView32"',
    `        SendMessage $R1 0x1001 0 ${colorref(FIELD)}`, // LVM_SETBKCOLOR
    `        SendMessage $R1 0x1026 0 ${colorref(FIELD)}`, // LVM_SETTEXTBKCOLOR
    `        SendMessage $R1 0x1024 0 ${colorref(TEXT)}`, // LVM_SETTEXTCOLOR
    "        System::Call 'uxtheme::#133(p R1, i 1)'",
    "        System::Call 'uxtheme::SetWindowTheme(p R1, w \"DarkMode_Explorer\", p 0)'", // barres de défilement
    '      ${EndIf}',
    '      Goto v3_next',
    '    v3_done:',
    "    System::Call 'user32::InvalidateRect(p R0, p 0, i 1)'",
    '    Pop $R3',
    '    Pop $R2',
    '    Pop $R1',
    '    Pop $R0',
    '  FunctionEnd',
    '',
    `  ; Pages d'accueil et de fin : contenu, puis polices. Les controles sont reperes dans l'ordre de la page`,
    `  ; (image, titre, texte) : les variables MUI de ces pages n'existent pas encore a cet endroit du script.`,
    `  Function ${p}v3FullPageShow`,
    `    Call ${p}v3InnerShow`,
    '    Push $R0',
    '    Push $R1',
    '    Push $R2',
    '    Push $R3',
    '    Push $R4',
    '    FindWindow $R0 "#32770" "" $HWNDPARENT',
    '    FindWindow $R1 "#32770" "" $R0', // page nsDialogs dans la page intérieure
    '    ${If} $R1 <> 0',
    '      StrCpy $R0 $R1',
    '    ${EndIf}',
    '    StrCpy $R1 0',
    '    StrCpy $R4 0', // nombre de textes déjà traités (0 : titre, 1 : texte)
    '    v3_font_next:',
    '      FindWindow $R1 "" "" $R0 $R1',
    '      StrCmp $R1 0 v3_font_done',
    "      System::Call 'user32::GetClassNameW(p R1, w .R2, i 64)'",
    '      StrCmp $R2 "Static" 0 v3_font_next',
    "      System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'",
    '      IntOp $R3 $R3 & 0x1F',
    '      IntCmp $R3 0xE v3_font_next', // SS_BITMAP : l'image du volet
    '      ${If} $R4 == 0',
    `        CreateFont $R2 "${TITLE_FONT}" 15 600`,
    '      ${Else}',
    `        CreateFont $R2 "${FONT}" 9 400`,
    '      ${EndIf}',
    '      SendMessage $R1 ${WM_SETFONT} $R2 1',
    '      IntOp $R4 $R4 + 1',
    '      IntCmp $R4 2 v3_font_done',
    '      Goto v3_font_next',
    '    v3_font_done:',
    '    Pop $R4',
    '    Pop $R3',
    '    Pop $R2',
    '    Pop $R1',
    '    Pop $R0',
    '  FunctionEnd',
  ];
}

/**
 * Texte complet de build/installer.nsh (à écrire en UTF-8 AVEC BOM : sans lui, NSIS lirait les accents
 * dans la page de code ANSI).
 * apps : [{ id, name, windows: { exe } }] livrées dans le paquet ; product : « V3Redis ».
 */
function buildInstallerNsh({ apps, product }) {
  const names = frenchList(apps.map((a) => a.name));
  const welcomeText = nsisString(
    `Cet assistant va installer ${product} \${VERSION} et ses applications : ${names}.\n\nFermez les applications ${product} ouvertes avant de continuer.\n\nCliquez sur Suivant pour continuer.`
  ).replace('$${VERSION}', '${VERSION}');
  return [
    // Commentaires en ASCII
    '; Genere par scripts/installer-nsh.js (via scripts/build-setup.js) - ne pas modifier a la main.',
    '; Design « Hyperespace » : voir l\'en-tete de scripts/installer-nsh.js.',
    '',
    '; --- Installation : interface, page d\'accueil ---',
    '!macro customWelcomePage',
    ...interfaceDefines(false),
    `  !define MUI_WELCOMEPAGE_TITLE ${nsisString(`Bienvenue dans l'installation de ${product}`)}`,
    `  !define MUI_WELCOMEPAGE_TEXT ${welcomeText}`,
    ...styleFunctions(false),
    '',
    '  !insertmacro skipPageIfUpdated',
    '  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3FullPageShow',
    '  !insertmacro MUI_PAGE_WELCOME',
    '!macroend',
    '',
    '; --- Debut de l\'installation / de la desinstallation : style de la page de progression, puis la verification',
    '; « application ouverte » d\'electron-builder, reprise telle quelle (customCheckAppRunning la remplace) ---',
    '!include "getProcessInfo.nsh"',
    'Var pid',
    '!macro customCheckAppRunning',
    '  !ifdef __UNINSTALL__',
    '    !ifdef BUILD_UNINSTALLER',
    '      Call un.v3InnerShow',
    '    !endif',
    '  !else',
    '    !ifndef BUILD_UNINSTALLER',
    '      Call v3InnerShow',
    '    !endif',
    '  !endif',
    '  !insertmacro IS_POWERSHELL_AVAILABLE',
    '  !insertmacro _CHECK_APP_RUNNING',
    '!macroend',
    '',
    '; --- Installation pour l\'utilisateur courant (pas de page « pour tous / pour moi », pas de droits admin) ---',
    '!macro customInstallMode',
    '  StrCpy $isForceCurrentInstall "1"',
    '!macroend',
    '',
    '; --- Page « dossier » (remplace celle d\'electron-builder) puis style de la page de progression ---',
    '!macro customPageAfterChangeDir',
    '  !include StrContains.nsh',
    '  ; meme correction que l\'installeur d\'electron-builder : le dossier choisi se termine par le nom de l\'application',
    '  Function v3InstFilesPre',
    '    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR',
    '    ${If} $0 == ""',
    '      StrCpy $INSTDIR "$INSTDIR\\${APP_FILENAME}"',
    '    ${EndIf}',
    '  FunctionEnd',
    '  !insertmacro skipPageIfUpdated',
    '  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3InnerShow',
    '  !insertmacro MUI_PAGE_DIRECTORY',
    '  ; pour MUI_PAGE_INSTFILES, insere juste apres par electron-builder',
    '  !define MUI_PAGE_CUSTOMFUNCTION_PRE v3InstFilesPre',
    '  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3InnerShow',
    '!macroend',
    '',
    '; --- Page de fin (lancement de l\'application comme dans electron-builder) ---',
    '!macro customFinishPage',
    '  Function StartApp',
    '    ${if} ${isUpdated}',
    '      StrCpy $1 "--updated"',
    '    ${else}',
    '      StrCpy $1 ""',
    '    ${endif}',
    '    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"',
    '  FunctionEnd',
    `  !define MUI_FINISHPAGE_TITLE ${nsisString(`${product} est installé`)}`,
    `  !define MUI_FINISHPAGE_TEXT ${nsisString(`${product} et ses applications sont prêts.\n\nLes mises à jour arriveront directement dans ${product}, pour toutes les applications à la fois.`)}`,
    '  !define MUI_FINISHPAGE_RUN',
    '  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"',
    '  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3FullPageShow',
    '  !insertmacro MUI_PAGE_FINISH',
    '!macroend',
    '',
    '; --- Desinstallation : interface, page d\'accueil ---',
    '!macro customUnWelcomePage',
    ...interfaceDefines(true),
    `  !define MUI_WELCOMEPAGE_TITLE ${nsisString(`Désinstallation de ${product}`)}`,
    `  !define MUI_WELCOMEPAGE_TEXT ${nsisString(`${product} et ses applications (${names}) vont être supprimés de cet ordinateur.\n\nVos réglages sont conservés.\n\nCliquez sur Suivant pour continuer.`)}`,
    ...styleFunctions(true),
    '',
    '  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.v3FullPageShow',
    '  !insertmacro MUI_UNPAGE_WELCOME',
    '!macroend',
    '',
    '; --- Desinstallation : page de fin ---',
    '!macro customUninstallPage',
    `  !define MUI_FINISHPAGE_TITLE ${nsisString(`${product} a été désinstallé`)}`,
    `  !define MUI_FINISHPAGE_TEXT ${nsisString(`${product} et ses applications ont été supprimés de cet ordinateur.`)}`,
    '  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.v3FullPageShow',
    '!macroend',
    '',
    `; --- Raccourcis des applications livrees avec ${product} : Menu Demarrer > ${product} > ... ---`,
    '!macro customInstall',
    `  CreateDirectory "$SMPROGRAMS\\${product}"`,
    ...apps.map((a) => `  CreateShortCut "$SMPROGRAMS\\${product}\\${a.name}.lnk" "$INSTDIR\\resources\\apps\\${a.id}\\${a.windows.exe}"`),
    '!macroend',
    '',
    '!macro customUnInstall',
    ...apps.map((a) => `  Delete "$SMPROGRAMS\\${product}\\${a.name}.lnk"`),
    `  RMDir "$SMPROGRAMS\\${product}"`,
    '!macroend',
    '',
  ].join('\r\n');
}

module.exports = { buildInstallerNsh, nsisString, frenchList, colorref, BG, TEXT };
