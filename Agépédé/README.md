# Agépédé

**Agépédé** (jeu de mots sur **AGDLP**) crée dans Active Directory, à partir de simples tableaux :

- les **unités d'organisation** (OU), y compris imbriquées ;
- les **groupes globaux** (GG) et leurs membres (comptes utilisateurs) ;
- les **groupes domaine local** (DL) et leurs membres (groupes globaux) ;
- les **permissions NTFS** données aux DL sur les dossiers partagés (et, en option, les dossiers absents).

Tout passe par les commandes classiques de l'invite de commandes Windows : `dsadd`, `dsmod`, `dsquery`, `icacls`.
Le script CMD complet est affiché avant toute action ; il peut être copié, exporté en `.bat`, simulé ou exécuté
directement depuis l'application.

## Rappel AGDLP

1. **A**ccounts : les comptes utilisateurs…
2. … sont membres de groupes **G**lobaux (GG), un par rôle ou service (`GG_Compta`).
3. Les GG sont membres de groupes **D**omaine **L**ocal (DL), un par ressource et par niveau d'accès (`DL_Compta_R`, `DL_Compta_RW`).
4. Les **P**ermissions NTFS ne sont données qu'aux DL, jamais directement aux utilisateurs.
5. Donner un accès = ajouter l'utilisateur au bon GG ; nouveau dossier = créer ses DL et ses permissions.
6. Les OU rangent les objets dans l'annuaire, elles ne donnent aucun droit.

## Prérequis pour la simulation et l'exécution

- **Windows Server 2016 ou plus récent** (contrôleur de domaine), ou **Windows 10 / 11 joint au domaine avec RSAT**
  « Outils AD DS » (fonctionnalité facultative *RSAT: Active Directory Domain Services and Lightweight Directory Services Tools*),
  qui fournit `dsadd`, `dsmod`, `dsquery`.
- Lancer Agépédé **en administrateur**, avec un compte autorisé à créer des objets dans l'annuaire (Admins du domaine
  ou délégation sur les OU concernées). `icacls` agit sur la machine qui exécute : chemins locaux de ce serveur ou chemins UNC.
  Dans la barre du domaine, la pastille « Administrateur : non » propose **« relancer en administrateur »** : Agépédé se
  rouvre avec les droits administrateur (fenêtre de contrôle de compte Windows) et reprend le projet en cours, même non
  enregistré. La case **« Toujours démarrer en administrateur »** demande l'élévation à chaque lancement (si elle est
  refusée, Agépédé s'ouvre quand même, sans droits). Relance via `powershell Start-Process -Verb RunAs` (`lib/elevation.js`).
- Sans ces outils (ou hors domaine), tout le reste fonctionne : saisie, vérification, aperçu et export du script `.bat`
  pour le lancer ailleurs. Les boutons « Simulation » et « Exécuter sur l'AD » sont alors désactivés avec l'explication.

## Prise en main

- **Visite guidée au premier lancement** : une bulle présente chaque zone de l'écran (domaine, état du poste, onglets,
  saisie en tableau, import CSV, raccourci DL, vérification, script, simulation / exécution, aide) en éclairant
  l'élément concerné. Précédent / Suivant (ou ← →), « Passer » ou Échap pour la quitter. Elle n'est proposée qu'une fois.
- **Bouton « Aide »** (ou F1) : guide illustré intégré à l'application, avec des **captures annotées** (repères
  numérotés et légendes ; survoler une légende met son repère en évidence), en thème clair ou sombre selon Windows :
  prise en main, domaine et poste, saisie des tableaux, vérification et exécution, AGDLP en bref, raccourcis et dépannage.
  On peut y **revoir la visite guidée** et **charger un projet d'exemple** (lab.local : 4 OU, 3 GG, 3 DL, 3 permissions).
- Les captures sont produites par `npm run guide:captures` (`scripts/capture-guide.js`) : l'application est ouverte
  avec l'exemple sur un environnement simulé (aucune commande lancée) et chaque repère est placé d'après la position
  réelle de l'élément. À relancer après une modification de l'interface.

## Utilisation

