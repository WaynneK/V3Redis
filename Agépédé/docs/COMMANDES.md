# Agépédé : référence des commandes

Ce document récapitule ce qui a été vérifié dans la documentation Microsoft (Microsoft Learn) avant d'écrire le moteur (`lib/agdlp.js`, `lib/runner.js`). Il explique aussi chaque choix fait dans les commandes générées.

> Les pages de référence des outils `ds*` sont archivées sur Microsoft Learn (versions Windows Server 2008/2012). Ces outils n'ont pas changé depuis et sont toujours fournis avec le rôle AD DS et avec les outils RSAT « AD DS ». La documentation précise qu'ils **doivent être lancés depuis une invite de commandes en administrateur**.

---

## 1. Créer une OU : `dsadd ou`

```
dsadd ou <DN de l'OU> [-desc <Description>] [{-s <Serveur> | -d <Domaine>}] [-u <Utilisateur>] [-p {<MotDePasse> | *}] [-q]
```

- Le DN est obligatoire. On le met entre guillemets s'il contient des espaces.
- L'OU parente doit déjà exister. Agépédé crée donc les OU **parents d'abord** (tri par profondeur).

Commande générée :
```
dsadd ou "OU=Compta,OU=Paris,DC=lab,DC=local" -desc "Service comptabilité"
```
Source : [Dsadd ou](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc770883(v=ws.11))

## 2. Créer un groupe : `dsadd group`

```
dsadd group <DN du groupe> [-secgrp {yes | no}] [-scope {l | g | u}] [-samid <NomSAM>] [-desc <Description>] [-memberof <Groupe> ...] [-members <Membre> ...]
```

- `-secgrp yes` crée un groupe de **sécurité**. C'est la valeur par défaut, mais Agépédé l'écrit quand même pour qu'on la voie.
- `-scope` : `l` pour domaine local, `g` pour global (valeur par défaut), `u` pour universel.
- `-samid` : nom « pré-Windows 2000 » (sAMAccountName). S'il est absent, dsadd le déduit du RDN. Agépédé le donne toujours.

Commandes générées :
```
dsadd group "CN=GG_Compta,OU=Groupes,DC=lab,DC=local" -secgrp yes -scope g -samid GG_Compta -desc "Comptables"
dsadd group "CN=DL_Compta_RW,OU=Groupes,DC=lab,DC=local" -secgrp yes -scope l -samid DL_Compta_RW
```
Le `-samid` est mis entre guillemets seulement s'il contient autre chose que des lettres, des chiffres, `_`, `.` ou `-`.

Si l'OU du groupe est vide, le groupe va dans le conteneur par défaut `CN=Users,<domaine>`.

Sources : [Dsadd group](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc754037(v=ws.11)) · [Use Directory Service to manage AD objects (KB 322684)](https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/directory-service-manage-objects)

## 2 bis. Créer un utilisateur : `dsadd user`

```
dsadd user <DN de l'utilisateur> [-samid <NomSAM>] [-upn <UPN>] [-fn <Prénom>] [-ln <Nom>] [-display <NomAffiché>] [-pwd {<MotDePasse> | *}] [-mustchpwd {yes | no}] [-disabled {yes | no}] ...
```

