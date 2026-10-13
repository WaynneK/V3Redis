/*
 * app.js — Interface de FichInter.
 *
 * Trois vues :
 *   - Modèles (accueil) : choix du modèle de fiche, import d'un modèle Word, fiches récentes ;
 *   - Formulaire : les cases du modèle, rangées par section (texte, dates, cases à cocher, signatures…),
 *     brouillon enregistré à chaque saisie ;
 *   - Fiche générée : vérification champ par champ (relue dans le fichier produit) et aperçu du document.
 * Les saisies partent au processus principal, qui écrit le .docx (lib/template.js).
 */
(() => {
  'use strict';

  const api = window.fichinter;
  const F = window.Fields;
  const $ = (id) => document.getElementById(id);
  const main = $('main');

  // ---------------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const ICONS = {
    doc: 'M7 3h7l5 5v13H7z M14 3v5h5',
    open: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
    pdf: 'M6 3h9l4 4v14H6z M15 3v4h4 M9 12h6 M9 16h4',
    folder: 'M3 6.5h6l2 2.5h10v10.5H3z',
    edit: 'M4 20l4.5-1L19.5 8 16 4.5 5 15.5z M14 6.5l3.5 3.5',
    plus: 'M12 5v14 M5 12h14',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M6 6l12 12 M18 6L6 18',
    alert: 'M12 3.5l9.5 16.5h-19z M12 10v4.5 M12 17.5v.01',
    trash: 'M4 7h16 M9.5 7V4.5h5V7 M6 7l1 13h10l1-13',
    upload: 'M12 15.5V4 M7 9l5-5 5 5 M4 15v5h16v-5',
    back: 'M15 18l-6-6 6-6',
    pen: 'M3 20.5c3.5-.5 4.5-3 7-3s2.5 2 5 2 3.5-1.5 5-2 M14.5 4.5l4 4L10 17l-4.5.5.5-4.5z',
    clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7.5V12l3 2',
    calendar: 'M4 6h16v14H4z M4 10h16 M8 3.5v4 M16 3.5v4',
    eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z M12 9.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6',
    spark: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5L18 18 M6 18l2.5-2.5 M15.5 8.5L18 6',
    redo: 'M20 11a8 8 0 1 0-2.3 5.7 M20 5v6h-6',
    hash: 'M5 9h14 M5 15h14 M10 4L8 20 M16 4l-2 16',
    zoomIn: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M20 20l-4-4 M11 8v6 M8 11h6',
    zoomOut: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M20 20l-4-4 M8 11h6',
    fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
    list: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  };

  function svg(name, cls) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('aria-hidden', 'true');
    if (cls) el.setAttribute('class', cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name] || '');
    el.append(p);
    return el;
  }

  function button(label, icon, cls, onClick, attrs) {
    return h('button', { type: 'button', class: `btn ${cls || ''}`.trim(), onclick: onClick, ...(attrs || {}) }, icon ? svg(icon) : null, label ? h('span', null, label) : null);
  }

  let toastTimer = null;
  function toast(text, kind) {
    const t = $('toast');
    t.textContent = text;
    t.className = `toast${kind ? ` ${kind}` : ''}`;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => (t.hidden = true), 250);
    }, kind === 'error' ? 6000 : 3200);
  }

  function busy(text) {
    $('busy-text').textContent = text || '';
    $('busy').hidden = !text;
  }

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // stockage indisponible
      }
    },
  };

  const fmtDateTime = (ms) => {
    const d = new Date(ms);
    return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })} à ${F.frTime(F.isoTime(d))}`;
  };
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  // ---------------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------------

  const state = {
    view: 'home',
    info: {},
    models: [],
    recent: [],
    model: null, // { id, name, builtin, hash, schema }
    values: {},
    replace: null, // fiche récente remplacée par la prochaine génération (« Modifier la saisie »)
    result: null, // { record, checks, data, from: 'generate' | 'recent' }
    filter: 'all',
    zoom: null, // null : ajusté à la largeur
  };

  const allFields = () => (state.model ? state.model.schema.sections.flatMap((s) => s.fields) : []);
  const draftKey = (m) => `fichinter.draft.${m.id}.${m.hash}`;
  const MEMORY_KEY = 'fichinter.memory';

  // ---------------------------------------------------------------------------
  // Fil d'Ariane et navigation
  // ---------------------------------------------------------------------------

  function crumbs() {
    const nav = $('crumbs');
    const parts = [h('button', { type: 'button', class: `crumb${state.view === 'home' ? ' current' : ''}`, onclick: () => state.view !== 'home' && goHome() }, 'Modèles')];
    if (state.view !== 'home' && state.model) {
      parts.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'));
      parts.push(h('button', { type: 'button', class: `crumb${state.view === 'form' ? ' current' : ''}`, onclick: () => state.view === 'result' && backToForm() }, state.model.name));
    } else if (state.view === 'result' && state.result) {
      parts.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'));
      parts.push(h('span', { class: 'crumb current' }, state.result.record.modelName));
    }
    if (state.view === 'result') {
      parts.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'));
      parts.push(h('span', { class: 'crumb current' }, 'Fiche générée'));
    }
    nav.replaceChildren(...parts);
  }

  function show(view, build) {
    // Formulaire quitté juste après une frappe : le brouillon est enregistré avant de changer de modèle ou de vue
    if (state.view === 'form' && savePending) saveDraft();
    state.view = view;
    const node = build();
    node.classList.add('view-in');
    main.replaceChildren(node);
    main.scrollTop = 0;
    crumbs();
    document.body.dataset.view = view;
  }

  async function goHome() {
    state.result = null;
    await refreshLists();
    show('home', viewHome);
  }

  async function refreshLists() {
    const [models, recent] = await Promise.all([api.listModels(), api.recent()]);
    state.models = Array.isArray(models) ? models : [];
    state.recent = Array.isArray(recent) ? recent : [];
  }

  // ---------------------------------------------------------------------------
  // Aperçu des documents Word (docx-preview)
  // ---------------------------------------------------------------------------

  let renderCount = 0;
  const PAGE_WIDTH = 794; // A4 à 96 ppp

  /** Affiche un .docx dans `host` (styles du document compris, retirés avec lui). */
  async function renderDocx(data, host, { thumb = false } = {}) {
    const className = `dx${++renderCount}`;
    host.replaceChildren();
    host.dataset.dx = className;
    await window.docx.renderAsync(data, host, host, {
      className,
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      // true ferait de chaque section du document une page (en-tête d'un côté, tableaux en colonnes de l'autre)
      ignoreLastRenderedPageBreak: false,
      experimental: true,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderComments: false,
      renderChanges: false,
    });
    host.classList.add('docx-host');
    if (thumb) host.classList.add('docx-thumb');
    return className;
  }

  // ---------------------------------------------------------------------------
  // Vue « Modèles »
  // ---------------------------------------------------------------------------

  function viewHome() {
    const cards = state.models.map(modelCard);
    cards.push(
      h(
        'button',
        { type: 'button', class: 'model-card import-card', onclick: importModel, title: 'Ajouter un modèle de fiche (.docx) : le formulaire est déduit de ses tableaux' },
        h('span', { class: 'import-icon' }, svg('upload')),
        h('strong', null, 'Importer un modèle Word'),
        h('span', { class: 'muted' }, 'Un .docx avec des tableaux « intitulé | case » : cases vides, cases à cocher, pointillés.')
      )
    );

    const recent = state.recent.length
      ? h('div', { class: 'recent-list' }, state.recent.map(recentRow))
      : h('div', { class: 'empty' }, h('p', null, 'Aucune fiche pour le moment.'), h('p', { class: 'muted' }, 'Les fiches générées apparaîtront ici : ouvrir, reprendre, exporter en PDF.'));

    return h(
      'section',
      { class: 'home' },
      h('div', { class: 'home-head' }, h('h1', null, 'Quelle fiche remplir ?'), h('p', { class: 'muted' }, 'Choisissez un modèle : le formulaire s\'adapte à ses cases. La fiche est ensuite générée en Word, relue et vérifiée.')),
      h('div', { class: 'model-grid' }, cards),
      h('div', { class: 'home-section' }, h('h2', null, 'Fiches récentes', state.recent.length ? h('span', { class: 'count' }, state.recent.length) : null), recent),
      h(
        'div',
        { class: 'outdir' },
        svg('folder'),
        h('span', null, 'Les fiches sont enregistrées dans ', h('strong', { title: state.info.outDir || '' }, state.info.outDir || '…')),
        button('Ouvrir', null, 'ghost small', () => api.openOutDir()),
        button('Changer…', null, 'ghost small', async () => {
          const res = await api.chooseOutDir();
          if (res && res.ok) {
            state.info.outDir = res.dir;
            show('home', viewHome);
            toast('Dossier des fiches modifié.');
          }
        })
      )
    );
  }

  function modelCard(m) {
    const draft = m.error ? null : store.get(`fichinter.draft.${m.id}.${m.hash}`, null);
    const thumb = h('div', { class: 'mc-thumb' }, h('div', { class: 'mc-thumb-page' }));
    const card = h(
      'article',
      {
        class: `model-card${m.error ? ' broken' : ''}`,
        tabindex: '0',
        role: 'button',
        'aria-label': `${m.name} — ${m.error ? 'illisible' : `${m.fields} champs`}`,
        onclick: () => !m.error && openModel(m.id),
        onkeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !m.error) {
            e.preventDefault();
            openModel(m.id);
          }
        },
      },
      thumb,
      h(
        'div',
        { class: 'mc-body' },
        h('h3', null, m.name),
        m.error
          ? h('p', { class: 'mc-error' }, m.error)
          : h('p', { class: 'muted' }, `${plural(m.sections, 'section', 'sections')} · ${plural(m.fields, 'champ', 'champs')}`),
        h(
          'div',
          { class: 'mc-tags' },
          h('span', { class: 'tag' }, m.builtin ? 'Livré avec FichInter' : 'Importé'),
          draft && draft.values ? h('span', { class: 'tag draft', title: `Brouillon du ${fmtDateTime(draft.updatedAt || Date.now())}` }, svg('edit'), 'Brouillon en cours') : null
        )
      ),
      m.builtin
        ? null
        : h(
            'button',
            {
              type: 'button',
              class: 'mc-remove',
              title: 'Retirer ce modèle (mis à la corbeille)',
              'aria-label': `Retirer le modèle ${m.name}`,
              onclick: (e) => {
                e.stopPropagation();
                removeModel(m);
              },
            },
            svg('trash')
          )
    );
    if (!m.error) {
      // Miniature : la première page du modèle, rendue quand la carte est affichée
      requestAnimationFrame(async () => {
        try {
          const res = await api.modelBytes(m.id);
          if (!res || !res.ok || !thumb.isConnected) return;
          const page = thumb.firstChild;
          await renderDocx(res.data, page, { thumb: true });
          const scale = thumb.clientWidth / PAGE_WIDTH;
          page.style.setProperty('zoom', String(scale));
          thumb.classList.add('ready');
        } catch {
          thumb.classList.add('failed');
        }
      });
    }
    return card;
  }

  function recentRow(r) {
    const status = !r.exists
      ? h('span', { class: 'pill missing' }, 'Fichier introuvable')
      : r.ok
        ? h('span', { class: 'pill ok', title: 'Toutes les saisies ont été relues dans le fichier' }, svg('check'), `${r.filled}/${r.total} remplis`)
        : h('span', { class: 'pill warn' }, svg('alert'), 'À vérifier');
    return h(
      'div',
      { class: `recent-row${r.exists ? '' : ' gone'}` },
      h('span', { class: 'rr-icon' }, svg('doc')),
      h(
        'button',
        { type: 'button', class: 'rr-main', disabled: !r.exists, onclick: () => openRecent(r.id), title: r.exists ? 'Voir la fiche et sa vérification' : r.file },
        h('strong', null, r.name.replace(/\.docx$/i, '')),
        h('small', { class: 'muted' }, `${r.modelName} · ${fmtDateTime(r.updatedAt || r.createdAt)}`)
      ),
      status,
      h(
        'div',
        { class: 'rr-actions' },
        r.exists ? button('', 'open', 'icon', () => openFiche(r.id), { title: 'Ouvrir dans Word', 'aria-label': 'Ouvrir dans Word' }) : null,
        r.exists ? button('', 'edit', 'icon', () => resumeRecent(r.id), { title: 'Reprendre la saisie', 'aria-label': 'Reprendre la saisie' }) : null,
        r.exists ? button('', 'folder', 'icon', () => api.showFiche(r.id), { title: 'Afficher dans le dossier', 'aria-label': 'Afficher dans le dossier' }) : null,
        button('', 'x', 'icon', () => forgetRecent(r), { title: 'Retirer de la liste (le fichier est conservé)', 'aria-label': 'Retirer de la liste' })
      )
    );
  }

  async function importModel() {
    const res = await api.importModel();
    if (!res || res.canceled) return;
    if (!res.ok) return alertModal('Modèle non importé', res.error || 'Import impossible.');
    await refreshLists();
    show('home', viewHome);
    toast(`Modèle importé : ${plural(res.sections, 'section', 'sections')}, ${plural(res.fields, 'champ', 'champs')}.`);
  }

  async function removeModel(m) {
    const ok = await confirmModal('Retirer ce modèle ?', `« ${m.name} » sera mis à la corbeille. Les fiches déjà générées avec lui sont conservées.`, 'Retirer', 'danger');
    if (!ok) return;
    const res = await api.removeModel(m.id);
    if (res && res.ok === false) return toast(res.error || 'Impossible de retirer le modèle.', 'error');
    store.remove(`fichinter.draft.${m.id}.${m.hash}`);
    await refreshLists();
    show('home', viewHome);
  }

  async function forgetRecent(r) {
    const res = await api.forgetFiche(r.id);
    if (res && res.ok === false) return toast(res.error, 'error');
    await refreshLists();
    show('home', viewHome);
    toast('Fiche retirée de la liste (le fichier est conservé).');
  }

  async function openFiche(id) {
    const res = await api.openFiche(id);
    if (res && res.ok === false) toast(res.error || 'Ouverture impossible.', 'error');
  }

  // ---------------------------------------------------------------------------
  // Ouverture d'un modèle : brouillon repris, ou fiche neuve préremplie
  // ---------------------------------------------------------------------------

  async function loadModel(id) {
    const res = await api.getModel(id);
    if (!res || !res.ok) {
      toast((res && res.error) || 'Modèle illisible.', 'error');
      return null;
    }
    return res.model;
  }

  async function openModel(id) {
    const model = await loadModel(id);
    if (!model) return;
    state.model = model;
    const draft = store.get(draftKey(model), null);
    if (draft && draft.values) {
      state.values = draft.values;
      state.replace = draft.replace || null;
      show('form', viewForm);
      toast('Brouillon repris là où vous l\'aviez laissé.');
    } else {
      startNew();
    }
  }

  function startNew() {
    state.values = {};
    state.replace = null;
    applyDefaults();
    show('form', viewForm);
  }

  /** Préremplissage d'une fiche neuve : date du jour, technicien et lieu mémorisés. */
  function applyDefaults() {
    const memory = store.get(MEMORY_KEY, {});
    const today = F.isoToday();
    for (const f of allFields()) {
      const a = f.assist || {};
      const key = F.norm(f.label);
      if (f.kind === 'blanks') {
        const arr = f.blanks.map((b, i) => {
          const bl = (a.blanks && a.blanks[i]) || {};
          if (bl.today) return today;
          if (bl.remember && typeof memory[`${key}#${i}`] === 'string') return memory[`${key}#${i}`];
          return '';
        });
        if (arr.some(Boolean)) state.values[f.key] = arr;
      } else if (a.today && f.kind === 'date') {
        state.values[f.key] = today;
      } else if (a.remember && memory[key] !== undefined) {
        if (f.kind === 'signature' && memory[key] && typeof memory[key] === 'object') state.values[f.key] = { name: String(memory[key].name || ''), image: String(memory[key].image || '') };
        else if (typeof memory[key] === 'string') state.values[f.key] = memory[key];
      }
    }
  }

  /** Mémorise les valeurs « à reprendre » (technicien, lieu de signature) après une génération. */
  function rememberValues() {
    const memory = store.get(MEMORY_KEY, {});
    for (const f of allFields()) {
      const a = f.assist || {};
      const key = F.norm(f.label);
      const v = state.values[f.key];
      if (f.kind === 'blanks' && a.blanks) {
        a.blanks.forEach((bl, i) => {
          if (bl.remember && Array.isArray(v) && v[i]) memory[`${key}#${i}`] = v[i];
        });
      } else if (a.remember && F.isFilled(f, v)) {
        memory[key] = f.kind === 'signature' ? { name: v.name || '', image: v.image || '' } : v;
      }
    }
    store.set(MEMORY_KEY, memory);
  }

  // ---------------------------------------------------------------------------
  // Vue « Formulaire »
  // ---------------------------------------------------------------------------

  let saveTimer = null;
  let savePending = false; // saisie pas encore enregistrée dans le brouillon
  let observer = null;
  const fieldNodes = new Map(); // clé → élément du champ

  function scheduleSave() {
    clearTimeout(saveTimer);
    savePending = true;
    saveTimer = setTimeout(saveDraft, 350);
  }

  function saveDraft() {
    clearTimeout(saveTimer);
    savePending = false;
    if (!state.model) return;
    const ok = store.set(draftKey(state.model), { values: state.values, replace: state.replace, updatedAt: Date.now() });
    const badge = $('draft-state');
    if (badge) {
      badge.textContent = ok ? 'Brouillon enregistré' : 'Brouillon non enregistré (stockage plein)';
      badge.classList.toggle('warn', !ok);
    }
  }

  function setValue(field, value, { silent = false } = {}) {
    state.values[field.key] = value;
    const node = fieldNodes.get(field.key);
    if (node) node.classList.toggle('filled', F.isFilled(field, value));
    updateProgress();
    if (!silent) scheduleSave();
    if (field.assist && field.kind === 'time') refreshDurations();
  }

  function viewForm() {
    const schema = state.model.schema;
    fieldNodes.clear();
    if (observer) observer.disconnect();

    const nav = h(
      'aside',
      { class: 'form-nav' },
      h('div', { class: 'fn-head' }, h('small', { class: 'muted' }, 'Modèle'), h('strong', null, state.model.name)),
      h(
        'ol',
        { class: 'fn-list' },
        schema.sections.map((s) =>
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: 'fn-item', dataset: { sec: s.id }, onclick: () => scrollToSection(s.id) },
              h('span', { class: 'fn-title' }, s.title),
              h('span', { class: 'fn-count', id: `count-${s.id}` }, '')
            )
          )
        )
      ),
      h('div', { class: 'fn-progress' }, h('div', { class: 'bar' }, h('span', { id: 'progress-bar' })), h('small', { id: 'progress-text', class: 'muted' }, ''))
    );

    const sections = schema.sections.map((s, i) =>
      h(
        'section',
        { class: 'fsec', id: `sec-${s.id}`, dataset: { sec: s.id }, style: { '--i': String(i) } },
        h('h2', null, h('span', { class: 'fsec-num' }, String(i + 1)), h('span', null, s.title.replace(/^\d+\s*[.)-]\s*/, ''))),
        h('div', { class: 'fgrid' }, s.fields.map(fieldEl))
      )
    );

    const scroll = h(
      'div',
      { class: 'form-scroll', id: 'form-scroll' },
      h(
        'header',
        { class: 'form-head' },
        h('div', null, h('h1', null, prettyTitle(schema.title)), h('p', { class: 'muted' }, state.replace ? 'Modification d\'une fiche déjà générée : elle sera remplacée.' : 'Remplissez ce qui est utile : les cases laissées vides restent vides sur la fiche.')),
        h('div', { class: 'form-head-actions' }, h('span', { class: 'draft-state', id: 'draft-state' }, 'Brouillon enregistré automatiquement'), button('Nouvelle fiche', 'plus', 'ghost small', newFicheConfirm, { title: 'Vider le formulaire (date du jour et technicien repris)' }))
      ),
      sections,
      h('div', { class: 'form-end' }, svg('check'), h('p', null, 'Fin du formulaire. Vérifiez puis générez la fiche.'))
    );

    const bar = h(
      'footer',
      { class: 'form-bar' },
      h('div', { class: 'fb-progress' }, h('strong', { id: 'fb-count' }, ''), h('small', { class: 'muted', id: 'fb-hint' }, '')),
      button('Générer la fiche', 'spark', 'primary big', generateFiche, { title: 'Générer la fiche Word (Ctrl+Entrée)' })
    );

    const view = h('section', { class: 'form-view' }, nav, h('div', { class: 'form-main' }, scroll, bar));

    // Section affichée : mise en avant dans la barre de gauche
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        for (const b of view.querySelectorAll('.fn-item')) b.classList.toggle('active', b.dataset.sec === visible.target.dataset.sec);
      },
      { root: scroll, rootMargin: '-10% 0px -60% 0px' }
    );
    requestAnimationFrame(() => {
      for (const s of view.querySelectorAll('.fsec')) observer.observe(s);
      updateProgress();
      refreshDurations();
      const first = view.querySelector('.fn-item');
      if (first) first.classList.add('active');
    });
    return view;
  }

  /** « FICHE INTERVENTION » → « Fiche intervention ». */
  function prettyTitle(t) {
    const s = String(t || 'Fiche').trim();
    return s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;
  }

  function scrollToSection(id) {
    const el = $(`sec-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updateProgress() {
    if (state.view !== 'form' && !$('progress-bar')) return;
    const schema = state.model.schema;
    let filled = 0;
    let total = 0;
    for (const s of schema.sections) {
      const n = s.fields.filter((f) => F.isFilled(f, state.values[f.key])).length;
      filled += n;
      total += s.fields.length;
      const c = $(`count-${s.id}`);
      if (c) {
        c.textContent = `${n}/${s.fields.length}`;
        c.classList.toggle('done', n === s.fields.length);
      }
    }
    const pct = total ? Math.round((filled / total) * 100) : 0;
    const bar = $('progress-bar');
    if (bar) bar.style.width = `${pct}%`;
    const text = $('progress-text');
    if (text) text.textContent = `${filled} / ${total} champs remplis`;
    const count = $('fb-count');
    if (count) count.textContent = `${filled} / ${total} champs remplis`;
    const hint = $('fb-hint');
    if (hint) hint.textContent = filled === total ? 'Tout est rempli.' : `${plural(total - filled, 'case restera vide', 'cases resteront vides')} sur la fiche.`;
  }

  // ---------------------------------------------------------------------------
  // Champs
  // ---------------------------------------------------------------------------

  const WIDE = new Set(['textarea', 'choice', 'check', 'blanks', 'signature']);
  const inputId = (f, suffix = '') => `f-${f.key.replace(/\./g, '-')}${suffix}`;

  function fieldEl(f) {
    const value = state.values[f.key];
    const wide = WIDE.has(f.kind) || (f.kind === 'text' && f.label.length > 38);
    const node = h('div', { class: `fld fld-${f.kind}${wide ? ' wide' : ''}${F.isFilled(f, value) ? ' filled' : ''}`, dataset: { key: f.key } });
    fieldNodes.set(f.key, node);
    const label = h('label', { class: 'fld-label', for: inputId(f) }, h('span', null, f.label), f.kind === 'choice' && f.multiple ? h('small', { class: 'muted' }, 'plusieurs choix possibles') : null);
    let body;
    switch (f.kind) {
      case 'choice':
        body = choiceEl(f);
        label.removeAttribute('for');
        break;
      case 'check':
        body = checkEl(f);
        label.removeAttribute('for');
        break;
      case 'blanks':
        body = blanksEl(f);
        break;
      case 'signature':
        body = signatureEl(f);
        break;
      case 'textarea':
        body = textareaEl(f);
        break;
      default:
        body = inputEl(f);
    }
    node.append(label, body);
    return node;
  }

  const INPUT_TYPES = { date: 'date', time: 'time', datetime: 'datetime-local', email: 'email', tel: 'tel' };
  const PLACEHOLDERS = { email: 'nom@exemple.fr', tel: '06 12 34 56 78' };

  function inputEl(f) {
    const input = h('input', {
      id: inputId(f),
      type: INPUT_TYPES[f.kind] || 'text',
      class: 'input',
      autocomplete: 'off',
      spellcheck: f.kind === 'text' ? 'true' : 'false',
      placeholder: PLACEHOLDERS[f.kind] || null,
      maxlength: '2000',
    });
    input.value = typeof state.values[f.key] === 'string' ? state.values[f.key] : '';
    const warn = h('small', { class: 'fld-warn', hidden: true });
    const check = () => {
      if (f.kind === 'email') {
        const v = input.value.trim();
        warn.hidden = !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
        warn.textContent = 'Adresse e-mail incomplète ?';
      }
    };
    input.addEventListener('input', () => {
      setValue(f, input.value);
      check();
    });
    check();

    const a = f.assist || {};
    const tools = [];
    if (a.now) {
      tools.push(
        button(f.kind === 'datetime' ? 'Maintenant' : 'Maintenant', 'clock', 'ghost tiny', () => {
          const now = new Date();
          input.value = f.kind === 'datetime' ? `${F.isoToday(now)}T${F.isoTime(now)}` : F.isoTime(now);
          setValue(f, input.value);
        })
      );
    }
    if (f.kind === 'date') {
      tools.push(
        button('Aujourd\'hui', null, 'ghost tiny', () => {
          input.value = F.isoToday();
          setValue(f, input.value);
        })
      );
    }
    if (a.ref) {
      tools.push(
        button('Générer', 'hash', 'ghost tiny', async () => {
          const res = await api.nextRef();
          if (res && res.ok) {
            input.value = res.ref;
            setValue(f, input.value);
          }
        }, { title: 'Référence du jour : INT-AAAAMMJJ-NN' })
      );
    }
    const extra = [];
    if (a.duration) extra.push(h('div', { class: 'fld-duration', dataset: { durationFor: f.key }, hidden: true }));
    if (a.remember) extra.push(h('small', { class: 'fld-hint muted' }, 'Repris automatiquement sur la prochaine fiche.'));

    const field = h('div', { class: `input-wrap${f.prefix ? ' has-prefix' : ''}` }, f.prefix ? h('span', { class: 'prefix' }, f.prefix) : null, input, tools.length ? h('div', { class: 'input-tools' }, tools) : null);
    return h('div', { class: 'fld-body' }, field, warn, extra);
  }

  function textareaEl(f) {
    const ta = h('textarea', { id: inputId(f), class: 'input', rows: String(Math.min(f.rows || 3, 6)), spellcheck: 'true', maxlength: '8000' });
    ta.value = typeof state.values[f.key] === 'string' ? state.values[f.key] : '';
    ta.addEventListener('input', () => setValue(f, ta.value));
    return h('div', { class: 'fld-body' }, f.prefix ? h('span', { class: 'prefix block' }, f.prefix) : null, ta);
  }

  function choiceValue(f) {
    const v = state.values[f.key];
    return v && Array.isArray(v.selected) ? { selected: [...v.selected], extra: { ...(v.extra || {}) } } : { selected: [], extra: {} };
  }

  function choiceEl(f) {
    const wrap = h('div', { class: 'fld-body' });
    const chips = h('div', { class: 'chips', role: f.multiple ? 'group' : 'radiogroup', 'aria-label': f.label });
    const extras = h('div', { class: 'chip-extras' });

    const render = () => {
      const v = choiceValue(f);
      chips.replaceChildren(
        ...f.options.map((o, i) => {
          const on = v.selected.includes(i);
          return h(
            'button',
            {
              type: 'button',
              class: `chip${on ? ' on' : ''}`,
              role: f.multiple ? 'checkbox' : 'radio',
              'aria-checked': String(on),
              title: o.text,
              onclick: () => toggle(i),
            },
            h('span', { class: 'chip-box', 'aria-hidden': 'true' }, on ? svg('check') : null),
            h('span', { class: 'chip-text' }, h('span', null, o.label), o.sub ? h('small', null, o.sub) : null)
          );
        })
      );
      extras.replaceChildren(
        ...f.options
          .map((o, i) => {
            if (!o.extra || !v.selected.includes(i)) return null;
            const input = h('input', { type: o.extra.kind === 'date' ? 'date' : 'text', class: 'input', id: inputId(f, `-x${i}`), placeholder: o.extra.kind === 'date' ? null : o.extra.label, maxlength: '500', spellcheck: 'true' });
            input.value = String(v.extra[i] || '');
            input.addEventListener('input', () => {
              const cur = choiceValue(f);
              cur.extra[i] = input.value;
              setValue(f, cur);
            });
            return h('label', { class: 'chip-extra', for: input.id }, h('span', null, `${o.label} — ${o.extra.label}`), input);
          })
          .filter(Boolean)
      );
    };

    const toggle = (i) => {
      const v = choiceValue(f);
      const had = v.selected.includes(i);
      if (f.multiple) v.selected = had ? v.selected.filter((x) => x !== i) : [...v.selected, i].sort((a, b) => a - b);
      else v.selected = had ? [] : [i];
      setValue(f, v);
      render();
      // Précision demandée : le champ prend le focus tout de suite
      if (!had && f.options[i].extra) {
        const x = $(inputId(f, `-x${i}`));
        if (x) x.focus();
      }
    };

    render();
    wrap.append(chips, extras);
    return wrap;
  }

  function checkEl(f) {
    const o = f.options[0];
    const input = h('input', { type: 'checkbox', id: inputId(f) });
    input.checked = state.values[f.key] === true;
    input.addEventListener('change', () => setValue(f, input.checked));
    return h(
      'div',
      { class: 'fld-body' },
      f.note ? h('blockquote', { class: 'note' }, f.note) : null,
      h('label', { class: 'toggle', for: input.id }, input, h('span', { class: 'toggle-box', 'aria-hidden': 'true' }, svg('check')), h('span', null, o ? o.text : f.label))
    );
  }

  function blanksEl(f) {
    const cur = () => (Array.isArray(state.values[f.key]) ? [...state.values[f.key]] : f.blanks.map(() => ''));
    const sentence = h('div', { class: 'sentence' });
    const parts = f.parts || f.blanks.map((_, i) => ({ blank: i }));
    let firstId = null;
    for (const p of parts) {
      if (p.blank === undefined) {
        const t = p.text.trim();
        if (t) sentence.append(h('span', { class: 'sentence-text' }, t));
        continue;
      }
      const b = f.blanks[p.blank];
      const id = inputId(f, p.blank ? `-${p.blank}` : '');
      if (!firstId) firstId = id;
      const input = h('input', { id, type: b.kind === 'date' ? 'date' : 'text', class: 'input', placeholder: b.kind === 'date' ? null : b.label, 'aria-label': b.label, maxlength: '300' });
      input.value = String(cur()[p.blank] || '');
      input.addEventListener('input', () => {
        const v = cur();
        v[p.blank] = input.value;
        setValue(f, v);
      });
      sentence.append(input);
    }
    return h('div', { class: 'fld-body' }, sentence);
  }

  function signatureEl(f) {
    const cur = () => {
      const v = state.values[f.key];
      return v && typeof v === 'object' ? { name: String(v.name || ''), image: String(v.image || '') } : { name: '', image: '' };
    };
    const name = h('input', { id: inputId(f), type: 'text', class: 'input', placeholder: 'Nom et prénom', autocomplete: 'off', maxlength: '200' });
    name.value = cur().name;
    name.addEventListener('input', () => setValue(f, { ...cur(), name: name.value }));
    const pad = h('div', { class: 'sig-box' });
    const render = () => {
      const v = cur();
      pad.replaceChildren(
        ...[
        v.image
          ? h('img', { class: 'sig-img', src: v.image, alt: `Signature : ${f.label}` })
          : h('button', { type: 'button', class: 'sig-empty', onclick: () => sign() }, svg('pen'), h('span', null, 'Signer ici')),
        v.image
          ? h('div', { class: 'sig-actions' }, button('Refaire', 'redo', 'ghost tiny', () => sign()), button('Effacer', 'x', 'ghost tiny', () => {
              setValue(f, { ...cur(), image: '' });
              render();
            }))
          : null,
        ].filter(Boolean)
      );
    };
    const sign = async () => {
      const image = await signatureModal(f.label);
      if (image === null) return;
      setValue(f, { ...cur(), image });
      render();
    };
    render();
    const a = f.assist || {};
    return h('div', { class: 'fld-body sig' }, h('div', { class: 'input-wrap' }, name), pad, a.remember ? h('small', { class: 'fld-hint muted' }, 'Nom et signature repris automatiquement sur la prochaine fiche.') : null, h('small', { class: 'fld-hint muted' }, 'La signature est facultative : la case peut aussi être signée à la main sur la fiche imprimée.'));
  }

  /** Durée calculée (heure d'arrivée → heure de fin), proposée dans « Temps / Tarif ». */
  function refreshDurations() {
    const fields = allFields();
    const start = fields.find((f) => f.kind === 'time' && /arriv|debut|depart du/.test(F.norm(f.label)));
    const end = fields.find((f) => f.kind === 'time' && /\bfin\b/.test(F.norm(f.label)));
    for (const el of document.querySelectorAll('[data-duration-for]')) {
      const d = start && end ? F.duration(state.values[start.key], state.values[end.key]) : '';
      el.hidden = !d;
      if (!d) continue;
      const target = fields.find((f) => f.key === el.dataset.durationFor);
      el.replaceChildren(
        svg('clock'),
        h('span', null, `Durée : ${d} (${F.frTime(state.values[start.key])} → ${F.frTime(state.values[end.key])})`),
        button('Insérer', null, 'ghost tiny', () => {
          const input = $(inputId(target));
          const cur = input.value.trim();
          input.value = cur ? (cur.includes(d) ? cur : `${d} — ${cur}`) : d;
          setValue(target, input.value);
        })
      );
    }
  }

  async function newFicheConfirm() {
    const filled = allFields().filter((f) => F.isFilled(f, state.values[f.key])).length;
    if (filled) {
      const ok = await confirmModal('Commencer une nouvelle fiche ?', 'Le formulaire sera vidé (la date du jour et le technicien sont repris). Les fiches déjà générées ne changent pas.', 'Nouvelle fiche');
      if (!ok) return;
    }
    store.remove(draftKey(state.model));
    startNew();
  }

  // ---------------------------------------------------------------------------
  // Génération
  // ---------------------------------------------------------------------------

  async function generateFiche() {
    if (!state.model || state.view !== 'form' || state.generating) return;
    state.generating = true;
    try {
      await generateNow();
    } finally {
      state.generating = false;
    }
  }

  async function generateNow() {
    saveDraft();
    const empty = state.model.schema.sections.flatMap((s) => s.fields.filter((f) => !F.isFilled(f, state.values[f.key])).map((f) => ({ f, s })));
    if (empty.length) {
      const choice = await emptyModal(empty);
      if (choice === 'fill') {
        const node = fieldNodes.get(empty[0].f.key);
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const input = node.querySelector('input, textarea, button');
          if (input) setTimeout(() => input.focus({ preventScroll: true }), 350);
          node.classList.add('flash');
          setTimeout(() => node.classList.remove('flash'), 1600);
        }
        return;
      }
      if (choice !== 'generate') return;
    }
    busy('Génération de la fiche…');
    let res;
    try {
      res = await api.generate(state.model.id, state.values, state.replace);
    } finally {
      busy('');
    }
    if (!res || !res.ok) return alertModal('Fiche non générée', (res && res.error) || 'Erreur inconnue.');
    rememberValues();
    store.remove(draftKey(state.model));
    state.replace = res.record.id;
    state.result = { record: res.record, checks: res.checks, data: res.data, from: 'generate' };
    state.filter = res.checks.some((c) => !c.ok) ? 'problems' : 'all';
    show('result', viewResult);
  }

  async function backToForm() {
    if (!state.model) return;
    if (!(await keepOtherDraft(state.model, state.replace))) return;
    show('form', viewForm);
    saveDraft();
  }

  /**
   * Un autre brouillon est en cours sur ce modèle (une autre fiche) : il serait remplacé par la saisie reprise.
   * → true si on peut continuer.
   */
  async function keepOtherDraft(model, replace) {
    const draft = store.get(draftKey(model), null);
    if (!draft || !draft.values || (draft.replace || null) === (replace || null)) return true;
    const fields = model.schema.sections.flatMap((s) => s.fields);
    if (!fields.some((f) => F.isFilled(f, draft.values[f.key]))) return true;
    return confirmModal('Remplacer le brouillon en cours ?', `Une autre fiche « ${model.name} » est en cours de saisie (brouillon du ${fmtDateTime(draft.updatedAt || Date.now())}). Elle sera remplacée par cette saisie.`, 'Remplacer');
  }

  // ---------------------------------------------------------------------------
  // Vue « Fiche générée »
  // ---------------------------------------------------------------------------

  async function openRecent(id) {
    busy('Ouverture de la fiche…');
    let res;
    try {
      res = await api.readFiche(id);
    } finally {
      busy('');
    }
    if (!res || !res.ok) return toast((res && res.error) || 'Fiche illisible.', 'error');
    state.model = res.modelAvailable ? await loadModel(res.record.modelId) : null;
    state.values = res.inputs && res.inputs.values ? res.inputs.values : {};
    state.replace = res.record.id;
    state.result = { record: res.record, checks: res.checks, data: res.data, from: 'recent' };
    state.filter = res.checks && res.checks.some((c) => !c.ok) ? 'problems' : 'all';
    show('result', viewResult);
  }

  async function resumeRecent(id) {
    const res = await api.readFiche(id);
    if (!res || !res.ok) return toast((res && res.error) || 'Fiche illisible.', 'error');
    if (!res.modelAvailable || !res.inputs) return alertModal('Reprise impossible', 'Le modèle de cette fiche a été retiré ou modifié depuis : ses saisies ne peuvent plus être reprises. Ouvrez la fiche dans Word pour la modifier.');
    const model = await loadModel(res.record.modelId);
    if (!model) return;
    if (!(await keepOtherDraft(model, res.record.id))) return;
    state.model = model;
    state.values = res.inputs.values || {};
    state.replace = res.record.id;
    show('form', viewForm);
    toast('Saisie reprise : la fiche sera remplacée à la prochaine génération.');
  }

  function viewResult() {
    const { record, checks } = state.result;
    const list = checks || [];
    const problems = list.filter((c) => !c.ok);
    const filled = list.filter((c) => c.filled);
    const ok = checks && !problems.length;
    const modified = state.result.from === 'recent' && problems.length;

    const head = h(
      'header',
      { class: `result-head ${!checks ? 'neutral' : ok ? 'ok' : 'bad'}` },
      h('span', { class: 'rh-icon' }, svg(!checks ? 'doc' : ok ? 'check' : 'alert')),
      h(
        'div',
        { class: 'rh-text' },
        h('h1', null, !checks ? 'Fiche' : ok ? (state.result.from === 'generate' ? 'Fiche générée et vérifiée' : 'Fiche vérifiée') : modified ? 'Fiche modifiée depuis sa génération' : 'Fiche générée — à vérifier'),
        h('p', null, h('strong', null, record.name), h('span', { class: 'muted' }, ` · ${record.modelName} · ${fmtDateTime(record.updatedAt || record.createdAt)}`)),
        checks
          ? h(
              'p',
              { class: 'rh-stats' },
              ok
                ? `Les ${plural(list.length, 'champ a été relu', 'champs ont été relus')} dans le fichier : ${plural(filled.length, 'saisie présente', 'saisies présentes')}, ${plural(list.length - filled.length, 'case laissée vide', 'cases laissées vides')}.`
                : modified
                  ? `${plural(problems.length, 'case ne correspond', 'cases ne correspondent')} plus à la saisie (fiche modifiée dans Word ?).`
                  : `${plural(problems.length, 'case ne correspond', 'cases ne correspondent')} pas à la saisie : vérifiez-les dans l'aperçu.`
            )
          : h('p', { class: 'rh-stats' }, 'Vérification impossible : le modèle de cette fiche a été retiré ou modifié depuis.')
      ),
      h(
        'div',
        { class: 'rh-actions' },
        button('Ouvrir dans Word', 'open', 'primary', () => openFiche(record.id)),
        button('Exporter en PDF', 'pdf', '', exportPdf),
        button('Dossier', 'folder', 'ghost', () => api.showFiche(record.id), { title: 'Afficher dans le dossier' }),
        state.model ? button('Modifier la saisie', 'edit', 'ghost', () => backToForm()) : null,
        state.model ? button('Nouvelle fiche', 'plus', 'ghost', async () => {
          if (!(await keepOtherDraft(state.model, null))) return;
          store.remove(draftKey(state.model));
          startNew();
        }) : null
      )
    );

    const checksPane = checks ? checksEl(list) : h('div', { class: 'checks empty' }, h('p', { class: 'muted' }, 'Pas de vérification disponible pour cette fiche.'));

    const pages = h('div', { class: 'preview-pages', id: 'preview-pages' });
    const zoomLabel = h('span', { class: 'zoom-label', id: 'zoom-label' }, '');
    const preview = h(
      'section',
      { class: 'preview' },
      h(
        'div',
        { class: 'preview-bar' },
        h('strong', null, 'Aperçu du fichier généré'),
        h('div', { class: 'zoom' }, button('', 'zoomOut', 'icon', () => zoomBy(-0.1), { title: 'Réduire', 'aria-label': 'Réduire' }), zoomLabel, button('', 'zoomIn', 'icon', () => zoomBy(0.1), { title: 'Agrandir', 'aria-label': 'Agrandir' }), button('', 'fit', 'icon', () => setZoom(null), { title: 'Ajuster à la largeur', 'aria-label': 'Ajuster à la largeur' }))
      ),
      h('div', { class: 'preview-scroll', id: 'preview-scroll' }, pages, h('div', { class: 'preview-loading', id: 'preview-loading' }, h('span', { class: 'spinner' }), 'Préparation de l\'aperçu…'))
    );

    const view = h('section', { class: 'result-view' }, head, h('div', { class: 'result-body' }, checksPane, preview));
    requestAnimationFrame(async () => {
      try {
        await renderDocx(state.result.data, pages);
        setZoom(state.zoom);
      } catch (err) {
        pages.replaceChildren(h('p', { class: 'muted pad' }, `Aperçu indisponible (${err && err.message ? err.message : err}). Ouvrez la fiche dans Word.`));
      } finally {
        const l = $('preview-loading');
        if (l) l.remove();
      }
    });
    return view;
  }

  function checksEl(list) {
    const counts = {
      all: list.length,
      filled: list.filter((c) => c.filled && c.ok).length,
      empty: list.filter((c) => !c.filled && c.ok).length,
      problems: list.filter((c) => !c.ok).length,
    };
    const tabs = [
      ['all', 'Tout'],
      ['filled', 'Remplis'],
      ['empty', 'Vides'],
      ['problems', 'Problèmes'],
    ];
    const body = h('div', { class: 'checks-list' });
    const tabBar = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Filtrer la vérification' });

    const render = () => {
      tabBar.replaceChildren(
        ...tabs
          .filter(([k]) => k !== 'problems' || counts.problems)
          .map(([k, label]) =>
            h(
              'button',
              { type: 'button', role: 'tab', class: `seg-btn${state.filter === k ? ' on' : ''}${k === 'problems' ? ' bad' : ''}`, 'aria-selected': String(state.filter === k), onclick: () => ((state.filter = k), render()) },
              label,
              h('span', { class: 'seg-count' }, counts[k])
            )
          )
      );
      const keep = (c) => (state.filter === 'filled' ? c.filled && c.ok : state.filter === 'empty' ? !c.filled && c.ok : state.filter === 'problems' ? !c.ok : true);
      const groups = [];
      let current = null;
      for (const c of list.filter(keep)) {
        if (!current || current.section !== c.section) {
          current = { section: c.section, items: [] };
          groups.push(current);
        }
        current.items.push(c);
      }
      body.replaceChildren(
        ...(groups.length
          ? groups.map((g) =>
              h(
                'div',
                { class: 'cg' },
                h('h3', null, g.section),
                g.items.map((c) =>
                  h(
                    'div',
                    { class: `ci ${!c.ok ? 'bad' : c.filled ? 'ok' : 'blank'}` },
                    h('span', { class: 'ci-icon', title: !c.ok ? 'Différent de la saisie' : c.filled ? 'Présent dans le fichier' : 'Laissé vide' }, svg(!c.ok ? 'alert' : c.filled ? 'check' : 'list')),
                    h('div', { class: 'ci-text' }, h('span', { class: 'ci-label' }, c.label), h('span', { class: 'ci-value' }, c.value || 'Laissé vide'), c.problem ? h('small', { class: 'ci-problem' }, c.problem) : null)
                  )
                )
              )
            )
          : [h('p', { class: 'muted pad' }, 'Rien à afficher ici.')])
      );
    };
    render();
    return h('section', { class: 'checks' }, h('div', { class: 'checks-head' }, h('strong', null, 'Vérification'), h('small', { class: 'muted' }, 'Chaque case a été relue dans le fichier .docx produit.')), tabBar, body);
  }

  // Zoom de l'aperçu (null : ajusté à la largeur du panneau)
  function setZoom(z) {
    state.zoom = z;
    const pages = $('preview-pages');
    const scroll = $('preview-scroll');
    if (!pages || !scroll) return;
    const fit = Math.max(0.3, Math.min(2, (scroll.clientWidth - 40) / PAGE_WIDTH));
    const value = z === null ? fit : z;
    pages.style.setProperty('zoom', String(value));
    const label = $('zoom-label');
    if (label) label.textContent = `${Math.round(value * 100)} %`;
  }

  function zoomBy(step) {
    const pages = $('preview-pages');
    const cur = pages ? Number(pages.style.getPropertyValue('zoom')) || 1 : 1;
    setZoom(Math.max(0.3, Math.min(2.5, Math.round((cur + step) * 10) / 10)));
  }

  window.addEventListener('resize', () => {
    if (state.view === 'result' && state.zoom === null) setZoom(null);
  });

  async function exportPdf() {
    const record = state.result.record;
    busy('Export PDF…');
    let res;
    try {
      res = await api.exportPdf(record.id);
      if (res && res.fallback) {
        // Sans Word : impression de l'aperçu (copie dans la zone d'impression, seule visible)
        const pages = $('preview-pages');
        if (!pages || !pages.querySelector('section')) {
          res = { ok: false, error: 'Word n\'est pas disponible et l\'aperçu n\'est pas prêt : réessayez dans un instant, ou ouvrez la fiche dans Word pour l\'exporter.' };
        } else {
          const area = $('print-area');
          area.replaceChildren(pages.cloneNode(true));
          area.firstChild.style.removeProperty('zoom');
          area.firstChild.removeAttribute('id');
          document.body.classList.add('printing');
          try {
            res = await api.printPdf(record.id);
          } finally {
            document.body.classList.remove('printing');
            area.replaceChildren();
          }
        }
      }
    } finally {
      busy('');
    }
    if (!res || !res.ok) return toast((res && res.error) || 'Export PDF impossible.', 'error');
    const file = res.file;
    toast(`PDF enregistré${res.by === 'word' ? ' (Word)' : ''} : ${file.split(/[\\/]/).pop()}`);
    const open = await confirmModal('PDF enregistré', `${file}\n\nVoulez-vous l'ouvrir ?`, 'Ouvrir le PDF');
    if (open) {
      const r = await api.openPdf(file);
      if (r && r.ok === false) toast(r.error || 'Ouverture impossible.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Fenêtres (modales) : confirmation, alerte, champs vides, signature
  // ---------------------------------------------------------------------------

  let modalClose = null;

  function modal({ title, body, actions, cls, onOpen }) {
    return new Promise((resolve) => {
      const layer = $('modal');
      const previous = document.activeElement;
      const close = (value) => {
        layer.hidden = true;
        layer.replaceChildren();
        modalClose = null;
        if (previous && previous.focus) previous.focus({ preventScroll: true });
        resolve(value);
      };
      modalClose = () => close(null);
      const box = h(
        'div',
        { class: `modal ${cls || ''}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
        h('h2', { id: 'modal-title' }, title),
        h('div', { class: 'modal-body' }, body),
        h(
          'div',
          { class: 'modal-actions' },
          actions.map((a) => button(a.label, a.icon, a.kind || 'ghost', () => (a.handler ? a.handler(close) : close(a.value)), a.attrs))
        )
      );
      layer.replaceChildren(h('div', { class: 'modal-backdrop', onclick: () => close(null) }), box);
      layer.hidden = false;
      const primary = box.querySelector('.modal-actions .btn.primary, .modal-actions .btn.danger') || box.querySelector('.modal-actions .btn');
      if (onOpen) onOpen(box, close);
      else if (primary) primary.focus();
    });
  }

  const confirmModal = (title, text, ok, kind = 'primary') =>
    modal({
      title,
      body: h('p', { class: 'pre' }, text),
      actions: [
        { label: 'Annuler', value: false },
        { label: ok, value: true, kind },
      ],
    }).then((v) => v === true);

  const alertModal = (title, text) => modal({ title, body: h('p', { class: 'pre' }, text), actions: [{ label: 'OK', value: true, kind: 'primary' }] });

  function emptyModal(empty) {
    const bySection = new Map();
    for (const { f, s } of empty) {
      if (!bySection.has(s.title)) bySection.set(s.title, []);
      bySection.get(s.title).push(f.label);
    }
    const body = h(
      'div',
      null,
      h('p', null, `${plural(empty.length, 'case restera vide', 'cases resteront vides')} sur la fiche. C'est normal pour celles qui ne concernent pas cette intervention.`),
      h('div', { class: 'empty-list' }, [...bySection].map(([sec, labels]) => h('div', null, h('strong', null, sec), h('ul', null, labels.map((l) => h('li', null, l))))))
    );
    return modal({
      title: 'Des cases sont vides',
      body,
      cls: 'wide',
      actions: [
        { label: 'Compléter', value: 'fill', icon: 'edit' },
        { label: 'Générer quand même', value: 'generate', kind: 'primary', icon: 'spark' },
      ],
    });
  }

  /** Signature à la souris, au stylet ou au doigt → PNG recadré (data URL), '' si vide, null si annulé. */
  function signatureModal(label) {
    const canvas = h('canvas', { class: 'sig-canvas', 'aria-label': 'Zone de signature' });
    const hint = h('p', { class: 'muted sig-hint' }, 'Signez dans le cadre avec la souris, un stylet ou le doigt.');
    let ctx = null;
    let drawing = false;
    let last = null;
    let dirty = false;
    const ratio = window.devicePixelRatio || 1;

    const setup = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 2.4;
    };
    const point = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      last = point(e);
      ctx.beginPath();
      ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = '#111827';
      ctx.fill();
      dirty = true;
      hint.hidden = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const p = point(ev);
        const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
        ctx.beginPath();
        ctx.moveTo(last.mid ? last.mid.x : last.x, last.mid ? last.mid.y : last.y);
        ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
        ctx.stroke();
        last = { ...p, mid };
      }
    });
    const stop = () => (drawing = false);
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    /** Image recadrée sur le tracé (marge de 10 px), 1200 px de large au plus. */
    const exportPng = () => {
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return '';
      const pad = Math.round(10 * ratio);
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(width - 1, maxX + pad);
      maxY = Math.min(height - 1, maxY + pad);
      const w = maxX - minX + 1;
      const hgt = maxY - minY + 1;
      const scale = Math.min(1, 1200 / w);
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w * scale));
      out.height = Math.max(1, Math.round(hgt * scale));
      out.getContext('2d').drawImage(canvas, minX, minY, w, hgt, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    };

    return modal({
      title: `Signature — ${label}`,
      cls: 'wide sig-modal',
      body: h('div', null, h('div', { class: 'sig-frame' }, canvas, h('span', { class: 'sig-line', 'aria-hidden': 'true' })), hint),
      onOpen: () => requestAnimationFrame(setup),
      actions: [
        {
          label: 'Effacer',
          icon: 'x',
          handler: () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            dirty = false;
            hint.hidden = false;
          },
        },
        { label: 'Annuler', value: null },
        { label: 'Valider la signature', kind: 'primary', icon: 'check', handler: (close) => close(dirty ? exportPng() : '') },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Thème, clavier, démarrage
  // ---------------------------------------------------------------------------

  async function initTheme() {
    const buttons = [...document.querySelectorAll('.theme [data-theme]')];
    const mark = (mode) => buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === mode)));
    try {
      const { mode } = await api.getTheme();
      mark(mode);
    } catch {
      mark('system');
    }
    for (const b of buttons) {
      b.addEventListener('click', async () => {
        const res = await api.setTheme(b.dataset.theme);
        if (res && res.ok) mark(res.mode);
      });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalClose) {
      e.preventDefault();
      modalClose();
      return;
    }
    if (modalClose) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.view === 'form') {
      e.preventDefault();
      generateFiche();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.view === 'form') {
      e.preventDefault();
      saveDraft();
      toast('Brouillon enregistré.');
    }
  });

  $('home-link').addEventListener('click', () => state.view !== 'home' && goHome());

  // Sauvegarde du brouillon si la fenêtre se ferme pendant la saisie
  window.addEventListener('beforeunload', () => {
    if (state.view === 'form') saveDraft();
  });

  async function start() {
    await initTheme();
    try {
      state.info = await api.info();
    } catch {
      state.info = {};
    }
    await refreshLists();
    show('home', viewHome);
    api.uiReady();
  }

  start();
})();
