/*
 * preload.js — Pont minimal entre la page (isolée, sans Node) et le processus principal.
 * Les calculs eux-mêmes sont faits dans la page (lib/ipcalc.js) ; seuls passent ici les exports,
 * le presse-papiers et le thème.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calkip', {
  /**
   * Exporte la liste d'adresses en .txt.
   * req : { input, mode, dhcp: { gateway, customGateway, reserveStart, reserveEnd, exclusions }, scope: 'pool'|'usable', numbered }
   */
  exportList: (req) => ipcRenderer.invoke('export:list', req),
  /** Exporte le résumé (et, avec req.split = préfixe, la liste des sous-réseaux du découpage). */
  exportSummary: (req) => ipcRenderer.invoke('export:summary', req),
  /** Exporte le calcul binaire expliqué étape par étape. req : { ip: 'a.b.c.d', prefix } */
  exportBinary: (req) => ipcRenderer.invoke('export:binary', req),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, progress) => callback(progress || {});
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
  /** Ouvre l'explorateur sur un fichier exporté pendant cette session. */
  showFile: (filePath) => ipcRenderer.invoke('file:show', String(filePath)),
  copy: (text) => ipcRenderer.invoke('clipboard:write', String(text)),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (mode) => ipcRenderer.invoke('theme:set', String(mode)),
  info: () => ipcRenderer.invoke('app:info'),
  /** Signale que l'interface est construite (fermeture de l'écran de démarrage). */
  uiReady: () => ipcRenderer.send('app:ui-ready'),
});
