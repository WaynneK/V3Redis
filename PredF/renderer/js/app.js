/*
 * app.js — Interface de PredF : barre latérale des outils, espace de travail, dépôt de fichiers,
 * raccourcis clavier, thème. Chaque outil est un module de ./tools (créé à sa première ouverture).
 */

import { api, $, h, icon, toast, initTooltip, initBusy, prepareFiles, pickFiles, plural } from './core.js';
import { initPdf } from './pdfview.js';
import * as merge from './tools/merge.js';
import * as organize from './tools/organize.js';
import * as split from './tools/split.js';
import * as images from './tools/images.js';
import * as exporter from './tools/export.js';
import * as compress from './tools/compress.js';
import * as stamp from './tools/stamp.js';
import * as assistant from './tools/assistant.js';

const TOOLS = [
  { id: 'merge', group: 'Assembler', name: 'Fusionner', hint: 'Plusieurs fichiers en un', title: 'Fusionner des PDF', desc: 'Assemblez des PDF et des images dans l\'ordre de votre choix, en gardant toutes les pages ou seulement certaines.', icon: 'merge', module: merge },
  { id: 'organize', group: 'Assembler', name: 'Organiser', hint: 'Ordre, rotation, suppression', title: 'Organiser les pages', desc: 'Déplacez, pivotez, dupliquez ou supprimez des pages, ajoutez des pages blanches, puis enregistrez.', icon: 'organize', module: organize },
  { id: 'split', group: 'Assembler', name: 'Découper', hint: 'Séparer en plusieurs fichiers', title: 'Découper un PDF', desc: 'Séparez un PDF en plusieurs fichiers ou extrayez seulement les pages utiles.', icon: 'split', module: split },
  { id: 'images', group: 'Convertir', name: 'Images → PDF', hint: 'Photos et scans en PDF', title: 'Images en PDF', desc: 'Transformez vos photos et images en un PDF propre, une image par page.', icon: 'images', module: images },
  { id: 'export', group: 'Convertir', name: 'PDF → Images', hint: 'Pages en images ou en texte', title: 'PDF en images ou en texte', desc: 'Enregistrez chaque page en image PNG ou JPEG, ou récupérez le texte du document.', icon: 'export', module: exporter },
  { id: 'compress', group: 'Améliorer', name: 'Compresser', hint: 'Alléger un PDF', title: 'Compresser un PDF', desc: 'Réduisez le poids d\'un PDF pour l\'envoyer ou l\'archiver, en comparant avant d\'enregistrer.', icon: 'compress', module: compress },
  { id: 'stamp', group: 'Améliorer', name: 'Finitions', hint: 'Numéros, filigrane, infos', title: 'Finitions', desc: 'Ajoutez des numéros de page ou un filigrane, et modifiez les propriétés du document.', icon: 'stamp', module: stamp },
  { id: 'assistant', group: 'Intelligence artificielle', name: 'Assistant IA', hint: 'Fusionner, résumer, simplifier', title: 'Assistant IA', desc: 'Demandez en langage courant ce qu\'il faut faire de vos documents : fusionner, résumer, simplifier, traduire… le résultat devient un PDF.', icon: 'sparkle', module: assistant },
];

const VIEW_KEY = 'predf.tool';
const instances = new Map(); // id → { el, accept, multiple, onFiles, onKey }
let current = null;

function instance(tool) {
  if (!instances.has(tool.id)) {
    const inst = tool.module.create();
    instances.set(tool.id, inst);
    $(`panel-${tool.id}`).append(inst.el);
  }
  return instances.get(tool.id);
}

function show(id) {
  const tool = TOOLS.find((t) => t.id === id) || TOOLS[0];
  current = tool;
  for (const t of TOOLS) {
    const on = t.id === tool.id;
    $(`tab-${t.id}`).setAttribute('aria-selected', String(on));
    $(`tab-${t.id}`).tabIndex = on ? 0 : -1;
    $(`panel-${t.id}`).hidden = !on;
  }
  $('tool-title').textContent = tool.title;
  $('tool-desc').textContent = tool.desc;
  $('tool-icon').replaceChildren(icon(tool.icon));
  $('tooltip').hidden = true;
  instance(tool);
  $('workspace').scrollTop = 0;
  try {
    localStorage.setItem(VIEW_KEY, tool.id);
  } catch {
    // préférence indisponible
  }
}

function buildSidebar() {
  const nav = $('tools');
  let group = null;
  for (const t of TOOLS) {
    if (t.group !== group) {
      group = t.group;
      nav.append(h('div', { class: 'nav-group', role: 'presentation' }, group));
    }
    const tab = h(
      'button',
      { type: 'button', role: 'tab', id: `tab-${t.id}`, class: 'nav-item', 'aria-controls': `panel-${t.id}`, 'aria-selected': 'false' },
      h('span', { class: 'nav-icon' }, icon(t.icon)),
      h('span', { class: 'nav-text' }, h('strong', null, t.name), h('small', null, t.hint))
    );
    tab.addEventListener('click', () => show(t.id));
    nav.append(tab);
    $('workspace-panels').append(h('section', { class: 'tool', id: `panel-${t.id}`, role: 'tabpanel', 'aria-labelledby': `tab-${t.id}`, hidden: true }));
  }
  // Flèches haut / bas entre les outils (motif ARIA « tablist » vertical)
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = TOOLS.indexOf(current);
    const next = TOOLS[(i + (e.key === 'ArrowDown' ? 1 : TOOLS.length - 1)) % TOOLS.length];
    show(next.id);
    $(`tab-${next.id}`).focus();
  });
}

