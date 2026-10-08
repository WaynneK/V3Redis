# PredF

Fusion et conversion de PDF **locales** : fusionner, organiser, découper, convertir images ↔ PDF, compresser, numéroter et marquer d'un filigrane. En option, un **Assistant IA** (API Claude d'Anthropic) qui fusionne, résume ou simplifie des documents sur simple consigne.

Les sept outils fonctionnent sans Internet : la page ne charge que le protocole interne de l'application (`predf://`), toute requête http(s)/ws de la page est annulée, et vos fichiers ne quittent pas l'ordinateur. **Seule exception : l'Assistant IA en mode Claude**, uniquement quand vous le lancez — il envoie alors les documents ajoutés et la consigne à l'API Claude d'Anthropic (depuis le processus principal), ce que l'écran rappelle clairement. En mode IA locale gratuite (Ollama), tout reste sur l'ordinateur.

## Commandes

```bash
npm install
```

```bash
npm start
```

- `npm run dev` : avec les DevTools.
- `npm test` : tests du moteur PDF et de la saisie des pages (`test/engine.test.js`, `node:test`).
- `npm run build:win` : installeur `dist/PredF-Setup-1.0.0.exe` + version portable `dist/PredF-Portable-1.0.0.exe`.
- `npm run build:linux` : AppImage (à lancer sous Linux).

## Démarrage

