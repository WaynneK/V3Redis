# V3Redis

Le HUB **V3Redis** et les applications livrées avec lui, en **un seul paquet** : un installeur Windows qui installe
le HUB et toutes ses applications, mises à jour ensemble depuis les releases de ce dépôt.

| Dossier | Contenu |
|---|---|
| [`V3Redis/`](V3Redis/) | le HUB : sélecteur d'applications, lancement, **mises à jour**, installeur « tout en un » |
| [`CalkIP/`](CalkIP/) | calculatrice IPv4 hors ligne (calculs en binaire pas à pas) |
| [`PredF/`](PredF/) | fusion et conversion de PDF, assistant IA (Claude ou IA locale gratuite) |
| [`Agépédé/`](Agépédé/) | OU, groupes globaux et domaine local Active Directory en AGDLP (Windows Server) |

SysInfo Lite a son propre dépôt ; le HUB l'intègre au paquet quand son projet est présent à côté des autres.

## Construire l'installeur

Dans chaque projet : `npm install`. Puis, dans `V3Redis/` :

```bash
npm run build
```

Résultat dans `V3Redis/dist/` : `V3Redis-Setup-x.y.z.exe`, son `.blockmap` et `latest.yml`.

## Publier une mise à jour

1. Augmenter la version dans `V3Redis/package.json` (et celles des applications modifiées).
2. `npm run build` dans `V3Redis/`.
3. Créer une release GitHub `vX.Y.Z` et y joindre les **3 fichiers** de `V3Redis/dist/`, puis la publier.
   Les V3Redis installés la détectent (au démarrage puis toutes les 4 h), la téléchargent et proposent
   « Installer et redémarrer ». Détails : [`V3Redis/README.md`](V3Redis/README.md).
