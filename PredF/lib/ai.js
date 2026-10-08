/*
 * ai.js — Assistant IA de PredF (processus principal) : envoie les documents et la consigne à l'API
 * Claude d'Anthropic et renvoie le document produit, en Markdown, au fil de l'écriture.
 *
 * C'est la seule partie de PredF qui utilise Internet, et seulement quand l'utilisateur lance
 * l'Assistant. La clé API est chiffrée avec le coffre du système (safeStorage : DPAPI sous Windows).
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;

/** Modèles proposés (le premier est celui par défaut). */
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'Meilleure qualité' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'Plus rapide' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'Le plus économique' },
];

/** Limite d'une requête : 32 Mo ; les fichiers sont envoyés en base64 (+33 %). */
const MAX_REQUEST_BYTES = 31 * 1024 * 1024;
const MAX_PDF_PAGES = 600;

const SYSTEM_PROMPT = `Tu es l'Assistant IA de PredF, un logiciel de bureau qui fusionne et transforme des documents PDF.

L'utilisateur te confie un ou plusieurs documents (PDF ou images) et une consigne : fusionner, résumer, simplifier, réorganiser, traduire, extraire des informations, etc. Ta réponse devient directement un nouveau document PDF, mis en page automatiquement.

Règles :
- Réponds uniquement par le document final, en Markdown : un titre principal (# …), des sections (##, ###), des paragraphes, des listes, des tableaux si utile, du **gras** pour l'essentiel. Aucune phrase d'introduction ou de conclusion adressée à l'utilisateur (pas de « Voici le document… »), pas de bloc de code autour du document.
- Appuie-toi seulement sur le contenu des documents fournis. N'invente ni chiffres, ni noms, ni dates. Si la consigne demande une information absente des documents, indique-le brièvement à l'endroit concerné.
- Quand tu fusionnes plusieurs documents, produis un seul document cohérent : regroupe les sujets communs, supprime les doublons, harmonise le vocabulaire et la structure, et signale les contradictions entre les sources.
- Écris dans la langue demandée ; sinon dans la langue de la consigne.
- Garde les informations importantes (chiffres, dates, noms, montants, obligations) exactes.`;

// ---------------------------------------------------------------------------
// Clé API (chiffrée sur le disque)
// ---------------------------------------------------------------------------

function createKeyStore({ safeStorage, userDataDir }) {
  const file = path.join(userDataDir, 'assistant-key.bin');
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    async save(key) {
      const k = String(key || '').trim();
      if (!/^sk-ant-[\w-]{20,}$/.test(k)) throw new Error('Clé API invalide : elle commence par « sk-ant- » (à créer sur console.anthropic.com).');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Le chiffrement du système n\'est pas disponible : la clé ne peut pas être enregistrée en sécurité.');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, safeStorage.encryptString(k));
    },
    async load() {
      try {
        return safeStorage.decryptString(await fsp.readFile(file));
      } catch {
        return null;
      }
    },
    async remove() {
      await fsp.unlink(file).catch(() => {});
    },
    /** « sk-ant-…a1b2 » : de quoi reconnaître la clé sans l'afficher. */
    async describe() {
      if (!fs.existsSync(file)) return null;
      const k = await this.load();
      return k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Requête
// ---------------------------------------------------------------------------

/** Blocs de contenu : chaque document (PDF ou image) avec son nom, puis la consigne. */
function buildContent(files, instruction) {
  const content = [];
  let bytes = 0;
  files.forEach((f, i) => {
    bytes += Math.ceil((f.bytes.length * 4) / 3);
    content.push({ type: 'text', text: `Document ${i + 1} : « ${f.name} »` });
    if (f.kind === 'pdf') {
      if (f.pageCount > MAX_PDF_PAGES) throw new Error(`${f.name} a ${f.pageCount} pages : l'Assistant en lit ${MAX_PDF_PAGES} au plus par document. Découpez-le d'abord (outil Découper).`);
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(f.bytes).toString('base64') }, title: f.name });
    } else {
      const media = f.type === 'png' ? 'image/png' : 'image/jpeg';
      content.push({ type: 'image', source: { type: 'base64', media_type: media, data: Buffer.from(f.bytes).toString('base64') } });
    }
  });
  if (bytes > MAX_REQUEST_BYTES) {
    throw new Error(`Documents trop lourds pour l'Assistant (${Math.round(bytes / 1048576)} Mo une fois encodés, 31 Mo au plus). Compressez-les ou retirez-en un.`);
  }
  content.push({ type: 'text', text: `Consigne : ${instruction}` });
  return content;
}

