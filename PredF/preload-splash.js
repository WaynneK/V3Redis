/*
 * preload-splash.js — Pont minimal de l'écran de chargement : il reçoit uniquement des messages
 * (version, progression, fin). Il n'envoie rien au processus principal.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  if (typeof callback !== 'function') return;
  ipcRenderer.on(channel, (_event, data) => callback(data));
};

contextBridge.exposeInMainWorld('splash', {
  onInit: listen('splash:init'), // { version }
  onProgress: listen('splash:progress'), // { done, total, label }
  onDone: listen('splash:done'),
});