1. **Domaine** : nom DNS (`lab.local`) ; le DN (`DC=lab,DC=local`) et le nom NetBIOS (`LAB`) sont calculés et restent modifiables.
   « Détecter » lit le domaine de la machine et vérifie les outils AD, les droits administrateur et le type de Windows.
2. **Onglets OU, GG, DL, Permissions** : une ligne par objet. La ligne vide du bas devient une vraie ligne dès qu'on y tape.
   - Entrée / Maj+Entrée : ligne suivante / précédente, Tab : cellule suivante, Ctrl+Suppr : supprimer la ligne.
   - **Coller depuis Excel** : un bloc de cellules copié (lignes et colonnes) remplit le tableau à partir de la cellule active ;
     une ligne d'en-têtes copiée avec le bloc est ignorée.
   - Les erreurs et avertissements sont surlignés en direct dans les cellules (message en info-bulle).
   - Onglet DL : « Créer les DL pour un GG » ajoute `DL_<Nom>_R` et `DL_<Nom>_RW` contenant ce GG.
3. **Script & exécution** : liste des erreurs (bloquantes) et avertissements — un clic mène à la cellule —, aperçu du script,
   « Copier », « Exporter .bat », « Simulation » (indique ce qui existe déjà, sans rien modifier), « Exécuter sur l'AD »
   (confirmation avec le domaine et le nombre d'OU, de groupes, d'appartenances et de permissions), « Arrêter »,
   journal détaillé (cliquer une ligne pour voir la commande et sa sortie) et « Exporter le journal ».
4. **Projet** : Nouveau, Ouvrir, Enregistrer, Enregistrer sous (fichier `.agepede.json`). Un brouillon est conservé
   automatiquement et restauré au démarrage ; la fermeture avec des modifications non enregistrées demande confirmation.

Raccourcis : Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Maj+S, Ctrl+1 à Ctrl+5 (onglets), F1 (aide).

## Formats CSV

Import et export par tableau (boutons « Importer CSV… » / « Exporter CSV… »). Séparateur `;` (Excel en français) ;
à l'import, `;`, `,` ou la tabulation sont détectés. Export en UTF-8 avec BOM ; import en UTF-8 ou Windows-1252
(CSV enregistré par Excel). La première ligne d'en-têtes est reconnue et ignorée.

| Tableau | Colonnes (dans cet ordre) |
| --- | --- |
| OU | `Nom;OU parente;Description` — OU parente vide = racine du domaine, sinon chemin `Paris/Compta` |
| Groupes globaux | `Nom;OU;Description;Membres (utilisateurs)` — OU vide = conteneur `CN=Users` ; membres = sAMAccountName séparés par des virgules |
| Groupes domaine local | `Nom;OU;Description;Membres (groupes globaux)` |
| Permissions | `Dossier;Groupe DL;Droit (R, RW, F)` — `R` Lecture (RX), `RW` Modification (M), `F` Contrôle total ; les libellés français sont acceptés |

Exemple (OU) :

```csv
Nom;OU parente;Description
Paris;;Site de Paris
Compta;Paris;Service comptable
```

## Commandes générées

Référence complète, syntaxe vérifiée et sources : [docs/COMMANDES.md](docs/COMMANDES.md). Formes utilisées :

```bat
rem OU (les parents d'abord)
dsadd ou "OU=Compta,OU=Paris,DC=lab,DC=local" -desc "Service comptable"
rem Groupe global (-scope g) ou domaine local (-scope l), groupe de sécurité
dsadd group "CN=GG_Compta,OU=Compta,OU=Paris,DC=lab,DC=local" -secgrp yes -scope g -samid GG_Compta -desc "Comptables"
rem Membre décrit dans les tableaux : par son DN
dsmod group "CN=DL_Compta_RW,OU=Compta,OU=Paris,DC=lab,DC=local" -addmbr "CN=GG_Compta,OU=Compta,OU=Paris,DC=lab,DC=local"
rem Membre existant dans l'AD (utilisateur) : recherché par son sAMAccountName, puis ajouté par son DN
(dsquery user -samid jdupont -limit 1 | findstr "=" >nul || (echo    Introuvable ...& cmd /c exit 1)) && for /f "delims=" %%u in ('dsquery user -samid jdupont -limit 1') do @dsmod group "CN=GG_Compta,..." -addmbr "%%~u"
rem Dossier (option « Créer les dossiers absents »)
if not exist "D:\Partages\Compta" mkdir "D:\Partages\Compta"
rem Permission NTFS héritée par les sous-dossiers et fichiers
icacls "D:\Partages\Compta" /grant "LAB\DL_Compta_RW:(OI)(CI)M"
```

