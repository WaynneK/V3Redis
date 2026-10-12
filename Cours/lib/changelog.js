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
      version: '0.1.0',
      date: '2026-10-12',
      title: 'Interface compacte',
      changes: [
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
