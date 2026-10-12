/*
 * preload.js — Pont minimal entre la page (isolée, sans Node) et le processus principal :
 * thème, version, fin de chargement, résumés PDF (liste, aperçu, visionneuse, téléchargement).
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cours', {
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (mode) => ipcRenderer.invoke('theme:set', String(mode)),
  info: () => ipcRenderer.invoke('app:info'),
  // Résumés PDF (dossier pdfs/<partie>/)
  /** { [partId]: [{ file, size, mtime }] } */
  listDocuments: () => ipcRenderer.invoke('docs:list'),
  /** { ok, data: ArrayBuffer } : contenu du PDF, pour l'aperçu de sa première page */
  readDocument: (partId, file) => ipcRenderer.invoke('docs:read', String(partId), String(file)),
  /** Ouvre le PDF dans la visionneuse */
  openDocument: (partId, file, title, page) => ipcRenderer.invoke('docs:open', String(partId), String(file), String(title || ''), Number(page) || 0),
  /** Enregistre une copie du PDF (boîte « Enregistrer sous ») */
  saveDocument: (partId, file) => ipcRenderer.invoke('docs:save', String(partId), String(file)),
  /** Développement : ouvre le dossier où déposer les PDF de la partie */
  openFolder: (partId) => ipcRenderer.invoke('docs:folder', String(partId)),
  /** Signale que l'interface est construite (fermeture de l'écran de démarrage). */
  uiReady: () => ipcRenderer.send('app:ui-ready'),
});