/** Message d'erreur lisible à partir des erreurs typées du SDK. */
function explainError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return { canceled: true, error: 'Arrêté.' };
  if (err instanceof Anthropic.AuthenticationError) return { error: 'Clé API refusée : vérifiez-la dans les réglages de l\'Assistant.' };
  if (err instanceof Anthropic.PermissionDeniedError) return { error: 'Cette clé API n\'a pas accès à ce modèle.' };
  if (err instanceof Anthropic.RateLimitError) return { error: 'Trop de demandes pour le moment (limite de votre compte) : réessayez dans une minute.' };
  if (err instanceof Anthropic.BadRequestError) {
    // Crédit épuisé : erreur 400 sans classe dédiée, reconnue par son message
    const detail = (err.error && err.error.error && err.error.error.message) || err.message || '';
    if (/credit balance is too low/i.test(detail)) {
      return { code: 'billing', error: 'Votre compte Anthropic n\'a plus de crédit. L\'API Claude est prépayée : ajoutez du crédit dans la console Anthropic (Plans & Billing), ou utilisez l\'IA locale gratuite.' };
    }
    return { error: `Demande refusée par l'API : ${detail}` };
  }
  if (err instanceof Anthropic.APIConnectionError) return { error: 'Connexion impossible : vérifiez votre accès à Internet.' };
  if (err instanceof Anthropic.APIError) return { error: `Erreur de l'API (${err.status || '?'}) : ${err.message}` };
  return { error: err && err.message ? err.message : String(err) };
}

/**
 * Lance l'Assistant. onText(delta) reçoit le texte au fil de l'eau.
 * Renvoie { job, done } : job.abort() arrête, done → { ok, text, stopReason, usage, model } ou { ok:false, error }.
 */
function run({ apiKey, baseURL, model, files, instruction, onText, onPhase = () => {} }) {
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined, maxRetries: 2 });
  const chosen = MODELS.some((m) => m.id === model) ? model : MODELS[0].id;
  const params = {
    model: chosen,
    max_tokens: 64000,
    system: SYSTEM_PROMPT,
    // Réflexion adaptative avec résumé lisible : l'interface montre que Claude travaille avant d'écrire
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: buildContent(files, instruction) }],
  };
  // Opus 5.5 et Sonnet 5.5 : si un filtre de sécurité refuse à tort, l'API relance sur le modèle de repli
  if (chosen !== 'claude-haiku-5-5') {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = client.beta.messages.stream(params);
  let text = '';
  onPhase({ phase: 'sending' });
  const done = (async () => {
    try {
      for await (const event of stream) {
        if (event.type === 'message_start') onPhase({ phase: 'thinking' }); // documents reçus par l'API
        else if (event.type === 'content_block_start' && event.content_block.type === 'thinking') onPhase({ phase: 'thinking' });
        else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') onPhase({ phase: 'thinking', thought: event.delta.thinking });
        else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text;
          onText(event.delta.text);
        }
      }
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        return { ok: false, error: 'L\'IA a refusé de traiter ces documents (filtre de sécurité). Reformulez la consigne ou retirez le document concerné.' };
      }
      return { ok: true, text, stopReason: message.stop_reason, usage: message.usage, model: message.model };
    } catch (err) {
      return { ok: false, text, ...explainError(err) };
    }
  })();
  return { job: { abort: () => stream.abort() }, done };
}

module.exports = { MODELS, SYSTEM_PROMPT, createKeyStore, buildContent, run, explainError };
