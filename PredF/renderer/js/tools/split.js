/*
 * Découper — un PDF en plusieurs fichiers : toutes les N pages, par plages, une page par fichier,
 * ou extraction de certaines pages dans un seul fichier. Aperçu coloré des fichiers créés.
 */

import { api, h, segmented, plural, baseName, check, showResult, withBusy, formatBytes, fmt } from '../core.js';
import { dropZone, docHeader, actionBar, optionGroup, pagesField } from '../components.js';
import { renderThumb, lazyThumbs, forget } from '../pdfview.js';

const GROUP_COLORS = 8;

export function create() {
  const state = { file: null, mode: 'every', every: 1, ranges: '', extract: '' };
  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);
  let lazy = null;

  function open(files) {
    const f = files.find((x) => x.kind === 'pdf');
    if (!f) return;
    if (state.file) {
      api.release([state.file.id]);
      forget(state.file.id);
    }
    state.file = f;
    state.every = Math.min(2, f.pageCount) || 1;
    state.ranges = '';
    state.extract = '';
    result.replaceChildren();
    render();
  }

  function close() {
    api.release([state.file.id]);
    forget(state.file.id);
    state.file = null;
    result.replaceChildren();
    render();
  }

  /** { groups: [[indices]…], error } selon le mode choisi. */
  function plan() {
    const count = state.file.pageCount;
    const R = window.PageRanges;
    try {
      if (state.mode === 'every') return { groups: R.chunk(count, state.every) };
      if (state.mode === 'each') return { groups: R.chunk(count, 1) };
      if (state.mode === 'ranges') return state.ranges.trim() ? { groups: R.parseGroups(state.ranges, count) } : { groups: [], error: 'Indiquez les plages : chaque élément séparé par une virgule devient un fichier.' };
      return state.extract.trim() ? { groups: [R.parsePageList(state.extract, count)] } : { groups: [], error: 'Indiquez les pages à extraire.' };
    } catch (err) {
      return { groups: [], error: err.message };
    }
  }

  const partName = (i, total) => `${baseName(state.file.name)}_partie-${String(i + 1).padStart(String(total).length, '0')}`;

  let preview = null;
  let strip = null;
  let bar = null;
  let runBtn = null;

  function updatePreview() {
    const p = plan();
    const groups = p.groups;
    // Couleur de groupe de chaque page (extraction : pages gardées / ignorées)
    const owner = new Map();
    groups.forEach((g, gi) => g.forEach((i) => !owner.has(i) && owner.set(i, gi)));
    [...strip.children].forEach((card, i) => {
      const g = owner.get(i);
      card.className = `strip-card${g === undefined ? ' ignored' : ` g${g % GROUP_COLORS}`}`;
      card.querySelector('.grp').textContent = g === undefined ? '' : state.mode === 'extract' ? '✓' : String(g + 1);
    });
    if (p.error) {
      preview.replaceChildren(h('p', { class: 'field-note error' }, p.error));
    } else if (state.mode === 'extract') {
      preview.replaceChildren(h('div', { class: 'out-row g0' }, h('span', { class: 'dot' }), h('strong', null, `${baseName(state.file.name)}_extrait.pdf`), h('span', null, `${plural(groups[0].length, 'page')} : ${window.PageRanges.formatList(groups[0])}`)));
    } else {
      const shown = groups.slice(0, 40);
      preview.replaceChildren(
        ...shown.map((g, i) => h('div', { class: `out-row g${i % GROUP_COLORS}` }, h('span', { class: 'dot' }), h('strong', null, `${partName(i, groups.length)}.pdf`), h('span', null, `${plural(g.length, 'page')} : ${window.PageRanges.formatList(g)}`))),
        ...(groups.length > shown.length ? [h('p', { class: 'hint' }, `… et ${fmt(groups.length - shown.length)} autres fichiers.`)] : [])
      );
    }
    const n = groups.length;
    bar.querySelector('.action-summary').textContent = p.error ? 'Réglage à compléter' : state.mode === 'extract' ? `1 fichier · ${plural(groups[0].length, 'page')}` : `${plural(n, 'fichier')} à créer`;
    runBtn.disabled = Boolean(p.error) || !n;
    runBtn.querySelector('span').textContent = state.mode === 'extract' ? 'Extraire et enregistrer' : `Découper en ${plural(n, 'fichier')}`;
  }

  function modeInput() {
    if (state.mode === 'every') {
      const input = h('input', { type: 'number', min: '1', max: String(state.file.pageCount), step: '1', value: String(state.every), class: 'num-input', 'aria-label': 'Nombre de pages par fichier' });
      input.addEventListener('input', () => {
        const n = Number(input.value);
        if (Number.isInteger(n) && n >= 1) {
          state.every = Math.min(n, state.file.pageCount);
          input.classList.remove('invalid');
          updatePreview();
        } else input.classList.add('invalid');
      });
      return h('label', { class: 'inline-field' }, h('span', null, 'Un fichier toutes les'), input, h('span', null, 'pages'));
    }
    if (state.mode === 'ranges') {
      const input = h('input', { type: 'text', value: state.ranges, placeholder: 'ex. 1-3, 4-8, 9-fin', class: 'pages-input wide', spellcheck: 'false', 'aria-label': 'Plages' });
      input.addEventListener('input', () => {
        state.ranges = input.value;
        updatePreview();
      });
      return h('label', { class: 'pages-field' }, h('span', { class: 'label' }, 'Plages (une par fichier, séparées par des virgules)'), input);
    }
    if (state.mode === 'extract') {
      const field = pagesField({
        value: state.extract,
        count: () => state.file.pageCount,
        placeholder: 'ex. 1, 3-5, paires',
        label: 'Pages à extraire (dans un seul fichier)',
        onChange: () => {
          state.extract = field.input.value;
          updatePreview();
        },
      });
      return field.el;
    }
    return h('p', { class: 'hint' }, `Chaque page devient un fichier : ${plural(state.file.pageCount, 'fichier')}.`);
  }

  function render() {
    if (lazy) lazy.disconnect();
    lazy = null;
    if (!state.file) {
      body.replaceChildren(dropZone({ kind: 'pdf', title: 'Déposez le PDF à découper', onFiles: open }));
      return;
    }
    lazy = lazyThumbs(null);
    const inputHolder = h('div', { class: 'mode-input' }, modeInput());
    const modes = segmented(
      [
        ['every', 'Toutes les N pages'],
        ['ranges', 'Par plages'],
        ['each', 'Une page par fichier'],
        ['extract', 'Extraire des pages'],
      ],
      state.mode,
      (v) => {
        state.mode = v;
        inputHolder.replaceChildren(modeInput());
        updatePreview();
        const first = inputHolder.querySelector('input');
        if (first) first.focus();
      }
    );
    strip = h(
      'ol',
      { class: 'strip' },
      Array.from({ length: state.file.pageCount }, (_, i) => {
        const canvas = h('canvas');
        const card = h('li', { class: 'strip-card' }, h('div', { class: 'thumb' }, canvas), h('span', { class: 'grp' }), h('span', { class: 'num' }, String(i + 1)));
        lazy.add(canvas, () => renderThumb(state.file.id, i, canvas, { width: 90 }));
        return card;
      })
    );
    preview = h('div', { class: 'out-list' });
    runBtn = h('button', { type: 'button', class: 'btn primary' }, h('span', null, 'Découper'));
    runBtn.addEventListener('click', run);
    bar = actionBar('', runBtn);
    body.replaceChildren(
      docHeader(state.file, { onChange: open, onClose: close }),
      h('div', { class: 'panel' }, optionGroup('Mode', modes.el), inputHolder, optionGroup('Fichiers créés', preview)),
      strip,
      bar
    );
    updatePreview();
  }

  async function run() {
    const p = plan();
    if (p.error || !p.groups.length) return;
    const file = state.file;
    if (state.mode === 'extract') {
      const items = p.groups[0].map((index) => ({ type: 'page', src: file.id, index }));
      const res = await withBusy('Extraction…', () => api.savePdf({ items, suggestedName: `${baseName(file.name)}_extrait.pdf`, hintId: file.id }));
      if (check(res)) showResult(result, res, { title: 'Pages extraites', detail: `${plural(res.pages, 'page')} · ${formatBytes(res.size)}` });
      return;
    }
    const groups = p.groups.map((g, i) => ({ name: partName(i, p.groups.length), items: g.map((index) => ({ type: 'page', src: file.id, index })) }));
    const res = await withBusy('Découpe en cours…', () => api.split({ groups, hintId: file.id }));
    if (check(res)) {
      const total = res.files.reduce((s, f) => s + f.size, 0);
      showResult(result, res, { title: `${plural(res.files.length, 'fichier créé', 'fichiers créés')}`, detail: `${formatBytes(total)} au total`, folder: res.dir });
    }
  }

  render();
  return { el: root, accept: 'pdf', multiple: false, onFiles: open };
}
