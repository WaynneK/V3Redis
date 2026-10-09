/*
 * mode-init.js — Chargé dans <head>, avant le premier rendu : applique le mode de la fenêtre.
 * V3Redis Light (html.light) : fenêtre classique, interface plate, aucun effet (styles.css, fin du fichier).
 */
'use strict';

(() => {
  const light = Boolean(window.hub && window.hub.mode === 'light');
  document.documentElement.classList.toggle('light', light);
  if (light) document.title = 'V3Redis Light';
})();
