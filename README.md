# V3Redis

Le HUB **V3Redis** et les applications livrées avec lui, en **un seul paquet** pour **Windows, Linux et macOS** :
on installe V3Redis, et toutes ses applications avec ; elles se mettent à jour ensemble depuis les releases de ce dépôt.

| Dossier | Contenu |
|---|---|
| [`V3Redis/`](V3Redis/) | le HUB : sélecteur d'applications, lancement, **mises à jour**, paquets « tout en un » |
| [`CalkIP/`](CalkIP/) | calculatrice IPv4 hors ligne (calculs en binaire pas à pas) |
| [`PredF/`](PredF/) | fusion et conversion de PDF, assistant IA (Claude ou IA locale gratuite) |
| [`Agépédé/`](Agépédé/) | OU, groupes globaux et domaine local Active Directory en AGDLP (exécution sous Windows Server) |
| [`Cours/`](Cours/) | résumés des cours de la formation : M.Julia (IP, Windows Server, Connexion), A.Julia (hardware) |

SysInfo Lite a son propre dépôt ; il est intégré au paquet quand son projet est présent à côté des autres.

## Télécharger (page *Releases*)

| Système | Fichier | Mises à jour |
|---|---|---|
| Windows 10 / 11 | `V3Redis-Setup-X.Y.Z.exe` | automatiques (bouton « Installer » dans V3Redis) |
| Linux (x86_64) | `V3Redis-X.Y.Z-x86_64.AppImage` : la rendre exécutable (`chmod +x`) puis la lancer | automatiques |
| macOS Apple Silicon | `V3Redis-X.Y.Z-arm64.dmg` | nouvelle version signalée, à télécharger |
| macOS Intel | `V3Redis-X.Y.Z-x64.dmg` | nouvelle version signalée, à télécharger |

**macOS** : l'application n'est pas signée par un compte développeur Apple. Au premier lancement, faire un
clic droit sur V3Redis › **Ouvrir** ; si macOS indique qu'elle est « endommagée », lancer une fois dans le Terminal
`xattr -cr /Applications/V3Redis.app`. Pour la même raison, les mises à jour ne s'installent pas toutes seules sur
macOS : V3Redis affiche la nouvelle version et ouvre sa page de téléchargement.

## Publier une nouvelle version

1. Augmenter la version dans `V3Redis/package.json` (et celles des applications modifiées), puis pousser.
2. **GitHub** › onglet **Actions** › **Release** › **Run workflow** : les paquets **Linux** et **macOS** sont construits et
   déposés dans une release **brouillon** `vX.Y.Z` (environ 15 min).
3. **Windows** : sur le PC, `npm run build` dans `V3Redis/` (SysInfo Lite y est inclus), puis ajouter à la release
   brouillon les fichiers de `V3Redis/dist/` listés à la fin du build : `V3Redis-Setup-X.Y.Z.exe`, son `.blockmap`,
   `latest.yml`, **et** les paquets des applications `V3Redis-X.Y.Z-app-<id>-win-x64.zip` avec leur liste
   `V3Redis-X.Y.Z-apps-win-x64.json` (sans eux, une application décochée à l'installation ne pourra pas être
   installée plus tard depuis V3Redis).
   (Avec le secret `SYSINFOLITE_TOKEN`, jeton en lecture sur le dépôt de SysInfo Lite, GitHub construit aussi le
   paquet Windows et cette étape disparaît.)
4. Vérifier la release, écrire les nouveautés (affichées dans V3Redis) puis **Publish release** — ni « pre-release »,
   ni brouillon : sinon les V3Redis installés ne la voient pas.

Construire à la main : `npm install` dans chaque projet, puis `npm run build` dans `V3Redis/` sur le système visé
(un paquet macOS ne se construit que sur un Mac, une AppImage que sous Linux). Détails : [`V3Redis/README.md`](V3Redis/README.md).
