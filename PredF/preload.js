/*
 * preload.js — Pont minimal entre la page (isolée, sans Node) et le processus principal.
 * La page désigne les fichiers par un identifiant ; seul le processus principal lit et écrit sur le disque.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('predf', {
  // Fichiers
  open: invoke('files:open'), // ({ kind: 'pdf' | 'images' | 'all', multiple }) → { files }
  add: invoke('files:add'), // (chemins) → { files }
  /**
   * Chemin sur le disque d'un fichier déposé dans la fenêtre. Un File à la fois : une FileList ne
   * traverse pas le pont contextBridge (elle arriverait vide).
   */
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  bytes: invoke('files:bytes'),
  release: invoke('files:release'),
  replaceImage: invoke('files:replaceImage'),
  pendingOpen: invoke('app:pendingOpen'),
  onOpenFiles: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('app:openFiles', () => callback());
  },

  // Création
  savePdf: invoke('pdf:save'), // ({ items, suggestedName, hintId, title })
  split: invoke('pdf:split'), // ({ groups: [{ name, items }], hintId })
  rasterStart: invoke('raster:start'),
  rasterAdd: invoke('raster:add'),
  rasterFinish: invoke('raster:finish'),
  rasterCancel: invoke('raster:cancel'),
  optimize: invoke('optimize:run'),
  savePending: invoke('pending:save'),
  releasePending: invoke('pending:release'),
  stampPreview: invoke('stamp:preview'),
  stampSave: invoke('stamp:save'),
  chooseExportDir: invoke('export:chooseDir'),
  writeExport: invoke('export:write'),
  saveText: invoke('export:text'),
  onProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, p) => callback(p || {});
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },

  // Assistant IA
  aiStatus: invoke('ai:status'),
  aiSaveKey: invoke('ai:saveKey'),
  aiRemoveKey: invoke('ai:removeKey'),
  aiRun: invoke('ai:run'), // ({ fileIds, instruction, model }) → { jobId }
  aiCancel: invoke('ai:cancel'),
  aiSavePdf: invoke('ai:savePdf'),
  aiLocalStatus: invoke('ai:localStatus'),
  aiLocalPull: invoke('ai:localPull'), // (modèle) → { jobId } ; arrêt avec aiCancel(jobId)
  onAiPullProgress: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('ai:pullProgress', (_event, p) => callback(p || {}));
  },
  onAiPullDone: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('ai:pullDone', (_event, p) => callback(p || {}));
  },
  openUrl: invoke('app:openUrl'),
  aiSaveText: invoke('ai:saveText'),
  onAiDelta: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('ai:delta', (_event, p) => callback(p || {}));
  },
  onAiPhase: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('ai:phase', (_event, p) => callback(p || {}));
  },
  onAiDone: (callback) => {
    if (typeof callback === 'function') ipcRenderer.on('ai:done', (_event, p) => callback(p || {}));
  },

  // Divers
  openFile: invoke('file:open'),
  showFile: invoke('file:show'),
  copy: invoke('clipboard:write'),
  getTheme: invoke('theme:get'),
  setTheme: invoke('theme:set'),
  info: invoke('app:info'),
  /** L'interface est construite et pdf.js chargé : l'écran de chargement peut laisser la place. */
  uiReady: () => ipcRenderer.send('app:ui-ready'),
});
