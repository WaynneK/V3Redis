/*
 * content.js — Contenu des cours : les parties, leurs chapitres et les résumés.
 *
 * C'est le SEUL fichier à modifier pour écrire un résumé (l'interface le lit tel quel).
 *
 * Partie  : { id, name, initials, description, topics: [mots-clés affichés], accent: '#rrggbb', chapters: [...] }
 * Chapitre : {
 *   id, title, subtitle?,           identifiant unique dans la partie (lettres, chiffres, tirets)
 *   keyPoints?: ['…'],              « Points clés » en tête du résumé
 *   sections?: [{ title, blocks }]  le résumé ; sans sections, le chapitre s'affiche « Résumé à venir »
 * }
 * Blocs d'une section (texte enrichi possible : **gras**, `code`) :
 *   { p: 'paragraphe' }
 *   { list: ['élément', …] }                        liste à puces
 *   { steps: ['étape', …] }                         liste numérotée
 *   { table: { head: ['A', 'B'], rows: [['1', '2'], …] } }
 *   { code: 'texte affiché tel quel (commandes)' }
 *   { note: 'encadré « À retenir »' }
 *   { warn: 'encadré « Attention »' }
 */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.CoursContent = data;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    version: 1,
    parts: [
      {
        id: 'm-julia',
        name: 'M.Julia',
        initials: 'MJ',
        description: 'IP, Windows Server, Connexion',
        topics: ['IP', 'Windows Server', 'Connexion'],
        accent: '#38bdf8',
        chapters: [
          { id: 'ip', title: 'IP' },
          { id: 'windows-server', title: 'Windows Server' },
          { id: 'connexion', title: 'Connexion' },
        ],
      },
      {
        id: 'a-julia',
        name: 'A.Julia',
        initials: 'AJ',
        description: 'Hardware : carte mère, CPU, GPU…',
        topics: ['Carte mère', 'CPU', 'GPU', 'RAM', 'Stockage'],
        accent: '#a78bfa',
        chapters: [
          { id: 'carte-mere', title: 'Carte mère' },
          { id: 'cpu', title: 'CPU', subtitle: 'Processeur' },
          { id: 'gpu', title: 'GPU', subtitle: 'Carte graphique' },
          { id: 'ram', title: 'RAM', subtitle: 'Mémoire vive' },
          { id: 'stockage', title: 'Stockage', subtitle: 'Disques durs et SSD' },
        ],
      },
    ],
  };
});
