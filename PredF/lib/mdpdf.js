/*
 * mdpdf.js — Met en page un document Markdown (réponse de l'Assistant IA) dans un PDF A4 propre :
 * titres, paragraphes justifiés à gauche, listes, citations, tableaux, code, numéros de page.
 *
 * Police : celle du système (Segoe UI / Consolas sous Windows, DejaVu sous Linux), embarquée en
 * sous-ensemble pour écrire tous les caractères (accents, guillemets, symboles). Sans police système,
 * repli sur Helvetica (les caractères non pris en charge sont remplacés).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const Markdown = require('./markdown.js');

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 64, bottom: 64, left: 62, right: 62 };
const BODY = 10.5;
const LEADING = 1.5;
const COLORS = {
  text: rgb(0.13, 0.11, 0.15),
  muted: rgb(0.42, 0.38, 0.45),
  accent: rgb(0.86, 0.22, 0.34),
  rule: rgb(0.86, 0.83, 0.86),
  head: rgb(0.97, 0.94, 0.96),
  code: rgb(0.96, 0.95, 0.97),
};

/** Polices du système : { regular, bold, italic, mono } (chemins), ou null. */
function systemFonts() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const sets = [
    [path.join(win, 'Fonts'), ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'consola.ttf']],
    [path.join(win, 'Fonts'), ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'cour.ttf']],
    ['/usr/share/fonts/truetype/dejavu', ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans-Oblique.ttf', 'DejaVuSansMono.ttf']],
    ['/usr/share/fonts/TTF', ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans-Oblique.ttf', 'DejaVuSansMono.ttf']],
    ['/System/Library/Fonts/Supplemental', ['Arial.ttf', 'Arial Bold.ttf', 'Arial Italic.ttf', 'Courier New.ttf']],
  ];
  for (const [dir, names] of sets) {
    const files = names.map((n) => path.join(dir, n));
    if (files.slice(0, 2).every((f) => fs.existsSync(f))) {
      return { regular: files[0], bold: files[1], italic: fs.existsSync(files[2]) ? files[2] : files[0], mono: fs.existsSync(files[3]) ? files[3] : files[0] };
    }
  }
  return null;
}

async function loadFonts(doc, fontFiles = systemFonts()) {
  if (fontFiles) {
    try {
      doc.registerFontkit(fontkit);
      const embed = (file) => doc.embedFont(fs.readFileSync(file), { subset: true });
      return { regular: await embed(fontFiles.regular), bold: await embed(fontFiles.bold), italic: await embed(fontFiles.italic), mono: await embed(fontFiles.mono), unicode: true };
    } catch {
      // police illisible : polices standard
    }
  }
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
    unicode: false,
  };
}

/** Remplace les caractères qu'une police standard (WinAnsi) ne sait pas écrire. */
function safeText(font, text, unicode) {
  if (unicode) {
    // Les sous-ensembles fontkit ignorent les glyphes absents ; on retire seulement les caractères de contrôle
    return text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
  }
  return [...text]
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return { '≥': '>=', '≤': '<=', '→': '->', '←': '<-', '✓': 'v', '✗': 'x', '≈': '~' }[ch] || '?';
      }
    })
    .join('');
}

