# HUB

Point d'entrée vers les applications : **SysInfo Lite**, **CalkIP**, **PredF** (fusion et conversion de PDF),
**Agépédé** (OU et groupes Active Directory en AGDLP, pour Windows Server) et **Cours** (résumés de la formation :
M.Julia et A.Julia).

Ajouter une application plus tard : son projet dans un dossier voisin (ex. `..\PredF`), une entrée dans `apps.js` avec `status: 'soon'` (affichée « Bientôt disponible »), puis `'available'` quand elle est prête. La détection, le lancement et l'installeur la prennent alors en compte sans autre changement.

## Interface

- **Fenêtre sans cadre** : l'en-tête sert de barre de titre (glisser pour déplacer), avec des boutons réduire / fermer assortis à l'interface (fermer en rouge au survol). Pas d'agrandissement ; la fenêtre reste redimensionnable par ses bords.
- **Sombre, ciel étoilé animé** (`renderer/stars.js`, canvas) : 3 profondeurs d'étoiles en parallaxe avec la souris, scintillement, étoiles filantes, nébuleuse teintée par la couleur de l'application choisie, effet « hyperespace » au lancement. Animation en pause quand la fenêtre est cachée ; image fixe si le système demande de réduire les animations.
- **Sélecteur interactif** : toutes les applications sont affichées côte à côte dans des boîtes (icône, accroche, état). Au survol, la boîte se soulève, s'incline et reflète la lumière sous la souris, avec une bordure à la couleur de l'application ; un **clic** la choisit (coche, panneau de détails, couleur du fond), un **double-clic** ou **Entrée** la lance. Touches 1–9 : accès direct ; Tab : navigation au clavier.
- **Lancement** (bouton « Lancer », double-clic ou Entrée) :
  1. **l'animation se joue en entier d'abord (2,2 s)** : saut en hyperespace maintenu, l'en-tête, les boîtes et le panneau se retirent, l'icône de l'application s'envole vers le centre, anneaux de lumière et particules en orbite, « Préparation de… » avec une barre qui se remplit ;
  2. **à la fin seulement**, éclair, « Lancement de… » et démarrage de l'application ;
  3. la scène s'éloigne, V3Redis s'efface en fondu et disparaît, puis **se ferme** dès que la fenêtre de l'application est affichée (Windows : surveillance de la fenêtre du processus, 12 s au plus). L'application lancée est un processus indépendant : elle reste ouverte ;
  4. en cas d'échec, la scène l'indique puis l'interface revient, et V3Redis reste ouvert.

  Si l'application était déjà ouverte, sa fenêtre existante passe au premier plan (une seule instance par application).
