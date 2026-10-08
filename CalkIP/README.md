# CalkIP

Calculatrice IPv4 **100 % locale** : réseau, masque, plage d'hôtes, **maximum de baux DHCP** et export `.txt` de la liste des adresses.

Aucune connexion réseau, jamais : la page interdit toute requête (CSP `connect-src 'none'`), le processus principal annule toute requête http(s)/ws sortante et n'ouvre aucun lien. Tout se calcule sur la machine.

## Commandes

```bash
npm install
```

```bash
npm start
```

- `npm run dev` : avec les DevTools.
- `npm test` : 360 tests des calculs (`test/ipcalc.test.js`, `test/binary.test.js`, `node:test`, sans dépendance).
- `npm run build:win` : installeur `dist/CalkIP-Setup-1.0.0.exe` + version portable `dist/CalkIP-Portable-1.0.0.exe`.
- `npm run build:linux` : AppImage (à lancer sous Linux).

## Démarrage

Écran de démarrage (comme SysInfo Lite) : petite fenêtre sans bordure, au thème clair ou sombre de CalkIP. Le logo apparaît avec un rebond, remonte, puis le nom arrive ; la barre suit le chargement réel (préférences, vérification du moteur de calcul sur des résultats connus, préparation de l'interface). La fenêtre principale s'ouvre quand l'interface est construite (2,4 s au minimum pour laisser l'animation se jouer, 15 s au maximum). Animations désactivées si le système demande de les réduire.

## Utilisation

1. **Adresse** : `192.168.1.10`, `192.168.1.10/26` ou `192.168.1.10 255.255.255.192` (masque). Le calcul se fait pendant la frappe ; Entrée force le calcul.
2. **Préfixe** :
   - **Auto** : le préfixe ou le masque saisi avec l'adresse ; sinon celui de la classe (A → /8, B → /16, C → /24). Les classes D (multicast) et E n'ont pas de masque par défaut : choisir un préfixe.
   - **/8, /16, /24, /32** : appliqués à l'adresse saisie (un préfixe tapé dans l'adresse est alors ignoré, l'interface le signale).
   - **Autre** : n'importe quel préfixe de /1 à /32.
   - **« Je connais le nombre d'appareils »** : calcule le plus petit réseau qui contient les appareils + la passerelle + les réservations, l'applique, et fixe le **nombre de baux souhaité** au nombre d'appareils. Un réseau a toujours une taille en puissance de 2 (50 appareils → /26, 62 hôtes) : la liste exportée contient exactement 50 adresses, les 12 autres restent libres.
3. **Baux DHCP** : passerelle (première, dernière, autre adresse, aucune), adresses réservées au début / à la fin (serveurs, imprimantes), exclusions (`192.168.1.50`, `192.168.1.100-120`, `192.168.1.100-192.168.1.120`, une par ligne, `#` pour commenter). Le résultat **« Baux DHCP maximum »** est le nombre d'adresses réellement distribuables. Le champ **« Nombre de baux souhaité »** arrête la plage (et la liste exportée) à ce nombre ; s'il dépasse ce que le réseau permet, le manque est signalé.
4. **Export** :
   - **Liste (.txt)** : les baux DHCP disponibles ou toutes les adresses utilisables, une par ligne (option : lignes numérotées), précédées d'un résumé. Encodage UTF-8 avec BOM et fins de ligne Windows (lisible dans le Bloc-notes).
   - Écriture par blocs avec progression et **annulation** (le fichier incomplet est supprimé). Un /8 complet (16 777 213 baux, ~235 Mo) s'écrit en ~2 s ; au-delà de 50 Mo, un second clic confirme. Limite : un /8 (16 777 216 adresses).
   - **Résumé (.txt)** et **Copier le résumé** (presse-papiers).
   - Raccourci **Ctrl + S** : exporter la liste.
