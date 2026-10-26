/*
 * textremove.js — Suppression du texte d'origine sous une ligne modifiée (outil « Modifier », lib/edit.js).
 *
 * Le contenu de la page (suite d'instructions PDF) est lu instruction par instruction : position du texte
 * (matrices cm / Tm / Td…), état du texte (police, taille, espacements), largeur des glyphes d'après la police.
 * Chaque instruction qui écrit du texte (Tj, TJ, ', ") et qui tient ENTIÈREMENT dans une zone donnée est
 * remplacée par un simple déplacement de même longueur ([-n] TJ) : rien n'est plus dessiné, le texte n'est
 * plus dans le fichier, et la suite de la ligne garde sa place.
 *
 * Prudence : la moindre incertitude (police sans largeurs connues, encodage à plusieurs octets non standard,
 * flux illisible) laisse l'instruction telle quelle ; l'appelant garde alors son cache par-dessus.
 */
'use strict';

const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } = require('pdf-lib');
const { Font, FontNames, Encodings } = require('@pdf-lib/standard-fonts');

// ---------------------------------------------------------------------------
// Lecture des instructions
// ---------------------------------------------------------------------------

const WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c, 0x00]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

class ParseError extends Error {}

/**
 * Instructions d'un contenu (chaîne latin1) : [{ op, args, start, end }] — start : début du premier opérande.
 * Valeurs : nombres, { name }, { str } (octets en latin1), tableaux ; dictionnaires ignorés ({ dict: true }).
 */
function parseContent(s) {
  const ops = [];
  let i = 0;
  const n = s.length;
  const code = (k) => s.charCodeAt(k);

  const skipWs = () => {
    while (i < n) {
      const c = code(i);
      if (WS.has(c)) i++;
      else if (c === 0x25) {
        // commentaire jusqu'à la fin de la ligne
        while (i < n && code(i) !== 0x0a && code(i) !== 0x0d) i++;
      } else break;
    }
  };

  const readLiteral = () => {
    i++; // (
    let depth = 1;
    let out = '';
    while (i < n) {
      const ch = s[i];
      if (ch === '\\') {
        const nx = s[i + 1];
        if (nx === undefined) throw new ParseError('chaîne');
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (map[nx] !== undefined) {
          out += map[nx];
          i += 2;
        } else if (/[0-7]/.test(nx)) {
          let oct = '';
          let k = i + 1;
          while (k < n && oct.length < 3 && /[0-7]/.test(s[k])) oct += s[k++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          i = k;
        } else if (nx === '\r') {
          i += s[i + 2] === '\n' ? 3 : 2;
        } else if (nx === '\n') {
          i += 2;
        } else {
          out += nx;
          i += 2;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          i++;
          return { str: out };
        }
      }
      out += ch;
      i++;
    }
    throw new ParseError('chaîne non fermée');
  };

  const readHex = () => {
    const end = s.indexOf('>', i);
    if (end < 0) throw new ParseError('chaîne hexadécimale');
    let hex = s.slice(i + 1, end).replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new ParseError('chaîne hexadécimale');
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
    i = end + 1;
    return { str: out };
  };

  const readToken = () => {
    skipWs();
    if (i >= n) return null;
    const c = s[i];
    if (c === '(') return readLiteral();
    if (c === '<') {
      if (s[i + 1] === '<') {
        // dictionnaire (opérande de BDC, DP…) : ignoré, imbrication comprise
        let depth = 0;
        while (i < n) {
          if (s[i] === '<' && s[i + 1] === '<') {
            depth++;
            i += 2;
          } else if (s[i] === '>' && s[i + 1] === '>') {
            depth--;
            i += 2;
            if (!depth) return { dict: true };
          } else if (s[i] === '(') readLiteral();
          else i++;
        }
        throw new ParseError('dictionnaire');
      }
      return readHex();
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipWs();
        if (i >= n) throw new ParseError('tableau');
        if (s[i] === ']') {
          i++;
          return arr;
        }
        const t = readToken();
        if (t && t.op !== undefined) throw new ParseError('tableau');
        arr.push(t);
      }
    }
    if (c === '/') {
      let k = i + 1;
      while (k < n && !WS.has(code(k)) && !DELIM.has(code(k))) k++;
      const name = s.slice(i + 1, k);
      i = k;
      return { name };
    }
    if (c === ']' || c === ')' || c === '>' || c === '{' || c === '}') throw new ParseError(`caractère ${c}`);
    let k = i;
    while (k < n && !WS.has(code(k)) && !DELIM.has(code(k))) k++;
    if (k === i) throw new ParseError('jeton vide');
    const word = s.slice(i, k);
    i = k;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    return { op: word };
  };

  let args = [];
  let start = -1;
  while (true) {
    skipWs();
    if (i >= n) break;
    const before = i;
    const t = readToken();
    if (t === null) break;
    if (t && t.op !== undefined) {
      const op = t.op;
      if (op === 'true' || op === 'false' || op === 'null') {
        if (start < 0) start = before;
        args.push(op === 'true');
        continue;
      }
      if (op === 'BI') {
        // Image en ligne : données binaires jusqu'à « EI » entouré d'espaces
        const id = s.indexOf('ID', i);
        if (id < 0) throw new ParseError('image en ligne');
        const re = /\sEI(?=[\s]|$)/g;
        re.lastIndex = id + 3;
        const m = re.exec(s);
        if (!m) throw new ParseError('image en ligne');
        i = m.index + m[0].length;
        ops.push({ op: 'BI', args: [], start: before, end: i });
      } else {
        ops.push({ op, args, start: start < 0 ? before : start, end: i });
      }
      args = [];
      start = -1;
    } else {
      if (start < 0) start = before;
      args.push(t);
    }
  }
  if (args.length) throw new ParseError('opérandes sans instruction');
  return ops;
}

