/*
 * guide.js — Prise en main d'Agépédé :
 *   - visite guidée au premier lancement (bulles posées sur la vraie interface, Précédent / Suivant / Passer) ;
 *   - guide illustré (bouton « Aide », F1) : captures de l'application annotées par des repères numérotés ;
 *   - projet d'exemple pour s'entraîner.
 *
 * Les captures (renderer/assets/guide/*.png) et la position des repères (renderer/js/guide-shots.js) sont
 * produites par un script de capture qui ouvre l'application, charge l'exemple et mesure les éléments désignés
 * par SHOT_SPECS : les numéros des captures correspondent donc toujours aux légendes ci-dessous.
 * Aucun innerHTML : le texte enrichi (**gras**, `code`) est construit nœud par nœud.
 */
(function () {
  'use strict';

  const TOUR_KEY = 'agepede.tour.v1';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /** Texte enrichi : **gras**, `code`, [[touche]]. */
  function rich(text) {
    const frag = document.createDocumentFragment();
    for (const part of String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/)) {
      if (!part) continue;
      if (part.startsWith('**')) frag.appendChild(el('b', null, part.slice(2, -2)));
      else if (part.startsWith('`')) frag.appendChild(el('code', null, part.slice(1, -1)));
      else if (part.startsWith('[[')) frag.appendChild(el('kbd', null, part.slice(2, -2)));
      else frag.appendChild(document.createTextNode(part));
    }
    return frag;
  }

  // ------------------------------------------------------------------ projet d'exemple

  const EXAMPLE = {
    version: 1,
    domain: { dns: 'lab.local', dn: 'DC=lab,DC=local', netbios: 'LAB' },
    options: { createFolders: true },
    ous: [
      { name: 'Paris', parent: '', description: 'Site de Paris' },
      { name: 'Groupes', parent: 'Paris', description: 'Groupes de sécurité' },
      { name: 'Utilisateurs', parent: 'Paris', description: 'Comptes du site' },
      { name: 'Serveurs', parent: 'Paris', description: 'Serveurs de fichiers' },
    ],
    globals: [
      { name: 'GG_Compta', ou: 'Paris/Groupes', description: 'Service comptabilité', members: 'jdupont, mmartin' },
      { name: 'GG_RH', ou: 'Paris/Groupes', description: 'Ressources humaines', members: 'pdurand' },
      { name: 'GG_Direction', ou: 'Paris/Groupes', description: 'Direction', members: 'cbernard' },
    ],
    locals: [
      { name: 'DL_Compta_R', ou: 'Paris/Groupes', description: 'Compta en lecture', members: 'GG_Direction' },
      { name: 'DL_Compta_RW', ou: 'Paris/Groupes', description: 'Compta en modification', members: 'GG_Compta' },
      { name: 'DL_RH_RW', ou: 'Paris/Groupes', description: 'RH en modification', members: 'GG_RH, GG_Direction' },
    ],
    permissions: [
      { path: 'D:\\Partages\\Compta', group: 'DL_Compta_R', right: 'R' },
      { path: 'D:\\Partages\\Compta', group: 'DL_Compta_RW', right: 'RW' },
      { path: 'D:\\Partages\\RH', group: 'DL_RH_RW', right: 'RW' },
    ],
  };

  // ------------------------------------------------------------------ captures annotées

  /**
   * Repères de chaque capture : sélecteur de l'élément désigné et point d'ancrage
   * (l = bord gauche, r = bord droit, t = haut, b = bas, c = centre). Lu par le script de capture.
   */
  const row1 = (t, f) => `#grid-${t} tbody tr:not(.ghost) td[data-field="${f}"]`;
  const SHOT_SPECS = {
    overview: { tab: 'ous', markers: [['#btn-new', 'l'], ['#dom-dns', 'r'], ['#btn-detect', 'r'], ['#env-chips .chip', 'l'], ['#tab-ous', 'l'], [row1('ous', 'name'), 'l'], ['#grid-ous tr.ghost td[data-field="name"]', 'l'], ['#view-ous .toolbar-actions', 'l'], ['#btn-help', 'b']] },
    domain: { tab: 'ous', crop: '.domainbar', markers: [['#dom-dns', 'r'], ['#dom-dn', 'r'], ['#dom-netbios', 'r'], ['#btn-detect', 'r'], ['#env-chips .chip', 'l'], ['#btn-elevate', 'r'], ['#opt-always-admin', 'l'], ['#env-badge', 'l']] },
    globals: { tab: 'globals', markers: [[row1('globals', 'name'), 'l'], [row1('globals', 'ou'), 'l'], [row1('globals', 'members'), 'l'], ['#grid-globals .has-error', 'r'], ['#tab-globals .count', 'r']] },
    locals: { tab: 'locals', markers: [['#dl-helper-gg', 'l'], ['#dl-helper-btn', 'r'], [row1('locals', 'members'), 'l'], ['#tab-locals', 'l']] },
    permissions: { tab: 'permissions', markers: [[row1('permissions', 'path'), 'l'], [row1('permissions', 'group'), 'l'], [row1('permissions', 'right'), 'l'], ['#view-permissions label.check', 't']] },
    script: { tab: 'script', markers: [['#issues', 'l'], ['#script-preview', 'l'], ['#btn-copy', 'l'], ['#btn-simulate', 'l'], ['#btn-run', 'b']] },
    run: {
      tab: 'script',
      scroll: '#view-script .panel:last-child',
      logScroll: '#run-log-body tr.log-row[data-i="8"]',
      markers: [['#run-summary', 'l'], ['#run-log-body tr.log-row[data-i="10"]', 'l'], ['#run-log-body tr.log-detail:not([hidden])', 'l'], ['#run-log-body tr.log-row.s-error td.st', 'r'], ['#btn-export-log', 'b']],
    },
  };

  const LEGENDS = {
    overview: [
      '**Projet** : nouveau, ouvrir, enregistrer (fichier `.agepede.json`). Le titre indique ● quand il y a des modifications.',
      '**Domaine visé** : nom DNS, DN et nom NetBIOS (calculés automatiquement).',
      '**Détecter** : lit le domaine de ce poste et vérifie les outils Active Directory.',
      '**Pastilles d\'état** : outils AD, droits administrateur, Windows Server, domaine du poste.',
      '**Onglets** : les étapes AGDLP dans l\'ordre, avec le nombre de lignes et les erreurs.',
      '**Tableau** : une ligne par objet, on tape directement dans les cellules.',
      '**Ligne vide** : tapez ou collez ici (Excel) pour ajouter des lignes.',
      '**Ajouter / Importer / Exporter** une ligne ou un fichier CSV (Excel).',
      '**Aide** : ce guide ([[F1]]).',
    ],
    domain: [
      '**Nom DNS** du domaine, par exemple `lab.local`.',
      '**DN** calculé (`DC=lab,DC=local`) ; « recalculer » le remet à jour.',
      '**NetBIOS** : nom court utilisé pour les permissions (`LAB\\DL_…`).',
      '**Détecter** : remplit le domaine du poste et met à jour les pastilles.',
      '**Outils AD** : dsadd, dsmod, dsquery doivent être présents (contrôleur de domaine ou RSAT).',
      '**Relancer en administrateur** : rouvre Agépédé avec les droits nécessaires, projet conservé.',
      '**Toujours démarrer en administrateur** : la demande d\'élévation est faite à chaque lancement.',
      '**Résumé** de l\'environnement : ce qu\'Agépédé pourra faire sur ce poste.',
    ],
    globals: [
      '**Nom** du groupe global, préfixe conseillé `GG_`.',
      '**OU** où le créer : chemin `Paris/Groupes` (suggestions des OU du tableau ; vide = conteneur Users).',
      '**Membres** : identifiants des utilisateurs (sAMAccountName), séparés par des virgules.',
      '**Erreur** : cellule en rouge, le message s\'affiche au survol. Ici un « ; » interdit.',
      '**Compteur** de lignes de l\'onglet ; une pastille rouge signale des erreurs.',
    ],
    locals: [
      '**Raccourci** : tapez le nom d\'un groupe global…',
      '… puis créez d\'un clic ses deux groupes domaine local, lecture (`_R`) et modification (`_RW`).',
      '**Membres** d\'un DL : les groupes globaux (suggestions proposées pendant la saisie).',
      '**Onglet DL** : un groupe par ressource et par niveau d\'accès.',
    ],
    permissions: [
      '**Dossier** : chemin local du serveur de fichiers (`D:\\Partages\\Compta`) ou UNC.',
      '**Groupe DL** qui reçoit le droit (suggestions des DL du tableau).',
      '**Droit** : Lecture, Modification ou Contrôle total (hérité par les sous-dossiers).',
      '**Créer les dossiers absents** avant d\'appliquer les droits.',
    ],
    script: [
      '**Vérification** : erreurs (bloquantes) et avertissements ; un clic mène à la cellule concernée.',
      '**Script CMD** : les commandes exactes (dsadd, dsmod, icacls), dans l\'ordre.',
      '**Copier** le script ou l\'**exporter** en `.bat` pour le lancer vous-même.',
      '**Simulation** : indique ce qui existe déjà, sans rien modifier.',
      '**Exécuter sur l\'AD** : crée réellement, après une confirmation.',
    ],
    run: [
      '**Résumé** : créés, déjà existants, erreurs, étapes ignorées.',
      '**Journal** : une ligne par commande ; cliquez pour voir le détail.',
      '**Détail** : la commande lancée et la réponse de Windows.',
      '**Statut** : ✓ créé, déjà existant (laissé tel quel), ✗ erreur.',
      '**Exporter le journal** en fichier texte (traçabilité).',
    ],
  };

  /** Capture annotée : image + repères numérotés + légende (survol = repère mis en évidence). */
  function figure(id, caption) {
    const shots = window.GUIDE_SHOTS || {};
    const shot = shots[id];
    const legend = LEGENDS[id] || [];
    const fig = el('figure', 'g-figure');
    if (shot) {
      const box = el('div', 'g-shot');
      box.style.aspectRatio = `${shot.w} / ${shot.h}`;
      // Capture claire ou sombre selon le thème de Windows
      const pic = el('picture');
      if (shot.dark) {
        const source = el('source');
        source.srcset = shot.dark;
        source.media = '(prefers-color-scheme: dark)';
        pic.appendChild(source);
      }
      const img = el('img');
      img.src = shot.src;
      img.alt = caption || '';
      img.loading = 'lazy';
      pic.appendChild(img);
      box.appendChild(pic);
      for (const m of shot.markers) {
        const dot = el('span', 'g-marker', String(m.n));
        dot.style.left = `${m.x}%`;
        dot.style.top = `${m.y}%`;
        dot.dataset.n = m.n;
        box.appendChild(dot);
      }
      fig.appendChild(box);
    }
    if (caption) fig.appendChild(el('figcaption', null, caption));
    if (legend.length) {
      const ol = el('ol', 'g-legend');
      legend.forEach((text, i) => {
        const li = el('li');
        li.dataset.n = i + 1;
        li.appendChild(el('span', 'g-num', String(i + 1)));
        const span = el('span');
        span.appendChild(rich(text));
        li.appendChild(span);
        const hl = (on) => {
          const dot = fig.querySelector(`.g-marker[data-n="${i + 1}"]`);
          if (dot) dot.classList.toggle('hl', on);
        };
        li.addEventListener('mouseenter', () => hl(true));
        li.addEventListener('mouseleave', () => hl(false));
        ol.appendChild(li);
      });
      fig.appendChild(ol);
    }
    return fig;
  }

  // ------------------------------------------------------------------ guide (aide intégrée)

  const para = (text) => {
    const p = el('p');
    p.appendChild(rich(text));
    return p;
  };
  const list = (items, ordered) => {
    const l = el(ordered ? 'ol' : 'ul');
    for (const t of items) {
      const li = el('li');
      li.appendChild(rich(t));
      l.appendChild(li);
    }
    return l;
  };
  const steps = (items) => {
    const ol = el('ol', 'g-steps');
    for (const [title, text] of items) {
      const li = el('li');
      li.appendChild(el('b', 'g-step-title', title));
      const p = el('span');
      p.appendChild(rich(text));
      li.appendChild(p);
      ol.appendChild(li);
    }
    return ol;
  };
  const actionBtn = (label, run, primary) => {
    const b = el('button', `btn${primary ? ' btn-primary' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  };

  const SECTIONS = [
    {
      id: 'start',
      title: 'Prise en main',
      build: (c) => {
        c.appendChild(para('Agépédé crée dans **Active Directory** les unités d\'organisation (OU), les groupes globaux (GG), les groupes domaine local (DL) et les permissions de dossiers, selon le modèle **AGDLP**. Vous remplissez des tableaux, Agépédé écrit et lance les commandes CMD.'));
        c.appendChild(
          steps([
            ['Le domaine', 'Saisissez le nom DNS (`lab.local`) ou cliquez sur **Détecter** sur un serveur du domaine.'],
            ['Les OU', 'Onglet **OU** : l\'arborescence (`Paris`, puis `Groupes` avec l\'OU parente `Paris`).'],
            ['Les groupes globaux', 'Onglet **GG** : un groupe par service, avec ses utilisateurs.'],
            ['Les groupes domaine local', 'Onglet **DL** : un groupe par dossier et par niveau d\'accès, contenant les GG.'],
            ['Les permissions', 'Onglet **Permissions** : chaque DL reçoit son droit sur son dossier.'],
            ['Vérifier et exécuter', 'Onglet **Script & exécution** : corrigez les erreurs, faites une **Simulation**, puis **Exécutez**.'],
          ])
        );
        c.appendChild(figure('overview', 'La fenêtre principale (projet d\'exemple chargé).'));
        const bar = el('div', 'g-actions');
        bar.append(actionBtn('Revoir la visite guidée', () => startTour(true), true), actionBtn('Charger le projet d\'exemple', () => loadExample()));
        c.appendChild(bar);
      },
    },
    {
      id: 'domain',
      title: 'Domaine et poste',
      build: (c) => {
        c.appendChild(para('Tout en haut, le **domaine visé** et l\'**état du poste**. Pour exécuter, Agépédé doit tourner **en administrateur** sur un **contrôleur de domaine** ou sur un poste du domaine équipé des outils **RSAT « AD DS »**.'));
        c.appendChild(figure('domain', 'Barre du domaine : poste Windows Server non lancé en administrateur.'));
        c.appendChild(para('Sans outils AD (ou hors domaine), tout le reste fonctionne : saisie, vérification et export du script `.bat` pour le lancer sur le serveur.'));
      },
    },
    {
      id: 'tables',
      title: 'Saisir les tableaux',
      build: (c) => {
        c.appendChild(para('Chaque onglet est un tableau, comme dans Excel. **Tapez dans la ligne vide du bas** : elle devient une vraie ligne et une nouvelle ligne vide apparaît.'));
        c.appendChild(
          list([
            '[[Entrée]] : ligne suivante (même colonne) · [[Maj]]+[[Entrée]] : ligne précédente · [[Tab]] : cellule suivante.',
            '**Coller depuis Excel** : copiez un bloc de cellules puis collez-le dans une cellule ; les lignes et colonnes se remplissent à partir d\'elle (une ligne d\'en-têtes est ignorée).',
            '**Importer / Exporter CSV** : un fichier par tableau, séparateur `;`, ouvert directement par Excel.',
            '[[Ctrl]]+[[Suppr]] ou × en bout de ligne : supprimer la ligne (« Annuler » dans la notification pour la récupérer).',
            '**OU parente** et **OU** : chemin de haut en bas séparé par `/` (`Paris/Groupes`). Vide = racine du domaine (OU) ou conteneur Users (groupes).',
          ])
        );
        c.appendChild(figure('globals', 'Onglet Groupes globaux : saisie et contrôle immédiat.'));
        c.appendChild(figure('locals', 'Onglet Groupes domaine local : le raccourci « Créer les DL pour un GG ».'));
        c.appendChild(figure('permissions', 'Onglet Permissions.'));
      },
    },
    {
      id: 'run',
      title: 'Vérifier et exécuter',
      build: (c) => {
        c.appendChild(para('L\'onglet **Script & exécution** rassemble la vérification, le script et son exécution. Tant qu\'il reste une **erreur**, rien ne peut être copié, exporté ni exécuté.'));
        c.appendChild(figure('script', 'Vérification et script CMD.'));
        c.appendChild(
          steps([
            ['Simulation', 'Lecture seule : chaque étape est marquée « à faire » ou « déjà existant ». Rien n\'est modifié.'],
            ['Exécution', 'Une confirmation rappelle le domaine et le nombre d\'objets. Les objets déjà présents sont laissés tels quels, **rien n\'est jamais supprimé**.'],
            ['Relance', 'Le script peut être relancé sans risque : ce qui existe est ignoré, seuls les manques sont créés.'],
          ])
        );
        c.appendChild(figure('run', 'Après une exécution : résumé et journal détaillé.'));
      },
    },
    {
      id: 'agdlp',
      title: 'AGDLP en bref',
      build: (c) => {
        const chain = el('div', 'g-chain');
        for (const [k, t, d] of [
          ['A', 'Accounts', 'les comptes utilisateurs'],
          ['G', 'Groupes globaux', 'un par service ou rôle'],
          ['DL', 'Domaine local', 'un par ressource et niveau d\'accès'],
          ['P', 'Permissions', 'données aux DL seulement'],
        ]) {
          const b = el('div', 'g-chain-item');
          b.append(el('strong', null, k), el('span', null, t), el('small', null, d));
          chain.appendChild(b);
        }
        c.appendChild(chain);
        c.appendChild(
          list(
            [
              'Les **comptes** (A) sont membres de **groupes globaux** (G) : `jdupont` → `GG_Compta`.',
              'Les GG sont membres de **groupes domaine local** (DL) : `GG_Compta` → `DL_Compta_RW`.',
              'Les **permissions** (P) ne sont données qu\'aux DL : `DL_Compta_RW` → Modification sur `D:\\Partages\\Compta`.',
              'Donner un accès à quelqu\'un = l\'ajouter au bon GG. Nouveau dossier partagé = ses DL et ses permissions.',
              'Les OU rangent les objets dans l\'annuaire ; elles ne donnent aucun droit.',
              'Interdit : un GG ne peut pas contenir de DL (Agépédé le signale).',
            ],
            true
          )
        );
      },
    },
    {
      id: 'tips',
      title: 'Raccourcis et dépannage',
      build: (c) => {
        c.appendChild(el('h3', null, 'Raccourcis'));
        c.appendChild(
          list([
            '[[Ctrl]]+[[N]] nouveau · [[Ctrl]]+[[O]] ouvrir · [[Ctrl]]+[[S]] enregistrer · [[Ctrl]]+[[Maj]]+[[S]] enregistrer sous.',
            '[[Ctrl]]+[[1]] à [[Ctrl]]+[[5]] : onglets · [[F1]] : ce guide.',
            'Le projet en cours est gardé en brouillon : il est restauré si Agépédé est fermé sans enregistrer.',
          ])
        );
        c.appendChild(el('h3', null, 'Problèmes fréquents'));
        c.appendChild(
          steps([
            ['« Outils AD absents »', 'Lancez Agépédé sur un contrôleur de domaine, ou installez la fonctionnalité Windows « RSAT : outils AD DS ». Vous pouvez aussi exporter le `.bat` et le lancer sur le serveur.'],
            ['« Administrateur : non »', 'Cliquez sur « relancer en administrateur » dans la pastille (le projet est conservé), ou cochez « Toujours démarrer en administrateur ».'],
            ['« Introuvable dans l\'Active Directory »', 'Le membre indiqué n\'existe pas : vérifiez l\'identifiant (sAMAccountName) de l\'utilisateur ou le nom du groupe.'],
            ['« existe déjà ailleurs dans le domaine »', 'Un groupe porte déjà ce nom dans une autre OU : renommez la ligne ou supprimez-la du tableau.'],
            ['Étape « ignorée »', 'Une étape dont elle dépend a échoué (par exemple l\'OU parente) : corrigez la première erreur puis relancez.'],
          ])
        );
      },
    },
  ];

  let guideBuilt = false;

  function buildGuide() {
    const nav = $('guide-nav');
    const body = $('guide-body');
    nav.textContent = '';
    body.textContent = '';
    for (const s of SECTIONS) {
      const b = el('button', 'g-nav-item', s.title);
      b.type = 'button';
      b.dataset.section = s.id;
      b.addEventListener('click', () => showSection(s.id));
      nav.appendChild(b);
      const sec = el('section', 'g-section');
      sec.id = `guide-${s.id}`;
      sec.appendChild(el('h2', null, s.title));
      s.build(sec);
      body.appendChild(sec);
    }
    guideBuilt = true;
  }

  function showSection(id) {
    const target = $(`guide-${id}`) ? id : SECTIONS[0].id;
    for (const b of document.querySelectorAll('#guide-nav .g-nav-item')) b.setAttribute('aria-current', String(b.dataset.section === target));
    for (const s of document.querySelectorAll('#guide-body .g-section')) s.hidden = s.id !== `guide-${target}`;
    $('guide-body').scrollTop = 0;
  }

  function openGuide(section) {
    if (!guideBuilt) buildGuide();
    const dlg = $('help-dialog');
    showSection(section || 'start');
    if (!dlg.open) dlg.showModal();
    const cur = document.querySelector('#guide-nav [aria-current="true"]');
    if (cur) cur.focus();
  }

  function closeGuide() {
    const dlg = $('help-dialog');
    if (dlg.open) dlg.close();
  }

  async function loadExample() {
    closeGuide();
    if (hooks.loadExample) await hooks.loadExample(JSON.parse(JSON.stringify(EXAMPLE)));
  }

  // ------------------------------------------------------------------ visite guidée

  const TOUR = [
    {
      title: 'Bienvenue dans Agépédé',
      text: [
        'Agépédé crée vos **OU**, **groupes globaux**, **groupes domaine local** et **permissions** dans Active Directory, selon le modèle **AGDLP**.',
        'Vous remplissez des tableaux, Agépédé vérifie tout puis écrit et lance les commandes CMD (`dsadd`, `dsmod`, `icacls`).',
        'Cette visite présente l\'écran en 1 minute.',
      ],
      welcome: true,
    },
    { target: '.domainbar', title: 'Le domaine', text: ['Saisissez le **nom DNS** du domaine (`lab.local`) : le DN et le nom NetBIOS se remplissent seuls.', 'Sur un serveur du domaine, **Détecter** les lit pour vous.'] },
    { target: '#env-chips', title: 'L\'état du poste', text: ['Ces pastilles indiquent si les **outils AD** sont présents, si Agépédé est **administrateur** et si le poste est dans le domaine.', 'Besoin des droits ? « **relancer en administrateur** » rouvre Agépédé sans perdre le projet.'] },
    { target: '.tabs', title: 'Les étapes AGDLP', text: ['Un onglet par étape : **OU** → **groupes globaux** → **groupes domaine local** → **permissions** → **script**.', 'Chaque onglet affiche son nombre de lignes et ses erreurs. Raccourcis [[Ctrl]]+[[1]] à [[Ctrl]]+[[5]].'], tab: 'ous' },
    { target: '#grid-ous', title: 'La saisie en tableau', text: ['Tapez dans la **ligne vide du bas** : elle devient une vraie ligne. [[Entrée]] passe à la ligne suivante, [[Tab]] à la cellule suivante.', 'Vous pouvez **coller un bloc copié depuis Excel** : il remplit plusieurs lignes d\'un coup.'], tab: 'ous' },
    { target: '#view-ous .toolbar-actions', title: 'Importer et exporter', text: ['Chaque tableau s\'importe et s\'exporte en **CSV** (Excel).', 'Le projet complet s\'enregistre avec **Enregistrer** ([[Ctrl]]+[[S]]).'], tab: 'ous' },
    { target: '#dl-helper', title: 'Le raccourci DL', text: ['Tapez le nom d\'un groupe global : Agépédé crée ses deux groupes domaine local, **lecture** (`_R`) et **modification** (`_RW`), qui le contiennent.'], tab: 'locals' },
    { target: '#view-script .panel', title: 'La vérification', text: ['Les **erreurs** bloquent l\'exécution, les **avertissements** conseillent.', 'Cliquez sur un message pour aller directement à la cellule concernée.'], tab: 'script' },
    { target: '#script-preview', title: 'Le script CMD', text: ['Les commandes exactes, dans l\'ordre. **Copiez**-les ou **exportez** un fichier `.bat` pour le lancer vous-même sur le serveur.'], tab: 'script' },
    { target: '#btn-simulate', targetBox: '.view-script .panel:last-child .panel-actions', title: 'Simuler, puis exécuter', text: ['**Simulation** : montre ce qui existe déjà, sans rien modifier.', '**Exécuter sur l\'AD** crée réellement, après confirmation. Rien n\'est jamais supprimé ; le script peut être relancé sans risque.'], tab: 'script' },
    { target: '#btn-help', title: 'Besoin d\'aide ?', text: ['Le **guide illustré** est toujours ici (ou [[F1]]) : captures annotées, AGDLP en bref, dépannage. Vous pourrez y revoir cette visite.', 'Pour vous entraîner, chargez le **projet d\'exemple**.'], last: true, tab: 'ous' },
  ];

  const tour = { index: 0, layer: null, active: false, prevTab: null };

  function tourSeen() {
    try {
      return localStorage.getItem(TOUR_KEY) === 'done';
    } catch {
      return false;
    }
  }

  function markTourSeen() {
    try {
      localStorage.setItem(TOUR_KEY, 'done');
    } catch {
      // stockage indisponible : la visite sera simplement reproposée
    }
  }

  function startTour(fromGuide) {
    if (fromGuide) closeGuide();
    if (tour.active) return;
    tour.active = true;
    tour.index = 0;
    tour.prevTab = hooks.getTab ? hooks.getTab() : null;
    const layer = el('div', 'tour-layer');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', 'Visite guidée');
    layer.append(el('div', 'tour-spot'), el('div', 'tour-bubble'));
    // Clic hors de la bulle : rien (la visite se quitte par « Passer » ou Échap)
    layer.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.tour-bubble')) e.preventDefault();
    });
    document.body.appendChild(layer);
    tour.layer = layer;
    document.addEventListener('keydown', onTourKey, true);
    window.addEventListener('resize', placeTour);
    renderTour();
  }

  function endTour(finished) {
    if (!tour.active) return;
    tour.active = false;
    markTourSeen();
    document.removeEventListener('keydown', onTourKey, true);
    window.removeEventListener('resize', placeTour);
    if (tour.layer) tour.layer.remove();
    tour.layer = null;
    if (hooks.showTab) hooks.showTab(finished ? 'ous' : tour.prevTab || 'ous');
    if (hooks.toast && !finished) hooks.toast('Visite guidée passée : retrouvez-la dans l\'Aide (F1).', 'info');
  }

  function onTourKey(e) {
    if (!tour.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      endTour(false);
    } else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest('button'))) {
      e.preventDefault();
      e.stopPropagation();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      prev();
    } else if (e.ctrlKey || e.key === 'F1') {
      // pas de raccourcis de l'application pendant la visite
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function next() {
    if (tour.index >= TOUR.length - 1) return endTour(true);
    tour.index++;
    renderTour();
  }

  function prev() {
    if (tour.index === 0) return;
    tour.index--;
    renderTour();
  }

  function renderTour() {
    const step = TOUR[tour.index];
    if (step.tab && hooks.showTab) hooks.showTab(step.tab);
    const bubble = tour.layer.querySelector('.tour-bubble');
    bubble.textContent = '';
    bubble.classList.toggle('welcome', Boolean(step.welcome));
    const head = el('div', 'tour-head');
    if (step.welcome) {
      const logo = el('img', 'tour-logo');
      logo.src = 'assets/logo.svg';
      logo.alt = '';
      head.appendChild(logo);
    } else head.appendChild(el('span', 'tour-count', `${tour.index} / ${TOUR.length - 1}`));
    head.appendChild(el('h2', null, step.title));
    bubble.appendChild(head);
    for (const t of step.text) bubble.appendChild(para(t));

    const actions = el('div', 'tour-actions');
    if (step.welcome) {
      actions.append(actionBtn('Plus tard', () => endTour(false)), actionBtn('Commencer la visite', next, true));
    } else {
      const skip = actionBtn('Passer', () => endTour(false));
      skip.classList.add('tour-skip');
      actions.appendChild(skip);
      actions.appendChild(actionBtn('Précédent', prev));
      if (step.last) {
        actions.appendChild(
          actionBtn('Charger l\'exemple', async () => {
            endTour(true);
            await loadExample();
          })
        );
        actions.appendChild(actionBtn('Terminer', () => endTour(true), true));
      } else actions.appendChild(actionBtn('Suivant', next, true));
    }
    bubble.appendChild(actions);
    const dots = el('div', 'tour-dots');
    TOUR.forEach((_, i) => dots.appendChild(el('span', i === tour.index ? 'on' : '')));
    bubble.appendChild(dots);
    // Laisser le temps à l'onglet de s'afficher avant de mesurer
    requestAnimationFrame(() => {
      placeTour();
      const primary = bubble.querySelector('.btn-primary');
      if (primary) primary.focus();
    });
  }

  function placeTour() {
    if (!tour.active || !tour.layer) return;
    const step = TOUR[tour.index];
    const spot = tour.layer.querySelector('.tour-spot');
    const bubble = tour.layer.querySelector('.tour-bubble');
    const target = step.target ? document.querySelector(step.targetBox || step.target) || document.querySelector(step.target) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!target) {
      spot.hidden = true;
      tour.layer.classList.add('dim');
      bubble.style.left = `${Math.max(16, (vw - bubble.offsetWidth) / 2)}px`;
      bubble.style.top = `${Math.max(16, (vh - bubble.offsetHeight) / 2)}px`;
      return;
    }
    tour.layer.classList.remove('dim');
    spot.hidden = false;
    target.scrollIntoView({ block: 'nearest' });
    const r = target.getBoundingClientRect();
    const pad = 6;
    const top = Math.max(4, r.top - pad);
    const left = Math.max(4, r.left - pad);
    const width = Math.min(vw - left - 4, r.width + pad * 2);
    const height = Math.min(vh - top - 4, r.height + pad * 2);
    Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    // Bulle sous la cible si la place le permet, sinon au-dessus, sinon à côté
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let bx = Math.min(Math.max(16, left), vw - bw - 16);
    let by;
    if (top + height + 12 + bh <= vh - 12) by = top + height + 12;
    else if (top - 12 - bh >= 12) by = top - 12 - bh;
    else {
      by = Math.min(Math.max(12, top), vh - bh - 12);
      bx = left + width + 12 + bw <= vw - 12 ? left + width + 12 : Math.max(12, left - 12 - bw);
    }
    bubble.style.left = `${bx}px`;
    bubble.style.top = `${by}px`;
  }

  // ------------------------------------------------------------------ mise en place

  let hooks = {};

  /**
   * hooks : { showTab(tab), getTab(), loadExample(project) → Promise, toast(message, kind) }.
   * Branche le bouton « Fermer » du guide ; la visite est proposée au premier lancement par maybeStartTour().
   */
  function init(h) {
    hooks = h || {};
    const close = $('help-close');
    if (close) close.addEventListener('click', closeGuide);
  }

  function maybeStartTour() {
    if (!tourSeen()) startTour(false);
  }

  window.AgepedeGuide = { init, openGuide, startTour, maybeStartTour, loadExample, EXAMPLE, SHOT_SPECS, LEGENDS, isTourActive: () => tour.active };
})();
