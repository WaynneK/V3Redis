# FichInter

Fiches d'intervention remplies en quelques minutes, à partir d'un **modèle Word** : on choisit le modèle, le
formulaire s'adapte à ses cases, on saisit, puis **Générer la fiche** produit un `.docx` relu et vérifié case par case.

## Utilisation

1. **Modèles** (accueil) : choisir un modèle. Le modèle livré, `modeles/Fiche d'intervention (test).docx`, est la
   fiche VERSUSLABZ (6 sections, 52 champs). **Importer un modèle Word** en ajoute d'autres (copiés dans
   `<données>/Modèles`, retirables : ils partent à la corbeille).
2. **Formulaire** : une carte par section, la barre de gauche suit l'avancement (`8/12`). Le brouillon est enregistré
   à chaque saisie et repris à la prochaine ouverture du modèle.
   - Date de l'intervention et « le … » de la signature : **date du jour** ; technicien, sa signature et « Fait à » :
     **repris** de la fiche précédente.
   - Heures : bouton **Maintenant** ; « Temps / Tarif » propose la **durée** calculée (arrivée → fin) ; « Ref du
     dossier » : bouton **Générer** (`INT-AAAAMMJJ-NN`).
   - Signatures : **dessinées** à la souris, au stylet ou au doigt (facultatives).
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
  - pointillés (`…………`, `……/……/…………`) → **phrase à trous** (texte, date) ;
  - vide, ou texte terminé par « : » (« Mr. / Mme : ») → **texte**, typé d'après l'intitulé
    (`lib/fields.js` : date, heure, date et heure, e-mail, téléphone, texte long, signature).
- Dans la fiche, seules les cases des champs sont réécrites (styles, logo, mise en page intacts) ; les cases à cocher
  deviennent `☒` (en gras) ou `☐`, les dates sont écrites à la française (`13/10/2026`, `09h05`).

## Développement

```
npm install
npm start          # ou npm run dev (outils de développement)
npm test           # analyse, remplissage, relecture, règles des champs
```

Application locale : aucune connexion (requêtes réseau bloquées). Aperçu Word : [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)
et [JSZip](https://stuk.github.io/jszip/), embarqués.