// ---------------------------------------------------------------------------
// Largeur des glyphes
// ---------------------------------------------------------------------------

const STD = {
  Helvetica: FontNames.Helvetica,
  'Helvetica-Bold': FontNames.HelveticaBold,
  'Helvetica-Oblique': FontNames.HelveticaOblique,
  'Helvetica-BoldOblique': FontNames.HelveticaBoldOblique,
  'Times-Roman': FontNames.TimesRoman,
  'Times-Bold': FontNames.TimesRomanBold,
  'Times-Italic': FontNames.TimesRomanItalic,
  'Times-BoldItalic': FontNames.TimesRomanBoldItalic,
  Courier: FontNames.Courier,
  'Courier-Bold': FontNames.CourierBold,
  'Courier-Oblique': FontNames.CourierOblique,
  'Courier-BoldOblique': FontNames.CourierBoldOblique,
  Arial: FontNames.Helvetica,
  'Arial,Bold': FontNames.HelveticaBold,
  'Arial,Italic': FontNames.HelveticaOblique,
  'Arial,BoldItalic': FontNames.HelveticaBoldOblique,
};

let winAnsiNames = null;
/** Code WinAnsi → nom du glyphe (« eacute »). */
function winAnsiName(c) {
  if (!winAnsiNames) {
    winAnsiNames = new Map();
    for (const cp of Encodings.WinAnsi.supportedCodePoints) {
      const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
      if (!winAnsiNames.has(code)) winAnsiNames.set(code, name);
    }
  }
  return winAnsiNames.get(c);
}

const num = (v) => (v instanceof PDFNumber ? v.asNumber() : undefined);
const nameOf = (v) => (v instanceof PDFName ? v.decodeText() : undefined);

/**
 * Largeurs d'une police (dictionnaire PDF) : { glyphs(octets) → [{ w (millièmes), space }] } ou null si inconnues.
 */
