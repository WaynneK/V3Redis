/*
 * core.js — Utilitaires partagés de l'interface : DOM sans innerHTML, icônes, notifications,
 * info-bulles, opération en cours (progression / annulation), ouverture de fichiers, résultats.
 */

export const api = window.predf;
export const $ = (id) => document.getElementById(id);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Icônes (traits 24 × 24)
// ---------------------------------------------------------------------------

export const ICONS = {
  merge: ['M8 4h7l4 4v7', 'M5 8h7l4 4v8H5z', 'M12 8v4h4'],
  organize: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  split: ['M6 3h8l4 4v4', 'M6 3v8', 'M3 14h18', 'M6 17v4h12v-4'],
  images: ['M4 5h16v14H4z', 'M4 15l4.5-4.5 4 4 2.5-2.5L20 17', 'M15 9.5h.01'],
  export: ['M6 3h8l4 4v6', 'M6 3v18h6', 'M14 3v4h4', 'M15 17h6', 'M18 14l3 3-3 3'],
  compress: ['M12 3v6', 'M9 6l3 3 3-3', 'M12 21v-6', 'M9 18l3-3 3 3', 'M4 12h16'],
  stamp: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 13h6', 'M9 17h4'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  rotateL: ['M3 8V3', 'M3 8h5', 'M4 13a8 8 0 1 0 2.3-6.5L3 8'],
  rotateR: ['M21 8V3', 'M21 8h-5', 'M20 13a8 8 0 1 1-2.3-6.5L21 8'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  blank: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M12 11v6', 'M9 14h6'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  redo: ['M15 14l5-5-5-5', 'M20 9H10a6 6 0 0 0 0 12h3'],
  folder: ['M3 6h6l2 2h10v11H3z'],
  open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  drag: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  sort: ['M7 4v16', 'M4 17l3 3 3-3', 'M14 6h6', 'M14 12h4', 'M14 18h2'],
  select: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'],
  extract: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M12 10v7', 'M9 14l3 3 3-3'],
  reverse: ['M7 4v16', 'M4 7l3-3 3 3', 'M17 20V4', 'M14 17l3 3 3-3'],
  text: ['M5 6h14', 'M12 6v13', 'M9 19h6'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  warn: ['M12 3 2 20h20L12 3z', 'M12 10v4', 'M12 17h.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v6', 'M12 7.5h.01'],
  prev: ['M15 5l-7 7 7 7'],
  next: ['M9 5l7 7-7 7'],
  offline: ['M2 8.8a15 15 0 0 1 20 0', 'M5 12.5a10 10 0 0 1 14 0', 'M8.5 16a5 5 0 0 1 7 0', 'M3 3l18 18'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z', 'M5 3l.5 1.5L7 5l-1.5.5L5 7l-.5-1.5L3 5l1.5-.5z'],
  key: ['M14.5 4a5.5 5.5 0 1 1-4.9 8l-6.6 6.6V21h3v-2h2v-2h2l1.6-1.6', 'M16 8.5h.01'],
  stop: ['M7 7h10v10H7z'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9s1.3-6.3 3.8-9z'],
};

export function icon(name, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** Bouton : libellé, icône, classes, action ; l'action peut être asynchrone (bouton désactivé pendant). */
export function button(label, { icon: ic, cls = '', tip, onClick, disabled, type = 'button' } = {}) {
  const b = h('button', { type, class: `btn ${cls}`.trim(), 'data-tip': tip || null, disabled: Boolean(disabled), 'aria-label': !label && tip ? tip : null }, ic ? icon(ic) : null, label ? h('span', null, label) : null);
  if (onClick) {
    b.addEventListener('click', async (e) => {
      if (b.dataset.running) return;
      b.dataset.running = '1';
      try {
        await onClick(e);
      } catch (err) {
        toast(err && err.message ? err.message : String(err), 'error');
      } finally {
        delete b.dataset.running;
      }
    });
  }
  return b;
}

/** Choix segmenté : options [[valeur, libellé]], renvoie { el, value, set }. */
export function segmented(options, value, onChange, { label, compact } = {}) {
  const el = h('div', { class: `segmented${compact ? ' compact' : ''}`, role: 'radiogroup', 'aria-label': label || null });
  const state = { value };
  const buttons = options.map(([v, text, tip]) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), 'data-tip': tip || null }, text);
    b.addEventListener('click', () => {
      if (state.value === v) return;
      set(v);
      onChange(v);
    });
    return b;
  });
  function set(v) {
    state.value = v;
    buttons.forEach((b, i) => b.setAttribute('aria-checked', String(options[i][0] === v)));
  }
  el.append(...buttons);
  return { el, get value() {
    return state.value;
  }, set };
}

/** Interrupteur (case à cocher stylée). */
export function toggle(labelText, checked, onChange, tip) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  return { el: h('label', { class: 'switch', 'data-tip': tip || null }, input, h('span', { class: 'track' }), h('span', null, labelText)), input };
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat('fr-FR');
export const fmt = (n) => nf.format(n).replace(/ | /g, ' ');

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export const plural = (n, word, pluralWord) => `${fmt(n)} ${n > 1 ? pluralWord || `${word}s` : word}`;

/** « rapport.pdf » → « rapport » */
export const baseName = (name) => String(name || 'document').replace(/\.[^.]+$/, '');

// ---------------------------------------------------------------------------
// Notifications, info-bulles
// ---------------------------------------------------------------------------

let toastTimer = null;
export function toast(message, level = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${level}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), level === 'error' ? 6000 : 3400);
}

