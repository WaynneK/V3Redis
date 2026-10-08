/*
 * preload.js — Pont minimal entre l'interface (isolée) et le processus principal.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  /** Catalogue et état : [{ id, name, description, status, canDownload, installed, path, version, source }]. */
  listApps: () => ipcRenderer.invoke('apps:list'),
  launch: (id) => ipcRenderer.invoke('apps:launch', String(id)),
  /** V3Redis s'efface, puis se ferme quand la fenêtre de l'application lancée est affichée. */
  retreat: (launchId) => ipcRenderer.invoke('hub:retreat', Number(launchId)),
  /** Lance l'installeur compilé dans le dossier du projet de l'application. */
  install: (id) => ipcRenderer.invoke('apps:install', String(id)),
  /** Choisir l'exécutable à la main (application installée ailleurs). */
  choose: (id) => ipcRenderer.invoke('apps:choose', String(id)),
  /** Oublier le chemin choisi à la main. */
  forget: (id) => ipcRenderer.invoke('apps:forget', String(id)),
  /** Ouvre la page de téléchargement de l'application dans le navigateur. */
  download: (id) => ipcRenderer.invoke('apps:download', String(id)),
  info: () => ipcRenderer.invoke('hub:info'),

  // Mises à jour du paquet (V3Redis + applications livrées) : état
  // { mode, state, current, version, percent, transferred, total, notes, error, checkedAt, manual, test }
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  /** → { ok } ou { ok: false, error, open: [noms des applications à fermer] } */
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateOpenRelease: () => ipcRenderer.invoke('update:open'),
  onUpdateStatus: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('update:status', (_event, s) => callback(s || {}));
  },

  // Barre de titre (fenêtre sans cadre)
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
});
