/*
 * splash.js — Écran de démarrage : affiche la progression réelle du chargement envoyée par le
 * processus principal, puis joue l'animation de sortie avant l'ouverture de Cours.
 */
'use strict';

(() => {
  const api = window.splash;
  const bar = document.getElementById('bar');
  const text = document.getElementById('status-text');
  const version = document.getElementById('version');
  const box = document.getElementById('splash');

  if (!api) return;

  api.onInit((info) => {
    if (info && info.version) version.textContent = `VERSION ${info.version}`;
  });

  api.onProgress((p) => {
    if (!p) return;
    if (Number.isFinite(p.done) && Number.isFinite(p.total) && p.total > 0) {
      // Jamais tout à fait plein avant la fin : la dernière étape est l'ouverture de la fenêtre
      bar.style.width = `${Math.max(6, Math.min(94, (p.done / p.total) * 94))}%`;
    }
    if (typeof p.label === 'string') text.textContent = p.label;
  });

  api.onDone(() => {
    bar.style.width = '100%';
    text.textContent = 'Prêt';
    box.classList.add('leaving');
  });
})();