- Le DN est `CN=<Prénom Nom>,<OU>` (l'identifiant si ni prénom ni nom). Si l'OU est vide, le compte va dans `CN=Users,<domaine>`, comme les groupes.
- `-samid` : nom d'ouverture de session (20 caractères au plus) ; `-upn` : `identifiant@domaine` (nom DNS du projet).
- `-pwd` : mot de passe de la ligne, sinon le **mot de passe par défaut** du projet. Il est toujours entre guillemets : `& | < > ^ !` y sont des caractères ordinaires (expansion retardée désactivée dans le script et au lancement). `"` et `%` sont refusés.
- `-mustchpwd yes` si « Changer le mot de passe à la première connexion » est coché ; `-disabled no` : le compte est actif.
- Le test d'existence porte sur le DN (comme pour les groupes). Si le DN est libre mais que l'identifiant est pris ailleurs (`0x80070524`), l'étape est une **erreur** et les appartenances du compte sont ignorées.
- Un mot de passe refusé par la stratégie du domaine donne `0x800708C5` (2245, NERR_PasswordTooShort) ou `0x8007052D` (1325, ERROR_PASSWORD_RESTRICTION). Agépédé prévient avant : moins de 7 caractères, moins de 3 catégories (minuscules, majuscules, chiffres, symboles) ou mot de passe contenant l'identifiant (stratégie par défaut d'un domaine).

Commande générée :
```
dsadd user "CN=Jean Dupont,OU=Utilisateurs,OU=Paris,DC=lab,DC=local" -samid jdupont -upn "jdupont@lab.local" -fn Jean -ln Dupont -display "Jean Dupont" -pwd "Bienvenue2026!" -mustchpwd yes -disabled no
```
Un utilisateur du tableau cité dans les membres d'un GG est ajouté par son DN, sans recherche `dsquery`.

Sources : [Dsadd user](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc731279(v=ws.11)) · [Password must meet complexity requirements](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/password-must-meet-complexity-requirements)

## 3. Ajouter un membre : `dsmod group -addmbr`

```
dsmod group <DN du groupe> ... [{-addmbr | -rmmbr | -chmbr} <DN du membre> ...] [-c] [-q]
```

- Le membre doit être désigné **par son DN**.
- Sans `-c`, dsmod s'arrête à la première erreur.

**Quand le membre est dans le tableau**, son DN est connu :
```
dsmod group "CN=DL_Compta_RW,OU=Groupes,DC=lab,DC=local" -addmbr "CN=GG_Compta,OU=Groupes,DC=lab,DC=local"
```

**Quand le membre existe déjà dans l'AD**, on ne connaît que son nom de compte : un utilisateur pour un GG, un groupe hors tableau pour un DL. Il faut alors retrouver son DN avec `dsquery`, sur une seule ligne :
```
(dsquery user -samid jdupont -limit 1 | findstr "=" >nul || (echo    Introuvable dans l'Active Directory : jdupont& cmd /c exit 1)) && for /f "delims=" %u in ('dsquery user -samid jdupont -limit 1') do @dsmod group "CN=GG_Compta,OU=Groupes,DC=lab,DC=local" -addmbr "%~u"
```

Pourquoi cette forme :

1. **`dsquery` ne renvoie pas de code d'erreur quand il ne trouve rien.** Il répond 0 avec une sortie vide. `| findstr "="` sert de garde : findstr renvoie 1 si aucune ligne ne contient de `=`, c'est-à-dire aucun DN.
2. Dans ce cas, `(echo … & cmd /c exit 1)` affiche un message et force le code 1. L'étape est donc comptée en **échec**.
3. **Les parenthèses externes sont obligatoires.** Testé sur cmd.exe : `A || (B) && C` est lu comme `A || (B && C)`. Sans les parenthèses, le `for` ne s'exécutait jamais quand le membre était trouvé.
4. `for /f "delims=" %u in ('commande')` lit chaque ligne entière, espaces compris.
5. `"%~u"` retire les guillemets éventuels puis en remet. Ça marche que `dsquery` entoure ou non le DN de guillemets. Testé avec un DN contenant espaces, accents et parenthèses.
6. `@` évite que cmd affiche la commande du corps de la boucle.
7. `-limit 1` : un sAMAccountName est unique dans le domaine.
8. Dans un fichier `.bat`, la variable doit s'écrire `%%u` / `%%~u`, et `%u` en interactif. `toBatch()` double tous les `%`. C'est sûr, puisque la validation interdit `%` dans toutes les saisies.