- **V3Redis Light** (PC peu puissants) : même application, même paquet et mêmes mises à jour, mais **fenêtre
  classique** (cadre et barre de titre du système, agrandissable), interface **plate et carrée** (liste des
  applications à gauche, détails à droite), **aucun effet** : ni ciel étoilé (aucune boucle d'animation), ni 3D, ni
  flou, ni ombre, ni animation de lancement — l'application démarre et V3Redis disparaît aussitôt.
  - Bouton **« Mode Light » / « Mode complet »** en haut : la fenêtre se recrée dans l'autre mode, le choix est mémorisé
    (`settings.json`, clé `mode`).
  - Raccourci **Menu Démarrer > V3Redis > V3Redis Light** (argument `--light` ; `--full` force le mode complet).
  - Sans choix enregistré, un PC de **4 Go de mémoire ou moins, ou 2 cœurs ou moins**, s'ouvre en Light d'office
    (message à l'ouverture). Règles dans `mode.js`, styles en fin de `renderer/styles.css` (`html.light`).
- **Casse-brique, édition ASCII** (caché, pour passer le temps) : **5 clics rapides** sur le bouton « Actualiser » l'ouvrent
  par-dessus le HUB (`renderer/breakout.js`). Tout en texte (briques `[===]`, briques solides `[###]`, raquette
  `<=======>`, balle `o`), niveaux de plus en plus durs, 3 vies, record mémorisé. ← → ou la souris, Espace pour lancer
  ou mettre en pause, R pour rejouer, Échap pour quitter. Le jeu garde le clavier (Entrée ne lance pas d'application)
  et se met en pause si la fenêtre perd le focus ; il tourne aussi en V3Redis Light.
- **Panneau de détails** : description, points forts, emplacement détecté, bouton principal (Lancer / Installer / Télécharger) et actions secondaires (emplacement manuel, détection automatique).
- Icône, accroche, couleur et points forts de chaque application : `apps.js` (icônes SVG dans `renderer/assets/apps/`).

## Commandes

```bash
npm install
```

```bash
npm start
```

- `npm run dev` : avec les DevTools.
- `npm run build` : **installeur Windows « tout en un »** `dist/V3Redis-Setup-x.y.z.exe` = V3Redis + SysInfo Lite + CalkIP + PredF + Agépédé (`scripts/build-setup.js`) :
  1. compile chaque application disponible dans son projet voisin (`..\SysInfoLite`, `..\CalkIP`, `..\PredF`, `..\Agépédé`, qui doivent avoir leurs `node_modules`) ;
  2. les copie dans `bundle\<id>\` avec un marqueur `hub-bundle.json` (SysInfo Lite désactive alors sa propre mise à jour : elles arrivent avec le HUB) ;
  3. génère `build\installer.nsh` : page « Applications » (choix des applications), raccourcis **Menu Démarrer > V3Redis > SysInfo Lite / CalkIP / PredF / Agépédé** (fichier en UTF-8 avec BOM pour les accents), supprimés à la désinstallation ;
  4. construit l'installeur ; les applications sont installées dans `<HUB>\resources\apps\<id>\` ;
  5. crée un paquet `.zip` par application et leur liste `.json` (installation depuis le HUB, voir plus bas).
- **Apparence de l'installeur** (design « Hyperespace ») : installeur en français avec page d'accueil et page de fin à
  fond sombre, volet `build/installerSidebar.bmp` (164 × 314) et bandeau `build/installerHeader.bmp` (150 × 57) sur les
  autres pages ; textes et liste des applications générés par `scripts/installer-nsh.js`. Les images se régénèrent
  depuis leurs sources `build/art/*.svg` avec `npm run installer:art`. La barre de titre et les boutons restent ceux de Windows.
- `npm run build:skip-apps` : même chose sans recompiler les applications (réutilise leur `dist\win-unpacked`).
- `npm run build:hub-only` : installeur du HUB seul.

Taille : ~600 Mo avec les quatre applications, car chaque application embarque son propre moteur Electron. Si une application est aussi installée séparément, le HUB lance la plus récente des deux.

## Applications à la carte (Windows)

- **À l'installation** : page **« Applications »** (après l'accueil), une case par application avec sa taille, toutes
  cochées la première fois. Les applications décochées sont retirées juste après l'extraction (pas de raccourci).
  V3Redis lui-même est toujours installé.
- **Choix mémorisé** dans `HKCU\Software\V3Redis\Applications` (`<id>` = `"1"` ou `"0"`) : une réinstallation repart du
  choix précédent, et les **mises à jour silencieuses le respectent** (une application retirée ne revient pas). Il est
  effacé par une vraie désinstallation de V3Redis.
- **Plus tard, dans le HUB** : une application absente propose **« Installer <nom> »** ; une application livrée avec
  V3Redis propose **« Désinstaller »** (après confirmation ; refusé si elle est ouverte). L'installation télécharge le
  paquet de l'application **dans la release de la version installée** (`V3Redis-X.Y.Z-app-<id>-win-x64.zip`, liste
  `V3Redis-X.Y.Z-apps-win-x64.json`) : mêmes fichiers que l'installeur, taille et empreinte SHA-512 vérifiées, puis
  extraction dans `resources\apps\<id>\`. Le registre et le raccourci du menu Démarrer sont mis à jour comme par
  l'installeur.
- **En arrière-plan** : pendant l'installation, le HUB reste utilisable (autres applications, lancement). Une seule
  **barre de progression** couvre téléchargement puis extraction (taille extraite mesurée en continu ; la liste donne
  `unpacked`), sur la boîte de l'application (« Installation 42 % ») et dans ses détails (pourcentage, Mo, « Annuler »
  pendant le téléchargement). À la fin, la détection est refaite : l'application est **prête à lancer sans
  redémarrer**. Si on lance une autre application ou qu'on ferme la fenêtre, V3Redis termine l'installation caché
  avant de se fermer ; une fenêtre recréée (passage en mode Light) reprend la barre en cours. Code : `app-manager.js` (HUB), `app-packs.js` (noms, vérifications),
  `scripts/installer-nsh.js` (page de l'installeur), `scripts/build-setup.js` (création des .zip et de la liste).
- **Linux et macOS** : le paquet (AppImage, .app signée) est en lecture seule ; toutes les applications y restent.
- **Tester sans GitHub** : `HUB_BUNDLE_DIR=<dossier vide> V3REDIS_APPS_URL=http://127.0.0.1:<port>/ npm start`, avec un
  serveur local qui sert la liste et les .zip (le registre et le menu Démarrer ne sont pas modifiés en développement).

## Mises à jour : un seul paquet

V3Redis et les applications livrées avec lui (SysInfo Lite, CalkIP, PredF, Agépédé) se mettent à jour **ensemble** :
une nouvelle version de V3Redis contient les nouvelles versions des applications (`resources\apps\`). Les applications
livrées ne cherchent pas de mise à jour de leur côté (SysInfo Lite le détecte grâce à `hub-bundle.json`).

**Côté utilisateur** (`updater.js`, bibliothèque `electron-updater`) :

- vérification au démarrage puis toutes les 4 h sur les releases GitHub de **WaynneK/V3Redis** ;
- pastille en haut à droite : `v0.2.0` (à jour) → « Mise à jour 42 % » pendant le téléchargement → **« Installer v0.2.1 »** ;
- téléchargement en arrière-plan, **différentiel** grâce au `.blockmap` (seuls les blocs modifiés), empreinte SHA-512 vérifiée ;
- un clic sur la pastille ouvre le panneau : état, nouveautés de la release, contenu du paquet installé, « Rechercher
  maintenant », **« Installer et redémarrer »** (installation silencieuse dans le même dossier puis relance, réglages conservés) ;
- l'installation n'a lieu que sur demande, jamais à la fermeture : V3Redis se ferme juste après avoir lancé une
  application, et une application ouverte ne peut pas être remplacée. Si une application livrée est ouverte,
  V3Redis demande de la fermer d'abord ;
- si une application est lancée pendant un téléchargement, V3Redis (caché) le termine avant de se fermer ;
- V3Redis installé avant la 0.2.0 n'a pas ce système : installer une fois la 0.2.0 à la main.

**Selon le système** :

| | Paquet | Applications livrées | Mise à jour |
|---|---|---|---|
| Windows | installeur NSIS (`V3Redis-Setup-X.Y.Z.exe`) | `resources\apps\<id>\` (dossiers « win-unpacked ») | automatique (`latest.yml`) |
| Linux | AppImage (`V3Redis-X.Y.Z-x86_64.AppImage`) | `resources/apps/<id>/` (dossiers « linux-unpacked ») | automatique (`latest-linux.yml`) |
| macOS | image disque (`V3Redis-X.Y.Z-arm64.dmg` / `-x64.dmg`) | `V3Redis.app/Contents/Resources/apps/<id>/<Nom>.app` | signalée : page de la release ouverte |

- **Linux** : une application livrée vit dans le système de fichiers monté par l'AppImage de V3Redis, qui disparaît
  quand V3Redis se ferme. Après un lancement, V3Redis reste donc ouvert, caché, tant que l'application tourne.
- **macOS** : sans compte développeur Apple, les paquets ont une signature locale (« ad hoc ») ; la mise à jour
  automatique, qui exige une vraie signature, est remplacée par un lien vers la nouvelle version.
- Les chemins propres à chaque système sont dans `platforms.js` (exécutable Linux et nom du paquet .app : `apps.js`).

**Publier une mise à jour** (procédure complète : `README.md` à la racine du dépôt) :

1. Augmenter la version dans `package.json` (ex. `0.13.1`) et, si besoin, celles des applications modifiées ; pousser.
2. GitHub › **Actions** › **Release** › **Run workflow** (`.github/workflows/release.yml`) : paquets Linux et macOS
   déposés dans la release brouillon `v0.13.1`.
3. Windows (SysInfo Lite n'est disponible que sur le PC) : `npm run build`, puis ajouter à la release
   `dist\V3Redis-Setup-0.13.1.exe`, son `.blockmap`, `dist\latest.yml`, les paquets `dist\V3Redis-0.13.1-app-<id>-win-x64.zip`
   et leur liste `dist\V3Redis-0.13.1-apps-win-x64.json` (installation d'une application depuis le HUB).
4. Notes de version (affichées dans V3Redis) puis *Publish release*. Une release en brouillon ou « pre-release »
   n'est pas proposée aux V3Redis installés.

**Tester sans GitHub** : `V3REDIS_UPDATE_URL=http://127.0.0.1:<port>/ npm start` avec un serveur local qui sert
`latest.yml` et l'installeur ; la vérification et le téléchargement fonctionnent, l'installation est refusée (mode test).

## Fonctionnement

- Le catalogue est dans `apps.js` : ajouter une application = ajouter une entrée (nom, description, état `available` ou `soon`, page de téléchargement, comment la retrouver sous Windows / Linux).
- Pour chaque application, le HUB détecte si elle est installée, dans cet ordre :
  1. emplacement choisi à la main (« Déjà installé ailleurs ? Choisir… »), mémorisé dans `settings.json` du dossier utilisateur ;
  2. **Windows** : « Applications installées » (registre, clés écrites par l'installeur), qui donne aussi la version ; **Linux** : AppImage dans `~/Applications`, `~/Bureau`, `~/Desktop`, `~/Téléchargements`, `~/Downloads`, `~/.local/bin` (et un niveau de sous-dossiers) ;
  3. **Windows** : dossier par défaut de l'installeur (`%LOCALAPPDATA%\Programs\<Nom>`) ;
  4. **version compilée dans le dossier du projet voisin** (même dossier parent que le HUB, ex. `..\CalkIP\dist\win-unpacked\CalkIP.exe` ou la version portable) : affichée « Prêt à lancer ». Si l'installeur compilé est présent (`..\CalkIP\dist\CalkIP-Setup-x.y.z.exe`), un bouton **Installer** le lance. Le HUB refait la détection quand on revient dans sa fenêtre. HUB empaqueté : indiquer le dossier des projets dans la variable d'environnement `HUB_PROJECTS_DIR`.
- **Lancer** démarre l'application dans un processus indépendant : elle reste ouverte si le HUB est fermé.
- **Télécharger** ouvre la page de la dernière release GitHub de l'application (seuls les liens du catalogue peuvent être ouverts).

## Arborescence

```
V3Redis/
├── package.json     # dépendances, scripts, configuration electron-builder
├── main.js          # processus principal : détection, lancement, IPC
├── preload.js       # pont contextBridge minimal (window.hub)
├── apps.js          # catalogue des applications
└── renderer/
    ├── index.html   # page (CSP stricte)
    └── app.js       # liste des applications et actions
```

Sécurité : `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP stricte, émetteur IPC vérifié, aucun `innerHTML`, lancement des exécutables sans shell.
