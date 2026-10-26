/*
 * build.js — Modèle « Fiche d'intervention VersusLabz » (modeles/), écrit à partir de la fiche PDF de la société.
 *
 * Lancer : node scripts/versuslabz/build.js   (régénère le .docx livré avec FichInter)
 *
 * Le document suit les règles d'analyse de lib/template.js :
 *   - titres de section : style « Titre2 » (paragraphe, ou ligne de titres d'un tableau à deux colonnes) ;
 *   - titres de cadre (Technicien / Client) : style « Titre3 », repris devant les intitulés du cadre ;
 *   - « intitulé | case » : case à ligne pointillée (bordure basse du paragraphe) ou cases ☐ ;
 *   - cadres grisés « titre + paragraphe vide » : textes longs ;
 *   - tableau « en-têtes + lignes vides » : pièces remplacées ;
 *   - cellules étroites vides : espaces entre deux colonnes (ignorées).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'modeles', 'Fiche d\'intervention VersusLabz.docx');
const LOGO = path.join(__dirname, 'logo.png');

// Couleurs de la fiche PDF
const C = { navy: '1F3A5F', line: '2E6DA4', text: '1E2630', gray: '5B6878', fill: 'F2F6FA', border: 'C9D4E0', dot: '9AA9BA', white: 'FFFFFF' };
const FONT = 'Calibri';
const BOX = 'Segoe UI Symbol';
const tw = (pt) => Math.round(pt * 20);

// ---------------------------------------------------------------------------
// Briques XML
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rPr({ b, i, color, sz, font, shd } = {}) {
  const f = font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>` : '';
  const inner = `${f}${b ? '<w:b/><w:bCs/>' : ''}${i ? '<w:i/><w:iCs/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ''}${shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${shd}"/>` : ''}`;
  return inner ? `<w:rPr>${inner}</w:rPr>` : '';
}

const run = (text, props) => `<w:r>${rPr(props)}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const bdr = (side, { val = 'single', sz = 4, color = C.border, space = 0 } = {}) => `<w:${side} w:val="${val}" w:sz="${sz}" w:space="${space}" w:color="${color}"/>`;

/** Paragraphe : runs (texte XML) et propriétés. */
function p(runs = '', { style, align, before, after, line, exact, ind, keepNext, under, mark } = {}) {
  const attrs = [before !== undefined && ` w:before="${before}"`, after !== undefined && ` w:after="${after}"`, line !== undefined && ` w:line="${line}" w:lineRule="${exact ? 'exact' : 'auto'}"`].filter(Boolean).join('');
  const spacing = attrs ? `<w:spacing${attrs}/>` : '';
  const pPr = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${keepNext ? '<w:keepNext/>' : ''}${under ? `<w:pBdr>${bdr('bottom', under)}</w:pBdr>` : ''}${spacing}${ind ? `<w:ind w:left="${ind}"/>` : ''}${align ? `<w:jc w:val="${align}"/>` : ''}${mark ? rPr(mark) : ''}`;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

/** Cellule : contenu (paragraphes), largeur (twips), fusions, fond, bordures, marges. */
function tc(content, { w, span, vMerge, shd, borders, mar, vAlign = 'top' } = {}) {
  const b = borders ? `<w:tcBorders>${['top', 'left', 'bottom', 'right'].filter((s) => borders[s]).map((s) => bdr(s, borders[s] === true ? {} : borders[s])).join('')}</w:tcBorders>` : '';
  const m = mar ? `<w:tcMar>${['top', 'left', 'bottom', 'right'].filter((s) => mar[s] !== undefined).map((s) => `<w:${s} w:w="${mar[s]}" w:type="dxa"/>`).join('')}</w:tcMar>` : '';
  const pr = `<w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : vMerge ? '<w:vMerge/>' : ''}${b}${shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${shd}"/>` : ''}${m}<w:vAlign w:val="${vAlign}"/>`;
  return `<w:tc><w:tcPr>${pr}</w:tcPr>${content || p()}</w:tc>`;
}

const tr = (cells, { h, exact } = {}) => `<w:tr><w:trPr><w:cantSplit/>${h ? `<w:trHeight w:val="${h}" w:hRule="${exact ? 'exact' : 'atLeast'}"/>` : ''}</w:trPr>${cells.join('')}</w:tr>`;

