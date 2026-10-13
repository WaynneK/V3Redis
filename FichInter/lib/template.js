/*
 * template.js — Modèle de fiche (word/document.xml) : analyse, remplissage, relecture.
 *
 * Analyse : le formulaire est déduit du document Word lui-même, sans réglage à écrire.
 *   - Une section = un tableau, titré par le paragraphe qui le précède (« 1. Identité ») ;
 *   - une ligne « intitulé | case » = un champ. Selon le contenu de la case :
 *       cases à cocher (« o », ☐, symboles Wingdings)  → choix (une seule case : à cocher) ;
 *       pointillés (« ………… », « ……/……/………… »)      → blancs à compléter (texte, date) ;
 *       vide ou texte terminé par « : »                → texte, date, heure, e-mail… d'après l'intitulé ;
 *       intitulé « signature »                         → nom + signature dessinée.
 *   - Une option terminée par « : » ou contenant des pointillés demande une précision
 *     (« Autre (Préciser) : », « Sous garantie (jusqu'au : ………… ) »).
 * Remplissage : seules les cases des champs sont réécrites (le reste du modèle est inchangé) ; les cases à
 * cocher deviennent ☒ (choisie, en gras) ou ☐.
 * Relecture : le fichier généré est relu case par case et comparé à ce qui devait y être écrit.
 */
'use strict';

const X = require('./ooxml.js');
const Fields = require('./fields.js');

// ---------------------------------------------------------------------------
// Repérage : corps, tableaux, lignes, cellules, paragraphes
// ---------------------------------------------------------------------------

function bodyRange(xml) {
  const open = /<w:body(?=[\s>])[^>]*>/.exec(xml);
  const close = xml.lastIndexOf('</w:body>');
  if (!open || close < 0) throw new Error('Document Word illisible (corps introuvable).');
  return [open.index + open[0].length, close];
}

/**
 * Plan du document : blocs du corps (paragraphes et tableaux, dans l'ordre) ; pour chaque tableau ses lignes,
 * pour chaque ligne ses cellules, pour chaque cellule ses paragraphes. Positions dans `xml`.
 */