**Encodage du DN trouvé (version 1.0.1).** `for /f` décode la sortie de `dsquery` avec la page de code active **au début de la ligne** (un `chcp` sur la même ligne ne compte pas : vérifié). En UTF-8 (`chcp 65001`), un DN accentué écrit par l'outil dans la page OEM (850) arrive déformé à `dsmod` (« Spé » → « Sp� », objet introuvable). D'où deux adaptations :

- **Dans l'application**, `lib/runner.js` ne passe pas par `for /f` : il lance lui-même `dsquery user -samid jdupont -limit 1`, décode la sortie (UTF-8, sinon CP850), prend le premier DN puis lance `dsmod group "<groupe>" -addmbr "<DN trouvé>"`. Le DN voyage en Unicode dans la ligne de commande. Le détail de l'étape dans le journal montre cette commande `dsmod` réelle.
- **Dans le `.bat`**, le script note la page de code d'origine au démarrage (`AGP_CP`, 850 en français), met le DN du groupe et la requête dans des variables tant qu'il est en UTF-8, puis exécute la recherche dans la page d'origine sur des lignes uniquement ASCII :
```
set "AGP_G=CN=GG_Compta,OU=Groupes,DC=lab,DC=local"
set "AGP_Q=dsquery user -samid jdupont -limit 1"
set "AGP_M=jdupont"
chcp %AGP_CP% >nul
(%AGP_Q% | findstr "=" >nul || (echo    Introuvable dans l'Active Directory : %AGP_M%& cmd /c exit 1)) && for /f "delims=" %%u in ('%AGP_Q%') do @dsmod group "%AGP_G%" -addmbr "%%~u"
set /a AGP_RC=%errorlevel%
chcp 65001 >nul
if %AGP_RC% neq 0 (set /a ERR+=1 & echo    ECHEC de l'étape 5.)
```
Vérifié avec de faux outils `ds*` écrivant en CP850 puis en UTF-8, DN « CN=Paul (Spé),… » : membre ajouté correctement par le `.bat` (console en 850) et par l'application (dans les deux encodages).

Pour un groupe existant, la même forme est utilisée avec `dsquery group -samid <nom>`.

Sources : [Dsmod group](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc732423(v=ws.11)) · [Dsquery user](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc725702(v=ws.11)) · [Dsquery group](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc754525(v=ws.11)) · [for](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/for)

## 4. Tests d'existence : `dsquery *`

```
dsquery * [{<NœudDeDépart> | forestroot | domainroot}] [-scope {subtree | onelevel | base}] [-filter <FiltreLDAP>] [-attr …] [-limit <N>]
```

- `-scope base` désigne « l'objet unique que représente le nœud de départ ». Par défaut la sortie est le DN.
- `domainroot` est le nœud de départ par défaut. `dsquery * domainroot -scope base` renvoie donc le DN du domaine. `detectEnvironment()` s'en sert quand l'outil est présent.
- Par défaut, `dsquery` renvoie au plus 100 résultats. `-limit 0` les renvoie tous.

