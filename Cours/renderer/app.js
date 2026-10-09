/*
 * app.js — Interface de Cours.
 *
 * Trois vues, construites sans innerHTML à partir de lib/content.js :
 *   - accueil : une carte par partie (M.Julia, A.Julia), avancement, « Reprendre la lecture » ;
 *   - partie : sommaire des chapitres à gauche, résumé du chapitre à droite (ou « Résumé à venir ») ;
 *   - recherche : résultats dans toutes les parties, accents et majuscules ignorés.
 * Chapitres lus et dernière lecture : gardés dans la page (localStorage).
 * Clavier : Ctrl+K recherche · Échap retour · ← → chapitre précédent / suivant · 1, 2… ouvrir une partie.
 */
'use strict';

(() => {
  const C = window.Course;
  const DATA = window.CoursContent;
  const api = window.cours || null;
  const $ = (id) => document.getElementById(id);
  const main = $('main');
  const READ_KEY = 'cours.read.v1';
  const LAST_KEY = 'cours.last.v1';

  // ------------------------------------------------------------------ utilitaires

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const ns = 'http://www.w3.org/2000/svg';
  function icon(paths) {
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  const ICONS = {
    back: ['M15 5l-7 7 7 7'],
    next: ['M9 5l7 7-7 7'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5', 'M8 7h8M8 10.5h6'],
    pen: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
    key: ['M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z'],
    alert: ['M12 3l10 18H2z', 'M12 10v4.5M12 17.5v.5'],
    info: ['M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19z', 'M12 11v5.5M12 7.5v.5'],
  };

  /** Texte enrichi (**gras**, `code`) en éléments. */
  function rich(text) {
    const frag = document.createDocumentFragment();
    for (const t of C.richTokens(text)) {
      if (t.type === 'b') frag.append(h('strong', null, t.text));
      else if (t.type === 'code') frag.append(h('code', null, t.text));
      else frag.append(document.createTextNode(t.text));
    }
    return frag;
  }

  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  const store = {
    get(key, fallback) {
      try {
        const v = JSON.parse(localStorage.getItem(key));
        return v === null ? fallback : v;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // stockage indisponible : sans conséquence
      }
    },
  };

  // ------------------------------------------------------------------ état

  const parts = DATA && Array.isArray(DATA.parts) ? DATA.parts : [];
  const state = {
    view: 'home', // home | part | search
    partId: null,
    chapterId: null,
    query: '',
    read: new Set(store.get(READ_KEY, [])),
  };

  const partOf = (id) => parts.find((p) => p.id === id) || null;
  const chapterOf = (part, id) => (part ? part.chapters.find((c) => c.id === id) || null : null);
  const readKey = (partId, chapterId) => `${partId}/${chapterId}`;

  function setRead(partId, chapterId, value) {
    const k = readKey(partId, chapterId);
    if (value) state.read.add(k);
    else state.read.delete(k);
    store.set(READ_KEY, [...state.read]);
  }

  // ------------------------------------------------------------------ navigation

  function go(view, { partId = state.partId, chapterId = null, focus = true } = {}) {
    state.view = view;
    if (view === 'part') {
      const part = partOf(partId);
      if (!part) return go('home');
      state.partId = part.id;
      // Chapitre demandé, sinon le dernier lu dans cette partie, sinon le premier
      const last = store.get(LAST_KEY, null);
      const wanted = chapterOf(part, chapterId) || (last && last.partId === part.id && chapterOf(part, last.chapterId)) || part.chapters[0];
      state.chapterId = wanted ? wanted.id : null;
      if (wanted) store.set(LAST_KEY, { partId: part.id, chapterId: wanted.id });
    }
    render();
    if (focus) main.focus({ preventScroll: true });
    main.scrollTop = 0;
  }

  function render() {
    renderCrumbs();
    document.body.dataset.view = state.view;
    const part = partOf(state.partId);
    document.body.style.setProperty('--part', state.view === 'part' && part ? part.accent : 'var(--accent)');
    if (state.view === 'search') main.replaceChildren(viewSearch());
    else if (state.view === 'part') main.replaceChildren(viewPart(part));
    else main.replaceChildren(viewHome());
  }

  function renderCrumbs() {
    const crumbs = $('crumbs');
    if (state.view === 'home') return crumbs.replaceChildren(); // déjà sur la liste des parties
    const items = [h('button', { type: 'button', class: 'crumb', onclick: () => go('home') }, 'Toutes les parties')];
    const part = partOf(state.partId);
    if (state.view === 'part' && part) {
      items.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('span', { class: 'crumb current', style: { '--c': part.accent } }, part.name));
    } else if (state.view === 'search') {
      items.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('span', { class: 'crumb current' }, 'Recherche'));
    }
    crumbs.replaceChildren(...items);
  }

  // ------------------------------------------------------------------ accueil

  function progressBar(value, max) {
    const pct = max ? Math.round((value / max) * 100) : 0;
    return h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value) }, h('span', { style: { width: `${pct}%` } }));
  }

  function partCard(part, index) {
    const s = C.partStats(part, state.read);
    return h(
      'button',
      { type: 'button', class: 'part-card', style: { '--part': part.accent }, onclick: () => go('part', { partId: part.id }), title: `Ouvrir ${part.name} (${index + 1})` },
      h('div', { class: 'pc-top' }, h('span', { class: 'avatar' }, part.initials || part.name.slice(0, 2)), h('span', { class: 'pc-key' }, String(index + 1))),
      h('h2', null, part.name),
      h('p', { class: 'pc-desc' }, part.description),
      h('ul', { class: 'topics' }, (part.topics || []).map((t) => h('li', null, t))),
      h(
        'div',
        { class: 'pc-foot' },
        h('div', { class: 'pc-stats' }, h('span', null, plural(s.chapters, 'chapitre', 'chapitres')), h('span', null, `${s.ready} résumé${s.ready > 1 ? 's' : ''} disponible${s.ready > 1 ? 's' : ''}`)),
        progressBar(s.read, s.chapters),
        h('div', { class: 'pc-read' }, s.ready ? `${s.read} / ${s.chapters} lu${s.read > 1 ? 's' : ''}` : 'Résumés en cours de rédaction')
      ),
      h('span', { class: 'pc-open' }, 'Ouvrir', icon(ICONS.next))
    );
  }

  function viewHome() {
    const last = store.get(LAST_KEY, null);
    const lp = last && partOf(last.partId);
    const lc = lp && chapterOf(lp, last.chapterId);
    const total = parts.reduce((n, p) => n + p.chapters.length, 0);
    const ready = parts.reduce((n, p) => n + C.partStats(p, state.read).ready, 0);
    return h(
      'section',
      { class: 'home' },
      h(
        'header',
        { class: 'home-head' },
        h('p', { class: 'eyebrow' }, 'Formation'),
        h('h1', null, 'Choisissez une partie'),
        h('p', { class: 'lead' }, `${plural(parts.length, 'partie', 'parties')} · ${plural(total, 'chapitre', 'chapitres')} · ${ready ? plural(ready, 'résumé disponible', 'résumés disponibles') : 'résumés en cours de rédaction'}`)
      ),
      h('div', { class: 'parts' }, parts.map(partCard)),
      lc
        ? h(
            'button',
            { type: 'button', class: 'resume', style: { '--part': lp.accent }, onclick: () => go('part', { partId: lp.id, chapterId: lc.id }) },
            h('span', { class: 'resume-icon' }, icon(ICONS.book)),
            h('span', { class: 'resume-text' }, h('small', null, 'Reprendre la lecture'), h('strong', null, `${lp.name} · ${lc.title}`)),
            icon(ICONS.next)
          )
        : null
    );
  }

  // ------------------------------------------------------------------ partie et chapitre

  function tocItem(part, chapter, index) {
    const ready = C.isReady(chapter);
    const read = state.read.has(readKey(part.id, chapter.id));
    const active = chapter.id === state.chapterId;
    return h(
      'li',
      null,
      h(
        'button',
        { type: 'button', class: `toc-item${active ? ' active' : ''}${ready ? ' ready' : ''}${read ? ' read' : ''}`, 'aria-current': active ? 'page' : null, onclick: () => go('part', { partId: part.id, chapterId: chapter.id, focus: false }) },
        h('span', { class: 'num' }, read ? icon(ICONS.check) : String(index + 1)),
        h('span', { class: 't' }, chapter.title, chapter.subtitle ? h('small', null, chapter.subtitle) : null),
        h('span', { class: 'state' }, ready ? (read ? 'Lu' : '') : 'À venir')
      )
    );
  }

  function viewPart(part) {
    const s = C.partStats(part, state.read);
    const toc = h(
      'aside',
      { class: 'toc' },
      h('div', { class: 'toc-head' }, h('span', { class: 'avatar' }, part.initials || part.name.slice(0, 2)), h('div', null, h('strong', null, part.name), h('small', null, part.description))),
      h('div', { class: 'toc-progress' }, progressBar(s.read, s.chapters), h('span', null, `${s.read} / ${s.chapters}`)),
      h('ol', { class: 'toc-list' }, part.chapters.map((c, i) => tocItem(part, c, i)))
    );
    return h('section', { class: 'part', style: { '--part': part.accent } }, toc, viewChapter(part, chapterOf(part, state.chapterId)));
  }

  function renderBlock(b) {
    const kind = C.blockKind(b);
    const v = kind ? b[kind] : null;
    switch (kind) {
      case 'p':
        return h('p', null, rich(v));
      case 'list':
        return h('ul', null, v.map((x) => h('li', null, rich(x))));
      case 'steps':
        return h('ol', { class: 'steps' }, v.map((x) => h('li', null, rich(x))));
      case 'table':
        return h(
          'div',
          { class: 'table-wrap' },
          h('table', null, v.head ? h('thead', null, h('tr', null, v.head.map((x) => h('th', null, rich(x))))) : null, h('tbody', null, (v.rows || []).map((r) => h('tr', null, r.map((x) => h('td', null, rich(x)))))))
        );
      case 'code':
        return h('pre', { class: 'code' }, String(v));
      case 'note':
        return h('div', { class: 'callout note' }, icon(ICONS.info), h('div', null, h('strong', null, 'À retenir'), h('p', null, rich(v))));
      case 'warn':
        return h('div', { class: 'callout warn' }, icon(ICONS.alert), h('div', null, h('strong', null, 'Attention'), h('p', null, rich(v))));
      default:
        return null;
    }
  }

  function viewChapter(part, chapter) {
    if (!chapter) return h('article', { class: 'chapter' }, h('p', { class: 'muted' }, 'Aucun chapitre dans cette partie.'));
    const { prev, next, index } = C.neighbours(part, chapter.id);
    const ready = C.isReady(chapter);
    const read = state.read.has(readKey(part.id, chapter.id));
    const body = [];
    if (ready) {
      if (Array.isArray(chapter.keyPoints) && chapter.keyPoints.length) {
        body.push(h('div', { class: 'keypoints' }, h('h2', null, icon(ICONS.key), 'Points clés'), h('ul', null, chapter.keyPoints.map((k) => h('li', null, rich(k))))));
      }
      for (const s of chapter.sections) body.push(h('section', { class: 'sec' }, h('h2', null, s.title), (s.blocks || []).map(renderBlock)));
    } else {
      body.push(
        h(
          'div',
          { class: 'empty' },
          h('span', { class: 'empty-icon' }, icon(ICONS.pen)),
          h('h2', null, 'Résumé à venir'),
          h('p', null, `Le résumé de « ${chapter.title} » (${part.name}) sera bientôt rédigé. Les points clés et les notions importantes apparaîtront ici.`)
        )
      );
    }
    const navBtn = (c, dir) =>
      c
        ? h('button', { type: 'button', class: `nav-btn ${dir}`, onclick: () => go('part', { partId: part.id, chapterId: c.id, focus: false }) }, dir === 'prev' ? icon(ICONS.back) : null, h('span', null, h('small', null, dir === 'prev' ? 'Précédent' : 'Suivant'), c.title), dir === 'next' ? icon(ICONS.next) : null)
        : h('span');
    return h(
      'article',
      { class: 'chapter' },
      h(
        'header',
        { class: 'ch-head' },
        h('p', { class: 'kicker' }, `${part.name} · Chapitre ${index + 1} / ${part.chapters.length}`),
        h('h1', null, chapter.title),
        chapter.subtitle ? h('p', { class: 'ch-sub' }, chapter.subtitle) : null,
        ready
          ? h(
              'button',
              { type: 'button', class: `read-toggle${read ? ' on' : ''}`, 'aria-pressed': String(read), onclick: () => (setRead(part.id, chapter.id, !read), render()) },
              icon(ICONS.check),
              read ? 'Lu' : 'Marquer comme lu'
            )
          : h('span', { class: 'badge soon' }, 'À venir')
      ),
      h('div', { class: 'ch-body' }, body),
      h('footer', { class: 'ch-nav' }, navBtn(prev, 'prev'), navBtn(next, 'next'))
    );
  }

  // ------------------------------------------------------------------ recherche

  function viewSearch() {
    const results = C.search(parts, state.query);
    const q = state.query.trim();
    return h(
      'section',
      { class: 'search-view' },
      h('h1', null, `Recherche : « ${q} »`),
      h('p', { class: 'lead' }, results.length ? plural(results.length, 'chapitre trouvé', 'chapitres trouvés') : 'Aucun chapitre ne correspond.'),
      h(
        'ul',
        { class: 'results' },
        results.map((r) => {
          const part = partOf(r.partId);
          return h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: 'result', style: { '--part': part.accent }, onclick: () => openResult(r) },
              h('span', { class: 'avatar small' }, part.initials || part.name.slice(0, 2)),
              h('span', { class: 'r-text' }, h('strong', null, r.title), h('small', null, `${r.partName} · ${C.isReady(chapterOf(part, r.chapterId)) ? r.snippet : 'Résumé à venir'}`)),
              icon(ICONS.next)
            )
          );
        })
      )
    );
  }

  function openResult(r) {
    $('search').value = '';
    state.query = '';
    go('part', { partId: r.partId, chapterId: r.chapterId });
  }

  function onSearchInput(e) {
    state.query = e.target.value;
    if (state.query.trim()) {
      if (state.view !== 'search') state.back = { view: state.view, partId: state.partId, chapterId: state.chapterId };
      state.view = 'search';
      render();
    } else if (state.view === 'search') {
      const b = state.back || { view: 'home' };
      go(b.view, { partId: b.partId, chapterId: b.chapterId, focus: false });
    }
  }

  // ------------------------------------------------------------------ thème

  function showTheme(mode) {
    for (const b of document.querySelectorAll('.theme [data-theme]')) b.setAttribute('aria-checked', String(b.dataset.theme === mode));
  }

  async function initTheme() {
    let mode = 'system';
    if (api) {
      try {
        mode = (await api.getTheme()).mode || 'system';
      } catch {
        // thème du système
      }
    }
    showTheme(mode);
    for (const b of document.querySelectorAll('.theme [data-theme]')) {
      b.addEventListener('click', async () => {
        showTheme(b.dataset.theme);
        if (api) await api.setTheme(b.dataset.theme);
      });
    }
  }

  // ------------------------------------------------------------------ clavier

  function onKey(e) {
    const typing = e.target instanceof HTMLInputElement;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f')) {
      e.preventDefault();
      $('search').focus();
      $('search').select();
      return;
    }
    if (e.key === 'Escape') {
      if (state.view === 'search' || typing) {
        $('search').value = '';
        onSearchInput({ target: $('search') });
        $('search').blur();
      } else if (state.view === 'part') go('home');
      return;
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (state.view === 'part' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const { prev, next } = C.neighbours(partOf(state.partId), state.chapterId);
      const target = e.key === 'ArrowLeft' ? prev : next;
      if (target) go('part', { chapterId: target.id, focus: false });
      e.preventDefault();
    } else if (state.view === 'home' && /^[1-9]$/.test(e.key) && parts[Number(e.key) - 1]) {
      go('part', { partId: parts[Number(e.key) - 1].id });
    }
  }

  // ------------------------------------------------------------------ démarrage

  function init() {
    try {
      if (!C || !DATA) {
        main.replaceChildren(h('p', { class: 'muted' }, 'Contenu des cours introuvable (lib/content.js). Réinstallez l\'application.'));
        return;
      }
      $('home-link').addEventListener('click', () => {
        $('search').value = '';
        state.query = '';
        go('home');
      });
      $('search').addEventListener('input', onSearchInput);
      document.addEventListener('keydown', onKey);
      initTheme();
      go('home', { focus: false });
    } finally {
      if (api) api.uiReady();
    }
  }

  init();
})();