function fontMetrics(dict) {
  if (!(dict instanceof PDFDict)) return null;
  const subtype = nameOf(dict.lookup(PDFName.of('Subtype')));
  if (subtype === 'Type0') {
    const enc = nameOf(dict.lookup(PDFName.of('Encoding')));
    if (enc !== 'Identity-H' && enc !== 'Identity-V') return null; // autres codages : longueur des codes variable
    const descendants = dict.lookup(PDFName.of('DescendantFonts'));
    const cid = descendants instanceof PDFArray ? descendants.lookup(0) : null;
    if (!(cid instanceof PDFDict)) return null;
    const dw = num(cid.lookup(PDFName.of('DW'))) ?? 1000;
    const widths = new Map();
    const W = cid.lookup(PDFName.of('W'));
    if (W instanceof PDFArray) {
      const a = W.asArray().map((x) => cid.context.lookup(x));
      for (let k = 0; k < a.length; ) {
        const first = num(a[k]);
        if (first === undefined) return null;
        if (a[k + 1] instanceof PDFArray) {
          a[k + 1].asArray().forEach((w, j) => widths.set(first + j, num(cid.context.lookup(w)) ?? dw));
          k += 2;
        } else {
          const last = num(a[k + 1]);
          const w = num(a[k + 2]);
          if (last === undefined || w === undefined || last - first > 70000) return null;
          for (let c = first; c <= last; c++) widths.set(c, w);
          k += 3;
        }
      }
    }
    return {
      glyphs(bytes) {
        if (bytes.length % 2) return null;
        const out = [];
        for (let k = 0; k < bytes.length; k += 2) {
          const c = (bytes.charCodeAt(k) << 8) | bytes.charCodeAt(k + 1);
          out.push({ w: widths.has(c) ? widths.get(c) : dw, space: false });
        }
        return out;
      },
    };
  }
  if (subtype === 'Type3') return null; // largeurs dans le repère propre de la police
  const widthsArr = dict.lookup(PDFName.of('Widths'));
  if (widthsArr instanceof PDFArray) {
    const first = num(dict.lookup(PDFName.of('FirstChar'))) ?? 0;
    const ws = widthsArr.asArray().map((x) => num(dict.context.lookup(x)) ?? 0);
    const desc = dict.lookup(PDFName.of('FontDescriptor'));
    const missing = desc instanceof PDFDict ? num(desc.lookup(PDFName.of('MissingWidth'))) ?? 0 : 0;
    return {
      glyphs(bytes) {
        const out = [];
        for (let k = 0; k < bytes.length; k++) {
          const c = bytes.charCodeAt(k);
          const w = ws[c - first];
          out.push({ w: w === undefined ? missing : w, space: c === 32 });
        }
        return out;
      },
    };
  }
  // Police standard sans largeurs (créée par pdf-lib, par exemple) : métriques AFM, codage WinAnsi
  const base = nameOf(dict.lookup(PDFName.of('BaseFont')));
  const std = base && STD[base.replace(/^[A-Z]{6}\+/, '')];
  const enc = nameOf(dict.lookup(PDFName.of('Encoding')));
  if (!std || (enc && enc !== 'WinAnsiEncoding')) return null;
  const font = Font.load(std);
  return {
    glyphs(bytes) {
      const out = [];
      for (let k = 0; k < bytes.length; k++) {
        const c = bytes.charCodeAt(k);
        const name = winAnsiName(c);
        const w = name ? font.getWidthOfGlyph(name) : undefined;
        if (w === undefined) return null;
        out.push({ w, space: c === 32 });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Parcours du contenu
// ---------------------------------------------------------------------------

const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const ID = [1, 0, 0, 1, 0, 0];
const fmtNum = (v) => String(Math.round(v * 1000) / 1000);

/**
 * Retire le texte qui tient dans des rectangles (repère du PDF : { x1, y1, x2, y2 }).
 * contentStr : contenu de la page (latin1) ; fontOf(nom de ressource) → métriques ou null.
 * → { content: nouveau contenu (ou null si rien retiré), removed: [par zone] instructions retirées,
 *     kept: [par zone] instructions de texte touchant la zone mais gardées (largeurs inconnues, ou débordant) }
 */
function removeTextInRects(contentStr, rects, fontOf) {
  const ops = parseContent(contentStr);
  const inside = (p) => rects.findIndex((r) => p[0] >= r.x1 && p[0] <= r.x2 && p[1] >= r.y1 && p[1] <= r.y2);
  let gs = { ctm: ID.slice(), Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, size: 0, rise: 0 };
  const stack = [];
  let Tm = ID.slice();
  let Tlm = ID.slice();
  const edits = [];
  const removed = rects.map(() => 0);
  const kept = rects.map(() => 0);

  const nextLine = (tx, ty) => {
    Tlm = mul([1, 0, 0, 1, tx, ty], Tlm);
    Tm = Tlm.slice();
  };

  /** Écrit un texte : déplacement calculé ; remplacé si entièrement dans une zone. */
  const show = (op, strings, prefix) => {
    // strings : [{ str } | nombre] (TJ) ou [{ str }]
    const metrics = gs.font ? fontOf(gs.font) : null;
    let tx = 0;
    let known = Boolean(metrics) && Tm !== null;
    if (known) {
      for (const part of strings) {
        if (typeof part === 'number') {
          tx += (-part / 1000) * gs.size * gs.Th;
          continue;
        }
        if (!part || part.str === undefined) continue;
        const glyphs = metrics.glyphs(part.str);
        if (!glyphs) {
          known = false;
          break;
        }
        for (const g of glyphs) tx += ((g.w / 1000) * gs.size + gs.Tc + (g.space ? gs.Tw : 0)) * gs.Th;
      }
    }
    if (!known || Tm === null) {
      // Position perdue jusqu'au prochain changement de ligne ; si le texte commence dans une zone, il est gardé
      if (Tm !== null) {
        const z = inside(apply(mul(Tm, gs.ctm), 0, gs.rise));
        if (z >= 0) kept[z]++;
      }
      Tm = null;
      return;
    }
    const M = mul(Tm, gs.ctm);
    const p0 = apply(M, 0, gs.rise);
    const p1 = apply(M, tx, gs.rise);
    const a = inside(p0);
    const b = inside(p1);
    const hasText = strings.some((p) => p && p.str && p.str.length);
    if (hasText && a >= 0 && a === b && gs.size * gs.Th !== 0) {
      edits.push({ start: op.start, end: op.end, text: `${prefix}[${fmtNum((-tx * 1000) / (gs.size * gs.Th))}] TJ` });
      removed[a]++;
    } else if (hasText && (a >= 0 || b >= 0)) kept[a >= 0 ? a : b]++;
    Tm = mul([1, 0, 0, 1, tx, 0], Tm);
  };

  for (const op of ops) {
    const A = op.args;
    switch (op.op) {
      case 'q':
        stack.push({ ...gs, ctm: gs.ctm.slice() });
        break;
      case 'Q':
        if (stack.length) gs = stack.pop();
        break;
      case 'cm':
        if (A.length === 6 && A.every((v) => typeof v === 'number')) gs.ctm = mul(A, gs.ctm);
        break;
      case 'BT':
        Tm = ID.slice();
        Tlm = ID.slice();
        break;
      case 'Tc':
        gs.Tc = Number(A[0]) || 0;
        break;
      case 'Tw':
        gs.Tw = Number(A[0]) || 0;
        break;
      case 'Tz':
        gs.Th = (Number(A[0]) || 0) / 100;
        break;
      case 'TL':
        gs.TL = Number(A[0]) || 0;
        break;
      case 'Ts':
        gs.rise = Number(A[0]) || 0;
        break;
      case 'Tf':
        gs.font = A[0] && A[0].name !== undefined ? A[0].name : null;
        gs.size = Number(A[1]) || 0;
        break;
      case 'Td':
        nextLine(Number(A[0]) || 0, Number(A[1]) || 0);
        break;
      case 'TD':
        gs.TL = -(Number(A[1]) || 0);
        nextLine(Number(A[0]) || 0, Number(A[1]) || 0);
        break;
      case 'Tm':
        if (A.length === 6 && A.every((v) => typeof v === 'number')) {
          Tlm = A.slice();
          Tm = A.slice();
        }
        break;
      case 'T*':
        nextLine(0, -gs.TL);
        break;
      case 'Tj':
        show(op, [A[0]], '');
        break;
      case 'TJ':
        show(op, Array.isArray(A[0]) ? A[0] : [], '');
        break;
      case "'":
        nextLine(0, -gs.TL);
        show(op, [A[0]], 'T* ');
        break;
      case '"':
        gs.Tw = Number(A[0]) || 0;
        gs.Tc = Number(A[1]) || 0;
        nextLine(0, -gs.TL);
        show(op, [A[2]], `${fmtNum(gs.Tw)} Tw ${fmtNum(gs.Tc)} Tc T* `);
        break;
      default:
        break;
    }
  }
  if (!edits.length) return { content: null, removed, kept };
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += contentStr.slice(last, e.start) + e.text;
    last = e.end;
  }
  out += contentStr.slice(last);
  return { content: out, removed, kept };
}

// ---------------------------------------------------------------------------
// Sur une page pdf-lib
// ---------------------------------------------------------------------------

/** Contenu décodé d'une page (flux mis bout à bout), ou null si un flux est illisible. */
function pageContent(page) {
  const contents = page.node.Contents();
  if (!contents) return null;
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r)) : [contents];
  const parts = [];
  for (const s of streams) {
    if (s instanceof PDFRawStream) {
      try {
        parts.push(Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'));
      } catch {
        return null; // filtre non pris en charge (images JBIG2…) : on ne touche à rien
      }
    } else if (s instanceof PDFStream && typeof s.getContentsString === 'function') {
      parts.push(s.getContentsString());
    } else return null;
  }
  return parts.join('\n');
}

/**
 * Retire du contenu de la page le texte qui tient dans les rectangles (repère du PDF).
 * → { removed: [par zone], kept: [par zone] } ; le contenu n'est réécrit que si du texte a été retiré.
 */
function removeTextFromPage(page, rects) {
  const none = { removed: rects.map(() => 0), kept: rects.map(() => 1) };
  if (!rects.length) return none;
  const content = pageContent(page);
  if (content === null) return none;
  const resources = page.node.Resources();
  const fonts = resources instanceof PDFDict ? resources.lookup(PDFName.of('Font')) : null;
  const cache = new Map();
  const fontOf = (name) => {
    if (!cache.has(name)) {
      let m = null;
      try {
        m = fonts instanceof PDFDict ? fontMetrics(fonts.lookup(PDFName.of(name))) : null;
      } catch {
        m = null;
      }
      cache.set(name, m);
    }
    return cache.get(name);
  };
  let res;
  try {
    res = removeTextInRects(content, rects, fontOf);
    if (res.content !== null) parseContent(res.content); // le contenu réécrit doit rester lisible
  } catch {
    return none;
  }
  if (res.content !== null) {
    const stream = page.doc.context.flateStream(Buffer.from(res.content, 'latin1'));
    page.node.set(PDFName.of('Contents'), page.doc.context.register(stream));
  }
  return { removed: res.removed, kept: res.kept };
}

module.exports = { parseContent, fontMetrics, removeTextInRects, removeTextFromPage, ParseError };