// ---------------------------------------------------------------------------
// Fichiers déposés ou passés au lancement : vers l'outil courant, ou le plus adapté
// ---------------------------------------------------------------------------

function accepts(tool, file) {
  const inst = instance(tool);
  return inst.accept === 'all' || (inst.accept === 'pdf' && file.kind === 'pdf') || (inst.accept === 'images' && file.kind === 'image');
}

/** Outil le plus adapté quand l'outil courant ne prend pas ces fichiers. */
function bestTool(files) {
  const pdfs = files.filter((f) => f.kind === 'pdf').length;
  const imgs = files.length - pdfs;
  if (pdfs && imgs) return 'merge';
  if (imgs) return 'images';
  return pdfs > 1 ? 'merge' : 'organize';
}

async function deliver(rawFiles, { fromLaunch = false } = {}) {
  const files = await prepareFiles(rawFiles, 'all');
  if (!files.length) return;
  let tool = current;
  if (fromLaunch || !files.some((f) => accepts(tool, f))) {
    const target = TOOLS.find((t) => t.id === bestTool(files));
    if (target !== tool) {
      show(target.id);
      if (!fromLaunch) toast(`Ouvert dans « ${target.name} ».`);
    }
    tool = target;
  }
  const inst = instance(tool);
  const usable = files.filter((f) => accepts(tool, f));
  const unused = files.filter((f) => !usable.includes(f));
  const taken = inst.multiple ? usable : usable.slice(0, 1);
  const dropped = [...unused, ...usable.slice(taken.length)];
  if (dropped.length) {
    api.release(dropped.map((f) => f.id));
    toast(inst.multiple ? `${plural(dropped.length, 'fichier ignoré', 'fichiers ignorés')} (type non accepté ici).` : 'Un seul fichier à la fois dans cet outil : le premier a été ouvert.');
  }
  if (taken.length) inst.onFiles(taken);
}

function initDrop() {
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    $('drop-tool').textContent = current.name;
    document.body.classList.add('drop-active');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('drop-active');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('drop-active');
    const paths = [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean);
    if (!paths.length) {
      toast('Ces éléments ne sont pas des fichiers de l\'ordinateur : glissez-les depuis l\'Explorateur.', 'error');
      return;
    }
    const res = await api.add(paths);
    if (res && res.ok) deliver(res.files);
    else toast((res && res.error) || 'Fichiers illisibles.', 'error');
  });
}

async function openPending(fromLaunch) {
  const res = await api.pendingOpen();
  if (res && res.ok && res.files.length) deliver(res.files, { fromLaunch });
}

// ---------------------------------------------------------------------------
// Thème, raccourcis
// ---------------------------------------------------------------------------

const THEMES = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'Système', light: 'Clair', dark: 'Sombre' };

async function initTheme() {
  const btn = $('theme');
  let mode = 'system';
  try {
    const res = await api.getTheme();
    if (res && THEMES.includes(res.mode)) mode = res.mode;
  } catch {
    // thème système
  }
  const label = () => {
    btn.querySelector('span').textContent = `Thème : ${THEME_LABELS[mode].toLowerCase()}`;
  };
  label();
  btn.addEventListener('click', async () => {
    const next = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
    const res = await api.setTheme(next);
    if (res && res.ok) {
      mode = next;
      label();
    }
  });
}

function initKeys() {
  document.addEventListener('keydown', async (e) => {
    if (!$('busy').hidden) return; // traitement en cours
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (ctrl && /^[1-8]$/.test(e.key)) {
      e.preventDefault();
      show(TOOLS[Number(e.key) - 1].id);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      const inst = instance(current);
      const files = await pickFiles(inst.accept, inst.multiple);
      if (files.length) inst.onFiles(files);
      return;
    }
    const inst = instances.get(current.id);
    if (inst && inst.onKey && inst.onKey(e)) e.preventDefault();
  });
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function init() {
  initTooltip();
  initBusy();
  buildSidebar();
  initDrop();
  initKeys();
  initTheme();
  let saved = null;
  try {
    saved = localStorage.getItem(VIEW_KEY);
  } catch {
    // préférence indisponible
  }
  show(saved || 'merge');
  api.info().then((info) => {
    document.title = 'PredF';
    $('version').textContent = `PredF ${info.version}`;
  });
  api.onOpenFiles(() => openPending(true));

  // pdf.js chargé avant de quitter l'écran de chargement (la première miniature s'affiche aussitôt)
  try {
    await Promise.race([initPdf(), new Promise((_, reject) => setTimeout(() => reject(new Error('délai dépassé')), 10000))]);
  } catch (err) {
    console.error('[predf] pdf.js :', err);
    toast('Le moteur d\'affichage des PDF n\'a pas pu démarrer : les aperçus seront indisponibles.', 'error');
  }
  requestAnimationFrame(() => api.uiReady());
  openPending(true);
}

init();
