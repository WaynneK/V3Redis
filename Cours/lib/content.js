/*
 * content.js — Les parties de Cours et les informations des résumés PDF.
 *
 * Ajouter un résumé = DÉPOSER LE PDF dans le dossier de sa partie : pdfs/<id de la partie>/
 *   (ex. pdfs/m-julia/01 - Adressage IP.pdf). Il apparaît tout seul dans l'application, rangé par nom de fichier
 *   (un numéro en tête permet de choisir l'ordre).
 * Titre affiché : celui donné ci-dessous, sinon le nom du fichier (sans numéro ni extension :
 *   « 01 - Adressage IP.pdf » → « Adressage IP »).
 * Description : celle donnée ci-dessous, sinon le sujet enregistré dans le PDF.
 * Auteur (panneau « Informations ») : celui donné ci-dessous, sinon l'auteur enregistré dans le PDF.
 *
 * Cours en DOSSIER (plusieurs fichiers) : pdfs/<partie>/<Nom du cours>/ avec ses PDF et ses photos, et un
 *   sous-dossier « Condensé » pour le PDF qui rassemble tout le cours (bouton « Condensé »). Informations :
 *   { folder: 'Nom du cours', title?, date?: 'AAAA-MM-JJ' (date du cours, ordre de la liste), description?,
 *     icon?: 'alimentation' | 'cpu' | 'carte-mere' | 'chipset' | 'bios' | 'disque' | 'codage' | 'document',
 *     files?: { 'nom du fichier': 'Titre affiché' } }.
 *
 * Partie : { id, name, initials, logo?: 'microsoft', description, topics: [thèmes affichés], accent: '#rrggbb',
 *            documents?: [{ file: 'nom du fichier.pdf', title?, description?, author? } | { folder, … }] }
 */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.CoursContent = data;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    version: 2,
    parts: [
      {
        id: 'm-julia',
        name: 'M.Julia',
        initials: 'MJ',
        description: 'IP, Windows Server, Connexion',
        topics: ['IP', 'Windows Server', 'Connexion'],
        accent: '#38bdf8',
        documents: [
          // { file: '01 - Adressage IP.pdf', title: 'Adressage IP', description: 'IPv4, masques, sous-réseaux.' },
        ],
      },
      {
        id: 'a-julia',
        name: 'A.Julia',
        initials: 'AJ',
        description: 'Hardware : carte mère, CPU, GPU…',
        topics: ['Carte mère', 'CPU', 'GPU', 'RAM', 'Stockage'],
        accent: '#a78bfa',
        documents: [
          {
            folder: 'Alimentation',
            title: 'Alimentation',
            icon: 'alimentation',
            date: '2026-10-05',
            description: 'Alimentations à découpage, courant alternatif et notions de base en électricité, certifications 80 Plus et alimentation redondante.',
            files: {
              'Architecture_et_Electricite - Mohssine.pdf':'Architecture de l\'UC & électricité',
              'ALIMENTATION.pdf': 'Alimentation à découpage',
              'courant alternatif.pdf': 'Le courant alternatif',
              'NOTIONS DE BASE EN ELECTRICITE.pdf': 'Notions de base en électricité',
              'classification alimentations 80.PNG': 'Normes et certifications 80 Plus',
              'double-alimentation-700-watts.JPG': 'Double alimentation 700 W (serveur)',
            },
          },
          // Condensés à venir : à déposer dans le sous-dossier « Condensé » de chaque cours
          {
            folder: 'BIOS',
            title: 'BIOS',
            icon: 'bios',
            description: 'BIOS et UEFI : rôle au démarrage de l\'ordinateur, réglages, et les principaux fabricants.',
            files: { 'BIOS.pdf': 'Le BIOS', 'Principaux fabricants de BIOS.pdf': 'Principaux fabricants de BIOS / UEFI' },
          },
          {
            folder: 'Carte mère',
            title: 'Carte mère',
            icon: 'carte-mere',
            description: 'La carte mère composant par composant : socket, chipsets, mémoire, connecteurs (exemple : Asus P5B-V).',
            files: { 'p5v.pdf': 'Carte mère Asus P5B-V : repérage des composants' },
          },
          {
            folder: 'Chipset',
            title: 'Chipset',
            icon: 'chipset',
            description: 'Le chipset et les générations de processeurs qu\'il accompagne.',
            files: { 'chipset et generation de processeurs.docx': 'Chipsets et générations de processeurs' },
          },
          {
            folder: 'Codage',
            title: 'Codage',
            icon: 'codage',
            description: 'Codage de l\'information : bits, octets, binaire, et la table ASCII.',
            files: { 'Codage Binaire - Alain.pdf': 'Le codage binaire', 'Table ASCII - Alain.pdf': 'Table ASCII' },
          },
          {
            folder: 'CPU',
            title: 'CPU',
            icon: 'cpu',
            description: 'Le processeur : jeux d\'instructions, loi de Moore, gammes Intel Core et fabrication du silicium.',
            files: {
              'Les instructions.pdf': 'Les jeux d\'instructions (MMX, SSE…)',
              'Intel-Core-Desktop-Boxed-Processors-Comparison-Chart.xlsx': 'Comparatif des processeurs Intel Core',
              'loi de moore.png': 'La loi de Moore',
              'Reportage-Procede-de-fabrication-du-Silicium-Micro-posse.mp4': 'Reportage : fabrication du silicium',
            },
          },
          {
            folder: 'Disque dur',
            title: 'Disque dur',
            icon: 'disque',
            description: 'Le stockage : NVMe face au SATA, le premier disque dur (IBM RAMAC 305) et l\'histoire de Seagate.',
            files: {
              'Comparaison NVMe – SATA.pdf': 'Comparaison NVMe / SATA',
              'dd ramdac 305 1956.JPG': 'IBM RAMAC 305 (1956) : le premier disque dur',
              'L\'histoire de Seagate - YouTube.webm': 'L\'histoire de Seagate',
            },
          },
          {
            folder: 'Doc',
            title: 'Doc',
            icon: 'document',
            description: 'Document de référence de la formation : « L\'ordinateur et vous ».',
            files: { 'l\'ordinateur et vous.pdf': 'L\'ordinateur et vous' },
          },
        ],
      },
      {
        id: 'office',
        name: 'Microsoft Office',
        initials: 'MO',
        logo: 'microsoft', // logo à la place des initiales (pastille de la barre, en-tête de la partie)
        description: 'Word, Excel, PowerPoint, Outlook',
        topics: ['Word', 'Excel', 'PowerPoint', 'Outlook'],
        accent: '#f97316',
        documents: [],
      },
    ],
  };
});