Tests générés : la commande réussit (code 0 et une ligne de DN) **seulement si l'objet existe**.
```
dsquery * "OU=Compta,OU=Paris,DC=lab,DC=local" -scope base 2>nul | findstr "="
```
Appartenance déjà en place, via un filtre LDAP sur `memberOf` :
```
dsquery * "CN=GG_Compta,…" -scope base -filter "(memberOf=CN=DL_Compta_RW,…)" 2>nul | findstr "="
dsquery * domainroot -filter "(&(objectCategory=person)(objectClass=user)(sAMAccountName=jdupont)(memberOf=CN=GG_Compta,…))" 2>nul | findstr "="
```
Les valeurs placées dans un filtre sont échappées selon la RFC 4515 : `\` devient `\5c`, `*` devient `\2a`, `(` devient `\28` et `)` devient `\29`.

Sources : [Dsquery *](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc754232(v=ws.11)) · [dsget group](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc731202(v=ws.11)) (`dsget group <DN> -members [-expand]` liste les membres directs ; `-expand` les liste récursivement).

## 5. Droits NTFS : `icacls /grant`

```
icacls <nom> /grant[:r] <sid>:<perm>[...] [/T] [/C] [/L] [/Q]
```

- `/grant` **ajoute** les droits aux droits explicites existants. `/grant:r` les **remplace**. Agépédé utilise `/grant` : relancer la commande ne retire rien.
- Droits simples : `N`, `F` (contrôle total), `M` (modification), `RX` (lecture et exécution), `R`, `W`, `D`.
- Héritage, entre parenthèses : `(OI)` fichiers, `(CI)` sous-dossiers, `(IO)`, `(NP)`, `(I)`.

| Droit Agépédé | Libellé | Masque icacls |
|---|---|---|
| `R` | Lecture | `(OI)(CI)RX` |
| `RW` | Modification | `(OI)(CI)M` |
| `F` | Contrôle total | `(OI)(CI)F` |

Commande générée. Le groupe est préfixé du nom NetBIOS du domaine, et tout l'argument est entre guillemets :
```
icacls "D:\Partages\Compta" /grant "LAB\DL_Compta_RW:(OI)(CI)M"
```
Si le nom NetBIOS n'est pas renseigné, Agépédé prend la première étiquette du nom DNS en majuscules (`lab.local` donne `LAB`) et affiche un avertissement.

Les `\` finaux des chemins sont retirés. Pour un programme Windows, `"D:\Dossier\"` se lit avec un guillemet littéral (`\"`). La racine d'un lecteur (`D:\`) est refusée.

Dossier (onglet Dossiers, ou dossier d'une permission si l'option « Créer les dossiers absents » est cochée) : `if not exist "D:\Partages\Compta" mkdir "D:\Partages\Compta"`. Les dossiers de l'onglet Dossiers sont créés parents d'abord.

Source : [icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)

## 5 bis. Casser l'héritage : `icacls /inheritance:d`

```
icacls <nom> /inheritance:e|d|r
icacls <nom> /remove[:g|:d] <sid> [...]
```

- `/inheritance:d` désactive l'héritage et **recopie** les droits hérités en droits explicites : c'est le bouton « Désactiver l'héritage › Convertir les autorisations héritées » de Windows. `/inheritance:r` les supprimerait tous (administrateurs compris) : Agépédé ne l'utilise pas.
- Option « retirer Utilisateurs et Utilisateurs authentifiés » (cochée par défaut) : `/remove:g` retire leurs droits accordés, recopiés du dossier parent. Les groupes sont désignés par leur **SID** (`*S-1-5-32-545` Utilisateurs, `*S-1-5-11` Utilisateurs authentifiés), car leur nom change avec la langue du serveur. Restent Administrateurs, Système, Créateur propriétaire et les groupes DL de l'onglet Permissions.
- L'étape passe **avant** les droits AGDLP (`/grant`), qui s'ajoutent ensuite en droits explicites. Elle peut être rejouée sans effet (héritage déjà désactivé, SID absents).

Commande générée (une étape, deux commandes enchaînées par `&&`) :
```
icacls "D:\Partages\Compta" /inheritance:d && icacls "D:\Partages\Compta" /remove:g *S-1-5-32-545 *S-1-5-11
```
Il n'y a pas de test d'existence : la simulation l'indique « à appliquer ».

Sources : [icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls) · [Well-known SIDs](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers)

## 6. Règles d'imbrication (AGDLP)

D'après le tableau « Group scope » de Microsoft :

| Étendue | Membres possibles | Peut être membre de |
|---|---|---|
| **Global** | comptes **du même domaine**, autres groupes **globaux du même domaine** | universels, globaux du même domaine, domaine local |
| **Domaine local** | comptes et groupes globaux de tout domaine (approuvé), universels de la forêt, **autres domaine local du même domaine** | autres domaine local du même domaine, groupes locaux des machines du domaine |