function tbl(grid, rows, { borders = {}, mar = {} } = {}) {
  const width = grid.reduce((a, b) => a + b, 0);
  const tb = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => (borders[s] ? bdr(s, borders[s]) : `<w:${s} w:val="nil"/>`)).join('')}</w:tblBorders>`;
  const m = { top: 0, left: 0, bottom: 0, right: 0, ...mar };
  const cm = `<w:tblCellMar>${['top', 'left', 'bottom', 'right'].map((s) => `<w:${s} w:w="${m[s]}" w:type="dxa"/>`).join('')}</w:tblCellMar>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/>${tb}<w:tblLayout w:type="fixed"/>${cm}<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid.map((g) => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

/** Espace vertical entre deux blocs (paragraphe vide de hauteur fixe). */
const gap = (pt) => p('', { before: 0, after: 0, line: tw(pt), exact: true, mark: { sz: 2 } });

// ---------------------------------------------------------------------------
// Contenu
// ---------------------------------------------------------------------------

const width = (grid, from, n = 1) => grid.slice(from, from + n).reduce((a, b) => a + b, 0);

/** Intitulé (gras). ind : retrait du texte dans sa cellule (pt). */
const label = (text, ind = 0) => p(run(text, { b: true }), { style: 'Intitule', ind: ind ? tw(ind) : undefined });
/** Case à remplir : ligne pointillée (bordure basse du paragraphe, lue par l'analyse : plusieurs traits = plusieurs lignes). */
const blank = () => p('', { style: 'Saisie', under: { val: 'dotted', sz: 4, color: C.dot } });
/** Cases à cocher : [['Faible', ' (gêne légère)'], 'Moyen'…] ; une option = texte, ou [texte, précision en italique]. */
function boxes(options, { sep = '      ' } = {}) {
  return p(
    options
      .map((o, i) => {
        const [text, sub] = Array.isArray(o) ? o : [o, ''];
        const last = i === options.length - 1;
        return (
          run('☐', { font: BOX, color: C.navy, sz: 17 }) +
          run(` ${text}${sub || last ? '' : sep}`) +
          (sub ? run(`${sub}${last ? '' : sep}`, { i: true, color: C.gray, sz: 15 }) : '')
        );
      })
      .join(''),
    { style: 'Options' }
  );
}
const dots = (n) => run('…'.repeat(n), { color: C.dot });

/** Titre de section numéroté : pastille + titre (style Titre2, trait en dessous). */
const heading = (n, text) => p(run(` ${n} `, { b: true, color: C.white, shd: C.navy, sz: 19 }) + run(`  ${text}`), { style: 'Titre2' });

/** Cadre grisé : titre + case de saisie (texte long). */
const frame = (title, w, extra = {}) => tc(label(title) + p('', { style: 'Cadre' }), { w, shd: C.fill, borders: { top: true, left: true, bottom: true, right: true }, mar: { left: tw(6), right: tw(6), top: tw(2) }, vAlign: 'top', ...extra });

const sp = (w, extra = {}) => tc(p(), { w, ...extra }); // espace entre deux colonnes

// En-tête : logo, titre, société -----------------------------------------------------------------
function header() {
  const grid = [tw(48), tw(260), tw(227.3)];
  const line = { sz: 13, color: C.navy };
  const logo =
    '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="508000" cy="381000"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="1" name="Logo VersusLabz"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr><pic:cNvPr id="1" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="508000" cy="381000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  const company =
    p(run('S.A.R.L. VERSUSLABZ', { b: true, color: C.navy, sz: 20 }), { align: 'right', after: 20 }) +
    p(run('36 rue du Peuple – 66000 Perpignan', { color: C.gray, sz: 17 }), { align: 'right', after: 10 }) +
    p(run('Tél. : 06 39 21 44 65', { color: C.gray, sz: 17 }), { align: 'right' });
  return tbl(grid, [
    tr(
      [
        tc(p(logo), { w: grid[0], vAlign: 'center', borders: { bottom: line } }),
        tc(p(run('FICHE D\'INTERVENTION', { b: true, color: C.navy, sz: 42 })), { w: grid[1], vAlign: 'center', borders: { bottom: line } }),
        tc(company, { w: grid[2], vAlign: 'center', borders: { bottom: line } }),
      ],
      { h: tw(40) }
    ),
  ], { mar: { bottom: tw(6) } });
}

// N° de fiche, réf. dossier, date ----------------------------------------------------------------
function refs() {
  const grid = [tw(50), tw(120.4), tw(64.8), tw(117.7), tw(91.7), tw(90.7)];
  const box = { shd: C.fill, vAlign: 'center' };
  return tbl(grid, [
    tr(
      [
        tc(label('N° de fiche'), { w: grid[0], ...box, mar: { left: tw(8) } }),
        tc(blank(), { w: grid[1], ...box }),
        tc(label('Réf. dossier'), { w: grid[2], ...box, mar: { left: tw(19.6) } }),
        tc(blank(), { w: grid[3], ...box }),
        tc(label('Date d\'intervention'), { w: grid[4], ...box, mar: { left: tw(20.1) } }),
        tc(blank(), { w: grid[5], ...box, mar: { right: tw(6) } }),
      ],
      { h: tw(22) }
    ),
  ], { borders: { top: { sz: 5 }, left: { sz: 5 }, bottom: { sz: 5 }, right: { sz: 5 } } });
}

// 1 Client | 2 Intervention ----------------------------------------------------------------------
function clientIntervention() {
  const g = [2080, 920, 548, 1684, 240, 1560, 1678, 620, 1376];
  const L = (i, n = 1) => width(g, i, n);
  const R = 16;
  return tbl(g, [
    tr([tc(heading(1, 'CLIENT'), { w: L(0, 4), span: 4 }), sp(L(4)), tc(heading(2, 'INTERVENTION'), { w: L(5, 4), span: 4 })]),
    tr([tc(label('Nom (M. / Mme)'), { w: L(0) }), tc(blank(), { w: L(1, 3), span: 3 }), sp(L(4)), tc(label('Technicien'), { w: L(5) }), tc(blank(), { w: L(6, 3), span: 3 })], { h: tw(R) }),
    tr([tc(label('Société / Raison sociale'), { w: L(0) }), tc(blank(), { w: L(1, 3), span: 3 }), sp(L(4)), tc(label('Lieu'), { w: L(5) }), tc(boxes(['Sur site', 'En atelier', 'À distance'], { sep: '     ' }), { w: L(6, 3), span: 3 })], { h: tw(R) }),
    tr([tc(label('N° client'), { w: L(0) }), tc(blank(), { w: L(1) }), tc(label('Tél.', 10), { w: L(2) }), tc(blank(), { w: L(3) }), sp(L(4)), tc(label('Heure d\'arrivée'), { w: L(5) }), tc(blank(), { w: L(6) }), tc(label('Fin', 7.5), { w: L(7) }), tc(blank(), { w: L(8) })], { h: tw(R) }),
    tr([tc(label('Adresse'), { w: L(0), vMerge: 'restart', vAlign: 'top' }), tc(blank() + blank(), { w: L(1, 3), span: 3, vMerge: 'restart' }), sp(L(4)), tc(label('Temps passé'), { w: L(5) }), tc(blank(), { w: L(6) }), tc(label('Tarif', 7.5), { w: L(7) }), tc(blank(), { w: L(8) })], { h: tw(R) }),
    tr([tc(p(), { w: L(0), vMerge: true }), tc(p(), { w: L(1, 3), span: 3, vMerge: true }), sp(L(4)), tc(label('Contrat de maint.'), { w: L(5) }), tc(boxes(['Non', 'Oui – N° ']).replace('</w:p>', `${dots(13)}</w:p>`), { w: L(6, 3), span: 3 })], { h: tw(R) }),
    tr([tc(label('E-mail'), { w: L(0) }), tc(blank(), { w: L(1, 3), span: 3 }), sp(L(4)), tc(label('Accès session fourni'), { w: L(5) }), tc(boxes(['Oui', 'Non']), { w: L(6) }), tc(p(run('(ne jamais noter le mot de passe)', { i: true, color: C.gray, sz: 14 }), { style: 'Options' }), { w: L(7, 2), span: 2 })], { h: tw(R) }),
  ]);
}

// 3 Matériel concerné ------------------------------------------------------------------------------
function materiel() {
  const g = [1560, 1848, 866, 174, 1080, 1530, 1078, 2570];
  const L = (i, n = 1) => width(g, i, n);
  return tbl(g, [
    tr([tc(label('Type d\'appareil'), { w: L(0) }), tc(boxes(['Ordinateur fixe', 'Ordinateur portable', 'Imprimante / Périphérique', 'Serveur / Réseau (box, switch…)', 'Autre : '], { sep: '   ' }).replace('</w:p>', `${dots(4)}</w:p>`), { w: L(1, 7), span: 7 })], { h: tw(17) }),
    tr([tc(label('Marque'), { w: L(0) }), tc(blank(), { w: L(1) }), tc(label('Modèle', 11.6), { w: L(2) }), tc(blank(), { w: L(3, 3), span: 3 }), tc(label('N° de série', 12), { w: L(6) }), tc(blank(), { w: L(7) })], { h: tw(16) }),
    tr([tc(label('Système / version'), { w: L(0) }), tc(blank(), { w: L(1, 3), span: 3 }), tc(label('Garantie', 11.6), { w: L(4) }), tc(p(run('☐', { font: BOX, color: C.navy, sz: 17 }) + run(' Hors garantie      ') + run('☐', { font: BOX, color: C.navy, sz: 17 }) + run(' Sous garantie jusqu\'au ') + run('___ / ___ / _____', { color: C.gray }), { style: 'Options' }), { w: L(5, 3), span: 3 })], { h: tw(16) }),
  ]);
}

// 4 Problème signalé -------------------------------------------------------------------------------
function probleme() {
  const g = [1560, 3672, 240, 5234];
  const L = (i, n = 1) => width(g, i, n);
  return tbl(g, [
    tr([tc(label('Niveau d\'urgence'), { w: L(0) }), tc(boxes([['Faible', ' (gêne légère)'], ['Moyen', ' (travail ralenti)'], ['Élevé', ' (poste ou activité bloqué)']], { sep: '          ' }), { w: L(1, 3), span: 3 })], { h: tw(17) }),
    tr([tc(p(), { w: L(0, 4), span: 4 })], { h: tw(5), exact: true }),
    tr([frame('Description de la panne', L(0, 4), { span: 4 })], { h: tw(38) }),
    tr([tc(p(), { w: L(0, 4), span: 4 })], { h: tw(6), exact: true }),
    tr([frame('Message d\'erreur affiché', L(0, 2), { span: 2 }), sp(L(2)), frame('Actions déjà tentées par le client', L(3))], { h: tw(30) }),
  ]);
}

// 5 Intervention réalisée --------------------------------------------------------------------------
function realisee() {
  const g = [1560, 3240, 432, 240, 416, 1352, 2180, 1286];
  const L = (i, n = 1) => width(g, i, n);
  const head = { shd: C.navy, vAlign: 'center', mar: { left: tw(6) }, borders: { top: { color: C.navy }, left: { color: C.navy }, right: { color: C.navy } } };
  const cellB = (shd, extra = {}) => ({ shd, vAlign: 'center', borders: { top: true, left: true, bottom: true, right: true }, mar: { left: tw(6) }, ...extra });
  const partsRow = (shd) =>
    tr([tc(p(), { w: L(0, 5), span: 5, ...cellB(shd) }), tc(p(), { w: L(5, 2), span: 2, ...cellB(shd) }), tc(p(), { w: L(7), ...cellB(shd) })], { h: tw(14) });
  const th = (text) => p(run(text, { b: true, color: C.white, sz: 16 }));
  return tbl(g, [
    tr([tc(label('Type'), { w: L(0) }), tc(boxes(['Matériel', 'Logiciel', 'Réseau / Internet', 'Virus / Sécurité', 'Données / Sauvegarde', 'Installation / Config.'], { sep: '     ' }), { w: L(1, 7), span: 7 })], { h: tw(15) }),
    tr([tc(p(), { w: L(0) }), tc(boxes(['Autre : ']).replace('</w:p>', `${dots(15)}</w:p>`), { w: L(1) }), tc(label('Sauvegarde avant intervention', 10), { w: L(2, 4), span: 4 }), tc(boxes(['Oui', 'Non', 'Sans objet'], { sep: '     ' }), { w: L(6, 2), span: 2 })], { h: tw(15) }),
    tr([tc(p(), { w: L(0, 8), span: 8 })], { h: tw(6), exact: true }),
    tr([frame('Diagnostic établi', L(0, 3), { span: 3 }), sp(L(3)), frame('Actions réalisées', L(4, 4), { span: 4 })], { h: tw(44) }),
    tr([tc(p(), { w: L(0, 8), span: 8 })], { h: tw(6), exact: true }),
    tr([tc(label('Pièces remplacées / fournies'), { w: L(0, 8), span: 8 })], { h: tw(16) }),
    tr([tc(th('Désignation'), { w: L(0, 5), span: 5, ...head }), tc(th('Référence'), { w: L(5, 2), span: 2, ...head }), tc(th('Qté'), { w: L(7), ...head })], { h: tw(13) }),
    partsRow(C.fill),
    partsRow(C.white),
    partsRow(C.fill),
    tr([tc(label('Résultat'), { w: L(0) }), tc(boxes(['Problème résolu', 'Partiellement résolu', 'Non résolu – préciser : '], { sep: '     ' }).replace('</w:p>', `${dots(24)}</w:p>`), { w: L(1, 7), span: 7 })], { h: tw(20) }),
  ]);
}

// 6 Observations et suivi --------------------------------------------------------------------------
function observations() {
  const g = [5232, 240, 1680, 3554];
  const box = { shd: C.fill, borders: { top: true, left: true, bottom: true, right: true } };
  return tbl(g, [
    tr([frame('Remarques', g[0], { vMerge: 'restart' }), sp(g[1], { vMerge: 'restart' }), tc(label('Suivi nécessaire ?'), { w: g[2] }), tc(boxes(['Non', 'Oui : ']).replace('</w:p>', `${dots(17)}</w:p>`), { w: g[3] })], { h: tw(15) }),
    tr([tc(p(), { w: g[0], vMerge: true, ...box }), sp(g[1], { vMerge: true }), tc(blank(), { w: g[2] + g[3], span: 2 })], { h: tw(14) }),
    tr([tc(p(), { w: g[0], vMerge: true, ...box }), sp(g[1], { vMerge: true }), tc(label('Prochain rendez-vous'), { w: g[2] }), tc(p(run('___ / ___ / _____   à   ___ h ___', { color: C.gray }), { style: 'Options' }), { w: g[3] })], { h: tw(15) }),
  ]);
}

// 7 Validation -------------------------------------------------------------------------------------
function validation() {
  const g = [660, 2620, 700, 1252, 240, 660, 2620, 700, 1254];
  const L = (i, n = 1) => width(g, i, n);
  // Cadre : bordure extérieure seulement (haut sur la 1re ligne, bas sur la dernière, côtés)
  const edge = (row, side) => ({ top: row === 0, bottom: row === 2, left: side === 'L' || side === 'LR', right: side === 'R' || side === 'LR' });
  const cell = (content, w, row, side, extra = {}) => tc(content, { w, borders: edge(row, side), ...extra });
  const title = (t) => p(run(t, { b: true, color: C.navy, sz: 17 }), { style: 'Titre3' });
  const mention = p(run('Mention « Bon pour accord »', { i: true, color: C.gray, sz: 15 }), { align: 'right' });
  const pad = { mar: { left: tw(7) } };
  return tbl(g, [
    tr([cell(title('Technicien'), L(0, 4), 0, 'LR', { span: 4, shd: C.fill, vAlign: 'center', ...pad }), sp(L(4)), cell(title('Client'), L(5, 2), 0, 'L', { span: 2, shd: C.fill, vAlign: 'center', ...pad }), cell(mention, L(7, 2), 0, 'R', { span: 2, shd: C.fill, vAlign: 'center', mar: { right: tw(6) } })], { h: tw(16) }),
    tr([cell(label('Nom'), L(0), 1, 'L', pad), cell(blank(), L(1), 1, ''), cell(label('Date', 9), L(2), 1, ''), cell(blank(), L(3), 1, 'R', { mar: { right: tw(7) } }), sp(L(4)), cell(label('Nom'), L(5), 1, 'L', pad), cell(blank(), L(6), 1, ''), cell(label('Date', 9), L(7), 1, ''), cell(blank(), L(8), 1, 'R', { mar: { right: tw(7) } })], { h: tw(19) }),
    tr([cell(label('Signature'), L(0, 2), 2, 'L', { span: 2, vAlign: 'top', ...pad }), cell(p(), L(2, 2), 2, 'R', { span: 2, vAlign: 'top' }), sp(L(4)), cell(label('Signature'), L(5, 2), 2, 'L', { span: 2, vAlign: 'top', ...pad }), cell(p(), L(7, 2), 2, 'R', { span: 2, vAlign: 'top' })], { h: tw(42) }),
  ]);
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function documentXml() {
  const body = [
    header(),
    gap(6),
    refs(),
    gap(8),
    clientIntervention(),
    gap(6),
    heading(3, 'MATÉRIEL CONCERNÉ'),
    materiel(),
    gap(6),
    heading(4, 'PROBLÈME SIGNALÉ'),
    probleme(),
    gap(6),
    heading(5, 'INTERVENTION RÉALISÉE'),
    realisee(),
    gap(6),
    heading(6, 'OBSERVATIONS ET SUIVI'),
    observations(),
    gap(6),
    heading(7, 'VALIDATION'),
    validation(),
    p('', { before: 0, after: 0, line: 20, exact: true, mark: { sz: 2 } }),
  ].join('');
  const sect = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${tw(22)}" w:right="${tw(30)}" w:bottom="${tw(16)}" w:left="${tw(30)}" w:header="284" w:footer="284" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`;
}

function stylesXml() {
  const rp = (o) => rPr(o);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault>${rp({ font: FONT, color: C.text, sz: 17 })}</w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:pBdr>${bdr('bottom', { sz: 6, color: C.line, space: 1 })}</w:pBdr><w:spacing w:before="0" w:after="${tw(2)}"/><w:outlineLvl w:val="1"/></w:pPr>${rp({ b: true, color: C.navy, sz: 21 })}</w:style>
<w:style w:type="paragraph" w:styleId="Titre3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr>${rp({ b: true, color: C.navy, sz: 17 })}</w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Intitule"><w:name w:val="Intitulé"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="${tw(3)}" w:after="${tw(1)}"/></w:pPr>${rp({ b: true, sz: 17 })}</w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Saisie"><w:name w:val="Saisie"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr>${bdr('bottom', { val: 'dotted', sz: 4, color: C.dot, space: 0 })}</w:pBdr><w:spacing w:before="${tw(3)}" w:after="${tw(1)}"/></w:pPr>${rp({ color: C.navy, sz: 17 })}</w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Options"><w:name w:val="Options"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="${tw(3)}" w:after="${tw(1)}"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Cadre"><w:name w:val="Cadre"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="${tw(2)}"/></w:pPr>${rp({ color: C.navy, sz: 17 })}</w:style>
<w:style w:type="table" w:default="1" w:styleId="TableauNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
}

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

async function main() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo-versuslabz.png"/></Relationships>`);
  zip.file('word/document.xml', documentXml());
  zip.file('word/styles.xml', stylesXml());
  zip.file('word/settings.xml', SETTINGS);
  zip.file('word/media/logo-versuslabz.png', fs.readFileSync(LOGO));
  const now = '2026-10-22T08:00:00Z';
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Fiche d'intervention – SARL VersusLabz</dc:title><dc:creator>SARL VersusLabz</dc:creator><cp:lastModifiedBy>FichInter</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FichInter</Application></Properties>`);
  // Date fixe : le fichier ne change que si son contenu change (empreinte du modèle, brouillons)
  const date = new Date('2026-10-22T08:00:00Z');
  for (const f of Object.values(zip.files)) f.date = date;
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(OUT, buf);
  console.log(`${path.relative(ROOT, OUT)} (${Math.round(buf.length / 1024)} Ko)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
