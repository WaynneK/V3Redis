/*
 * Finitions — numéros de page, filigrane et propriétés du document (titre, auteur…), avec un aperçu
 * en direct de la page choisie.
 */

import { api, h, icon, button, segmented, toggle, plural, baseName, check, showResult, withBusy, formatBytes, toast } from '../core.js';
import { dropZone, docHeader, actionBar } from '../components.js';
import { renderThumb, getDocument, forget } from '../pdfview.js';

const FORMATS = [
  ['n', '1, 2, 3…'],
  ['page', 'Page 1'],
  ['slash', '1 / 12'],
  ['sur', 'Page 1 sur 12'],
  ['dash', '- 1 -'],
];
const POSITIONS = [
  ['bottom-center', 'En bas, au centre'],
  ['bottom-right', 'En bas, à droite'],
  ['bottom-left', 'En bas, à gauche'],
  ['top-center', 'En haut, au centre'],
  ['top-right', 'En haut, à droite'],
  ['top-left', 'En haut, à gauche'],
];
const COLORS = [
  ['gris', 'Gris'],
  ['rouge', 'Rouge'],
  ['bleu', 'Bleu'],
  ['violet', 'Violet'],
  ['noir', 'Noir'],
];

function select(options, value, onChange, label) {
  const el = h('select', { 'aria-label': label }, options.map(([v, text]) => h('option', { value: v }, text)));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function create() {
  const fresh = () => ({
    numbers: { enabled: true, position: 'bottom-center', format: 'slash', start: 1, size: 10, skipFirst: false },
    watermark: { enabled: false, text: 'CONFIDENTIEL', size: 'medium', opacity: 0.18, color: 'gris', angle: 'diagonal' },
    props: { enabled: false, title: '', author: '', subject: '', keywords: '', clear: false },
  });
  const state = { file: null, opts: fresh(), page: 0 };
  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);

  function open(files) {
    const f = files.find((x) => x.kind === 'pdf');
    if (!f) return;
    if (state.file) {
      api.release([state.file.id]);
      forget(state.file.id);
    }
    state.file = f;
    state.page = 0;
    const keep = state.opts;
    state.opts = fresh();
    state.opts.numbers = keep.numbers;
    state.opts.watermark = keep.watermark;
    const info = f.info || {};
    Object.assign(state.opts.props, { title: info.title || '', author: info.author || '', subject: info.subject || '', keywords: info.keywords || '' });
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

  // ---------------------------------------------------------------- Aperçu

  let previewCanvas = null;
  let previewLabel = null;
  let previewTimer = null;
  let previewSeq = 0;
  let lastPreviewKey = null;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(drawPreview, 220);
  }

  async function drawPreview() {
    if (!previewCanvas || !state.file) return;
    const seq = ++previewSeq;
    const o = state.opts;
    const any = o.numbers.enabled || (o.watermark.enabled && o.watermark.text.trim());
    previewLabel.textContent = `Page ${state.page + 1} sur ${state.file.pageCount}`;
    const canvas = h('canvas');
    try {
      if (!any) {
        await renderThumb(state.file.id, state.page, canvas, { width: 340 });
      } else {
        const res = await api.stampPreview(state.file.id, o, state.page);
        if (seq !== previewSeq) return;
        if (!res || !res.ok) {
          previewCanvas.parentElement.dataset.error = (res && res.error) || 'Aperçu impossible.';
          return;
        }
        const key = `preview-${seq}`;
        await renderThumb(key, 0, canvas, { width: 340, bytesProvider: async () => res.bytes });
        if (lastPreviewKey) forget(lastPreviewKey);
        lastPreviewKey = key;
      }
    } catch (err) {
      if (seq === previewSeq) previewCanvas.parentElement.dataset.error = err.message;
      return;
    }
    if (seq !== previewSeq) return;
    delete previewCanvas.parentElement.dataset.error;
    canvas.className = 'preview-canvas';
    previewCanvas.replaceWith(canvas);
    previewCanvas = canvas;
  }

  // ---------------------------------------------------------------- Options

  function section(title, key, hint, content) {
    const o = state.opts[key];
    const box = h('div', { class: 'stamp-body' }, content);
    box.inert = !o.enabled;
    const sw = toggle(title, o.enabled, (on) => {
      o.enabled = on;
      box.inert = !on;
      wrap.classList.toggle('off', !on);
      schedulePreview();
      updateBar();
    });
    const wrap = h('section', { class: `stamp-section${o.enabled ? '' : ' off'}` }, h('div', { class: 'stamp-head' }, sw.el, h('span', { class: 'muted' }, hint)), box);
    return wrap;
  }

  const field = (label, control, note) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, note || null);

  function numbersSection() {
    const n = state.opts.numbers;
    const change = (k) => (v) => {
      n[k] = v;
      schedulePreview();
    };
    const start = h('input', { type: 'number', min: '0', max: '99999', step: '1', value: String(n.start), class: 'num-input' });
    start.addEventListener('input', () => {
      const v = Number(start.value);
      if (Number.isInteger(v) && v >= 0) change('start')(v);
    });
    const skip = h('input', { type: 'checkbox' });
    skip.checked = n.skipFirst;
    skip.addEventListener('change', () => change('skipFirst')(skip.checked));
    return section(
      'Numéros de page',
      'numbers',
      'sur chaque page',
      h(
        'div',
        { class: 'stamp-grid' },
        field('Position', select(POSITIONS, n.position, change('position'), 'Position')),
        field('Format', select(FORMATS, n.format, change('format'), 'Format')),
        field('Commencer à', start),
        field(
          'Taille',
          segmented(
            [
              [8, 'Petite'],
              [10, 'Moyenne'],
              [13, 'Grande'],
            ],
            n.size,
            change('size'),
            { compact: true }
          ).el
        ),
        h('label', { class: 'check span2' }, skip, 'Pas de numéro sur la première page (couverture)')
      )
    );
  }

  function watermarkSection() {
    const w = state.opts.watermark;
    const change = (k) => (v) => {
      w[k] = v;
      schedulePreview();
    };
    const text = h('input', { type: 'text', value: w.text, maxlength: '80', placeholder: 'ex. CONFIDENTIEL, BROUILLON, COPIE', spellcheck: 'false' });
    text.addEventListener('input', () => change('text')(text.value));
    const opacity = h('input', { type: 'range', min: '5', max: '60', step: '1', value: String(Math.round(w.opacity * 100)), class: 'range' });
    const opacityOut = h('output', { class: 'muted' }, `${Math.round(w.opacity * 100)} %`);
    opacity.addEventListener('input', () => {
      opacityOut.textContent = `${opacity.value} %`;
      change('opacity')(Number(opacity.value) / 100);
    });
    const swatches = h(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-label': 'Couleur' },
      COLORS.map(([v, label]) => {
        const b = h('button', { type: 'button', role: 'radio', class: `swatch c-${v}`, 'aria-checked': String(w.color === v), 'data-tip': label, 'aria-label': label });
        b.addEventListener('click', () => {
          swatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === b)));
          change('color')(v);
        });
        return b;
      })
    );
    return section(
      'Filigrane',
      'watermark',
      'texte en travers de chaque page',
      h(
        'div',
        { class: 'stamp-grid' },
        h('div', { class: 'span2' }, field('Texte', text)),
        field('Couleur', swatches),
        field(
          'Taille',
          segmented(
            [
              ['small', 'Petite'],
              ['medium', 'Moyenne'],
              ['large', 'Grande'],
            ],
            w.size,
            change('size'),
            { compact: true }
          ).el
        ),
        field(
          'Sens',
          segmented(
            [
              ['diagonal', 'Diagonale'],
              ['horizontal', 'Horizontal'],
            ],
            w.angle,
            change('angle'),
            { compact: true }
          ).el
        ),
        field('Opacité', h('div', { class: 'range-row' }, opacity, opacityOut))
      )
    );
  }

  function propsSection() {
    const p = state.opts.props;
    const input = (k, placeholder) => {
      const el = h('input', { type: 'text', value: p[k], placeholder, spellcheck: 'false' });
      el.addEventListener('input', () => (p[k] = el.value));
      return el;
    };
    const clear = h('input', { type: 'checkbox' });
    clear.checked = p.clear;
    const fields = h(
      'div',
      { class: 'stamp-grid' },
      field('Titre', input('title', 'Titre du document')),
      field('Auteur', input('author', 'Nom de l\'auteur')),
      field('Sujet', input('subject', 'Résumé en quelques mots')),
      field('Mots-clés', input('keywords', 'séparés par des virgules'))
    );
    clear.addEventListener('change', () => {
      p.clear = clear.checked;
      fields.inert = clear.checked;
      fields.classList.toggle('dimmed', clear.checked);
    });
    return section(
      'Propriétés',
      'props',
      'visibles dans Fichier › Propriétés du lecteur PDF',
      h('div', null, fields, h('label', { class: 'check' }, clear, 'Effacer toutes les propriétés (anonymiser le document)'))
    );
  }

  // ---------------------------------------------------------------- Rendu

  let bar = null;
  let saveBtn = null;
  function updateBar() {
    if (!bar) return;
    const o = state.opts;
    const on = [o.numbers.enabled && 'numéros', o.watermark.enabled && 'filigrane', o.props.enabled && 'propriétés'].filter(Boolean);
    bar.querySelector('.action-summary').textContent = on.length ? `À appliquer : ${on.join(', ')}` : 'Activez au moins une finition';
    saveBtn.disabled = !on.length;
  }

  function render() {
    if (!state.file) {
      previewCanvas = null;
      bar = null;
      body.replaceChildren(dropZone({ kind: 'pdf', title: 'Déposez le PDF à finaliser', hint: 'ou cliquez pour le choisir — numéros de page, filigrane, propriétés', onFiles: open }));
      return;
    }
    previewCanvas = h('canvas', { class: 'preview-canvas' });
    previewLabel = h('span', { class: 'muted' });
    const go = (delta) => {
      const next = Math.min(state.file.pageCount - 1, Math.max(0, state.page + delta));
      if (next === state.page) return;
      state.page = next;
      drawPreview();
    };
    const preview = h(
      'aside',
      { class: 'stamp-preview' },
      h('div', { class: 'preview-frame' }, previewCanvas),
      h('div', { class: 'preview-nav' }, button('', { icon: 'prev', cls: 'icon-only', tip: 'Page précédente', onClick: () => go(-1) }), previewLabel, button('', { icon: 'next', cls: 'icon-only', tip: 'Page suivante', onClick: () => go(1) }))
    );
    saveBtn = button('Appliquer et enregistrer', { icon: 'check', cls: 'primary', onClick: save });
    bar = actionBar('', saveBtn);
    body.replaceChildren(
      docHeader(state.file, { onChange: open, onClose: close }),
      h('div', { class: 'stamp-layout' }, h('div', { class: 'stamp-options' }, numbersSection(), watermarkSection(), propsSection()), preview),
      bar
    );
    updateBar();
    drawPreview();
  }

  async function save() {
    const file = state.file;
    const res = await withBusy('Application des finitions…', () => api.stampSave(file.id, state.opts, `${baseName(file.name)}_finalise.pdf`));
    if (check(res)) showResult(result, res, { title: 'PDF enregistré', detail: `${plural(res.pages, 'page')} · ${formatBytes(res.size)}` });
  }

  render();
  return { el: root, accept: 'pdf', multiple: false, onFiles: open };
}