function layout(xml) {
  const [a, b] = bodyRange(xml);
  const blocks = X.children(xml, a, b, ['w:p', 'w:tbl']).map((blk) => {
    if (blk.tag === 'w:p') return { type: 'p', start: blk.start, end: blk.end, text: X.textOf(xml, blk.start, blk.end) };
    const [ti, te] = X.innerRange(xml, blk.start, blk.end);
    const rows = X.children(xml, ti, te, ['w:tr']).map((tr) => {
      const [ri, re] = X.innerRange(xml, tr.start, tr.end);
      // w:trPr peut suivre un w:tblPrEx (exceptions de mise en forme de la ligne)
      const firstCell = xml.slice(ri, re).search(/<w:tc(?=[\s>])/);
      const trPr = /<w:trPr>[\s\S]*?<\/w:trPr>/.exec(xml.slice(ri, firstCell < 0 ? re : ri + firstCell));
      const height = trPr ? Number((/<w:trHeight [^>]*?w:val="(\d+)"/.exec(trPr[0]) || [])[1] || 0) : 0;
      const cells = X.children(xml, ri, re, ['w:tc']).map((tc) => {
        const [ci, ce] = X.innerRange(xml, tc.start, tc.end);
        const head = xml.slice(ci, Math.min(ce, ci + 2000));
        const tcPr = /^<w:tcPr>[\s\S]*?<\/w:tcPr>/.exec(head);
        const merged = Boolean(tcPr && /<w:vMerge\/>|<w:vMerge w:val="continue"\/>/.test(tcPr[0]));
        const paragraphs = X.children(xml, ci, ce, ['w:p']).map((p) => ({ start: p.start, end: p.end }));
        return { start: tc.start, end: tc.end, merged, paragraphs };
      });
      return { start: tr.start, end: tr.end, height, cells };
    });
    return { type: 'tbl', start: blk.start, end: blk.end, rows };
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// Cases à cocher et pointillés
// ---------------------------------------------------------------------------

const MARKS = '☐☑☒□■▢❏❐❑❒○◯●◻◼⬜⬛';
const CHECKED = '☑☒■●◼⬛';
const SYMBOL_FONT = /courier|wingdings|webdings|symbol|consolas|segoe ui symbol|ms gothic/i;
const MARK_SPLIT = new RegExp(`([${MARKS}])`);

/**
 * Éléments d'un paragraphe : [{ type: 'mark', checked, rPr } | { type: 'text', text, rPr }] dans l'ordre.
 * Une case est un caractère de case (☐…), un « o » seul en Courier New / Wingdings (modèles faits à la main)
 * ou un symbole Wingdings (w:sym).
 */
function tokens(xml, p) {
  const out = [];
  for (const r of X.runs(xml, p.start, p.end)) {
    if (r.drawing && !r.text) {
      out.push({ type: 'drawing' });
      continue;
    }
    const t = r.text;
    if (t.trim() === 'o' && SYMBOL_FONT.test(r.font)) {
      out.push({ type: 'mark', checked: false, rPr: r.rPr });
      continue;
    }
    for (const piece of t.split(MARK_SPLIT)) {
      if (!piece) continue;
      if (piece.length === 1 && MARKS.includes(piece)) out.push({ type: 'mark', checked: CHECKED.includes(piece), rPr: r.rPr });
      else out.push({ type: 'text', text: piece, rPr: r.rPr });
    }
  }
  return out;
}

const tidy = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();

/** Pointillés à compléter : « ……/……/………… » (date) ou « ………… », « ....... », « _____ ». */
const BLANK_RE = /([.…]{2,}\s*\/\s*[.…]{2,}\s*\/\s*[.…]{2,})|(…[.…]*…|\.{4,}|_{4,})/g;
const hasBlank = (s) => {
  BLANK_RE.lastIndex = 0;
  return BLANK_RE.test(s);
};

/** Découpe un texte en morceaux fixes et pointillés : [{ text } | { blank: 'date'|'text', text }]. */
function splitBlanks(text) {
  const out = [];
  let last = 0;
  BLANK_RE.lastIndex = 0;
  let m;
  while ((m = BLANK_RE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ blank: m[1] ? 'date' : 'text', text: m[0] });
    last = BLANK_RE.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Option d'une case à cocher, d'après son texte dans le modèle :
 *   { text (texte d'origine), label (court), sub (précision entre parenthèses), extra: { kind, label, mode } | null }
 *   mode 'append' : la précision s'écrit après « : » ; mode 'blank' : elle remplace les pointillés.
 */
function parseOption(raw) {
  const text = tidy(raw).replace(/\n/g, ' ');
  if (hasBlank(text)) {
    const parts = splitBlanks(text);
    const before = parts[0] && !parts[0].blank ? parts[0].text : '';
    // « Sous garantie (jusqu'au : ………… ) » : libellé « Sous garantie », précision « jusqu'au » (date)
    const open = before.lastIndexOf('(');
    const label = tidy((open > 0 ? before.slice(0, open) : before).replace(/[:(]\s*$/, ''));
    const hint = tidy((open >= 0 ? before.slice(open + 1) : '').replace(/:\s*$/, '')) || 'Préciser';
    const blank = parts.find((p) => p.blank);
    const kind = blank.blank === 'date' ? 'date' : Fields.guessKind(hint) === 'date' ? 'date' : 'text';
    return { text, label: label || text, sub: '', extra: { kind, label: cap(hint), mode: 'blank' } };
  }
  if (/:\s*$/.test(text)) {
    const body = text.replace(/\s*:\s*$/, '');
    let m;
    let label = body;
    let hint = 'Préciser';
    if ((m = /^(.*?)\s*\(([^()]*)\)$/.exec(body)) && m[1]) [label, hint] = [m[1], m[2]];
    else if ((m = /^(.*?)\s+[–—-]\s+(.*)$/.exec(body))) [label, hint] = [m[1], m[2]];
    else if ((m = /^(.*),\s*(.*)$/.exec(body))) [label, hint] = [m[1], m[2]];
    return { text, label: tidy(label), sub: '', extra: { kind: Fields.guessKind(hint) === 'date' ? 'date' : 'text', label: cap(tidy(hint)), mode: 'append' } };
  }
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(text);
  return m && m[1] ? { text, label: m[1], sub: m[2], extra: null } : { text, label: text, sub: '', extra: null };
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

/** Texte d'une cellule (paragraphes séparés par des retours à la ligne). */
function cellText(xml, cell) {
  return cell.paragraphs.map((p) => X.textOf(xml, p.start, p.end)).join('\n');
}

/**
 * Champ décrit par une case (cellule « valeur ») ; null si la case est un simple texte du modèle.
 * Les positions (privées, préfixe « _ ») servent au remplissage.
 */
function fieldOf(xml, label, cell, height, key) {
  const paras = cell.paragraphs.map((p) => ({ ...p, tokens: tokens(xml, p) }));
  const withMarks = paras.filter((p) => p.tokens.some((t) => t.type === 'mark'));

  // Cases à cocher (un ou plusieurs paragraphes) ; le texte fixe qui les précède devient une note
  if (withMarks.length) {
    const options = [];
    const groups = [];
    for (const p of withMarks) {
      const prefix = [];
      const items = [];
      for (const t of p.tokens) {
        if (t.type === 'mark') items.push({ mark: t, parts: [] });
        else if (t.type === 'text') (items.length ? items[items.length - 1].parts : prefix).push(t);
      }
      const group = { paragraph: { start: p.start, end: p.end }, prefix, options: [] };
      for (const it of items) {
        const raw = it.parts.map((t) => t.text).join('');
        const opt = parseOption(raw);
        if (!opt.text) continue;
        const labelRPr = (it.parts.find((t) => t.text.trim()) || it.parts[0] || {}).rPr || it.mark.rPr;
        group.options.push(options.length);
        options.push({ ...opt, _markRPr: it.mark.rPr, _labelRPr: labelRPr, _checked: it.mark.checked });
      }
      groups.push(group);
    }
    if (!options.length) return null;
    const first = paras.indexOf(withMarks[0]);
    const note = tidy(paras.slice(0, first).map((p) => p.tokens.filter((t) => t.type === 'text').map((t) => t.text).join('')).join('\n'));
    const kind = options.length === 1 ? 'check' : 'choice';
    return {
      key,
      label: label || options[0].label,
      kind,
      multiple: kind === 'choice' && options.length >= 6, // longues listes (type d'intervention…) : plusieurs choix possibles
      options: options.map(({ text, label: l, sub, extra }) => ({ text, label: l, sub, extra })),
      note,
      _options: options,
      _groups: groups,
    };
  }

  const texts = paras.map((p) => p.tokens.filter((t) => t.type === 'text').map((t) => t.text).join(''));

  // Pointillés à compléter (« Fait à …………, le ……/……/………… »)
  const bi = texts.findIndex(hasBlank);
  if (bi >= 0) {
    const pieces = splitBlanks(texts[bi]);
    const blanks = [];
    pieces.forEach((piece, i) => {
      if (!piece.blank) return;
      const before = i > 0 && !pieces[i - 1].blank ? tidy(pieces[i - 1].text.replace(/^[\s,;:.]+|[\s,;:]+$/g, '')) : '';
      const kind = piece.blank === 'date' ? 'date' : Fields.guessKind(before) === 'date' ? 'date' : 'text';
      let bl = before;
      if (kind === 'date' && (!bl || /^(le|du|au|date)$/i.test(bl))) bl = 'Date';
      if (!bl) bl = /fait [àa]/i.test(label) ? 'Lieu' : label;
      blanks.push({ kind, label: cap(bl) });
    });
    const rPr = (paras[bi].tokens.find((t) => t.type === 'text' && t.text.trim()) || {}).rPr || '';
    // Phrase à trous pour la page : morceaux fixes et numéros des blancs, dans l'ordre
    let n = 0;
    const parts = pieces.map((p) => (p.blank ? { blank: n++ } : { text: p.text.replace(/[ \t ]+/g, ' ') }));
    return { key, label, kind: 'blanks', blanks, parts, text: tidy(texts[bi]), _paragraph: { start: paras[bi].start, end: paras[bi].end }, _pieces: pieces, _rPr: rPr };
  }

  // Case libre : vide, ou texte d'amorce terminé par « : » (« Mr. / Mme : »)
  const prefix = tidy(texts.join('\n'));
  if (prefix && !/[:：]$/.test(prefix)) return null; // texte fixe du modèle
  if (!label) return null;
  const kind = Fields.guessKind(label, height);
  // La saisie s'écrit après l'amorce (dernier paragraphe terminé par « : »), sinon dans le premier paragraphe
  const withPrefix = prefix ? texts.map((t) => t.trim()).findLastIndex((t) => /[:：]$/.test(t)) : -1;
  const target = paras[withPrefix >= 0 ? withPrefix : 0];
  const field = { key, label, kind, prefix, _paragraph: target ? { start: target.start, end: target.end } : null };
  if (kind === 'textarea') field.rows = Fields.rowsFor(height);
  return field;
}

/**
 * Analyse d'un modèle : { title, sections: [{ id, title, fields }], fieldCount }.
 * keepPositions : garde les positions internes (remplissage, relecture).
 */
function analyze(xml, { keepPositions = false } = {}) {
  const blocks = layout(xml);
  const sections = [];
  let pending = '';
  let title = '';
  let tableIndex = -1;
  for (const blk of blocks) {
    if (blk.type === 'p') {
      const t = tidy(blk.text);
      if (!t) continue;
      if (!title) title = t.split('\n')[0];
      if (t.length <= 120 && !t.includes('\n')) pending = t;
      else pending = '';
      continue;
    }
    tableIndex++;
    const fields = [];
    blk.rows.forEach((row, ri) => {
      const cells = row.cells;
      const pairs = [];
      if (cells.length === 1) pairs.push([null, 0]);
      else for (let ci = 0; ci + 1 < cells.length; ci += 2) pairs.push([ci, ci + 1]);
      for (const [li, vi] of pairs) {
        const vc = cells[vi];
        if (vc.merged) continue;
        const label = li === null ? '' : tidy(cellText(xml, cells[li])).replace(/\n/g, ' ').replace(/\s*:$/, '');
        const f = fieldOf(xml, label, vc, row.height, `t${tableIndex}.r${ri}.c${vi}`);
        if (!f) continue;
        f._cell = { start: vc.start, end: vc.end };
        fields.push(f);
      }
    });
    if (!fields.length) continue;
    if (!pending && sections.length) {
      sections[sections.length - 1].fields.push(...fields); // tableau qui prolonge la section précédente
    } else {
      sections.push({ id: `s${sections.length + 1}`, title: pending || `Section ${sections.length + 1}`, fields });
    }
    pending = '';
  }
  const fieldCount = sections.reduce((n, s) => n + s.fields.length, 0);
  const out = { title: title || 'Fiche', sections, fieldCount };
  return keepPositions ? out : publicSchema(out);
}

/** Schéma sans les positions internes (envoyé à la page). */
function publicSchema(schema) {
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
  return {
    ...schema,
    sections: schema.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => {
        const g = strip(f);
        g.assist = Fields.assistOf(f);
        return g;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Remplissage
// ---------------------------------------------------------------------------

const BOX_FONT = 'Segoe UI Symbol';

/** Balise ouvrante d'un paragraphe et ses propriétés : « <w:p …><w:pPr>…</w:pPr> ». */
function paragraphHead(xml, p) {
  const open = xml.slice(p.start, xml.indexOf('>', p.start) + 1);
  return open.endsWith('/>') ? { open: open.replace(/\/>$/, '>'), pPr: '' } : { open, pPr: X.paragraphProps(xml, p.start, p.end) };
}

/** Texte d'une option tel qu'il est écrit dans la fiche (précision comprise). */
function optionDocText(opt, extra) {
  const v = opt.extra ? Fields.formatValue(opt.extra.kind, String(extra || '')).trim().replace(/\n/g, ' ') : '';
  if (!v) return opt.text;
  if (opt.extra.mode === 'blank') {
    let done = false;
    return splitBlanks(opt.text)
      .map((p) => {
        if (!p.blank || done) return p.text;
        done = true;
        return v;
      })
      .join('');
  }
  return `${opt.text} ${v}`;
}

/** Texte d'une case de pointillés une fois complétée (pointillés gardés quand rien n'est saisi). */
function blanksDocText(field, value) {
  let i = 0;
  return field._pieces
    .map((p) => {
      if (!p.blank) return p.text;
      const b = field.blanks[i];
      const v = Fields.formatValue(b.kind, String((Array.isArray(value) ? value[i] : '') || '')).trim().replace(/\n/g, ' ');
      i++;
      return v || p.text;
    })
    .join('');
}

function choiceSelection(field, value) {
  if (field.kind === 'check') return value === true ? [0] : [];
  const sel = value && Array.isArray(value.selected) ? value.selected.filter((i) => Number.isInteger(i) && field._options[i]) : [];
  return field.multiple ? [...new Set(sel)] : sel.slice(0, 1);
}

/** Paragraphes réécrits pour un champ : [{ start, end, text }]. */
function fieldEdits(xml, field, value, image) {
  if (field.kind === 'choice' || field.kind === 'check') {
    const selected = new Set(choiceSelection(field, value));
    const extras = (value && value.extra) || {};
    return field._groups.map((g) => {
      const { open, pPr } = paragraphHead(xml, g.paragraph);
      let body = '';
      const prefixText = g.prefix.map((t) => t.text).join('');
      if (prefixText) body += X.textRun(g.prefix[0].rPr, prefixText);
      g.options.forEach((oi, j) => {
        const opt = field._options[oi];
        const on = selected.has(oi);
        body += X.textRun(X.withFont(opt._markRPr, BOX_FONT), on ? '☒' : '☐');
        const sep = j < g.options.length - 1 ? '   ' : '';
        // Espace insécable : la case reste sur la même ligne que le début de son texte
        body += X.textRun(on ? X.withBold(opt._labelRPr) : opt._labelRPr, ` ${on ? optionDocText(opt, extras[oi]) : opt.text}${sep}`);
      });
      return { start: g.paragraph.start, end: g.paragraph.end, text: `${open}${pPr}${body}</w:p>` };
    });
  }
  if (field.kind === 'blanks') {
    const { open, pPr } = paragraphHead(xml, field._paragraph);
    const rPr = field._rPr || X.paragraphRunProps(pPr);
    return [{ start: field._paragraph.start, end: field._paragraph.end, text: `${open}${pPr}${X.textRun(rPr, blanksDocText(field, value))}</w:p>` }];
  }
  if (!field._paragraph) return [];
  const text = field.kind === 'signature' ? String((value && value.name) || '').trim() : Fields.formatValue(field.kind, value);
  if (!text && !image) return [];
  const p = field._paragraph;
  const { open, pPr } = paragraphHead(xml, p);
  const existing = X.runs(xml, p.start, p.end);
  const rPr = existing.length ? existing[existing.length - 1].rPr : X.paragraphRunProps(pPr);
  const closing = xml.lastIndexOf('</w:p>', p.end);
  const selfClosing = closing < p.start;
  const inner = selfClosing ? '' : xml.slice(xml.indexOf('>', p.start) + 1, closing).slice(pPr.length);
  let out = `${open}${pPr}${inner}${text ? X.textRun(rPr, (field.prefix ? ' ' : '') + text) : ''}</w:p>`;
  if (image) out += `${open}${pPr}<w:r>${drawingXml(image)}</w:r></w:p>`;
  return [{ start: p.start, end: p.end, text: out }];
}

/** Image en ligne (signature) : { rId, id, cx, cy } en EMU. */
function drawingXml({ rId, id, cx, cy }) {
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  return (
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Signature ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:nvPicPr><pic:cNvPr id="${id}" name="signature-${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

/**
 * Document rempli. values : { [clé du champ]: saisie } ; images : { [clé]: { rId, id, cx, cy } } (signatures).
 */
function fill(xml, values, images = {}) {
  const schema = analyze(xml, { keepPositions: true });
  const edits = [];
  for (const s of schema.sections) {
    for (const f of s.fields) edits.push(...fieldEdits(xml, f, values[f.key], images[f.key]));
  }
  // Paragraphe vide qui termine le document après un tableau (imposé par Word) : réduit à presque rien, sinon
  // une fiche remplie jusqu'en bas de page en ferait une page blanche de plus
  const blocks = layout(xml);
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'p' && blocks.length > 1 && blocks[blocks.length - 2].type === 'tbl' && !last.text.trim() && !/<w:drawing[\s>]|<w:pict[\s>]/.test(xml.slice(last.start, last.end))) {
    const sectPr = (/<w:sectPr[\s>][\s\S]*<\/w:sectPr>/.exec(X.paragraphProps(xml, last.start, last.end)) || [''])[0];
    edits.push({ start: last.start, end: last.end, text: `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>${sectPr}</w:pPr></w:p>` });
  }
  let out = X.splice(xml, edits);
  // Espaces de noms des images (présents dans tout document Word récent, ajoutés sinon)
  if (Object.keys(images).length) {
    const NS = {
      'xmlns:wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
      'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    };
    out = out.replace(/<w:document(?=[\s>])[^>]*>/, (tag) => {
      let t = tag;
      for (const [k, v] of Object.entries(NS)) if (!new RegExp(`\\s${k}=`).test(t)) t = t.replace(/^<w:document/, `<w:document ${k}="${v}"`);
      return t;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relecture et vérification
// ---------------------------------------------------------------------------

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Texte d'une case (paragraphes séparés par des retours à la ligne) dans un fragment XML `<w:tc>…</w:tc>`. */
function fragmentCellText(frag) {
  const [a, b] = X.innerRange(frag, 0, frag.length);
  return X.children(frag, a, b, ['w:p'])
    .map((p) => X.textOf(frag, p.start, p.end))
    .join('\n');
}

/** Ce que la case d'un champ doit contenir une fois remplie : { text, checked: [index] | null, drawing }. */
function expectedCell(xml, field, value, image) {
  const edits = fieldEdits(xml, field, value, image);
  if (field.kind === 'choice' || field.kind === 'check') {
    const selected = choiceSelection(field, value).sort((a, b) => a - b);
    return { checked: selected, text: squash(edits.map((e) => X.textOf(e.text, 0, e.text.length)).join(' ')), drawing: false };
  }
  // Case du modèle avec la saisie écrite dedans : texte complet attendu (amorce et texte fixe compris)
  const { start, end } = field._cell;
  const frag = X.splice(xml.slice(start, end), edits.map((e) => ({ start: e.start - start, end: e.end - start, text: e.text })));
  return { text: squash(fragmentCellText(frag)), checked: null, drawing: Boolean(image) };
}

/** Lecture d'une case du document généré : texte, cases cochées (dans l'ordre), images. */
function readCell(xml, cell, field) {
  const toks = cell.paragraphs.flatMap((p) => tokens(xml, p));
  const marks = toks.filter((t) => t.type === 'mark');
  const checked = marks.map((m, i) => (m.checked ? i : -1)).filter((i) => i >= 0);
  const drawing = toks.some((t) => t.type === 'drawing');
  if (field.kind === 'choice' || field.kind === 'check') {
    // Texte des paragraphes à cases seulement (la note fixe du modèle n'en fait pas partie)
    const texts = cell.paragraphs
      .map((p) => tokens(xml, p))
      .filter((ts) => ts.some((t) => t.type === 'mark'))
      .map((ts) => ts.map((t) => (t.type === 'mark' ? (t.checked ? '☒' : '☐') : t.type === 'text' ? t.text : '')).join(''));
    return { text: squash(texts.join(' ')), checked, drawing, marks: marks.length };
  }
  return { text: squash(cellText(xml, cell)), checked: null, drawing, marks: marks.length };
}

/**
 * Vérifie un document généré (`out`) par rapport au modèle (`xml`) et aux saisies.
 * → [{ key, section, label, value (résumé lisible), filled, ok, problem }]
 */
function verify(xml, out, values, images = {}) {
  const schema = analyze(xml, { keepPositions: true });
  const plan = layout(out).filter((b) => b.type === 'tbl');
  const results = [];
  for (const s of schema.sections) {
    for (const f of s.fields) {
      const [, t, r, c] = /^t(\d+)\.r(\d+)\.c(\d+)$/.exec(f.key).map(Number);
      const cell = plan[t] && plan[t].rows[r] && plan[t].rows[r].cells[c];
      const value = values[f.key];
      const item = { key: f.key, section: s.title, label: f.label, value: Fields.display(f, value), filled: Fields.isFilled(f, value), ok: false, problem: '' };
      if (!cell) {
        item.problem = 'Case introuvable dans le fichier généré.';
        results.push(item);
        continue;
      }
      const want = expectedCell(xml, f, value, images[f.key]);
      const got = readCell(out, cell, f);
      if (f.kind === 'signature') {
        item.ok = got.text === want.text && (!want.drawing || got.drawing);
        if (!item.ok) item.problem = want.drawing && !got.drawing ? 'Signature absente du fichier.' : `Texte relu : « ${got.text.slice(0, 80)} »`;
      } else if (want.checked) {
        item.ok = got.marks === f._options.length && JSON.stringify(got.checked) === JSON.stringify(want.checked) && got.text === want.text;
        if (!item.ok) item.problem = 'Cases cochées différentes de la saisie.';
      } else {
        item.ok = got.text === want.text;
        if (!item.ok) item.problem = `Texte relu : « ${got.text.slice(0, 80)} »`;
      }
      results.push(item);
    }
  }
  return results;
}

module.exports = { analyze, fill, verify, layout, tokens, parseOption, splitBlanks, publicSchema, optionDocText, BLANK_RE };
