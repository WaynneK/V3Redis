# Cours

Les **résumés PDF des cours de la formation**, classés par partie. Application de la suite V3Redis (lancée depuis le
HUB, ou seule), 100 % locale : aucune connexion.

| Partie | Description | Dossier des PDF |
|---|---|---|
| **M.Julia** | IP, Windows Server, Connexion | `pdfs/m-julia/` |
| **A.Julia** | Hardware : carte mère, CPU, GPU… | `pdfs/a-julia/` |
| **Microsoft Office** | Word, Excel, PowerPoint, Outlook | `pdfs/office/` |

## Interface

Interface « compacte » :

- **Barre de gauche** : accueil, puis une **pastille par partie** (MJ, AJ, MO). Touches **1**, **2**, **3** : ouvrir une partie.
  Le cours choisi dans chaque partie est gardé.
- **Accueil** : uniquement les **nouveautés de la dernière mise à jour** (`lib/changelog.js` ; les versions
  précédentes en dessous, repliées). Les parties s'ouvrent depuis la barre de gauche. À chaque mise à jour, ajouter
  une entrée en tête de `lib/changelog.js` avec la version de `package.json` (vérifié par `npm test`).
- **Partie** : la **liste des cours** (un PDF = un cours : statut, titre, pages, date ; **↑ ↓** pour changer, filtre
  au-delà de 3 cours), puis le **cours sélectionné** : grand **aperçu de la première page**, **titre**,
  **description** et les boutons :
  - **Visionner** (ou clic sur l'aperçu) : visionneuse PDF dans sa fenêtre (zoom, recherche, impression) ;
  - **Télécharger** : enregistre une copie du PDF où l'on veut (Téléchargements par défaut) ;
  - **Marquer comme lu** / **À réviser** : statut du cours (point de couleur dans la liste). Un cours ouvert sans
    statut passe **En cours**.

  Trois onglets :
  - **Informations** : auteur, taille (Ko / Mo et octets), pages, version PDF, langue, dates de création /
    modification (si le PDF les contient), date d'ajout, logiciel qui l'a produit, nom du fichier ;
  - **Sommaire** : les **signets du PDF** (parties A, B, C… et leurs sections A1, A2…) ; un clic ouvre la
    visionneuse **à la bonne page** ;
  - **Mes notes** : texte libre, enregistré pendant la saisie.

  Statuts et notes sont gardés sur ce PC.
- **Recherche** (**Ctrl+K**) dans les titres, descriptions et auteurs de toutes les parties (accents et majuscules
  ignorés). Un clic sur le nom de la partie d'un résultat l'affiche dans sa partie. **Échap** : retour.
- Thème système / clair / sombre. Aperçus, informations et sommaires sont lus une fois (pdf.js) puis gardés tant que
  le PDF ne change pas. Pour avoir un sommaire, le PDF doit contenir des signets (exports Word / LibreOffice avec
  « créer des signets », WeasyPrint…).

## Ajouter un cours en dossier (plusieurs fichiers + condensé)

Un cours peut rassembler plusieurs fichiers : un dossier dans la partie, avec ses PDF et ses photos, et un
sous-dossier `Condensé` pour le PDF qui résume tout le cours.

```
pdfs/a-julia/Alimentation/
  ALIMENTATION.pdf, courant alternatif.pdf, … (PDF du cours)
  classification alimentations 80.PNG, …       (photos : PNG, JPG, GIF, WebP, BMP)
  Condensé/Architecture_et_Electricite - Mohssine.pdf
```

- Dans l'application : le cours affiche l'aperçu du condensé, un bouton **Condensé** (visionneuse) et l'onglet
  **Fichiers** (tous les fichiers : aperçu, ouverture, téléchargement). Sans condensé, le premier PDF le remplace.
- L'auteur du condensé est tiré de son nom : `Sujet - Auteur.pdf`.
- Informations dans `lib/content.js` (liste `documents` de la partie) :

  ```js
  { folder: 'Alimentation', title: 'Alimentation', date: '2026-10-05', description: '…',
    files: { 'ALIMENTATION.pdf': 'Alimentation à découpage', 'classification alimentations 80.PNG': 'Normes 80 Plus' } }
  ```

  `date` (jour du cours) range les cours dans l'ordre chronologique ; `files` donne un titre lisible à chaque fichier ;
  `icon` choisit sa vignette (`alimentation`, `cpu`, `carte-mere`, `chipset`, `bios`, `disque`, `codage`, `document`).
- Un cours déclaré dans `content.js` sans fichier est affiché **« À venir »** (vignette, description, avis) ; il
  s'ouvre normalement dès que ses PDF sont déposés dans son dossier.

## Ajouter un résumé

1. **Déposer le PDF** dans le dossier de sa partie : `pdfs/m-julia/`, `pdfs/a-julia/` ou `pdfs/office/`. Il apparaît tout seul (au
   prochain retour dans la fenêtre de Cours). En développement, le bouton « Ouvrir le dossier des PDF » d'une partie
   vide y mène directement.
2. **Titre** : tiré du nom du fichier, sans numéro ni extension : `01 - Adressage IP.pdf` → « Adressage IP ». Le
   numéro en tête choisit l'ordre (`2` passe avant `10`).
3. **Description** (facultatif) : dans `lib/content.js`, liste `documents` de la partie :

   ```js
   documents: [
     { file: '01 - Adressage IP.pdf', title: 'Adressage IP', description: 'IPv4, masques, sous-réseaux et CIDR.', author: 'M.Julia' },
   ],
   ```

   Sans description ici, Cours affiche le « Sujet » enregistré dans les propriétés du PDF, s'il y en a un ; sans
   `author`, l'« Auteur » des propriétés du PDF (sinon « Non renseigné »).

Nouvelle partie : une entrée dans `parts` (`lib/content.js`) et son dossier `pdfs/<id>/`. Les PDF sont livrés avec
l'application (copiés hors de l'archive, `asarUnpack`), donc inclus dans l'installeur de V3Redis.

## Développement

```bash
npm install
```

```bash
npm start
```

- `npm test` : tests (titres, ordre, recherche, contenu).
- Depuis le HUB en `npm run dev`, Cours est lancé depuis ce dossier : les modifications sont visibles à chaque lancement.
- `COURS_PDF_DIR=<dossier>` (développement) : lire les PDF ailleurs que dans `pdfs/` (tests).

Structure : `main.js` (fenêtre, écran de démarrage, thème, liste / lecture / visionneuse / copie des PDF),
`preload.js`, `lib/content.js` (parties, informations des PDF), `lib/course.js` (titres, recherche, vérification),
`renderer/` (interface, pdf.js pour les aperçus), `pdfs/`, `test/`.
