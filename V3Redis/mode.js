/*
 * mode.js — V3Redis complet ou V3Redis Light (PC peu puissants).
 *
 * Light : fenêtre Windows classique (cadre et barre de titre du système), aucun effet (ni ciel étoilé, ni 3D,
 * ni animation de lancement), interface plate en liste. Même application, même paquet, mêmes mises à jour.
 *
 * Choix du mode, dans cet ordre :
 *   1. argument --light ou --full (raccourci « V3Redis Light » du menu Démarrer : --light) ;
 *   2. choix enregistré par le bouton de l'interface (settings.json : mode) ;
 *   3. sinon détection : 4 Go de mémoire ou moins, ou 2 cœurs ou moins → Light (auto: true).
 */
'use strict';

const MODES = ['full', 'light'];
const WEAK_MEMORY = 4.5 * 1024 ** 3; // un PC « 4 Go » annonce un peu moins de 4 Gio
const WEAK_CPUS = 2;

/** → { mode: 'full' | 'light', auto: true si le mode Light vient de la détection du matériel } */
function resolveMode({ argv = [], saved, totalMem = 0, cpus = 0 } = {}) {
  if (argv.includes('--light')) return { mode: 'light', auto: false };
  if (argv.includes('--full')) return { mode: 'full', auto: false };
  if (MODES.includes(saved)) return { mode: saved, auto: false };
  const weak = (totalMem > 0 && totalMem <= WEAK_MEMORY) || (cpus > 0 && cpus <= WEAK_CPUS);
  return weak ? { mode: 'light', auto: true } : { mode: 'full', auto: false };
}

/** Options de la fenêtre propres au mode (le reste est commun, voir main.js). */
function windowOptions(mode) {
  if (mode === 'light') {
    return {
      width: 900,
      height: 600,
      minWidth: 640,
      minHeight: 440,
      title: 'V3Redis Light',
      backgroundColor: '#16181d',
      frame: true, // fenêtre classique : cadre, barre de titre et boutons du système
      maximizable: true,
    };
  }
  return {
    width: 1120,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: 'V3Redis',
    backgroundColor: '#05060f', // pas de flash blanc avant le premier rendu
    frame: false, // barre de titre dessinée par l'interface (en-tête déplaçable + boutons réduire / fermer)
    maximizable: false, // pas de bouton agrandir : le double-clic sur l'en-tête n'agrandit pas non plus
  };
}

module.exports = { MODES, resolveMode, windowOptions, WEAK_MEMORY, WEAK_CPUS };
