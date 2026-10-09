/*
 * apps.js — Catalogue des applications proposées par le HUB.
 *
 * Ajouter une application = ajouter une entrée ici :
 *   id           identifiant interne (unique)
 *   name         nom affiché
 *   tagline      accroche courte (sélecteur)
 *   description  une phrase
 *   icon         fichier SVG dans renderer/assets/apps/
 *   accent       couleur de l'application (lueur du sélecteur, nébuleuse du fond)
 *   features     points forts (3 ou 4 courts)
 *   status       'available' (installable / lançable) ou 'soon' (annoncée, pas encore sortie)
 *   downloadUrl  page de téléchargement (seuls ces liens peuvent être ouverts par le HUB)
 *   windows      { displayName, exe, defaultDir } : nom dans « Applications installées »,
 *                exécutable dans le dossier d'installation, dossier par défaut de l'installeur
 *   linux        { appImagePrefix, bin } : début du nom de l'AppImage (ex. « SysInfo-Lite- ») ;
 *                bin : exécutable de l'application livrée avec le HUB (« executableName » Linux du projet)
 *   mac          { app } : nom du paquet .app (productName du projet), livré avec le HUB ou dans /Applications
 *   local        projet voisin du HUB (même dossier parent), utilisé quand l'application n'est pas
 *                installée : { project: nom du dossier, winExe: exécutables compilés (chemins relatifs),
 *                winPortable / appImage : motifs des fichiers de dist/, winInstaller : motif de l'installeur }
 */
'use strict';

module.exports = [
  {
    id: 'sysinfo',
    name: 'SysInfo Lite',
    tagline: 'Tout votre matériel, en un coup d\'œil',
    description: 'Informations matérielles détaillées (processeur, carte mère, mémoire, GPU, disques, réseau).',
    icon: 'sysinfo.svg',
    accent: '#8b6dff',
    features: ['Processeur & GPU', 'Mémoire & disques', 'Températures en direct', 'Test de débit'],
    status: 'available',
    downloadUrl: 'https://github.com/WaynneK/SysInfoLite/releases/latest',
    windows: {
      displayName: 'SysInfo Lite',
      exe: 'SysInfo Lite.exe',
      defaultDir: ['LOCALAPPDATA', 'Programs', 'SysInfo Lite'],
    },
    linux: {
      appImagePrefix: 'SysInfo-Lite-',
      bin: 'sysinfo-lite', // à confirmer quand le projet SysInfo Lite sera de retour (executableName Linux)
    },
    mac: {
      app: 'SysInfo Lite.app',
    },
    local: {
      project: 'SysInfoLite',
      winExe: ['dist/win-unpacked/SysInfo Lite.exe'],
      winPortable: /^SysInfo-Lite-Portable-[\d.]+\.exe$/,
      winInstaller: /^SysInfo-Lite-Setup-[\d.]+\.exe$/,
      appImage: /^SysInfo-Lite-[\d.]+-x86_64\.AppImage$/,
    },
  },
  {
    id: 'calkip',
    name: 'CalkIP',
    tagline: 'Vos réseaux IP, calculés en local',
    description: 'Calculatrice IPv4 hors ligne : réseau, masque, maximum de baux DHCP et export .txt des adresses.',
    icon: 'calkip.svg',
    accent: '#22d3ee',
    features: ['/8 · /16 · /24 · /32 ou auto', 'Baux DHCP maximum', 'Export .txt', '100 % hors ligne'],
    status: 'available',
    downloadUrl: null, // à renseigner quand CalkIP aura sa page de releases
    windows: {
      displayName: 'CalkIP',
      exe: 'CalkIP.exe',
      defaultDir: ['LOCALAPPDATA', 'Programs', 'CalkIP'],
    },
    linux: {
      appImagePrefix: 'CalkIP-',
      bin: 'calkip',
    },
    mac: {
      app: 'CalkIP.app',
    },
    local: {
      project: 'CalkIP',
      winExe: ['dist/win-unpacked/CalkIP.exe'],
      winPortable: /^CalkIP-Portable-[\d.]+\.exe$/,
      winInstaller: /^CalkIP-Setup-[\d.]+\.exe$/,
      appImage: /^CalkIP-[\d.]+-x86_64\.AppImage$/,
    },
  },
  {
    id: 'predf',
    name: 'PredF',
    tagline: 'Vos PDF convertis et fusionnés',
    description: 'Fusion et conversion de PDF : assembler, réorganiser et convertir vos documents.',
    icon: 'predf.svg',
    accent: '#ff5d73',
    features: ['Fusion et découpe', 'Pages à réorganiser', 'Images ↔ PDF', 'Compression', '100 % hors ligne'],
    status: 'available',
    downloadUrl: null,
    windows: {
      displayName: 'PredF',
      exe: 'PredF.exe',
      defaultDir: ['LOCALAPPDATA', 'Programs', 'PredF'],
    },
    linux: {
      appImagePrefix: 'PredF-',
      bin: 'predf',
    },
    mac: {
      app: 'PredF.app',
    },
    local: {
      project: 'PredF',
      winExe: ['dist/win-unpacked/PredF.exe'],
      winPortable: /^PredF-Portable-[\d.]+\.exe$/,
      winInstaller: /^PredF-Setup-[\d.]+\.exe$/,
      appImage: /^PredF-[\d.]+-x86_64\.AppImage$/,
    },
  },
  {
    id: 'agepede',
    name: 'Agépédé',
    tagline: 'Votre Active Directory, en AGDLP',
    description: 'OU, utilisateurs, groupes et dossiers en tableau, créés en CMD (AGDLP).',
    icon: 'agepede.svg',
    accent: '#f59e0b',
    features: ['OU, comptes, GG et DL', 'Héritage des dossiers', 'Script CMD (dsadd)', 'Windows Server'],
    status: 'available',
    downloadUrl: null,
    windows: {
      displayName: 'Agépédé',
      exe: 'Agepede.exe',
      defaultDir: ['LOCALAPPDATA', 'Programs', 'Agepede'], // dossier nommé d'après l'exécutable (nom ASCII)
    },
    linux: {
      appImagePrefix: 'Agepede-',
      bin: 'agepede',
    },
    mac: {
      app: 'Agépédé.app',
    },
    local: {
      project: 'Agépédé',
      winExe: ['dist/win-unpacked/Agepede.exe'],
      winPortable: /^Agepede-Portable-[\d.]+\.exe$/,
      winInstaller: /^Agepede-Setup-[\d.]+\.exe$/,
      appImage: /^Agepede-[\d.]+-x86_64\.AppImage$/,
    },
  },
  {
    // Module annoncé : pas encore d'application. Pour le rendre disponible : status 'available', puis les
    // champs windows / linux / local (même forme que les autres) et son projet voisin ..\Cours
    id: 'cours',
    name: 'Cours',
    tagline: 'Les résumés de la formation',
    description: 'Les résumés des cours de la formation, classés par module, à relire en un clin d\'œil.',
    icon: 'cours.svg',
    accent: '#34d399',
    features: ['Résumés par module', 'Points clés', 'Révision rapide'],
    status: 'soon',
    downloadUrl: null,
  },
];
