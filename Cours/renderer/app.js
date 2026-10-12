/*
 * app.js — Interface de Cours : les résumés PDF de la formation, rangés par partie.
 *
 * Interface « compacte » (construite sans innerHTML) :
 *   - barre de gauche : accueil + une pastille par partie (M.Julia, A.Julia, Microsoft Office…) ;
 *   - accueil : les nouveautés de la dernière mise à jour (lib/changelog.js), et rien d'autre ;
 *   - partie : liste de ses cours (un PDF = un cours ; statut, titre, pages, date) et le cours sélectionné : grand
 *     aperçu, « Visionner » (visionneuse PDF), « Télécharger », statut (lu / à réviser), onglets Informations,
 *     Sommaire (signets du PDF → visionneuse à la bonne page) et Mes notes ;
 *   - recherche : dans les titres, descriptions et auteurs de toutes les parties.
 * Aperçus, informations et sommaire : lus par pdf.js, gardés en cache (localStorage) tant que le fichier ne change
 * pas. Statuts et notes : localStorage (sur ce PC). Un cours ouvert sans statut passe « En cours ».
 * Clavier : Ctrl+K recherche · Échap retour · 1, 2… ouvrir une partie · ↑ ↓ changer de cours.
 */
'use strict';

(() => {
  const C = window.Course;
  const DATA = window.CoursContent;
  const api = window.cours || null;
  const pdfjs = window.pdfjsLib || null;
  const $ = (id) => document.getElementById(id);
  const main = $('main');
  const CACHE_KEY = 'cours.previews.v3'; // v3 : aperçu + informations du PDF + sommaire (signets)
  const PROGRESS_KEY = 'cours.progress.v1'; // statut de chaque cours : lu, en cours, à réviser
  const NOTES_KEY = 'cours.notes.v1'; // notes personnelles de chaque cours
  try {
    localStorage.removeItem('cours.previews.v1');
    localStorage.removeItem('cours.previews.v2');
  } catch {
    // stockage indisponible
  }

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
    next: ['M9 5l7 7-7 7'],
    eye: ['M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z', 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z'],
    download: ['M12 4v11', 'M7 10.5l5 5 5-5', 'M5 20h14'],
    file: ['M6 2.5h8l5 5V21a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 21z', 'M14 2.5V8h5'],
    folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M16 16l4.5 4.5'],
    home: ['M4 11l8-7 8 7', 'M6 9.5V20h4.5v-5.5h3V20H18V9.5'],
    check: ['M5 12.5l4.5 4.5L19 7'],
    flag: ['M6 21V4', 'M6 4.5h11l-2.5 4 2.5 4H6'],
    image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 8.5a1 1 0 1 0 0 .01'],
    layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
    play: ['M8 5.5v13l11-6.5z'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
  };

  /** Icônes de cours (content.js : icon) : tracés 24 × 24, dessinés en blanc sur la couleur de la partie. */
  const COURSE_ICONS = {
    // Alimentation : batterie et éclair
    alimentation: ['M3.5 7.5h15a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 2 15V9a1.5 1.5 0 0 1 1.5-1.5z', 'M22 10.5v3', 'M12 9l-2.5 3.5h3L10 16'],
    cpu: ['M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z', 'M10.5 10.5h3v3h-3z', 'M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4'],
    'carte-mere': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M7 7h5v5H7z', 'M15 7h3M15 10h3M7 15.5h11M7 18h6'],
    chipset: ['M12 3.5l8.5 8.5-8.5 8.5L3.5 12z', 'M10 10h4v4h-4z'],
    bios: ['M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M6.5 10h5M6.5 14h7', 'M17 10.5v3', 'M8 18v2.5M12 18v2.5M16 18v2.5'],
    // Disque dur : boîtier, plateau, axe et bras de lecture
    disque: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M11 6.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', 'M11 10.7a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z', 'M18 6.5v6.5l-3.5 3', 'M6 19h.01M18 19h.01'],
    codage: ['M8 8l-4 4 4 4', 'M16 8l4 4-4 4', 'M13.5 5.5l-3 13'],
    document: ['M6 2.5h8l5 5V21a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 21z', 'M14 2.5V8h5', 'M9 13h7M9 17h5'],
  };
  /** Vignette d'un cours (icône sur la couleur de sa partie), ou null s'il n'a pas d'icône. */
  function courseArt(d, cls) {
    if (!d.icon || !COURSE_ICONS[d.icon]) return null;
    const svg = icon(COURSE_ICONS[d.icon]);
    svg.classList.add('art-icon');
    return h('span', { class: `course-art ${cls}`, 'aria-hidden': 'true' }, svg);
  }

  /** Logos de partie (content.js : logo) : formes simples dessinées ici, aucune image externe. */
  const LOGOS = {
    // Microsoft : quatre carrés
    microsoft: [
      [1, 1, '#f25022'],
      [12, 1, '#7fba00'],
      [1, 12, '#00a4ef'],
      [12, 12, '#ffb900'],
    ],
  };
  function logoSvg(name) {
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 23 23');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'logo');
    for (const [x, y, color] of LOGOS[name]) {
      const r = document.createElementNS(ns, 'rect');
      for (const [k, v] of Object.entries({ x, y, width: 10, height: 10, fill: color, stroke: 'none' })) r.setAttribute(k, v);
      svg.append(r);
    }
    return svg;
  }

  /** Pastille d'une partie : son logo s'il en a un, sinon ses initiales sur sa couleur. */
  function partBadge(p, cls = '') {
    if (p.logo && LOGOS[p.logo]) return h('span', { class: `avatar has-logo ${cls}`.trim() }, logoSvg(p.logo));
    return h('span', { class: `avatar ${cls}`.trim() }, p.initials || p.name.slice(0, 2));
  }

  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const dateFr = (ms) => (ms ? new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  // ------------------------------------------------------------------ état

  const parts = DATA && Array.isArray(DATA.parts) ? DATA.parts : [];
  const state = {
    view: 'home', // home | part | search
    partId: null,
    query: '',
    back: null,
    docs: {}, // partId → documents affichés (course.mergeDocuments)
    selected: {}, // partId → fichier du cours affiché à droite de la liste
    tab: null, // onglet choisi (files | info | toc | notes) ; aucun : le premier du cours (Fichiers ou Informations)
    loaded: false,
  };

  const partOf = (id) => parts.find((p) => p.id === id) || null;
  const docsOf = (partId) => state.docs[partId] || [];
  const docKey = (d) => `${d.partId}/${d.file}|${d.size}|${d.mtime}`;
  // Même cours = même partie + même fichier (les objets sont recréés quand le dossier des PDF change)
  const sameDoc = (a, b) => Boolean(a && b && a.partId === b.partId && a.file === b.file);

  // ------------------------------------------------------------------ aperçus (pdf.js) et cache

  const cache = (() => {
    let map = {};
    try {
      map = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch {
      map = {};
    }
    let timer = null;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(map));
        } catch {
          // stockage plein : les aperçus seront simplement redessinés
        }
      }, 300);
    };
    return {
      get: (k) => map[k] || null,
      set(k, v) {
        map[k] = v;
        save();
      },
      /** Ne garde que les aperçus des fichiers encore présents (et à jour). */
      keepOnly(keys) {
        const next = {};
        for (const k of keys) if (map[k]) next[k] = map[k];
        map = next;
        save();
      },
    };
  })();

  if (pdfjs) pdfjs.GlobalWorkerOptions.workerSrc = ''; // traitement dans la page (pdf.worker.min.js chargé juste avant)

  /** Première page en image (JPEG ~ 300 px de large), nombre de pages, sujet du PDF. */
  async function renderPreview(d) {
    const res = await api.readDocument(d.partId, d.file);
    if (!res || !res.ok) throw new Error((res && res.error) || 'lecture impossible');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(res.data), isEvalSupported: false, useSystemFonts: true }).promise;
    try {
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 300 / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      let info = {};
      try {
        const meta = await pdf.getMetadata();
        info = (meta && meta.info) || {};
      } catch {
        // pas de métadonnées
      }
      const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
      // Sommaire : signets du PDF (deux niveaux) avec leur numéro de page
      let outline = [];
      try {
        const pageOf = async (dest) => {
          try {
            const d2 = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
            return Array.isArray(d2) && d2[0] ? (await pdf.getPageIndex(d2[0])) + 1 : null;
          } catch {
            return null;
          }
        };
        const walk = async (items, depth) => {
          const out = [];
          for (const o of (items || []).slice(0, 40)) {
            out.push({ title: text(o.title), page: await pageOf(o.dest), items: depth ? [] : await walk(o.items, depth + 1) });
          }
          return out;
        };
        outline = C.sections(await walk(await pdf.getOutline(), 0));
      } catch {
        outline = [];
      }
      return {
        outline,
        thumb: canvas.toDataURL('image/jpeg', 0.82),
        pages: pdf.numPages,
        subject: text(info.Subject),
        ratio: canvas.height / canvas.width,
        // Panneau « Informations »
        author: text(info.Author),
        software: text(info.Creator) && text(info.Producer) && text(info.Creator) !== text(info.Producer) ? `${text(info.Creator)} · ${text(info.Producer)}` : text(info.Creator) || text(info.Producer),
        created: C.pdfDate(info.CreationDate),
        modified: C.pdfDate(info.ModDate),
        version: text(info.PDFFormatVersion),
        language: text(info.Language),
      };
    } finally {
      pdf.destroy();
    }
  }

  // File d'attente : un PDF à la fois, seulement ceux qui sont à l'écran
  const queue = [];
  let working = false;
  const waiting = new Map(); // clé → éléments d'aperçu à remplir
  const unreadable = new Set(); // PDF que pdf.js n'a pas pu lire (pas de nouvel essai tant que le fichier ne change pas)

  function requestPreview(d, holder) {
    const k = docKey(d);
    const hit = cache.get(k);
    if (hit) return fillPreview(holder, d, hit);
    if (!pdfjs || !api || unreadable.has(k)) return holder.classList.add('failed');
    if (!waiting.has(k)) {
      waiting.set(k, []);
      queue.push(d);
    }
    waiting.get(k).push(holder);
    pump();
  }

  async function pump() {
    if (working) return;
    working = true;
    while (queue.length) {
      const d = queue.shift();
      const k = docKey(d);
      let result = null;
      try {
        result = await renderPreview(d);
        cache.set(k, result);
      } catch (err) {
        console.warn('[cours] aperçu impossible :', d.file, err && err.message);
        unreadable.add(k);
      }
      for (const holder of waiting.get(k) || []) {
        if (result) fillPreview(holder, d, result);
        else holder.classList.add('failed');
      }
      // Une fois par PDF lu (réussi ou illisible : « illisible » au lieu de « … ») ; jamais pour un aperçu déjà en
      // cache, sinon un onglet qui contient des aperçus (Fichiers) se redessinerait sans fin
      onPreviewReady(d);
      waiting.delete(k);
    }
    working = false;
  }

  /** Aperçu prêt : image, nombre de pages, description tirée du PDF si content.js n'en donne pas. */
  function fillPreview(holder, d, p) {
    holder.replaceChildren(h('img', { src: p.thumb, alt: '', draggable: 'false' }));
    holder.classList.add('ready');
    const row = holder.closest('[data-doc]');
    if (!row) return;
    const pages = row.querySelector('.d-pages');
    if (pages && p.pages) pages.textContent = plural(p.pages, 'page', 'pages');
    const desc = row.querySelector('.d-desc');
    // Sujet du PDF en guise de description, seulement si le cours n'en a pas (cours en dossier : jamais celui du condensé)
    if (desc && !d.description && !row.hasAttribute('data-has-desc') && p.subject) {
      desc.textContent = p.subject;
      desc.classList.remove('none');
    }
  }

  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer.unobserve(e.target);
            const d = e.target._doc;
            if (d) requestPreview(d, e.target);
          }
        },
        { root: main, rootMargin: '300px' }
      )
    : null;

  function previewBox(d) {
    const box = h('span', { class: 'thumb' }, icon(ICONS.file));
    const cached = cache.get(docKey(d));
    if (cached) {
      // Rempli après l'insertion dans la page (la ligne parente doit exister)
      requestAnimationFrame(() => fillPreview(box, d, cached));
    } else if (observer) {
      box._doc = d;
      requestAnimationFrame(() => observer.observe(box));
    } else requestAnimationFrame(() => requestPreview(d, box));
    return box;
  }

  // ------------------------------------------------------------------ actions

  /**
   * Visionneuse : un fichier du cours (target), sinon le PDF qui le représente (condensé ou premier PDF), à une
   * page précise depuis le sommaire. Un cours ouvert sans statut passe « En cours ».
   */
  /** Fichier principal d'un cours : son condensé ou son premier PDF, sinon son premier fichier (Word, vidéo…). */
  const mainFile = (d) => C.coverOf(d) || (d && d.kind === 'folder' ? d.files[0] || null : null);

  async function openDoc(course, { target, page } = {}) {
    if (!api) return;
    const t = target || mainFile(course);
    if (!t) return toast('Ce cours n\'a pas encore de fichier.');
    const res = await api.openDocument(course.partId, t.file, t.title, page || 0);
    if (!res || !res.ok) return toast((res && res.error) || 'Ouverture impossible.');
    if (res.external) toast(`« ${t.title} » s'ouvre avec ${APP_NAMES[C.officeApp(t.name)] || 'le programme de l\'ordinateur'}.`);
    if (!statusOf(course)) setStatus(course, 'encours');
  }

  async function saveDoc(course, target) {
    if (!api) return;
    const t = target || mainFile(course);
    if (!t) return;
    const res = await api.saveDocument(course.partId, t.file);
    if (res && res.ok) toast({ image: 'Photo enregistrée.', video: 'Vidéo enregistrée.', office: 'Document enregistré.' }[t.kind] || 'PDF enregistré.');
    else if (!(res && res.canceled)) toast((res && res.error) || 'Enregistrement impossible.');
  }

  const APP_NAMES = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint' };
  /** Type affiché d'un fichier : « PDF », « Photo », « Vidéo », « Document Word »… */
  function kindLabel(f) {
    if (f.kind === 'office') return { word: 'Document Word', excel: 'Classeur Excel', powerpoint: 'Présentation PowerPoint' }[C.officeApp(f.name)] || 'Document';
    return { pdf: 'PDF', image: 'Photo', video: 'Vidéo' }[f.kind] || 'Fichier';
  }

  /** Vignette d'une vidéo ou d'un document Office (pas d'aperçu : icône sur fond de couleur). */
  function fileTile(f) {
    if (f.kind === 'video') return h('span', { class: 'thumb tile video' }, icon(ICONS.play), h('span', { class: 'tile-label' }, 'Vidéo'));
    const appName = C.officeApp(f.name);
    const letter = { word: 'W', excel: 'X', powerpoint: 'P' }[appName] || 'D';
    return h('span', { class: `thumb tile office ${appName || 'doc'}` }, h('span', { class: 'tile-letter' }, letter), h('span', { class: 'tile-label' }, APP_NAMES[appName] || 'Document'));
  }

  /** Miniature d'une photo (lue par le processus principal, affichée en blob:), gardée le temps de la session. */
  const imageUrls = new Map();
  function imageBox(f) {
    const box = h('span', { class: 'thumb photo' }, icon(ICONS.image));
    const key = `${f.partId}/${f.file}|${f.size}|${f.mtime}`;
    const show = (url) => {
      box.replaceChildren(h('img', { src: url, alt: '', draggable: 'false' }));
      box.classList.add('ready');
    };
    if (imageUrls.has(key)) show(imageUrls.get(key));
    else if (api) {
      api
        .readDocument(f.partId, f.file)
        .then((res) => {
          if (!res || !res.ok) throw new Error((res && res.error) || 'lecture impossible');
          const url = URL.createObjectURL(new Blob([res.data]));
          imageUrls.set(key, url);
          show(url);
        })
        .catch(() => box.classList.add('failed'));
    }
    return box;
  }

  // ------------------------------------------------------------------ navigation

  function go(view, { partId = state.partId, focus = true } = {}) {
    const from = state.view === 'part' ? state.partId : null;
    state.view = view;
    if (view === 'part') {
      const part = partOf(partId);
      if (!part) return go('home');
      state.partId = part.id;
      // Animation : d'une partie à l'autre, le contenu arrive du côté de la partie choisie (ordre du menu)
      const step = from && from !== part.id ? Math.sign(parts.indexOf(part) - parts.findIndex((p) => p.id === from)) : 0;
      document.body.dataset.anim = step ? 'switch' : 'enter';
      document.body.style.setProperty('--dir', String(step || 1));
    } else document.body.dataset.anim = 'enter';
    render();
    if (focus) main.focus({ preventScroll: true });
    main.scrollTop = 0;
  }

  function goHome() {
    $('search').value = '';
    state.query = '';
    go('home');
  }

  function render() {
    renderCrumbs();
    renderRail();
    document.body.dataset.view = state.view;
    const part = partOf(state.partId);
    document.body.style.setProperty('--part', state.view === 'part' && part ? part.accent : 'var(--accent)');
    if (state.view === 'search') main.replaceChildren(viewSearch());
    else if (state.view === 'part') main.replaceChildren(viewPart(part));
    else main.replaceChildren(viewHome());
  }

  function renderCrumbs() {
    const crumbs = $('crumbs');
    if (state.view === 'home') return crumbs.replaceChildren();
    const items = [h('button', { type: 'button', class: 'crumb', onclick: () => goHome() }, 'Accueil')];
    const part = partOf(state.partId);
    if (state.view === 'part' && part) items.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('span', { class: 'crumb current', style: { '--c': part.accent } }, part.name));
    else if (state.view === 'search') items.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), h('span', { class: 'crumb current' }, 'Recherche'));
    crumbs.replaceChildren(...items);
  }

  // ------------------------------------------------------------------ accueil : les nouveautés, et rien d'autre

  /**
   * Nouveautés de la dernière mise à jour (lib/changelog.js) en pleine page ; les versions précédentes en dessous,
   * repliées. Les parties s'ouvrent depuis la barre de gauche.
   */
  function viewHome() {
    const log = Array.isArray(window.CoursChangelog) ? window.CoursChangelog : [];
    const dayFr = (iso) => dateFr(new Date(`${iso}T12:00:00`).getTime());
    const list = (e) => h('ul', { class: 'cl-list' }, e.changes.map((c, i) => h('li', { style: { '--i': Math.min(i, 12) } }, h('span', { class: 'cl-check' }, icon(ICONS.check)), h('span', null, c))));
    if (!log.length) return h('section', { class: 'home' }, h('p', { class: 'muted pad' }, 'Choisis une partie dans la barre de gauche.'));
    const [last, ...older] = log;
    return h(
      'section',
      { class: 'home' },
      h(
        'header',
        { class: 'cl-head' },
        h('span', { class: 'cl-icon' }, icon(ICONS.sparkle)),
        h('div', null, h('p', { class: 'eyebrow' }, 'Nouveautés'), h('h1', null, last.title), h('p', { class: 'lead' }, `Version ${last.version} · ${dayFr(last.date)}`))
      ),
      h('article', { class: 'changelog' }, list(last)),
      older.length
        ? h(
            'details',
            { class: 'cl-older' },
            h('summary', null, plural(older.length, 'version précédente', 'versions précédentes')),
            older.map((e) => h('div', { class: 'cl-old' }, h('h2', null, `${e.title} `, h('small', null, `v${e.version} · ${dayFr(e.date)}`)), list(e)))
          )
        : null
    );
  }
  // ------------------------------------------------------------------ résultat de recherche

  /** Un résumé : aperçu (cliquable) + partie, titre, description, informations, boutons. */
  function docRow(d, { showPart = false } = {}) {
    const part = partOf(d.partId);
    const folder = d.kind === 'folder';
    const cover = C.coverOf(d);
    const art = courseArt(d, 'mid');
    const thumb = h(
      'button',
      { type: 'button', class: `thumb-btn${art ? ' art' : ''}`, title: `Visionner « ${d.title} »`, disabled: !cover, onclick: () => openDoc(d) },
      art || (cover ? previewBox(cover) : h('span', { class: 'thumb failed' }, icon(ICONS.file))),
      cover ? h('span', { class: 'thumb-hover' }, icon(ICONS.eye), 'Visionner') : null
    );
    return h(
      'article',
      { class: 'doc', 'data-doc': '', 'data-has-desc': folder ? '' : null, 'data-filter': C.fold(`${d.title} ${d.description} ${d.file}`), style: { '--part': part ? part.accent : 'var(--accent)' } },
      thumb,
      h(
        'div',
        { class: 'd-body' },
        showPart && part
          ? h('button', { type: 'button', class: 'd-part', title: `Afficher dans ${part.name}`, onclick: () => showCourse(d) }, part.name)
          : null,
        h('h3', { class: 'd-title' }, d.title),
        h('p', { class: `d-desc${d.description ? '' : ' none'}` }, d.description || 'Pas de description.'),
        h(
          'p',
          { class: 'd-meta' },
          folder ? h('span', null, d.empty ? 'À venir' : `${plural(d.files.length, 'fichier', 'fichiers')}${d.condense ? ' + condensé' : ''}`) : h('span', { class: 'd-pages' }, '— pages'),
          d.empty ? null : h('span', null, C.formatSize(d.size)),
          d.date ? h('span', null, `Cours du ${dateFr(d.date)}`) : d.mtime ? h('span', null, `Ajouté le ${dateFr(d.mtime)}`) : null
        ),
        h(
          'div',
          { class: 'd-actions' },
          folder
            ? h('button', { type: 'button', class: 'btn primary', onclick: () => showCourse(d) }, icon(ICONS.next), 'Ouvrir le cours')
            : h('button', { type: 'button', class: 'btn primary', onclick: () => openDoc(d) }, icon(ICONS.eye), 'Visionner'),
          cover ? h('button', { type: 'button', class: 'btn', onclick: () => saveDoc(d) }, icon(ICONS.download), folder && d.condense ? 'Télécharger le condensé' : 'Télécharger') : null
        )
      )
    );
  }

  // ------------------------------------------------------------------ statuts et notes (gardés sur ce PC)

  function store(key) {
    let map = {};
    try {
      map = JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      map = {};
    }
    return {
      get: (k) => map[k],
      set(k, v) {
        if (v === undefined || v === null || v === '') delete map[k];
        else map[k] = v;
        try {
          localStorage.setItem(key, JSON.stringify(map));
        } catch {
          // stockage plein ou indisponible
        }
      },
    };
  }
  const progress = store(PROGRESS_KEY);
  const notes = store(NOTES_KEY);
  const courseId = (d) => `${d.partId}/${d.file}`; // sans taille ni date : le statut survit à une mise à jour du PDF

  const STATUS = { lu: 'Lu', encours: 'En cours', reviser: 'À réviser' };
  function statusOf(d) {
    const s = progress.get(courseId(d));
    return s && STATUS[s.s] ? s.s : '';
  }
  function setStatus(d, s) {
    progress.set(courseId(d), s ? { s, at: Date.now() } : null);
    for (const dot of document.querySelectorAll(`.cp-row[data-file="${CSS.escape(d.file)}"] .cp-dot`)) dot.dataset.status = s || '';
    if (sameDoc(shownDoc(), d)) renderDetail(shownDoc(), { animate: false });
  }

  // ------------------------------------------------------------------ partie : liste des cours + cours sélectionné

  const shortDate = (ms) => (ms ? new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');

  /** Cours affiché d'une partie : celui choisi dans la liste, sinon le premier. */
  function currentDoc(partId) {
    const docs = docsOf(partId);
    return docs.find((d) => d.file === state.selected[partId]) || docs[0] || null;
  }
  const shownDoc = () => (state.view === 'part' ? currentDoc(state.partId) : null);

  /** Ouvre la partie d'un résumé avec ce cours sélectionné (accueil, recherche). */
  function showCourse(d) {
    state.selected[d.partId] = d.file;
    if (state.view === 'search') {
      $('search').value = '';
      state.query = '';
    }
    go('part', { partId: d.partId });
  }

  /** Sélection dans la liste : seul le cours affiché est remplacé (la liste garde son défilement). */
  function selectCourse(d, { focus = false } = {}) {
    state.selected[d.partId] = d.file;
    for (const row of document.querySelectorAll('.cp-row')) {
      const on = row.dataset.file === d.file;
      row.classList.toggle('current', on);
      if (on) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      if (on && focus) {
        row.focus();
        row.scrollIntoView({ block: 'nearest' });
      }
    }
    renderDetail(d);
  }

  /** Infos du cours dans la liste : pages (PDF seul) ou nombre de fichiers (dossier), et date. */
  function rowMeta(d) {
    if (d.kind === 'folder' && d.empty) return ['À venir', shortDate(d.date)].filter(Boolean).join(' · ');
    // Date du cours (content.js) seulement : celle des fichiers n'est que leur date de copie
    if (d.kind === 'folder') return [`${plural(d.files.length, 'fichier', 'fichiers')}${d.condense ? ' + condensé' : ''}`, shortDate(d.date)].filter(Boolean).join(' · ');
    const p = cache.get(docKey(d));
    return [p && p.pages ? `${p.pages} p.` : C.formatSize(d.size), shortDate(d.mtime)].filter(Boolean).join(' · ');
  }

  /** Le fichier f fait-il partie du cours d (lui-même, ou un fichier de son dossier) ? */
  const inCourse = (d, f) => Boolean(d && f) && (sameDoc(d, f) || (d.kind === 'folder' && d.partId === f.partId && f.file.startsWith(`${d.file}/`)));

  /** Aperçu prêt : met à jour la liste et le cours affiché (sans rejouer leurs animations). */
  function onPreviewReady(d) {
    for (const el of document.querySelectorAll(`.cp-row[data-key="${CSS.escape(docKey(d))}"] .cp-meta`)) el.textContent = rowMeta(d);
    // L'onglet « Mes notes » n'est pas redessiné : la saisie en cours garde le focus
    const shown = shownDoc();
    if (inCourse(shown, d) && state.tab !== 'notes') renderTab(shown);
  }

  /** Colonne de gauche : nom de la partie, filtre, cours (statut, titre, pages, date), légende. */
  function courseList(part, docs, current) {
    const rows = docs.map((d, i) =>
      h(
        'button',
        {
          type: 'button',
          class: `cp-row${d === current ? ' current' : ''}`,
          'aria-current': d === current ? 'true' : null,
          'data-file': d.file,
          'data-key': docKey(d),
          'data-filter': C.fold(`${d.title} ${d.description} ${d.author} ${d.file}`),
          style: { '--i': Math.min(i, 12) },
          title: d.title,
          onclick: () => selectCourse(d),
        },
        h('span', { class: 'cp-dot', 'data-status': statusOf(d), 'aria-hidden': 'true' }),
        h('span', { class: 'cp-text' }, courseArt(d, 'small'), h('span', { class: 'cp-label' }, h('strong', null, d.title), h('small', { class: 'cp-meta' }, rowMeta(d)))),
        h('span', { class: 'cp-size' }, d.empty ? '' : C.formatSize(d.size))
      )
    );
    const none = h('p', { class: 'cp-none', hidden: true }, 'Aucun cours ne correspond.');
    let filter = null;
    if (docs.length > 3) {
      const input = h('input', { type: 'search', class: 'doc-filter', placeholder: 'Filtrer les cours…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Filtrer les cours' });
      input.addEventListener('input', () => {
        const q = C.fold(input.value);
        let shown = 0;
        for (const row of rows) {
          row.hidden = Boolean(q) && !row.dataset.filter.includes(q);
          if (!row.hidden) shown += 1;
        }
        none.hidden = shown > 0;
      });
      filter = h('label', { class: 'cp-filter' }, icon(ICONS.search), input);
    }
    return h(
      'aside',
      { class: 'cp-list', 'aria-label': `Cours de ${part.name}` },
      h(
        'header',
        { class: 'cp-head' },
        h('div', { class: 'cp-title' }, partBadge(part, 'small'), h('h1', null, part.name), h('span', null, plural(docs.length, 'cours', 'cours'))),
        h('p', null, part.description),
        filter
      ),
      h('div', { class: 'cp-rows', role: 'list' }, rows, none),
      h(
        'footer',
        { class: 'cp-legend' },
        Object.entries(STATUS).map(([s, label]) => h('span', null, h('span', { class: 'cp-dot', 'data-status': s }), label))
      )
    );
  }

  // Cours affiché : grand aperçu, statut, actions, onglets (Informations, Sommaire, Mes notes)

  /** Onglets d'un cours : un cours en dossier a « Fichiers » (en premier) et, s'il en a un, « Condensé ». */
  function tabsOf(d) {
    if (d.kind !== 'folder') return [['info', 'Informations'], ['toc', 'Sommaire'], ['notes', 'Mes notes']];
    return [['files', `Fichiers (${d.files.length})`], ...(d.condense ? [['condense', 'Condensé']] : []), ['info', 'Informations'], ['notes', 'Mes notes']];
  }
  /** Onglet affiché : celui choisi s'il existe pour ce cours, sinon le premier. */
  const tabFor = (d) => (tabsOf(d).some(([id]) => id === state.tab) ? state.tab : tabsOf(d)[0][0]);

  function renderDetail(d, { animate = true } = {}) {
    const box = document.querySelector('.cp-detail');
    if (!box) return;
    box.classList.toggle('still', !animate);
    box.replaceChildren(courseDetail(d));
  }

  function courseDetail(d) {
    const part = partOf(d.partId);
    const status = statusOf(d);
    const folder = d.kind === 'folder';
    const cover = C.coverOf(d);
    const current = tabFor(d);
    const art = courseArt(d, 'large');
    const main = mainFile(d); // condensé, premier PDF, sinon premier fichier (Word, vidéo…)
    const thumb = h(
      'button',
      { type: 'button', class: `thumb-btn${art ? ' art' : ''}`, disabled: !main, title: !main ? null : folder && d.condense ? `Ouvrir le condensé « ${d.condense.title} »` : `Ouvrir « ${main.title} »`, onclick: () => openDoc(d) },
      // Cours avec une icône : la vignette du cours ; sinon l'aperçu de son PDF
      art || (cover ? previewBox(cover) : h('span', { class: 'thumb failed' }, icon(ICONS.file))),
      main ? h('span', { class: 'thumb-hover' }, icon(folder && d.condense ? ICONS.layers : ICONS.eye), folder && d.condense ? 'Condensé' : cover ? 'Visionner' : 'Ouvrir') : null,
      folder && d.condense ? h('span', { class: 'thumb-tag' }, 'Condensé') : d.empty ? h('span', { class: 'thumb-tag soon' }, 'À venir') : null
    );
    const toggle = (s, label, onLabel, ic) =>
      h(
        'button',
        { type: 'button', class: `btn ghost toggle${status === s ? ' on' : ''}`, 'data-s': s, 'aria-pressed': String(status === s), onclick: () => setStatus(d, status === s ? '' : s) },
        icon(ic),
        status === s ? onLabel : label
      );
    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist' },
      tabsOf(d).map(([id, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `tab${current === id ? ' on' : ''}`,
            'aria-selected': String(current === id),
            onclick: () => {
              state.tab = id;
              for (const t of tabs.children) {
                const on = t.dataset.tab === id;
                t.classList.toggle('on', on);
                t.setAttribute('aria-selected', String(on));
              }
              renderTab(d);
            },
            'data-tab': id,
          },
          label,
          id === 'notes' && notes.get(courseId(d)) ? h('span', { class: 'tab-dot', 'aria-label': '(notes)' }) : null
        )
      )
    );
    // Cours en dossier : « Condensé » (le PDF qui rassemble tout le cours) ; sans condensé, son premier PDF
    const primary = folder && d.condense
      ? h('button', { type: 'button', class: 'btn primary', onclick: () => openDoc(d), title: `Ouvrir « ${d.condense.title} »` }, icon(ICONS.layers), 'Condensé')
      : cover || !main
        ? h('button', { type: 'button', class: 'btn primary', disabled: !cover, onclick: () => openDoc(d) }, icon(ICONS.eye), 'Visionner')
        // Pas de PDF (ex. un document Word seul) : on ouvre le premier fichier
        : h('button', { type: 'button', class: 'btn primary', onclick: () => openDoc(d), title: `Ouvrir « ${main.title} »` }, icon(main.kind === 'office' ? ICONS.external : ICONS.eye), main.kind === 'office' ? `Ouvrir dans ${APP_NAMES[C.officeApp(main.name)] || 'le programme'}` : 'Ouvrir');
    const download = main
      ? h('button', { type: 'button', class: 'btn', onclick: () => saveDoc(d) }, icon(ICONS.download), folder && d.condense ? 'Télécharger le condensé' : 'Télécharger')
      : null;
    return h(
      'article',
      { class: 'cp-hero', 'data-doc': '', 'data-has-desc': folder ? '' : null, style: { '--part': part ? part.accent : 'var(--accent)' } },
      thumb,
      h(
        'div',
        { class: 'cp-body' },
        h(
          'div',
          { class: 'cp-chips' },
          part ? h('span', { class: 'chip' }, part.name) : null,
          d.date ? h('span', { class: 'chip date' }, `Cours du ${dateFr(d.date)}`) : null,
          status ? h('span', { class: `chip st-${status}` }, STATUS[status]) : null
        ),
        h('h2', { class: 'cp-name' }, d.title),
        h('p', { class: `d-desc${d.description ? '' : ' none'}` }, d.description || 'Pas de description.'),
        folder && d.condense
          ? h('p', { class: 'cp-condense' }, icon(ICONS.layers), h('span', null, 'Condensé : ', h('strong', null, d.condense.title), d.condense.author ? ` — par ${d.condense.author}` : ''))
          : null,
        // Cours annoncé, sans fichier : pas d'actions sur des fichiers, un simple avis
        d.empty
          ? h('p', { class: 'cp-soon' }, icon(ICONS.file), 'Les fichiers de ce cours arrivent bientôt.')
          : h('div', { class: 'd-actions' }, primary, download, toggle('lu', 'Marquer comme lu', 'Lu', ICONS.check), toggle('reviser', 'À réviser', 'À réviser', ICONS.flag)),
        tabs,
        h('div', { class: 'tab-body', 'data-key': docKey(d) }, tabContent(d))
      )
    );
  }

  /** Contenu de l'onglet ouvert, remplacé seul (aperçu lu, changement d'onglet). */
  function renderTab(d) {
    const body = document.querySelector(`.cp-detail .tab-body[data-key="${CSS.escape(docKey(d))}"]`);
    if (body) body.replaceChildren(tabContent(d));
  }

  function tabContent(d) {
    const tab = tabFor(d);
    if (tab === 'files') return filesTab(d);
    if (tab === 'condense') return condenseTab(d);
    if (tab === 'toc') return tocTab(d);
    if (tab === 'notes') return notesTab(d);
    return infoTab(d);
  }

  /**
   * Condensé d'un cours en dossier (le PDF qui rassemble tout le cours) : aperçu, titre, auteur, pages, taille,
   * Ouvrir / Télécharger, puis son sommaire (signets) s'il en a un.
   */
  function condenseTab(d) {
    const c = d.condense;
    const p = cache.get(docKey(c)) || {};
    const pages = p.pages ? plural(p.pages, 'page', 'pages') : unreadable.has(docKey(c)) ? 'PDF illisible' : '…';
    return h(
      'div',
      { class: 'condense-tab' },
      h(
        'div',
        { class: 'condense-card' },
        h('button', { type: 'button', class: 'thumb-btn', title: `Ouvrir « ${c.title} »`, onclick: () => openDoc(d, { target: c }) }, previewBox(c), h('span', { class: 'thumb-hover' }, icon(ICONS.eye), 'Ouvrir')),
        h(
          'div',
          { class: 'cc-body' },
          h('span', { class: 'cc-kicker' }, icon(ICONS.layers), 'Condensé du cours'),
          h('h3', null, c.title),
          c.author ? h('p', { class: 'cc-author' }, `par ${c.author}`) : null,
          h('p', { class: 'cc-meta' }, [pages, C.formatSize(c.size)].join(' · ')),
          h('p', { class: 'cc-file', title: c.name }, c.name),
          h(
            'div',
            { class: 'd-actions' },
            h('button', { type: 'button', class: 'btn primary', onclick: () => openDoc(d, { target: c }) }, icon(ICONS.eye), 'Ouvrir le condensé'),
            h('button', { type: 'button', class: 'btn', onclick: () => saveDoc(d, c) }, icon(ICONS.download), 'Télécharger')
          )
        )
      ),
      h('h4', { class: 'cc-toc-title' }, 'Sommaire'),
      tocTab(d)
    );
  }

  /** Fichiers d'un cours en dossier : ses PDF et ses photos (le condensé a son onglet). Clic : visionneuse ; bouton : téléchargement. */
  function filesTab(d) {
    const card = (f) => {
      const p = f.kind === 'pdf' ? cache.get(docKey(f)) : null;
      const what = p && p.pages ? `PDF · ${plural(p.pages, 'page', 'pages')}` : kindLabel(f);
      return h(
        'div',
        { class: `file-card${f.condense ? ' condense' : ''}` },
        h(
          'button',
          { type: 'button', class: 'fc-open', title: `Ouvrir « ${f.title} »`, onclick: () => openDoc(d, { target: f }) },
          f.kind === 'image' ? imageBox(f) : f.kind === 'pdf' ? previewBox(f) : fileTile(f),
          f.condense ? h('span', { class: 'thumb-tag' }, 'Condensé') : null,
          h('span', { class: 'fc-text' }, h('strong', null, f.title), h('small', null, [what, C.formatSize(f.size)].join(' · ')), f.condense && f.author ? h('small', null, `par ${f.author}`) : null)
        ),
        h('button', { type: 'button', class: 'fc-save', title: `Télécharger « ${f.name} »`, 'aria-label': `Télécharger ${f.title}`, onclick: () => saveDoc(d, f) }, icon(ICONS.download))
      );
    };
    if (d.empty) return h('p', { class: 'tab-empty' }, 'Aucun fichier pour l\'instant : les PDF et les photos de ce cours arriveront bientôt.');
    if (!d.files.length) return h('p', { class: 'tab-empty' }, 'Ce cours n\'a pas d\'autre fichier que son condensé.');
    return h('div', { class: 'files-grid' }, d.files.map(card));
  }

  const LANGUAGES = (() => {
    try {
      return new Intl.DisplayNames(['fr'], { type: 'language' });
    } catch {
      return null;
    }
  })();
  const languageName = (code) => {
    if (!code) return '';
    try {
      const name = LANGUAGES ? LANGUAGES.of(code) : code;
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      return code;
    }
  };

  /** Lignes « libellé : valeur » des informations (valeurs vides retirées). */
  function infoList(rows) {
    return h(
      'dl',
      { class: 'info-grid' },
      rows
        .filter(([, value]) => value)
        .map(([label, value, opt = {}]) =>
          h(
            'div',
            { class: `ci-row${opt.file ? ' file' : ''}` },
            h('dt', null, label),
            h('dd', { class: opt.faint ? 'faint' : opt.warn ? 'warn' : null, title: opt.file ? value : null }, value, opt.sub ? h('small', null, opt.sub) : null)
          )
        )
    );
  }

  /** Informations : auteur (content.js, sinon le PDF), taille, pages, format, langue, dates, logiciel, fichier. */
  function infoTab(d) {
    if (d.kind === 'folder') {
      // Cours en dossier : contenu, condensé (auteur, pages), taille totale, date du cours, dossier
      const count = (k) => d.files.filter((f) => f.kind === k).length;
      const content = [
        count('pdf') ? plural(count('pdf'), 'PDF', 'PDF') : '',
        count('office') ? plural(count('office'), 'document', 'documents') : '',
        count('image') ? plural(count('image'), 'photo', 'photos') : '',
        count('video') ? plural(count('video'), 'vidéo', 'vidéos') : '',
        d.condense ? 'un condensé' : '',
      ].filter(Boolean);
      const c = d.condense ? cache.get(docKey(d.condense)) || {} : null;
      return infoList([
        ['Contenu', d.empty ? 'Aucun fichier pour l\'instant' : content.join(', '), { faint: d.empty }],
        ['Condensé', d.condense ? d.condense.title : d.empty ? '' : 'Pas encore', { faint: !d.condense }],
        ['Par', d.condense ? d.condense.author : ''],
        ['Pages', c && c.pages ? `${c.pages} (condensé)` : ''],
        ['Date du cours', d.date ? dateFr(d.date) : ''],
        ['Taille', d.empty ? '' : C.formatSize(d.size), { sub: `${Number(d.size).toLocaleString('fr-FR')} octets` }],
        ['Ajouté le', dateFr(d.mtime)],
        ['Dossier', d.file, { file: true }],
      ]);
    }
    const p = cache.get(docKey(d)) || {};
    const author = d.author || p.author || '';
    const rows = [
      ['Auteur', author || 'Non renseigné', { faint: !author }],
      ['État', unreadable.has(docKey(d)) ? 'PDF illisible (fichier abîmé ou protégé)' : '', { warn: true }],
      ['Pages', p.pages ? String(p.pages) : unreadable.has(docKey(d)) ? '' : '…'],
      ['Taille', C.formatSize(d.size), { sub: `${Number(d.size).toLocaleString('fr-FR')} octets` }],
      ['Format', p.version ? `PDF ${p.version}` : 'PDF'],
      ['Langue', languageName(p.language)],
      ['Ajouté le', dateFr(d.mtime)],
      ['Créé le', p.created ? dateFr(p.created) : ''],
      ['Modifié le', p.modified && dateFr(p.modified) !== dateFr(p.created) ? dateFr(p.modified) : ''],
      ['Logiciel', p.software],
      ['Fichier', d.file, { file: true }],
    ];
    return infoList(rows);
  }

  /** Sommaire : signets du PDF (cours en dossier : ceux du condensé) ; un clic ouvre la visionneuse à la bonne page. */
  function tocTab(d) {
    const cover = C.coverOf(d);
    if (!cover) return h('p', { class: 'tab-empty' }, 'Ce cours n\'a pas de PDF.');
    const p = cache.get(docKey(cover));
    if (!p) return h('p', { class: 'tab-empty' }, unreadable.has(docKey(cover)) ? 'PDF illisible : sommaire indisponible.' : 'Lecture du sommaire…');
    if (!p.outline || !p.outline.length) {
      return h('p', { class: 'tab-empty' }, `${d.kind === 'folder' && d.condense ? 'Le condensé' : 'Ce PDF'} n'a pas de signets : pas de sommaire à afficher.`);
    }
    const entry = (s, sub) =>
      h(
        'button',
        { type: 'button', class: `toc-item${sub ? ' sub' : ''}`, disabled: !s.page, title: s.page ? `Ouvrir à la page ${s.page}` : null, onclick: () => openDoc(d, { target: cover, page: s.page }) },
        sub ? (s.code ? h('span', { class: 'toc-code' }, s.code) : null) : h('span', { class: 'toc-badge' }, s.code || icon(ICONS.file)),
        h('span', { class: 'toc-title' }, s.title),
        s.page ? h('span', { class: 'toc-page' }, sub ? String(s.page) : `p. ${s.page}`) : null
      );
    return h('div', { class: 'toc' }, p.outline.map((s) => h('div', { class: 'toc-part' }, entry(s, false), s.items.map((x) => entry(x, true)))));
  }

  /** Mes notes : texte libre gardé sur ce PC, enregistré pendant la saisie. */
  function notesTab(d) {
    const id = courseId(d);
    const saved = h('span', { class: 'notes-state' }, notes.get(id) ? 'Enregistré' : 'Gardées sur ce PC');
    const area = h('textarea', { class: 'notes', placeholder: 'Tes notes sur ce cours : points à retenir, questions…', spellcheck: 'true', 'aria-label': 'Mes notes' });
    area.value = notes.get(id) || '';
    let timer = null;
    area.addEventListener('input', () => {
      saved.textContent = '…';
      clearTimeout(timer);
      timer = setTimeout(() => {
        notes.set(id, area.value.trim() ? area.value : null);
        saved.textContent = 'Enregistré';
        if (!sameDoc(shownDoc(), d)) return; // un autre cours est affiché entre-temps : son onglet n'est pas concerné
        const tab = document.querySelector('.tab[data-tab="notes"]');
        if (tab && !tab.querySelector('.tab-dot') && area.value.trim()) tab.append(h('span', { class: 'tab-dot' }));
        if (tab && !area.value.trim()) tab.querySelector('.tab-dot')?.remove();
      }, 400);
    });
    return h('div', { class: 'notes-box' }, area, saved);
  }

  function viewPart(part) {
    const docs = docsOf(part.id);
    if (!state.loaded) return h('section', { class: 'cp-empty' }, h('p', { class: 'muted pad' }, 'Chargement des résumés…'));
    if (!docs.length) {
      return h(
        'section',
        { class: 'cp-empty', style: { '--part': part.accent } },
        h(
          'div',
          { class: 'empty' },
          part.logo ? partBadge(part, 'large') : h('span', { class: 'empty-icon' }, icon(ICONS.file)),
          h('strong', null, `${part.name} : aucun cours pour l'instant`),
          h('p', null, `Les résumés PDF de ${part.name} apparaîtront ici dès qu'ils seront ajoutés.`),
          api && state.dev ? h('button', { type: 'button', class: 'btn', onclick: () => api.openFolder(part.id) }, icon(ICONS.folder), 'Ouvrir le dossier des PDF') : null
        )
      );
    }
    const current = currentDoc(part.id);
    state.selected[part.id] = current.file;
    // Pages et sommaire de tous les cours de la partie, en arrière-plan (le cours affiché d'abord)
    requestAnimationFrame(() => {
      for (const d of [current, ...docs.filter((x) => x !== current)]) {
        const t = C.coverOf(d); // cours en dossier : son condensé (ou premier PDF)
        if (t && !cache.get(docKey(t)) && !unreadable.has(docKey(t))) requestPreview(t, h('span'));
      }
    });
    return h('section', { class: 'cp', style: { '--part': part.accent } }, courseList(part, docs, current), h('div', { class: 'cp-detail' }, courseDetail(current)));
  }

  // ------------------------------------------------------------------ barre des parties (à gauche)

  function buildRail() {
    const rail = $('rail');
    const item = (props, content, label) => h('button', { type: 'button', class: 'rail-btn', title: label, 'aria-label': label, ...props }, content);
    rail.replaceChildren(
      h('span', { class: 'rail-ind', 'aria-hidden': 'true' }),
      item({ 'data-view': 'home', onclick: () => goHome() }, icon(ICONS.home), 'Accueil : nouveautés (Échap)'),
      h('span', { class: 'rail-sep', 'aria-hidden': 'true' }),
      ...parts.map((p, i) =>
        item({ 'data-part': p.id, style: { '--part': p.accent }, onclick: () => go('part', { partId: p.id }) }, partBadge(p), `${p.name} — ${p.description} (${i + 1})`)
      )
    );
  }

  /** Pastille active + indicateur (glisse d'une pastille à l'autre). */
  function renderRail() {
    const rail = $('rail');
    let active = null;
    for (const b of rail.querySelectorAll('.rail-btn')) {
      const on = b.dataset.view ? state.view === 'home' : state.view === 'part' && b.dataset.part === state.partId;
      b.classList.toggle('on', on);
      if (on) {
        b.setAttribute('aria-current', 'page');
        active = b;
      } else b.removeAttribute('aria-current');
    }
    const ind = rail.querySelector('.rail-ind');
    if (!ind) return;
    ind.classList.toggle('hidden', !active);
    if (active) ind.style.transform = `translateY(${active.offsetTop + active.offsetHeight / 2 - 12}px)`;
  }

  // ------------------------------------------------------------------ recherche

  function viewSearch() {
    const results = C.search(parts.map((p) => ({ ...p, documents: docsOf(p.id) })), state.query);
    return h(
      'section',
      { class: 'part search-view' },
      h('header', { class: 'search-head' }, h('h1', null, `Recherche : « ${state.query.trim()} »`), h('p', { class: 'lead' }, results.length ? plural(results.length, 'résumé trouvé', 'résumés trouvés') : 'Aucun résumé ne correspond.')),
      h('div', { class: 'doc-list' }, results.map((d) => docRow(d, { showPart: true })))
    );
  }

  function onSearchInput(e) {
    state.query = e.target.value;
    if (state.query.trim()) {
      if (state.view !== 'search') state.back = { view: state.view, partId: state.partId };
      state.view = 'search';
      render();
    } else if (state.view === 'search') {
      const b = state.back || { view: 'home' };
      go(b.view, { partId: b.partId, focus: false });
    }
  }

  // ------------------------------------------------------------------ chargement des documents

  async function loadDocuments() {
    let files = {};
    if (api) {
      try {
        files = (await api.listDocuments()) || {};
      } catch {
        files = {};
      }
    }
    const next = Object.fromEntries(parts.map((p) => [p.id, C.mergeDocuments(p, files[p.id] || [])]));
    if (state.loaded && JSON.stringify(next) === JSON.stringify(state.docs)) return false; // rien de nouveau : mêmes objets
    state.docs = next;
    state.loaded = true;
    // Aperçus gardés : PDF seuls, et chaque PDF des cours en dossier (condensé compris)
    cache.keepOnly(parts.flatMap((p) => state.docs[p.id].flatMap((d) => (d.kind === 'folder' ? [...(d.condense ? [d.condense] : []), ...d.files] : [d]).map(docKey))));
    return true;
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
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f')) {
      e.preventDefault();
      $('search').focus();
      $('search').select();
      return;
    }
    if (e.key === 'Escape') {
      if (e.target instanceof HTMLTextAreaElement) {
        e.target.blur(); // notes : Échap quitte la saisie (déjà enregistrée)
        return;
      }
      if (e.target.classList && e.target.classList.contains('doc-filter') && e.target.value) {
        e.target.value = '';
        e.target.dispatchEvent(new Event('input'));
        return;
      }
      if (state.view === 'search' || e.target === $('search')) {
        $('search').value = '';
        onSearchInput({ target: $('search') });
        $('search').blur();
      } else if (state.view === 'part') go('home');
      return;
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    // Partie : ↑ / ↓ changent de cours (parmi ceux que le filtre laisse visibles)
    if (state.view === 'part' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const visible = docsOf(state.partId).filter((d) => {
        const item = document.querySelector(`.cp-row[data-file="${CSS.escape(d.file)}"]`);
        return item && !item.hidden;
      });
      if (!visible.length) return;
      e.preventDefault();
      const i = visible.findIndex((d) => d.file === state.selected[state.partId]);
      const next = i < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
      selectCourse(visible[next], { focus: true });
      return;
    }
    // 1, 2… : ouvrir une partie (comme les pastilles de la barre de gauche)
    if (/^[1-9]$/.test(e.key) && parts[Number(e.key) - 1]) go('part', { partId: parts[Number(e.key) - 1].id });
  }

  // ------------------------------------------------------------------ démarrage

  async function init() {
    try {
      if (!C || !DATA) {
        main.replaceChildren(h('p', { class: 'muted pad' }, 'Contenu des cours introuvable (lib/content.js). Réinstallez l\'application.'));
        return;
      }
      $('home-link').addEventListener('click', goHome);
      $('search').addEventListener('input', onSearchInput);
      document.addEventListener('keydown', onKey);
      buildRail();
      window.addEventListener('resize', renderRail);
      // Retour dans la fenêtre : nouveaux PDF éventuels (ajoutés pendant que Cours était ouvert)
      window.addEventListener('focus', async () => {
        if (state.view === 'search') return;
        if (await loadDocuments()) render();
      });
      initTheme();
      go('home', { focus: false });
      if (api) {
        try {
          state.dev = Boolean((await api.info()).dev); // développement : bouton « Ouvrir le dossier des PDF »
        } catch {
          state.dev = false;
        }
        await loadDocuments();
        render();
      }
    } finally {
      if (api) api.uiReady();
    }
  }

  init();
})();
