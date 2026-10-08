/*
 * components.js — Briques d'interface communes aux outils : zone de dépôt, en-tête de document,
 * carte de miniature, barre d'actions du bas.
 */

import { h, icon, button, fmt, formatBytes, plural, pickFiles } from './core.js';
import { renderThumb } from './pdfview.js';

const KIND_TEXT = {
  pdf: { one: 'un PDF', many: 'des PDF', formats: 'PDF' },
  images: { one: 'une image', many: 'des images', formats: 'JPEG, PNG, WebP, GIF, BMP' },
  all: { one: 'un fichier', many: 'des PDF et des images', formats: 'PDF, JPEG, PNG, WebP, GIF, BMP' },
};

/** Grande zone d'accueil d'un outil : déposer des fichiers ou cliquer pour les choisir. */
export function dropZone({ kind = 'pdf', multiple = false, title, hint, onFiles }) {
  const t = KIND_TEXT[kind];
  const zone = h(
    'button',
    { type: 'button', class: 'dropzone', 'aria-label': title || `Choisir ${multiple ? t.many : t.one}` },
    h('span', { class: 'dz-icon' }, icon(kind === 'images' ? 'images' : 'file')),
    h('strong', null, title || `Déposez ${multiple ? t.many : t.one} ici`),
    h('span', { class: 'dz-hint' }, hint || 'ou cliquez pour parcourir vos dossiers'),
    h('span', { class: 'dz-formats' }, t.formats)
  );
  zone.addEventListener('click', async () => {
    const files = await pickFiles(kind, multiple);
    if (files.length) onFiles(files);
  });
  return zone;
}

/** Résumé d'un PDF ouvert : « 12 pages · A4 portrait · 2,3 Mo ». */
export function docSummary(file) {
  if (file.kind !== 'pdf') return [file.image ? `${fmt(file.image.displayWidth)} × ${fmt(file.image.displayHeight)} px` : 'Image', formatBytes(file.size)].join(' · ');
  return [plural(file.pageCount, 'page'), file.info && file.info.format, formatBytes(file.size)].filter(Boolean).join(' · ');
}

/** En-tête d'un document ouvert dans un outil : vignette de la 1re page, nom, résumé, bouton Changer. */
export function docHeader(file, { onChange, onClose, kind = 'pdf', extra } = {}) {
  const canvas = h('canvas', { class: 'doc-thumb', 'aria-hidden': 'true' });
  renderThumb(file.id, 0, canvas, { width: 46 }).catch(() => canvas.classList.add('failed'));
  return h(
    'div',
    { class: 'doc-header' },
    canvas,
    h('div', { class: 'doc-meta' }, h('strong', { 'data-tip': file.path || null }, file.name), h('span', null, docSummary(file))),
    extra || null,
    h(
      'div',
      { class: 'doc-actions' },
      onChange
        ? button('Changer', {
            icon: 'file',
            cls: 'small ghost',
            tip: 'Ouvrir un autre fichier',
            onClick: async () => {
              const files = await pickFiles(kind, false);
              if (files.length) onChange(files);
            },
          })
        : null,
      onClose ? button('', { icon: 'close', cls: 'icon-only ghost', tip: 'Fermer ce fichier', onClick: onClose }) : null
    )
  );
}

/** Barre collée en bas de l'outil : résumé à gauche, actions à droite. */
export function actionBar(summary, ...actions) {
  return h('div', { class: 'action-bar' }, h('div', { class: 'action-summary' }, summary), h('div', { class: 'action-buttons' }, actions));
}

/** Panneau d'options (titre + contenu). */
export function optionGroup(title, ...content) {
  return h('div', { class: 'option-group' }, title ? h('span', { class: 'label' }, title) : null, content);
}

/** Champ texte « Pages » avec vérification en direct (texte d'aide ou erreur sous le champ). */
export function pagesField({ value = '', count, placeholder = 'Toutes (ex. 1-3, 5, 8-fin)', onChange, label = 'Pages' }) {
  const input = h('input', { type: 'text', class: 'pages-input', value, placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
  const note = h('span', { class: 'field-note' });
  const state = { pages: null, error: null };
  // onChange n'est appelé qu'aux saisies (pas à la création : l'appelant lit field.state)
  const validate = (notify = true) => {
    try {
      state.pages = window.PageRanges.parsePageList(input.value, count());
      state.error = null;
      note.textContent = input.value.trim() ? plural(state.pages.length, 'page') : '';
      note.classList.remove('error');
      input.classList.remove('invalid');
    } catch (err) {
      state.pages = null;
      state.error = err.message;
      note.textContent = err.message;
      note.classList.add('error');
      input.classList.add('invalid');
    }
    if (notify && onChange) onChange(state);
  };
  input.addEventListener('input', () => validate());
  validate(false);
  return { el: h('label', { class: 'pages-field' }, h('span', { class: 'label' }, label), input, note), input, state, validate };
}
