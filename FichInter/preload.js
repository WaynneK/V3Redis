/*
 * preload.js — Pont minimal entre la page (isolée, sans Node) et le processus principal :
 * thème, modèles, génération des fiches, fiches récentes, export PDF.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('fichinter', {
  getTheme: call('theme:get'),
  setTheme: (mode) => ipcRenderer.invoke('theme:set', String(mode)),
  /** { version, platform, dev, outDir, word } */
  info: call('app:info'),
  // Modèles (.docx livrés ou importés)
  listModels: call('models:list'),
  /** { ok, model: { id, name, builtin, hash, schema } } */
  getModel: (id) => ipcRenderer.invoke('models:get', String(id)),
  /** { ok, data: ArrayBuffer } : le modèle tel quel (miniature) */
  modelBytes: (id) => ipcRenderer.invoke('models:bytes', String(id)),
  importModel: call('models:import'),
  removeModel: (id) => ipcRenderer.invoke('models:remove', String(id)),
  // Fiches
  /** { ok, record, checks, data: ArrayBuffer } */
  generate: (modelId, values, replace) => ipcRenderer.invoke('fiche:generate', String(modelId), values, replace ? String(replace) : null),
  recent: call('fiche:recent'),
  /** { ok, record, inputs, data: ArrayBuffer } */
  readFiche: (id) => ipcRenderer.invoke('fiche:read', String(id)),
  forgetFiche: (id) => ipcRenderer.invoke('fiche:forget', String(id)),
  openFiche: (id) => ipcRenderer.invoke('fiche:open', String(id)),
  showFiche: (id) => ipcRenderer.invoke('fiche:show', String(id)),
  exportPdf: (id) => ipcRenderer.invoke('fiche:pdf', String(id)),
  printPdf: (id) => ipcRenderer.invoke('fiche:print-pdf', String(id)),
  openPdf: (file) => ipcRenderer.invoke('fiche:open-pdf', String(file)),
  // Réglages
  chooseOutDir: call('settings:out-dir'),
  openOutDir: call('settings:open-out-dir'),
  nextRef: call('ref:next'),
  /** Signale que l'interface est construite (fermeture de l'écran de démarrage). */
  uiReady: () => ipcRenderer.send('app:ui-ready'),
});
