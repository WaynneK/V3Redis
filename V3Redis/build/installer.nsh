; Genere par scripts/installer-nsh.js (via scripts/build-setup.js) - ne pas modifier a la main.
; Design « Hyperespace » : voir l'en-tete de scripts/installer-nsh.js.

; --- Choix des applications : "1" a installer, "0" a ecarter (variables de l'installeur seulement) ---
!ifndef BUILD_UNINSTALLER
  Var v3App_sysinfo
  Var v3Chk_sysinfo
  Var v3App_calkip
  Var v3Chk_calkip
  Var v3App_predf
  Var v3Chk_predf
  Var v3App_agepede
  Var v3Chk_agepede
!endif

; --- Demarrage de l'installeur : choix precedent (registre), sinon toutes les applications ---
!macro customInit
  ReadRegStr $0 HKCU "Software\V3Redis\Applications" "sysinfo"
  ${If} $0 == "0"
    StrCpy $v3App_sysinfo "0"
  ${Else}
    StrCpy $v3App_sysinfo "1"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\V3Redis\Applications" "calkip"
  ${If} $0 == "0"
    StrCpy $v3App_calkip "0"
  ${Else}
    StrCpy $v3App_calkip "1"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\V3Redis\Applications" "predf"
  ${If} $0 == "0"
    StrCpy $v3App_predf "0"
  ${Else}
    StrCpy $v3App_predf "1"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\V3Redis\Applications" "agepede"
  ${If} $0 == "0"
    StrCpy $v3App_agepede "0"
  ${Else}
    StrCpy $v3App_agepede "1"
  ${EndIf}
!macroend

; --- Installation : interface, page d'accueil ---
!macro customWelcomePage
  SetFont "Segoe UI" 8
  !define MUI_BGCOLOR "070814"
  !define MUI_TEXTCOLOR "E9ECFF"
  !define MUI_INSTFILESPAGE_COLORS "9F8BFF 14163A"
  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth colored"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_CUSTOMFUNCTION_GUIINIT v3GuiInit
  !define MUI_WELCOMEPAGE_TITLE "Bienvenue dans l'installation de V3Redis"
  !define MUI_WELCOMEPAGE_TEXT "Cet assistant va installer V3Redis ${VERSION} et les applications de votre choix : SysInfo Lite, CalkIP, PredF et Agépédé.$\r$\n$\r$\nFermez les applications V3Redis ouvertes avant de continuer.$\r$\n$\r$\nCliquez sur Suivant pour continuer."
  ; Bouton poussoir au theme sombre de Windows (registre attendu : $R1)
  Function v3DarkButton
    System::Call 'uxtheme::#133(p R1, i 1)'
    System::Call 'uxtheme::SetWindowTheme(p R1, w "DarkMode_Explorer", p 0)'
  FunctionEnd

  ; Fenetre principale : fond, mention du bas, boutons, barre de titre
  Function v3GuiInit
    Push $R1
    SetCtlColors $HWNDPARENT E9ECFF 070814
    GetDlgItem $R1 $HWNDPARENT 1256
    SetCtlColors $R1 7D82B0 070814
    GetDlgItem $R1 $HWNDPARENT 1028
    SetCtlColors $R1 7D82B0 070814
    System::Call 'uxtheme::#135(i 2)'
    GetDlgItem $R1 $HWNDPARENT 1
    Call v3DarkButton
    GetDlgItem $R1 $HWNDPARENT 2
    Call v3DarkButton
    GetDlgItem $R1 $HWNDPARENT 3
    Call v3DarkButton
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x00140807, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00FFECE9, i 4)'
    Pop $R1
  FunctionEnd

  ; Contenu de la page affichee. Les pages d'accueil et de fin (nsDialogs) sont une seconde fenetre
  ; « #32770 » DANS la page interieure : les deux niveaux sont traites.
  Function v3InnerShow
    Push $R0
    FindWindow $R0 "#32770" "" $HWNDPARENT
    Push $R0
    Call v3StyleDialog
    FindWindow $R0 "#32770" "" $R0
    ${If} $R0 <> 0
      Push $R0
      Call v3StyleDialog
    ${EndIf}
    Pop $R0
  FunctionEnd

  ; Une fenetre de page (sur la pile) : son fond et chacun de ses controles, selon leur type
  Function v3StyleDialog
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    SetCtlColors $R0 E9ECFF 070814
    StrCpy $R1 0
    v3_next:
      FindWindow $R1 "" "" $R0 $R1
      StrCmp $R1 0 v3_done
      System::Call 'user32::GetClassNameW(p R1, w .R2, i 64)'
      ${If} $R2 == "Static"
        SetCtlColors $R1 E9ECFF 070814
      ${ElseIf} $R2 == "Edit"
        SetCtlColors $R1 E9ECFF 14163A
      ${ElseIf} $R2 == "Button"
        System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'
        IntOp $R3 $R3 & 0xF
        ${If} $R3 <= 1
          Call v3DarkButton
        ${Else}
          System::Call 'uxtheme::SetWindowTheme(p R1, w " ", w " ")'
          SetCtlColors $R1 E9ECFF 070814
        ${EndIf}
      ${ElseIf} $R2 == "msctls_progress32"
        System::Call 'uxtheme::SetWindowTheme(p R1, w " ", w " ")'
        System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'
        IntOp $R3 $R3 | 1
        System::Call 'user32::SetWindowLongW(p R1, i -16, i R3)'
        SendMessage $R1 0x409 0 0x00FF8B9F
        SendMessage $R1 0x2001 0 0x003A1614
      ${ElseIf} $R2 == "SysListView32"
        SendMessage $R1 0x1001 0 0x003A1614
        SendMessage $R1 0x1026 0 0x003A1614
        SendMessage $R1 0x1024 0 0x00FFECE9
        System::Call 'uxtheme::#133(p R1, i 1)'
        System::Call 'uxtheme::SetWindowTheme(p R1, w "DarkMode_Explorer", p 0)'
      ${EndIf}
      Goto v3_next
    v3_done:
    System::Call 'user32::InvalidateRect(p R0, p 0, i 1)'
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  ; Pages d'accueil et de fin : contenu, puis polices. Les controles sont reperes dans l'ordre de la page
  ; (image, titre, texte) : les variables MUI de ces pages n'existent pas encore a cet endroit du script.
  Function v3FullPageShow
    Call v3InnerShow
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    FindWindow $R0 "#32770" "" $HWNDPARENT
    FindWindow $R1 "#32770" "" $R0
    ${If} $R1 <> 0
      StrCpy $R0 $R1
    ${EndIf}
    StrCpy $R1 0
    StrCpy $R4 0
    v3_font_next:
      FindWindow $R1 "" "" $R0 $R1
      StrCmp $R1 0 v3_font_done
      System::Call 'user32::GetClassNameW(p R1, w .R2, i 64)'
      StrCmp $R2 "Static" 0 v3_font_next
      System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'
      IntOp $R3 $R3 & 0x1F
      IntCmp $R3 0xE v3_font_next
      ${If} $R4 == 0
        CreateFont $R2 "Segoe UI Semibold" 15 600
      ${Else}
        CreateFont $R2 "Segoe UI" 9 400
      ${EndIf}
      SendMessage $R1 ${WM_SETFONT} $R2 1
      IntOp $R4 $R4 + 1
      IntCmp $R4 2 v3_font_done
      Goto v3_font_next
    v3_font_done:
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  !insertmacro skipPageIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3FullPageShow
  !insertmacro MUI_PAGE_WELCOME
