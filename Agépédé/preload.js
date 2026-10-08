/*
 * preload.js — Pont minimal entre la page (isolée, sans Node) et le processus principal.
 * La page édite le projet et construit l'aperçu du script avec lib/agdlp.js ; passent ici uniquement :
 * fichiers (projet, CSV, script, journal), détection de l'environnement, exécution, presse-papiers.
 * Pour exécuter, la page envoie le PROJET : le processus principal le revalide et régénère les commandes.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('agepede', {
  detectEnvironment: () => ipcRenderer.invoke('env:detect'),
  openProject: () => ipcRenderer.invoke('project:open'),
  /** req : { project, filePath, name, saveAs } — filePath n'est réutilisé que s'il a été choisi dans une boîte de dialogue. */
  saveProject: (req) => ipcRenderer.invoke('project:save', req),
  importCsv: (table) => ipcRenderer.invoke('csv:import', String(table)),
  /** req : { table, text, name } */
  exportCsv: (req) => ipcRenderer.invoke('csv:export', req),
  /** req : { project, name, options: { title, date } } — le script est régénéré par le processus principal. */
  exportScript: (req) => ipcRenderer.invoke('script:export', req),
  exportLog: (req) => ipcRenderer.invoke('log:export', req),
  /** req : { project, dryRun } */
  startRun: (req) => ipcRenderer.invoke('run:start', req),
  cancelRun: () => ipcRenderer.invoke('run:cancel'),
  onRunProgress: subscribe('run:progress'),
  showFile: (filePath) => ipcRenderer.invoke('file:show', String(filePath)),
  copy: (text) => ipcRenderer.invoke('clipboard:write', String(text)),
  info: () => ipcRenderer.invoke('app:info'),
  /** Relance en administrateur (fenêtre UAC) ; current : { project, filePath, name, dirty } repris par la nouvelle instance. */
  relaunchAsAdmin: (current) => ipcRenderer.invoke('admin:relaunch', current),
  getAlwaysAdmin: () => ipcRenderer.invoke('admin:getAlways'),
  setAlwaysAdmin: (value) => ipcRenderer.invoke('admin:setAlways', Boolean(value)),
  /** Au démarrage : { handoff (projet repris après une relance) | null, note (message) | null }. */
  takeStartup: () => ipcRenderer.invoke('app:takeStartup'),
  setDirty: (value) => ipcRenderer.send('app:dirty', Boolean(value)),
  closeNow: () => ipcRenderer.invoke('app:close'),
  onSaveThenClose: subscribe('app:save-then-close'),
  onDiscardDraft: subscribe('app:discard-draft'),
  /** Signale que l'interface est construite (fermeture de l'écran de démarrage). */
  uiReady: () => ipcRenderer.send('app:ui-ready'),
});
