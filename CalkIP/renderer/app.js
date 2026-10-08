/*
 * app.js — Interface de CalkIP.
 *
 * Les calculs viennent de lib/ipcalc.js (objet global IPCalc) et se font pendant la frappe.
 * L'export des listes passe par le processus principal (window.calkip), qui refait le calcul.
 * Le DOM est construit sans innerHTML. Aucune connexion réseau.
 */
'use strict';

(() => {
  const C = window.IPCalc;
  const api = window.calkip;
  const $ = (id) => document.getElementById(id);
  const fmt = C.formatNumber;

  const STORE_KEY = 'calkip.form';
  const HISTORY_KEY = 'calkip.history';
  const SPLIT_PAGE = 256;
  const BIG_EXPORT_BYTES = 50 * 1024 * 1024; // au-delà : confirmation avant l'export

  const state = {
    mode: 'auto', // 'auto' | '8' | '16' | '24' | '32' | 'custom'
    data: null, // { parsed, calc, pool, poolError, reason }
    splitShown: SPLIT_PAGE,
    exporting: false,
    confirmArmed: false,
  };

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function svgIcon(paths) {
    const ns = 'http://www.w3.org/2000/svg';
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

  const COPY_ICON = ['M9 9h10v10H9z', 'M5 15V5h10'];

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function formatBytes(bytes) {
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

  const storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
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

  async function copy(text, label) {
    const res = await api.copy(text);
    // Tournure neutre : pas d'accord à deviner (« Masque », « Diffusion »…)
    toast(res && res.ok ? `Copié dans le presse-papiers${label ? ` : ${label.charAt(0).toLowerCase()}${label.slice(1)}` : ''}.` : 'Copie impossible.');
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
      let left = r.left + r.width / 2 - t.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
      let top = r.bottom + 8;
      if (top + t.height > window.innerHeight - 8) top = r.top - t.height - 8;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    });
    document.addEventListener('scroll', () => (tip.hidden = true), true);
  }

  // ---------------------------------------------------------------------------
  // Formulaire
  // ---------------------------------------------------------------------------

  function currentModeValue() {
    if (state.mode === 'auto') return 'auto';
    if (state.mode === 'custom') return Number($('custom-prefix').value);
    return Number(state.mode);
  }

  function dhcpOptions() {
    return {
      gateway: (document.querySelector('input[name="gateway"]:checked') || {}).value || 'first',
      customGateway: $('custom-gateway').value,
      reserveStart: Number($('reserve-start').value) || 0,
      reserveEnd: Number($('reserve-end').value) || 0,
      exclusions: $('exclusions').value,
      limit: $('lease-limit').value,
    };
  }

  /** Requête complète, telle qu'envoyée au processus principal pour les exports. */
  function request() {
    return { input: $('ip').value, mode: currentModeValue(), dhcp: dhcpOptions() };
  }

  function setMode(mode) {
    state.mode = String(mode);
    document.querySelectorAll('#mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
    $('custom-row').hidden = state.mode !== 'custom';
  }

  function saveForm() {
    const d = dhcpOptions();
    storage.set(STORE_KEY, {
      input: $('ip').value,
      mode: state.mode,
      customPrefix: $('custom-prefix').value,
      ...d,
      scope: (document.querySelector('input[name="scope"]:checked') || {}).value,
      numbered: $('numbered').checked,
    });
  }

  function restoreForm() {
    const s = storage.get(STORE_KEY, null);
    if (!s) return;
    $('ip').value = s.input || '';
    if (s.customPrefix) $('custom-prefix').value = s.customPrefix;
    setMode(['auto', '8', '16', '24', '32', 'custom'].includes(s.mode) ? s.mode : 'auto');
    const gw = document.querySelector(`input[name="gateway"][value="${s.gateway}"]`);
    if (gw) gw.checked = true;
    $('custom-gateway').value = s.customGateway || '';
    $('reserve-start').value = Number(s.reserveStart) || 0;
    $('reserve-end').value = Number(s.reserveEnd) || 0;
    $('exclusions').value = s.exclusions || '';
    $('lease-limit').value = s.limit || '';
    const scope = document.querySelector(`input[name="scope"][value="${s.scope}"]`);
    if (scope) scope.checked = true;
    $('numbered').checked = Boolean(s.numbered);
  }

  // ---------------------------------------------------------------------------
  // Calcul
  // ---------------------------------------------------------------------------

  function showFieldError(id, message) {
    const el = $(id);
    el.textContent = message || '';
    el.hidden = !message;
  }

  function compute() {
    const input = $('ip').value;
    $('custom-gateway').hidden = dhcpOptions().gateway !== 'custom';
    showFieldError('dhcp-error', '');
    if (!input.trim()) {
      state.data = null;
      showFieldError('ip-error', '');
      $('ip').classList.remove('invalid');
      $('mode-help').textContent = modeHelpIdle();
      return;
    }
    let parsed;
    let resolved;
    try {
      parsed = C.parseInput(input);
      resolved = C.resolvePrefix(parsed, currentModeValue());
    } catch (err) {
      state.data = null;
      showFieldError('ip-error', err.message);
      $('ip').classList.add('invalid');
      $('mode-help').textContent = modeHelpIdle();
      return;
    }
    showFieldError('ip-error', '');
    $('ip').classList.remove('invalid');

    const calc = C.calculate(parsed.ip, resolved.prefix);
    let pool = null;
    let poolError = null;
    try {
      pool = C.dhcpPool(calc, dhcpOptions());
    } catch (err) {
      poolError = err.message;
      showFieldError('dhcp-error', err.message);
    }
    const previous = state.data;
    state.data = { parsed, calc, pool, poolError, reason: resolved.reason };
    // Nouveau réseau : on repart du début de la liste des sous-réseaux
    if (!previous || previous.calc.network !== calc.network || previous.calc.prefix !== calc.prefix) state.splitShown = SPLIT_PAGE;

    let help = `Préfixe utilisé : /${calc.prefix} — ${resolved.reason}.`;
    if (state.mode !== 'auto' && parsed.prefix !== null && parsed.prefix !== calc.prefix) {
      help += ` Le /${parsed.prefix} saisi est ignoré (mode manuel) : choisissez « Auto » pour l'utiliser.`;
    }
    $('mode-help').textContent = help;
  }

  function modeHelpIdle() {
    return state.mode === 'auto'
      ? 'Auto : utilise le préfixe ou le masque saisi, sinon celui de la classe (A → /8, B → /16, C → /24).'
      : 'Le préfixe choisi s\'applique à l\'adresse saisie.';
  }

  // ---------------------------------------------------------------------------
  // Affichage des résultats
  // ---------------------------------------------------------------------------

  function copyButton(text, label) {
    const b = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Copier ${label}`, 'data-tip': `Copier ${text}` }, svgIcon(COPY_ICON));
    b.addEventListener('click', () => copy(text, label));
    return b;
  }

  /** Ligne de tableau : [libellé, valeur (texte ou nœud), sous-texte, texte à copier]. */
  function kvRow(label, value, sub, copyText, tip) {
    return h(
      'tr',
      null,
      h('th', { scope: 'row', 'data-tip': tip || null }, label),
      h('td', null, value, copyText ? copyButton(copyText, label.toLowerCase()) : null, sub ? h('span', { class: 'sub' }, sub) : null)
    );
  }

  function goToNetwork(ip, prefix) {
    $('ip').value = `${C.toIp(ip)}/${prefix}`;
    setMode('auto');
    update();
    $('results').scrollTop = 0;
  }

  const TYPE_LEVEL = { private: 'ok', public: 'info', cgnat: 'accent', linklocal: 'warn', loopback: 'warn', multicast: 'warn', reserved: 'crit', documentation: 'warn', thisnetwork: 'crit', broadcast: 'crit' };

  function renderHero(d) {
    const { calc, pool } = d;
    $('hero-net').textContent = `${C.toIp(calc.network)}/${calc.prefix}`;
    $('hero-tags').replaceChildren(
      h('span', { class: `tag ${TYPE_LEVEL[calc.type.kind] || ''}`, 'data-tip': calc.type.help }, calc.type.label),
      h('span', { class: 'tag', 'data-tip': calc.classfulPrefix ? `Classe ${calc.ipClass} : masque historique /${calc.classfulPrefix}.` : `Classe ${calc.ipClass} : pas de masque par défaut.` }, `Classe ${calc.ipClass}`),
      h('span', { class: 'tag accent' }, `Masque ${C.toIp(calc.mask)}`)
    );
    $('stat-leases').textContent = pool ? fmt(pool.leases) : '—';
    $('stat-leases-label').textContent = pool && pool.limit !== null ? `Baux DHCP (${fmt(pool.limit)} demandés)` : 'Baux DHCP maximum';
    $('stat-usable').textContent = fmt(calc.usable);
    $('stat-total').textContent = fmt(calc.total);

    // Avertissements sur l'adresse saisie
    const notes = [];
    if (calc.role === 'network') notes.push(`${C.toIp(calc.ip)} est l'adresse du réseau lui-même : elle n'est pas attribuable à un appareil.`);
    if (calc.role === 'broadcast') notes.push(`${C.toIp(calc.ip)} est l'adresse de diffusion du réseau : elle n'est pas attribuable à un appareil.`);
    if (['loopback', 'multicast', 'reserved', 'thisnetwork', 'broadcast', 'linklocal', 'documentation'].includes(calc.type.kind)) notes.push(calc.type.help);
    $('role-note').textContent = notes.join(' ');
    $('role-note').hidden = !notes.length;
  }

  function renderNetwork(d) {
    const { calc, parsed } = d;
    const ipText = C.toIp(calc.ip);
    const roleText = { network: 'adresse du réseau', broadcast: 'adresse de diffusion', host: `hôte n° ${fmt(calc.prefix >= 31 ? calc.offset + 1 : calc.offset)} du réseau` }[calc.role];
    const neighbor = (ip) => {
      if (ip === null) return '—';
      const b = h('button', { type: 'button', class: 'link' }, `${C.toIp(ip)}/${calc.prefix}`);
      b.addEventListener('click', () => goToNetwork(ip, calc.prefix));
      return b;
    };
    $('network-table').replaceChildren(
      h(
        'tbody',
        null,
        kvRow('Adresse saisie', ipText, roleText, ipText),
        kvRow('Adresse réseau', C.toIp(calc.network), null, C.toIp(calc.network)),
        kvRow('Masque', `${C.toIp(calc.mask)}`, `/${calc.prefix} · ${C.toHex(calc.mask)}`, C.toIp(calc.mask)),
        kvRow('Masque générique (wildcard)', C.toIp(calc.wildcard), 'utilisé dans les ACL Cisco et OSPF', C.toIp(calc.wildcard), 'Inverse du masque : les bits à 1 désignent la partie hôte.'),
        kvRow('Diffusion (broadcast)', calc.broadcast === null ? 'aucune' : C.toIp(calc.broadcast), calc.broadcast === null ? (calc.prefix === 31 ? 'liaison point à point (RFC 3021)' : 'une seule adresse') : null, calc.broadcast === null ? null : C.toIp(calc.broadcast)),
        kvRow('Première adresse utilisable', C.toIp(calc.firstHost), null, C.toIp(calc.firstHost)),
        kvRow('Dernière adresse utilisable', C.toIp(calc.lastHost), null, C.toIp(calc.lastHost)),
        kvRow('Plage utilisable', `${C.toIp(calc.firstHost)} – ${C.toIp(calc.lastHost)}`, null, `${C.toIp(calc.firstHost)}-${C.toIp(calc.lastHost)}`),
        kvRow('Notation CIDR', `${C.toIp(calc.network)}/${calc.prefix}`, null, `${C.toIp(calc.network)}/${calc.prefix}`),
        kvRow(
          'Zone DNS inverse',
          calc.reverseZone,
          calc.reverseZoneExact ? null : 'préfixe non multiple de 8 : zone englobante (délégation RFC 2317 nécessaire)',
          calc.reverseZone
        ),
        kvRow('Réseau précédent', neighbor(calc.previousNetwork)),
        kvRow('Réseau suivant', neighbor(calc.nextNetwork)),
        parsed.prefix !== null && parsed.prefix !== calc.prefix ? kvRow('Préfixe saisi (ignoré)', `/${parsed.prefix}`, 'mode manuel actif') : null
      )
    );
  }

  function renderPool(d) {
    const { calc, pool, poolError } = d;
    const bar = $('poolbar');
    const legend = $('pool-legend');
    if (!pool) {
      bar.replaceChildren();
      legend.replaceChildren();
      $('pool-table').replaceChildren(h('tbody', null, kvRow('Plage DHCP', poolError || 'Réglages invalides')));
      $('pool-notes').replaceChildren();
      return;
    }
    // Répartition des adresses utilisables : passerelle, réservées (tout le reste), distribuables, exclues,
    // et libres (au-delà du nombre de baux demandé)
    const gw = pool.gateway !== null ? 1 : 0;
    const reserved = Math.max(0, calc.usable - pool.leases - pool.excludedCount - gw - pool.free);
    const segs = [
      ['seg-gw', gw, 'Passerelle'],
      ['seg-res', reserved, 'Réservées'],
      ['seg-pool', pool.leases, 'Baux distribués'],
      ['seg-exc', pool.excludedCount, 'Exclues'],
      ['seg-free', pool.free, 'Libres'],
    ].filter(([, n]) => n > 0);
    bar.replaceChildren(...segs.map(([cls, n, label]) => h('span', { class: cls, style: null, 'data-tip': `${label} : ${fmt(n)}` })));
    // Largeurs via le CSSOM (la CSP interdit les attributs style en ligne)
    [...bar.children].forEach((el, i) => (el.style.flex = `${segs[i][1]} 0 0`));
    legend.replaceChildren(...segs.map(([cls, n, label]) => h('span', null, h('i', { class: cls }), `${label} (${fmt(n)})`)));

    const exclusionText = pool.excluded.length
      ? pool.excluded
          .slice(0, 4)
          .map(([a, b]) => (a === b ? C.toIp(a) : `${C.toIp(a)} – ${C.toIp(b)}`))
          .join(', ') + (pool.excluded.length > 4 ? '…' : '')
      : null;

    $('pool-table').replaceChildren(
      h(
        'tbody',
        null,
        kvRow('Passerelle', pool.gateway === null ? 'aucune réservée' : C.toIp(pool.gateway), null, pool.gateway === null ? null : C.toIp(pool.gateway)),
        pool.reserveStart ? kvRow('Réservées au début', fmt(pool.reserveStart)) : null,
        pool.reserveEnd ? kvRow('Réservées à la fin', fmt(pool.reserveEnd)) : null,
        kvRow('Début de la plage DHCP', pool.start === null ? '—' : C.toIp(pool.start), null, pool.start === null ? null : C.toIp(pool.start)),
        kvRow('Fin de la plage DHCP', pool.end === null ? '—' : C.toIp(pool.end), null, pool.end === null ? null : C.toIp(pool.end)),
        pool.excludedCount ? kvRow('Exclues dans la plage', fmt(pool.excludedCount), exclusionText) : null,
        pool.limit !== null ? kvRow('Baux demandés', fmt(pool.limit), pool.shortage ? `il en manque ${fmt(pool.shortage)} : réseau trop petit` : null) : null,
        pool.free ? kvRow('Laissées libres', fmt(pool.free), 'distribuables mais hors de la plage (au-delà des baux demandés)') : null,
        kvRow(
          pool.limit !== null ? 'Baux DHCP' : 'Baux DHCP maximum',
          h('strong', null, fmt(pool.leases)),
          pool.limit !== null && !pool.shortage
            ? `${fmt(pool.available)} possibles sur ce réseau`
            : pool.leases === calc.usable
              ? 'toutes les adresses utilisables'
              : `${fmt(calc.usable - pool.leases)} adresse(s) gardée(s) hors DHCP`
        )
      )
    );
    $('pool-notes').replaceChildren(...pool.notes.map((n) => h('li', null, n)));
  }

  /** Bits colorés : partie réseau / partie hôte. */
  function bits(binary, prefix) {
    const wrap = h('span');
    let index = 0;
    let run = '';
    let runNet = null;
    const flush = () => {
      if (run) wrap.append(h('span', { class: runNet ? 'bits-net' : 'bits-host' }, run));
      run = '';
    };
    for (const ch of binary) {
      if (ch === '.') {
        run += '.';
        continue;
      }
      const isNet = index < prefix;
      if (runNet !== null && isNet !== runNet) flush();
      runNet = isNet;
      run += ch;
      index++;
    }
    flush();
    return wrap;
  }

  function renderBinary(d) {
    const { calc } = d;
    $('binary-table').replaceChildren(
      h(
        'tbody',
        null,
        kvRow('Adresse', bits(calc.binary.ip, calc.prefix), C.toHex(calc.ip)),
        kvRow('Masque', bits(calc.binary.mask, calc.prefix), C.toHex(calc.mask)),
        kvRow('Réseau', bits(calc.binary.network, calc.prefix), C.toHex(calc.network))
      )
    );
  }

  // --- Export : nombres, estimation de taille ---

  function exportScope() {
    return (document.querySelector('input[name="scope"]:checked') || {}).value === 'usable' ? 'usable' : 'pool';
  }

  /** Taille estimée du fichier : longueur moyenne mesurée sur 1 000 adresses réparties dans la plage. */
  function estimate(d) {
    const scope = exportScope();
    const count = scope === 'pool' ? (d.pool ? d.pool.leases : 0) : d.calc.usable;
    const first = scope === 'pool' ? d.pool && d.pool.start : d.calc.firstHost;
    const last = scope === 'pool' ? d.pool && d.pool.end : d.calc.lastHost;
    if (!count || first === null || first === undefined) return { count: 0, bytes: 0 };
    const samples = Math.min(1000, last - first + 1);
    let chars = 0;
    for (let i = 0; i < samples; i++) chars += C.toIp(first + Math.floor(((last - first) * i) / Math.max(1, samples - 1))).length;
    const numbering = $('numbered').checked ? String(count).length + 2 : 0;
    return { count, bytes: Math.round(count * (chars / samples + 2 + numbering) + 1600) };
  }

  function renderExport(d) {
    $('scope-pool-count').textContent = d.pool ? `(${fmt(d.pool.leases)})` : '';
    $('scope-usable-count').textContent = `(${fmt(d.calc.usable)})`;
    const est = estimate(d);
    const el = $('estimate');
    el.classList.remove('warn');
    disarmConfirm();
    if (!est.count) {
      el.replaceChildren('Aucune adresse à exporter avec ces réglages.');
      $('export-list').disabled = true;
    } else if (est.count > C.EXPORT_LIMIT) {
      el.replaceChildren(`${fmt(est.count)} adresses : au-delà de la limite d'export (un /8, ${fmt(C.EXPORT_LIMIT)} adresses). Exportez le résumé ou découpez le réseau.`);
      el.classList.add('warn');
      $('export-list').disabled = true;
    } else {
      el.replaceChildren(h('strong', null, `${fmt(est.count)} ligne${est.count > 1 ? 's' : ''}`), ` · environ ${formatBytes(est.bytes)}`);
      if (est.bytes > BIG_EXPORT_BYTES) {
        el.classList.add('warn');
        el.append(' — fichier volumineux, quelques secondes d\'écriture.');
      }
      $('export-list').disabled = state.exporting;
    }
    $('export-summary').disabled = state.exporting;
  }

  // --- Découpage ---

  function renderSplitOptions(d) {
    const select = $('split-prefix');
    const current = Number(select.value);
    const options = [];
    for (let p = d.calc.prefix + 1; p <= 32; p++) {
      const count = 2 ** (p - d.calc.prefix);
      options.push(h('option', { value: String(p) }, `/${p} — ${fmt(count)} × ${fmt(C.usableCount(p))} hôtes`));
    }
    select.replaceChildren(...options);
    if (!options.length) return;
    const fallback = Math.min(32, d.calc.prefix + (d.calc.prefix >= 24 ? 1 : 2));
    select.value = String(current > d.calc.prefix && current <= 32 ? current : fallback);
  }

  function renderSplit(d) {
    const { calc } = d;
    const table = $('split-table');
    const more = $('split-more');
    if (calc.prefix >= 32) {
      $('split-info').textContent = 'Un /32 ne contient qu\'une adresse : il ne peut pas être découpé.';
      table.replaceChildren();
      more.hidden = true;
      $('export-split').disabled = true;
      return;
    }
    const p = Number($('split-prefix').value);
    const res = C.splitSubnets(calc, p, state.splitShown);
    $('split-info').textContent = `${fmt(res.count)} sous-réseaux /${res.prefix} de ${fmt(res.size)} adresses (${fmt(res.usablePerSubnet)} utilisables chacun). Le sous-réseau qui contient l'adresse saisie est surligné.`;
    $('export-split').disabled = res.count > 2 ** 20 || state.exporting;
    if (res.count > 2 ** 20) $('split-info').textContent += ` Trop nombreux pour un export (limite ${fmt(2 ** 20)}).`;
    const head = h('thead', null, h('tr', null, ['N°', 'Réseau', 'Première', 'Dernière', 'Diffusion', 'Hôtes'].map((t) => h('th', null, t))));
    const rows = res.subnets.map((s, i) =>
      h(
        'tr',
        { class: calc.ip >= s.network && calc.ip <= s.lastAddress ? 'current' : null },
        h('td', null, fmt(i + 1)),
        h('td', null, `${C.toIp(s.network)}/${s.prefix}`),
        h('td', null, C.toIp(s.firstHost)),
        h('td', null, C.toIp(s.lastHost)),
        h('td', null, s.broadcast === null ? '—' : C.toIp(s.broadcast)),
        h('td', null, fmt(s.usable))
      )
    );
    table.replaceChildren(head, h('tbody', null, rows));
    more.hidden = res.subnets.length >= res.count;
    more.textContent = `Afficher ${fmt(Math.min(SPLIT_PAGE, res.count - res.subnets.length))} de plus (${fmt(res.subnets.length)} / ${fmt(res.count)})`;
  }

  function render() {
    const d = state.data;
    $('empty').hidden = Boolean(d);
    $('output').hidden = !d;
    if (!d) return;
    renderHero(d);
    renderNetwork(d);
    renderPool(d);
    renderExport(d);
    renderBinary(d);
    renderSplitOptions(d);
    renderSplit(d);
  }

  let historyTimer = null;
  function update() {
    compute();
    render();
    saveForm();
    // L'historique retient une saisie valide restée stable 1,5 s
    clearTimeout(historyTimer);
    if (state.data) historyTimer = setTimeout(() => addHistory(state.data), 1500);
  }

  // ---------------------------------------------------------------------------
  // Historique
  // ---------------------------------------------------------------------------

  function addHistory(d) {
    const entry = { input: $('ip').value.trim(), mode: state.mode, customPrefix: $('custom-prefix').value, label: `${C.toIp(d.calc.ip)}/${d.calc.prefix}` };
    const list = storage.get(HISTORY_KEY, []).filter((e) => e.label !== entry.label);
    list.unshift(entry);
    storage.set(HISTORY_KEY, list.slice(0, 12));
    renderHistory();
  }

  function renderHistory() {
    const list = storage.get(HISTORY_KEY, []);
    $('history-card').hidden = !list.length;
    $('history').replaceChildren(
      ...list.map((e) => {
        const chip = h('button', { type: 'button', class: 'chip', 'data-tip': `Saisie : ${e.input}` }, e.label);
        chip.addEventListener('click', () => {
          $('ip').value = e.input;
          if (e.customPrefix) $('custom-prefix').value = e.customPrefix;
          setMode(e.mode || 'auto');
          update();
        });
        return chip;
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  function disarmConfirm() {
    state.confirmArmed = false;
    const b = $('export-list');
    b.classList.remove('confirm');
    b.textContent = 'Exporter la liste (.txt)';
  }

  function setExporting(on) {
    state.exporting = on;
    $('progress').hidden = !on;
    if (on) {
      $('progress-bar').style.width = '0%';
      $('progress-text').textContent = 'Préparation…';
      $('export-done').hidden = true;
    }
    if (state.data) renderExport(state.data);
    $('export-split').disabled = on;
  }

  function showDone(res, label) {
    const done = $('export-done');
    const show = h('button', { type: 'button', class: 'btn small' }, 'Afficher dans le dossier');
    show.addEventListener('click', () => api.showFile(res.filePath));
    done.replaceChildren(h('span', null, label), h('span', { class: 'path' }, res.filePath), show);
    done.hidden = false;
  }

  async function exportList() {
    if (!state.data || state.exporting || $('export-list').disabled) return;
    const est = estimate(state.data);
    // Gros fichier : un second clic confirme
    if (est.bytes > BIG_EXPORT_BYTES && !state.confirmArmed) {
      state.confirmArmed = true;
      const b = $('export-list');
      b.classList.add('confirm');
      b.textContent = `Confirmer l'export (≈ ${formatBytes(est.bytes)})`;
      return;
    }
    disarmConfirm();
    setExporting(true);
    try {
      const res = await api.exportList({ ...request(), scope: exportScope(), numbered: $('numbered').checked });
      if (res && res.ok) {
        showDone(res, `${fmt(res.count)} adresses enregistrées (${formatBytes(res.bytes)}, ${(res.ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s)`);
        toast('Liste enregistrée.');
        addHistory(state.data);
      } else if (res && !res.canceled) {
        toast(res.error || 'Export impossible.');
      } else if (res && res.error) {
        toast(res.error);
      }
    } finally {
      setExporting(false);
    }
  }

  async function exportSummary(split) {
    if (!state.data || state.exporting) return;
    const res = await api.exportSummary({ ...request(), split: split || null });
    if (res && res.ok) {
      showDone(res, split ? 'Découpage enregistré' : 'Résumé enregistré');
      toast(split ? 'Découpage enregistré.' : 'Résumé enregistré.');
    } else if (res && !res.canceled) {
      toast(res.error || 'Export impossible.');
    }
  }

  function summaryText() {
    const d = state.data;
    return ['CalkIP — résumé', ...C.summaryLines(d.calc, d.pool, { input: $('ip').value.trim(), reason: d.reason }), ...(d.pool ? d.pool.notes.map((n) => `Remarque : ${n}`) : [])].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Thème
  // ---------------------------------------------------------------------------

  const THEMES = ['system', 'light', 'dark'];
  const THEME_LABELS = { system: 'système', light: 'clair', dark: 'sombre' };

  async function initTheme() {
    const btn = $('theme');
    let mode = 'system';
    try {
      const res = await api.getTheme();
      if (res && THEMES.includes(res.mode)) mode = res.mode;
    } catch {
      // thème système
    }
    btn.textContent = `Thème : ${THEME_LABELS[mode]}`;
    btn.addEventListener('click', async () => {
      const next = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
      const res = await api.setTheme(next);
      if (res && res.ok) {
        mode = next;
        btn.textContent = `Thème : ${THEME_LABELS[mode]}`;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Onglets : Calculatrice / Binaire
  // ---------------------------------------------------------------------------

  const VIEW_KEY = 'calkip.view';
  let view = 'calc';

  function setView(next) {
    view = next === 'binary' ? 'binary' : 'calc';
    document.querySelectorAll('.tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
    $('view-calc').hidden = view !== 'calc';
    $('view-binary').hidden = view !== 'binary';
    $('tooltip').hidden = true;
    storage.set(VIEW_KEY, view);
    if (view === 'binary') window.BinaryView.onShow(state.data);
  }

  function initViews() {
    window.BinaryView.init({ h, svgIcon, kvRow, copyButton, toast, copy, storage, api, getData: () => state.data });
    document.querySelectorAll('.tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
    // Flèches gauche / droite entre les onglets (motif ARIA « tablist »)
    $('tab-calc').parentElement.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setView(view === 'calc' ? 'binary' : 'calc');
      $(view === 'calc' ? 'tab-calc' : 'tab-binary').focus();
    });
    $('open-binary').addEventListener('click', () => {
      setView('binary');
      window.BinaryView.syncFrom(state.data, true);
      window.BinaryView.focusSteps();
    });
    setView(storage.get(VIEW_KEY, 'calc'));
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  function init() {
    // Préfixes personnalisés /1 à /32
    const custom = $('custom-prefix');
    for (let p = 1; p <= 32; p++) {
      custom.append(h('option', { value: String(p) }, `/${p} — ${C.toIp(C.prefixToMask(p))} — ${fmt(C.usableCount(p))} hôte${C.usableCount(p) > 1 ? 's' : ''}`));
    }
    custom.value = '26';

    restoreForm();
    initTooltip();
    initTheme();
    renderHistory();

    let debounce = null;
    const schedule = () => {
      clearTimeout(debounce);
      debounce = setTimeout(update, 120);
    };
    $('ip').addEventListener('input', schedule);
    $('ip').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounce);
        update();
      }
    });
    document.querySelectorAll('#mode button').forEach((b) =>
      b.addEventListener('click', () => {
        setMode(b.dataset.mode);
        update();
      })
    );
    custom.addEventListener('change', update);
    document.querySelectorAll('input[name="gateway"]').forEach((r) =>
      r.addEventListener('change', () => {
        update();
        if (r.value === 'custom' && r.checked) $('custom-gateway').focus();
      })
    );
    ['custom-gateway', 'reserve-start', 'reserve-end', 'exclusions', 'lease-limit'].forEach((id) => $(id).addEventListener('input', schedule));
    document.querySelectorAll('input[name="scope"]').forEach((r) =>
      r.addEventListener('change', () => {
        if (state.data) renderExport(state.data);
        saveForm();
      })
    );
    $('numbered').addEventListener('change', () => {
      if (state.data) renderExport(state.data);
      saveForm();
    });

    // Assistant « nombre d'hôtes »
    const hostsInput = $('hosts');
    const hostsApply = $('hosts-apply');
    // Réseau nécessaire = appareils + passerelle + adresses réservées ; la taille d'un réseau étant une
    // puissance de 2, il reste souvent des adresses : le nombre de baux est donc fixé au nombre d'appareils
    let suggested = null;
    const describeHosts = () => {
      suggested = null;
      hostsApply.disabled = true;
      if (!hostsInput.value) {
        $('hosts-result').textContent = 'Indiquez combien d\'appareils doivent recevoir une adresse : CalkIP choisit le plus petit réseau suffisant et limite la plage DHCP à ce nombre.';
        return;
      }
      try {
        C.prefixForHosts(hostsInput.value); // valide la saisie (entier ≥ 1), lève une erreur lisible sinon
        const devices = Number(hostsInput.value.trim());
        const d = dhcpOptions();
        const extra = (d.gateway === 'none' ? 0 : 1) + d.reserveStart + d.reserveEnd;
        const p = C.prefixForHosts(devices + extra);
        const usable = C.usableCount(p);
        suggested = { prefix: p, devices };
        hostsApply.disabled = false;
        const parts = [`${fmt(devices)} appareil${devices > 1 ? 's' : ''}`];
        if (d.gateway !== 'none') parts.push('la passerelle');
        if (d.reserveStart + d.reserveEnd) parts.push(`${fmt(d.reserveStart + d.reserveEnd)} adresse(s) réservée(s)`);
        const left = usable - devices - extra;
        $('hosts-result').textContent =
          `Pour ${parts.join(' + ')} (${fmt(devices + extra)} adresses) : /${p} (${C.toIp(C.prefixToMask(p))}), ${fmt(usable)} hôtes utilisables. ` +
          `Un réseau a toujours une taille en puissance de 2 : ${fmt(devices)} baux seront distribués${left > 0 ? `, ${fmt(left)} adresse(s) resteront libres` : ''}.`;
      } catch (err) {
        $('hosts-result').textContent = err.message;
      }
    };
    hostsInput.addEventListener('input', describeHosts);
    hostsApply.addEventListener('click', () => {
      if (suggested === null) return;
      const { prefix, devices } = suggested;
      if ([8, 16, 24, 32].includes(prefix)) setMode(String(prefix));
      else {
        custom.value = String(prefix);
        setMode('custom');
      }
      $('lease-limit').value = String(devices);
      document.querySelector('input[name="scope"][value="pool"]').checked = true; // export = les baux demandés
      update();
      toast(`/${prefix} appliqué, plage DHCP limitée à ${fmt(devices)} baux.`);
    });
    // Les réglages de passerelle / réservations changent le calcul de l'assistant
    ['reserve-start', 'reserve-end'].forEach((id) => $(id).addEventListener('input', () => hostsInput.value && describeHosts()));
    document.querySelectorAll('input[name="gateway"]').forEach((r) => r.addEventListener('change', () => hostsInput.value && describeHosts()));

    document.querySelectorAll('[data-example]').forEach((b) =>
      b.addEventListener('click', () => {
        $('ip').value = b.dataset.example;
        setMode('auto');
        update();
        $('ip').focus();
      })
    );

    $('export-list').addEventListener('click', exportList);
    $('export-summary').addEventListener('click', () => exportSummary(null));
    $('copy-summary').addEventListener('click', () => state.data && copy(summaryText(), 'Résumé'));
    $('export-cancel').addEventListener('click', () => {
      $('progress-text').textContent = 'Annulation…';
      api.cancelExport();
    });
    $('export-split').addEventListener('click', () => exportSummary(Number($('split-prefix').value)));
    $('split-prefix').addEventListener('change', () => {
      state.splitShown = SPLIT_PAGE;
      if (state.data) renderSplit(state.data);
    });
    $('split-more').addEventListener('click', () => {
      state.splitShown += SPLIT_PAGE;
      if (state.data) renderSplit(state.data);
    });
    $('history-clear').addEventListener('click', () => {
      storage.set(HISTORY_KEY, []);
      renderHistory();
    });

    api.onExportProgress((p) => {
      if (!p.total) return;
      const pct = Math.min(100, (p.written / p.total) * 100);
      $('progress-bar').style.width = `${pct}%`;
      if (!p.aborted) $('progress-text').textContent = `${fmt(p.written)} / ${fmt(p.total)} adresses (${pct.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} %)`;
    });

    document.addEventListener('keydown', (e) => {
      const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        // Ctrl + S : la liste dans la calculatrice, le calcul expliqué dans l'onglet Binaire
        if (view === 'binary') window.BinaryView.exportSteps();
        else exportList();
      } else if (ctrl && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        setView(e.key === '1' ? 'calc' : 'binary');
      } else if (view === 'binary' && window.BinaryView.onKey(e)) {
        e.preventDefault();
      }
    });

    api.info().then((info) => {
      document.title = `CalkIP ${info.version}`;
    });

    update();
    initViews();
    if (view === 'calc') $('ip').focus();
    // Première vue construite : l'écran de démarrage peut laisser la place à la fenêtre
    requestAnimationFrame(() => api.uiReady());
  }

  init();
})();
