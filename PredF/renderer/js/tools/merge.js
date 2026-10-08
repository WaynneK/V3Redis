/*
 * Fusionner — plusieurs PDF et images en un seul PDF, dans l'ordre choisi, avec une sélection de pages
 * par fichier.
 */

import { api, h, icon, button, segmented, plural, baseName, toast, check, showResult, withBusy, sortable, moveItems, imageUrl, pickFiles, formatBytes as formatSize } from '../core.js';
import { dropZone, docSummary, actionBar, optionGroup, pagesField } from '../components.js';
import { renderThumb } from '../pdfview.js';

export function create() {
  const state = {
    entries: [], // { key, file, pages: { pages, error } }
    layout: { size: 'A4', margin: 10 },
  };
  let seq = 0;

  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);

  function add(files) {
    for (const file of files) {
      state.entries.push({ key: `m${++seq}`, file, pages: { pages: null, error: null }, text: '' });
    }
    result.replaceChildren();
    render();
  }

  function remove(keys) {
    const set = new Set(keys);
    const gone = state.entries.filter((e) => set.has(e.key));
    state.entries = state.entries.filter((e) => !set.has(e.key));
    api.release(gone.map((e) => e.file.id));
    render();
  }

  function totalPages() {
    return state.entries.reduce((sum, e) => sum + (e.file.kind === 'pdf' ? (e.pages.pages ? e.pages.pages.length : 0) : 1), 0);
  }

  function row(entry, index) {
    const { file } = entry;
    let thumb;
    if (file.kind === 'pdf') {
      thumb = h('canvas', { class: 'row-thumb' });
      renderThumb(file.id, 0, thumb, { width: 44 }).catch(() => thumb.classList.add('failed'));
    } else {
      thumb = h('img', { class: 'row-thumb', alt: '', draggable: 'false' });
      imageUrl(file.id).then((url) => {
        thumb.src = url;
        thumb.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      });
    }
    let pagesCell;
    if (file.kind === 'pdf') {
      const field = pagesField({
        value: entry.text,
        count: () => file.pageCount,
        onChange: (s) => {
          entry.pages = { pages: s.pages, error: s.error };
          entry.text = field.input.value;
          updateBar();
        },
      });
      entry.pages = { pages: field.state.pages, error: field.state.error };
      pagesCell = field.el;
    } else {
      pagesCell = h('div', { class: 'pages-field static' }, h('span', { class: 'label' }, 'Pages'), h('span', { class: 'static-value' }, '1 page (image)'));
    }
    return h(
      'li',
      { class: 'file-row', draggable: 'true', 'data-key': entry.key },
      h('span', { class: 'row-handle', 'data-tip': 'Glisser pour réordonner' }, icon('drag')),
      h('span', { class: 'row-index' }, String(index + 1)),
      thumb,
      h('div', { class: 'row-meta' }, h('strong', { 'data-tip': file.path || null }, file.name), h('span', null, docSummary(file))),
      pagesCell,
      button('', { icon: 'trash', cls: 'icon-only ghost', tip: 'Retirer de la liste', onClick: () => remove([entry.key]) })
    );
  }

  let bar = null;
  let saveBtn = null;
  function updateBar() {
    if (!bar) return;
    const errors = state.entries.filter((e) => e.file.kind === 'pdf' && e.pages.error).length;
    const pages = totalPages();
    bar.querySelector('.action-summary').textContent = errors
      ? `${plural(errors, 'sélection')} de pages à corriger`
      : `${plural(state.entries.length, 'fichier')} · ${plural(pages, 'page')} au total`;
    saveBtn.disabled = Boolean(errors) || pages === 0 || state.entries.length === 0;
  }

  function render() {
    if (!state.entries.length) {
      bar = null;
      body.replaceChildren(
        dropZone({ kind: 'all', multiple: true, title: 'Déposez vos PDF et images ici', hint: 'ou cliquez pour les choisir — ils seront assemblés dans l\'ordre de la liste', onFiles: add })
      );
      return;
    }
    const list = h('ol', { class: 'file-list' }, state.entries.map(row));
    sortable(list, {
      axis: 'y',
      onMove: (keys, to) => {
        state.entries = moveItems(state.entries, keys, to, (e) => e.key);
        render();
      },
    });
    const hasImages = state.entries.some((e) => e.file.kind === 'image');
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      button('Ajouter des fichiers', {
        icon: 'plus',
        onClick: async () => {
          const files = await pickFiles('all', true);
          if (files.length) add(files);
        },
      }),
      button('Trier par nom', {
        icon: 'sort',
        cls: 'ghost',
        onClick: () => {
          state.entries.sort((a, b) => a.file.name.localeCompare(b.file.name, 'fr', { numeric: true, sensitivity: 'base' }));
          render();
        },
      }),
      h('span', { class: 'spacer' }),
      button('Tout retirer', { icon: 'trash', cls: 'ghost danger', onClick: () => remove(state.entries.map((e) => e.key)) })
    );
    const options = hasImages
      ? h(
          'div',
          { class: 'options-row' },
          optionGroup(
            'Pages des images',
            segmented(
              [
                ['A4', 'A4'],
                ['fit', 'Taille de l\'image', 'Page aux proportions de l\'image'],
                ['Letter', 'Letter'],
              ],
              state.layout.size,
              (v) => (state.layout.size = v),
              { compact: true }
            ).el
          ),
          optionGroup(
            'Marges',
            segmented(
              [
                [0, 'Aucune'],
                [10, 'Petites'],
                [20, 'Normales'],
              ],
              state.layout.margin,
              (v) => (state.layout.margin = v),
              { compact: true }
            ).el
          )
        )
      : null;
    saveBtn = button('Fusionner et enregistrer', { icon: 'merge', cls: 'primary', onClick: save });
    bar = actionBar('', saveBtn);
    body.replaceChildren(...[toolbar, h('p', { class: 'hint' }, 'Glissez les lignes pour changer l\'ordre. Laissez « Pages » vide pour garder tout le fichier.'), list, options, bar].filter(Boolean));
    updateBar();
  }

  async function save() {
    const items = [];
    for (const e of state.entries) {
      if (e.file.kind === 'pdf') {
        if (e.pages.error) {
          toast(`${e.file.name} : ${e.pages.error}`, 'error');
          return;
        }
        for (const index of e.pages.pages) items.push({ type: 'page', src: e.file.id, index });
      } else {
        items.push({ type: 'image', src: e.file.id, layout: { size: state.layout.size, orientation: 'auto', margin: state.layout.margin } });
      }
    }
    const first = state.entries[0].file;
    const res = await withBusy('Fusion en cours…', () => api.savePdf({ items, suggestedName: `${baseName(first.name)}_fusion.pdf`, hintId: first.id }));
    if (check(res)) showResult(result, res, { title: 'PDF fusionné enregistré', detail: `${plural(res.pages, 'page')} · ${formatSize(res.size)}` });
  }

  render();
  return { el: root, accept: 'all', multiple: true, onFiles: add };
}
