/*
 * Organiser — les pages d'un ou plusieurs PDF en miniatures : réordonner (glisser), pivoter, dupliquer,
 * supprimer, insérer des pages blanches, annuler / rétablir, puis enregistrer ou extraire la sélection.
 */

import { api, h, icon, button, plural, baseName, check, showResult, withBusy, sortable, moveItems, pickFiles, formatBytes, toast } from '../core.js';
import { dropZone, actionBar } from '../components.js';
import { renderThumb, lazyThumbs } from '../pdfview.js';

const SIZE_KEY = 'predf.thumbSize';

export function create() {
  const state = {
    sources: new Map(), // id → fichier
    pages: [], // { key, src, index, rotate, blank? }
    selected: new Set(),
    anchor: null,
    undo: [],
    redo: [],
  };
  let seq = 0;
  const cards = new Map(); // clé → élément
  let lazy = null;

  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);

  let size = 150;
  try {
    size = Math.min(240, Math.max(100, Number(localStorage.getItem(SIZE_KEY)) || 150));
  } catch {
    // préférence indisponible
  }

  // ---------------------------------------------------------------- Historique

  const snapshot = () => state.pages.map((p) => ({ ...p }));
  function commit(change) {
    state.undo.push(snapshot());
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    change();
    result.replaceChildren();
    render();
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    state.pages = state.undo.pop();
    pruneSelection();
    render();
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    state.pages = state.redo.pop();
    pruneSelection();
    render();
  }
  function pruneSelection() {
    const keys = new Set(state.pages.map((p) => p.key));
    for (const k of [...state.selected]) if (!keys.has(k)) state.selected.delete(k);
  }

  // ---------------------------------------------------------------- Actions

  function addFiles(files) {
    const pdfs = files.filter((f) => f.kind === 'pdf');
    if (!pdfs.length) return;
    const wasEmpty = !state.pages.length;
    const insert = () => {
      for (const f of pdfs) {
        state.sources.set(f.id, f);
        for (let i = 0; i < f.pageCount; i++) state.pages.push({ key: `p${++seq}`, src: f.id, index: i, rotate: 0 });
      }
    };
    if (wasEmpty) {
      insert();
      result.replaceChildren();
      render();
    } else {
      commit(insert);
      toast(`${plural(pdfs.reduce((s, f) => s + f.pageCount, 0), 'page ajoutée', 'pages ajoutées')} à la fin.`);
    }
  }

  const selection = () => state.pages.filter((p) => state.selected.has(p.key));

  function rotate(delta) {
    if (!state.selected.size) return;
    // Les miniatures pivotées sont redessinées par render() (rotation différente de celle affichée)
    commit(() => {
      for (const p of state.pages) if (state.selected.has(p.key)) p.rotate = (p.rotate + delta + 360) % 360;
    });
  }

  function removeSelected() {
    if (!state.selected.size) return;
    if (state.selected.size === state.pages.length) {
      toast('Le document doit garder au moins une page.', 'error');
      return;
    }
    commit(() => {
      state.pages = state.pages.filter((p) => !state.selected.has(p.key));
      state.selected.clear();
    });
  }

  function duplicateSelected() {
    if (!state.selected.size) return;
    commit(() => {
      const out = [];
      const fresh = [];
      for (const p of state.pages) {
        out.push(p);
        if (state.selected.has(p.key)) {
          const copy = { ...p, key: `p${++seq}` };
          out.push(copy);
          fresh.push(copy.key);
        }
      }
      state.pages = out;
      state.selected = new Set(fresh);
    });
  }

  function insertBlank() {
    commit(() => {
      const sel = selection();
      const after = sel.length ? state.pages.indexOf(sel[sel.length - 1]) : state.pages.length - 1;
      const blank = { key: `p${++seq}`, blank: true, rotate: 0 };
      state.pages.splice(after + 1, 0, blank);
      state.selected = new Set([blank.key]);
      state.anchor = blank.key;
    });
  }

  function reverse() {
    commit(() => state.pages.reverse());
  }

  function selectAll() {
    state.selected = new Set(state.pages.map((p) => p.key));
    updateSelection();
  }

  function clickCard(e, key) {
    if (e.shiftKey && state.anchor) {
      const keys = state.pages.map((p) => p.key);
      const [a, b] = [keys.indexOf(state.anchor), keys.indexOf(key)].sort((x, y) => x - y);
      if (!(e.ctrlKey || e.metaKey)) state.selected.clear();
      for (let i = a; i <= b; i++) state.selected.add(keys[i]);
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
      state.anchor = key;
    } else {
      state.selected = new Set([key]);
      state.anchor = key;
    }
    updateSelection();
  }

  function itemsOf(pages) {
    return pages.map((p) => (p.blank ? { type: 'blank', rotate: p.rotate } : { type: 'page', src: p.src, index: p.index, rotate: p.rotate }));
  }

  function firstSource() {
    return [...state.sources.values()][0];
  }

  async function save() {
    const first = firstSource();
    const res = await withBusy('Enregistrement…', () => api.savePdf({ items: itemsOf(state.pages), suggestedName: `${baseName(first.name)}_organise.pdf`, hintId: first.id }));
    if (check(res)) showResult(result, res, { title: 'PDF enregistré', detail: `${plural(res.pages, 'page')} · ${formatBytes(res.size)}` });
  }

  async function extract() {
    const sel = selection();
    if (!sel.length) return;
    const first = firstSource();
    const res = await withBusy('Extraction…', () => api.savePdf({ items: itemsOf(sel), suggestedName: `${baseName(first.name)}_extrait.pdf`, hintId: first.id }));
    if (check(res)) showResult(result, res, { title: 'Sélection extraite', detail: `${plural(res.pages, 'page')} · ${formatBytes(res.size)}` });
  }

  function closeAll() {
    api.release([...state.sources.keys()]);
    state.sources.clear();
    state.pages = [];
    state.selected.clear();
    state.undo = [];
    state.redo = [];
    cards.clear();
    result.replaceChildren();
    render();
  }

  // ---------------------------------------------------------------- Affichage

  function drawThumb(card, page) {
    const holder = card.querySelector('.thumb');
    if (page.blank) {
      holder.replaceChildren(h('div', { class: `blank-page${page.rotate % 180 ? ' landscape' : ''}` }, 'Page blanche'));
      return;
    }
    const canvas = h('canvas');
    holder.replaceChildren(canvas);
    lazy.add(canvas, () => renderThumb(page.src, page.index, canvas, { width: 200, extraRotate: page.rotate }));
  }

  function makeCard(page) {
    const card = h(
      'li',
      { class: 'page-card', draggable: 'true', 'data-key': page.key, tabindex: '0' },
      h('div', { class: 'thumb' }),
      h(
        'div',
        { class: 'card-tools' },
        button('', { icon: 'rotateL', cls: 'icon-only', tip: 'Pivoter à gauche', onClick: () => onlyThen(page.key, () => rotate(270)) }),
        button('', { icon: 'rotateR', cls: 'icon-only', tip: 'Pivoter à droite', onClick: () => onlyThen(page.key, () => rotate(90)) }),
        button('', { icon: 'trash', cls: 'icon-only danger', tip: 'Supprimer', onClick: () => onlyThen(page.key, removeSelected) })
      ),
      h('div', { class: 'card-foot' }, h('span', { class: 'num' }), h('span', { class: 'src' })),
      h('span', { class: 'card-check', 'aria-hidden': 'true' }, icon('check'))
    );
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-tools')) return;
      clickCard(e, page.key);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        clickCard(e, page.key);
      }
    });
    drawThumb(card, page);
    return card;
  }

  /** Les petits boutons d'une carte agissent sur cette page seule si elle n'est pas dans la sélection. */
  function onlyThen(key, fn) {
    if (!state.selected.has(key)) {
      state.selected = new Set([key]);
      state.anchor = key;
    }
    fn();
  }

  let grid = null;
  let bar = null;
  let selButtons = [];
  let undoBtn = null;
  let redoBtn = null;
  let extractBtn = null;

  function updateSelection() {
    for (const [key, card] of cards) {
      const on = state.selected.has(key);
      card.classList.toggle('selected', on);
      card.setAttribute('aria-selected', String(on));
    }
    const n = state.selected.size;
    selButtons.forEach((b) => (b.disabled = n === 0));
    if (extractBtn) extractBtn.disabled = n === 0;
    if (undoBtn) undoBtn.disabled = !state.undo.length;
    if (redoBtn) redoBtn.disabled = !state.redo.length;
    if (bar) {
      const sources = state.sources.size;
      bar.querySelector('.action-summary').textContent = `${plural(state.pages.length, 'page')}${sources > 1 ? ` · ${plural(sources, 'fichier')}` : ''}${n ? ` · ${plural(n, 'sélectionnée', 'sélectionnées')}` : ''}`;
    }
  }

  function render() {
    if (!state.pages.length) {
      if (lazy) lazy.disconnect();
      lazy = null;
      grid = null;
      bar = null;
      body.replaceChildren(dropZone({ kind: 'pdf', multiple: true, title: 'Déposez un PDF à organiser', hint: 'ou cliquez pour le choisir — plusieurs PDF sont mis bout à bout', onFiles: addFiles }));
      return;
    }
    if (!grid) {
      lazy = lazyThumbs(null);
      grid = h('ol', { class: 'page-grid', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Pages' });
      sortable(grid, {
        onMove: (keys, to) => commit(() => (state.pages = moveItems(state.pages, keys, to, (p) => p.key))),
        selectedKeys: () => [...state.selected],
      });
      const sizeInput = h('input', { type: 'range', min: '100', max: '240', step: '10', value: String(size), class: 'size-range', 'aria-label': 'Taille des miniatures' });
      sizeInput.addEventListener('input', () => {
        size = Number(sizeInput.value);
        grid.style.setProperty('--thumb', `${size}px`);
        try {
          localStorage.setItem(SIZE_KEY, String(size));
        } catch {
          // préférence indisponible
        }
      });
      grid.style.setProperty('--thumb', `${size}px`);
      const rotL = button('', { icon: 'rotateL', cls: 'icon-only', tip: 'Pivoter à gauche (Maj + R)', onClick: () => rotate(270) });
      const rotR = button('', { icon: 'rotateR', cls: 'icon-only', tip: 'Pivoter à droite (R)', onClick: () => rotate(90) });
      const dup = button('', { icon: 'copy', cls: 'icon-only', tip: 'Dupliquer', onClick: duplicateSelected });
      const del = button('', { icon: 'trash', cls: 'icon-only danger', tip: 'Supprimer (Suppr)', onClick: removeSelected });
      selButtons = [rotL, rotR, dup, del];
      undoBtn = button('', { icon: 'undo', cls: 'icon-only', tip: 'Annuler (Ctrl + Z)', onClick: undo });
      redoBtn = button('', { icon: 'redo', cls: 'icon-only', tip: 'Rétablir (Ctrl + Y)', onClick: redo });
      const toolbar = h(
        'div',
        { class: 'toolbar' },
        button('Ajouter un PDF', {
          icon: 'plus',
          onClick: async () => {
            const files = await pickFiles('pdf', true);
            if (files.length) addFiles(files);
          },
        }),
        h('span', { class: 'sep' }),
        button('', { icon: 'select', cls: 'icon-only', tip: 'Tout sélectionner (Ctrl + A)', onClick: selectAll }),
        rotL,
        rotR,
        dup,
        button('', { icon: 'blank', cls: 'icon-only', tip: 'Insérer une page blanche', onClick: insertBlank }),
        del,
        button('', { icon: 'reverse', cls: 'icon-only', tip: 'Inverser l\'ordre des pages', onClick: reverse }),
        h('span', { class: 'sep' }),
        undoBtn,
        redoBtn,
        h('span', { class: 'spacer' }),
        h('label', { class: 'size-control', 'data-tip': 'Taille des miniatures' }, icon('organize'), sizeInput),
        button('', { icon: 'close', cls: 'icon-only ghost', tip: 'Fermer et recommencer', onClick: closeAll })
      );
      extractBtn = button('Extraire la sélection', { icon: 'extract', tip: 'Enregistre seulement les pages sélectionnées', onClick: extract });
      bar = actionBar('', extractBtn, button('Enregistrer le PDF', { icon: 'check', cls: 'primary', onClick: save }));
      body.replaceChildren(toolbar, h('p', { class: 'hint' }, 'Cliquez pour sélectionner (Ctrl : plusieurs, Maj : une plage), glissez pour déplacer.'), grid, bar);
    }

    // Réconciliation par clé : les cartes existantes (et leurs miniatures) sont déplacées, pas recréées
    const keys = new Set(state.pages.map((p) => p.key));
    for (const [key, card] of cards) {
      if (!keys.has(key)) {
        card.remove();
        cards.delete(key);
      }
    }
    const multi = state.sources.size > 1;
    state.pages.forEach((page, i) => {
      let card = cards.get(page.key);
      if (!card) {
        card = makeCard(page);
        card.dataset.rot = String(page.rotate);
        cards.set(page.key, card);
      } else if (card.dataset.rot !== String(page.rotate)) {
        // Rotation changée (pivoter, annuler, rétablir) : miniature redessinée
        card.dataset.rot = String(page.rotate);
        drawThumb(card, page);
      }
      if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] || null);
      card.querySelector('.num').textContent = String(i + 1);
      const src = page.blank ? 'blanche' : multi ? `${state.sources.get(page.src).name} · p. ${page.index + 1}` : page.index !== i ? `p. ${page.index + 1}` : '';
      card.querySelector('.src').textContent = src;
      card.querySelector('.src').dataset.tip = src;
      card.classList.toggle('rotated', Boolean(page.rotate));
    });
    updateSelection();
  }

  function onKey(e) {
    if (!state.pages.length) return false;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    if (typing) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'a') selectAll();
    else if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) undo();
    else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) redo();
    else if (ctrl && e.key.toLowerCase() === 's') save();
    else if (!ctrl && (e.key === 'Delete' || e.key === 'Backspace')) removeSelected();
    else if (!ctrl && e.key.toLowerCase() === 'r') rotate(e.shiftKey ? 270 : 90);
    else if (e.key === 'Escape' && state.selected.size) {
      state.selected.clear();
      updateSelection();
    } else return false;
    return true;
  }

  render();
  return { el: root, accept: 'pdf', multiple: true, onFiles: addFiles, onKey };
}