async function markdownToPdf(markdown, { title, author, fontFiles } = {}) {
  const doc = await PDFDocument.create();
  const F = await loadFonts(doc, fontFiles);
  const width = PAGE.width - MARGIN.left - MARGIN.right;
  let page = null;
  let y = 0;

  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN.top;
  };
  const ensure = (h) => {
    if (!page || y - h < MARGIN.bottom) newPage();
  };

  const fontOf = (run, base) => (run.code ? F.mono : run.bold || base === 'bold' ? F.bold : run.italic ? F.italic : base === 'italic' ? F.italic : F.regular);

  /** Découpe des morceaux de texte enrichi en lignes de largeur maxi. */
  function layout(inlines, size, maxWidth, base) {
    const words = [];
    for (const run of inlines) {
      const font = fontOf(run, base);
      const text = safeText(font, run.text, F.unicode);
      for (const part of text.split(/(\s+)/)) {
        if (!part) continue;
        words.push({ text: part, font, space: /^\s+$/.test(part), code: run.code });
      }
    }
    const lines = [];
    let line = [];
    let w = 0;
    const measure = (wd) => wd.font.widthOfTextAtSize(wd.space ? ' ' : wd.text, size);
    for (const wd of words) {
      if (wd.space) {
        if (line.length) {
          line.push({ ...wd, text: ' ' });
          w += measure(wd);
        }
        continue;
      }
      let ww = measure(wd);
      if (w + ww > maxWidth && line.length) {
        while (line.length && line[line.length - 1].space) line.pop();
        lines.push(line);
        line = [];
        w = 0;
      }
      // Mot plus long que la ligne : coupé en morceaux
      if (ww > maxWidth) {
        let chunk = '';
        for (const ch of wd.text) {
          if (wd.font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
            lines.push([{ ...wd, text: chunk }]);
            chunk = '';
          }
          chunk += ch;
        }
        wd.text = chunk;
        ww = measure(wd);
      }
      line.push(wd);
      w += ww;
    }
    while (line.length && line[line.length - 1].space) line.pop();
    if (line.length) lines.push(line);
    return lines.length ? lines : [[]];
  }

  function drawLine(line, x, size, color) {
    let cx = x;
    for (const wd of line) {
      if (wd.code) {
        const tw = wd.font.widthOfTextAtSize(wd.text, size);
        page.drawRectangle({ x: cx - 1, y: y - 2.5, width: tw + 2, height: size + 3, color: COLORS.code });
      }
      page.drawText(wd.text, { x: cx, y, size, font: wd.font, color });
      cx += wd.font.widthOfTextAtSize(wd.text, size);
    }
  }

  /** Paragraphe (ou titre) : lignes posées les unes sous les autres, avec saut de page si besoin. */
  function paragraph(inlines, { size = BODY, x = MARGIN.left, maxWidth = width, color = COLORS.text, base, before = 0, after = size * 0.7, leading = LEADING, keepWithNext = 0 }) {
    const lines = layout(inlines, size, maxWidth, base);
    const lh = size * leading;
    ensure(before + lh * Math.min(lines.length, 2) + keepWithNext);
    y -= before;
    lines.forEach((line) => {
      ensure(lh);
      y -= size;
      drawLine(line, x, size, color);
      y -= lh - size;
    });
    y -= after;
  }

  function table(block) {
    const cols = block.head.length;
    const size = 9.5;
    const pad = 5;
    const plainLen = (cell) => cell.map((r) => r.text).join('').length;
    // Largeurs : proportionnelles au contenu, avec un minimum
    const weights = Array.from({ length: cols }, (_, c) => Math.max(4, Math.min(40, Math.max(plainLen(block.head[c]), ...block.rows.map((r) => plainLen(r[c]))))));
    const total = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / total) * width);
    const drawRow = (cells, header) => {
      const laid = cells.map((cell, c) => layout(cell, size, colW[c] - 2 * pad, header ? 'bold' : undefined));
      const lh = size * 1.35;
      const h = Math.max(...laid.map((l) => l.length)) * lh + 2 * pad;
      ensure(h);
      const top = y;
      if (header) page.drawRectangle({ x: MARGIN.left, y: top - h, width, height: h, color: COLORS.head });
      let x = MARGIN.left;
      laid.forEach((lines, c) => {
        let ly = top - pad - size;
        for (const line of lines) {
          const save = y;
          y = ly;
          drawLine(line, x + pad, size, COLORS.text);
          y = save;
          ly -= lh;
        }
        x += colW[c];
      });
      page.drawLine({ start: { x: MARGIN.left, y: top - h }, end: { x: MARGIN.left + width, y: top - h }, thickness: header ? 1 : 0.5, color: COLORS.rule });
      y = top - h;
    };
    ensure(40);
    y -= 4;
    page.drawLine({ start: { x: MARGIN.left, y }, end: { x: MARGIN.left + width, y }, thickness: 1, color: COLORS.rule });
    drawRow(block.head, true);
    for (const row of block.rows) drawRow(row, false);
    y -= BODY;
  }

  newPage();
  const blocks = Markdown.parse(markdown);
  blocks.forEach((b, i) => {
    const next = blocks[i + 1];
    if (b.type === 'h') {
      const sizes = { 1: 21, 2: 15.5, 3: 12.5, 4: 11 };
      const size = sizes[b.level];
      const first = y >= PAGE.height - MARGIN.top - 1;
      paragraph(b.inlines, { size, base: 'bold', color: b.level === 1 ? COLORS.text : b.level === 2 ? COLORS.accent : COLORS.text, before: first ? 0 : size * 0.9, after: size * 0.45, leading: 1.25, keepWithNext: next ? BODY * 3 : 0 });
      if (b.level === 1) {
        page.drawRectangle({ x: MARGIN.left, y: y + 2, width: 46, height: 3, color: COLORS.accent });
        y -= 10;
      }
    } else if (b.type === 'p') {
      paragraph(b.inlines, {});
    } else if (b.type === 'quote') {
      const startPage = page;
      const top = y;
      paragraph(b.inlines, { x: MARGIN.left + 14, maxWidth: width - 14, color: COLORS.muted, base: 'italic' });
      if (page === startPage) page.drawRectangle({ x: MARGIN.left, y: y + BODY * 0.7, width: 3, height: top - y - BODY * 0.7, color: COLORS.rule });
    } else if (b.type === 'ul' || b.type === 'ol') {
      let counter = 0;
      b.items.forEach((it, k) => {
        counter = it.level === 0 ? (it.number || counter + 1) : counter;
        const indent = 16 + it.level * 16;
        const marker = b.type === 'ol' && it.level === 0 ? `${counter}.` : it.level ? '–' : '•';
        const lines = layout(it.inlines, BODY, width - indent, undefined);
        const lh = BODY * LEADING;
        ensure(lh);
        page.drawText(safeText(F.regular, marker, F.unicode), { x: MARGIN.left + indent - 13, y: y - BODY, size: BODY, font: b.type === 'ol' ? F.bold : F.regular, color: COLORS.accent });
        lines.forEach((line) => {
          ensure(lh);
          y -= BODY;
          drawLine(line, MARGIN.left + indent, BODY, COLORS.text);
          y -= lh - BODY;
        });
        y -= k === b.items.length - 1 ? BODY * 0.7 : 2;
      });
    } else if (b.type === 'table') {
      table(b);
    } else if (b.type === 'hr') {
      ensure(20);
      y -= 8;
      page.drawLine({ start: { x: MARGIN.left, y }, end: { x: MARGIN.left + width, y }, thickness: 0.8, color: COLORS.rule });
      y -= 12;
    } else if (b.type === 'code') {
      const size = 9;
      const lh = size * 1.4;
      for (const raw of b.text.split('\n')) {
        const lines = layout([{ text: raw || ' ', code: false }], size, width - 16, undefined).map((l) => l.map((w) => ({ ...w, font: F.mono })));
        for (const line of lines) {
          ensure(lh);
          page.drawRectangle({ x: MARGIN.left, y: y - lh, width, height: lh, color: COLORS.code });
          y -= size + 2;
          drawLine(line, MARGIN.left + 8, size, COLORS.text);
          y -= lh - size - 2;
        }
      }
      y -= BODY * 0.8;
    }
  });

  // Pied de page : numéros
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const w = F.regular.widthOfTextAtSize(label, 8.5);
    p.drawText(label, { x: (PAGE.width - w) / 2, y: 32, size: 8.5, font: F.regular, color: COLORS.muted });
  });

  doc.setTitle(title || Markdown.title(markdown) || 'Document');
  if (author) doc.setAuthor(author);
  doc.setCreator('PredF — Assistant IA');
  doc.setProducer('PredF (pdf-lib)');
  return doc.save({ useObjectStreams: true });
}

module.exports = { markdownToPdf, systemFonts };
