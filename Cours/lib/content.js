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
 * Partie : { id, name, initials, logo?: 'microsoft', description, topics: [thèmes affichés], accent: '#rrggbb',
 *            documents?: [{ file: 'nom du fichier.pdf', title?, description?, author? }] }
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
        documents: [],
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
