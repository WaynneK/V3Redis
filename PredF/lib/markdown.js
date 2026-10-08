/*
 * markdown.js — Lecture du Markdown produit par l'Assistant IA, en blocs simples.
 *
 * Partagé : l'interface en fait l'aperçu (DOM, sans innerHTML), le processus principal en fait un PDF.
 * Sous-ensemble volontairement réduit : titres (# à ####), paragraphes, listes à puces et numérotées
 * (un niveau d'imbrication), citations, tableaux, séparateurs, blocs de code ; en ligne : **gras**,
 * *italique*, `code`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** « Texte **gras** et *italique* » → [{ text, bold, italic, code }]. */
  function parseInline(text) {
    const out = [];
    const re = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)(?<!\s)\3|`([^`]+)`/g;
    let last = 0;
    let m;
    const plain = (s) => s && out.push({ text: s.replace(/\\([*_`#|\\])/g, '$1') });
    while ((m = re.exec(text))) {
      // « _ » au milieu d'un mot (nom_de_fichier) n'est pas de l'italique
      if (m[3] === '_' && /\w/.test(text[m.index - 1] || '')) continue;
      plain(text.slice(last, m.index));
      if (m[2] !== undefined) {
        for (const part of parseInline(m[2])) out.push({ ...part, bold: true });
      } else if (m[4] !== undefined) {
        for (const part of parseInline(m[4])) out.push({ ...part, italic: true });
      } else {
        out.push({ text: m[5], code: true });
      }
      last = re.lastIndex;
    }
    plain(text.slice(last));
    return out.length ? out : [{ text: '' }];
  }

  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));

  /** Texte Markdown → liste de blocs. */
  function parse(source) {
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    const flush = () => {
      if (para.length) blocks.push({ type: 'p', inlines: parseInline(para.join(' ')) });
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      // Bloc de code
      if (/^```/.test(trimmed)) {
        flush();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
        blocks.push({ type: 'code', text: code.join('\n') });
        continue;
      }
      // Titre
      const hm = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
      if (hm) {
        flush();
        blocks.push({ type: 'h', level: Math.min(4, hm[1].length), inlines: parseInline(hm[2]) });
        continue;
      }
      // Séparateur
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s/g, ''))) {
        flush();
        blocks.push({ type: 'hr' });
        continue;
      }
      // Tableau : ligne d'en-tête suivie d'une ligne de séparation
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
        i--;
        const width = Math.max(head.length, ...rows.map((r) => r.length));
        const pad = (r) => [...r, ...Array(width - r.length).fill('')].slice(0, width);
        blocks.push({ type: 'table', head: pad(head).map(parseInline), rows: rows.map((r) => pad(r).map(parseInline)) });
        continue;
      }
      // Citation
      if (/^>\s?/.test(trimmed)) {
        flush();
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
        i--;
        blocks.push({ type: 'quote', inlines: parseInline(quote.join(' ')) });
        continue;
      }
      // Listes
      const lm = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
      if (lm) {
        flush();
        const ordered = /\d/.test(lm[2]);
        const items = [];
        const baseIndent = lm[1].length;
        while (i < lines.length) {
          const m2 = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m2) {
            const level = m2[1].length > baseIndent + 1 ? 1 : 0;
            // Une liste numérotée qui suit une liste à puces (ou l'inverse) commence un nouveau bloc
            if (level === 0 && /\d/.test(m2[2]) !== ordered) break;
            const number = /\d/.test(m2[2]) ? parseInt(m2[2], 10) : null;
            items.push({ level, number, inlines: parseInline(m2[3]) });
            i++;
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            // Suite d'un élément sur la ligne suivante (indentée)
            const prev = items[items.length - 1];
            prev.inlines = parseInline(`${prev.inlines.map((x) => x.text).join('')} ${lines[i].trim()}`);
            i++;
          } else break;
        }
        i--;
        blocks.push({ type: ordered ? 'ol' : 'ul', items });
        continue;
      }
      para.push(trimmed);
    }
    flush();
    return blocks;
  }

  /** Texte brut (copie, .txt) : marques Markdown retirées. */
  function toPlain(source) {
    const text = (inl) => inl.map((x) => x.text).join('');
    return parse(source)
      .map((b) => {
        if (b.type === 'h') return text(b.inlines).toUpperCase();
        if (b.type === 'p' || b.type === 'quote') return text(b.inlines);
        if (b.type === 'ul' || b.type === 'ol') return b.items.map((it, i) => `${'  '.repeat(it.level)}${b.type === 'ol' ? `${it.number || i + 1}.` : '•'} ${text(it.inlines)}`).join('\n');
        if (b.type === 'table') return [b.head, ...b.rows].map((r) => r.map(text).join(' | ')).join('\n');
        if (b.type === 'code') return b.text;
        if (b.type === 'hr') return '—'.repeat(20);
        return '';
      })
      .join('\n\n');
  }

  /** Premier titre du document (nom de fichier proposé, titre du PDF). */
  function title(source) {
    const h = parse(source).find((b) => b.type === 'h');
    return h ? h.inlines.map((x) => x.text).join('').trim() : '';
  }

  return { parse, parseInline, toPlain, title };
});
