/*
 * app.js — Interface du HUB : sélecteur 3D des applications, détails et actions.
 *
 * Sélecteur : clic sur une carte, glisser, molette, flèches ← →, Début / Fin, touches 1–9 ;
 * Entrée ou double-clic lance l'application choisie. La carte active s'incline sous la souris
 * et sa couleur teinte la nébuleuse et les étoiles du fond (stars.js).
 * Le DOM est construit sans innerHTML.
 */
'use strict';

(() => {
  const hub = window.hub;
  const $ = (id) => document.getElementById(id);
  const track = $('track');
  const STORE_KEY = 'hub.selected';
  /** V3Redis Light : liste plate, pas d'inclinaison 3D, lancement direct sans animation. */
  const LIGHT = hub.mode === 'light';

  const state = {
    apps: [],
    index: 0,
    cards: [],
    busy: false,
    op: null, // installation depuis le HUB en cours : { id, phase, received, total }
  };

  const SOURCES = {
    registre: 'Détecté dans les applications installées',
    défaut: 'Dossier d\'installation par défaut',
    recherche: 'Trouvé dans vos dossiers',
    manuel: 'Emplacement choisi à la main',
    build: 'Version compilée dans le dossier du projet (non installée)',
    hub: 'Livré avec V3Redis',
  };

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function svg(paths, fill) {
    const ns = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(ns, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('aria-hidden', 'true');
    if (fill) el.classList.add('filled'); // icône pleine (▶ Lancer) ; les autres sont tracées
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      if (fill) p.setAttribute('fill', 'currentColor');
      el.append(p);
    }
    return el;
  }

  const ICONS = {
    play: ['M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z'],
    download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 17v3h16v-3'],
    install: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
    folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    reset: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  };

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
  }

  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : '139, 109, 255';
  };

  const storage = {
    get() {
      try {
        return localStorage.getItem(STORE_KEY);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        localStorage.setItem(STORE_KEY, value);
      } catch {
        // sans conséquence
      }
    },
  };

  /** État affiché d'une application : { text, level } pour la pastille. */
  function statusOf(a) {
    const v = a.version ? ` · v${a.version}` : '';
    if (a.status === 'soon') return { text: 'Bientôt disponible', level: '' };
    if (a.installed && a.source === 'build') return { text: `Prêt à lancer${v}`, level: 'ready' };
    if (a.installed) return { text: `Installé${v}`, level: 'ok' };
    return { text: 'Non installé', level: 'missing' };
  }

  // ---------------------------------------------------------------------------
  // Info-bulles (attribut data-tip)
  // ---------------------------------------------------------------------------

  function initTooltip() {
    const tip = $('tooltip');
    let current = null;
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tip]');
      if (target === current) return;
      current = target;
      if (!target) {
        tip.hidden = true;
        return;
      }
      tip.textContent = target.dataset.tip;
      tip.hidden = false;
      const r = target.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
      const top = r.bottom + 8 + t.height > window.innerHeight ? r.top - t.height - 8 : r.bottom + 8;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    });
  }

  // ---------------------------------------------------------------------------
  // Sélecteur
  // ---------------------------------------------------------------------------

  function buildCards() {
    state.cards = state.apps.map((a, i) => {
      const st = statusOf(a);
      const face = h(
        'div',
        { class: 'card-face' },
        h('span', { class: 'card-check', 'aria-hidden': 'true' }, svg(['M5 12.5l4.5 4.5L19 7.5'])),
        a.icon ? h('img', { class: 'card-icon', src: `assets/apps/${a.icon}`, alt: '', draggable: 'false' }) : h('div', { class: 'card-icon' }),
        h('div', { class: 'card-name' }, a.name),
        h('div', { class: 'card-tagline' }, a.tagline),
        h('span', { class: `pill ${st.level}` }, st.text)
      );
      const card = h(
        'button',
        { class: `card${a.status === 'soon' ? ' soon' : ''}`, type: 'button', role: 'option', id: `card-${a.id}`, 'aria-label': `${a.name} — ${st.text}` },
        face
      );
      card.style.setProperty('--card-rgb', hexToRgb(a.accent));
      // Clic : choisir ; double-clic : lancer
      card.addEventListener('click', () => select(i));
      card.addEventListener('dblclick', () => {
        select(i);
        launchSelected();
      });
      if (LIGHT) return card;
      // Inclinaison qui suit la souris (toutes les boîtes)
      card.addEventListener('pointermove', (e) => {
        const r = face.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        face.style.transform = `rotateX(${(0.5 - py) * 8}deg) rotateY(${(px - 0.5) * 12}deg)`;
      });
      card.addEventListener('pointerleave', () => {
        face.style.transform = '';
      });
      return card;
    });
    track.replaceChildren(...state.cards);
    if (!state.cards.length) track.append(h('div', { class: 'empty-state' }, 'Aucune application dans le catalogue.'));
  }

  function select(i, { quiet = false } = {}) {
    if (!state.apps.length) return;
    const index = Math.max(0, Math.min(state.apps.length - 1, i));
    const changed = index !== state.index;
    state.index = index;
    const a = state.apps[index];
    state.cards.forEach((card, j) => {
      card.classList.toggle('active', j === index);
      card.setAttribute('aria-selected', String(j === index));
    });

    // Couleur de l'application : interface, nébuleuse, étoiles
    document.documentElement.style.setProperty('--accent', a.accent);
    document.documentElement.style.setProperty('--accent-rgb', hexToRgb(a.accent));
    if (window.Starfield) window.Starfield.setAccent(a.accent);

    renderDetails(a, changed && !quiet && !LIGHT);
    storage.set(a.id);
  }

  // ---------------------------------------------------------------------------
  // Détails et actions
  // ---------------------------------------------------------------------------

  function actionButton(label, icon, cls, onClick, tip) {
    const b = h('button', { class: `btn ${cls || ''}`.trim(), type: 'button', 'data-tip': tip || null }, icon ? svg(ICONS[icon], icon === 'play') : null, label);
    b.addEventListener('click', () => run(b, onClick));
    return b;
  }

  async function run(button, action) {
    if (button) button.disabled = true;
    try {
      await action();
    } catch (err) {
      toast(`Erreur : ${err && err.message ? err.message : err}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderDetails(a, animate) {
    const st = statusOf(a);
    $('d-name').textContent = a.name;
    const pill = $('d-status');
    pill.className = `pill ${st.level}`;
    pill.textContent = st.text;
    $('d-desc').textContent = a.description;
    $('d-desc').title = a.description; // texte complet si la ligne est coupée (fenêtre étroite)
    $('d-features').replaceChildren(...a.features.map((f) => h('li', null, f)));
    $('d-path').textContent = a.installed && a.path
      ? `${SOURCES[a.source] || a.source} — ${a.path}`
      : a.status === 'soon'
        ? 'Cette application arrive bientôt dans V3Redis.'
        : a.canAdd
          ? 'Pas installée : « Installer » l\'ajoute à V3Redis (téléchargement depuis GitHub).'
          : 'Introuvable sur cet ordinateur.';
    $('d-path').dataset.tip = a.installed && a.path ? a.path : '';
    if (!$('d-path').dataset.tip) delete $('d-path').dataset.tip;

    // Installation depuis le HUB en cours : progression à la place des boutons
    if (state.op && state.op.id === a.id) {
      $('d-actions').replaceChildren(progressBlock());
      updateProgress();
      return;
    }

    const actions = [];
    if (a.status === 'soon') {
      actions.push(h('button', { class: 'btn launch', type: 'button', disabled: true }, 'Bientôt disponible'));
    } else if (a.installed) {
      actions.push(actionButton(`Lancer ${a.name}`, 'play', 'launch', launchSelected));
    } else if (a.canAdd) {
      actions.push(actionButton(`Installer ${a.name}`, 'install', 'launch', () => addApp(a), 'Télécharge l\'application depuis la release GitHub de cette version de V3Redis'));
    } else if (a.canInstall) {
      actions.push(actionButton(`Installer ${a.name}`, 'install', 'launch', () => installApp(a), a.installerName));
    } else if (a.canDownload) {
      actions.push(actionButton('Télécharger', 'download', 'launch', () => hub.download(a.id)));
    } else {
      actions.push(h('button', { class: 'btn launch', type: 'button', disabled: true }, 'Introuvable'));
    }

    const secondary = [];
    if (a.status === 'available') {
      if (a.installed && a.canInstall) secondary.push(actionButton('Installer', 'install', 'ghost', () => installApp(a), a.installerName));
      if (!a.installed && a.canDownload && a.canInstall) secondary.push(actionButton('Télécharger', 'download', 'ghost', () => hub.download(a.id)));
      secondary.push(
        actionButton(a.installed ? 'Emplacement…' : 'Déjà installé ? Choisir…', 'folder', 'ghost', async () => {
          const res = await hub.choose(a.id);
          if (res && res.ok) await refresh();
        }, 'Indiquer l\'exécutable de l\'application à la main')
      );
      if (a.canRemove) secondary.push(actionButton('Désinstaller', 'trash', 'ghost', () => removeApp(a), `Retirer ${a.name} de V3Redis (réinstallable à tout moment)`));
      if (a.source === 'manuel') {
        secondary.push(
          actionButton('Détection auto', 'reset', 'ghost', async () => {
            await hub.forget(a.id);
            await refresh();
          }, 'Oublier l\'emplacement choisi à la main')
        );
      }
    }
    // La ligne secondaire est toujours présente (vide si besoin) : le bouton principal et la hauteur du
    // panneau ne bougent pas d'une application à l'autre
    $('d-actions').replaceChildren(...actions, h('div', { class: 'secondary-actions', 'aria-hidden': secondary.length ? null : 'true' }, secondary));

    if (animate) {
      const details = $('details');
      details.classList.remove('swap');
      void details.offsetWidth; // relance l'animation
      details.classList.add('swap');
    }
  }

  // ---------------------------------------------------------------------------
  // Lancement : l'animation se joue EN ENTIER d'abord (interface qui se retire, icône au centre, anneaux,
  // particules, saut en hyperespace, barre qui se remplit) ; l'application n'est démarrée qu'à la fin,
  // puis V3Redis s'efface et se ferme quand la fenêtre de l'application est affichée.
  // ---------------------------------------------------------------------------

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ANIMATION_MS = 2200; // durée de l'animation avant le démarrage de l'application

  /** L'icône part de sa boîte et rejoint le centre de la scène. */
  function flyIcon(a) {
    const target = $('ls-icon');
    target.src = `assets/apps/${a.icon}`;
    const from = state.cards[state.index].querySelector('.card-icon').getBoundingClientRect();
    const to = target.getBoundingClientRect();
    if (!from.width || !to.width || reducedMotion.matches) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    target.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` },
        { transform: 'translate(0, 0) scale(1.08)', offset: 0.75 },
        { transform: 'translate(0, 0) scale(1)' },
      ],
      { duration: 850, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
  }

  function setStage(name, status) {
    $('ls-name').textContent = name;
    $('ls-status').textContent = status;
  }

  async function launchSelected() {
    const a = state.apps[state.index];
    if (!a || state.busy) return;
    if (!a.installed || a.status !== 'available') {
      toast(a.status === 'soon' ? `${a.name} arrive bientôt.` : `${a.name} n'est pas installé.`);
      return;
    }
    state.busy = true;
    if (LIGHT) return launchLight(a);
    const stage = $('launch-stage');
    $('tooltip').hidden = true;
    $('toast').classList.remove('show'); // un ancien message ne doit pas recouvrir la scène

    // 1) Animation : scène affichée, interface qui se retire, saut maintenu, barre qui se remplit
    stage.classList.remove('shown', 'failed', 'filling');
    stage.hidden = false;
    setStage(a.name, `Préparation de ${a.name}…`);
    if (window.Starfield) {
      window.Starfield.warp();
      window.Starfield.hold(1);
    }
    flyIcon(a);
    void stage.offsetWidth; // la scène part bien de l'opacité 0
    document.body.classList.add('launching');
    stage.classList.add('filling');
    await sleep(ANIMATION_MS);

    // 2) Fin de l'animation : éclair, et seulement maintenant l'application est démarrée
    setStage(a.name, `Lancement de ${a.name}…`);
    stage.classList.add('shown');
    const res = await hub.launch(a.id).catch((err) => ({ ok: false, error: err && err.message }));
    if (!res || !res.ok) {
      await failLaunch(res && res.error);
      return;
    }
    await sleep(600);

    // 3) Sortie : la scène s'éloigne, V3Redis s'efface puis se ferme dès que l'application est affichée
    document.body.classList.add('launch-exit');
    const back = await hub.retreat(res.launchId);
    // Rouvert pendant qu'il terminait, caché, le téléchargement d'une mise à jour : l'interface revient
    if (back && back.revived) resetLaunch();
  }

  /** V3Redis Light : lancement immédiat, sans scène ; la fenêtre disparaît dès que l'application démarre. */
  async function launchLight(a) {
    toast(`Lancement de ${a.name}…`);
    const res = await hub.launch(a.id).catch((err) => ({ ok: false, error: err && err.message }));
    if (!res || !res.ok) {
      toast((res && res.error) || 'Lancement impossible.');
      state.busy = false;
      return;
    }
    const back = await hub.retreat(res.launchId);
    if (back && back.revived) state.busy = false;
  }

  /** Échec : la scène tremble, affiche l'erreur, puis l'interface revient. */
  async function failLaunch(message) {
    const stage = $('launch-stage');
    stage.classList.remove('shown');
    stage.classList.add('failed');
    setStage($('ls-name').textContent, message || 'Lancement impossible.');
    if (window.Starfield) window.Starfield.hold(0);
    await sleep(1800);
    resetLaunch();
    toast(message || 'Lancement impossible.');
  }

  /** Remet l'interface dans son état normal (après un échec de lancement). */
  function resetLaunch() {
    if (window.Starfield) window.Starfield.hold(0);
    document.body.classList.remove('launch-exit');
    document.body.classList.remove('launching');
    const stage = $('launch-stage');
    setTimeout(() => {
      if (!document.body.classList.contains('launching')) {
        stage.hidden = true;
        stage.classList.remove('shown', 'failed', 'filling');
      }
    }, 500);
    state.busy = false;
  }


  // ---------------------------------------------------------------------------
  // Applications du paquet : installer (téléchargement) / désinstaller depuis le HUB
  // ---------------------------------------------------------------------------

  // L'installation tourne en arrière-plan : on peut parcourir le HUB, lancer une autre application ou fermer la
  // fenêtre (V3Redis termine alors l'installation caché). Avancement sur la boîte de l'application et dans ses
  // détails ; à la fin, la détection est refaite toute seule : l'application est prête à lancer.

  const mo = (b) => Math.round((b || 0) / 1048576);

  /** Texte d'avancement : « Téléchargement : 54 / 132 Mo », « Extraction des fichiers »… */
  function phaseText(op) {
    switch (op.phase) {
      case 'download':
        return op.total ? `Téléchargement : ${mo(op.received)} / ${mo(op.total)} Mo` : 'Téléchargement…';
      case 'extract':
        return op.unpacked ? `Extraction des fichiers : ${mo(op.extracted)} / ${mo(op.unpacked)} Mo` : 'Extraction des fichiers…';
      case 'finish':
        return 'Finalisation…';
      case 'done':
        return 'Installé';
      default:
        return 'Préparation…';
    }
  }

  function progressBlock() {
    const cancel = h('button', { class: 'btn ghost', type: 'button', id: 'op-cancel' }, 'Annuler');
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      hub.cancelAddApp();
    });
    return h(
      'div',
      { class: 'op-progress', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'op-head' }, h('span', { class: 'op-title' }, 'Installation'), h('strong', { class: 'op-pct', id: 'op-pct' })),
      h('div', { class: 'op-bar' }, h('span', { id: 'op-bar' })),
      h('div', { class: 'op-text', id: 'op-text' }),
      cancel
    );
  }

  /** Met à jour les deux barres (boîte de l'application, panneau de détails) sans reconstruire l'interface. */
  function updateProgress() {
    const op = state.op;
    if (!op) return;
    const pct = Math.max(0, Math.min(100, op.percent || 0));
    const card = $(`card-${op.id}`);
    if (card) {
      card.classList.add('installing');
      const pill = card.querySelector('.pill');
      if (pill) {
        pill.className = 'pill installing';
        pill.textContent = `Installation ${pct} %`;
      }
      let bar = card.querySelector('.card-progress span');
      if (!bar) {
        card.querySelector('.card-face').append(h('div', { class: 'card-progress', 'aria-hidden': 'true' }, h('span')));
        bar = card.querySelector('.card-progress span');
      }
      bar.style.width = `${pct}%`;
    }
    if (!$('op-text')) return;
    const pill = $('d-status');
    pill.className = 'pill installing';
    pill.textContent = 'Installation…';
    $('op-pct').textContent = `${pct} %`;
    $('op-text').textContent = phaseText(op);
    $('op-bar').style.width = `${pct}%`;
    $('op-bar').parentElement.classList.toggle('indeterminate', op.phase === 'prepare');
    const cancel = $('op-cancel');
    if (cancel) cancel.hidden = !['prepare', 'download'].includes(op.phase); // extraction : on va jusqu'au bout
  }

  /** Fin de l'installation : nouvelle détection (l'application apparaît prête à lancer), message. */
  async function finishInstall(name, res) {
    state.op = null;
    if (res && res.ok) toast(`${name} est installé : prêt à lancer.`);
    else if (res && res.cancelled) toast('Installation annulée.');
    else toast((res && res.error) || 'Installation impossible.');
    await refresh();
  }

  async function addApp(a) {
    if (state.op) return toast('Une installation est déjà en cours : attendez qu\'elle se termine.');
    state.op = { id: a.id, name: a.name, phase: 'prepare', percent: 0, owned: true };
    renderDetails(a, false);
    updateProgress();
    toast(`Installation de ${a.name} en arrière-plan : vous pouvez continuer à utiliser V3Redis.`);
    const res = await hub.addApp(a.id).catch((err) => ({ ok: false, error: err && err.message }));
    await finishInstall(a.name, res);
  }

  async function removeApp(a) {
    const res = await hub.removeApp(a.id);
    if (res && res.canceled) return;
    toast(res && res.ok ? `${a.name} est désinstallé.` : (res && res.error) || 'Désinstallation impossible.');
    await refresh();
  }

  function initAppProgress() {
    if (!hub.onAppProgress) return;
    hub.onAppProgress((p) => {
      if (!state.op || p.id !== state.op.id) return;
      Object.assign(state.op, p);
      updateProgress();
      // Installation lancée par une autre fenêtre (avant un passage en mode Light, par exemple) : personne
      // n'attend sa réponse ici, la fin est repérée par l'avancement
      if (!state.op.owned && ['done', 'error', 'cancelled'].includes(p.phase)) {
        finishInstall(state.op.name || p.id, { ok: p.phase === 'done', cancelled: p.phase === 'cancelled', error: p.phase === 'error' ? 'Installation impossible.' : null });
      }
    });
  }

  async function installApp(a) {
    const res = await hub.install(a.id);
    toast(res && res.ok ? `Installation de ${a.name} lancée : suivez l'assistant, V3Redis se mettra à jour ensuite.` : (res && res.error) || 'Installation impossible.');
  }

  // ---------------------------------------------------------------------------
  // Chargement / actualisation
  // ---------------------------------------------------------------------------

  async function refresh() {
    const apps = await hub.listApps();
    if (!Array.isArray(apps)) {
      toast(`Erreur : ${(apps && apps.error) || 'catalogue illisible'}`);
      return;
    }
    const currentId = state.apps[state.index] ? state.apps[state.index].id : storage.get();
    state.apps = apps;
    // Installation en cours lancée par une fenêtre précédente : on reprend son avancement
    const running = apps.find((a) => a.installing);
    if (running && !state.op) state.op = { ...running.installing, id: running.id, name: running.name, owned: false };
    buildCards();
    const ready = apps.filter((a) => a.installed).length;
    $('app-count').textContent = `${apps.length} application${apps.length > 1 ? 's' : ''} · ${ready} prête${ready > 1 ? 's' : ''} à lancer`;
    select(Math.max(0, apps.findIndex((a) => a.id === currentId)), { quiet: true });
    updateProgress(); // les boîtes viennent d'être reconstruites
  }

  // ---------------------------------------------------------------------------
  // Interactions : clavier (les boîtes sont aussi accessibles avec Tab)
  // ---------------------------------------------------------------------------

  /** Boutons réduire / fermer de la barre de titre. */
  function initWindowControls() {
    $('win-min').addEventListener('click', () => hub.minimize());
    $('win-close').addEventListener('click', () => hub.close());
  }

  /** Bouton V3Redis ↔ V3Redis Light : la fenêtre est recréée dans l'autre mode (choix mémorisé). */
  function initModeToggle() {
    const btn = $('mode-toggle');
    btn.textContent = LIGHT ? 'Mode complet' : 'Mode Light';
    btn.dataset.tip = LIGHT ? 'Revenir à V3Redis complet (effets, ciel étoilé, animations)' : 'V3Redis Light : fenêtre classique, sans effets, pour les PC peu puissants';
    btn.addEventListener('click', () =>
      run(btn, async () => {
        const res = await hub.setMode(LIGHT ? 'full' : 'light');
        if (!res || !res.ok) toast((res && res.error) || 'Changement de mode impossible.');
      })
    );
    if (hub.autoLight) setTimeout(() => toast('PC peu puissant détecté : V3Redis s\'ouvre en version Light. « Mode complet » en haut pour les effets.'), 600);
  }

  function initInteractions() {
    initWindowControls();
    initModeToggle();
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const onButton = e.target instanceof HTMLButtonElement; // Entrée sur un bouton = son propre clic
      if (e.key === 'Enter' && !onButton) launchSelected();
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= state.apps.length) select(Number(e.key) - 1);
      else return;
      e.preventDefault();
    });

    // Actualiser. Le bouton reste cliquable pendant la détection (un clic de plus pendant qu'elle tourne est
    // simplement ignoré) : 5 clics rapides ouvrent le casse-brique ASCII caché (breakout.js).
    const refreshBtn = $('refresh');
    let refreshing = false;
    const secret = { count: 0, last: 0 };
    refreshBtn.addEventListener('click', async () => {
      const now = Date.now();
      secret.count = now - secret.last < 700 ? secret.count + 1 : 1;
      secret.last = now;
      if (secret.count >= 5 && window.Breakout && !state.busy) {
        secret.count = 0;
        $('tooltip').hidden = true;
        window.Breakout.open();
        return;
      }
      if (refreshing) return;
      refreshing = true;
      refreshBtn.classList.remove('spin');
      void refreshBtn.offsetWidth;
      refreshBtn.classList.add('spin');
      try {
        await refresh();
        if (!(window.Breakout && window.Breakout.isOpen())) toast('Détection actualisée.');
      } catch (err) {
        toast(`Erreur : ${err && err.message ? err.message : err}`);
      } finally {
        refreshing = false;
      }
    });

    // Retour dans la fenêtre (après une installation, par exemple) : nouvelle détection
    let lastFocusRefresh = Date.now();
    window.addEventListener('focus', () => {
      if (Date.now() - lastFocusRefresh < 1500) return;
      lastFocusRefresh = Date.now();
      refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // Mises à jour : V3Redis et ses applications forment un seul paquet (updater.js)
  // ---------------------------------------------------------------------------

  const upd = { s: null, installing: false, notified: null, blocked: null };

  const fmtMo = (bytes) => `${Math.round((bytes || 0) / 1048576)} Mo`;

  /** Texte, classe et info-bulle de la pastille de la barre de titre. */
  function chipView(s) {
    const v = `v${s.current}`;
    if (s.mode === 'disabled') return { text: `${v} · dev`, cls: 'muted', tip: 'Mises à jour désactivées en développement (npm start).' };
    switch (s.state) {
      case 'checking':
        return { text: 'Recherche…', cls: 'busy', tip: 'Recherche d\'une mise à jour…' };
      case 'downloading':
        return { text: `Mise à jour ${s.percent || 0} %`, cls: 'progress', tip: `Téléchargement de V3Redis ${s.version || ''} (avec ses applications)…` };
      case 'downloaded':
        return { text: `Installer v${s.version}`, cls: 'ready', tip: 'Mise à jour prête : cliquez pour l\'installer.' };
      case 'available':
        return { text: `v${s.version} disponible`, cls: 'ready', tip: 'Nouvelle version disponible.' };
      case 'error':
        return { text: v, cls: 'error', tip: `Mises à jour : ${s.error || 'erreur'}` };
      default:
        return { text: v, cls: 'muted', tip: s.checkedAt ? `V3Redis est à jour (vérifié à ${new Date(s.checkedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}).` : 'Mises à jour de V3Redis' };
    }
  }

  function renderUpdate() {
    const s = upd.s;
    if (!s) return;
    const chip = $('update-chip');
    const view = chipView(s);
    chip.hidden = false;
    chip.className = `update-chip ${view.cls}`;
    chip.dataset.tip = view.tip;
    $('update-chip-text').textContent = view.text;
    $('update-chip-bar').style.width = `${s.state === 'downloading' ? s.percent || 0 : 0}%`;
    if (!$('update-panel').hidden) renderPanel();
  }

  function renderPanel() {
    const s = upd.s || {};
    const st = $('up-state');
    const detail = $('up-detail');
    let title = '';
    let more = '';
    if (s.mode === 'disabled') {
      title = `V3Redis ${s.current} (développement)`;
      more = 'Les mises à jour ne sont vérifiées que dans V3Redis installé.';
    } else if (upd.installing) {
      title = 'Installation…';
      more = 'V3Redis va se fermer, installer la nouvelle version puis se rouvrir.';
    } else {
      switch (s.state) {
        case 'checking':
          title = 'Recherche d\'une mise à jour…';
          break;
        case 'downloading':
          title = `Téléchargement de la version ${s.version} : ${s.percent || 0} %`;
          more = s.total ? `${fmtMo(s.transferred)} sur ${fmtMo(s.total)} — seuls les éléments modifiés sont téléchargés quand c'est possible. Vous pouvez continuer à utiliser V3Redis.` : 'Vous pouvez continuer à utiliser V3Redis.';
          break;
        case 'downloaded':
          title = `La version ${s.version} est prête à être installée.`;
          more = 'V3Redis se ferme, installe la mise à jour (toutes les applications livrées avec lui comprises) puis se rouvre. Vos réglages sont conservés.';
          break;
        case 'available':
          title = `La version ${s.version} est disponible.`;
          more = 'Téléchargez le nouvel installeur depuis la page de la release.';
          break;
        case 'not-available':
          title = `V3Redis ${s.current} est à jour.`;
          more = s.checkedAt ? `Dernière vérification : ${new Date(s.checkedAt).toLocaleString('fr-FR')}. Vérification automatique au démarrage puis toutes les 4 h.` : '';
          break;
        case 'error':
          title = 'La vérification n\'a pas abouti.';
          more = s.error || '';
          break;
        default:
          title = `V3Redis ${s.current}`;
          more = 'Vérification automatique au démarrage puis toutes les 4 h.';
      }
    }
    if (upd.blocked) more = upd.blocked;
    st.textContent = title;
    detail.textContent = more;
    detail.classList.toggle('warn', Boolean(upd.blocked) || s.state === 'error');
    $('up-progress').hidden = s.state !== 'downloading';
    $('up-progress-bar').style.width = `${s.percent || 0}%`;
    const notes = s.notes && ['downloading', 'downloaded', 'available'].includes(s.state);
    $('up-notes').hidden = !notes;
    if (notes) {
      $('up-notes-title').textContent = `Nouveautés de la version ${s.version}`;
      $('up-notes-text').textContent = s.notes;
    }
    // Contenu du paquet : les applications livrées avec V3Redis et leur version
    const list = state && Array.isArray(state.apps) ? state.apps : [];
    $('up-apps').replaceChildren(
      h('li', null, h('strong', null, 'V3Redis'), h('span', null, `v${s.current || '?'}`)),
      ...list
        .filter((a) => a.status === 'available')
        .map((a) => h('li', null, h('strong', null, a.name), h('span', { class: a.source === 'hub' ? '' : 'faint' }, a.installed ? `v${a.version || '?'}${a.source === 'hub' ? '' : ' · hors paquet'}` : 'non installé')))
    );
    // Actions
    const actions = [];
    const btn = (label, cls, fn, disabled) => {
      const b = h('button', { class: `btn ${cls || ''}`.trim(), type: 'button', disabled: disabled || null }, label);
      b.addEventListener('click', fn);
      return b;
    };
    if (s.mode !== 'disabled') {
      if (s.state === 'downloaded') actions.push(btn('Installer et redémarrer', 'primary', installUpdate, upd.installing));
      if (['idle', 'not-available', 'error', 'available'].includes(s.state)) actions.push(btn('Rechercher maintenant', s.state === 'available' ? 'ghost' : '', manualCheck));
      if (s.version && s.mode !== 'disabled') actions.push(btn(s.state === 'available' ? 'Ouvrir la release' : 'Voir la release', s.state === 'available' ? 'primary' : 'ghost', () => hub.updateOpenRelease()));
    }
    actions.push(btn('Fermer', 'ghost', closePanel));
    $('up-actions').replaceChildren(...actions);
  }

  function openPanel() {
    upd.blocked = null;
    $('update-panel').hidden = false;
    renderPanel();
    const first = $('up-actions').querySelector('.btn');
    if (first) first.focus();
  }

  function closePanel() {
    $('update-panel').hidden = true;
    $('update-chip').focus();
  }

  async function manualCheck() {
    upd.blocked = null;
    const s = await hub.updateCheck();
    if (s && s.state === 'not-available') toast(`V3Redis est à jour (v${s.current}).`);
    else if (s && s.state === 'error') toast(`Mises à jour : ${s.error}`);
  }

  async function installUpdate() {
    if (upd.installing) return;
    upd.installing = true;
    upd.blocked = null;
    renderPanel();
    const res = await hub.updateInstall().catch((err) => ({ ok: false, error: err && err.message }));
    if (!res || !res.ok) {
      upd.installing = false;
      upd.blocked = (res && res.error) || 'Installation impossible.';
      renderPanel();
    }
  }

  function initUpdates() {
    if (!hub.onUpdateStatus) return;
    const chip = $('update-chip');
    chip.addEventListener('click', () => ($('update-panel').hidden ? openPanel() : closePanel()));
    $('up-close').addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('update-panel').hidden) {
        e.preventDefault();
        closePanel();
      }
    });
    document.addEventListener('mousedown', (e) => {
      const panel = $('update-panel');
      if (!panel.hidden && !panel.contains(e.target) && !chip.contains(e.target)) panel.hidden = true;
    });
    hub.onUpdateStatus((s) => {
      const before = upd.s;
      upd.s = s;
      renderUpdate();
      // Mise à jour prête (une seule notification par version)
      if (s.state === 'downloaded' && upd.notified !== s.version && (!before || before.state !== 'downloaded')) {
        upd.notified = s.version;
        toast(`Mise à jour ${s.version} prête : cliquez sur « Installer v${s.version} » en haut.`);
      }
    });
    hub.updateStatus().then((s) => {
      if (s && !upd.s) {
        upd.s = s;
        renderUpdate();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------

  initTooltip();
  initInteractions();
  initUpdates();
  initAppProgress();
  refresh();
})();
