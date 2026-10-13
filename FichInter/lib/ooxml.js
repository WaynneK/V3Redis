/*
 * ooxml.js — Lecture et écriture minimales du XML de Word (word/document.xml), sans dépendance.
 *
 * Le document est traité comme du texte : on repère les éléments (paragraphes, tableaux, lignes, cellules,
 * passages) par leurs balises, en tenant compte de l'imbrication (un tableau dans une cellule, par exemple).
 * Tout ce qui n'est pas réécrit reste octet pour octet identique au modèle.
 */
'use strict';

/** Début d'une balise ouvrante exacte (« <w:p » mais pas « <w:pPr »). */
const openRe = (tag) => new RegExp(`<${tag}(?=[\\s>/])`, 'g');

/**
 * Fin de l'élément qui commence à `start` (balise `tag`), imbrication comprise. Renvoie l'indice juste après
 * la balise fermante (ou la balise auto-fermante).
 */
function elementEnd(xml, tag, start) {
  const re = new RegExp(`<${tag}(?=[\\s>/])[^>]*?(/?)>|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return re.lastIndex;
    } else if (m[1] === '/') {
      if (depth === 0) return re.lastIndex;
    } else {
      depth++;
    }
  }
  throw new Error(`Élément <${tag}> non fermé`);
}

/** Contenu (entre les balises) d'un élément complet. */
function innerRange(xml, start, end) {
  const open = xml.indexOf('>', start) + 1;
  if (xml[open - 2] === '/') return [open, open]; // auto-fermante
  const close = xml.lastIndexOf('</', end - 1);
  return [open, close];
}

/**
 * Enfants directs d'une zone [from, to) parmi les balises `tags` (« w:p », « w:tbl »…). Les blocs de contenu
 * (w:sdt) et le balisage personnalisé (w:customXml) sont traversés : leurs paragraphes comptent comme des
 * enfants directs.
 * → [{ tag, start, end }]
 */
function children(xml, from, to, tags) {
  const out = [];
  const want = new Set(tags);
  const any = /<(w:[A-Za-z]+)(?=[\s>/])/g;
  any.lastIndex = from;
  let m;
  while ((m = any.exec(xml)) && m.index < to) {
    const tag = m[1];
    const end = elementEnd(xml, tag, m.index);
    if (tag === 'w:sdt') {
      const content = /<w:sdtContent(?=[\s>])/g;
      content.lastIndex = m.index;
      const c = content.exec(xml);
      if (c && c.index < end) {
        const cEnd = elementEnd(xml, 'w:sdtContent', c.index);
        const [a, b] = innerRange(xml, c.index, cEnd);
        out.push(...children(xml, a, b, tags));
      }
    } else if (tag === 'w:customXml' || tag === 'w:smartTag') {
      // Balisage XML personnalisé autour de paragraphes, lignes ou cellules : son contenu compte aussi
      const [a, b] = innerRange(xml, m.index, end);
      out.push(...children(xml, a, b, tags));
    } else if (want.has(tag)) {
      out.push({ tag, start: m.index, end });
    }
    any.lastIndex = end;
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : all;
  });
}

function escapeXml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // caractères interdits en XML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Caractères des polices de symboles (w:sym, Wingdings) utilisés comme cases à cocher. */
const SYM_BOXES = { F06F: '☐', F0A8: '☐', F071: '☐', F072: '☐', F0FE: '☒', F078: '☒', F0FD: '☒', F06E: '■', F0A1: '○' };

/**
 * Passages (w:r) d'un paragraphe, dans l'ordre : { start, end, rPr, text, font, drawing }.
 * Les passages dans un lien, une insertion suivie ou un bloc de contenu sont inclus.
 */
function runs(xml, from, to) {
  const out = [];
  const re = openRe('w:r');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(xml)) && m.index < to) {
    const end = elementEnd(xml, 'w:r', m.index);
    const body = xml.slice(m.index, end);
    // Propriétés du passage lui-même : premier enfant (pas celles d'une zone de texte qu'il contiendrait)
    const afterOpen = body.indexOf('>') + 1;
    const rPr = body.startsWith('<w:rPr', afterOpen) ? firstRunProps(body.slice(afterOpen)) : '';
    const font = (/<w:rFonts [^>]*?w:(?:ascii|hAnsi)="([^"]+)"/.exec(rPr) || [])[1] || '';
    out.push({ start: m.index, end, rPr, text: runText(body), font, drawing: /<w:drawing[\s>]|<w:pict[\s>]/.test(body) });
    re.lastIndex = end;
  }
  return out;
}

/** Texte d'un passage : w:t, tabulations, retours à la ligne, symboles. */
function runText(body) {
  let text = '';
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t\/>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\/>|<w:sym\s[^>]*?w:char="([0-9A-Fa-f]+)"[^>]*\/>|<w:noBreakHyphen\/>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) text += unescapeXml(m[1]);
    else if (m[2]) text += SYM_BOXES[m[2].toUpperCase()] || '';
    else if (m[0].startsWith('<w:tab')) text += '\t';
    else if (m[0].startsWith('<w:br') || m[0].startsWith('<w:cr')) text += '\n';
    else if (m[0].startsWith('<w:noBreakHyphen')) text += '-';
  }
  return text;
}

/** Texte d'une zone (paragraphe, cellule) : texte de ses passages. */
function textOf(xml, from, to) {
  return runs(xml, from, to)
    .map((r) => r.text)
    .join('');
}

/** Propriétés du paragraphe (w:pPr), ou ''. */
function paragraphProps(xml, start, end) {
  const [a] = innerRange(xml, start, end);
  const rest = xml.slice(a, end);
  if (!rest.startsWith('<w:pPr')) return '';
  return rest.slice(0, elementEnd(rest, 'w:pPr', 0));
}

/**
 * Premières propriétés de passage (w:rPr) d'un fragment, prêtes à être réutilisées pour un nouveau passage :
 * imbrication respectée (w:rPrChange contient lui-même un w:rPr), suivi des modifications retiré.
 */
function firstRunProps(fragment) {
  const m = /<w:rPr(?=[\s>/])/.exec(fragment);
  if (!m) return '';
  const rPr = fragment.slice(m.index, elementEnd(fragment, 'w:rPr', m.index));
  if (rPr.endsWith('/>')) return '';
  return rPr
    .replace(/<w:rPrChange(?=[\s>])[\s\S]*<\/w:rPrChange>/, '')
    .replace(/<w:(?:ins|del|moveFrom|moveTo)\s[^>]*\/>/g, '');
}

/** Propriétés de passage de la marque de paragraphe (w:pPr/w:rPr) : taille de police d'une cellule vide. */
function paragraphRunProps(pPr) {
  // Le w:rPr de la marque suit les autres propriétés ; celui d'un w:pPrChange (ancienne version) est ignoré
  return firstRunProps(String(pPr || '').replace(/<w:pPrChange(?=[\s>])[\s\S]*<\/w:pPrChange>/, ''));
}

/** Passage de texte (w:r) avec ses propriétés ; « \n » devient un retour à la ligne, « \t » une tabulation. */
function textRun(rPr, text) {
  const body = String(text)
    .split('\n')
    .map((line, i) =>
      (i ? '<w:br/>' : '') +
      line
        .split('\t')
        .map((p, j) => `${j ? '<w:tab/>' : ''}${p ? `<w:t xml:space="preserve">${escapeXml(p)}</w:t>` : ''}`)
        .join('')
    )
    .join('');
  return `<w:r>${rPr || ''}${body}</w:r>`;
}

/** Propriétés de passage modifiées : gras ajouté, police remplacée (cases à cocher). */
function withBold(rPr) {
  const base = rPr && rPr !== '<w:rPr/>' ? rPr : '<w:rPr></w:rPr>';
  if (/<w:b\/>|<w:b w:val="(?:1|true|on)"\/>/.test(base)) return base;
  const cleaned = base.replace(/<w:b w:val="[^"]*"\/>|<w:bCs w:val="[^"]*"\/>/g, '');
  // w:b se place tôt dans w:rPr (après w:rStyle / w:rFonts) : Word est tolérant, mais on respecte l'ordre du schéma
  return cleaned.replace(/(<w:rPr>(?:<w:rStyle [^>]*\/>)?(?:<w:rFonts [^>]*\/>)?)/, '$1<w:b/><w:bCs/>');
}

function withFont(rPr, font) {
  const base = (rPr && rPr !== '<w:rPr/>' ? rPr : '<w:rPr></w:rPr>').replace(/<w:rFonts [^>]*\/>/, '');
  const fonts = `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`;
  return base.replace(/(<w:rPr>(?:<w:rStyle [^>]*\/>)?)/, `$1${fonts}`);
}

/** Remplace des zones [start, end) d'un texte (zones disjointes, dans n'importe quel ordre). */
function splice(xml, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = xml;
  let last = Infinity;
  for (const e of sorted) {
    if (e.end > last) throw new Error('Modifications qui se chevauchent');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    last = e.start;
  }
  return out;
}

module.exports = { elementEnd, innerRange, children, runs, runText, textOf, paragraphProps, paragraphRunProps, firstRunProps, textRun, withBold, withFont, splice, escapeXml, unescapeXml, SYM_BOXES };