!macroend

; --- Debut de l'installation / de la desinstallation : style de la page de progression, puis la verification
; « application ouverte » d'electron-builder, reprise telle quelle (customCheckAppRunning la remplace) ---
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !ifdef __UNINSTALL__
    !ifdef BUILD_UNINSTALLER
      Call un.v3InnerShow
    !endif
  !else
    !ifndef BUILD_UNINSTALLER
      Call v3InnerShow
    !endif
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

; --- Installation pour l'utilisateur courant (pas de page « pour tous / pour moi », pas de droits admin) ---
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; --- Page « Applications », page « dossier » (remplace celle d'electron-builder), style de la progression ---
!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  Function v3AppsPage
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "Applications" "Choisissez les applications à installer avec V3Redis."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Décochez celles dont vous n'avez pas besoin. Vous pourrez les installer ou les désinstaller plus tard, à tout moment, depuis V3Redis."
    Pop $0
    ${NSD_CreateCheckbox} 4u 32u 100% 13u "SysInfo Lite  —  Tout votre matériel, en un coup d'œil (370 Mo)"
    Pop $v3Chk_sysinfo
    ${If} $v3App_sysinfo == "1"
      ${NSD_Check} $v3Chk_sysinfo
    ${EndIf}
    ${NSD_CreateCheckbox} 4u 48u 100% 13u "CalkIP  —  Vos réseaux IP, calculés en local (368 Mo)"
    Pop $v3Chk_calkip
    ${If} $v3App_calkip == "1"
      ${NSD_Check} $v3Chk_calkip
    ${EndIf}
    ${NSD_CreateCheckbox} 4u 64u 100% 13u "PredF  —  Vos PDF convertis et fusionnés (426 Mo)"
    Pop $v3Chk_predf
    ${If} $v3App_predf == "1"
      ${NSD_Check} $v3Chk_predf
    ${EndIf}
    ${NSD_CreateCheckbox} 4u 80u 100% 13u "Agépédé  —  Votre Active Directory, en AGDLP (372 Mo)"
    Pop $v3Chk_agepede
    ${If} $v3App_agepede == "1"
      ${NSD_Check} $v3Chk_agepede
    ${EndIf}
    ${NSD_CreateLabel} 0 100u 100% 12u "V3Redis lui-même est toujours installé."
    Pop $0
    Call v3InnerShow
    nsDialogs::Show
  FunctionEnd

  Function v3AppsLeave
    ${NSD_GetState} $v3Chk_sysinfo $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $v3App_sysinfo "1"
    ${Else}
      StrCpy $v3App_sysinfo "0"
    ${EndIf}
    ${NSD_GetState} $v3Chk_calkip $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $v3App_calkip "1"
    ${Else}
      StrCpy $v3App_calkip "0"
    ${EndIf}
    ${NSD_GetState} $v3Chk_predf $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $v3App_predf "1"
    ${Else}
      StrCpy $v3App_predf "0"
    ${EndIf}
    ${NSD_GetState} $v3Chk_agepede $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $v3App_agepede "1"
    ${Else}
      StrCpy $v3App_agepede "0"
    ${EndIf}
  FunctionEnd
  Page custom v3AppsPage v3AppsLeave
  !include StrContains.nsh
  ; meme correction que l'installeur d'electron-builder : le dossier choisi se termine par le nom de l'application
  Function v3InstFilesPre
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  FunctionEnd
  !insertmacro skipPageIfUpdated
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3InnerShow
  !insertmacro MUI_PAGE_DIRECTORY
  ; pour MUI_PAGE_INSTFILES, insere juste apres par electron-builder
  !define MUI_PAGE_CUSTOMFUNCTION_PRE v3InstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3InnerShow
!macroend

; --- Page de fin (lancement de l'application comme dans electron-builder) ---
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_TITLE "V3Redis est installé"
  !define MUI_FINISHPAGE_TEXT "V3Redis et les applications choisies sont prêts.$\r$\n$\r$\nLes mises à jour arriveront directement dans V3Redis, pour toutes les applications à la fois. Une application peut être ajoutée ou retirée à tout moment depuis V3Redis."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW v3FullPageShow
  !insertmacro MUI_PAGE_FINISH
!macroend

; --- Desinstallation : interface, page d'accueil ---
!macro customUnWelcomePage
  SetFont "Segoe UI" 8
  !define MUI_BGCOLOR "070814"
  !define MUI_TEXTCOLOR "E9ECFF"
  !define MUI_INSTFILESPAGE_COLORS "9F8BFF 14163A"
  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth colored"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.v3GuiInit
  !define MUI_WELCOMEPAGE_TITLE "Désinstallation de V3Redis"
  !define MUI_WELCOMEPAGE_TEXT "V3Redis et ses applications (SysInfo Lite, CalkIP, PredF et Agépédé) vont être supprimés de cet ordinateur.$\r$\n$\r$\nVos réglages sont conservés.$\r$\n$\r$\nCliquez sur Suivant pour continuer."
  ; Bouton poussoir au theme sombre de Windows (registre attendu : $R1)
  Function un.v3DarkButton
    System::Call 'uxtheme::#133(p R1, i 1)'
    System::Call 'uxtheme::SetWindowTheme(p R1, w "DarkMode_Explorer", p 0)'
  FunctionEnd

  ; Fenetre principale : fond, mention du bas, boutons, barre de titre
  Function un.v3GuiInit
    Push $R1
    SetCtlColors $HWNDPARENT E9ECFF 070814
    GetDlgItem $R1 $HWNDPARENT 1256
    SetCtlColors $R1 7D82B0 070814
    GetDlgItem $R1 $HWNDPARENT 1028
    SetCtlColors $R1 7D82B0 070814
    System::Call 'uxtheme::#135(i 2)'
    GetDlgItem $R1 $HWNDPARENT 1
    Call un.v3DarkButton
    GetDlgItem $R1 $HWNDPARENT 2
    Call un.v3DarkButton
    GetDlgItem $R1 $HWNDPARENT 3
    Call un.v3DarkButton
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x00140807, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00FFECE9, i 4)'
    Pop $R1
  FunctionEnd

  ; Contenu de la page affichee. Les pages d'accueil et de fin (nsDialogs) sont une seconde fenetre
  ; « #32770 » DANS la page interieure : les deux niveaux sont traites.
  Function un.v3InnerShow
    Push $R0
    FindWindow $R0 "#32770" "" $HWNDPARENT
    Push $R0
    Call un.v3StyleDialog
    FindWindow $R0 "#32770" "" $R0
    ${If} $R0 <> 0
      Push $R0
      Call un.v3StyleDialog
    ${EndIf}
    Pop $R0
  FunctionEnd

  ; Une fenetre de page (sur la pile) : son fond et chacun de ses controles, selon leur type
  Function un.v3StyleDialog
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    SetCtlColors $R0 E9ECFF 070814
    StrCpy $R1 0
    v3_next:
      FindWindow $R1 "" "" $R0 $R1
      StrCmp $R1 0 v3_done
      System::Call 'user32::GetClassNameW(p R1, w .R2, i 64)'
      ${If} $R2 == "Static"
        SetCtlColors $R1 E9ECFF 070814
      ${ElseIf} $R2 == "Edit"
        SetCtlColors $R1 E9ECFF 14163A
      ${ElseIf} $R2 == "Button"
        System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'
        IntOp $R3 $R3 & 0xF
        ${If} $R3 <= 1
          Call un.v3DarkButton
        ${Else}
          System::Call 'uxtheme::SetWindowTheme(p R1, w " ", w " ")'
          SetCtlColors $R1 E9ECFF 070814
        ${EndIf}
      ${ElseIf} $R2 == "msctls_progress32"
        System::Call 'uxtheme::SetWindowTheme(p R1, w " ", w " ")'
        System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'
        IntOp $R3 $R3 | 1
        System::Call 'user32::SetWindowLongW(p R1, i -16, i R3)'
        SendMessage $R1 0x409 0 0x00FF8B9F
        SendMessage $R1 0x2001 0 0x003A1614
      ${ElseIf} $R2 == "SysListView32"
        SendMessage $R1 0x1001 0 0x003A1614
        SendMessage $R1 0x1026 0 0x003A1614
        SendMessage $R1 0x1024 0 0x00FFECE9
        System::Call 'uxtheme::#133(p R1, i 1)'
        System::Call 'uxtheme::SetWindowTheme(p R1, w "DarkMode_Explorer", p 0)'
      ${EndIf}
      Goto v3_next
    v3_done:
    System::Call 'user32::InvalidateRect(p R0, p 0, i 1)'
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  ; Pages d'accueil et de fin : contenu, puis polices. Les controles sont reperes dans l'ordre de la page
  ; (image, titre, texte) : les variables MUI de ces pages n'existent pas encore a cet endroit du script.
  Function un.v3FullPageShow
    Call un.v3InnerShow
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    FindWindow $R0 "#32770" "" $HWNDPARENT
    FindWindow $R1 "#32770" "" $R0
    ${If} $R1 <> 0
      StrCpy $R0 $R1
    ${EndIf}
    StrCpy $R1 0
    StrCpy $R4 0
    v3_font_next:
      FindWindow $R1 "" "" $R0 $R1
      StrCmp $R1 0 v3_font_done
      System::Call 'user32::GetClassNameW(p R1, w .R2, i 64)'
      StrCmp $R2 "Static" 0 v3_font_next
      System::Call 'user32::GetWindowLongW(p R1, i -16) i .R3'
      IntOp $R3 $R3 & 0x1F
      IntCmp $R3 0xE v3_font_next
      ${If} $R4 == 0
        CreateFont $R2 "Segoe UI Semibold" 15 600
      ${Else}
        CreateFont $R2 "Segoe UI" 9 400
      ${EndIf}
      SendMessage $R1 ${WM_SETFONT} $R2 1
      IntOp $R4 $R4 + 1
      IntCmp $R4 2 v3_font_done
      Goto v3_font_next
    v3_font_done:
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.v3FullPageShow
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; --- Desinstallation : page de fin ---
!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "V3Redis a été désinstallé"
  !define MUI_FINISHPAGE_TEXT "V3Redis et ses applications ont été supprimés de cet ordinateur."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.v3FullPageShow
!macroend

; --- Applications choisies : raccourci (Menu Demarrer > V3Redis > ...) ; ecartees : dossier supprime ---
!macro customInstall
  CreateDirectory "$SMPROGRAMS\V3Redis"
  ${If} $v3App_sysinfo == "0"
    RMDir /r "$INSTDIR\resources\apps\sysinfo"
    Delete "$SMPROGRAMS\V3Redis\SysInfo Lite.lnk"
    WriteRegStr HKCU "Software\V3Redis\Applications" "sysinfo" "0"
  ${Else}
    CreateShortCut "$SMPROGRAMS\V3Redis\SysInfo Lite.lnk" "$INSTDIR\resources\apps\sysinfo\SysInfo Lite.exe"
    WriteRegStr HKCU "Software\V3Redis\Applications" "sysinfo" "1"
  ${EndIf}
  ${If} $v3App_calkip == "0"
    RMDir /r "$INSTDIR\resources\apps\calkip"
    Delete "$SMPROGRAMS\V3Redis\CalkIP.lnk"
    WriteRegStr HKCU "Software\V3Redis\Applications" "calkip" "0"
  ${Else}
    CreateShortCut "$SMPROGRAMS\V3Redis\CalkIP.lnk" "$INSTDIR\resources\apps\calkip\CalkIP.exe"
    WriteRegStr HKCU "Software\V3Redis\Applications" "calkip" "1"
  ${EndIf}
  ${If} $v3App_predf == "0"
    RMDir /r "$INSTDIR\resources\apps\predf"
    Delete "$SMPROGRAMS\V3Redis\PredF.lnk"
    WriteRegStr HKCU "Software\V3Redis\Applications" "predf" "0"
  ${Else}
    CreateShortCut "$SMPROGRAMS\V3Redis\PredF.lnk" "$INSTDIR\resources\apps\predf\PredF.exe"
    WriteRegStr HKCU "Software\V3Redis\Applications" "predf" "1"
  ${EndIf}
  ${If} $v3App_agepede == "0"
    RMDir /r "$INSTDIR\resources\apps\agepede"
    Delete "$SMPROGRAMS\V3Redis\Agépédé.lnk"
    WriteRegStr HKCU "Software\V3Redis\Applications" "agepede" "0"
  ${Else}
    CreateShortCut "$SMPROGRAMS\V3Redis\Agépédé.lnk" "$INSTDIR\resources\apps\agepede\Agepede.exe"
    WriteRegStr HKCU "Software\V3Redis\Applications" "agepede" "1"
  ${EndIf}
  ; V3Redis Light : meme programme, fenetre classique sans effets (PC peu puissants)
  CreateShortCut "$SMPROGRAMS\V3Redis\V3Redis Light.lnk" "$INSTDIR\V3Redis.exe" "--light" "$INSTDIR\V3Redis.exe" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\V3Redis\SysInfo Lite.lnk"
  Delete "$SMPROGRAMS\V3Redis\CalkIP.lnk"
  Delete "$SMPROGRAMS\V3Redis\PredF.lnk"
  Delete "$SMPROGRAMS\V3Redis\Agépédé.lnk"
  Delete "$SMPROGRAMS\V3Redis\V3Redis Light.lnk"
  RMDir "$SMPROGRAMS\V3Redis"
  ; vraie desinstallation (pas une mise a jour) : le choix des applications est oublie
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\V3Redis\Applications"
  ${endIf}
!macroend
