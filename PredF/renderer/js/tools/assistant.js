/*
 * Assistant IA — « Fusionne ces documents et simplifie-les » : le document produit s'affiche au fil de
 * l'écriture puis s'enregistre en PDF. Deux moteurs au choix :
 *  - Claude (API Anthropic) : meilleure qualité, lit les PDF en entier ; clé API payante, passe par Internet ;
 *  - IA locale gratuite (Ollama) : sans compte ni Internet, les documents restent sur l'ordinateur ;
 *    PredF guide l'installation d'Ollama et télécharge le modèle.
 */

import { api, h, icon, button, segmented, plural, baseName, toast, check, showResult, withBusy, pickFiles, formatBytes, fmt, imageUrl, busy } from '../core.js';
import { dropZone, docSummary } from '../components.js';
import { renderThumb, pageText } from '../pdfview.js';

const PRESETS = [
  ['Fusionner', 'Fusionne ces documents en un seul document clair et bien structuré : regroupe les sujets communs, supprime les doublons et harmonise le style.'],
  ['Résumer', 'Fais un résumé clair de ces documents (une à deux pages), avec les points essentiels et les chiffres clés.'],
  ['Simplifier', 'Réécris ce contenu en langage simple et accessible, avec des phrases courtes, sans perdre d\'information importante.'],
  ['Points clés', 'Extrais les points clés, les décisions, les dates et les actions à mener, sous forme de listes et d\'un tableau récapitulatif.'],
  ['Comparer', 'Compare ces documents : points communs, différences et contradictions, avec un tableau comparatif.'],
  ['Traduire', 'Traduis ces documents en anglais, en conservant leur structure.'],
];
const PREFS_KEY = 'predf.ai';

// ---------------------------------------------------------------------------
// Aperçu du Markdown (DOM construit à la main : aucun innerHTML)
// ---------------------------------------------------------------------------

function inlineNodes(inlines) {
  return inlines.map((r) => {
    let node = document.createTextNode(r.text);
    if (r.code) node = h('code', null, r.text);
    if (r.italic) node = h('em', null, node);
    if (r.bold) node = h('strong', null, node);
    return node;
  });
}

function renderMarkdown(text) {
  return window.Markdown.parse(text).map((b) => {
    switch (b.type) {
      case 'h':
        return h(`h${b.level}`, null, inlineNodes(b.inlines));
      case 'p':
        return h('p', null, inlineNodes(b.inlines));
      case 'quote':
        return h('blockquote', null, inlineNodes(b.inlines));
      case 'hr':
        return h('hr');
      case 'code':
        return h('pre', null, b.text);
      case 'ul':
      case 'ol':
        return h(b.type, null, b.items.map((it) => h('li', { class: it.level ? 'sub' : null }, inlineNodes(it.inlines))));
      case 'table':
        return h(
          'div',
          { class: 'md-table' },
          h('table', null, h('thead', null, h('tr', null, b.head.map((c) => h('th', null, inlineNodes(c))))), h('tbody', null, b.rows.map((r) => h('tr', null, r.map((c) => h('td', null, inlineNodes(c)))))))
        );
      default:
        return null;
    }
  });
}

const words = (t) => (t.match(/[\p{L}\p{N}]+/gu) || []).length;

// ---------------------------------------------------------------------------
// Outil
// ---------------------------------------------------------------------------

