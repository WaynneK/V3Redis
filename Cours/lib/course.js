/*
 * course.js — Outils de l'application Cours, sans dépendance ni accès système.
 * Chargé par la page (<script>, objet global « Course ») et par les tests (require).
 *
 *   validate(content)     contrôle du fichier de contenu (identifiants, couleurs, blocs connus)
 *   richTokens(text)      **gras** et `code` → [{ type: 'text' | 'b' | 'code', text }]
 *   isReady(chapter)      le chapitre a-t-il un résumé ?
 *   partStats(part, read) chapitres, résumés disponibles, chapitres lus
 *   search(parts, query)  recherche sans tenir compte des accents ni de la casse, avec extrait
 *   neighbours(part, id)  chapitres précédent et suivant
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Course = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLOCKS = ['p', 'list', 'steps', 'table', 'code', 'note', 'warn'];
  const str = (v) => (v === undefined || v === null ? '' : String(v));

  /** Clé de comparaison : sans accents, sans casse, espaces réduits. */
  function fold(s) {
    return str(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** « **gras** et `code` » → morceaux à afficher (aucun HTML : la page crée elle-même les éléments). */
  function richTokens(text) {
    const out = [];
    for (const part of str(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) out.push({ type: 'b', text: part.slice(2, -2) });
      else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) out.push({ type: 'code', text: part.slice(1, -1) });
      else out.push({ type: 'text', text: part });
    }
    return out;
  }

  const plain = (text) => richTokens(text).map((t) => t.text).join('');

  function blockKind(block) {
    if (!block || typeof block !== 'object') return null;
    const keys = Object.keys(block).filter((k) => BLOCKS.includes(k));
    return keys.length === 1 ? keys[0] : null;
  }

  /** Texte brut d'un bloc (recherche). */
  function blockText(block) {
    const kind = blockKind(block);
    const v = kind ? block[kind] : '';
    if (kind === 'list' || kind === 'steps') return (Array.isArray(v) ? v : []).map(plain).join(' ');
    if (kind === 'table') return [...(v.head || []), ...(v.rows || []).flat()].map(plain).join(' ');
    return plain(v);
  }

  const isReady = (chapter) => Boolean(chapter && Array.isArray(chapter.sections) && chapter.sections.length);

  /** Tout le texte d'un chapitre, morceau par morceau (titre, points clés, sections). */
  function chapterChunks(chapter) {
    const chunks = [str(chapter.title), str(chapter.subtitle), ...(chapter.keyPoints || []).map(plain)];
    for (const s of chapter.sections || []) {
      chunks.push(str(s.title));
      for (const b of s.blocks || []) chunks.push(blockText(b));
    }
    return chunks.filter(Boolean);
  }

  /** Contrôle du contenu : renvoie la liste des problèmes (vide si tout va bien). */
  function validate(content) {
    const errors = [];
    const parts = content && Array.isArray(content.parts) ? content.parts : null;
    if (!parts || !parts.length) return ['Aucune partie dans le contenu.'];
    const partIds = new Set();
    parts.forEach((p, i) => {
      const where = `Partie ${i + 1}${p && p.name ? ` (${p.name})` : ''}`;
      if (!p || typeof p !== 'object') return errors.push(`${where} : invalide.`);
      if (!/^[a-z0-9-]+$/.test(str(p.id))) errors.push(`${where} : identifiant invalide (lettres minuscules, chiffres, tirets).`);
      else if (partIds.has(p.id)) errors.push(`${where} : identifiant « ${p.id} » en double.`);
      partIds.add(p.id);
      if (!str(p.name).trim()) errors.push(`${where} : nom manquant.`);
      if (!/^#[0-9a-f]{6}$/i.test(str(p.accent))) errors.push(`${where} : couleur invalide (forme #rrggbb).`);
      const chapters = Array.isArray(p.chapters) ? p.chapters : [];
      if (!chapters.length) errors.push(`${where} : aucun chapitre.`);
      const ids = new Set();
      chapters.forEach((c, j) => {
        const cw = `${where}, chapitre ${j + 1}${c && c.title ? ` (${c.title})` : ''}`;
        if (!c || typeof c !== 'object') return errors.push(`${cw} : invalide.`);
        if (!/^[a-z0-9-]+$/.test(str(c.id))) errors.push(`${cw} : identifiant invalide.`);
        else if (ids.has(c.id)) errors.push(`${cw} : identifiant « ${c.id} » en double.`);
        ids.add(c.id);
        if (!str(c.title).trim()) errors.push(`${cw} : titre manquant.`);
        if (c.keyPoints !== undefined && !Array.isArray(c.keyPoints)) errors.push(`${cw} : keyPoints doit être une liste.`);
        (Array.isArray(c.sections) ? c.sections : []).forEach((s, k) => {
          const sw = `${cw}, section ${k + 1}`;
          if (!s || !str(s.title).trim()) errors.push(`${sw} : titre manquant.`);
          (s && Array.isArray(s.blocks) ? s.blocks : []).forEach((b, n) => {
            const kind = blockKind(b);
            if (!kind) errors.push(`${sw}, bloc ${n + 1} : type inconnu (attendu : ${BLOCKS.join(', ')}).`);
            else if ((kind === 'list' || kind === 'steps') && !Array.isArray(b[kind])) errors.push(`${sw}, bloc ${n + 1} : « ${kind} » doit être une liste.`);
            else if (kind === 'table' && !(b.table && Array.isArray(b.table.rows))) errors.push(`${sw}, bloc ${n + 1} : tableau sans lignes (rows).`);
          });
        });
      });
    });
    return errors;
  }

  /** { chapters, ready, read } d'une partie ; read : Set des clés « partie/chapitre » déjà lues. */
  function partStats(part, read) {
    const chapters = part.chapters || [];
    const r = read instanceof Set ? read : new Set(read || []);
    return {
      chapters: chapters.length,
      ready: chapters.filter(isReady).length,
      read: chapters.filter((c) => r.has(`${part.id}/${c.id}`)).length,
    };
  }

  /** Extrait d'environ « width » caractères autour de la première occurrence. */
  function snippet(text, query, width = 110) {
    const t = str(text).replace(/\s+/g, ' ').trim();
    const i = fold(t).indexOf(fold(query)); // fold garde la longueur pour les lettres latines courantes
    if (i < 0) return t.slice(0, width) + (t.length > width ? '…' : '');
    const start = Math.max(0, i - Math.floor((width - query.length) / 2));
    const end = Math.min(t.length, start + width);
    return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
  }

  /**
   * Recherche dans toutes les parties : chaque mot doit apparaître dans le chapitre (accents et casse ignorés).
   * → [{ partId, chapterId, title, partName, snippet, score }] ; titres trouvés d'abord.
   */
  function search(parts, query) {
    const words = fold(query).split(' ').filter((w) => w.length > 0);
    if (!words.length) return [];
    const out = [];
    for (const p of parts || []) {
      for (const c of p.chapters || []) {
        const chunks = chapterChunks(c);
        const hay = fold([p.name, p.description, ...chunks].join(' '));
        if (!words.every((w) => hay.includes(w))) continue;
        const titleHay = fold(`${c.title} ${str(c.subtitle)}`);
        const score = words.filter((w) => titleHay.includes(w)).length * 10 + (isReady(c) ? 1 : 0);
        // Extrait : le morceau qui contient le plus de mots cherchés (à égalité, le plus long : du texte plutôt qu'un titre)
        let hit = chunks[0] || '';
        let best = -1;
        for (const ch of chunks) {
          const n = words.filter((w) => fold(ch).includes(w)).length;
          if (n > best || (n === best && n > 0 && ch.length > hit.length)) {
            best = n;
            hit = ch;
          }
        }
        const anchor = words.find((w) => fold(hit).includes(w)) || words[0];
        out.push({ partId: p.id, chapterId: c.id, title: c.title, partName: p.name, snippet: snippet(hit, anchor), score });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function neighbours(part, chapterId) {
    const list = (part && part.chapters) || [];
    const i = list.findIndex((c) => c.id === chapterId);
    return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null, index: i };
  }

  return { BLOCKS, fold, richTokens, plain, blockKind, isReady, chapterChunks, validate, partStats, snippet, search, neighbours };
});