Écran de chargement comme SysInfo Lite et CalkIP : petite fenêtre sans bordure, au thème clair ou sombre de PredF. Le logo apparaît avec un rebond, remonte, puis le nom arrive ; la barre suit le chargement réel (préférences, vérification du moteur PDF sur un petit document, chargement de l'afficheur pdf.js). La fenêtre principale s'ouvre quand tout est prêt (2,4 s au minimum, 15 s au maximum).

## Outils

Une barre latérale, sept outils (plus l'Assistant IA, décrit plus bas). Chaque outil commence par une grande zone de dépôt ; on peut aussi **glisser des fichiers n'importe où dans la fenêtre** (s'ils ne conviennent pas à l'outil ouvert, PredF ouvre le bon), ou les ouvrir avec <kbd>Ctrl</kbd> + <kbd>O</kbd>. Rien n'est jamais écrasé : chaque résultat est enregistré là où vous le choisissez, puis un bandeau propose **Ouvrir** et **Afficher dans le dossier**.

| Outil | Ce qu'il fait |
|---|---|
| **Fusionner** | PDF et images dans l'ordre de la liste (glisser pour réordonner, tri par nom). Pour chaque PDF, une sélection de pages facultative : `1-3, 5, 8-fin`, `paires`, `impaires`, `7-2` (ordre inverse). Format et marges des pages d'images. |
| **Organiser** | Les pages en miniatures : sélection (Ctrl : plusieurs, Maj : une plage), déplacer en glissant, pivoter, dupliquer, supprimer, insérer une page blanche, inverser l'ordre, ajouter un autre PDF à la fin, annuler / rétablir (100 étapes). Enregistrer tout, ou **extraire la sélection**. Raccourcis : <kbd>R</kbd> / <kbd>Maj</kbd>+<kbd>R</kbd>, <kbd>Suppr</kbd>, <kbd>Ctrl</kbd>+<kbd>A</kbd>, <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd>, <kbd>Ctrl</kbd>+<kbd>S</kbd>. Taille des miniatures réglable. |
| **Découper** | Toutes les N pages, par plages (`1-3, 4-8, 9-fin` : un fichier par élément), une page par fichier, ou extraction de pages dans un seul fichier. Aperçu coloré : chaque page porte la couleur et le numéro du fichier qui la recevra. |
| **Images → PDF** | JPEG, PNG, WebP, GIF, BMP ; une image par page. Format A4 / A3 / A5 / Letter ou aux proportions de l'image, orientation auto / portrait / paysage, marges. Rotation par image ; les photos de téléphone sont remises à l'endroit (orientation EXIF). |
| **PDF → Images** | Chaque page en PNG ou JPEG (qualité réglable), à 72, 150 ou 300 ppp, dans le dossier choisi. Ou **le texte** du PDF : aperçu, copie, enregistrement `.txt` (UTF-8, lisible dans le Bloc-notes). Pas de reconnaissance de caractères pour les scans. |
| **Compresser** | *Sans perte* (structure réécrite, texte intact) ou *Équilibrée* / *Forte* / *Maximale* (pages redessinées en JPEG à 150 / 110 / 72 ppp : fort gain sur les scans, texte non sélectionnable). Avant / après comparés avant d'enregistrer ; PredF prévient si le résultat est plus lourd. |
| **Finitions** | Numéros de page (6 positions, 5 formats dont « Page 1 sur 12 », numéro de départ, taille, sans numéro sur la couverture), filigrane (texte, couleur, taille, diagonale ou horizontal, opacité), propriétés (titre, auteur, sujet, mots-clés, ou tout effacer). **Aperçu en direct** de n'importe quelle page. Les pages pivotées sont gérées : numéros et filigrane restent droits. |

### Assistant IA

Demandez en langage courant ce qu'il faut faire de vos documents, comme à une personne : « Fusionne ces deux rapports, simplifie le langage et termine par un tableau des actions ». Exemples prêts à l'emploi : Fusionner, Résumer, Simplifier, Points clés, Comparer, Traduire.

Deux moteurs au choix, en haut de l'écran :

| | **IA locale (gratuite)** | **Claude (Anthropic)** |
|---|---|---|
| Prix | Gratuit | Payant (clé API) |
| Compte | Aucun | Compte Anthropic |
| Internet | Non (après le téléchargement du modèle) | Oui |
| Vos documents | Restent sur l'ordinateur | Envoyés à l'API Anthropic |
| Lecture | Texte des PDF (les scans ne sont pas lus) ; images si le modèle sait les lire | PDF complets (texte, tableaux, scans, images) |
| Qualité | Bonne pour résumer, simplifier, fusionner des textes courts | La meilleure, y compris sur de longs documents |

Sans clé Anthropic, PredF propose directement l'IA locale.

#### IA locale gratuite (Ollama)

1. Installer [Ollama](https://ollama.com/download) (gratuit) — bouton « Télécharger Ollama » dans PredF ;
2. le lancer : PredF le détecte tout seul (vérification toutes les 4 s) ;
3. télécharger un modèle depuis PredF, une seule fois, avec barre de progression : **Qwen 2.5 7B** (recommandé, très bon en français, ≈ 4,7 Go), **Mistral 7B** (≈ 4,1 Go) ou **Llama 3.2 3B** (léger, ≈ 2 Go). Les modèles déjà installés dans Ollama sont aussi proposés.

Le texte des PDF est extrait par PredF (pdf.js) et envoyé au serveur Ollama de l'ordinateur (127.0.0.1 uniquement). Le contexte du modèle est agrandi selon la taille des documents (jusqu'à 32 000 jetons, soit environ 80 pages de texte) ; au-delà, PredF prévient au lieu de couper les documents en silence.

#### Claude

- **Clé API** : à créer sur console.anthropic.com puis à coller une fois dans PredF ; elle est chiffrée avec le coffre du système (DPAPI sous Windows) et peut être modifiée ou supprimée à tout moment. L'utilisation est facturée sur votre compte Anthropic.
- **Modèles** : Claude Opus 5.5 (par défaut, meilleure qualité), Claude Sonnet 5.5 (plus rapide), Claude Haiku 5.5 (économique).
- **Lecture complète** : les PDF sont envoyés tels quels (texte, tableaux, images, mise en page), ainsi que les images ; jusqu'à 600 pages par PDF et 31 Mo par demande.
- **Écriture en direct** : le document apparaît au fil de la rédaction, comme une page ; bouton **Arrêter** à tout moment.
- **Résultat** : **Enregistrer en PDF** (mise en page soignée : titres, listes, tableaux, citations, numéros de page, police du système pour tous les caractères), Markdown (.md) ou copie du texte.
- Consigne de l'IA : ne rien inventer, garder exacts chiffres, dates et noms, signaler les contradictions entre documents, écrire dans la langue demandée.

Limites assumées : les PDF chiffrés (mot de passe ou restrictions) sont refusés avec un message clair ; la conversion vers Word / Excel n'est pas proposée (impossible à faire correctement sans service en ligne).

## Arborescence

```
PredF/
├── package.json          # scripts, dépendances (pdf-lib, pdfjs-dist), configuration electron-builder
├── main.js               # processus principal : protocole predf://, écran de chargement, fichiers, IPC
├── preload.js            # pont contextBridge minimal (window.predf)
├── preload-splash.js     # pont de l'écran de chargement
├── lib/engine.js         # moteur PDF (pdf-lib) : construire, fusionner, images, compression, finitions
├── lib/ranges.js         # saisie des pages (partagée page / processus principal)
├── lib/ai.js             # Assistant IA : clé chiffrée, requête à l'API Claude en streaming
├── lib/localai.js        # Assistant IA : IA locale gratuite via Ollama (état, téléchargement, rédaction)
├── lib/markdown.js       # lecture du Markdown produit par l'IA (aperçu et PDF)
├── lib/mdpdf.js          # mise en page Markdown → PDF
├── test/                 # tests (node:test) : engine.test.js, assistant.test.js
├── build/icon.png        # icône de l'application
└── renderer/
    ├── index.html        # page (CSP stricte, hors ligne)
    ├── styles.css        # thème clair / sombre (polices système)
    ├── splash.*          # écran de chargement
    └── js/
        ├── app.js        # barre latérale, dépôt de fichiers, raccourcis, thème
        ├── core.js       # utilitaires d'interface
        ├── components.js # zone de dépôt, en-tête de document, champs
        ├── pdfview.js    # affichage pdf.js : miniatures, rendu en image, texte
        └── tools/        # un module par outil
```

Sécurité : `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP stricte, émetteur IPC vérifié, aucun `innerHTML`. La page n'accède pas au disque : elle désigne les fichiers par un identifiant ; seul le processus principal lit les fichiers choisis ou déposés et n'écrit que là où l'utilisateur l'a demandé (écriture via un fichier temporaire, jamais d'écrasement silencieux dans un dossier d'export).
