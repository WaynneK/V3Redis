/*
 * ranges.js — Saisie des pages : « 1-3, 5, 8- », « paires », « impaires », « fin ».
 *
 * Chargé par l'interface (<script>, objet global « PageRanges ») et par le processus principal (require) :
 * l'aperçu et le fichier créé utilisent exactement la même lecture.
 * Les pages sont numérotées à partir de 1 dans le texte et renvoyées en indices (à partir de 0).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PageRanges = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class RangeError_ extends Error {
    constructor(message) {
      super(message);
      this.name = 'RangeError';
    }
  }

  const END_WORDS = ['fin', 'end', 'n', 'dernière', 'derniere'];

  /** Lit un numéro de page (« 3 », « fin ») ; renvoie un indice (0 …). */
  function pageNumber(word, count, token) {
    const w = word.trim().toLowerCase();
    if (END_WORDS.includes(w)) return count - 1;
    if (!/^\d+$/.test(w)) throw new RangeError_(`« ${token} » : un numéro de page est attendu (ex. 1-3, 5, 8-fin).`);
    const n = Number(w);
    if (n < 1) throw new RangeError_(`« ${token} » : les pages commencent à 1.`);
    if (n > count) throw new RangeError_(`« ${token} » : le document n'a que ${count} page${count > 1 ? 's' : ''}.`);
    return n - 1;
  }

  /** Un élément : « 5 », « 2-7 », « 8- », « -3 », « 7-2 » (à l'envers), « paires », « impaires », « toutes ». */
  function parseToken(token, count) {
    const t = token.trim().toLowerCase();
    if (['toutes', 'tout', 'all', '*'].includes(t)) return Array.from({ length: count }, (_, i) => i);
    if (['paires', 'paire', 'pairs', 'even'].includes(t)) return Array.from({ length: count }, (_, i) => i).filter((i) => (i + 1) % 2 === 0);
    if (['impaires', 'impaire', 'impairs', 'odd'].includes(t)) return Array.from({ length: count }, (_, i) => i).filter((i) => (i + 1) % 2 === 1);
    const m = /^([^-–]*)[-–]([^-–]*)$/.exec(t);
    if (!m) return [pageNumber(t, count, token.trim())];
    const from = m[1].trim() ? pageNumber(m[1], count, token.trim()) : 0;
    const to = m[2].trim() ? pageNumber(m[2], count, token.trim()) : count - 1;
    const out = [];
    if (from <= to) for (let i = from; i <= to; i++) out.push(i);
    else for (let i = from; i >= to; i--) out.push(i); // « 7-2 » : ordre inverse
    return out;
  }

  function tokens(text) {
    return String(text === undefined || text === null ? '' : text)
      .split(/[,;\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /**
   * Liste de pages dans l'ordre saisi (les doublons sont gardés : « 1, 1 » duplique la page 1).
   * Texte vide : toutes les pages.
   */
  function parsePageList(text, count) {
    if (!Number.isInteger(count) || count < 1) throw new RangeError_('Le document ne contient aucune page.');
    const list = tokens(text);
    if (!list.length) return Array.from({ length: count }, (_, i) => i);
    return list.flatMap((t) => parseToken(t, count));
  }

  /** Groupes : chaque élément séparé par une virgule devient un fichier (« 1-3, 4-8, 9 » → 3 fichiers). */
  function parseGroups(text, count) {
    if (!Number.isInteger(count) || count < 1) throw new RangeError_('Le document ne contient aucune page.');
    const list = tokens(text);
    if (!list.length) throw new RangeError_('Indiquez au moins une plage de pages (ex. 1-3, 4-8, 9).');
    return list.map((t) => parseToken(t, count));
  }

  /** Découpe toutes les n pages. */
  function chunk(count, size) {
    const n = Number(size);
    if (!Number.isInteger(n) || n < 1) throw new RangeError_('Indiquez un nombre de pages entier, au moins 1.');
    const groups = [];
    for (let i = 0; i < count; i += n) groups.push(Array.from({ length: Math.min(n, count - i) }, (_, k) => i + k));
    return groups;
  }

  /** [0, 1, 2, 4] → « 1-3, 5 ». */
  function formatList(indices) {
    const parts = [];
    let i = 0;
    while (i < indices.length) {
      let j = i;
      while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j++;
      parts.push(j > i ? `${indices[i] + 1}-${indices[j] + 1}` : String(indices[i] + 1));
      i = j + 1;
    }
    return parts.join(', ');
  }

  return { RangeError: RangeError_, parsePageList, parseGroups, chunk, formatList };
});
