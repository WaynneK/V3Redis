/*
 * binary-view.js — Onglet « Binaire » de CalkIP.
 *
 * Atelier bit à bit (adresse, masque, wildcard, réseau, diffusion), explication étape par étape,
 * convertisseur, octet à la loupe, entraînement et mémo. Les calculs viennent de lib/ipcalc.js et
 * lib/binary.js ; app.js fournit les utilitaires d'interface (BinaryView.init). DOM sans innerHTML.
 */
'use strict';

(() => {
  const C = window.IPCalc;
  const B = window.IPBinary;
  const $ = (id) => document.getElementById(id);
  const fmt = C.formatNumber;
  const STORE_KEY = 'calkip.binary';
  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const sup = (n) => String(n).replace(/\d/g, (d) => SUP[d]);

  let ui = null; // { h, svgIcon, kvRow, copyButton, toast, copy, storage, api }
  let h = null;

  const st = {
    ip: C.parseIp('192.168.1.10'),
    prefix: 26,
    step: 0,
    all: false,
    level: 'moyen',
    synced: null, // dernier réseau repris de la calculatrice
  };

  // ---------------------------------------------------------------------------
  // État, sauvegarde
  // ---------------------------------------------------------------------------

  function save() {
    ui.storage.set(STORE_KEY, { ip: C.toIp(st.ip), prefix: st.prefix, step: st.step, all: st.all, level: st.level, synced: st.synced });
  }

  function restore() {
    const s = ui.storage.get(STORE_KEY, null);
    if (!s) return;
    try {
      st.ip = C.parseIp(s.ip);
    } catch {
      // adresse par défaut
    }
    if (Number.isInteger(s.prefix) && s.prefix >= 0 && s.prefix <= 32) st.prefix = s.prefix;
    if (Number.isInteger(s.step) && s.step >= 0 && s.step < 9) st.step = s.step;
    st.all = Boolean(s.all);
    if (B.LEVELS[s.level]) st.level = s.level;
    st.synced = typeof s.synced === 'string' ? s.synced : null;
  }

  /** Change l'adresse et / ou le préfixe étudiés, puis redessine tout. */
  function setAddress(ip, prefix, options = {}) {
    st.ip = ip >>> 0;
    st.prefix = prefix;
    if (!options.fromField) {
      $('b-ip').value = `${C.toIp(st.ip)}/${st.prefix}`;
      showError('');
    }
    refresh();
  }

  function showError(message) {
    $('b-error').textContent = message || '';
    $('b-error').hidden = !message;
    $('b-ip').classList.toggle('invalid', Boolean(message));
  }

  /** Saisie libre : « a.b.c.d », « a.b.c.d/n », « a.b.c.d masque », ou une adresse binaire / hexadécimale. */
  function readField() {
    const text = $('b-ip').value;
    if (!text.trim()) {
      showError('');
      return;
    }
    try {
      const parsed = C.parseInput(text);
      showError('');
      setAddress(parsed.ip, parsed.prefix === null ? st.prefix : parsed.prefix, { fromField: true });
    } catch (err) {
      try {
        if (text.includes('/')) throw err;
        const any = B.parseAnyIp(text);
        showError('');
        setAddress(any.value, st.prefix, { fromField: true });
      } catch {
        showError(err.message);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // En-tête : préfixe
  // ---------------------------------------------------------------------------

  function renderHead() {
    const mask = C.prefixToMask(st.prefix);
    $('b-prefix').value = String(st.prefix);
    $('b-prefix-out').textContent = `/${st.prefix}`;
    $('b-mask-out').textContent = C.toIp(mask);
    $('b-prefix-dec').disabled = st.prefix <= 0;
    $('b-prefix-inc').disabled = st.prefix >= 32;
    // Remplissage de la piste du curseur (CSSOM : la CSP interdit les styles en ligne)
    $('b-prefix').style.setProperty('--fill', `${(st.prefix / 32) * 100}%`);
  }

  // ---------------------------------------------------------------------------
  // Atelier bit à bit
  // ---------------------------------------------------------------------------

  const BOARD_ROWS = [
    { key: 'ip', label: 'Adresse', sub: 'cliquez un bit', action: 'ip' },
    { key: 'mask', label: 'Masque', sub: '', action: 'mask' },
    { key: 'wildcard', label: 'Wildcard', sub: 'NON masque' },
    { key: 'network', label: 'Réseau', sub: 'adresse ET masque' },
    { key: 'last', label: 'Diffusion', sub: 'réseau OU wildcard' },
  ];
  const col = (i) => 2 + i + Math.floor(i / 8);
  const board = { cells: {}, dec: {}, labels: {}, subs: {}, segNet: null, segHost: null, built: false, hover: null };

  function place(el, row, colStart, colEnd) {
    el.style.gridRow = String(row);
    el.style.gridColumn = colEnd ? `${colStart} / ${colEnd}` : String(colStart);
    return el;
  }

  function buildBoard() {
    const root = $('board');
    const parts = [];
    board.segNet = place(h('div', { class: 'seg net' }), 1, 2, 3);
    board.segHost = place(h('div', { class: 'seg host' }), 1, 2, 3);
    parts.push(board.segNet, board.segHost);

    parts.push(place(h('div', { class: 'b-label weights' }, 'Poids'), 2, 1));
    for (let i = 0; i < 32; i++) {
      const w = 7 - (i % 8);
      parts.push(place(h('div', { class: 'weight', 'data-col': i, 'data-tip': `2${sup(w)} = ${2 ** w}` }, String(2 ** w)), 2, col(i)));
    }
    parts.push(place(h('div', { class: 'b-dec head' }, 'Décimal'), 2, 37));

    BOARD_ROWS.forEach((r, ri) => {
      // Lignes 3 à 5 : saisies et wildcard ; ligne 6 : séparateur ; lignes 7 et 8 : résultats
      const row = ri + 3 + (ri >= 3 ? 1 : 0);
      board.subs[r.key] = h('small', null, r.sub);
      board.labels[r.key] = h('span', null, r.label);
      parts.push(place(h('div', { class: `b-label${r.action ? ' active' : ''}` }, board.labels[r.key], board.subs[r.key]), row, 1));
      board.cells[r.key] = [];
      for (let i = 0; i < 32; i++) {
        const cell = r.action
          ? h('button', { type: 'button', class: `bit clickable row-${r.key}`, 'data-col': i, 'data-action': r.action, 'aria-label': `${r.label}, bit ${i + 1}` })
          : h('span', { class: `bit row-${r.key}`, 'data-col': i });
        board.cells[r.key].push(cell);
        parts.push(place(cell, row, col(i)));
      }
      board.dec[r.key] = place(h('div', { class: `b-dec mono${r.key === 'network' || r.key === 'last' ? ' strong' : ''}` }), row, 37);
      parts.push(board.dec[r.key]);
      // Séparateur avant les lignes calculées
      if (r.key === 'wildcard') parts.push(place(h('div', { class: 'b-rule' }), row + 1, 2, 37));
    });
    root.replaceChildren(...parts);
    board.built = true;

    root.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-action]');
      if (!cell) return;
      const i = Number(cell.dataset.col);
      if (cell.dataset.action === 'ip') {
        setAddress((st.ip ^ (2 ** (31 - i))) >>> 0, st.prefix);
      } else {
        // Masque : cliquer un 1 ramène la limite sur ce bit, cliquer un 0 l'étend jusqu'à lui
        setAddress(st.ip, i < st.prefix ? i : i + 1);
      }
      describeBit(i);
    });
    const onHover = (e) => {
      const cell = e.target.closest && e.target.closest('[data-col]');
      setHover(cell ? Number(cell.dataset.col) : null);
    };
    root.addEventListener('mouseover', onHover);
    root.addEventListener('focusin', onHover);
    root.addEventListener('mouseleave', () => setHover(null));
  }

  function setHover(i) {
    if (board.hover === i) return;
    board.hover = i;
    document.querySelectorAll('#board .col-hl').forEach((el) => el.classList.remove('col-hl'));
    if (i === null) {
      $('bit-info').replaceChildren('Survolez un bit pour voir sa position, son poids et le calcul de la colonne.');
      return;
    }
    document.querySelectorAll(`#board [data-col="${i}"]`).forEach((el) => el.classList.add('col-hl'));
    describeBit(i);
  }

  function describeBit(i) {
    const w = 7 - (i % 8);
    const bit = (n) => (n >>> (31 - i)) & 1;
    const c = C.calculate(st.ip, st.prefix);
    $('bit-info').replaceChildren(
      h('strong', null, `Bit ${i + 1} / 32`),
      ` · octet n° ${Math.floor(i / 8) + 1} · poids 2${sup(w)} = ${2 ** w} · `,
      h('span', { class: i < st.prefix ? 'bits-net-sample' : 'bits-host-sample' }, i < st.prefix ? 'partie réseau' : 'partie hôte'),
      ` — adresse ${bit(st.ip)} ET masque ${bit(c.mask)} = réseau ${bit(c.network)} ; réseau ${bit(c.network)} OU wildcard ${bit(c.wildcard)} = ${st.prefix <= 30 ? 'diffusion' : 'dernière'} ${bit(c.lastAddress)}`
    );
  }

  function renderBoard() {
    if (!board.built) buildBoard();
    const c = C.calculate(st.ip, st.prefix);
    const values = { ip: c.ip, mask: c.mask, wildcard: c.wildcard, network: c.network, last: c.lastAddress };
    const p = st.prefix;
    for (const r of BOARD_ROWS) {
      const bits = B.bits32(values[r.key]);
      board.cells[r.key].forEach((cell, i) => {
        const before = cell.textContent;
        cell.textContent = bits[i];
        cell.classList.toggle('one', bits[i] === '1');
        cell.classList.toggle('net', i < p);
        cell.classList.toggle('host', i >= p);
        cell.classList.toggle('edge', i === p && p > 0 && p < 32);
        if (before && before !== bits[i]) {
          cell.classList.remove('flip');
          void cell.offsetWidth; // relance l'animation
          cell.classList.add('flip');
        }
        if (r.action === 'mask') cell.setAttribute('data-tip', i < p ? `Ramener le préfixe à /${i}` : `Étendre le préfixe à /${i + 1}`);
      });
      board.dec[r.key].textContent = C.toIp(values[r.key]);
    }
    board.labels.last.textContent = p <= 30 ? 'Diffusion' : 'Dernière';
    board.subs.mask.textContent = `/${p} · cliquez un bit`;

    // Accolades « partie réseau / partie hôte »
    const label = (n, word) => (n >= 6 ? `${word} · ${n} bit${n > 1 ? 's' : ''}` : String(n));
    board.segNet.hidden = p === 0;
    board.segHost.hidden = p === 32;
    if (p > 0) {
      place(board.segNet, 1, col(0), col(p - 1) + 1).textContent = label(p, 'Partie réseau');
      board.segNet.setAttribute('data-tip', `Partie réseau : ${p} bit${p > 1 ? 's' : ''}`);
    }
    if (p < 32) {
      place(board.segHost, 1, col(p), col(31) + 1).textContent = label(32 - p, 'Partie hôte');
      board.segHost.setAttribute('data-tip', `Partie hôte : ${32 - p} bit${32 - p > 1 ? 's' : ''}`);
    }
    if (board.hover !== null) describeBit(board.hover);

    // Résultats
    const hb = 32 - p;
    const chips = [
      ['Réseau', `${C.toIp(c.network)}/${p}`],
      ['Masque', C.toIp(c.mask)],
      [p <= 30 ? 'Diffusion' : 'Dernière', C.toIp(c.lastAddress)],
      ['Plage utilisable', `${C.toIp(c.firstHost)} – ${C.toIp(c.lastHost)}`, `${C.toIp(c.firstHost)}-${C.toIp(c.lastHost)}`],
      ['Hôtes', p <= 30 ? `2${sup(hb)} − 2 = ${fmt(c.usable)}` : fmt(c.usable), String(c.usable)],
    ];
    $('board-results').replaceChildren(
      ...chips.map(([label, value, copyText]) => {
        const b = h('button', { type: 'button', class: 'res-chip', 'data-tip': `Copier ${copyText || value}` }, h('span', null, label), h('strong', { class: 'mono' }, value));
        b.addEventListener('click', () => ui.copy(copyText || value, label));
        return b;
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Étape par étape
  // ---------------------------------------------------------------------------

  /** Texte avec **gras**. */
  function rich(text) {
    return String(text)
      .split(/\*\*(.+?)\*\*/)
      .map((part, i) => (i % 2 ? h('strong', null, part) : part));
  }

  const NOTE_ICONS = {
    tip: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z'],
    warn: ['M12 3 2 20h20L12 3z', 'M12 10v4', 'M12 17h.01'],
  };

  function bitsBlock(b) {
    const rows = b.rows.map((r) => {
      const s = B.bits32(r.value);
      const octs = [0, 1, 2, 3].map((o) =>
        h(
          'span',
          { class: `oct${b.focus === o ? ' focus' : ''}` },
          [...s.slice(o * 8, o * 8 + 8)].map((ch, k) => {
            const i = o * 8 + k;
            const cls = ['b'];
            if (b.split) cls.push(i < b.prefix ? 'n' : 'h');
            if (ch === '1') cls.push('one');
            if (b.split && i === b.prefix && b.prefix > 0 && b.prefix < 32) cls.push('edge');
            return h('span', { class: cls.join(' ') }, ch);
          })
        )
      );
      const cls = [r.kind === 'result' ? 'res' : '', r.sign === '=' || r.sign === 'NON' ? 'rule' : ''].filter(Boolean).join(' ');
      return h('tr', { class: cls || null }, h('th', { scope: 'row' }, r.label), h('td', { class: 'sign' }, r.sign || ''), h('td', { class: 'bits' }, octs), h('td', { class: 'dec' }, C.toIp(r.value)));
    });
    return h('div', { class: 'bitgrid-wrap' }, h('table', { class: 'bitgrid' }, h('tbody', null, rows)));
  }

  function decomposeBlock(b) {
    return h(
      'div',
      { class: 'decomp' },
      h('div', { class: 'decomp-head' }, h('span', null, `Octet n° ${b.index + 1}`), h('strong', { class: 'mono' }, String(b.value))),
      h(
        'table',
        null,
        h(
          'tbody',
          null,
          h('tr', null, h('th', null, 'Poids'), b.steps.map((s) => h('td', null, String(s.weight)))),
          h(
            'tr',
            null,
            h('th', null, 'Reste'),
            b.steps.map((s) => h('td', { 'data-tip': s.bit ? `${s.before} ≥ ${s.weight} → bit 1, reste ${s.before} − ${s.weight} = ${s.after}` : `${s.before} < ${s.weight} → bit 0, le reste reste ${s.before}` }, String(s.before)))
          ),
          h('tr', { class: 'bitrow' }, h('th', null, 'Bit'), b.steps.map((s) => h('td', { class: s.bit ? 'one' : null }, String(s.bit))))
        )
      ),
      h('div', { class: 'decomp-foot mono' }, `${b.value} = ${b.bits}`, h('span', null, b.terms.length ? ` (${b.terms.join(' + ')})` : ' (aucun bit à 1)'))
    );
  }

  function tableBlock(b) {
    const mono = new Set(b.mono || []);
    return h(
      'div',
      { class: `st-table-wrap${b.compact ? ' compact' : ''}` },
      h(
        'table',
        { class: `data st-table${b.compact ? ' compact' : ''}` },
        h('thead', null, h('tr', null, b.head.map((t) => h('th', null, t)))),
        h(
          'tbody',
          null,
          b.rows.map((r, i) =>
            h(
              'tr',
              { class: i === b.highlight ? 'current' : null },
              r.map((v, ci) => (ci === 0 && b.firstColHead ? h('th', { scope: 'row' }, v) : h('td', { class: mono.has(ci) || b.compact ? 'mono' : 'plain' }, v)))
            )
          )
        )
      )
    );
  }

  function renderBlock(b) {
    switch (b.type) {
      case 'p':
        return h('p', { class: 'st-p' }, rich(b.text));
      case 'note':
        return h('div', { class: `st-note ${b.level}` }, ui.svgIcon(NOTE_ICONS[b.level] || NOTE_ICONS.tip), h('p', null, rich(b.text)));
      case 'formula':
        return h('div', { class: 'st-formula mono' }, b.lines.map((l) => h('div', null, l)));
      case 'result':
        return h(
          'div',
          { class: 'st-result' },
          b.items.map((it) => {
            const chip = h('button', { type: 'button', class: 'res-chip accent', 'data-tip': `Copier ${it.value}` }, h('span', null, it.label), h('strong', { class: 'mono' }, it.value));
            chip.addEventListener('click', () => ui.copy(it.value, it.label));
            return chip;
          })
        );
      case 'table':
        return tableBlock(b);
      case 'bits':
        return bitsBlock(b);
      case 'decompose':
        return decomposeBlock(b);
      default:
        return null;
    }
  }

  function renderStepContent(step) {
    const out = [];
    let group = null;
    for (const b of step.blocks) {
      if (b.type === 'decompose') {
        if (!group) {
          group = h('div', { class: 'decomp-grid' });
          out.push(group);
        }
        group.append(decomposeBlock(b));
        continue;
      }
      group = null;
      out.push(renderBlock(b));
    }
    return out;
  }

  function renderSteps(animate) {
    const { steps } = B.explain(st.ip, st.prefix);
    st.step = Math.min(st.step, steps.length - 1);
    $('steps-all').checked = st.all;

    $('stepper').replaceChildren(
      ...steps.map((s, i) => {
        const b = h(
          'button',
          { type: 'button', class: `pill${i === st.step && !st.all ? ' is-current' : ''}${i < st.step && !st.all ? ' is-done' : ''}`, 'aria-current': i === st.step && !st.all ? 'step' : null, 'data-tip': s.title },
          h('span', { class: 'num' }, String(i + 1)),
          h('span', { class: 'lbl' }, s.short)
        );
        b.addEventListener('click', () => goStep(i));
        return h('li', null, b);
      })
    );

    const body = $('step-body');
    if (st.all) {
      body.replaceChildren(
        ...steps.map((s, i) =>
          h('section', { class: 'step', id: `step-${i}` }, h('h3', { class: 'step-title' }, h('span', { class: 'num' }, String(i + 1)), s.title), renderStepContent(s))
        )
      );
    } else {
      const s = steps[st.step];
      body.replaceChildren(h('section', { class: `step${animate ? ` enter-${animate}` : ''}` }, h('h3', { class: 'step-title' }, h('span', { class: 'num' }, String(st.step + 1)), s.title), renderStepContent(s)));
    }
    $('step-nav').hidden = st.all;
    $('step-prev').disabled = st.step === 0;
    $('step-next').disabled = st.step === steps.length - 1;
    $('step-count').textContent = `Étape ${st.step + 1} sur ${steps.length}`;
    $('step-next').textContent = st.step === steps.length - 2 ? 'Récapitulatif →' : 'Suivant →';
  }

  function goStep(i) {
    if (st.all) {
      const el = $(`step-${i}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (i < 0 || i > 8 || i === st.step) return;
    const dir = i > st.step ? 'next' : 'prev';
    st.step = i;
    renderSteps(dir);
    save();
    // Garde le haut de l'étape visible
    const card = $('steps-card');
    const top = card.getBoundingClientRect().top;
    if (top < 0) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------------------
  // Convertisseur
  // ---------------------------------------------------------------------------

  const FORMAT_LABELS = { decimal: 'décimal pointé', binary: 'binaire', hex: 'hexadécimal', integer: 'entier 32 bits' };
  let converted = null;

  function renderConverter() {
    const text = $('conv-in').value;
    const err = $('conv-error');
    converted = null;
    if (!text.trim()) {
      err.hidden = true;
      $('conv-table').replaceChildren();
      $('conv-format').textContent = '';
      $('conv-use').hidden = true;
      return;
    }
    try {
      const res = B.parseAnyIp(text);
      converted = res.value;
      err.hidden = true;
      const f = B.formats(res.value);
      $('conv-format').textContent = `Format reconnu : ${FORMAT_LABELS[res.format]}`;
      $('conv-table').replaceChildren(
        h(
          'tbody',
          null,
          ui.kvRow('Décimal pointé', f.decimal, null, f.decimal),
          ui.kvRow('Binaire', f.binary, null, f.binary),
          ui.kvRow('Hexadécimal', f.hex, f.hexDotted, f.hex),
          ui.kvRow('Entier 32 bits', fmt(Number(f.integer)), null, f.integer),
          ui.kvRow('Type', C.addressType(res.value).label, `classe ${C.ipClass(res.value)}`)
        )
      );
      $('conv-use').hidden = false;
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      $('conv-table').replaceChildren();
      $('conv-format').textContent = '';
      $('conv-use').hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Octet à la loupe
  // ---------------------------------------------------------------------------

  let octet = 168;

  function buildOctet() {
    $('octet-bits').replaceChildren(
      ...B.WEIGHTS.map((w, i) => {
        const b = h('button', { type: 'button', class: 'obit', 'data-i': i, 'aria-label': `Bit de poids ${w}` }, h('span', { class: 'v' }), h('span', { class: 'w' }, String(w)), h('span', { class: 'p' }, `2${sup(7 - i)}`));
        b.addEventListener('click', () => setOctet(octet ^ w));
        return b;
      })
    );
    $('octet-dec').addEventListener('input', () => {
      const raw = $('octet-dec').value.trim();
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < 0 || n > 255) {
        $('octet-dec').classList.toggle('invalid', raw !== '');
        return;
      }
      $('octet-dec').classList.remove('invalid');
      setOctet(n, true);
    });
  }

  function setOctet(n, fromInput) {
    octet = n;
    if (!fromInput) {
      $('octet-dec').value = String(n);
      $('octet-dec').classList.remove('invalid');
    }
    const d = B.decompose(n);
    [...$('octet-bits').children].forEach((b, i) => {
      const on = d.bits[i] === '1';
      b.classList.toggle('one', on);
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('.v').textContent = d.bits[i];
    });
    $('octet-out').replaceChildren(h('span', null, h('small', null, 'Binaire'), h('strong', { class: 'mono' }, d.bits)), h('span', null, h('small', null, 'Hexa'), h('strong', { class: 'mono' }, `0x${n.toString(16).toUpperCase().padStart(2, '0')}`)));
    $('octet-sum').textContent = d.terms.length ? `${d.terms.join(' + ')} = ${n}` : 'Aucun bit à 1 = 0';
    const bits = B.maskOctetBits(n);
    $('octet-mask').textContent =
      bits === null
        ? 'Pas une valeur de masque : dans un masque, les bits à 1 sont tous collés à gauche.'
        : bits === 0
          ? 'Valeur de masque possible : 0 bit à 1 (octet entièrement côté hôte).'
          : bits === 8
            ? 'Valeur de masque possible : 8 bits à 1 (octet entièrement côté réseau).'
            : `Valeur de masque possible : ${bits} bit${bits > 1 ? 's' : ''} à 1 · nombre magique 256 − ${n} = ${256 - n}.`;
  }

  // ---------------------------------------------------------------------------
  // Entraînement
  // ---------------------------------------------------------------------------

  const FIELD_TIPS = {
    mask: 'Préfixe /n : n bits à 1 puis des 0. Convertissez chaque octet en décimal.',
    network: 'Adresse ET masque : partie hôte à 0.',
    broadcast: 'Réseau OU wildcard : partie hôte à 1.',
    first: 'Adresse réseau + 1.',
    last: 'Adresse de diffusion − 1.',
    hosts: '2^h − 2, avec h = 32 − préfixe.',
  };
  const train = { ex: null, checked: false, won: false, revealed: false, tried: 0, solved: 0 };

  function buildTraining() {
    $('train-grid').replaceChildren(
      ...B.EXERCISE_FIELDS.map((f) =>
        h(
          'label',
          { class: 'train-field', 'data-key': f.key },
          h('span', { class: 'label', 'data-tip': FIELD_TIPS[f.key] }, f.label),
          h('input', { type: 'text', class: 'mono', id: `tr-${f.key}`, spellcheck: 'false', autocomplete: 'off', inputmode: f.kind === 'ip' ? 'decimal' : 'numeric', placeholder: f.kind === 'ip' ? 'a.b.c.d' : 'nombre' }),
          h('span', { class: 'train-fb' })
        )
      )
    );
    document.querySelectorAll('#train-level button').forEach((b) =>
      b.addEventListener('click', () => {
        st.level = b.dataset.level;
        save();
        renderLevel();
        newExercise();
      })
    );
    $('train-grid').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        checkTraining();
      }
    });
    $('train-grid').addEventListener('input', (e) => {
      const field = e.target.closest('.train-field');
      if (field) field.classList.remove('ok', 'ko');
    });
    $('train-check').addEventListener('click', checkTraining);
    $('train-reveal').addEventListener('click', revealTraining);
    $('train-new').addEventListener('click', newExercise);
    $('train-explain').addEventListener('click', () => {
      if (!train.ex) return;
      st.step = 0;
      setAddress(train.ex.ip, train.ex.prefix);
      $('workshop-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function renderLevel() {
    document.querySelectorAll('#train-level button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.level === st.level)));
    $('train-help').textContent = B.LEVELS[st.level].help;
  }

  function renderScore() {
    $('train-score').textContent = train.tried ? `Réussis : ${train.solved} / ${train.tried}` : '';
  }

  function newExercise() {
    train.ex = B.makeExercise(st.level);
    train.checked = false;
    train.won = false;
    train.revealed = false;
    $('train-ip').textContent = `${C.toIp(train.ex.ip)}/${train.ex.prefix}`;
    document.querySelectorAll('.train-field').forEach((f) => {
      f.classList.remove('ok', 'ko');
      f.querySelector('input').value = '';
      f.querySelector('.train-fb').textContent = '';
    });
    $('train-result').hidden = true;
    $('train-explain').hidden = true;
    renderScore();
  }

  function answers() {
    const out = {};
    for (const f of B.EXERCISE_FIELDS) out[f.key] = $(`tr-${f.key}`).value;
    return out;
  }

  function checkTraining() {
    if (!train.ex) return;
    const res = B.checkExercise(train.ex, answers());
    if (!train.checked) {
      train.checked = true;
      train.tried += 1;
    }
    for (const f of B.EXERCISE_FIELDS) {
      const r = res.fields[f.key];
      const el = document.querySelector(`.train-field[data-key="${f.key}"]`);
      el.classList.toggle('ok', r.ok);
      el.classList.toggle('ko', !r.ok && !r.empty);
      el.querySelector('.train-fb').textContent = train.revealed && !r.ok ? `Réponse : ${r.expected}` : r.error || '';
    }
    const result = $('train-result');
    result.hidden = false;
    result.className = `train-result ${res.score === res.total ? 'ok' : 'ko'}`;
    if (res.score === res.total) {
      result.textContent = train.revealed ? 'Tout est juste (avec la correction).' : 'Tout est juste, bravo ! Passez au suivant ou augmentez le niveau.';
      if (!train.won && !train.revealed) {
        train.won = true;
        train.solved += 1;
        ui.toast('Exercice réussi.');
      }
    } else {
      result.textContent = `${res.score} / ${res.total} réponse${res.score > 1 ? 's' : ''} juste${res.score > 1 ? 's' : ''}. Corrigez les champs en rouge, ou affichez la correction.`;
    }
    renderScore();
  }

  function revealTraining() {
    if (!train.ex) return;
    if (!train.checked) {
      train.checked = true;
      train.tried += 1;
    }
    train.revealed = true;
    const res = B.checkExercise(train.ex, answers());
    for (const f of B.EXERCISE_FIELDS) {
      const r = res.fields[f.key];
      const el = document.querySelector(`.train-field[data-key="${f.key}"]`);
      el.classList.toggle('ok', r.ok);
      el.classList.toggle('ko', !r.ok);
      el.querySelector('.train-fb').textContent = r.ok ? '' : `Réponse : ${r.expected}`;
    }
    const result = $('train-result');
    result.hidden = false;
    result.className = 'train-result info';
    result.textContent = 'Correction affichée. Ouvrez le calcul pas à pas pour comprendre chaque réponse.';
    $('train-explain').hidden = false;
    renderScore();
  }

  // ---------------------------------------------------------------------------
  // Mémo
  // ---------------------------------------------------------------------------

  function buildMemo() {
    const pow = [];
    for (let n = 0; n <= 16; n++) pow.push([n, 2 ** n]);
    pow.push([24, 2 ** 24], [32, 2 ** 32]);
    $('memo-pow').replaceChildren(
      h('thead', null, h('tr', null, h('th', null, 'n'), h('th', null, '2ⁿ'), h('th', null, '2ⁿ − 2'))),
      h('tbody', null, pow.map(([n, v]) => h('tr', null, h('td', null, `2${sup(n)}`), h('td', null, fmt(v)), h('td', null, n >= 2 ? fmt(v - 2) : '—'))))
    );
    $('memo-mask').replaceChildren(
      h('thead', null, h('tr', null, h('th', null, 'Bits à 1'), h('th', null, 'Binaire'), h('th', null, 'Décimal'), h('th', null, 'Pas'))),
      h('tbody', null, B.MASK_OCTETS.map((v, i) => h('tr', null, h('td', null, String(i)), h('td', null, B.octetBits(v)), h('td', null, String(v)), h('td', null, String(256 - v)))))
    );
    const rows = [];
    for (let p = 0; p <= 32; p++) {
      rows.push(h('tr', { 'data-prefix': p }, h('td', null, `/${p}`), h('td', null, C.toIp(C.prefixToMask(p))), h('td', null, fmt(2 ** (32 - p))), h('td', null, fmt(C.usableCount(p)))));
    }
    $('memo-cidr').replaceChildren(h('thead', null, h('tr', null, h('th', null, 'Préfixe'), h('th', null, 'Masque'), h('th', null, 'Adresses'), h('th', null, 'Hôtes'))), h('tbody', null, rows));
    $('memo-cidr').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-prefix]');
      if (tr) setAddress(st.ip, Number(tr.dataset.prefix));
    });
    $('memo-hosts').addEventListener('input', renderHostsHelper);
    $('memo-hosts-apply').addEventListener('click', () => {
      const p = hostsPrefix();
      if (p !== null) {
        setAddress(st.ip, p);
        $('workshop-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    renderHostsHelper();
  }

  function hostsPrefix() {
    try {
      return C.prefixForHosts($('memo-hosts').value);
    } catch {
      return null;
    }
  }

  function renderHostsHelper() {
    const out = $('memo-hosts-out');
    const raw = $('memo-hosts').value;
    $('memo-hosts-apply').disabled = true;
    if (!raw.trim()) {
      out.replaceChildren('Indiquez un nombre de machines : CalkIP déroule le calcul du préfixe.');
      return;
    }
    let p;
    try {
      p = C.prefixForHosts(raw);
    } catch (err) {
      out.replaceChildren(err.message);
      return;
    }
    const n = Number(raw.trim());
    const hb = 32 - p;
    const lines =
      p >= 31
        ? [`${fmt(n)} adresse${n > 1 ? 's' : ''} → /${p} (${p === 31 ? 'liaison point à point, RFC 3021' : 'une seule machine'})`]
        : [
            `On cherche le plus petit h tel que 2^h − 2 ≥ ${fmt(n)}`,
            hb > 2 ? `h = ${hb - 1} : 2${sup(hb - 1)} − 2 = ${fmt(2 ** (hb - 1) - 2)}  → trop petit` : null,
            `h = ${hb} : 2${sup(hb)} − 2 = ${fmt(2 ** hb - 2)}  → suffisant`,
            `Préfixe = 32 − ${hb} = /${p}  ·  masque ${C.toIp(C.prefixToMask(p))}`,
          ].filter(Boolean);
    out.replaceChildren(...lines.map((l) => h('div', null, l)));
    $('memo-hosts-apply').disabled = false;
  }

  function highlightMemo() {
    document.querySelectorAll('#memo-cidr tr.current').forEach((tr) => tr.classList.remove('current'));
    const row = document.querySelector(`#memo-cidr tr[data-prefix="${st.prefix}"]`);
    if (row) {
      row.classList.add('current');
      const wrap = row.closest('.table-wrap');
      if (wrap && !$('view-binary').hidden) wrap.scrollTop = row.offsetTop - wrap.clientHeight / 2 + row.clientHeight / 2;
    }
  }

  // ---------------------------------------------------------------------------
  // Rafraîchissement, synchronisation avec la calculatrice
  // ---------------------------------------------------------------------------

  let lastExplained = null;
  function refresh() {
    renderHead();
    renderBoard();
    const key = `${st.ip}/${st.prefix}`;
    if (key !== lastExplained) {
      lastExplained = key;
      renderSteps(null);
    }
    highlightMemo();
    save();
  }

  /** Reprend l'adresse de la calculatrice (si elle a changé depuis la dernière reprise, ou si force). */
  function syncFrom(data, force) {
    if (!data) return false;
    const label = `${C.toIp(data.calc.ip)}/${data.calc.prefix}`;
    if (!force && label === st.synced) return false;
    st.synced = label;
    setAddress(data.calc.ip, data.calc.prefix);
    return true;
  }

  function exportSteps() {
    ui.api.exportBinary({ ip: C.toIp(st.ip), prefix: st.prefix }).then((res) => {
      if (res && res.ok) ui.toast(`Calcul enregistré : ${res.filePath}`);
      else if (res && !res.canceled) ui.toast(res.error || 'Export impossible.');
    });
  }

  function init(tools) {
    ui = tools;
    h = tools.h;
    restore();
    $('b-ip').value = `${C.toIp(st.ip)}/${st.prefix}`;

    let debounce = null;
    $('b-ip').addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(readField, 150);
    });
    $('b-ip').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounce);
        readField();
      }
    });
    $('b-prefix').addEventListener('input', () => setAddress(st.ip, Number($('b-prefix').value)));
    $('b-prefix-dec').addEventListener('click', () => st.prefix > 0 && setAddress(st.ip, st.prefix - 1));
    $('b-prefix-inc').addEventListener('click', () => st.prefix < 32 && setAddress(st.ip, st.prefix + 1));
    $('b-sync').addEventListener('click', () => {
      if (!tools.getData()) {
        ui.toast('La calculatrice n\'a pas encore d\'adresse valide.');
        return;
      }
      syncFrom(tools.getData(), true);
      ui.toast('Adresse de la calculatrice reprise.');
    });

    $('steps-all').addEventListener('change', () => {
      st.all = $('steps-all').checked;
      renderSteps(null);
      save();
    });
    $('step-prev').addEventListener('click', () => goStep(st.step - 1));
    $('step-next').addEventListener('click', () => goStep(st.step + 1));
    $('steps-copy').addEventListener('click', () => ui.copy(B.explainLines(st.ip, st.prefix).join('\n'), 'Calcul'));
    $('steps-export').addEventListener('click', exportSteps);

    $('conv-in').addEventListener('input', renderConverter);
    $('conv-use').addEventListener('click', () => {
      if (converted === null) return;
      setAddress(converted, st.prefix);
      $('workshop-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    buildOctet();
    setOctet(octet);
    buildTraining();
    renderLevel();
    newExercise();
    buildMemo();
    refresh();
  }

  /** Appelé à chaque ouverture de l'onglet. */
  function onShow(data) {
    syncFrom(data, false);
    highlightMemo();
  }

  /** Raccourcis clavier propres à l'onglet (flèches : étapes). */
  function onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'ArrowRight' && !st.all) {
      goStep(st.step + 1);
      return true;
    }
    if (e.key === 'ArrowLeft' && !st.all) {
      goStep(st.step - 1);
      return true;
    }
    return false;
  }

  window.BinaryView = { init, onShow, onKey, syncFrom, exportSteps, focusSteps: () => $('steps-card').scrollIntoView({ behavior: 'smooth', block: 'start' }) };
})();