export function initTooltip() {
  const tip = $('tooltip');
  let current = null;
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest && e.target.closest('[data-tip]');
    if (target === current) return;
    current = target;
    if (!target || !target.dataset.tip) {
      tip.hidden = true;
      return;
    }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
    const top = r.bottom + 8 + t.height > window.innerHeight - 8 ? r.top - t.height - 8 : r.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });
  document.addEventListener('scroll', () => (tip.hidden = true), true);
  document.addEventListener('mousedown', () => (tip.hidden = true));
}

// ---------------------------------------------------------------------------
// Opération en cours : voile, progression, annulation
// ---------------------------------------------------------------------------

const busyState = { active: false, cancel: null };

export const busy = {
  start(label, { cancellable = false } = {}) {
    busyState.active = true;
    busyState.canceled = false;
    $('busy').hidden = false;
    $('busy-label').textContent = label || 'Traitement…';
    $('busy-detail').textContent = '';
    $('busy-bar').style.width = '0%';
    $('busy').classList.toggle('indeterminate', true);
    $('busy-cancel').hidden = !cancellable;
  },
  progress(done, total, label) {
    if (!busyState.active) return;
    if (label) $('busy-label').textContent = label;
    if (total > 0) {
      $('busy').classList.remove('indeterminate');
      $('busy-bar').style.width = `${Math.min(100, (done / total) * 100)}%`;
      $('busy-detail').textContent = `${fmt(done)} / ${fmt(total)}`;
    }
  },
  get canceled() {
    return Boolean(busyState.canceled);
  },
  end() {
    busyState.active = false;
    $('busy').hidden = true;
  },
};

export function initBusy() {
  $('busy-cancel').addEventListener('click', () => {
    busyState.canceled = true;
    $('busy-label').textContent = 'Annulation…';
  });
  api.onProgress((p) => busy.progress(p.done, p.total, p.label));
}

/** Exécute une opération avec le voile de progression ; renvoie son résultat. */
export async function withBusy(label, fn, options) {
  busy.start(label, options);
  try {
    return await fn();
  } finally {
    busy.end();
  }
}

// ---------------------------------------------------------------------------
// Résultat d'un enregistrement
// ---------------------------------------------------------------------------

