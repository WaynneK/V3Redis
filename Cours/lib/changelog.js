/*
 * changelog.js — Nouveautés de Cours, affichées sur l'accueil (la plus récente en premier).
 *
 * À chaque mise à jour : ajouter une entrée EN TÊTE de la liste, avec la version de package.json
 * (un test vérifie que la première entrée correspond à la version de l'application).
 *
 * Entrée : { version: '0.2.0', date: 'AAAA-MM-JJ', title: 'Titre court', changes: ['Une ligne par nouveauté', …] }
 */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.CoursChangelog = data;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return [
    {
      version: '0.1.1',
      date: '2026-10-13',
      title: 'Condensé Carte mère et cours Word',
      changes: [
        'Carte mère : le condensé est disponible (fiches de révision maintenance et carte mère), bouton et onglet « Condensé ».',
        'Microsoft Office : deux cours Word. « Word en ligne » : insérer un tableau, insérer une forme.',
        '« Word version bureau » : tableaux (avec un exercice), formes, groupes de formes, zones de texte, et une vidéo sur les formes.',
        'M.Julia : 9 cours TIP (historique, informatique, réseaux, IP, virtualisation, VirtualBox, bases Microsoft), contenu à venir.',
      ],
    },
    {
      version: '0.1.0',
      date: '2026-10-12',
      title: 'Lancement de Cours',
      changes: [
        'A.Julia : 8 cours (Alimentation, BIOS, Carte mère, Chipset, Codage, CPU, Disque dur, Doc) avec leurs PDF, photos et vidéos.',
        'Vidéos lues dans Cours, documents Word et Excel ouverts avec le programme de l\'ordinateur.',
        'Cours en dossier : bouton et onglet « Condensé » pour le PDF qui rassemble tout le cours, onglet « Fichiers » pour le reste.',
        'Nouvelle partie Microsoft Office : Word, Excel, PowerPoint, Outlook.',
        'Barre des parties à gauche : une pastille par partie (touches 1, 2, 3).',
        'Liste des cours avec leur statut (lu, en cours, à réviser), leurs pages et leur date.',
        'Grand aperçu du cours sélectionné, boutons « Marquer comme lu » et « À réviser ».',
        'Onglet Sommaire : les parties du PDF, un clic ouvre la visionneuse à la bonne page.',
        'Onglet Mes notes : tes notes sur chaque cours, enregistrées pendant la saisie.',
        'Onglet Informations : auteur, taille, pages, format, langue, logiciel…',
        'Animations au changement de partie et de cours.',
      ],
    },
  ];
});