export function create() {
  const state = {
    engine: null, // 'claude' | 'local'
    // Claude
    key: null, // « sk-ant-…ab12 » ou null
    canStore: true,
    models: [],
    model: null,
    editingKey: false,
    // IA locale (Ollama)
    local: { checked: false, running: false, models: [], recommended: [], model: null },
    pull: null, // { jobId, model, completed, total, status }
    // Travail
    files: [],
    instruction: '',
    job: null,
    text: '',
    done: null,
  };
  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  })();
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ engine: state.engine, model: state.model, localModel: state.local.model }));
    } catch {
      // préférence indisponible
    }
  };

  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);

  // ---------------------------------------------------------------- État des moteurs

  async function loadStatus() {
    const res = await api.aiStatus();
    if (res && res.ok) {
      state.key = res.key;
      state.canStore = res.canStore;
      state.models = res.models;
      state.model = state.models.some((m) => m.id === prefs.model) ? prefs.model : state.models[0].id;
    }
    // Sans clé Anthropic et sans choix enregistré : l'IA locale gratuite d'abord
    state.engine = prefs.engine === 'claude' || prefs.engine === 'local' ? prefs.engine : state.key ? 'claude' : 'local';
    state.local.model = prefs.localModel || null;
    await checkLocal();
    render();
  }

  async function checkLocal() {
    const res = await api.aiLocalStatus();
    const L = state.local;
    L.checked = true;
    if (res && res.ok) {
      L.running = res.running;
      L.version = res.version;
      L.models = res.models || [];
      L.recommended = res.recommended || [];
      if (!L.models.some((m) => m.name === L.model)) L.model = L.models.length ? L.models[0].name : null;
    }
  }

  // Tant que l'IA locale n'est pas prête, on revérifie toutes les 4 s (l'utilisateur installe Ollama)
  setInterval(async () => {
    if (state.engine !== 'local' || state.job || state.pull || !root.isConnected || root.closest('[hidden]')) return;
    if (state.local.running && state.local.models.length) return;
    const before = `${state.local.running}/${state.local.models.length}`;
    await checkLocal();
    if (`${state.local.running}/${state.local.models.length}` !== before) render();
  }, 4000);

  // ---------------------------------------------------------------- Claude : clé API

  function keyCard() {
    const input = h('input', { type: 'password', class: 'key-input', placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Clé API Anthropic' });
    const save = button('Enregistrer la clé', {
      icon: 'key',
      cls: 'primary',
      onClick: async () => {
        const res = await api.aiSaveKey(input.value);
        input.value = '';
        if (check(res)) {
          state.key = res.key;
          state.editingKey = false;
          toast('Clé API enregistrée (chiffrée sur cet ordinateur).');
          render();
        }
      },
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
    return h(
      'div',
      { class: 'panel key-card' },
      h(
        'div',
        { class: 'key-head' },
        h('span', { class: 'key-icon' }, icon('key')),
        h('div', null, h('strong', null, 'Clé API Anthropic'), h('span', { class: 'muted' }, 'Créez une clé sur la console Anthropic (rubrique « API Keys »), puis collez-la ici. L\'utilisation est facturée sur votre compte Anthropic.'))
      ),
      h('div', { class: 'key-row' }, input, save, button('Ouvrir la console', { icon: 'open', cls: 'ghost', onClick: () => api.openUrl('https://console.anthropic.com/settings/keys') }), state.key ? button('Annuler', { cls: 'ghost', onClick: () => ((state.editingKey = false), render()) }) : null),
      h('p', { class: 'hint' }, state.canStore ? 'La clé est chiffrée avec le coffre de Windows et ne quitte cet ordinateur que pour appeler l\'API Anthropic.' : 'Le chiffrement du système n\'est pas disponible : la clé ne peut pas être enregistrée.'),
      h(
        'div',
        { class: 'free-callout' },
        icon('sparkle'),
        h('div', null, h('strong', null, 'Pas de compte Anthropic ?'), h('span', null, 'Utilisez l\'IA locale gratuite : sans compte, sans clé, sans Internet. Vos documents restent sur l\'ordinateur.')),
        button('Utiliser l\'IA gratuite', { cls: 'primary', onClick: () => switchEngine('local') })
      )
    );
  }

  // ---------------------------------------------------------------- IA locale : installation guidée

  function pullProgress() {
    const p = state.pull;
    const pct = p.total ? Math.min(100, (p.completed / p.total) * 100) : 0;
    const bar = h('span');
    bar.style.width = `${pct}%`;
    return h(
      'div',
      { class: 'pull-box' },
      h('div', { class: 'pull-head' }, h('strong', null, `Téléchargement de ${p.model}…`), h('span', { class: 'muted' }, p.total ? `${formatBytes(p.completed)} / ${formatBytes(p.total)} · ${Math.floor(pct)} %` : p.status || 'Préparation…')),
      h('div', { class: 'busy-track' }, bar),
      button('Annuler', { cls: 'small ghost', onClick: () => api.aiCancel(p.jobId) })
    );
  }

  async function startPull(model) {
    const res = await api.aiLocalPull(model);
    if (!check(res)) return;
    state.pull = { jobId: res.jobId, model, completed: 0, total: 0, status: 'Connexion…' };
    render();
  }

  api.onAiPullProgress((p) => {
    if (!state.pull || p.jobId !== state.pull.jobId) return;
    Object.assign(state.pull, { completed: p.completed, total: p.total, status: p.status });
    const box = body.querySelector('.pull-box');
    if (box) box.replaceWith(pullProgress());
  });
  api.onAiPullDone(async (p) => {
    if (!state.pull || p.jobId !== state.pull.jobId) return;
    const model = state.pull.model;
    state.pull = null;
    if (p.ok) {
      toast(`Modèle ${model} installé : l'IA locale est prête.`);
      await checkLocal();
      state.local.model = model;
      savePrefs();
    } else if (!p.canceled) toast(p.error || 'Téléchargement impossible.', 'error');
    render();
  });

  function modelCards() {
    const L = state.local;
    const installed = new Set(L.models.map((m) => m.name));
    return h(
      'div',
      { class: 'model-cards' },
      L.recommended.map((m) =>
        h(
          'div',
          { class: 'model-card' },
          h('div', { class: 'model-title' }, h('strong', null, m.label), h('span', { class: 'tag ok' }, 'Gratuit')),
          h('span', { class: 'muted' }, m.hint),
          h('div', { class: 'model-foot' }, h('span', { class: 'muted' }, m.size), installed.has(m.id) ? h('span', { class: 'tag ok' }, 'Installé') : button('Télécharger', { icon: 'extract', cls: 'small', disabled: Boolean(state.pull), onClick: () => startPull(m.id) }))
        )
      )
    );
  }

  function localSetupCard() {
    const L = state.local;
    if (!L.running) {
      return h(
        'div',
        { class: 'panel setup-card' },
        h('div', { class: 'key-head' }, h('span', { class: 'key-icon' }, icon('sparkle')), h('div', null, h('strong', null, 'IA locale gratuite : installez Ollama'), h('span', { class: 'muted' }, 'Ollama est un logiciel gratuit qui fait tourner l\'IA directement sur cet ordinateur. PredF s\'y connecte tout seul.'))),
        h(
          'ol',
          { class: 'setup-steps' },
          h('li', null, h('strong', null, 'Téléchargez et installez Ollama'), h('span', { class: 'muted' }, 'Gratuit, environ 1 Go, Windows / macOS / Linux.'), button('Télécharger Ollama', { icon: 'open', cls: 'small primary', onClick: () => api.openUrl('https://ollama.com/download') })),
          h('li', null, h('strong', null, 'Lancez Ollama'), h('span', { class: 'muted' }, 'Il se place dans la zone de notification, à côté de l\'horloge.')),
          h('li', null, h('strong', null, 'Revenez ici'), h('span', { class: 'muted' }, 'PredF détecte Ollama automatiquement et vous propose de télécharger un modèle.'), button('Vérifier maintenant', { icon: 'undo', cls: 'small', onClick: async () => (await checkLocal(), render(), !state.local.running && toast('Ollama ne répond pas encore : vérifiez qu\'il est lancé.')) }))
        ),
        h('p', { class: 'hint' }, h('span', { class: 'pulse inline' }), ' Recherche d\'Ollama sur cet ordinateur…')
      );
    }
    return h(
      'div',
      { class: 'panel setup-card' },
      h('div', { class: 'key-head' }, h('span', { class: 'key-icon ok' }, icon('check')), h('div', null, h('strong', null, `Ollama est prêt${L.version ? ` (version ${L.version})` : ''}`), h('span', { class: 'muted' }, 'Dernière étape : téléchargez un modèle d\'IA (une seule fois). Ensuite, plus besoin d\'Internet.'))),
      state.pull ? pullProgress() : null,
      modelCards()
    );
  }

  function switchEngine(engine) {
    state.engine = engine;
    savePrefs();
    render();
  }

  // ---------------------------------------------------------------- Documents

  function addFiles(files) {
    for (const f of files) if (!state.files.some((x) => x.id === f.id)) state.files.push(f);
    render();
  }

  function removeFile(id) {
    state.files = state.files.filter((f) => f.id !== id);
    api.release([id]);
    render();
  }

  function fileChip(f) {
    let thumb;
    if (f.kind === 'pdf') {
      thumb = h('canvas', { class: 'chip-thumb' });
      renderThumb(f.id, 0, thumb, { width: 30 }).catch(() => thumb.classList.add('failed'));
    } else {
      thumb = h('img', { class: 'chip-thumb', alt: '' });
      imageUrl(f.id).then((url) => {
        thumb.src = url;
        thumb.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      });
    }
    return h(
      'li',
      { class: 'doc-chip' },
      thumb,
      h('div', { class: 'row-meta' }, h('strong', { 'data-tip': f.path || null }, f.name), h('span', null, docSummary(f))),
      button('', { icon: 'close', cls: 'icon-only ghost', tip: 'Retirer', disabled: Boolean(state.job), onClick: () => removeFile(f.id) })
    );
  }

  // ---------------------------------------------------------------- Lancement

  /** IA locale : texte des PDF extrait ici (pdf.js), page par page. Renvoie null si annulé. */
  async function extractTexts() {
    const pdfs = state.files.filter((f) => f.kind === 'pdf');
    const total = pdfs.reduce((s, f) => s + f.pageCount, 0);
    const texts = [];
    let done = 0;
    busy.start('Lecture du texte des documents…', { cancellable: true });
    try {
      for (const f of pdfs) {
        const pages = [];
        for (let i = 0; i < f.pageCount; i++) {
          if (busy.canceled) return null;
          busy.progress(done++, total, `Lecture de ${f.name}…`);
          const t = await pageText(f.id, i);
          if (t) pages.push(`[Page ${i + 1}]\n${t}`);
        }
        texts.push({ id: f.id, text: pages.join('\n\n') });
      }
    } finally {
      busy.end();
    }
    return texts;
  }

  async function start() {
    const instruction = state.instruction.trim();
    if (!state.files.length) return toast('Ajoutez au moins un document.', 'error');
    if (!instruction) return toast('Écrivez une consigne ou choisissez un exemple.', 'error');
    const req = { engine: state.engine, fileIds: state.files.map((f) => f.id), instruction };
    if (state.engine === 'local') {
      const m = state.local.models.find((x) => x.name === state.local.model);
      if (!m) return toast('Choisissez un modèle d\'IA locale.', 'error');
      const texts = await extractTexts();
      if (!texts) return;
      const empty = texts.filter((t) => !t.text.trim()).length;
      if (empty && empty === state.files.length) return toast('Aucun texte lisible dans ces documents (scans ?) : l\'IA locale ne lit que le texte. Essayez Claude, qui lit aussi les images.', 'error');
      if (empty) toast(`${plural(empty, 'document')} sans texte lisible (scan) : ignoré${empty > 1 ? 's' : ''} par l'IA locale.`);
      if (!m.vision && state.files.some((f) => f.kind === 'image')) toast('Ce modèle ne lit pas les images : elles sont ignorées.');
      Object.assign(req, { model: m.name, vision: Boolean(m.vision), texts });
    } else {
      req.model = state.model;
    }
    state.text = '';
    state.done = null;
    state.phase = state.engine === 'local' ? 'loading' : 'sending';
    state.thought = '';
    state.startedAt = Date.now();
    const res = await api.aiRun(req);
    if (!check(res)) return;
    state.job = res.jobId;
    render();
    renderOutput();
    // Le suivi (étape, chronomètre, réflexion) est sous la consigne : on l'amène à l'écran
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  api.onAiDelta((p) => {
    if (p.jobId !== state.job) return;
    state.text += p.text;
    scheduleOutput();
  });
  api.onAiPhase((p) => {
    if (p.jobId !== state.job) return;
    state.phase = p.phase;
    state.thought = p.thought || '';
    if (!state.text) scheduleOutput();
  });
  // Chronomètre de l'étape en cours (sans tout redessiner)
  setInterval(() => {
    if (!state.job) return;
    const el = result.querySelector('.ai-elapsed');
    if (el) el.textContent = elapsed();
  }, 1000);
  api.onAiDone((p) => {
    if (p.jobId !== state.job) return;
    state.job = null;
    state.done = p;
    if (!p.ok && !p.canceled && p.code !== 'billing') toast(p.error || 'L\'Assistant n\'a pas pu terminer.', 'error');
    render();
    renderOutput();
  });

  // ---------------------------------------------------------------- Résultat

  let outputTimer = null;
  function scheduleOutput() {
    if (outputTimer) return;
    outputTimer = setTimeout(() => {
      outputTimer = null;
      renderOutput();
    }, 120);
  }

  const PHASES = {
    sending: 'Envoi des documents à Claude…',
    thinking: 'Claude réfléchit…',
    loading: 'Chargement du modèle local…',
  };
  const HINTS = {
    sending: 'Les documents partent vers l\'API Anthropic.',
    thinking: 'Claude lit les documents et prépare le plan avant d\'écrire : 30 s à quelques minutes selon leur longueur.',
    loading: 'Le modèle se charge en mémoire (jusqu\'à une minute la première fois), puis lit vos documents.',
  };

  /** « 1 min 05 s » depuis le lancement. */
  function elapsed() {
    const s = Math.max(0, Math.round((Date.now() - (state.startedAt || Date.now())) / 1000));
    return ` · ${s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`}`;
  }

  function suggestedName(ext) {
    const title = window.Markdown.title(state.text).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
    return `${title || `${baseName(state.files[0] ? state.files[0].name : 'document')}_IA`}.${ext}`;
  }

  function renderOutput() {
    if (!state.job && !state.done && !state.text) {
      result.replaceChildren();
      return;
    }
    const running = Boolean(state.job);
    const d = state.done;
    let status;
    if (running) status = h('span', { class: 'ai-status running' }, h('span', { class: 'pulse' }), state.text ? `Rédaction… ${fmt(words(state.text))} mots` : PHASES[state.phase] || 'Préparation…', h('span', { class: 'ai-elapsed muted' }, elapsed()));
    else if (d && d.ok) {
      const u = d.usage || {};
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      status = h('span', { class: 'ai-status ok' }, icon('check'), `Terminé · ${fmt(words(state.text))} mots`, h('span', { class: 'muted', 'data-tip': `Jetons lus : ${fmt(tokens)} · écrits : ${fmt(u.output_tokens || 0)}` }, ` · ${d.model || ''}`));
    } else if (d && d.canceled) status = h('span', { class: 'ai-status warn' }, 'Arrêté avant la fin');
    else if (d && d.code === 'billing') status = h('span', { class: 'ai-status warn' }, icon('warn'), 'Crédit Anthropic épuisé');
    else status = h('span', { class: 'ai-status warn' }, icon('warn'), (d && d.error) || 'Erreur');

    // Crédit Anthropic épuisé : deux issues proposées plutôt qu'un message d'erreur brut
    const billing =
      d && !d.ok && d.code === 'billing'
        ? h(
            'div',
            { class: 'free-callout billing' },
            icon('warn'),
            h('div', null, h('strong', null, 'Plus de crédit sur votre compte Anthropic'), h('span', null, 'L\'API Claude est prépayée : rechargez votre compte (quelques euros suffisent pour de nombreux documents), ou continuez gratuitement avec l\'IA locale.')),
            button('Ajouter du crédit', { icon: 'open', onClick: () => api.openUrl('https://console.anthropic.com/settings/billing') }),
            button('Utiliser l\'IA gratuite', { cls: 'primary', onClick: () => switchEngine('local') })
          )
        : null;
    const truncated = d && d.ok && d.stopReason === 'max_tokens';
    const hasText = Boolean(state.text.trim());
    const saved = h('div', { class: 'ai-saved' });
    const actions = running
      ? [button('Arrêter', { icon: 'stop', cls: 'small', onClick: () => api.aiCancel(state.job) })]
      : hasText
        ? [
            button('Copier', { icon: 'copy', cls: 'small ghost', onClick: async () => (await api.copy(window.Markdown.toPlain(state.text))) && toast('Texte copié dans le presse-papiers.') }),
            button('Markdown', {
              icon: 'text',
              cls: 'small ghost',
              tip: 'Enregistrer le texte au format Markdown (.md)',
              onClick: async () => {
                const res = await api.aiSaveText({ markdown: state.text, format: 'md', suggestedName: suggestedName('md'), hintId: state.files[0] && state.files[0].id });
                if (check(res)) toast(`Enregistré : ${res.filePath}`);
              },
            }),
            button('Enregistrer en PDF', {
              icon: 'check',
              cls: 'small primary',
              onClick: async () => {
                const res = await withBusy('Mise en page du PDF…', () => api.aiSavePdf({ markdown: state.text, suggestedName: suggestedName('pdf'), hintId: state.files[0] && state.files[0].id }));
                if (check(res)) showResult(saved, res, { title: 'Document enregistré en PDF', detail: `${plural(res.pages, 'page')} · ${formatBytes(res.size)}` });
              },
            }),
          ]
        : [];
    const page = billing
      ? null
      : h(
          'article',
          { class: `ai-page${running && hasText ? ' writing' : ''}` },
          hasText
            ? renderMarkdown(state.text)
            : h(
                'div',
                { class: 'ai-placeholder' },
                h('span', { class: 'spinner' }),
                h('strong', null, PHASES[state.phase] || 'Préparation…'),
                h('span', { class: 'ai-hint' }, HINTS[state.phase] || ''),
                state.thought ? h('p', { class: 'ai-thought' }, h('span', null, 'Réflexion'), `… ${state.thought.replace(/\s+/g, ' ').trim().slice(-280)}`) : null
              )
        );
    const fresh = !result.querySelector('.ai-output');
    result.replaceChildren(
      h(
        'div',
        { class: `panel ai-output${fresh ? ' fresh' : ''}` },
        h('div', { class: 'ai-output-head' }, status, h('span', { class: 'spacer' }), actions),
        billing,
        truncated ? h('p', { class: 'notice warn' }, icon('warn'), h('span', null, 'Le document a atteint la longueur maximale d\'une réponse : la fin peut manquer. Demandez une version plus courte ou traitez les documents en plusieurs fois.')) : null,
        page,
        saved
      )
    );
    if (running) page.scrollTop = page.scrollHeight;
  }

  // ---------------------------------------------------------------- Rendu

  function engineSwitch() {
    const running = Boolean(state.job);
    const card = (id, title, desc, tags) =>
      h(
        'button',
        { type: 'button', class: `engine-card${state.engine === id ? ' active' : ''}`, role: 'radio', 'aria-checked': String(state.engine === id), disabled: running, onclick: () => state.engine !== id && switchEngine(id) },
        h('span', { class: 'engine-title' }, h('strong', null, title), tags.map(([t, c]) => h('span', { class: `tag ${c}` }, t))),
        h('span', { class: 'muted' }, desc)
      );
    return h(
      'div',
      { class: 'engine-switch', role: 'radiogroup', 'aria-label': 'Moteur d\'IA' },
      card('local', 'IA locale', 'Sur cet ordinateur, avec Ollama. Sans compte ni Internet : vos documents ne sortent pas.', [['Gratuit', 'ok'], ['Privé', 'ok']]),
      card('claude', 'Claude (Anthropic)', 'La meilleure qualité, lit aussi les scans et les images. Clé API, par Internet.', [['Payant', 'warn']])
    );
  }

  function privacyNotice() {
    if (state.engine === 'local') {
      return h('div', { class: 'notice ok-soft ai-privacy' }, icon('check'), h('span', null, 'IA locale : tout se passe sur cet ordinateur. Aucun document n\'est envoyé sur Internet, et c\'est gratuit.'));
    }
    return h(
      'div',
      { class: 'notice info ai-privacy' },
      icon('globe'),
      h('span', null, 'Claude : vos documents et votre consigne sont envoyés à l\'API d\'Anthropic, par Internet. Tous les autres outils de PredF restent 100 % locaux.'),
      state.key && !state.editingKey
        ? h(
            'span',
            { class: 'key-status' },
            icon('key'),
            state.key,
            button('Modifier', { cls: 'small ghost', onClick: () => ((state.editingKey = true), render()) }),
            button('Supprimer', {
              cls: 'small ghost danger',
              onClick: async () => {
                await api.aiRemoveKey();
                state.key = null;
                render();
              },
            })
          )
        : null
    );
  }

  function render() {
    if (!state.engine) return;
    const running = Boolean(state.job);
    const head = [engineSwitch(), privacyNotice()];
    if (state.engine === 'claude' && (!state.key || state.editingKey)) {
      body.replaceChildren(...head, keyCard());
      return;
    }
    if (state.engine === 'local' && (!state.local.running || !state.local.models.length)) {
      body.replaceChildren(...head, localSetupCard());
      return;
    }

    const docs = state.files.length
      ? h(
          'div',
          { class: 'panel' },
          h('div', { class: 'panel-head' }, h('span', { class: 'label' }, `Documents (${state.files.length})`), h('span', { class: 'spacer' }), button('Ajouter', { icon: 'plus', cls: 'small', disabled: running, onClick: async () => addFiles(await pickFiles('all', true)) })),
          h('ul', { class: 'doc-chips' }, state.files.map(fileChip))
        )
      : dropZone({ kind: 'all', multiple: true, title: 'Déposez les documents à confier à l\'Assistant', hint: state.engine === 'local' ? 'PDF (le texte est lu sur cet ordinateur) et images pour les modèles qui les lisent' : 'PDF et images — Claude les lit en entier (texte, tableaux, images)', onFiles: addFiles });

    const area = h('textarea', { class: 'ai-instruction', rows: '4', placeholder: 'Ex. : Fusionne ces deux rapports en un seul, simplifie le langage et termine par un tableau des actions à mener.', 'aria-label': 'Consigne', disabled: running });
    area.value = state.instruction;
    area.addEventListener('input', () => (state.instruction = area.value));
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        start();
      }
    });
    const presets = h(
      'div',
      { class: 'presets' },
      PRESETS.map(([label, text]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'preset',
            disabled: running,
            'data-tip': text,
            onclick: () => {
              state.instruction = text;
              area.value = text;
              area.focus();
            },
          },
          label
        )
      )
    );

    let modelChooser;
    if (state.engine === 'claude') {
      modelChooser = segmented(
        state.models.map((m) => [m.id, m.label, m.hint]),
        state.model,
        (v) => {
          state.model = v;
          savePrefs();
        },
        { compact: true, label: 'Modèle' }
      ).el;
    } else {
      const select = h('select', { 'aria-label': 'Modèle local', disabled: running }, state.local.models.map((m) => h('option', { value: m.name }, `${m.name}${m.params ? ` · ${m.params}` : ''}${m.vision ? ' · lit les images' : ''}`)));
      select.value = state.local.model;
      select.addEventListener('change', () => {
        state.local.model = select.value;
        savePrefs();
      });
      const more = h('details', { class: 'more-models' }, h('summary', null, 'Autres modèles gratuits'), state.pull ? pullProgress() : null, modelCards());
      modelChooser = h('div', { class: 'local-model' }, select, more);
    }
    const launch = button(running ? 'En cours…' : 'Lancer l\'Assistant', { icon: 'sparkle', cls: 'primary', disabled: running || !state.files.length, onClick: start });
    body.replaceChildren(
      ...head,
      docs,
      h(
        'div',
        { class: 'panel' },
        h('span', { class: 'label' }, 'Votre consigne'),
        presets,
        area,
        h('div', { class: 'ai-run-row' }, h('div', { class: 'option-group' }, h('span', { class: 'label' }, state.engine === 'local' ? 'Modèle local' : 'Modèle'), modelChooser), h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Ctrl + Entrée'), launch)
      )
    );
  }

  loadStatus();
  return {
    el: root,
    accept: 'all',
    multiple: true,
    onFiles: (files) => {
      if (state.job) {
        api.release(files.map((f) => f.id));
        toast('Attendez la fin de l\'Assistant pour ajouter des documents.');
        return;
      }
      addFiles(files);
    },
  };
}
