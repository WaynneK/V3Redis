# Cours

Les **résumés des cours de la formation**, classés par partie, à relire en un clin d'œil. Application de la suite
V3Redis (lancée depuis le HUB, ou seule), 100 % locale : aucune connexion.

| Partie | Description | Chapitres |
|---|---|---|
| **M.Julia** | IP, Windows Server, Connexion | IP · Windows Server · Connexion |
| **A.Julia** | Hardware : carte mère, CPU, GPU… | Carte mère · CPU · GPU · RAM · Stockage |

## Interface

- **Accueil** : une carte par partie (couleur propre, thèmes abordés, nombre de chapitres, résumés disponibles,
  chapitres lus) et « Reprendre la lecture ». Touches **1**, **2** : ouvrir une partie.
- **Partie** : sommaire à gauche (numéro, « À venir » / « Lu »), résumé du chapitre à droite : **points clés**, sections
  (paragraphes, listes, tableaux, commandes, encadrés « À retenir » / « Attention »), **Marquer comme lu**, chapitres
  précédent / suivant (**←** **→**). Un chapitre sans résumé affiche « Résumé à venir ».
- **Recherche** (**Ctrl+K**) dans toutes les parties, sans tenir compte des accents ni des majuscules, avec extrait.
  **Échap** : retour.
- Thème système / clair / sombre ; chapitres lus et dernière lecture gardés sur le poste.

## Écrire un résumé

Tout le contenu est dans **`lib/content.js`** (l'interface n'a pas à être modifiée). Un chapitre sans `sections`
reste « À venir » ; dès qu'il en a, il devient lisible. Exemple :

```js
{
  id: 'ip',
  title: 'IP',
  keyPoints: ['Une adresse **IPv4** compte 32 bits', 'Le **masque** sépare réseau et hôtes'],
  sections: [
    {
      title: 'Les masques',
      blocks: [
        { p: 'Le masque `255.255.255.0` s\'écrit aussi **/24**.' },
        { list: ['Point 1', 'Point 2'] },
        { steps: ['Étape 1', 'Étape 2'] },
        { table: { head: ['CIDR', 'Masque'], rows: [['/24', '255.255.255.0']] } },
        { code: 'ipconfig /all' },
        { note: 'À retenir…' },
        { warn: 'Attention…' },
      ],
    },
  ],
}
```

Texte enrichi : `**gras**` et `` `code` ``. Ajouter une partie ou un chapitre = ajouter une entrée (identifiant en
minuscules, chiffres et tirets). Le contenu est vérifié au démarrage et par `npm test` (identifiants en double, blocs
inconnus, couleurs…).

## Développement

```bash
npm install
```

```bash
npm start
```

- `npm test` : tests (outils et contenu réel).
- `npm run build:win` : installeur et version portable ; le HUB l'embarque avec les autres applications (`npm run build`
  dans `V3Redis/`).

Structure : `main.js` (fenêtre, écran de démarrage, thème), `preload.js`, `lib/content.js` (contenu), `lib/course.js`
(vérification, recherche, texte enrichi), `renderer/` (interface), `test/`.
