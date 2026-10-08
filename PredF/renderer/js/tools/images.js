/*
 * Images → PDF — photos et images (JPEG, PNG, WebP, GIF, BMP) en un PDF : une image par page, dans
 * l'ordre choisi, avec le format de page, l'orientation et les marges voulus.
 */

import { api, h, icon, button, segmented, plural, baseName, check, showResult, withBusy, sortable, moveItems, imageUrl, pickFiles, formatBytes, fmt } from '../core.js';
import { dropZone, actionBar, optionGroup } from '../components.js';

export function create() {
  const state = {
    entries: [], // { key, file, rotate }
    layout: { size: 'A4', orientation: 'auto', margin: 10 },
  };
  let seq = 0;
  const urls = new Map(); // clé → URL blob de la miniature

  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);

  function add(files) {
    for (const file of files.filter((f) => f.kind === 'image')) state.entries.push({ key: `i${++seq}`, file, rotate: 0 });
    result.replaceChildren();
    render();
  }

  function remove(keys) {
    const set = new Set(keys);
    for (const e of state.entries.filter((x) => set.has(x.key))) {
      api.release([e.file.id]);
      if (urls.has(e.key)) URL.revokeObjectURL(urls.get(e.key));
      urls.delete(e.key);
    }
    state.entries = state.entries.filter((e) => !set.has(e.key));
    render();
  }

  function card(entry, i) {
    const img = h('img', { alt: '', draggable: 'false' });
    const box = h('div', { class: `thumb image-thumb rot-${entry.rotate}` }, img);
    const { displayWidth: w, displayHeight: hh } = entry.file.image || { displayWidth: 1, displayHeight: 1 };
    // Image tournée d'un quart de tour : réduite pour rester dans la case carrée
    box.style.setProperty('--fit', String(Math.min(1, hh / w)));
    const show = (url) => (img.src = url);
    if (urls.has(entry.key)) show(urls.get(entry.key));
    else
      imageUrl(entry.file.id).then((url) => {
        urls.set(entry.key, url);
        show(url);
      });
    const turn = (delta) => {
      entry.rotate = (entry.rotate + delta + 360) % 360;
      box.className = `thumb image-thumb rot-${entry.rotate}`;
    };
    return h(
      'li',
      { class: 'page-card image-card', draggable: 'true', 'data-key': entry.key },
      box,
      h(
        'div',
        { class: 'card-tools' },
        button('', { icon: 'rotateL', cls: 'icon-only', tip: 'Pivoter à gauche', onClick: () => turn(270) }),
        button('', { icon: 'rotateR', cls: 'icon-only', tip: 'Pivoter à droite', onClick: () => turn(90) }),
        button('', { icon: 'trash', cls: 'icon-only danger', tip: 'Retirer', onClick: () => remove([entry.key]) })
      ),
      h('div', { class: 'card-foot' }, h('span', { class: 'num' }, String(i + 1)), h('span', { class: 'src', 'data-tip': `${entry.file.name} · ${fmt(w)} × ${fmt(hh)} px · ${formatBytes(entry.file.size)}` }, entry.file.name))
    );
  }

  function render() {
    if (!state.entries.length) {
      body.replaceChildren(dropZone({ kind: 'images', multiple: true, title: 'Déposez vos images ici', hint: 'ou cliquez pour les choisir — une image par page, dans l\'ordre de la grille', onFiles: add }));
      return;
    }
    const grid = h('ol', { class: 'page-grid' }, state.entries.map(card));
    sortable(grid, {
      onMove: (keys, to) => {
        state.entries = moveItems(state.entries, keys, to, (e) => e.key);
        render();
      },
    });
    const L = state.layout;
    const orientation = segmented(
      [
        ['auto', 'Auto', 'Paysage pour les images larges, portrait sinon'],
        ['portrait', 'Portrait'],
        ['landscape', 'Paysage'],
      ],
      L.orientation,
      (v) => (L.orientation = v),
      { compact: true }
    );
    const orientationGroup = optionGroup('Orientation', orientation.el);
    orientationGroup.hidden = L.size === 'fit';
    const options = h(
      'div',
      { class: 'options-row' },
      optionGroup(
        'Format de page',
        segmented(
          [
            ['A4', 'A4'],
            ['A3', 'A3'],
            ['A5', 'A5'],
            ['Letter', 'Letter'],
            ['fit', 'Taille de l\'image', 'Chaque page prend les proportions de son image'],
          ],
          L.size,
          (v) => {
            L.size = v;
            orientationGroup.hidden = v === 'fit';
          },
          { compact: true }
        ).el
      ),
      orientationGroup,
      optionGroup(
        'Marges',
        segmented(
          [
            [0, 'Aucune'],
            [10, 'Petites'],
            [20, 'Normales'],
          ],
          L.margin,
          (v) => (L.margin = v),
          { compact: true }
        ).el
      )
    );
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      button('Ajouter des images', {
        icon: 'plus',
        onClick: async () => {
          const files = await pickFiles('images', true);
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
    body.replaceChildren(
      toolbar,
      options,
      h('p', { class: 'hint' }, 'Glissez les images pour changer l\'ordre. Les photos de téléphone sont remises à l\'endroit automatiquement.'),
      grid,
      actionBar(`${plural(state.entries.length, 'image')} → ${plural(state.entries.length, 'page')}`, button('Créer le PDF', { icon: 'images', cls: 'primary', onClick: save }))
    );
  }

  async function save() {
    const items = state.entries.map((e) => ({ type: 'image', src: e.file.id, rotate: e.rotate, layout: { ...state.layout } }));
    const first = state.entries[0].file;
    const name = state.entries.length === 1 ? baseName(first.name) : `${baseName(first.name)}_images`;
    const res = await withBusy('Création du PDF…', () => api.savePdf({ items, suggestedName: `${name}.pdf`, hintId: first.id }));
    if (check(res)) showResult(result, res, { title: 'PDF créé', detail: `${plural(res.pages, 'page')} · ${formatBytes(res.size)}` });
  }

  render();
  return { el: root, accept: 'images', multiple: true, onFiles: add };
}
