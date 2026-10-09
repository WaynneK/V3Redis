/*
 * preload.js — Pont minimal entre la page (isolée, sans Node) et le processus principal :
 * thème, version, fin de chargement. Le contenu des cours est lu directement par la page (lib/content.js).
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cours', {
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (mode) => ipcRenderer.invoke('theme:set', String(mode)),
  info: () => ipcRenderer.invoke('app:info'),
  /** Signale que l'interface est construite (fermeture de l'écran de démarrage). */
  uiReady: () => ipcRenderer.send('app:ui-ready'),
});