Avant chaque création, un test d'existence en lecture seule (`dsquery * "<DN>" -scope base`) permet d'ignorer ce qui
existe déjà : le script peut être relancé sans risque. Le `.bat` exporté est en UTF-8 sans BOM avec `chcp 65001`
(accents corrects dans cmd.exe) et renvoie en code de sortie le nombre d'étapes en échec. Pour un membre recherché
par son identifiant, l'application lance elle-même la recherche `dsquery` puis `dsmod` avec le DN trouvé, et le `.bat`
fait la recherche dans la page de code d'origine de la console : un DN accentué arrive intact (détails dans
[docs/COMMANDES.md](docs/COMMANDES.md)).

## Sécurité

- **Rien n'est jamais supprimé ni modifié** : Agépédé crée des objets et ajoute des membres ou des droits, c'est tout
  (aucun `dsrm`, `dsmove`, `icacls /remove` ou `/reset`).
- **Le script affiché est le script exécuté** : pour exécuter, l'interface envoie le projet ; le processus principal le
  revérifie et régénère lui-même les commandes avec le même moteur (`lib/agdlp.js`) — il refuse s'il reste une erreur.
  Seule nuance : pour un membre recherché par son identifiant, la recherche `dsquery` et le `dsmod` du script sont
  lancés l'un après l'autre (sans `for /f`), le `dsmod` réel figurant dans le journal.
- Les noms sont vérifiés avant d'entrer dans une ligne de commande : les caractères interprétés par cmd.exe
  (`" % ! ^ & | < >`) sont refusés, les DN sont échappés.
- Confirmation native avant toute exécution réelle ; une seule exécution à la fois ; arrêt possible à tout moment
  (les commandes déjà passées ne sont pas annulées).
- Application locale : aucune connexion réseau depuis l'interface (CSP stricte, isolation de contexte, sandbox),
  écritures de fichiers atomiques, un fichier existant n'est remplacé que s'il a été choisi dans une boîte de dialogue.

## Développement

```powershell
npm install
npm start            # lancer l'application
npm run dev          # avec les outils de développement
npm test             # tests du moteur et de l'exécuteur (node --test)
npm run build:dir    # application non empaquetée : dist\win-unpacked\Agepede.exe
npm run build:win    # installeur NSIS (Agepede-Setup-<version>.exe) et version portable (Agepede-Portable-<version>.exe)
npm run build:linux  # AppImage (Agepede-<version>-x86_64.AppImage)
```

Installation par utilisateur (NSIS) : `%LOCALAPPDATA%\Programs\Agepede\Agepede.exe`, nom affiché dans
« Applications installées » : `Agépédé <version>`.

Mode de test du déroulement de l'exécution (développement uniquement, ignoré par l'application installée) :
`$env:AGEPEDE_FAKE_RUN = '1'; npm start` — la simulation et l'exécution produisent des résultats fictifs, aucune
commande n'est lancée.

Structure :

```
main.js               processus principal : fenêtres, fichiers, détection, exécution (via lib/runner.js)
preload.js            pont minimal page ↔ processus principal
preload-splash.js     écran de démarrage
lib/agdlp.js          moteur : validation, plan des commandes, script .bat, CSV (sans dépendance, partagé avec la page)
lib/runner.js         exécution des commandes (cmd.exe), détection de l'environnement
renderer/             interface (index.html, styles.css, js/grid.js, js/app.js, splash.*)
docs/COMMANDES.md     référence des commandes
test/                 tests node --test
```