5. **Autres informations** : type d'adresse (privée RFC 1918, publique, CGNAT, APIPA, loopback, multicast, documentation, réservée), classe, masque générique (wildcard), diffusion, zone DNS inverse, réseaux précédent / suivant (cliquables), représentation binaire (bits réseau / hôtes) et hexadécimale, position de l'adresse dans le réseau (avertit si c'est l'adresse réseau ou de diffusion).
6. **Découpage en sous-réseaux** : n'importe quel préfixe plus long ; tableau (256 par page, le sous-réseau de l'adresse saisie est surligné) et export `.txt` (jusqu'à 1 048 576 sous-réseaux).
7. **Historique** des 12 derniers calculs ; la saisie et les réglages sont retrouvés au lancement suivant. Thème clair / sombre / système.

## Onglet « Binaire »

Pour comprendre et vérifier un calcul bit par bit (onglet en haut, ou <kbd>Ctrl</kbd> + <kbd>2</kbd> ; <kbd>Ctrl</kbd> + <kbd>1</kbd> revient à la calculatrice). Il reprend l'adresse de la calculatrice à l'ouverture, et le bouton **« Voir le calcul pas à pas »** de la carte Binaire y mène directement.

1. **Atelier bit à bit** : les 32 bits de l'adresse, du masque, du wildcard, du réseau (adresse ET masque) et de la diffusion (réseau OU wildcard), avec le poids de chaque bit et les accolades partie réseau / partie hôte. Un clic sur un bit de l'adresse l'inverse, un clic sur le masque déplace la limite (aussi au curseur, ou avec − / +). Le survol d'un bit détaille sa position, son poids et le calcul de sa colonne. Le champ accepte aussi une adresse écrite en binaire ou en hexadécimal.
2. **Étape par étape** (9 étapes, flèches ← → du clavier) : les bases (bits, octets, poids), la conversion de chaque octet par soustractions, le masque en binaire, l'adresse réseau (ET logique), la diffusion (NON puis OU), la première et la dernière adresse, le nombre d'hôtes (2^h − 2), la méthode rapide du « nombre magique » (256 − octet du masque) et un récapitulatif. **Tout afficher** met les 9 étapes à la suite ; **Copier** et **Exporter (.txt)** (ou <kbd>Ctrl</kbd> + <kbd>S</kbd> dans cet onglet) donnent la même explication en texte.
3. **Convertisseur** : décimal pointé, binaire, hexadécimal (`0xC0A8010A`, `C0.A8.01.0A`) ou entier 32 bits, format reconnu tout seul.
4. **Un octet à la loupe** : 8 bits à cliquer, la somme des poids, l'hexadécimal, et si la valeur peut être un octet de masque.
5. **Entraînement** : un réseau tiré au hasard (Facile : /8, /16, /24 ; Moyen : /17 à /30 en réseau privé ; Expert : /9 à /30 sur toute adresse de classe A, B ou C), six réponses à trouver (masque, réseau, diffusion, première, dernière, hôtes), correction champ par champ et calcul pas à pas de l'exercice.
6. **Mémo** : puissances de 2, octets de masque, tableau des préfixes /0 à /32 (cliquable), opérations ET / OU / NON, masque nécessaire pour N machines.

## Règles de calcul

| Préfixe | Adresses | Hôtes utilisables | Remarque |
|---|---|---|---|
| /0 à /30 | 2^(32−n) | 2^(32−n) − 2 | adresse réseau et diffusion exclues |
| /31 | 2 | 2 | liaison point à point (RFC 3021), pas de réseau ni de diffusion |
| /32 | 1 | 1 | une seule machine ; pas de plage DHCP |

**Baux DHCP maximum** = hôtes utilisables − passerelle − réservations − exclusions situées dans la plage. Une exclusion hors de la plage est signalée « sans effet ». Une passerelle personnalisée au bord de la plage la resserre ; au milieu, elle est retirée de la liste.

## Arborescence

```
CalkIP/
├── package.json        # scripts, configuration electron-builder
├── main.js             # processus principal : fenêtre, exports (flux, progression, annulation), hors ligne
├── preload.js          # pont contextBridge minimal (window.calkip)
├── lib/ipcalc.js       # tous les calculs IPv4 (sans dépendance, partagés page / processus principal)
├── lib/binary.js       # calcul binaire : conversions, explication pas à pas, exercices
├── test/               # tests (node:test) : ipcalc.test.js, binary.test.js
├── build/icon.png      # icône de l'application
└── renderer/
    ├── index.html      # page (CSP stricte, hors ligne)
    ├── styles.css      # thème clair / sombre (polices système)
    ├── app.js          # interface, onglets
    ├── binary-view.js  # onglet « Binaire »
    └── assets/         # logo
```

Sécurité : `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP stricte, émetteur IPC vérifié, aucun `innerHTML`, le calcul de l'export est refait par le processus principal (aucune confiance dans les nombres envoyés par la page), seuls les fichiers exportés pendant la session peuvent être montrés dans l'explorateur.