Ce qu'Agépédé en tire, dans `validateProject` :

- Un GG qui contient un DL est une **erreur**. AD le refuse : `ERROR_DS_GLOBAL_CANT_HAVE_LOCAL_MEMBER` (8516, 0x2144).
- Un GG dans un GG est **autorisé**, mais signalé par un **avertissement** : c'est hors AGDLP strict.
- Un DL dans un DL est **autorisé**, avec un **avertissement**. Une boucle entre DL est aussi signalée.
- Un membre de DL absent du tableau donne un **avertissement** : il est supposé exister déjà dans l'AD.
- Un droit donné à un GG donne un **avertissement** : en AGDLP, les droits vont aux DL.
- Un groupe membre de lui-même est une **erreur**.

Source : [Active Directory security groups, « Group scope »](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-groups)

## 7. Noms et échappement

### Noms distinctifs (DN)
Microsoft liste les caractères réservés dans une valeur de RDN :
`,` `+` `"` `\` `<` `>` `;` `=` `/`, ainsi que l'espace ou `#` en tête, l'espace en fin, CR et LF.
- On les échappe avec `\` : `OU=Ventes\, Export`.
- CR et LF sont écrits en hexadécimal : `\0D` et `\0A`.

Source : [Distinguished Names](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ldap/distinguished-names)

### sAMAccountName (groupes, utilisateurs)
- Caractères interdits : `" / \ [ ] : ; | = , + * ? < >`. Agépédé refuse aussi `@`.
- **20 caractères au plus** pour rester compatible avec les anciens clients. L'attribut lui-même accepte jusqu'à 256 caractères.

