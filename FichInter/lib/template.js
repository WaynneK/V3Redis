/*
 * template.js — Modèle de fiche (word/document.xml) : analyse, remplissage, relecture.
 *
 * Analyse : le formulaire est déduit du document Word lui-même, sans réglage à écrire.
 *   - Une section = un tableau, titré par le paragraphe qui le précède (« 1. Identité ») ;
 *   - une ligne « intitulé | case » = un champ. Selon le contenu de la case :
 *       cases à cocher (« o », ☐, symboles Wingdings)  → choix (une seule case : à cocher) ;
 *       pointillés (« ………… », « ___ / ___ / _____ », « ___ h ___ ») → blancs à compléter (texte, date, heure) ;
 *       vide ou texte terminé par « : »                → texte, date, heure, e-mail… d'après l'intitulé ;
 *       plusieurs paragraphes vides soulignés          → texte sur plusieurs lignes (une ligne par trait) ;
 *       intitulé « signature »                         → nom + signature dessinée.
 *   - Une option terminée par « : » ou contenant des pointillés demande une précision
 *     (« Autre (Préciser) : », « Sous garantie (jusqu'au : ………… ) », « Oui – N° ………… »).
 *   - Une ligne sans intitulé dont la case n'a que des cases à cocher prolonge la liste de la ligne du dessus.
 *   - Mises en page plus riches :
 *       ligne de titres (style Titre 1/2) dans un tableau à colonnes → une section par colonne ;
 *       ligne de titres de cadre (style Titre 3…)                    → titre repris devant les intitulés
 *                                                                      (« Technicien · Nom ») ;
 *       cadre grisé « titre + paragraphe vide »                      → texte long (titre = intitulé) ;
 *       ligne d'en-têtes suivie de lignes vides                      → tableau à remplir (pièces…) ;
 *       cellule étroite vide (≤ 0,7 cm)                              → espace entre deux colonnes, ignorée ;
 *       texte après la dernière case d'une ligne                     → aide du champ.
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
      // Colonne de la grille où commence chaque cellule (cellules fusionnées horizontalement : w:gridSpan)
      let col = trPr ? Number((/<w:gridBefore w:val="(\d+)"/.exec(trPr[0]) || [])[1] || 0) : 0;
      const cells = X.children(xml, ri, re, ['w:tc']).map((tc) => {
        const [ci, ce] = X.innerRange(xml, tc.start, tc.end);
        const head = xml.slice(ci, Math.min(ce, ci + 2000));
        const tcPr = (/^<w:tcPr>[\s\S]*?<\/w:tcPr>/.exec(head) || [''])[0];
        const merged = /<w:vMerge\/>|<w:vMerge w:val="continue"\/>/.test(tcPr);
        const restart = /<w:vMerge w:val="restart"\/>/.test(tcPr);
        const span = Math.max(1, Number((/<w:gridSpan w:val="(\d+)"/.exec(tcPr) || [])[1] || 1));
        const tcW = /<w:tcW ([^>]*)\/>/.exec(tcPr);
        const width = tcW && !/w:type="(?:pct|auto|nil)"/.test(tcW[1]) ? Number((/w:w="(\d+)"/.exec(tcW[1]) || [])[1] || 0) : 0;
        const shd = /<w:shd [^>]*?w:fill="([0-9A-Fa-f]{6})"/.exec(tcPr);
        const shaded = Boolean(shd && !/^f{6}$/i.test(shd[1]));
        const paragraphs = X.children(xml, ci, ce, ['w:p']).map((p) => ({ start: p.start, end: p.end }));
        const cell = { start: tc.start, end: tc.end, merged, restart, col, span, width, shaded, paragraphs };
        col += span;
        return cell;
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

/**
 * Pointillés à compléter : « ……/……/………… » ou « ___ / ___ / _____ » (date), « ___ h ___ » (heure),
 * « ………… », « ....... », « _____ » (texte).
 */
