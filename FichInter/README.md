# FichInter

Fiches d'intervention remplies en quelques minutes, à partir d'un **modèle Word** : on choisit le modèle, le
formulaire s'adapte à ses cases, on saisit, puis **Générer la fiche** produit un `.docx` relu et vérifié case par case.

## Utilisation

1. **Modèles** (accueil) : choisir un modèle. Le modèle livré, `modeles/Fiche d'intervention VersusLabz.docx`, est la
   fiche de la S.A.R.L. VersusLabz (une page A4, 7 parties, 42 champs). Il est écrit par
   `node scripts/versuslabz/build.js` (logo : `scripts/versuslabz/logo.png`) : modifier ce script puis le relancer
   pour faire évoluer la fiche. **Importer un modèle Word** en ajoute d'autres (copiés dans `<données>/Modèles`,
   retirables : ils partent à la corbeille).
2. **Formulaire** : une carte par section, la barre de gauche suit l'avancement (`8/12`). Le brouillon est enregistré
   à chaque saisie et repris à la prochaine ouverture du modèle.
   - Date de l'intervention et « le … » de la signature : **date du jour** ; technicien, sa signature et « Fait à » :
     **repris** de la fiche précédente.
   - Heures : bouton **Maintenant** ; « Temps passé » propose la **durée** calculée (arrivée → fin) ; « N° de
     fiche », « Réf. dossier » : bouton **Générer** (`INT-AAAAMMJJ-NN`).
   - Pièces remplacées : un petit tableau (désignation, référence, quantité), autant de lignes que sur la fiche.
   - Signatures : **dessinées** à la souris, au stylet ou au doigt (facultatives) ; quand le cadre a sa case « Nom »,
     seule la signature est demandée.
3. **Générer la fiche** (Ctrl+Entrée) : les cases vides sont listées (Compléter / Générer quand même), puis la fiche
   est écrite dans le dossier des fiches (`Documents\Fiches d'intervention` par défaut, modifiable sur l'accueil) :
   `Fiche d'intervention - <client> - <date>.docx`.
4. **Fiche générée** : **Vérification** (chaque champ relu dans le fichier produit : présent, vide, ou différent) et
   **Aperçu** du document. Ouvrir dans Word, **Exporter en PDF** (par Word s'il est installé, sinon rendu de
   l'aperçu), Modifier la saisie (la fiche est remplacée), Nouvelle fiche.
5. **Fiches récentes** (accueil) : revoir une fiche (relue à nouveau : une modification faite dans Word depuis est
   signalée), la reprendre, l'ouvrir, afficher son dossier.

## Modèles : comment le formulaire est déduit

Aucun réglage à écrire : `lib/template.js` lit le document.

- Une **section** = un tableau, titré par le paragraphe qui le précède (« 1. Identité »).
- Une ligne **« intitulé | case »** = un champ (lignes à 4 cellules : deux champs). Selon la case :
  - cases à cocher (`o` en Courier New, `☐`, symboles Wingdings) → **choix** (une case seule : à cocher ; 6 options
    et plus : plusieurs choix possibles). Option terminée par « : » (« Autre (Préciser) : ») ou avec des pointillés
    (« Sous garantie (jusqu'au : ………… ) ») → précision à saisir ;
  - pointillés (`…………`, `……/……/…………`, `___ / ___ / _____`, `___ h ___`) → **phrase à trous** (texte, date, heure) ;
  - vide, ou texte terminé par « : » (« Mr. / Mme : ») → **texte**, typé d'après l'intitulé
    (`lib/fields.js` : date, heure, date et heure, e-mail, téléphone, texte long, signature) ; plusieurs
    paragraphes vides soulignés → texte sur plusieurs lignes (une par trait).
- Ligne sans intitulé avec des cases à cocher sous une liste : suite de la même liste.
- Mises en page plus riches (modèle VersusLabz) :
  - ligne de **titres** (style Titre 1 ou 2) dans un tableau en colonnes → une section par colonne
    (« 1 CLIENT | 2 INTERVENTION ») ; titres de **cadre** (Titre 3) → repris devant les intitulés (« Client · Nom ») ;
  - **cadre grisé** « titre + paragraphe vide » → texte long (« Description de la panne ») ;
  - ligne d'**en-têtes suivie de lignes vides** → tableau à remplir (pièces) ;
  - cellule étroite vide (≤ 0,7 cm) → espace entre colonnes, ignorée ; texte seul en fin de ligne → aide du champ.
- Dans la fiche, seules les cases des champs sont réécrites (styles, logo, mise en page intacts) ; les cases à cocher
  deviennent `☒` (en gras) ou `☐`, les dates sont écrites à la française (`13/10/2026`, `09h05`).

## Développement

```
npm install
npm start          # ou npm run dev (outils de développement)
npm test           # analyse, remplissage, relecture, règles des champs
node scripts/versuslabz/build.js   # régénère le modèle VersusLabz livré
```

Tests : `test/versuslabz.test.js` (modèle livré) et `test/modele-test.docx` (premier modèle, mise en page
« intitulé | case » simple, gardé pour les tests).

Application locale : aucune connexion (requêtes réseau bloquées). Aperçu Word : [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)
et [JSZip](https://stuk.github.io/jszip/), embarqués.
