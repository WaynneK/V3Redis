'use strict';
/*
 * Tests du moteur PDF (lib/engine.js) et de la saisie des pages (lib/ranges.js).
 * Les PDF et images de test sont fabriqués ici (aucun fichier externe).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const E = require('../lib/engine.js');
const R = require('../lib/ranges.js');

const { describe, it } = test;

// ---------------------------------------------------------------------------
// Fabriques
// ---------------------------------------------------------------------------

/** PDF de n pages ; chaque page porte son numéro dans son texte (« P1 », « P2 »…) et a une largeur distincte. */
async function makePdf(n, { title, rotate } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([400 + i, 600]);
    page.drawText(`P${i + 1}`, { x: 50, y: 500, size: 30, font });
    if (rotate) page.setRotation(degrees(rotate));
  }
  if (title) doc.setTitle(title);
  return doc.save();
}

/** Largeurs des pages : chaque page de test a une largeur unique (400 + numéro - 1). */
async function widths(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** PNG RVB uni de w × h pixels. */
function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 200;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** En-têtes JPEG (APP1 EXIF avec orientation, SOF0) : suffisant pour les lecteurs d'en-têtes et pdf-lib. */
function makeJpegHeader(w, h, orientation, little = true) {
  const u16 = (v) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (little ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const app1Body = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
  const app1 = [0xff, 0xe1, (app1Body.length + 2) >> 8, (app1Body.length + 2) & 255, ...app1Body];
  const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

const sourcesOf = (map) => (src) => map[src];

// ---------------------------------------------------------------------------
// ranges.js
// ---------------------------------------------------------------------------

describe('saisie des pages', () => {
  it('lit listes, plages ouvertes, ordre inverse et mots-clés', () => {
    assert.deepEqual(R.parsePageList('1-3, 5', 10), [0, 1, 2, 4]);
    assert.deepEqual(R.parsePageList('8-', 10), [7, 8, 9]);
    assert.deepEqual(R.parsePageList('-3', 10), [0, 1, 2]);
    assert.deepEqual(R.parsePageList('4-2', 10), [3, 2, 1]);
    assert.deepEqual(R.parsePageList('9-fin', 10), [8, 9]);
    assert.deepEqual(R.parsePageList('paires', 5), [1, 3]);
    assert.deepEqual(R.parsePageList('impaires', 5), [0, 2, 4]);
    assert.deepEqual(R.parsePageList('', 3), [0, 1, 2]);
    assert.deepEqual(R.parsePageList('2, 2', 3), [1, 1]);
    assert.deepEqual(R.parsePageList('1 – 2', 3), [0, 1]);
  });

  it('refuse les pages hors du document', () => {
    for (const bad of ['0', '11', '3-12', 'abc', '1-2-3']) assert.throws(() => R.parsePageList(bad, 10), R.RangeError, bad);
  });

  it('groupes et découpe régulière', () => {
    assert.deepEqual(R.parseGroups('1-3, 4-5; 6', 6), [[0, 1, 2], [3, 4], [5]]);
    assert.throws(() => R.parseGroups('', 6), R.RangeError);
    assert.deepEqual(R.chunk(7, 3), [[0, 1, 2], [3, 4, 5], [6]]);
    assert.deepEqual(R.chunk(2, 5), [[0, 1]]);
    assert.throws(() => R.chunk(5, 0), R.RangeError);
  });

  it('résume une liste', () => {
    assert.equal(R.formatList([0, 1, 2, 4, 6, 7]), '1-3, 5, 7-8');
    assert.equal(R.formatList([3]), '4');
    assert.equal(R.formatList([]), '');
  });
});

// ---------------------------------------------------------------------------
// Types de fichiers et images
// ---------------------------------------------------------------------------

describe('fichiers et images', () => {
  it('reconnaît le type par le contenu', async () => {
    assert.equal(E.detectType(await makePdf(1)), 'pdf');
    assert.equal(E.detectType(makePng(2, 2)), 'png');
    assert.equal(E.detectType(makeJpegHeader(4, 3, 1)), 'jpg');
    assert.equal(E.detectType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'gif');
    assert.equal(E.detectType(new Uint8Array([1, 2, 3, 4, 5])), null);
  });

  it('dimensions et orientation EXIF', () => {
    assert.deepEqual(E.imageSize(makePng(30, 20), 'png'), { width: 30, height: 20 });
    for (const little of [true, false]) {
      assert.deepEqual(E.imageSize(makeJpegHeader(640, 480, 6, little), 'jpg'), { width: 640, height: 480 });
      assert.equal(E.jpegOrientation(makeJpegHeader(640, 480, 6, little)), 6);
      assert.equal(E.jpegOrientation(makeJpegHeader(640, 480, 3, little)), 3);
    }
    const info = E.inspectImage(makeJpegHeader(640, 480, 8));
    assert.equal(info.displayWidth, 480);
    assert.equal(info.displayHeight, 640);
  });
});

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

describe('inspect', () => {
  it('pages, rotation et propriétés', async () => {
    const res = await E.inspect(await makePdf(3, { title: 'Rapport', rotate: 90 }));
    assert.equal(res.pageCount, 3);
    assert.deepEqual(res.pages[0], { width: 600, height: 400, rotation: 90 });
    assert.equal(res.info.title, 'Rapport');
  });

  it('refuse un fichier endommagé', async () => {
    await assert.rejects(() => E.inspect(new Uint8Array(Buffer.from('%PDF-1.7 n\'importe quoi'))), E.PdfError);
  });

  it('nomme les formats courants', () => {
    assert.equal(E.describeSize(595.28, 841.89), 'A4 portrait');
    assert.equal(E.describeSize(841.89, 595.28), 'A4 paysage');
    assert.equal(E.describeSize(612, 792), 'Letter portrait');
    assert.equal(E.describeSize(283.46, 283.46), '100 × 100 mm');
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('buildPdf', () => {
  it('fusionne deux PDF dans l\'ordre demandé', async () => {
    const a = await makePdf(3);
    const b = await makePdf(2);
    const src = sourcesOf({ a: { kind: 'pdf', bytes: a }, b: { kind: 'pdf', bytes: b } });
    const out = await E.buildPdf(
      [
        { type: 'page', src: 'b', index: 1 },
        { type: 'page', src: 'a', index: 0 },
        { type: 'page', src: 'a', index: 2 },
        { type: 'page', src: 'b', index: 0 },
      ],
      src
    );
    assert.deepEqual(await widths(out), [401, 400, 402, 400]);
  });

  it('duplique une page utilisée deux fois (objets distincts)', async () => {
    const a = await makePdf(2);
    const out = await E.buildPdf(
      [
        { type: 'page', src: 'a', index: 1 },
        { type: 'page', src: 'a', index: 1, rotate: 90 },
        { type: 'page', src: 'a', index: 1 },
      ],
      sourcesOf({ a: { kind: 'pdf', bytes: a } })
    );
    const doc = await PDFDocument.load(out);
    const pages = doc.getPages();
    assert.equal(pages.length, 3);
    assert.notEqual(pages[0].ref.toString(), pages[1].ref.toString());
    assert.equal(pages[1].getRotation().angle, 90);
    assert.equal(pages[0].getRotation().angle, 0);
  });

  it('cumule les rotations et ajoute des pages blanches', async () => {
    const a = await makePdf(1, { rotate: 90 });
    const out = await E.buildPdf(
      [
        { type: 'page', src: 'a', index: 0, rotate: 270 },
        { type: 'blank' },
        { type: 'blank', width: 595.28, height: 841.89 },
      ],
      sourcesOf({ a: { kind: 'pdf', bytes: a } })
    );
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPage(0).getRotation().angle, 0);
    assert.equal(Math.round(doc.getPage(1).getWidth()), 400); // même taille que la page précédente
    assert.equal(Math.round(doc.getPage(2).getHeight()), 842);
  });

  it('refuse une page inexistante', async () => {
    const a = await makePdf(2);
    await assert.rejects(() => E.buildPdf([{ type: 'page', src: 'a', index: 5 }], sourcesOf({ a: { kind: 'pdf', bytes: a } })), E.PdfError);
    await assert.rejects(() => E.buildPdf([], () => null), E.PdfError);
  });

  it('place des images (format, orientation, marges, EXIF)', async () => {
    const png = makePng(300, 200); // paysage
    const jpg = makeJpegHeader(400, 300, 6); // stocké paysage, affiché portrait
    const src = sourcesOf({ p: { kind: 'image', bytes: png }, j: { kind: 'image', bytes: jpg } });
    const out = await E.buildPdf(
      [
        { type: 'image', src: 'p', layout: { size: 'A4', orientation: 'auto', margin: 10 } },
        { type: 'image', src: 'p', layout: { size: 'A4', orientation: 'portrait', margin: 0 } },
        { type: 'image', src: 'j', layout: { size: 'fit', margin: 0 } },
        { type: 'image', src: 'j', layout: { size: 'A4', orientation: 'auto' } },
      ],
      src
    );
    const doc = await PDFDocument.load(out);
    const size = (i) => doc.getPage(i).getSize();
    assert.ok(size(0).width > size(0).height, 'auto : paysage pour une image paysage');
    assert.ok(size(1).width < size(1).height, 'portrait imposé');
    assert.ok(size(2).width < size(2).height, 'adapté : proportions de l\'image affichée (portrait)');
    assert.equal(Math.round(size(2).height), 842);
    assert.equal(Math.round(size(2).width), Math.round((841.89 * 300) / 400));
    assert.ok(size(3).width < size(3).height, 'auto : portrait pour une photo tournée');
  });

  it('signale la progression', async () => {
    const a = await makePdf(45);
    const calls = [];
    await E.buildPdf(
      Array.from({ length: 45 }, (_, i) => ({ type: 'page', src: 'a', index: i })),
      sourcesOf({ a: { kind: 'pdf', bytes: a } }),
      { onProgress: (d, t) => calls.push([d, t]) }
    );
    assert.deepEqual(calls.at(-1), [45, 45]);
  });
});

// ---------------------------------------------------------------------------
// Compression, optimisation, finitions
// ---------------------------------------------------------------------------

describe('pages en images et optimisation', () => {
  it('construit un PDF à partir de JPEG', async () => {
    const job = await E.createRasterJob();
    await job.addPage(makeJpegHeader(100, 140, 1), 595.28, 841.89);
    await job.addPage(makeJpegHeader(140, 100, 1), 841.89, 595.28);
    await assert.rejects(() => job.addPage(makePng(2, 2), 100, 100), E.PdfError);
    const out = await job.finish({ title: 'Compressé' });
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPageCount(), 2);
    assert.equal(Math.round(doc.getPage(1).getWidth()), 842);
    assert.equal(doc.getTitle(), 'Compressé');
  });

  it('réécrit sans perte', async () => {
    const a = await makePdf(4, { title: 'Doc' });
    const out = await E.optimizePdf(a);
    assert.deepEqual(await widths(out), [400, 401, 402, 403]);
    assert.equal((await PDFDocument.load(out)).getTitle(), 'Doc');
  });
});

describe('stampPdf', () => {
  it('numérote, ajoute un filigrane et change les propriétés', async () => {
    const a = await makePdf(3, { rotate: 90 });
    const out = await E.stampPdf(a, {
      numbers: { position: 'bottom-right', format: 'sur', start: 1, size: 11 },
      watermark: { text: 'CONFIDENTIEL – brouillon été', size: 'medium', opacity: 0.2, color: 'rouge' },
      props: { title: 'Titre', author: 'Moi', keywords: 'a, b ; c' },
    });
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPageCount(), 3);
    assert.equal(doc.getTitle(), 'Titre');
    assert.equal(doc.getAuthor(), 'Moi');
    assert.equal(doc.getKeywords(), 'a b c');
    // Le texte ajouté est dans le flux de contenu de chaque page
    assert.ok(out.length > a.length);
  });

  it('aperçu : une seule page', async () => {
    const a = await makePdf(5);
    const out = await E.stampPdf(a, { numbers: { format: 'n' }, onlyPage: 2 });
    assert.deepEqual(await widths(out), [402]);
  });

  it('refuse un caractère impossible à écrire', async () => {
    const a = await makePdf(1);
    await assert.rejects(() => E.stampPdf(a, { watermark: { text: 'Secret 🔒' } }), /🔒/);
  });

  it('efface les propriétés', async () => {
    const a = await makePdf(1, { title: 'À effacer' });
    const doc = await PDFDocument.load(await E.stampPdf(a, { props: { clear: true } }));
    assert.ok(!doc.getTitle());
  });
});
