/*
 * app.js — Interface d'Agépédé.
 *
 * L'état complet est un projet Agdlp (domaine, options, ous, users, globals, locals, folders, permissions). Les tableaux de
 * saisie (grid.js) modifient directement ses lignes ; après chaque modification : vérification
 * (Agdlp.validateProject), surlignage des cellules, script (Agdlp.plan + Agdlp.toBatch) et brouillon local.
 *
 * Pour la simulation et l'exécution, la page envoie le PROJET au processus principal, qui le revalide et
 * régénère lui-même les commandes (identiques à l'aperçu) avant de les confier à lib/runner.js.
 */
'use strict';

(() => {
  const A = window.Agdlp;
  const api = window.agepede || null;
  const $ = (id) => document.getElementById(id);

  const TABLES = ['ous', 'users', 'globals', 'locals', 'folders', 'permissions'];
  const TAB_ORDER = [...TABLES, 'script'];
  const TABLE_LABELS = { ous: 'OU', users: 'Utilisateurs', globals: 'Groupes globaux', locals: 'Groupes DL', folders: 'Dossiers', permissions: 'Permissions', domain: 'Domaine', options: 'Options', project: 'Projet' };
  const DRAFT_KEY = 'agepede.draft.v1';
  const KIND_LABELS = { ou: 'OU', user: 'Utilisateur', group: 'Groupe', member: 'Appartenance', folder: 'Dossier', inherit: 'Héritage', acl: 'Permission' };
  /** Options du projet liées à un champ de la page : id → [clé, type]. */
  const OPTION_INPUTS = {
    'opt-create-folders': ['createFolders', 'check'],
    'opt-default-password': ['defaultPassword', 'text'],
    'opt-must-change': ['mustChangePassword', 'check'],
    'opt-strip-users': ['stripUsers', 'check'],
    'opt-strip-users-perm': ['stripUsers', 'check'], // même option, reprise dans l'onglet Permissions
  };

  // ------------------------------------------------------------------ utilitaires

  const norm = (s) =>
    String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();

  const str = (v) => (v == null ? '' : String(v));
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function debounce(fn, ms) {
    let t = null;
    const d = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn();
      }, ms);
    };
    /** Exécute tout de suite un appel en attente (rien s'il n'y en a pas). */
    d.flush = () => {
      if (t === null) return;
      clearTimeout(t);
      t = null;
      fn();
    };
    return d;
  }

  const RIGHT_KEYS = ['R', 'RW', 'F'];
  const DEFAULT_RIGHT_LABELS = { R: 'Lecture', RW: 'Modification', F: 'Contrôle total' };
  const rightLabel = (k) => (A && A.RIGHTS && A.RIGHTS[k] && A.RIGHTS[k].label) || DEFAULT_RIGHT_LABELS[k] || k;
  const RIGHT_SYNONYMS = {
    R: ['R', 'L', 'LECTURE', 'READ', 'RX', 'LECTURE SEULE', 'LECTURE ET EXECUTION', 'READ ONLY'],
    RW: ['RW', 'M', 'MODIFICATION', 'MODIFIER', 'MODIFY', 'ECRITURE', 'LECTURE ECRITURE', 'LECTURE ET ECRITURE', 'LE', 'W'],
    F: ['F', 'CT', 'FC', 'CONTROLE TOTAL', 'FULL', 'FULL CONTROL', 'TOTAL'],
  };

  /** Droit saisi ou collé (code ou libellé, avec ou sans accents) → R | RW | F ; sinon la valeur telle quelle. */
  function coerceRight(value) {
    const n = norm(value);
    if (!n) return 'R';
    if (A && typeof A.normalizeRight === 'function') {
      const k = A.normalizeRight(value);
      if (k) return k;
    }
    for (const k of RIGHT_KEYS) {
      if (norm(rightLabel(k)) === n || RIGHT_SYNONYMS[k].includes(n)) return k;
    }
    return str(value).trim();
  }

  const prefix = (kind, fallback) => (A && A.PREFIXES && A.PREFIXES[kind]) || fallback;

  function safeDn(dns) {
    const d = str(dns).trim();
    if (!d) return '';
    try {
      return A.domainToDn(d) || '';
    } catch {
      return '';
    }
  }

  const guessNetbios = (dns) =>
    str(dns)
      .trim()
      .split('.')[0]
      .toUpperCase()
      .slice(0, 15);

  // ------------------------------------------------------------------ état

  const state = {
    project: null,
    filePath: null,
    name: '',
    dirty: false,
    dnAuto: true,
    nbAuto: true,
    tab: 'ous',
    env: null,
    detecting: false,
    issues: { errors: [], warnings: [] },
    steps: [],
    script: '',
    scriptDate: '',
    planError: null,
    closing: false,
    info: null,
    run: { active: false, dryRun: false, steps: [], results: [], summary: null, error: null, startedAt: null, endedAt: null, fake: false, open: new Set() },
    alwaysAdmin: false, // option « Toujours démarrer en administrateur »
    elevating: false,
    ad: null, // annuaire lu (OU, comptes, groupes déjà présents) : { base, at, ous, users, groups }
    adReading: false,
    adError: '',
    adFake: false,
  };

  const grids = {};

  // ------------------------------------------------------------------ colonnes des tableaux

  const COLUMNS = {
    ous: [
      { key: 'name', label: 'Nom', placeholder: 'Nouvelle OU, ex. Paris', width: '26%' },
      { key: 'parent', label: 'OU parente', list: 'dl-ou-paths', placeholder: 'vide = racine du domaine', width: '32%', aliases: ['Parent', 'OU parent', 'Chemin parent'] },
      { key: 'description', label: 'Description', placeholder: '' },
    ],
    users: [
      { key: 'login', label: 'Identifiant', placeholder: 'Nouveau compte, ex. jdupont', width: '17%', aliases: ['Login', 'sAMAccountName', 'Nom d\'ouverture de session', 'Compte'] },
      { key: 'firstName', label: 'Prénom', placeholder: 'Jean', width: '15%', aliases: ['Prenom', 'First name'] },
      { key: 'lastName', label: 'Nom', placeholder: 'Dupont', width: '17%', aliases: ['Nom de famille', 'Last name'] },
      { key: 'ou', label: 'OU', list: 'dl-ou-paths', placeholder: 'vide = conteneur Users', width: '25%' },
      { key: 'password', label: 'Mot de passe', placeholder: 'vide = mot de passe par défaut', aliases: ['MDP', 'Password'] },
    ],
    globals: [
      { key: 'name', label: 'Nom', placeholder: 'Nouveau groupe, ex. GG_Compta', width: '22%' },
      { key: 'ou', label: 'OU', list: 'dl-ou-paths', placeholder: 'vide = conteneur Users', width: '20%' },
      { key: 'description', label: 'Description', width: '24%' },
      { key: 'members', label: 'Membres (utilisateurs)', list: 'dl-user-names', multi: true, placeholder: 'jdupont, mmartin', aliases: ['Membres', 'Utilisateurs'] },
    ],
    folders: [
      { key: 'path', label: 'Dossier', placeholder: 'D:\\Partages\\Compta', width: '62%', aliases: ['Chemin', 'Dossier partagé'] },
      {
        key: 'inheritance',
        label: 'Héritage des droits',
        type: 'toggle',
        defaultValue: 'keep',
        coerce: (v) => A.normalizeInheritance(v),
        aliases: ['Héritage', 'Heritage', 'Héritage (Conservé, Cassé)'],
        help: 'Cliquez sur le bouton d\'une ligne pour casser ou rétablir l\'héritage des autorisations du dossier.',
        states: [
          { value: 'keep', label: '🔗 Conservé', title: 'Le dossier hérite des autorisations de son dossier parent. Cliquez pour casser l\'héritage.' },
          { value: 'break', label: '✂ Cassé', title: 'L\'héritage sera cassé (icacls /inheritance:d) : les autorisations du parent sont recopiées puis le dossier n\'en hérite plus. Cliquez pour le conserver.' },
        ],
      },
    ],
    locals: [
      { key: 'name', label: 'Nom', placeholder: 'Nouveau groupe, ex. DL_Compta_RW', width: '22%' },
      { key: 'ou', label: 'OU', list: 'dl-ou-paths', placeholder: 'vide = conteneur Users', width: '20%' },
      { key: 'description', label: 'Description', width: '24%' },
      { key: 'members', label: 'Membres (GG)', list: 'dl-gg-names', multi: true, placeholder: 'GG_Compta, GG_Direction', aliases: ['Membres', 'Groupes globaux'] },
    ],
    permissions: [
      { key: 'path', label: 'Dossier', list: 'dl-folder-paths', placeholder: 'D:\\Partages\\Compta', width: '36%', aliases: ['Chemin', 'Dossier partagé'] },
      { key: 'group', label: 'Groupe DL', list: 'dl-dl-names', placeholder: 'DL_Compta_RW', width: '24%', aliases: ['Groupe'] },
      {
        key: 'right',
        label: 'Droit',
        type: 'select',
        options: RIGHT_KEYS.map((k) => ({ value: k, label: rightLabel(k) })),
        defaultValue: 'R',
        coerce: coerceRight,
        aliases: ['Droits', 'Permission', 'Accès'],
        width: '18%',
      },
      {
        // Bouton : casse l'héritage du dossier partagé (ligne de l'onglet Dossiers), pour n'y laisser que les DL
        key: 'inherit',
        label: 'Héritage du dossier',
        type: 'action',
        emptyLabel: '✂ Casser l\'héritage',
        help: 'Casser l\'héritage du dossier partagé : il ne reprend plus les droits de son parent, seuls les DL (et les administrateurs) y ont accès.',
        render: (row) => inheritButton(row),
        onClick: (row) => toggleInheritance(row),
      },
    ],
  };

  // Les en-têtes du format CSV du moteur sont aussi reconnus quand on colle un bloc avec ses en-têtes
  if (A && A.COLUMNS) {
    for (const t of TABLES) {
      for (const c of A.COLUMNS[t] || []) {
        const col = COLUMNS[t].find((x) => x.key === c.key);
        if (col && c.label) col.aliases = [...(col.aliases || []), c.label];
      }
    }
  }

  const fieldLabel = (table, field) => {
    if (table === 'domain') return { dns: 'Nom DNS', dn: 'DN', netbios: 'NetBIOS' }[field] || field;
    if (field === 'defaultPassword') return 'Mot de passe par défaut';
    const col = (COLUMNS[table] || []).find((c) => c.key === field);
    return col ? col.label : field;
  };

  function newRow(table) {
    const id = A.newId();
    switch (table) {
      case 'ous':
        return { id, name: '', parent: '', description: '' };
      case 'users':
        return { id, login: '', firstName: '', lastName: '', ou: '', password: '' };
      case 'folders':
        return { id, path: '', inheritance: 'keep' };
      case 'permissions':
        return { id, path: '', group: '', right: 'R' };
      default:
        return { id, name: '', ou: '', description: '', members: '' };
    }
  }

  const isBlankRow = (table, row) => COLUMNS[table].every((c) => c.type === 'select' || c.type === 'toggle' || str(row[c.key]).trim() === '');

  /** Projet tel qu'il sera vérifié, enregistré et exécuté : sans les lignes entièrement vides. */
  function effectiveProject() {
    const p = state.project;
    const out = { ...p, domain: { ...(p.domain || {}) }, options: { ...(p.options || {}) } };
    for (const t of TABLES) out[t] = (p[t] || []).filter((r) => !isBlankRow(t, r)).map((r) => ({ ...r }));
    return out;
  }

  /** Projet chargé (fichier, brouillon, nouveau) : forme normalisée et un id par ligne. */
  function shapeProject(obj) {
    const p = A.normalizeProject(obj || A.emptyProject());
    p.domain = p.domain || { dns: '', dn: '', netbios: '' };
    p.options = p.options || A.emptyProject().options;
    for (const t of TABLES) {
      if (!Array.isArray(p[t])) p[t] = [];
      for (const r of p[t]) if (!r.id) r.id = A.newId();
    }
    return p;
  }

  // ------------------------------------------------------------------ notifications et questions

  function toast(message, kind = 'info', action = null) {
    const box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    const t = el('div', `toast ${kind}`);
    t.appendChild(el('span', 'msg', message));
    let timer = null;
    const close = () => {
      clearTimeout(timer);
      t.remove();
    };
    if (action) {
      const b = el('button', 'btn', action.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        close();
        action.run();
      });
      t.appendChild(b);
    }
    const x = el('button', 'row-del', '×');
    x.type = 'button';
    x.title = 'Fermer';
    x.addEventListener('click', close);
    t.appendChild(x);
    box.appendChild(t);
    timer = setTimeout(close, kind === 'error' || action ? 9000 : 5000);
  }

  /** Fichier écrit : nom court dans la notification, chemin complet en info-bulle, bouton « Afficher ». */
  function toastFile(what, filePath) {
    const base = str(filePath).split(/[\\/]/).pop();
    toast(`${what} : ${base}`, 'ok', { label: 'Afficher', run: () => api.showFile(filePath) });
    const last = $('toasts').lastChild;
    if (last) last.title = filePath;
  }

  /** Petite boîte de question dans la fenêtre ; renvoie l'id du bouton choisi ('cancel' avec Échap). */
  function ask({ title, message, buttons }) {
    const dlg = $('ask-dialog');
    $('ask-title').textContent = title || 'Agépédé';
    $('ask-message').textContent = message || '';
    const actions = $('ask-actions');
    actions.textContent = '';
    return new Promise((resolve) => {
      let done = false;
      const finish = (id) => {
        if (done) return;
        done = true;
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
        resolve(id);
      };
      const onCancel = (e) => {
        e.preventDefault();
        finish('cancel');
      };
      dlg.addEventListener('cancel', onCancel);
      for (const b of buttons) {
        const btn = el('button', `btn${b.primary ? ' btn-primary' : ''}`, b.label);
        btn.type = 'button';
        btn.addEventListener('click', () => finish(b.id));
        actions.appendChild(btn);
      }
      dlg.showModal();
      const primary = actions.querySelector('.btn-primary') || actions.firstChild;
      if (primary) primary.focus();
    });
  }

  const modalOpen = () => Boolean(document.querySelector('dialog[open]'));

  // ------------------------------------------------------------------ titre, état modifié, brouillon

  function updateTitle() {
    const name = state.name || 'Sans titre';
    document.title = `${state.dirty ? '● ' : ''}${name} — Agépédé`;
    const pn = $('project-name');
    pn.textContent = name;
    pn.classList.toggle('dirty', state.dirty);
    pn.title = state.filePath ? `${state.filePath}${state.dirty ? ' (modifié)' : ''}` : state.dirty ? 'Projet non enregistré (modifié)' : 'Projet non enregistré';
  }

  function setDirty(value) {
    const v = Boolean(value);
    if (state.dirty !== v) {
      state.dirty = v;
      if (api) api.setDirty(v);
    }
    updateTitle();
  }

  /** Copie du projet sans aucun mot de passe (colonne Mot de passe, mot de passe par défaut) : le brouillon est en clair sur le disque. */
  function withoutPasswords(project) {
    const p = { ...project, options: { ...(project.options || {}), defaultPassword: '' } };
    p.users = (project.users || []).map((u) => ({ ...u, password: '' }));
    const removed = Boolean(str(project.options && project.options.defaultPassword) || (project.users || []).some((u) => str(u.password)));
    return { project: p, removed };
  }

  function saveDraft() {
    if (state.closing || !state.project) return;
    try {
      const { project, removed } = withoutPasswords(state.project);
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ project, passwordsRemoved: removed, filePath: state.filePath, name: state.name, dirty: state.dirty, at: Date.now() }));
    } catch {
      // stockage indisponible : le brouillon n'est simplement pas conservé
    }
  }

  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      return d && d.project && typeof d.project === 'object' ? d : null;
    } catch {
      return null;
    }
  }

  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // rien à faire
    }
  }

  const scheduleDraft = debounce(saveDraft, 400);

  // ------------------------------------------------------------------ listes de suggestions

  function names(table, key = 'name') {
    const seen = new Set();
    const out = [];
    for (const r of state.project[table] || []) {
      const n = str(r[key]).trim();
      if (n && !seen.has(n.toLowerCase())) {
        seen.add(n.toLowerCase());
        out.push(n);
      }
    }
    return out.sort((a, b) => a.localeCompare(b, 'fr'));
  }

  function ouPaths() {
    const set = new Set();
    for (const r of state.project.ous || []) {
      const n = str(r.name).trim();
      if (!n) continue;
      if (typeof A.ouFullPath === 'function') {
        set.add(A.ouFullPath(r));
        continue;
      }
      const parent = str(r.parent).trim().replace(/^\/+|\/+$/g, '');
      set.add(parent ? `${parent}/${n}` : n);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  function fillDatalist(id, values) {
    const dl = $(id);
    dl.textContent = '';
    for (const v of values.slice(0, 2000)) {
      const o = document.createElement('option');
      o.value = v;
      dl.appendChild(o);
    }
  }

  /** Noms du tableau, complétés par ceux de l'annuaire lu (même domaine que le projet), sans doublon. */
  function withAd(list, adNames) {
    const seen = new Set(list.map((n) => n.toLowerCase()));
    const out = list.slice();
    for (const n of adNames) {
      if (n && !seen.has(n.toLowerCase())) {
        seen.add(n.toLowerCase());
        out.push(n);
      }
    }
    return out.sort((a, b) => a.localeCompare(b, 'fr'));
  }

  const adNames = (table) => (adIndex() ? adItems(table).map((it) => (table === 'ous' ? it.path : table === 'users' ? it.login : it.name)) : []);

  function refreshLists() {
    fillDatalist('dl-ou-paths', withAd(ouPaths(), adNames('ous')));
    fillDatalist('dl-gg-names', withAd(names('globals'), adNames('globals')));
    fillDatalist('dl-dl-names', withAd(names('locals'), adNames('locals')));
    fillDatalist('dl-folder-paths', names('folders', 'path'));
  }

  const scheduleLists = debounce(refreshLists, 250);

  // ------------------------------------------------------------------ vérification et script

  function scriptOptions(eff) {
    return { title: state.name || 'Agépédé', domain: eff.domain && eff.domain.dns, date: state.scriptDate };
  }

  function validate() {
    if (!state.project) return;
    const eff = effectiveProject();
    let res;
    try {
      res = A.validateProject(eff, { directory: state.ad }) || {};
    } catch (err) {
      res = { errors: [{ table: 'project', message: `Vérification impossible : ${err.message}` }], warnings: [] };
    }
    state.issues = { errors: res.errors || [], warnings: res.warnings || [] };

    // Script (toujours à jour : il sert aussi à savoir s'il y a quelque chose à exécuter).
    // La date de l'en-tête ne change que si le contenu change : l'aperçu, la copie et le .bat exporté
    // restent identiques.
    try {
      state.steps = A.plan(eff) || [];
      const key = JSON.stringify([state.name, eff.domain && eff.domain.dns, state.steps.map((s) => [s.label, s.command, s.check])]);
      if (key !== state.scriptKey || !state.scriptDate) {
        state.scriptKey = key;
        state.scriptDate = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      }
      state.script = A.toBatch(state.steps, scriptOptions(eff));
      state.planError = null;
    } catch (err) {
      state.steps = [];
      state.script = '';
      state.planError = err && err.message ? err.message : String(err);
    }

    const tagged = [...state.issues.errors.map((i) => ({ ...i, level: 'error' })), ...state.issues.warnings.map((i) => ({ ...i, level: 'warning' }))];
    for (const t of TABLES) grids[t].applyIssues(tagged.filter((i) => i.table === t));
    markRows();
    if (state.ad) for (const t of AD_TABLES) renderAdPanel(t); // « dans le tableau » / « Ajouter au tableau » à jour
    grids.permissions.refreshActions(); // boutons « Casser l'héritage » (dépendent de l'onglet Dossiers)
    renderInheritNote();
    // Projet vierge : pas de rouge sur le domaine avant que l'utilisateur ait commencé
    state.pristine = !TABLES.some((t) => eff[t].length) && !str(eff.domain.dns) && !str(eff.domain.dn);
    applyDomainIssues(state.pristine ? [] : tagged.filter((i) => !TABLES.includes(i.table) && ['dns', 'dn', 'netbios'].includes(i.field)));
    updateCounts(tagged);
    renderIssues(tagged);
    renderScript();
    updateRunControls();
  }

  const scheduleValidate = debounce(validate, 150);

  function applyDomainIssues(issues) {
    const map = { dns: $('dom-dns'), dn: $('dom-dn'), netbios: $('dom-netbios') };
    for (const input of Object.values(map)) {
      input.classList.remove('has-error', 'has-warning');
      input.title = '';
    }
    for (const it of issues) {
      const input = map[it.field];
      if (!input) continue;
      if (it.level === 'error') input.classList.remove('has-warning');
      if (!input.classList.contains('has-error')) input.classList.add(it.level === 'error' ? 'has-error' : 'has-warning');
      input.title = input.title ? `${input.title}\n${it.message}` : it.message;
    }
  }

  function updateCounts(tagged) {
    for (const t of TABLES) {
      const n = (state.project[t] || []).filter((r) => !isBlankRow(t, r)).length;
      document.querySelector(`[data-count="${t}"]`).textContent = String(n);
      const tab = $(`tab-${t}`);
      if (tagged) {
        const mine = tagged.filter((i) => i.table === t);
        tab.classList.toggle('tab-error', mine.some((i) => i.level === 'error'));
        tab.classList.toggle('tab-warning', !mine.some((i) => i.level === 'error') && mine.length > 0);
      }
    }
    const sc = document.querySelector('[data-count="script"]');
    const tabScript = $('tab-script');
    const nErr = state.pristine ? 0 : state.issues.errors.length;
    sc.textContent = nErr ? `${nErr} erreur${nErr > 1 ? 's' : ''}` : state.steps.length ? String(state.steps.length) : '';
    tabScript.classList.toggle('tab-error', nErr > 0);
    tabScript.title = `Ctrl+5${nErr ? ` — ${plural(nErr, 'erreur à corriger', 'erreurs à corriger')}` : state.steps.length ? ` — ${plural(state.steps.length, 'commande', 'commandes')}` : ''}`;
  }

  function rowLabel(table, id) {
    const rows = state.project[table] || [];
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return '';
    const r = rows[i];
    const what = str(r.name || r.login || r.path).trim();
    return `ligne ${i + 1}${what ? ` (${what})` : ''}`;
  }

  function renderIssues(tagged) {
    const ul = $('issues');
    ul.textContent = '';
    const nErr = state.issues.errors.length;
    const nWarn = state.issues.warnings.length;
    $('validation-meta').textContent = nErr || nWarn ? `${plural(nErr, 'erreur', 'erreurs')}, ${plural(nWarn, 'avertissement', 'avertissements')}` : '';
    if (!tagged.length) {
      const li = el('li');
      li.appendChild(el('span', 'ok', '✓ Aucune erreur.'));
      if (!state.steps.length) li.appendChild(el('span', 'where', 'Remplissez les tableaux pour générer le script.'));
      ul.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of tagged.slice(0, 400)) {
      const li = el('li', it.level);
      li.appendChild(el('span', 'lvl', it.level === 'error' ? '✗ Erreur' : '⚠ Avertissement'));
      const table = TABLES.includes(it.table) ? it.table : it.table === 'domain' || ['dns', 'dn', 'netbios'].includes(it.field) ? 'domain' : null;
      const where = [];
      if (it.table) where.push(TABLE_LABELS[it.table] || it.table);
      if (table && table !== 'domain' && it.id != null) where.push(rowLabel(table, it.id));
      if (it.field) where.push(fieldLabel(it.table, it.field));
      if (where.length) li.appendChild(el('span', 'where', `${where.filter(Boolean).join(' › ')} :`));
      li.appendChild(el('span', 'msg', it.message));
      if (table) {
        li.dataset.table = table;
        if (it.id != null) li.dataset.id = it.id;
        if (it.field) li.dataset.field = it.field;
        li.title = 'Aller à la cellule';
      }
      frag.appendChild(li);
    }
    if (tagged.length > 400) frag.appendChild(el('li', 'where', `… et ${tagged.length - 400} autres.`));
    ul.appendChild(frag);
  }

  function goToIssue(li) {
    const table = li.dataset.table;
    if (table === 'domain') {
      const input = { dns: $('dom-dns'), dn: $('dom-dn'), netbios: $('dom-netbios') }[li.dataset.field] || $('dom-dns');
      input.focus();
      input.select();
      return;
    }
    showTab(table);
    if (li.dataset.field === 'defaultPassword') {
      $('opt-default-password').focus();
      return;
    }
    if (li.dataset.id && !grids[table].reveal(li.dataset.id, li.dataset.field)) grids[table].addRow();
  }

  function countKinds(steps) {
    const c = { ou: 0, user: 0, group: 0, member: 0, folder: 0, inherit: 0, acl: 0 };
    for (const s of steps) if (c[s.kind] !== undefined) c[s.kind] += 1;
    return c;
  }

  function describeCounts(steps) {
    const c = countKinds(steps);
    const parts = [plural(c.ou, 'OU', 'OU')];
    if (c.user) parts.push(plural(c.user, 'utilisateur', 'utilisateurs'));
    parts.push(plural(c.group, 'groupe', 'groupes'), plural(c.member, 'appartenance', 'appartenances'));
    if (c.folder) parts.push(plural(c.folder, 'dossier', 'dossiers'));
    if (c.inherit) parts.push(plural(c.inherit, 'héritage cassé', 'héritages cassés'));
    parts.push(plural(c.acl, 'permission', 'permissions'));
    return parts.join(', ');
  }

  function renderScript() {
    const pre = $('script-preview');
    const blocked = state.issues.errors.length > 0 || Boolean(state.planError);
    pre.classList.toggle('blocked', blocked);
    pre.textContent = '';
    if (state.planError) {
      pre.textContent = `Le script ne peut pas être généré : ${state.planError}`;
    } else if (!state.steps.length) {
      pre.textContent = 'Aucune commande : remplissez les tableaux (OU, utilisateurs, groupes, dossiers, permissions).';
    } else {
      const frag = document.createDocumentFragment();
      const lines = state.script.split(/\r?\n/);
      if (lines[lines.length - 1] === '') lines.pop(); // le script se termine par un retour à la ligne
      for (const line of lines) {
        if (/^\s*(rem\b|::|@?echo off)/i.test(line)) frag.appendChild(el('span', 'rem', `${line}\n`));
        else frag.appendChild(document.createTextNode(`${line}\n`));
      }
      pre.appendChild(frag);
    }
    $('script-meta').textContent = state.steps.length ? `${plural(state.steps.length, 'commande', 'commandes')} : ${describeCounts(state.steps)}` : '';
    const canExport = !blocked && state.steps.length > 0;
    for (const id of ['btn-copy', 'btn-export-bat']) {
      const b = $(id);
      b.disabled = !canExport;
      b.title = canExport ? '' : blocked ? 'Corrigez les erreurs pour copier ou exporter le script.' : 'Le script est vide.';
    }
  }

  // ------------------------------------------------------------------ environnement

  function renderEnv() {
    const env = state.env;
    const badge = $('env-badge');
    const chips = $('env-chips');
    chips.textContent = '';
    badge.className = 'env-badge';
    if (state.detecting) {
      badge.textContent = 'Environnement : détection…';
      return;
    }
    if (!env) {
      badge.textContent = api ? 'Environnement : non détecté' : 'Aperçu hors application';
      return;
    }
    const tools = env.tools || {};
    const adTools = Boolean(tools.dsadd && tools.dsmod && tools.dsquery);
    if (env.fake) {
      badge.textContent = 'MODE TEST — exécution simulée';
      badge.classList.add('test');
    } else if (!env.isWindows) {
      badge.textContent = 'Hors Windows — saisie et export uniquement';
      badge.classList.add('warn');
    } else if (adTools && env.isServer) {
      badge.textContent = 'Windows Server avec outils AD';
      badge.classList.add('ok');
    } else if (adTools) {
      badge.textContent = 'Poste avec RSAT (outils AD)';
      badge.classList.add('ok');
    } else {
      badge.textContent = 'Outils AD absents — saisie et export uniquement';
      badge.classList.add('warn');
    }
    badge.title = env.error ? `Détection incomplète : ${env.error}` : '';

    const chip = (text, cls, title) => {
      const c = el('span', `chip ${cls || ''}`, text);
      if (title) c.title = title;
      chips.appendChild(c);
      return c;
    };
    chip(`Outils AD (dsadd) : ${tools.dsadd ? 'détectés' : 'absents'}`, tools.dsadd ? 'ok' : 'bad', tools.dsadd ? `dsadd ${tools.dsadd ? '✓' : '✗'} · dsmod ${tools.dsmod ? '✓' : '✗'} · dsquery ${tools.dsquery ? '✓' : '✗'} · icacls ${tools.icacls ? '✓' : '✗'}` : 'Installez RSAT « Outils AD DS » ou utilisez un contrôleur de domaine.');
    const canElevate = Boolean(api && env.isWindows && !env.fake);
    const adminChip = chip(`Administrateur : ${env.isAdmin ? 'oui' : 'non'}`, env.isAdmin ? 'ok' : 'warn', env.isAdmin ? '' : 'Certaines commandes (icacls, création de dossiers, et souvent dsadd) demandent les droits administrateur.');
    if (canElevate && !env.isAdmin) {
      const b = el('button', 'link-btn', state.elevating ? 'relance…' : 'relancer en administrateur');
      b.type = 'button';
      b.id = 'btn-elevate';
      b.disabled = state.elevating || state.run.active;
      b.title = 'Ferme Agépédé et le rouvre avec les droits administrateur (fenêtre de contrôle de compte Windows). Le projet en cours est conservé.';
      b.addEventListener('click', relaunchAsAdmin);
      adminChip.appendChild(b);
    }
    if (canElevate) {
      const label = el('label', 'chip chip-option');
      label.title = 'À chaque lancement, Agépédé demande les droits administrateur (fenêtre de contrôle de compte Windows).';
      const box = el('input');
      box.type = 'checkbox';
      box.id = 'opt-always-admin';
      box.checked = state.alwaysAdmin;
      box.addEventListener('change', () => setAlwaysAdmin(box.checked));
      label.append(box, document.createTextNode(' Toujours démarrer en administrateur'));
      chips.appendChild(label);
    }
    chip(`Windows Server : ${env.isServer ? 'oui' : 'non'}`, env.isServer ? 'ok' : '');
    const d = env.domain && env.domain.dns;
    if (d) {
      const c = chip(`Domaine du poste : ${d}`, 'ok');
      const cur = str(state.project.domain && state.project.domain.dns).trim().toLowerCase();
      if (cur !== d.toLowerCase()) {
        c.className = 'chip warn';
        c.title = 'Le projet vise un autre domaine que celui de ce poste.';
        const b = el('button', 'link-btn', 'utiliser');
        b.type = 'button';
        b.addEventListener('click', () => applyDetectedDomain(true));
        c.appendChild(b);
      }
    } else {
      chip('Poste hors domaine', env.isWindows ? 'warn' : '', 'Simulation et exécution nécessitent un poste joint au domaine.');
    }
    adChip(chip);
  }

  function setDomain(domain, markDirty) {
    const p = state.project;
    p.domain = { ...(p.domain || {}), dns: str(domain.dns), dn: str(domain.dn) || safeDn(domain.dns), netbios: str(domain.netbios) || guessNetbios(domain.dns) };
    fillDomainInputs();
    if (markDirty) changed();
    else scheduleValidate();
  }

  function applyDetectedDomain(markDirty) {
    const env = state.env;
    if (!env || !env.domain || !env.domain.dns) return;
    setDomain(env.domain, markDirty);
    toast(`Domaine du projet : ${env.domain.dns}`, 'ok');
    renderEnv();
  }

  /** Relance en administrateur : la nouvelle instance reprend le projet tel quel (même non enregistré). */
  async function relaunchAsAdmin() {
    if (!api || state.elevating) return;
    if (state.run.active) return toast('Une exécution est en cours : attendez la fin avant de relancer.', 'error');
    state.elevating = true;
    renderEnv();
    try {
      saveDraft();
      const r = await api.relaunchAsAdmin({ project: effectiveProject(), filePath: state.filePath, name: state.name, dirty: state.dirty });
      if (r && r.ok) {
        state.closing = true; // la nouvelle instance prend le relais ; celle-ci se ferme
        toast('Relance en administrateur…', 'ok');
        return;
      }
      if (r && r.canceled) toast('Élévation refusée : Agépédé reste ouvert sans droits administrateur.', 'info');
      else toast(`Relance en administrateur impossible : ${(r && r.error) || 'erreur inconnue'}`, 'error');
    } catch (err) {
      toast(`Relance en administrateur impossible : ${err.message}`, 'error');
    } finally {
      if (!state.closing) {
        state.elevating = false;
        renderEnv();
      }
    }
  }

  async function setAlwaysAdmin(value) {
    if (!api) return;
    try {
      const r = await api.setAlwaysAdmin(value);
      state.alwaysAdmin = Boolean(r && r.value);
      toast(state.alwaysAdmin ? 'Agépédé demandera les droits administrateur à chaque lancement.' : 'Agépédé démarrera sans demander les droits administrateur.', 'ok');
    } catch (err) {
      toast(`Préférence non enregistrée : ${err.message}`, 'error');
    }
    renderEnv();
  }

  async function detectEnvironment(manual) {
    if (!api || state.detecting) return;
    state.detecting = true;
    $('btn-detect').disabled = true;
    renderEnv();
    try {
      state.env = await api.detectEnvironment();
    } catch (err) {
      state.env = { isWindows: false, tools: {}, error: err.message };
    } finally {
      state.detecting = false;
      $('btn-detect').disabled = false;
    }
    const env = state.env;
    const cur = str(state.project.domain && state.project.domain.dns).trim();
    if (env && env.domain && env.domain.dns) {
      if (!cur) applyDetectedDomain(manual && hasContent());
      else if (manual && cur.toLowerCase() !== env.domain.dns.toLowerCase()) {
        const r = await ask({
          title: 'Domaine détecté',
          message: `Ce poste appartient au domaine ${env.domain.dns}.\nLe projet vise ${cur}. Utiliser ${env.domain.dns} pour le projet ?`,
          buttons: [
            { id: 'yes', label: `Utiliser ${env.domain.dns}`, primary: true },
            { id: 'no', label: 'Garder le domaine du projet' },
          ],
        });
        if (r === 'yes') applyDetectedDomain(true);
      } else if (manual) toast(`Environnement détecté (domaine ${env.domain.dns}).`, 'ok');
    } else if (manual) {
      toast(env && env.isWindows ? 'Ce poste n\'est pas joint à un domaine (ou le domaine est injoignable).' : 'Environnement détecté : pas de domaine Active Directory ici.', 'info');
    }
    renderEnv();
    updateRunControls();
    // Poste joint au domaine : l'annuaire est lu tout de suite (puis à la demande : « Rafraîchir l'AD », F5)
    if (env && (env.fake || (env.isWindows && env.joined))) readDirectory(false);
    else renderAdState();
  }

  const hasContent = () => TABLES.some((t) => (state.project[t] || []).some((r) => !isBlankRow(t, r))) || Boolean(state.filePath);

  // ------------------------------------------------------------------ annuaire (bouton « Rafraîchir l'AD »)
  // OU, comptes et groupes déjà présents dans l'Active Directory, créés par Agépédé ou à la main : affichés sous
  // les tableaux, marqués « AD » dans les lignes du projet, proposés en suggestion et utilisés par la vérification.

  const AD_TABLES = ['ous', 'users', 'globals', 'locals'];

  /** Index de l'annuaire lu, s'il concerne bien le domaine du projet (sinon null). */
  const adIndex = () => (state.ad ? A.directoryIndex(state.ad, state.project.domain) : null);
  const adTime = () => (state.ad ? new Date(state.ad.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
  const adSummary = (d) => `${plural(d.ous.length, 'OU', 'OU')} · ${plural(d.users.length, 'utilisateur', 'utilisateurs')} · ${plural(d.groups.length, 'groupe', 'groupes')}`;

  /** Objets de l'annuaire montrés sous un tableau (les objets système hors OU et hors Users, comme Builtin, sont omis). */
  function adItems(table) {
    const d = state.ad;
    if (!d) return [];
    if (table === 'ous') return d.ous;
    if (table === 'users') return d.users.filter((u) => u.ou !== null);
    const scope = table === 'globals' ? 'global' : 'local';
    return d.groups.filter((g) => g.scope === scope && g.ou !== null);
  }

  /** Clé d'une ligne du projet, comparable à celle de l'objet de l'annuaire correspondant. */
  function rowKey(table, row) {
    if (table === 'ous') return A.nameKey(A.ouFullPath(row));
    if (table === 'users') return A.nameKey(row.login);
    return A.nameKey(row.name);
  }
  const itemKey = (table, item) => A.nameKey(table === 'ous' ? item.path : table === 'users' ? item.login : item.name);

  async function readDirectory(manual) {
    if (!api || !api.readDirectory || state.adReading) return;
    state.adReading = true;
    renderAdState();
    let res;
    try {
      res = await api.readDirectory();
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    state.adReading = false;
    if (res && res.ok && res.directory) {
      const before = state.ad ? new Set([...state.ad.ous, ...state.ad.users, ...state.ad.groups].map((o) => o.dn.toLowerCase())) : null;
      state.ad = res.directory;
      state.adFake = Boolean(res.fake);
      state.adError = '';
      if (manual) {
        const all = [...state.ad.ous, ...state.ad.users, ...state.ad.groups];
        const added = before ? all.filter((o) => !before.has(o.dn.toLowerCase())).length : 0;
        toast(`Active Directory relu : ${adSummary(state.ad)}${added ? ` — ${plural(added, 'nouvel objet', 'nouveaux objets')} depuis la dernière lecture` : ''}.`, 'ok');
      }
    } else {
      state.adError = (res && res.error) || "Lecture de l'annuaire impossible.";
      if (manual) toast(state.adError, 'error');
    }
    renderAdState();
    validate(); // pastilles « AD » et avertissements à jour
    refreshLists();
  }

  /** Bouton, pastille de la barre du domaine et panneaux sous les tableaux. */
  function renderAdState() {
    const b = $('btn-refresh-ad');
    const env = state.env;
    const unsupported = !api || !api.readDirectory || (env && !env.isWindows && !env.fake);
    b.disabled = state.adReading || unsupported;
    b.classList.toggle('spinning', state.adReading);
    b.title = unsupported
      ? "Lecture de l'Active Directory : sous Windows, sur un poste joint au domaine."
      : "Relire l'Active Directory (F5) : OU, utilisateurs et groupes déjà présents, y compris ceux créés à la main";
    renderEnv();
    for (const t of AD_TABLES) renderAdPanel(t);
  }

  /** Pastille « Annuaire » (ajoutée par renderEnv à la barre du domaine). */
  function adChip(chip) {
    if (state.adReading) return chip("Annuaire : lecture…", '', "Lecture de l'Active Directory en cours.");
    if (state.ad) {
      const idx = adIndex();
      const c = chip(`Annuaire : ${adSummary(state.ad)} — lu à ${adTime()}`, idx ? 'ok' : 'warn', idx ? 'Objets déjà présents dans l\'Active Directory : ils sont affichés sous chaque tableau. F5 pour relire.' : `L'annuaire lu (${A.dnToDomain(state.ad.base)}) n'est pas le domaine du projet : il n'est pas utilisé pour la vérification.`);
      return c;
    }
    if (state.adError) return chip('Annuaire : non lu', 'warn', state.adError);
    return null;
  }

  const adFilters = {}; // texte de recherche de chaque panneau

  function renderAdPanel(table) {
    const panel = $(`ad-${table}`);
    if (!panel) return;
    panel.textContent = '';
    const d = state.ad;
    const head = el('div', 'ad-head');
    const title = el('h3', null, "Déjà dans l'Active Directory");
    head.appendChild(title);
    panel.appendChild(head);
    if (!d) {
      const msg = state.adReading ? "Lecture de l'Active Directory…" : state.adError ? `${state.adError}` : "Les objets déjà présents dans l'Active Directory (créés avec Agépédé ou à la main) s'affichent ici : bouton « ↻ Rafraîchir l'AD » (F5).";
      panel.appendChild(el('p', `ad-note${state.adError ? ' bad' : ''}`, msg));
      panel.classList.add('empty');
      return;
    }
    panel.classList.remove('empty');
    const idx = adIndex();
    const items = adItems(table);
    const inTable = new Set((state.project[table] || []).filter((r) => !isBlankRow(table, r)).map((r) => rowKey(table, r)));
    title.appendChild(el('span', 'count', String(items.length)));
    head.appendChild(el('span', 'ad-meta', `lu à ${adTime()}${state.adFake ? ' (MODE TEST)' : ''}`));
    const search = el('input', 'ad-search');
    search.type = 'search';
    search.placeholder = 'Rechercher…';
    search.value = adFilters[table] || '';
    search.setAttribute('aria-label', "Rechercher dans l'Active Directory");
    head.appendChild(search);
    if (!idx) {
      panel.appendChild(el('p', 'ad-note bad', `L'annuaire lu est celui du domaine ${A.dnToDomain(d.base)}, pas celui du projet (${str(state.project.domain.dns) || 'non renseigné'}) : il n'est pas utilisé pour la vérification.`));
    }
    const list = el('div', 'ad-list');
    panel.appendChild(list);
    const fill = () => {
      const q = norm(adFilters[table] || '');
      const shown = items.filter((it) => !q || norm(adCells(table, it).join(' ')).includes(q));
      list.textContent = '';
      if (!items.length) {
        list.appendChild(el('p', 'ad-note', table === 'ous' ? 'Aucune OU dans l\'annuaire.' : table === 'users' ? 'Aucun compte utilisateur.' : table === 'globals' ? 'Aucun groupe global.' : 'Aucun groupe domaine local.'));
        return;
      }
      if (!shown.length) {
        list.appendChild(el('p', 'ad-note', 'Aucun résultat.'));
        return;
      }
      const tbl = el('table', 'ad-table');
      const thead = el('thead');
      const trh = el('tr');
      for (const h of AD_HEADERS[table]) trh.appendChild(el('th', null, h));
      trh.appendChild(el('th', 'ad-act'));
      thead.appendChild(trh);
      tbl.appendChild(thead);
      const tbody = el('tbody');
      for (const it of shown.slice(0, 300)) {
        const tr = el('tr');
        for (const c of adCells(table, it)) {
          const td = el('td', null, c);
          td.title = c;
          tr.appendChild(td);
        }
        const act = el('td', 'ad-act');
        if (inTable.has(itemKey(table, it))) act.appendChild(el('span', 'ad-tag', 'dans le tableau'));
        else if (table !== 'users' && idx) {
          const add = el('button', 'link-btn', 'Ajouter au tableau');
          add.type = 'button';
          add.title = table === 'ous' ? "Reprend cette OU dans le tableau (elle ne sera pas recréée) : utile pour y ranger de nouveaux objets." : "Reprend ce groupe dans le tableau (il ne sera pas recréé) : ajoutez-lui des membres dans la colonne Membres.";
          add.addEventListener('click', () => addFromAd(table, it));
          act.appendChild(add);
        }
        tr.appendChild(act);
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      list.appendChild(tbl);
      if (shown.length > 300) list.appendChild(el('p', 'ad-note', `… et ${shown.length - 300} autres : affinez la recherche.`));
    };
    search.addEventListener('input', () => {
      adFilters[table] = search.value;
      fill();
    });
    fill();
  }

  const AD_HEADERS = {
    ous: ['OU', 'Description'],
    users: ['Identifiant', 'Nom affiché', 'Emplacement'],
    globals: ['Groupe global', 'Emplacement', 'Membres'],
    locals: ['Groupe domaine local', 'Emplacement', 'Membres'],
  };

  function adCells(table, it) {
    if (table === 'ous') return [it.path, it.description || ''];
    if (table === 'users') return [it.login, it.display || '', it.where || ''];
    return [it.name, it.where || '', (it.members || []).join(', ')];
  }

  /** Reprend une OU ou un groupe de l'annuaire dans le tableau (ligne « déjà existante », complétée ensuite). */
  function addFromAd(table, it) {
    const row = newRow(table);
    if (table === 'ous') {
      const segs = it.path.split('/');
      row.name = segs.pop();
      row.parent = segs.join('/');
      row.description = it.description || '';
    } else {
      row.name = it.name;
      row.ou = it.ou || '';
      row.description = it.description || '';
      row.members = (it.members || []).join(', ');
    }
    state.project[table].push(row);
    grids[table].render();
    changed();
    renderAdPanel(table);
    toast(`« ${table === 'ous' ? it.path : it.name} » ajouté au tableau : il existe déjà, il ne sera pas recréé${table === 'ous' ? '' : ' (seuls les nouveaux membres seront ajoutés)'}.`, 'ok');
  }

  /** Pastille « AD » sur les lignes du projet qui existent déjà dans l'annuaire. */
  function markRows() {
    const idx = adIndex();
    for (const t of AD_TABLES) {
      const marks = {};
      if (idx) {
        const map = t === 'ous' ? idx.ous : t === 'users' ? idx.users : idx.groups;
        for (const row of state.project[t] || []) {
          if (isBlankRow(t, row)) continue;
          const found = map.get(rowKey(t, row));
          if (found) marks[row.id] = `Existe déjà dans l'Active Directory (lu à ${adTime()}) : ${t === 'ous' ? 'l\'OU' : t === 'users' ? 'le compte' : 'le groupe'} ne sera pas recréé${t === 'globals' || t === 'locals' ? ', seuls les nouveaux membres seront ajoutés' : ''}.`;
        }
      }
      grids[t].setMarks(marks);
    }
  }

  // ------------------------------------------------------------------ domaine (barre du haut)

  function fillDomainInputs() {
    const d = state.project.domain || {};
    $('dom-dns').value = str(d.dns);
    $('dom-dn').value = str(d.dn);
    $('dom-netbios').value = str(d.netbios);
    state.dnAuto = !str(d.dn) || str(d.dn) === safeDn(d.dns);
    state.nbAuto = !str(d.netbios) || str(d.netbios) === guessNetbios(d.dns);
  }

  function wireDomain() {
    $('dom-dns').addEventListener('input', (e) => {
      const d = state.project.domain;
      d.dns = e.target.value.trim();
      if (state.dnAuto) {
        d.dn = safeDn(d.dns);
        $('dom-dn').value = d.dn;
      }
      if (state.nbAuto) {
        d.netbios = guessNetbios(d.dns);
        $('dom-netbios').value = d.netbios;
      }
      changed();
      renderEnv();
    });
    $('dom-dn').addEventListener('input', (e) => {
      const d = state.project.domain;
      d.dn = e.target.value.trim();
      state.dnAuto = !d.dn || d.dn === safeDn(d.dns);
      changed();
    });
    $('dom-netbios').addEventListener('input', (e) => {
      const d = state.project.domain;
      d.netbios = e.target.value.trim();
      state.nbAuto = !d.netbios || d.netbios === guessNetbios(d.dns);
      changed();
    });
    $('dom-dn-auto').addEventListener('click', (e) => {
      e.preventDefault();
      const d = state.project.domain;
      d.dn = safeDn(d.dns);
      $('dom-dn').value = d.dn;
      state.dnAuto = true;
      changed();
    });
    $('btn-detect').addEventListener('click', () => detectEnvironment(true));
  }

  // ------------------------------------------------------------------ modifications

  function changed() {
    setDirty(true);
    updateCounts(null);
    scheduleValidate();
    scheduleLists();
    scheduleDraft();
  }

  // ------------------------------------------------------------------ onglets

  function showTab(tab) {
    if (!TAB_ORDER.includes(tab)) return;
    state.tab = tab;
    for (const t of TAB_ORDER) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
      $(`view-${t}`).hidden = t !== tab;
    }
    if (tab === 'script') scheduleValidate.flush();
  }

  // ------------------------------------------------------------------ projet

  function loadProject(project, { filePath = null, name = '', dirty = false } = {}) {
    state.project = shapeProject(project);
    state.filePath = filePath;
    state.name = name || '';
    fillDomainInputs();
    fillOptionInputs();
    for (const t of TABLES) grids[t].render();
    resetRun();
    state.dirty = !dirty; // force la mise à jour (et l'envoi au processus principal)
    setDirty(dirty);
    refreshLists();
    validate();
    renderEnv();
    saveDraft();
  }

  function fillOptionInputs() {
    const o = state.project.options;
    for (const [id, [key, type]] of Object.entries(OPTION_INPUTS)) {
      if (type === 'check') $(id).checked = Boolean(o[key]);
      else $(id).value = str(o[key]);
    }
  }

  function wireOptions() {
    for (const [id, [key, type]] of Object.entries(OPTION_INPUTS)) {
      $(id).addEventListener(type === 'check' ? 'change' : 'input', (e) => {
        state.project.options[key] = type === 'check' ? e.target.checked : e.target.value;
        if (type === 'check') fillOptionInputs(); // cases liées à la même option (Dossiers / Permissions)
        changed();
      });
    }
    // Afficher / masquer le mot de passe par défaut
    $('opt-default-password-show').addEventListener('click', (e) => {
      const input = $('opt-default-password');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Masquer' : 'Afficher';
    });
    // Héritage de tous les dossiers d'un coup
    for (const [id, value, msg] of [
      ['btn-break-all', 'break', 'Héritage cassé sur'],
      ['btn-keep-all', 'keep', 'Héritage conservé sur'],
    ]) {
      $(id).addEventListener('click', () => {
        const n = grids.folders.setAll('inheritance', value);
        toast(n ? `${msg} ${plural(n, 'dossier', 'dossiers')}.` : 'Aucun changement.', n ? 'ok' : 'info');
      });
    }
    $('btn-break-perms').addEventListener('click', breakAllPermissionFolders);
  }

  // ------------------------------------------------------------------ héritage du dossier partagé (onglet Permissions)
  // Casser l'héritage d'un dossier partagé pour y mettre les DL : l'état est celui de la ligne du dossier dans l'onglet
  // Dossiers (ajoutée au besoin). Le script casse l'héritage AVANT de donner les droits aux DL.

  /** Ligne de l'onglet Dossiers pour un chemin (casse et barre finale ignorées), ou null. */
  function folderRowFor(path) {
    const key = A.pathKey(path);
    return (state.project.folders || []).find((r) => !isBlankRow('folders', r) && A.pathKey(r.path) === key) || null;
  }

  const validPath = (path) => Boolean(str(path).trim()) && !A.validateName('path', path);

  /** État du bouton « Casser l'héritage » d'une ligne de permission. */
  function inheritButton(row) {
    if (!validPath(row.path)) return { label: '✂ Casser l\'héritage', title: 'Saisissez d\'abord un chemin de dossier valide.', disabled: true, state: 'keep' };
    const folder = folderRowFor(row.path);
    const strip = state.project.options.stripUsers;
    if (folder && folder.inheritance === 'break') {
      return {
        label: '✂ Héritage cassé',
        state: 'break',
        pressed: true,
        title: `L'héritage de « ${A.cleanPath(row.path)} » sera cassé avant de donner les droits aux DL${strip ? ' ; « Utilisateurs » et « Utilisateurs authentifiés » seront retirés : seuls les administrateurs et les DL y auront accès' : ''}. Cliquez pour conserver l'héritage.`,
      };
    }
    return {
      label: '✂ Casser l\'héritage',
      state: 'keep',
      pressed: false,
      title: `Le dossier hérite des droits de son parent : tout le monde garde l'accès hérité. Cliquez pour casser l'héritage (icacls /inheritance:d${strip ? ', puis retrait d\'« Utilisateurs »' : ''}) avant de donner les droits aux DL.`,
    };
  }

  /** Casse (ou rétablit) l'héritage du dossier d'une permission. */
  function toggleInheritance(row) {
    if (!validPath(row.path)) return;
    const path = A.cleanPath(row.path);
    let folder = folderRowFor(path);
    const breaking = !folder || folder.inheritance !== 'break';
    if (!folder) {
      folder = { ...newRow('folders'), path, inheritance: 'break' };
      state.project.folders.push(folder);
    } else folder.inheritance = breaking ? 'break' : 'keep';
    grids.folders.render();
    grids.permissions.refreshActions();
    changed();
    toast(
      breaking
        ? `Héritage cassé sur « ${path} » : les DL de l'onglet Permissions y recevront leurs droits${state.project.options.stripUsers ? ', et seuls eux (et les administrateurs) y auront accès' : ''}. Voir aussi l'onglet Dossiers.`
        : `Héritage conservé sur « ${path} ».`,
      'ok'
    );
  }

  /** Casse l'héritage de tous les dossiers de l'onglet Permissions. */
  function breakAllPermissionFolders() {
    const seen = new Set();
    let n = 0;
    for (const r of state.project.permissions || []) {
      if (isBlankRow('permissions', r) || !validPath(r.path)) continue;
      const path = A.cleanPath(r.path);
      const key = A.pathKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const folder = folderRowFor(path);
      if (folder && folder.inheritance === 'break') continue;
      if (folder) folder.inheritance = 'break';
      else state.project.folders.push({ ...newRow('folders'), path, inheritance: 'break' });
      n += 1;
    }
    if (!seen.size) return toast('Aucun dossier valide dans le tableau des permissions.', 'info');
    if (!n) return toast('L\'héritage est déjà cassé sur tous ces dossiers.', 'info');
    grids.folders.render();
    grids.permissions.refreshActions();
    changed();
    toast(`Héritage cassé sur ${plural(n, 'dossier', 'dossiers')} : les DL y recevront leurs droits.`, 'ok');
  }

  /** Résumé sous les boutons : dossiers des permissions dont l'héritage sera cassé. */
  function renderInheritNote() {
    const note = $('perm-inherit-note');
    if (!note) return;
    const keys = new Set();
    let broken = 0;
    for (const r of state.project.permissions || []) {
      if (isBlankRow('permissions', r) || !validPath(r.path)) continue;
      const key = A.pathKey(r.path);
      if (keys.has(key)) continue;
      keys.add(key);
      const f = folderRowFor(r.path);
      if (f && f.inheritance === 'break') broken += 1;
    }
    note.textContent = keys.size ? `Héritage cassé : ${broken} / ${plural(keys.size, 'dossier', 'dossiers')}.` : '';
  }

  async function confirmDiscard() {
    if (!state.dirty) return true;
    const r = await ask({
      title: 'Modifications non enregistrées',
      message: `Enregistrer les modifications du projet « ${state.name || 'Sans titre'} » ?`,
      buttons: [
        { id: 'save', label: 'Enregistrer', primary: true },
        { id: 'discard', label: 'Ne pas enregistrer' },
        { id: 'cancel', label: 'Annuler' },
      ],
    });
    if (r === 'save') return Boolean((await saveProject(false)).ok);
    return r === 'discard';
  }

  async function newProject() {
    if (state.run.active) return toast('Une exécution est en cours.', 'error');
    if (!(await confirmDiscard())) return;
    loadProject(A.emptyProject(), {});
    showTab('ous');
    toast('Nouveau projet.', 'ok');
  }

  async function openProject() {
    if (!api) return;
    if (state.run.active) return toast('Une exécution est en cours.', 'error');
    if (!(await confirmDiscard())) return;
    const r = await api.openProject();
    if (!r || r.canceled) return;
    if (!r.ok) return toast(r.error || 'Ouverture impossible.', 'error');
    loadProject(r.project, { filePath: r.filePath, name: r.name, dirty: false });
    showTab('ous');
    toast(`Projet ouvert : ${r.name}`, 'ok');
  }

  async function saveProject(saveAs) {
    if (!api) return { ok: false };
    scheduleValidate.flush();
    const r = await api.saveProject({ project: effectiveProject(), filePath: state.filePath, name: state.name, saveAs: Boolean(saveAs) });
    if (!r || r.canceled) return { ok: false, canceled: true };
    if (!r.ok) {
      toast(r.error || 'Enregistrement impossible.', 'error');
      return r;
    }
    state.filePath = r.filePath;
    state.name = r.name;
    setDirty(false);
    saveDraft();
    validate(); // le titre du script reprend le nom du projet
    toastFile('Projet enregistré', r.filePath);
    return r;
  }

  // ------------------------------------------------------------------ CSV

  async function importCsv(table) {
    if (!api) return;
    const r = await api.importCsv(table);
    if (!r || r.canceled) return;
    if (!r.ok) return toast(r.error || 'Import impossible.', 'error');
    let rows;
    try {
      const matrix = A.parseCsv(r.text);
      rows = A.rowsFromTable(table, matrix);
      if (rows && !Array.isArray(rows) && Array.isArray(rows.rows)) rows = rows.rows;
      if (!Array.isArray(rows)) throw new Error('format non reconnu');
    } catch (err) {
      return toast(`CSV illisible (${r.fileName}) : ${err.message}`, 'error');
    }
    rows = rows.map((row) => {
      const base = newRow(table);
      const out = { ...base, ...row, id: row && row.id ? row.id : base.id };
      if (table === 'permissions') out.right = coerceRight(out.right);
      return out;
    });
    rows = rows.filter((row) => !isBlankRow(table, row));
    if (!rows.length) return toast(`Aucune ligne trouvée dans ${r.fileName}.`, 'error');
    const current = state.project[table].filter((row) => !isBlankRow(table, row));
    let mode = 'append';
    if (current.length) {
      mode = await ask({
        title: 'Importer un CSV',
        message: `${plural(rows.length, 'ligne lue', 'lignes lues')} dans ${r.fileName}.\nLe tableau « ${TABLE_LABELS[table]} » contient déjà ${plural(current.length, 'ligne', 'lignes')}.`,
        buttons: [
          { id: 'append', label: 'Ajouter à la suite', primary: true },
          { id: 'replace', label: 'Remplacer' },
          { id: 'cancel', label: 'Annuler' },
        ],
      });
      if (mode === 'cancel') return;
    }
    // Ids en double (même fichier importé deux fois) : nouveaux ids
    const ids = new Set(mode === 'replace' ? [] : current.map((x) => x.id));
    for (const row of rows) {
      if (ids.has(row.id)) row.id = A.newId();
      ids.add(row.id);
    }
    state.project[table] = mode === 'replace' ? rows : [...current, ...rows];
    grids[table].render();
    changed();
    toast(`${plural(rows.length, 'ligne importée', 'lignes importées')} depuis ${r.fileName}.`, 'ok');
  }

  async function exportCsv(table) {
    if (!api) return;
    const rows = effectiveProject()[table];
    if (!rows.length) return toast('Le tableau est vide.', 'error');
    let text;
    try {
      text = A.toCsv(rows, A.COLUMNS[table]);
    } catch (err) {
      return toast(`Export impossible : ${err.message}`, 'error');
    }
    const r = await api.exportCsv({ table, text, name: state.name || str(state.project.domain.dns) || 'agepede' });
    if (!r || r.canceled) return;
    if (!r.ok) return toast(r.error || 'Export impossible.', 'error');
    toastFile('CSV exporté', r.filePath);
  }

  // ------------------------------------------------------------------ aide « Créer les DL pour un GG »

  function createDlForGg() {
    const input = $('dl-helper-gg');
    const gg = input.value.trim();
    if (!gg) {
      input.focus();
      return toast('Indiquez le nom d\'un groupe global (par exemple GG_Compta).', 'error');
    }
    const pg = prefix('global', 'GG_');
    const pl = prefix('local', 'DL_');
    const base = gg.toUpperCase().startsWith(pg.toUpperCase()) ? gg.slice(pg.length) : gg;
    if (!base) return toast('Nom de groupe global incomplet.', 'error');
    const ggRow = state.project.globals.find((r) => str(r.name).trim().toLowerCase() === gg.toLowerCase());
    const ou = ggRow ? str(ggRow.ou) : '';
    const locals = state.project.locals;
    // La ligne vide éventuellement en cours de saisie reste en bas
    const created = [];
    const skipped = [];
    for (const [suffix, what] of [
      ['R', 'lecture'],
      ['RW', 'modification'],
    ]) {
      const name = `${pl}${base}_${suffix}`;
      if (locals.some((r) => str(r.name).trim().toLowerCase() === name.toLowerCase())) {
        skipped.push(name);
        continue;
      }
      locals.push({ ...newRow('locals'), name, ou, description: `Accès en ${what} — ${base}`, members: ggRow ? str(ggRow.name).trim() : gg });
      created.push(name);
    }
    grids.locals.render();
    if (created.length) changed();
    input.value = '';
    if (created.length) toast(`Créés : ${created.join(', ')}${skipped.length ? ` (déjà présents : ${skipped.join(', ')})` : ''}${ggRow ? '' : ` — attention : ${gg} n'est pas dans l'onglet Groupes globaux`}.`, ggRow ? 'ok' : 'info');
    else toast(`Déjà présents : ${skipped.join(', ')}.`, 'info');
  }

  // ------------------------------------------------------------------ exécution

  const STATUS = {
    pending: { label: 'En attente' },
    running: { label: 'En cours…' },
    ok: { label: '✓ Créé', member: '✓ Ajouté', acl: '✓ Appliqué', inherit: '✓ Cassé' },
    exists: { label: 'Déjà existant', member: 'Déjà membre', acl: 'Déjà appliqué' },
    todo: { label: 'À créer', member: 'À ajouter', acl: 'À appliquer', inherit: 'À appliquer' },
    error: { label: '✗ Erreur' },
    unknown: { label: '? Non vérifiable', acl: 'À appliquer', inherit: 'À appliquer' },
    skipped: { label: 'Ignoré : dépend d\'une étape en échec' },
    cancelled: { label: 'Annulé' },
    notrun: { label: 'Non exécuté' },
  };

  const statusKey = (s) => (STATUS[s] ? s : 'unknown');
  const statusLabel = (s, kind) => {
    const st = STATUS[statusKey(s)];
    return (kind && st[kind]) || st.label;
  };

  function resetRun() {
    state.run = { active: false, dryRun: false, steps: [], results: [], summary: null, error: null, startedAt: null, endedAt: null, fake: false, open: new Set() };
    renderLog();
    renderRunSummary();
    updateRunControls();
  }

  function runBlockers() {
    const reasons = [];
    const warns = [];
    const env = state.env;
    if (!api) reasons.push('Page ouverte hors de l\'application.');
    else if (state.detecting) reasons.push('Détection de l\'environnement en cours…');
    else if (!env) reasons.push('Environnement non détecté : cliquez sur « Détecter ».');
    else if (!env.fake) {
      const tools = env.tools || {};
      // Outils exigés selon les étapes (mêmes règles que le processus principal et le script .bat)
      const need = A.toolsNeeded(state.steps);
      if (!env.isWindows) reasons.push('Simulation et exécution ne sont possibles que sous Windows, sur un contrôleur de domaine ou un poste avec RSAT. Vous pouvez exporter le script .bat et le lancer là-bas.');
      else if (need.ds && (!tools.dsadd || !tools.dsmod || !tools.dsquery)) reasons.push('Outils Active Directory absents (dsadd, dsmod, dsquery) : installez RSAT « Outils AD DS » ou lancez Agépédé sur un contrôleur de domaine. Vous pouvez quand même exporter le script .bat.');
      else if (need.icacls && !tools.icacls) reasons.push('icacls introuvable : les permissions ne peuvent pas être appliquées depuis ce poste.');
    }
    if (state.issues.errors.length) reasons.push(`${plural(state.issues.errors.length, 'erreur à corriger', 'erreurs à corriger')} (voir « Vérification » ci-dessus).`);
    if (state.planError) reasons.push(`Le script ne peut pas être généré : ${state.planError}`);
    else if (!state.steps.length && !state.issues.errors.length) reasons.push('Rien à créer : remplissez au moins un tableau.');
    if (env && !env.fake && env.isWindows && !env.isAdmin) warns.push('Agépédé n\'est pas lancé en administrateur : certaines commandes (icacls, création de dossiers) peuvent échouer.');
    const dns = str(state.project.domain && state.project.domain.dns).trim();
    if (env && env.domain && env.domain.dns && dns && env.domain.dns.toLowerCase() !== dns.toLowerCase()) warns.push(`Ce poste appartient au domaine ${env.domain.dns}, le projet vise ${dns}.`);
    if (env && !env.fake && env.isWindows && env.tools && env.tools.dsadd && A.toolsNeeded(state.steps).ds && !(env.domain && env.domain.dns)) warns.push('Aucun domaine détecté pour ce poste : les commandes risquent d\'échouer.');
    if (env && env.fake) warns.push('MODE TEST (développement) : la simulation et l\'exécution sont fictives, aucune commande n\'est lancée.');
    return { reasons, warns };
  }

  function updateRunControls() {
    if (!state.project) return;
    const { reasons, warns } = runBlockers();
    const active = state.run.active;
    const blocked = reasons.length > 0;
    const sim = $('btn-simulate');
    const run = $('btn-run');
    sim.disabled = active || blocked;
    run.disabled = active || blocked;
    sim.title = blocked ? reasons[0] : 'Vérifie, sans rien créer, ce qui existe déjà dans l\'annuaire.';
    run.title = blocked ? reasons[0] : 'Crée les objets dans Active Directory (confirmation demandée).';
    $('btn-stop').hidden = !(active && state.run.startedAt && !state.run.endedAt);
    $('btn-export-log').disabled = active || !state.run.steps.length || !state.run.endedAt;

    const box = $('run-status');
    box.textContent = '';
    box.className = `run-status ${blocked ? 'bad' : warns.length ? 'warn' : 'ok'}`;
    if (blocked) {
      for (const r of reasons) box.appendChild(el('p', null, r));
    } else {
      const dns = str(state.project.domain.dns) || '?';
      box.appendChild(el('p', null, `Prêt : ${plural(state.steps.length, 'commande', 'commandes')} (${describeCounts(state.steps)}) sur le domaine ${dns}. Commencez par une simulation : elle indique ce qui existe déjà, sans rien modifier.`));
    }
    for (const w of warns) box.appendChild(el('p', null, `⚠ ${w}`));
  }

  function renderLog() {
    const tbody = $('run-log-body');
    tbody.textContent = '';
    const run = state.run;
    if (!run.steps.length) {
      const tr = el('tr', 'log-empty');
      const td = el('td', null, 'Le journal apparaîtra ici pendant la simulation ou l\'exécution. Cliquez sur une ligne pour voir la commande et sa sortie.');
      td.colSpan = 5;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    const frag = document.createDocumentFragment();
    run.steps.forEach((step, i) => {
      const tr = el('tr', 'log-row');
      tr.dataset.i = String(i);
      tr.appendChild(el('td', 'num', String(i + 1)));
      tr.appendChild(el('td', 'kind', KIND_LABELS[step.kind] || step.kind || ''));
      const label = el('td', 'label', step.label || step.command || '');
      label.title = step.command || '';
      tr.appendChild(label);
      tr.appendChild(el('td', 'st'));
      tr.appendChild(el('td', 'dur'));
      frag.appendChild(tr);
      const detail = el('tr', 'log-detail');
      detail.dataset.i = String(i);
      detail.hidden = true;
      const td = el('td');
      td.colSpan = 5;
      detail.appendChild(td);
      frag.appendChild(detail);
    });
    tbody.appendChild(frag);
    run.steps.forEach((_s, i) => updateLogRow(i));
  }

  function updateLogRow(i) {
    const run = state.run;
    const tbody = $('run-log-body');
    const tr = tbody.querySelector(`tr.log-row[data-i="${i}"]`);
    if (!tr) return;
    const res = run.results[i] || { status: 'pending' };
    const step = run.steps[i];
    const key = statusKey(res.status);
    tr.className = `log-row s-${key}`;
    tr.children[3].textContent = statusLabel(res.status, step.kind);
    tr.children[3].title = res.message || '';
    tr.children[4].textContent = Number.isFinite(res.durationMs) ? `${(res.durationMs / 1000).toFixed(res.durationMs < 10000 ? 1 : 0)} s` : '';
    const detail = tr.nextElementSibling;
    if (key === 'error' && !run.open.has(i)) run.open.add(i); // les erreurs sont dépliées d'office
    detail.hidden = !run.open.has(i);
    if (!detail.hidden) fillDetail(detail.firstChild, step, res);
  }

  function fillDetail(td, step, res) {
    td.textContent = '';
    td.appendChild(el('div', 'lbl', 'Commande'));
    td.appendChild(el('pre', null, step.command || ''));
    if (res.message) {
      td.appendChild(el('div', 'lbl', 'Résultat'));
      td.appendChild(el('pre', null, res.message));
    }
    if (res.output) {
      td.appendChild(el('div', 'lbl', 'Sortie'));
      td.appendChild(el('pre', null, res.output));
    }
  }

  function tally() {
    const c = { ok: 0, exists: 0, todo: 0, error: 0, unknown: 0, skipped: 0, cancelled: 0, notrun: 0, pending: 0, running: 0 };
    for (const r of state.run.results) c[statusKey(r.status)] += 1;
    return c;
  }

  function summaryText() {
    const run = state.run;
    if (run.error) return `Interrompu : ${run.error}`;
    const c = tally();
    const notRun = c.pending + c.running + c.cancelled + c.notrun;
    const stopped = Boolean(run.summary && run.summary.cancelled) || c.cancelled > 0;
    if (run.dryRun) {
      const parts = [`${c.todo} à faire`, `${c.exists} déjà existant${c.exists > 1 ? 's' : ''}`];
      if (c.unknown) parts.push(`${c.unknown} non vérifiable${c.unknown > 1 ? 's' : ''} à l'avance (icacls)`);
      if (c.error) parts.push(plural(c.error, 'erreur', 'erreurs'));
      if (notRun) parts.push(`${notRun} non vérifié${notRun > 1 ? 's' : ''}`);
      return `${stopped ? 'Simulation arrêtée' : 'Simulation terminée'} : ${parts.join(', ')}. Rien n'a été modifié.`;
    }
    const parts = [`${c.ok} créé${c.ok > 1 ? 's' : ''} ou appliqué${c.ok > 1 ? 's' : ''}`, `${c.exists} déjà existant${c.exists > 1 ? 's' : ''}`, plural(c.error, 'erreur', 'erreurs')];
    if (c.skipped) parts.push(`${c.skipped} ignoré${c.skipped > 1 ? 's' : ''} (étape préalable en échec)`);
    if (c.unknown) parts.push(`${c.unknown} indéterminé${c.unknown > 1 ? 's' : ''}`);
    if (notRun) parts.push(`${notRun} non exécuté${notRun > 1 ? 's' : ''}`);
    return `${stopped ? 'Exécution arrêtée' : 'Exécution terminée'} : ${parts.join(', ')}.`;
  }

  function renderRunSummary() {
    const run = state.run;
    const box = $('run-summary');
    const progress = $('run-progress');
    if (!run.steps.length) {
      box.hidden = true;
      progress.hidden = true;
      return;
    }
    const total = run.steps.length;
    const done = run.results.filter((r) => !['pending', 'running', 'notrun', 'cancelled'].includes(statusKey(r.status))).length;
    progress.hidden = false;
    $('run-progress-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    $('run-progress-text').textContent = `${run.dryRun ? 'Simulation' : 'Exécution'}${run.fake ? ' (MODE TEST)' : ''} : ${done} / ${total}`;
    if (!run.endedAt) {
      box.hidden = true;
      return;
    }
    const c = tally();
    box.hidden = false;
    const stopped = Boolean(run.summary && run.summary.cancelled) || c.cancelled > 0 || c.notrun > 0;
    box.className = `run-summary ${run.error || c.error ? 'bad' : stopped ? '' : 'ok'}`;
    box.textContent = summaryText();
  }

  function onRunProgress(msg) {
    if (!msg) return;
    const run = state.run;
    if (msg.type === 'start') {
      state.run = {
        active: true,
        dryRun: Boolean(msg.dryRun),
        fake: Boolean(msg.fake),
        steps: Array.isArray(msg.steps) ? msg.steps : [],
        results: (msg.steps || []).map(() => ({ status: 'pending' })),
        summary: null,
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        open: new Set(),
      };
      if (state.run.results.length) state.run.results[0].status = 'running';
      renderLog();
      renderRunSummary();
      updateRunControls();
    } else if (msg.type === 'step') {
      const i = msg.index;
      if (!Number.isInteger(i) || i < 0 || i >= run.steps.length) return;
      run.results[i] = { status: msg.status, message: msg.message, output: msg.output, durationMs: msg.durationMs };
      updateLogRow(i);
      if (i + 1 < run.steps.length && statusKey(run.results[i + 1].status) === 'pending') {
        run.results[i + 1].status = 'running';
        updateLogRow(i + 1);
      }
      const tr = $('run-log-body').querySelector(`tr.log-row[data-i="${i}"]`);
      if (tr && $('view-script').hidden === false) tr.scrollIntoView({ block: 'nearest' });
      renderRunSummary();
    } else if (msg.type === 'end') {
      run.endedAt = Date.now();
      run.summary = msg.summary || null;
      run.error = msg.error || null;
      run.results.forEach((r, i) => {
        if (['pending', 'running'].includes(statusKey(r.status))) {
          r.status = 'notrun';
          updateLogRow(i);
        }
      });
      renderRunSummary();
      updateRunControls();
    }
  }

  async function startRun(dryRun) {
    if (!api || state.run.active) return;
    scheduleValidate.flush();
    const { reasons } = runBlockers();
    if (reasons.length) return toast(reasons[0], 'error');
    state.run.active = true;
    updateRunControls();
    let res;
    try {
      res = await api.startRun({ project: effectiveProject(), dryRun: Boolean(dryRun) });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    // Les derniers messages de progression peuvent arriver juste après la réponse : on les attend un peu
    if (res && res.ok) {
      const started = Date.now();
      while (!state.run.endedAt && Date.now() - started < 1500) await new Promise((r) => setTimeout(r, 30));
    }
    state.run.active = false;
    if (res && res.ok && !state.run.endedAt) {
      // Message de fin non reçu : on termine l'affichage avec le résumé renvoyé
      onRunProgress({ type: 'end', summary: res.summary });
    }
    updateRunControls();
    if (!res || res.canceled) return;
    if (!res.ok) return toast(res.error || 'Échec du lancement.', 'error');
    const c = tally();
    toast(summaryText(), c.error ? 'error' : 'ok');
    // Après une vraie exécution, l'annuaire a changé : il est relu (pastilles « AD » et listes à jour)
    if (!dryRun) readDirectory(false);
  }

  function buildLogText() {
    const run = state.run;
    const d = state.project.domain || {};
    const rule = '='.repeat(72);
    const lines = [
      `Agépédé — journal ${run.dryRun ? 'de simulation' : 'd\'exécution'}${run.fake ? ' (MODE TEST, résultats fictifs)' : ''}`,
      `Date : ${new Date(run.startedAt || Date.now()).toLocaleString('fr-FR')}`,
      `Domaine : ${str(d.dns) || '?'}${d.dn ? ` (${d.dn})` : ''}`,
      `Projet : ${state.name || 'Sans titre'}${state.filePath ? ` — ${state.filePath}` : ''}`,
      state.env ? `Poste : ${state.env.isServer ? 'Windows Server' : state.env.isWindows ? 'Windows' : state.env.platform || '?'}, administrateur : ${state.env.isAdmin ? 'oui' : 'non'}` : '',
      rule,
      '',
    ].filter((l) => l !== null);
    const width = String(run.steps.length).length;
    run.steps.forEach((step, i) => {
      const r = run.results[i] || {};
      lines.push(`${String(i + 1).padStart(width, '0')}  [${statusLabel(r.status, step.kind).replace(/^[✓✗?]\s*/, '').toUpperCase()}]  ${step.label || ''}`);
      lines.push(`      > ${step.command || ''}`);
      if (r.message) lines.push(`      ${r.message}`);
      if (r.output) for (const l of String(r.output).split(/\r?\n/)) if (l.trim()) lines.push(`        ${l}`);
    });
    lines.push('', rule, summaryText(), '');
    // Journal partageable : mots de passe masqués (-pwd "****"), le script .bat les garde
    return A.maskPasswords(lines.join('\r\n'));
  }

  async function exportLog() {
    if (!api || !state.run.steps.length) return;
    const r = await api.exportLog({ text: buildLogText() });
    if (!r || r.canceled) return;
    if (!r.ok) return toast(r.error || 'Export impossible.', 'error');
    toastFile('Journal exporté', r.filePath);
  }

  // ------------------------------------------------------------------ script : copier, exporter

  async function copyScript() {
    if (!api || !state.script) return;
    await api.copy(state.script);
    toast('Script copié dans le presse-papiers.', 'ok');
  }

  async function exportBat() {
    if (!api) return;
    scheduleValidate.flush();
    const eff = effectiveProject();
    const r = await api.exportScript({ project: eff, name: state.name || str(eff.domain.dns) || 'agepede', options: { title: scriptOptions(eff).title, date: state.scriptDate } });
    if (!r || r.canceled) return;
    if (!r.ok) return toast(r.error || 'Export impossible.', 'error');
    toastFile('Script exporté', r.filePath);
  }

  // ------------------------------------------------------------------ aide

  /** Guide illustré (js/guide.js) ; section facultative : 'start', 'domain', 'tables', 'run', 'agdlp', 'tips'. */
  function openHelp(section) {
    const G = window.AgepedeGuide;
    if (!G || (G.isTourActive && G.isTourActive())) return;
    G.openGuide(typeof section === 'string' ? section : undefined);
  }

  /** Projet d'exemple du guide : remplace le projet en cours (après confirmation s'il est modifié). */
  async function loadExample(example) {
    if (state.run.active) return toast('Une exécution est en cours.', 'error');
    if (!(await confirmDiscard())) return;
    loadProject(example, { name: 'Exemple', dirty: false });
    showTab('ous');
    toast('Projet d\'exemple chargé : parcourez les onglets, puis « Script & exécution ».', 'ok');
  }

  function initGuide() {
    const G = window.AgepedeGuide;
    if (!G) return;
    G.init({ showTab, getTab: () => state.tab, loadExample, toast });
  }

  // ------------------------------------------------------------------ mise en place

  function buildGrids() {
    for (const t of TABLES) {
      grids[t] = new window.Grid({
        table: t,
        el: $(`grid-${t}`),
        columns: COLUMNS[t],
        getRows: () => state.project[t],
        newRow: () => newRow(t),
        onChange: () => changed(),
        onPasted: (n) => toast(`${plural(n, 'ligne collée', 'lignes collées')}.`, 'ok'),
        onDelete: (row, index) =>
          toast(`Ligne supprimée${str(row.name || row.login || row.path).trim() ? ` : ${str(row.name || row.login || row.path).trim()}` : ''}.`, 'info', {
            label: 'Annuler',
            run: () => {
              const rows = state.project[t];
              rows.splice(Math.min(index, rows.length), 0, row);
              grids[t].render();
              changed();
            },
          }),
        // Membres proposés : ceux du tableau et ceux déjà dans l'Active Directory (annuaire lu)
        multiOptions: (col) => (col.key !== 'members' ? [] : t === 'locals' ? withAd(names('globals'), adNames('globals')) : t === 'globals' ? withAd(names('users', 'login'), adNames('users')) : []),
      });
    }
  }

  function wire() {
    $('btn-new').addEventListener('click', newProject);
    $('btn-open').addEventListener('click', openProject);
    $('btn-save').addEventListener('click', () => saveProject(false));
    $('btn-save-as').addEventListener('click', () => saveProject(true));
    $('btn-help').addEventListener('click', () => openHelp());
    initGuide();

    for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const t = b.dataset.table;
      if (b.dataset.action === 'add-row') grids[t].addRow();
      else if (b.dataset.action === 'import-csv') importCsv(t);
      else if (b.dataset.action === 'export-csv') exportCsv(t);
    });

    wireOptions();

    $('dl-helper-btn').addEventListener('click', createDlForGg);
    $('dl-helper-gg').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createDlForGg();
      }
    });

    $('issues').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-table]');
      if (li) goToIssue(li);
    });

    $('btn-copy').addEventListener('click', copyScript);
    $('btn-export-bat').addEventListener('click', exportBat);
    $('btn-simulate').addEventListener('click', () => startRun(true));
    $('btn-run').addEventListener('click', () => startRun(false));
    $('btn-stop').addEventListener('click', () => {
      if (api) api.cancelRun();
      $('btn-stop').disabled = true;
      setTimeout(() => {
        $('btn-stop').disabled = false;
      }, 1500);
    });
    $('btn-export-log').addEventListener('click', exportLog);

    $('run-log-body').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.log-row');
      if (!tr) return;
      const i = Number(tr.dataset.i);
      if (state.run.open.has(i)) state.run.open.delete(i);
      else state.run.open.add(i);
      const detail = tr.nextElementSibling;
      detail.hidden = !state.run.open.has(i);
      if (!detail.hidden) fillDetail(detail.firstChild, state.run.steps[i], state.run.results[i] || {});
    });

    $('btn-refresh-ad').addEventListener('click', () => readDirectory(true));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'F1') {
        e.preventDefault();
        openHelp();
        return;
      }
      if (e.key === 'F5' && !modalOpen()) {
        e.preventDefault(); // F5 relit l'annuaire (jamais de rechargement de la page)
        readDirectory(true);
        return;
      }
      if (!e.ctrlKey || e.altKey || modalOpen()) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        saveProject(e.shiftKey);
      } else if (k === 'o') {
        e.preventDefault();
        openProject();
      } else if (k === 'n') {
        e.preventDefault();
        newProject();
      } else if (/^[1-7]$/.test(e.key)) {
        e.preventDefault();
        showTab(TAB_ORDER[Number(e.key) - 1]);
      }
    });

    if (api) {
      api.onRunProgress(onRunProgress);
      api.onSaveThenClose(async () => {
        const r = await saveProject(false);
        if (r && r.ok) {
          state.closing = true;
          api.closeNow();
        }
      });
      api.onDiscardDraft(() => {
        state.closing = true;
        clearDraft();
      });
    }
  }

  async function init() {
    try {
      if (!A || !window.Grid) {
        document.body.textContent = 'Agépédé : moteur AGDLP introuvable (lib/agdlp.js). Réinstallez l\'application.';
        return;
      }
      wire();
      wireDomain();
      state.project = shapeProject(A.emptyProject());
      buildGrids();
      // Relance en administrateur : le projet transmis par l'instance précédente passe avant le brouillon
      let startup = null;
      if (api && api.takeStartup) {
        try {
          startup = await api.takeStartup();
          const pref = await api.getAlwaysAdmin();
          state.alwaysAdmin = Boolean(pref && pref.value);
        } catch {
          startup = null;
        }
      }
      const draft = startup && startup.handoff ? null : loadDraft();
      if (startup && startup.handoff) {
        const h = startup.handoff;
        loadProject(h.project, { filePath: h.filePath || null, name: h.name || '', dirty: Boolean(h.dirty) });
        toast('Agépédé relancé en administrateur : projet repris.', 'ok');
      } else if (draft) {
        try {
          loadProject(draft.project, { filePath: draft.filePath || null, name: draft.name || '', dirty: Boolean(draft.dirty) });
          if (draft.dirty) toast(`Brouillon restauré (modifications non enregistrées du ${new Date(draft.at || Date.now()).toLocaleString('fr-FR')}).`, 'info');
          // Les mots de passe ne sont jamais écrits dans le brouillon : à ressaisir (ou rouvrir le fichier du projet)
          if (draft.passwordsRemoved) toast('Mots de passe non conservés dans le brouillon : ressaisissez-les ou rouvrez le fichier du projet avant d\'enregistrer.', 'info');
        } catch {
          loadProject(A.emptyProject(), {});
        }
      } else {
        loadProject(A.emptyProject(), {});
      }
      if (startup && startup.note) toast(startup.note.text, startup.note.kind === 'error' ? 'error' : 'info');
      showTab('ous');
      renderAdState();
      if (api) {
        api
          .info()
          .then((info) => {
            state.info = info;
            $('help-version').textContent = `Agépédé ${info.version}${info.fakeRun ? ' — MODE TEST (exécution simulée)' : ''}`;
          })
          .catch(() => {});
      }
      // Premier lancement : visite guidée, une fois la fenêtre affichée (après l'écran de démarrage)
      if (!(startup && startup.handoff)) whenVisible(() => window.AgepedeGuide && window.AgepedeGuide.maybeStartTour());
    } finally {
      if (api) api.uiReady();
    }
    detectEnvironment(false);
  }

  function whenVisible(fn) {
    const go = () => setTimeout(fn, 450);
    if (document.visibilityState === 'visible') return go();
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVis);
      go();
    };
    document.addEventListener('visibilitychange', onVis);
  }

  init();
})();
