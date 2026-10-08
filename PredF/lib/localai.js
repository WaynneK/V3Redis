/*
 * localai.js — IA locale gratuite pour l'Assistant de PredF, via Ollama (ollama.com).
 *
 * Ollama fait tourner des modèles ouverts (Qwen, Llama, Mistral…) sur l'ordinateur : ni compte, ni clé,
 * ni Internet une fois le modèle téléchargé, et les documents ne quittent pas la machine.
 * PredF dialogue avec le serveur local d'Ollama (http://127.0.0.1:11434) : état, téléchargement d'un
 * modèle, rédaction en flux. Seules les adresses de cet ordinateur sont acceptées.
 *
 * Les modèles locaux ne lisent pas les PDF : l'interface en extrait le texte (pdf.js) avant l'envoi.
 */
'use strict';

const DEFAULT_URL = 'http://127.0.0.1:11434';

/** Modèles conseillés (téléchargeables depuis PredF). */
const RECOMMENDED = [
  { id: 'qwen2.5:7b', label: 'Qwen 2.5 · 7B', size: '≈ 4,7 Go', hint: 'Recommandé : très bon en français · 8 Go de mémoire conseillés' },
  { id: 'mistral:7b', label: 'Mistral · 7B', size: '≈ 4,1 Go', hint: 'Modèle européen, à l\'aise en français · 8 Go de mémoire conseillés' },
  { id: 'llama3.2:3b', label: 'Llama 3.2 · 3B', size: '≈ 2 Go', hint: 'Léger et rapide, pour les ordinateurs modestes' },
];

/** Contexte maximal demandé au modèle (au-delà, la mémoire nécessaire explose sur un PC ordinaire). */
const MAX_CONTEXT = 32768;
/** Estimation grossière : ~3,5 caractères par jeton en français. */
const estimateTokens = (text) => Math.ceil(String(text).length / 3.5);

/** N'accepte que des adresses de cet ordinateur (l'IA locale doit rester locale). */
function checkUrl(url) {
  const u = new URL(url || DEFAULT_URL);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) {
    throw new Error('L\'IA locale doit tourner sur cet ordinateur (adresse 127.0.0.1 ou localhost).');
  }
  return u.origin;
}

async function getJson(base, pathname, init = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathname}`, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** État d'Ollama : { running, version, models: [{ name, size, vision }] }. */
async function status(url) {
  const base = checkUrl(url);
  let version;
  try {
    version = (await getJson(base, '/api/version')).version;
  } catch {
    return { running: false, models: [] };
  }
  let models = [];
  try {
    const tags = await getJson(base, '/api/tags');
    models = (tags.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details && m.details.family, params: m.details && m.details.parameter_size }));
    // Capacité « vision » (lecture d'images), indiquée par les versions récentes d'Ollama
    await Promise.all(
      models.map(async (m) => {
        try {
          const show = await getJson(base, '/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }) });
          m.vision = Array.isArray(show.capabilities) && show.capabilities.includes('vision');
        } catch {
          m.vision = false;
        }
      })
    );
  } catch {
    // liste indisponible : Ollama démarre peut-être
  }
  return { running: true, version, models };
}

/** Lit un flux NDJSON (une réponse JSON par ligne) et appelle onLine pour chacune. */
async function readNdjson(res, onLine) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of res.body) {
    rest += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
  if (rest.trim()) onLine(JSON.parse(rest.trim()));
}

const aborted = (err) => err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''));

/** Télécharge un modèle. onProgress({ status, completed, total }). Renvoie { job, done }. */
function pull({ url, model, onProgress }) {
  const base = checkUrl(url);
  const ctrl = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(`${base}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: ctrl.signal });
      if (!res.ok) throw new Error(`Ollama a refusé le téléchargement (HTTP ${res.status}).`);
      let error = null;
      await readNdjson(res, (p) => {
        if (p.error) error = p.error;
        else onProgress({ status: p.status, completed: p.completed || 0, total: p.total || 0 });
      });
      if (error) throw new Error(`Téléchargement impossible : ${error}`);
      return { ok: true };
    } catch (err) {
      if (aborted(err)) return { ok: false, canceled: true, error: 'Téléchargement annulé.' };
      return { ok: false, error: err.message || String(err) };
    }
  })();
  return { job: { abort: () => ctrl.abort() }, done };
}

/** Message utilisateur : texte des documents, puis la consigne. */
function buildPrompt(docs, instruction) {
  const parts = docs.map((d, i) => `===== Document ${i + 1} : « ${d.name} » =====\n${d.text || '(aucun texte : document scanné ou image)'}`);
  return `${parts.join('\n\n')}\n\n===== Consigne =====\n${instruction}`;
}

/**
 * Rédaction en flux. docs : [{ name, text }] ; images : [base64] (modèles « vision » seulement).
 * Renvoie { job, done } comme l'Assistant Claude : done → { ok, text, stopReason, usage, model } ou { ok:false, error }.
 */
function run({ url, model, system, docs, images, instruction, onText, onPhase = () => {} }) {
  const base = checkUrl(url);
  const prompt = buildPrompt(docs, instruction);
  const needed = estimateTokens(system) + estimateTokens(prompt) + 4096; // + place pour la réponse
  const ctrl = new AbortController();
  const done = (async () => {
    if (needed > MAX_CONTEXT) {
      return {
        ok: false,
        error: `Documents trop longs pour l'IA locale (≈ ${Math.round(estimateTokens(prompt) / 1000)} 000 jetons, ${Math.round((MAX_CONTEXT - 4096) / 1000)} 000 au plus). Retirez un document, ne gardez que les pages utiles (outil Découper), ou utilisez Claude.`,
      };
    }
    let text = '';
    onPhase({ phase: 'loading' }); // chargement du modèle en mémoire (jusqu'à une minute la première fois)
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt, ...(images && images.length ? { images } : {}) },
          ],
          // Contexte agrandi juste ce qu'il faut : par défaut Ollama couperait les longs documents sans prévenir
          options: { num_ctx: Math.min(MAX_CONTEXT, Math.max(8192, 2 ** Math.ceil(Math.log2(needed)))), temperature: 0.3 },
        }),
      });
      if (res.status === 404) return { ok: false, error: `Le modèle « ${model} » n'est pas installé dans Ollama.` };
      if (!res.ok) return { ok: false, error: `Ollama a renvoyé une erreur (HTTP ${res.status}).` };
      let final = null;
      let error = null;
      await readNdjson(res, (p) => {
        if (p.error) error = p.error;
        if (p.message && p.message.content) {
          text += p.message.content;
          onText(p.message.content);
        }
        if (p.done) final = p;
      });
      if (error) return { ok: false, text, error: `Ollama : ${error}` };
      return {
        ok: true,
        text,
        stopReason: final && final.done_reason === 'length' ? 'max_tokens' : 'end_turn',
        usage: { input_tokens: (final && final.prompt_eval_count) || 0, output_tokens: (final && final.eval_count) || 0 },
        model: `${model} (local)`,
      };
    } catch (err) {
      if (aborted(err)) return { ok: false, text, canceled: true, error: 'Arrêté.' };
      if (/ECONNREFUSED|fetch failed/i.test(`${err.message} ${err.cause && err.cause.code}`)) return { ok: false, text, error: 'Ollama ne répond pas : lancez l\'application Ollama puis réessayez.' };
      return { ok: false, text, error: err.message || String(err) };
    }
  })();
  return { job: { abort: () => ctrl.abort() }, done };
}

module.exports = { DEFAULT_URL, RECOMMENDED, MAX_CONTEXT, estimateTokens, checkUrl, status, pull, run, buildPrompt };