Source : [SAM-Account-Name attribute](https://learn.microsoft.com/en-us/windows/win32/adschema/a-samaccountname)

### OU
- Aucun caractère n'est interdit par AD. La longueur va de **1 à 64 caractères**.
- AD compare les noms **sans tenir compte des accents** : « Société » et « SOCIETE » entrent en conflit. Agépédé détecte les doublons en ignorant la casse et les accents.

Source : [Name computers, domains, sites, and OUs (KB 909264)](https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/naming-conventions-for-computer-domain-site-ou)

### Règles retenues par `validateName`

| Type | Refusé | Longueur |
|---|---|---|
| toutes saisies | `"` `%` `!` `^` `&` `\|` `<` `>`, retours ligne, espaces en tête ou en fin | |
| `ou` | `/` et `\` (séparateurs de chemin) | ≤ 64 |
| `group` | caractères interdits du sAMAccountName, `@` | ≤ 64 (attribut `cn`) ; **avertissement au-delà de 20** (pré-Windows 2000) |
| `user` | idem | ≤ 20 : un nom d'ouverture de session pré-Windows 2000 ne peut pas être plus long |
| `person` (prénom, nom) | caractères de « toutes saisies » | ≤ 64 (nom affiché « Prénom Nom » aussi) |
| mot de passe (`validatePassword`) | `"` `%`, retours ligne, espaces en tête ou en fin | ≤ 127 |
| `path` | `* ? /`, chemin relatif, racine de lecteur, `.` ou `..` | ≤ 240 |
| `desc` | `"` `%` `!` | ≤ 1024 |

Sont autorisés : accents, espaces, `-`, `_`, `.` et parenthèses. Les parenthèses dans un nom de compte donnent un avertissement.

Pourquoi ces caractères sont interdits dans cmd.exe :
- `"` ferme l'argument.
- `%` et `!` développent des variables. `!` ne le fait que si l'expansion retardée est activée.
- `^ & | < >` sont des opérateurs.

## 8. Lancement, codes de retour et encodage

### Lancement depuis l'application
```
cmd.exe /d /v:off /s /c "chcp 65001>nul & <ligne>"
```
- `/d` désactive l'AutoRun. `/v:off` désactive l'expansion retardée même si le registre l'active : un `!` (mot de passe) reste littéral.
- `/s` retire seulement les guillemets externes et laisse le reste tel quel.
- La ligne est passée avec `windowsVerbatimArguments`.
- La sortie est lue en UTF-8. Si on y trouve le caractère de remplacement U+FFFD, l'outil a écrit dans la page OEM, et la sortie est décodée en **CP850** (table embarquée, vérifiée contre .NET `Encoding.GetEncoding(850)`).
- En cas de délai dépassé ou d'annulation, l'arbre de processus est tué par `taskkill /pid <pid> /t /f`.

### Classement des résultats (`classifyResult`)
Sur un serveur français, les messages sont traduits. Le classement se fait donc d'abord sur le **code de sortie** et les **codes hexadécimaux**. Le texte anglais ou français ne sert qu'en dernier recours. Un HRESULT `0x8007xxxx` correspond à l'erreur Win32 `xxxx`.

| Code | Nom | Statut Agépédé |
|---|---|---|
| `0x80071392` (5010) | ERROR_OBJECT_ALREADY_EXISTS | `exists` (déjà membre pour une étape `member`) |
| `0x80072071` (8305) | ERROR_DS_OBJ_STRING_NAME_EXISTS | `exists` |
| `0x80070562` (1378) | ERROR_MEMBER_IN_ALIAS : « déjà membre du groupe » | `exists` |
| `0x80070528` (1320) | ERROR_MEMBER_IN_GROUP | `exists` |
| `0x8007200D` (8205) | ERROR_DS_ATTRIBUTE_OR_VALUE_EXISTS | `exists` |
| `0x80072030` (8240) | ERROR_DS_NO_SUCH_OBJECT : objet introuvable | `error` |
| `0x80070524` / `0x80070526` / `0x80070563` | compte ou groupe déjà existant (nom SAM pris ailleurs) | `error` |
| `0x80072098` (8344) | ERROR_DS_INSUFF_ACCESS_RIGHTS | `error` |
| `0x8007203A` (8250) | ERROR_DS_SERVER_DOWN | `error` |
| `0x80072144` (8516) | ERROR_DS_GLOBAL_CANT_HAVE_LOCAL_MEMBER | `error` |
| `0x80070534` (1332) | ERROR_NONE_MAPPED (icacls : groupe inconnu) | `error` |
| `0x80070005` (5) | accès refusé | `error` |
| code de sortie `9009` | commande introuvable (RSAT absent) | `error` |

Autres règles :
- Le code de sortie est accepté signé (`-2147019886`) ou non signé (`2147947410`). Node renvoie la forme non signée, ce qui a été vérifié.
- Un code 0 vaut succès. Exception : un outil `ds*` qui écrit lui-même « dsadd failed: » ou « … a échoué ». On ne cherche pas le mot « Failed » seul, car icacls affiche « Failed processing 0 files » quand tout va bien.
- Une étape `group` dont le test dit « absent » mais que dsadd déclare « existe déjà » est classée **erreur** : le sAMAccountName est déjà pris ailleurs dans le domaine.

Sources : [System Error Codes 1300-1699](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1300-1699-) · [4000-5999](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--4000-5999-) · [8200-8999](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--8200-8999-)

### Script `.bat` (`toBatch`)
- `@echo off`, `setlocal DisableDelayedExpansion` (un `!` reste littéral), lecture de la page de code d'origine (`for /f "tokens=2 delims=:." %%c in ('chcp') do set /a AGP_CP=%%c`, 850 par défaut), puis `chcp 65001 >nul` **avant toute ligne accentuée**. Le fichier est enregistré en **UTF-8 sans BOM** : un BOM serait lu comme une commande sur la première ligne.
- Le script vérifie que `dsadd` est présent (`where dsadd >nul 2>&1 || (echo … & exit /b 1)`). Il prévient si l'invite n'est pas en administrateur (`net session`).
- Chaque étape s'affiche sous la forme `echo [n/N] libellé`. Vient ensuite le **test d'existence** : si l'objet existe, l'étape est comptée « déjà faite » et on passe à la suite par `goto :etape_n_fin`. Le script peut donc être relancé.
- Après chaque commande vient `if %errorlevel% neq 0 (set /a ERR+=1 & echo    ECHEC …)`. Ce test est **hors de tout bloc `( … )`**, donc sans piège d'expansion retardée. `neq 0` attrape aussi les codes **négatifs** (HRESULT), ce que `if errorlevel 1` ne fait pas. Vérifié avec `cmd /c exit -2147019886`.
- Avant `if not exist … mkdir`, la ligne `cmd /c exit 0` remet le code à zéro. Sinon, un dossier déjà présent hériterait de l'échec de l'étape précédente. Vérifié.
- La dernière ligne est `exit /b %ERR%` : le code de sortie est le nombre d'échecs. Il n'y a **pas de `pause`**, pour qu'une exécution sans surveillance soit possible.

## 9. Détection de l'environnement (`detectEnvironment`)

Toutes les commandes utilisées sont en lecture seule :

| Information | Commande | Pourquoi |
|---|---|---|
| Outils | `where dsadd dsmod dsquery dsget icacls` | une seule commande, chemins lus sur la sortie standard |
| Serveur | `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v InstallationType` | la valeur est `Server`, `Server Core` ou `Client` |
| Administrateur | `whoami /groups` | il faut le SID `S-1-5-32-544` (Administrateurs) **et** le niveau d'intégrité élevé `S-1-16-12288`, ou système `S-1-16-16384`. Les SID ne dépendent pas de la langue, et un administrateur non élevé n'a que le niveau moyen `S-1-16-8192`. À défaut, `net session` (code 0 seulement en administrateur ; dépend du service Serveur, d'où son rôle de simple repli) |
| Domaine | variables `USERDNSDOMAIN` et `USERDOMAIN`, puis `dsquery * domainroot -scope base` si l'outil est présent | « membre d'un domaine » si `USERDOMAIN` ≠ `COMPUTERNAME` |

## 10. Ce qui n'a pas pu être vérifié

Cette machine n'a ni outils AD ni domaine, donc aucune commande `ds*` n'a été lancée. Les points suivants viennent de l'expérience et de recoupements, pas d'une page Microsoft explicite :

- **Le code de sortie exact des outils `ds*` en cas d'échec.** Il n'est documenté nulle part. Le moteur accepte donc un code non nul quelconque, un HRESULT signé ou non, et en repli le texte « dsadd failed » ou « a échoué ».
- **Le format exact de la sortie de `dsquery`.** Il s'agit de DN entre guillemets, d'après l'usage courant ; la page Microsoft montre seulement que la sortie par défaut est le DN. La forme `"%~u"` fonctionne dans les deux cas.
- **Le code HRESULT exact d'un `dsmod -addmbr` sur un membre déjà présent.** Ce peut être `0x80070562` ou `0x80071392`, selon la couche qui répond. Les deux sont classés `exists`.
- **La traduction française des messages** (« dsadd a échoué : … »). Elle ne sert qu'en dernier recours.
- **`icacls /remove:g` sur un SID absent du dossier.** D'après l'usage, la commande réussit sans rien changer ; non testé ici.
- **Le code exact d'un mot de passe refusé par `dsadd user`.** `0x800708C5` d'après l'usage ; `0x8007052D` est aussi reconnu.
- **Le filtre `memberOf` dans `dsquery * -filter`.** La syntaxe LDAP est standard, mais elle n'a pas été testée sur un contrôleur de domaine. Si le test ne trouve rien, la commande est lancée et le résultat « déjà membre » est classé `exists` : il n'y a aucun risque.