const BLANK_RE = /([.…_]{2,}\s*\/\s*[.…_]{2,}\s*\/\s*[.…_]{2,})|([.…_]{2,}\s*h\s*[.…_]{2,})|(…[.…]*…|\.{4,}|_{4,})/g;
const hasBlank = (s) => {
  BLANK_RE.lastIndex = 0;
  return BLANK_RE.test(s);
};

/** Découpe un texte en morceaux fixes et pointillés : [{ text } | { blank: 'date'|'time'|'text', text }]. */
function splitBlanks(text) {
  const out = [];
  let last = 0;
  BLANK_RE.lastIndex = 0;
  let m;
  while ((m = BLANK_RE.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ blank: m[1] ? 'date' : m[2] ? 'time' : 'text', text: m[0] });
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
    // « Sous garantie (jusqu'au : ………… ) », « Sous garantie jusqu'au ___ / ___ / _____ » : libellé « Sous garantie »,
    // précision « jusqu'au » (date) ; « Oui – N° ………… » : libellé « Oui », précision « N° »
    const open = before.lastIndexOf('(');
    let label = before;
    let hint = '';
    let m;
    if (open >= 0) [label, hint] = [before.slice(0, open), before.slice(open + 1)];
    else if ((m = /^(.*?)\s+[–—-]\s+(.*?)[\s:]*$/.exec(before))) [label, hint] = [m[1], m[2]];
    else if ((m = /^(.*?)\s+(jusqu['’]\s?(?:au|à)|depuis(?: le)?|le|du|au)[\s:]*$/i.exec(before))) [label, hint] = [m[1], m[2]];
    label = tidy(label.replace(/[:(\s]+$/, ''));
    hint = tidy(hint.replace(/[:\s]+$/, '')) || 'Préciser';
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

/** Contenu d'une cellule : { text, marks (cases à cocher), blank (pointillés), drawing }. */
function cellInfo(xml, cell) {
  if (!cell._info) {
    const toks = cell.paragraphs.flatMap((p) => tokens(xml, p));
    const text = toks.filter((t) => t.type === 'text').map((t) => t.text).join('');
    cell._info = { text: cellText(xml, cell), marks: toks.some((t) => t.type === 'mark'), blank: hasBlank(text), drawing: toks.some((t) => t.type === 'drawing') };
  }
  return cell._info;
}

/** Niveau de titre d'un paragraphe (style « Titre 2 » / « Heading 2 », niveau hiérarchique) ; 0 sinon. */
function headingLevel(xml, p) {
  const pPr = X.paragraphProps(xml, p.start, p.end);
  const style = (/<w:pStyle w:val="([^"]+)"/.exec(pPr) || [])[1] || '';
  const m = /^(?:heading|titre)\s?(\d)$/i.exec(style);
  if (m) return Number(m[1]);
  const lvl = /<w:outlineLvl w:val="(\d)"\/>/.exec(pPr);
  return lvl && Number(lvl[1]) < 9 ? Number(lvl[1]) + 1 : 0;
}

/** Paragraphe souligné (bordure basse) : une ligne à remplir. */
function underlined(xml, p) {
  return /<w:pBdr>[\s\S]*?<w:bottom\b(?![^>]*w:val="(?:nil|none)")/.test(X.paragraphProps(xml, p.start, p.end));
}

/** Cellule étroite et vide (≤ 0,7 cm) : espace entre deux colonnes de la mise en page. */
function isSpacer(xml, cell) {
  if (!cell.width || cell.width > 400 || cell.shaded) return false;
  const i = cellInfo(xml, cell);
  return !i.text.trim() && !i.marks && !i.drawing;
}

/** Cadre grisé « titre + paragraphe(s) vide(s) » (« Description de la panne ») : son titre, sinon ''. */
function frameTitle(xml, cell) {
  if (cell.merged || !cell.shaded || cell.paragraphs.length < 2) return '';
  const [first, ...rest] = cell.paragraphs.map((p) => tokens(xml, p));
  if ([first, ...rest].some((ts) => ts.some((t) => t.type === 'mark'))) return '';
  if (rest.some((ts) => ts.some((t) => t.type === 'drawing' || (t.type === 'text' && t.text.trim())))) return '';
  const title = tidy(first.filter((t) => t.type === 'text').map((t) => t.text).join(''));
  if (!title || title.length > 80 || hasBlank(title) || headingLevel(xml, cell.paragraphs[0])) return '';
  return title.replace(/\s*:$/, '');
}

/**
 * Ligne de titres (« 1 CLIENT | 2 INTERVENTION », « Technicien | Client ») : [{ col, level, title }] ou null.
 * Les autres cellules de la ligne (mention, espace) sont ignorées.
 */
function titleRow(xml, row) {
  const heads = [];
  for (const c of row.cells) {
    if (c.merged) continue;
    const i = cellInfo(xml, c);
    if (i.marks || i.blank) return null;
    const level = c.paragraphs.length ? headingLevel(xml, c.paragraphs[0]) : 0;
    if (level && i.text.trim()) heads.push({ col: c.col, level, title: tidy(i.text).replace(/\n/g, ' ') });
  }
  return heads.length ? heads : null;
}

/** Tableau à remplir : ligne d'en-têtes (ri) suivie de lignes vides de même découpage → { columns, data: [lignes] } ou null. */
function gridAt(xml, rows, ri) {
  const head = rows[ri].cells;
  if (head.length < 2 || head.some((c) => c.merged)) return null;
  const infos = head.map((c) => cellInfo(xml, c));
  if (infos.some((i) => !i.text.trim() || i.marks || i.blank || i.drawing)) return null;
  const data = [];
  for (let r = ri + 1; r < rows.length; r++) {
    const cs = rows[r].cells;
    if (cs.length !== head.length || cs.some((c, k) => c.merged || c.col !== head[k].col)) break;
    if (cs.some((c) => {
      const i = cellInfo(xml, c);
      return i.text.trim() || i.marks || i.drawing;
    })) break;
    data.push(r);
  }
  return data.length ? { columns: infos.map((i) => tidy(i.text).replace(/\n/g, ' ')), data } : null;
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
        // Mise en forme du texte de l'option (pas celle de la case : police de symboles)
        const labelPart = it.parts.find((t) => t.text.trim()) || it.parts[0];
        const labelRPr = labelPart ? labelPart.rPr : it.mark.rPr;
        group.options.push(options.length);
        options.push({ ...opt, _markRPr: it.mark.rPr, _labelRPr: labelRPr, _parts: it.parts, _checked: it.mark.checked });
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
      options: options.map(publicOption),
      note,
      _options: options,
      _groups: groups,
      _unlabeled: !label,
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
      const kind = piece.blank === 'date' || piece.blank === 'time' ? piece.blank : Fields.guessKind(before) === 'date' ? 'date' : 'text';
      let bl = before;
      if (kind === 'date' && (!bl || /^(le|du|au|date)$/i.test(bl))) bl = 'Date';
      if (kind === 'time' && (!bl || /^(à|a|vers|de|heure)$/i.test(bl))) bl = 'Heure';
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
  let kind = Fields.guessKind(label, height);
  // Plusieurs paragraphes vides soulignés (« Adresse » sur deux lignes) : une ligne de texte par trait
  const lined = paras.length >= 2 && !prefix && paras.filter((p) => underlined(xml, p)).length >= 2 && (kind === 'text' || kind === 'textarea');
  if (lined) kind = 'textarea';
  // La saisie s'écrit après l'amorce (dernier paragraphe terminé par « : »), sinon dans le premier paragraphe
  const withPrefix = prefix ? texts.map((t) => t.trim()).findLastIndex((t) => /[:：]$/.test(t)) : -1;
  const target = paras[withPrefix >= 0 ? withPrefix : 0];
  const field = { key, label, kind, prefix, _paragraph: target ? { start: target.start, end: target.end } : null };
  if (lined) {
    field.rows = paras.length;
    field._lines = paras.map((p) => ({ start: p.start, end: p.end }));
  } else if (kind === 'textarea') field.rows = Fields.rowsFor(height);
  return field;
}

const publicOption = ({ text, label, sub, extra }) => ({ text, label, sub, extra });

/** Ajoute à une liste de cases à cocher celles de la ligne suivante (ligne sans intitulé). */
function mergeChoices(into, more) {
  const offset = into._options.length;
  into._options.push(...more._options);
  into._groups.push(...more._groups.map((g) => ({ ...g, options: g.options.map((i) => i + offset) })));
  into.options = into._options.map(publicOption);
  into.kind = 'choice';
  into.multiple = into.multiple || into._options.length >= 6;
  into._at.push(...more._at);
  into._cells.push(...more._cells);
}

/** Champs d'un tableau (index T), dans l'ordre de lecture. Positions : _t, _at [[ligne, case]], _cells. */
function tableFields(xml, tbl, T) {
  const fields = [];
  const frameCols = new Set(); // colonnes d'un cadre fusionné verticalement (ses lignes suivantes sont ignorées)
  let heads = null;
  const place = (f, row, cells, vcol) => Object.assign(f, { _t: T, _row: row, _vcol: vcol, _at: cells.map((c) => [row, c.ci]), _cells: cells.map(({ c }) => ({ start: c.start, end: c.end })) });
  const rows = tbl.rows;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const heading = titleRow(xml, row);
    if (heading) {
      heads = heading;
      continue;
    }
    const rowFields = [];

    // Tableau à remplir (« Désignation | Référence | Qté » puis lignes vides)
    const grid = gridAt(xml, rows, ri);
    if (grid) {
      const prev = ri > 0 ? rows[ri - 1].cells.filter((c) => !c.merged && !isSpacer(xml, c)) : [];
      const prevInfo = prev.length === 1 ? cellInfo(xml, prev[0]) : null;
      const caption = prevInfo && prevInfo.text.trim() && !prevInfo.marks && !prevInfo.blank ? tidy(prevInfo.text).replace(/\n/g, ' ').replace(/\s*:$/, '') : '';
      const f = {
        key: `t${T}.r${grid.data[0]}.c0`,
        label: caption || grid.columns.join(' / '),
        kind: 'table',
        columns: grid.columns,
        rows: grid.data.length,
        _grid: grid.data.map((r) => rows[r].cells.map((c) => ({ paragraph: c.paragraphs[0] || null }))),
      };
      Object.assign(f, {
        _t: T,
        _row: grid.data[grid.data.length - 1],
        _vcol: row.cells[0].col,
        _at: grid.data.flatMap((r) => rows[r].cells.map((c, ci) => [r, ci])),
        _cells: grid.data.flatMap((r) => rows[r].cells.map((c) => ({ start: c.start, end: c.end }))),
      });
      rowFields.push(f);
      ri = grid.data[grid.data.length - 1];
    } else {
      const rest = [];
      row.cells.forEach((c, ci) => {
        if (c.merged && frameCols.has(c.col)) return;
        const title = frameTitle(xml, c);
        if (title) {
          let kind = Fields.guessKind(title, row.height);
          if (kind !== 'signature') kind = 'textarea';
          const target = c.paragraphs[1];
          const f = { key: `t${T}.r${ri}.c${ci}`, label: title, kind, prefix: '', _paragraph: { start: target.start, end: target.end } };
          if (kind === 'textarea') f.rows = Math.max(3, Fields.rowsFor(row.height));
          rowFields.push(place(f, ri, [{ c, ci }], c.col));
          if (c.restart) frameCols.add(c.col);
          return;
        }
        if (isSpacer(xml, c)) return;
        rest.push({ c, ci });
      });
      // Cases « intitulé | valeur » (une case seule : sans intitulé)
      const pairs = rest.length === 1 ? [[null, rest[0]]] : [];
      for (let i = 0; rest.length > 1 && i + 1 < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
      for (const [l, v] of pairs) {
        if (v.c.merged) continue;
        const label = l ? tidy(cellText(xml, l.c)).replace(/\n/g, ' ').replace(/\s*:$/, '') : '';
        const f = fieldOf(xml, label, v.c, row.height, `t${T}.r${ri}.c${v.ci}`);
        if (f) rowFields.push(place(f, ri, [v], v.c.col));
      }
      // Texte seul après la dernière case (« (ne jamais noter le mot de passe) ») : aide du champ qui précède
      if (rest.length > 2 && rest.length % 2) {
        const last = rest[rest.length - 1];
        const info = cellInfo(xml, last.c);
        const f = rowFields.find((x) => x.key === `t${T}.r${ri}.c${rest[rest.length - 2].ci}`);
        if (f && !f.note && !last.c.merged && info.text.trim() && !info.marks && !info.blank) f.note = cap(tidy(info.text).replace(/\n/g, ' ').replace(/^\((.*)\)$/, '$1'));
      }
      // « Fin » à côté d'une heure d'arrivée : une heure aussi
      for (const f of rowFields) {
        if (f.kind === 'text' && /^(fin|debut|depart|arrivee)$/.test(Fields.norm(f.label)) && rowFields.some((o) => o.kind === 'time')) f.kind = 'time';
      }
      // Ligne sans intitulé, cases à cocher sous celles de la ligne du dessus : suite de la même liste
      for (const f of [...rowFields]) {
        if (!f._unlabeled) continue;
        const above = fields.find((o) => o._row === ri - 1 && o._vcol === f._vcol && (o.kind === 'choice' || o.kind === 'check'));
        if (!above) continue;
        mergeChoices(above, f);
        rowFields.splice(rowFields.indexOf(f), 1);
      }
    }

    // Colonnes titrées : section (Titre 1/2) ou titre de cadre repris devant l'intitulé (Titre 3…)
    rowFields.sort((a, b) => a._vcol - b._vcol);
    for (const f of rowFields) {
      const h = heads && heads.filter((x) => x.col <= f._vcol).pop();
      if (!h) continue;
      if (h.level <= 2) f._section = h.title;
      else {
        f.label = `${h.title} · ${f.label}`;
        f._frame = h.col;
      }
    }
    fields.push(...rowFields);
  }
  // Cadres côte à côte (Technicien | Client) : les champs d'un cadre se suivent dans le formulaire
  fields.sort((a, b) => (a._frame === undefined ? -1 : a._frame) - (b._frame === undefined ? -1 : b._frame));
  // Signature d'un cadre qui a déjà sa case « Nom » : seule la signature dessinée est demandée
  for (const f of fields) {
    const group = f.kind === 'signature' && f.label.includes(' · ') ? f.label.split(' · ')[0] : '';
    if (group && fields.some((o) => o.kind !== 'signature' && o.label.startsWith(`${group} · `) && /^nom\b/i.test(o.label.slice(group.length + 3)))) f.nameless = true;
  }
  return fields;
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
    // Document qui commence par un tableau (en-tête avec logo) : titre = premier texte du tableau
    if (!title) title = (blk.rows.flatMap((r) => r.cells).map((c) => tidy(cellText(xml, c))).find(Boolean) || '').split('\n')[0];
    const fields = tableFields(xml, blk, tableIndex);
    if (!fields.length) continue;
    const loose = fields.filter((f) => !f._section);
    if (loose.length) {
      if (!pending && sections.length) {
        sections[sections.length - 1].fields.push(...loose); // tableau qui prolonge la section précédente
      } else {
        sections.push({ id: `s${sections.length + 1}`, title: pending || (sections.length ? `Section ${sections.length + 1}` : 'Informations générales'), fields: loose });
      }
    }
    // Colonnes titrées : une section chacune, dans l'ordre des titres
    const named = new Map();
    for (const f of fields) if (f._section) named.set(f._section, [...(named.get(f._section) || []), f]);
    for (const [t, fs] of named) sections.push({ id: `s${sections.length + 1}`, title: t, fields: fs });
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

/**
 * Passages d'une case de pointillés une fois complétée : texte fixe et pointillés laissés vides dans la mise en forme
 * du modèle, saisies dans la couleur du texte (pas le gris des pointillés).
 */
function blanksRuns(field, value, rPr) {
  const valueRPr = rPr.replace(/<w:color [^>]*\/>/, '');
  let i = 0;
  return field._pieces
    .map((p) => {
      if (!p.blank) return X.textRun(rPr, p.text);
      const b = field.blanks[i];
      const v = Fields.formatValue(b.kind, String((Array.isArray(value) ? value[i] : '') || '')).trim().replace(/\n/g, ' ');
      i++;
      return v ? X.textRun(valueRPr, v) : X.textRun(rPr, p.text);
    })
    .join('');
}

function choiceSelection(field, value) {
  if (field.kind === 'check') return value === true ? [0] : [];
  const sel = value && Array.isArray(value.selected) ? value.selected.filter((i) => Number.isInteger(i) && field._options[i]) : [];
  return field.multiple ? [...new Set(sel)] : sel.slice(0, 1);
}

/** Paragraphe du modèle avec un texte ajouté à la fin (mise en forme du dernier passage, ou du paragraphe). */
function paragraphWith(xml, p, text) {
  const { open, pPr } = paragraphHead(xml, p);
  const existing = X.runs(xml, p.start, p.end);
  const rPr = existing.length ? existing[existing.length - 1].rPr : X.paragraphRunProps(pPr);
  const closing = xml.lastIndexOf('</w:p>', p.end);
  const selfClosing = closing < p.start;
  const inner = selfClosing ? '' : xml.slice(xml.indexOf('>', p.start) + 1, closing).slice(pPr.length);
  return `${open}${pPr}${inner}${text ? X.textRun(rPr, text) : ''}</w:p>`;
}

/** Texte d'une option découpé comme dans le modèle : passages sans les espaces des bords, espaces de fin à part. */
function trimParts(parts) {
  const segs = parts.filter((t) => t.text).map((t) => ({ text: t.text, rPr: t.rPr }));
  let trail = '';
  let trailRPr = segs.length ? segs[segs.length - 1].rPr : '';
  while (segs.length && !segs[0].text.trim()) segs.shift();
  while (segs.length && !segs[segs.length - 1].text.trim()) trail = segs.pop().text + trail;
  if (segs.length) {
    segs[0].text = segs[0].text.replace(/^\s+/, '');
    const last = segs[segs.length - 1];
    const m = /\s+$/.exec(last.text);
    if (m) {
      trail = m[0] + trail;
      last.text = last.text.slice(0, m.index);
    }
    trailRPr = last.rPr;
  }
  return { segs, trail, trailRPr };
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
        const { segs, trail, trailRPr } = trimParts(opt._parts || []);
        const extra = on && opt.extra ? Fields.formatValue(opt.extra.kind, String(extras[oi] || '')).trim() : '';
        // Espace insécable (\u00a0) : la case reste sur la même ligne que le début de son texte
        if (!extra && segs.length) {
          // Texte du modèle repris passage par passage (précision en italique, espacement entre les options)
          body += segs.map((t, k) => X.textRun(on ? X.withBold(t.rPr) : t.rPr, `${k ? '' : '\u00a0'}${t.text}`)).join('');
          if (trail || sep) body += X.textRun(trailRPr, trail || sep);
        } else {
          body += X.textRun(on ? X.withBold(opt._labelRPr) : opt._labelRPr, `\u00a0${on ? optionDocText(opt, extras[oi]) : opt.text}${trail || sep}`);
        }
      });
      return { start: g.paragraph.start, end: g.paragraph.end, text: `${open}${pPr}${body}</w:p>` };
    });
  }
  if (field.kind === 'blanks') {
    const { open, pPr } = paragraphHead(xml, field._paragraph);
    const rPr = field._rPr || X.paragraphRunProps(pPr);
    return [{ start: field._paragraph.start, end: field._paragraph.end, text: `${open}${pPr}${blanksRuns(field, value, rPr)}</w:p>` }];
  }
  if (field.kind === 'table') {
    // Une saisie par case du tableau (valeur : liste à plat, ligne par ligne)
    const vals = Array.isArray(value) ? value : [];
    const cols = field.columns.length;
    const edits = [];
    field._grid.forEach((row, r) =>
      row.forEach((cell, c) => {
        const v = Fields.formatValue('text', String(vals[r * cols + c] || '')).replace(/\s*\n\s*/g, ' ').trim();
        if (v && cell.paragraph) edits.push({ start: cell.paragraph.start, end: cell.paragraph.end, text: paragraphWith(xml, cell.paragraph, v) });
      })
    );
    return edits;
  }
  if (!field._paragraph) return [];
  const text = field.kind === 'signature' ? (field.nameless ? '' : String((value && value.name) || '').trim()) : Fields.formatValue(field.kind, value);
  if (!text && !image) return [];
  if (field._lines && text) {
    // Une ligne de texte par trait ; ce qui dépasse s'écrit à la suite sur le dernier
    const lines = text.split('\n');
    const n = field._lines.length;
    return field._lines
      .map((p, i) => {
        const t = i === n - 1 ? lines.slice(i).join('\n') : lines[i] || '';
        return t ? { start: p.start, end: p.end, text: paragraphWith(xml, p, t) } : null;
      })
      .filter(Boolean);
  }
  const p = field._paragraph;
  let out = paragraphWith(xml, p, text ? (field.prefix ? ' ' : '') + text : '');
  if (image) {
    const { open, pPr } = paragraphHead(xml, p);
    out += `${open}${pPr}<w:r>${drawingXml(image)}</w:r></w:p>`;
  }
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

/** Ce que les cases d'un champ doivent contenir une fois remplies : { text, checked: [index] | null, drawing }. */
function expectedCell(xml, field, value, image) {
  const edits = fieldEdits(xml, field, value, image);
  if (field.kind === 'choice' || field.kind === 'check') {
    const selected = choiceSelection(field, value).sort((a, b) => a - b);
    return { checked: selected, text: squash(edits.map((e) => X.textOf(e.text, 0, e.text.length)).join(' ')), drawing: false };
  }
  // Cases du modèle avec la saisie écrite dedans : texte complet attendu (amorce et texte fixe compris)
  const texts = field._cells.map(({ start, end }) => {
    const inside = edits.filter((e) => e.start >= start && e.end <= end).map((e) => ({ start: e.start - start, end: e.end - start, text: e.text }));
    return fragmentCellText(X.splice(xml.slice(start, end), inside));
  });
  return { text: squash(texts.join(' ')), checked: null, drawing: Boolean(image) };
}

/** Lecture des cases d'un champ dans le document généré : texte, cases cochées (dans l'ordre), images. */
function readCell(xml, cells, field) {
  const paragraphs = cells.flatMap((c) => c.paragraphs);
  const toks = paragraphs.flatMap((p) => tokens(xml, p));
  const marks = toks.filter((t) => t.type === 'mark');
  const checked = marks.map((m, i) => (m.checked ? i : -1)).filter((i) => i >= 0);
  const drawing = toks.some((t) => t.type === 'drawing');
  if (field.kind === 'choice' || field.kind === 'check') {
    // Texte des paragraphes à cases seulement (la note fixe du modèle n'en fait pas partie)
    const texts = paragraphs
      .map((p) => tokens(xml, p))
      .filter((ts) => ts.some((t) => t.type === 'mark'))
      .map((ts) => ts.map((t) => (t.type === 'mark' ? (t.checked ? '☒' : '☐') : t.type === 'text' ? t.text : '')).join(''));
    return { text: squash(texts.join(' ')), checked, drawing, marks: marks.length };
  }
  return { text: squash(cells.map((c) => cellText(xml, c)).join(' ')), checked: null, drawing, marks: marks.length };
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
      const cells = f._at.map(([r, c]) => plan[f._t] && plan[f._t].rows[r] && plan[f._t].rows[r].cells[c]);
      const value = values[f.key];
      const item = { key: f.key, section: s.title, label: f.label, value: Fields.display(f, value), filled: Fields.isFilled(f, value), ok: false, problem: '' };
      if (cells.some((c) => !c)) {
        item.problem = 'Case introuvable dans le fichier généré.';
        results.push(item);
        continue;
      }
      const want = expectedCell(xml, f, value, images[f.key]);
      const got = readCell(out, cells, f);
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