/** Bandeau de succès sous un outil : chemin, taille, boutons Ouvrir / Afficher dans le dossier. */
export function showResult(container, res, { title, detail, folder } = {}) {
  const target = folder || res.filePath;
  const actions = [];
  if (!folder && res.filePath) actions.push(button('Ouvrir', { icon: 'open', cls: 'small', onClick: () => api.openFile(res.filePath) }));
  if (target) actions.push(button('Afficher dans le dossier', { icon: 'folder', cls: 'small ghost', onClick: () => api.showFile(target) }));
  const card = h(
    'div',
    { class: 'result', role: 'status' },
    h('span', { class: 'result-icon' }, icon('check')),
    h('div', { class: 'result-text' }, h('strong', null, title || 'Enregistré'), h('span', { class: 'path', 'data-tip': target || null }, target || ''), detail ? h('span', { class: 'muted' }, detail) : null),
    h('div', { class: 'result-actions' }, actions),
    button('', { icon: 'close', cls: 'icon-only ghost', tip: 'Fermer', onClick: () => card.remove() })
  );
  container.replaceChildren(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Réponse IPC : erreur affichée, annulation silencieuse ; renvoie true si tout s'est bien passé. */
export function check(res) {
  if (res && res.ok) return true;
  if (res && res.canceled) return false;
  toast((res && res.error) || 'Opération impossible.', 'error');
  return false;
}

// ---------------------------------------------------------------------------
// Fichiers : ouverture, dépôt, conversion des images WebP / GIF / BMP
// ---------------------------------------------------------------------------

/** Convertit en PNG (dans la page) une image que pdf-lib ne sait pas placer directement. */
async function convertImage(file) {
  const bytes = await api.bytes(file.id);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const res = await api.replaceImage(file.id, new Uint8Array(await blob.arrayBuffer()));
  if (!res || !res.ok) throw new Error((res && res.error) || 'Conversion impossible.');
  return res.file;
}

/** Prépare les fichiers reçus : erreurs signalées, images converties si besoin, filtrage par type. */
export async function prepareFiles(files, accept) {
  const ok = [];
  const refused = [];
  for (const f of files || []) {
    if (f.error) {
      refused.push(`${f.name} : ${f.error}`);
      continue;
    }
    if (accept === 'pdf' && f.kind !== 'pdf') {
      refused.push(`${f.name} : un PDF est attendu ici.`);
      api.release([f.id]);
      continue;
    }
    if (accept === 'images' && f.kind !== 'image') {
      refused.push(`${f.name} : une image est attendue ici.`);
      api.release([f.id]);
      continue;
    }
    if (f.needsConversion) {
      try {
        ok.push(await convertImage(f));
      } catch (err) {
        refused.push(`${f.name} : ${err.message}`);
      }
      continue;
    }
    ok.push(f);
  }
  if (refused.length) toast(refused.length === 1 ? refused[0] : `${refused.length} fichiers ignorés. ${refused[0]}`, 'error');
  return ok;
}

export async function pickFiles(kind, multiple) {
  const res = await api.open({ kind, multiple });
  if (!res || !res.ok) {
    check(res);
    return [];
  }
  return prepareFiles(res.files, kind);
}

/** Miniature d'une image (URL blob, libérée par l'appelant via revoke). */
export async function imageUrl(id) {
  const bytes = await api.bytes(id);
  return URL.createObjectURL(new Blob([bytes]));
}

// ---------------------------------------------------------------------------
// Glisser-déposer pour réordonner une liste
// ---------------------------------------------------------------------------

/**
 * Rend les enfants de `list` réordonnables à la souris (attribut data-key sur chaque enfant).
 * onMove(fromKeys, toIndex) : les éléments déplacés et leur nouvelle position (avant l'élément d'indice toIndex).
 * selectedKeys() : éléments sélectionnés (déplacés ensemble si l'élément saisi en fait partie).
 */
export function sortable(list, { onMove, selectedKeys = () => [], axis = 'grid' }) {
  let dragKeys = null;
  let marker = null;

  const clear = () => {
    if (marker) marker.classList.remove('drop-before', 'drop-after');
    marker = null;
  };

  list.addEventListener('dragstart', (e) => {
    const item = e.target.closest('[data-key]');
    if (!item || item.parentElement !== list) return;
    const key = item.dataset.key;
    const sel = selectedKeys();
    dragKeys = sel.includes(key) ? sel : [key];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-predf-sort', key);
    requestAnimationFrame(() => dragKeys && dragKeys.forEach((k) => list.querySelector(`[data-key="${CSS.escape(k)}"]`)?.classList.add('dragging')));
  });
  list.addEventListener('dragover', (e) => {
    if (!dragKeys) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('[data-key]');
    clear();
    if (!item || item.parentElement !== list) return;
    const r = item.getBoundingClientRect();
    const after = axis === 'y' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    marker = item;
    item.classList.add(after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clear();
  });
  list.addEventListener('drop', (e) => {
    if (!dragKeys) return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...list.children].filter((c) => c.dataset.key);
    let index = items.length;
    if (marker) {
      index = items.indexOf(marker) + (marker.classList.contains('drop-after') ? 1 : 0);
    }
    const keys = dragKeys;
    clear();
    dragKeys = null;
    onMove(keys, index);
  });
  list.addEventListener('dragend', () => {
    clear();
    dragKeys = null;
    list.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  });
}

/** Déplace les éléments `keys` d'un tableau (clé via keyOf) vers l'indice `to` (indice dans le tableau d'origine). */
export function moveItems(array, keys, to, keyOf) {
  const set = new Set(keys);
  const moving = array.filter((x) => set.has(keyOf(x)));
  let target = to;
  for (let i = 0; i < Math.min(to, array.length); i++) if (set.has(keyOf(array[i]))) target--;
  const rest = array.filter((x) => !set.has(keyOf(x)));
  rest.splice(Math.max(0, Math.min(target, rest.length)), 0, ...moving);
  return rest;
}
