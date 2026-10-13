/*
 * docx.js — Fichiers Word (.docx) : ouverture, analyse du modèle, génération de la fiche et vérification.
 *
 * Un .docx est une archive zip : seul word/document.xml est réécrit (plus, pour les signatures dessinées,
 * l'image, sa relation et le type PNG). Tout le reste du modèle (styles, logo, mise en page) est recopié tel quel.
 * La fiche générée est relue depuis l'archive produite, puis comparée aux saisies (template.verify).
 */
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const JSZip = require('jszip');
const Template = require('./template.js');

const MAX_DOCX_BYTES = 40 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 3 * 1024 * 1024;

/** Archive et partie principale (word/document.xml en général, d'après _rels/.rels). */
async function open(buffer) {
  if (!buffer || buffer.length < 4 || buffer.length > MAX_DOCX_BYTES) throw new Error('Fichier Word trop volumineux ou vide.');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('Ce fichier n\'est pas un document Word (.docx).');
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error('Document Word illisible (archive endommagée).');
  }
  let part = 'word/document.xml';
  const rels = zip.file('_rels/.rels');
  if (rels) {
    const m = /<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*Target="([^"]+)"/.exec(await rels.async('string')) || /<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/officeDocument"/.exec(await rels.async('string'));
    if (m) part = m[1].replace(/^\//, '');
  }
  const file = zip.file(part);
  if (!file) throw new Error('Ce fichier n\'est pas un document Word (.docx).');
  const xml = await file.async('string');
  return { zip, part, xml };
}

/** Description d'un modèle : { schema, hash } (hash : empreinte du contenu, pour les brouillons). */
async function describe(buffer) {
  const { xml } = await open(buffer);
  const schema = Template.analyze(xml);
  const hash = crypto.createHash('sha1').update(xml).digest('hex').slice(0, 16);
  return { schema, hash };
}

/** Image PNG d'une signature (data URL) → { png, width, height } ; null si invalide. */
function decodeSignature(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const png = Buffer.from(m[1], 'base64');
  if (png.length < 33 || png.length > MAX_SIGNATURE_BYTES) return null;
  if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > 4000 || height > 4000) return null;
  return { png, width, height };
}

const EMU_PER_CM = 360000;
// Assez petite pour garder la fiche sur une page (la case grandit d'environ une ligne)
const SIG_MAX_W = 3.6 * EMU_PER_CM;
const SIG_MAX_H = 0.9 * EMU_PER_CM;

/** Ajoute les signatures à l'archive : images, relations, type PNG → { [clé]: { rId, id, cx, cy } }. */
async function addSignatures(zip, part, signatures) {
  const images = {};
  const entries = Object.entries(signatures || {})
    .map(([key, url]) => [key, decodeSignature(url)])
    .filter(([, img]) => img);
  if (!entries.length) return images;

  const relsPath = path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
  const relsFile = zip.file(relsPath);
  let rels = relsFile ? await relsFile.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const taken = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));

  let n = 0;
  for (const [key, img] of entries) {
    n++;
    let rId = `rIdFichInter${n}`;
    while (taken.has(rId)) rId += 'x';
    taken.add(rId);
    const target = `media/fichinter-signature-${n}.png`;
    zip.file(path.posix.join(path.posix.dirname(part), target), img.png);
    rels = rels.replace('</Relationships>', `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`);
    // Taille dans la case : 3,6 × 0,9 cm au plus, proportions gardées
    let cx = SIG_MAX_W;
    let cy = (cx * img.height) / img.width;
    if (cy > SIG_MAX_H) {
      cy = SIG_MAX_H;
      cx = (cy * img.width) / img.height;
    }
    images[key] = { rId, id: 1900000000 + n, cx: Math.round(cx), cy: Math.round(cy), target };
  }
  zip.file(relsPath, rels);

  const ct = zip.file('[Content_Types].xml');
  if (ct) {
    let types = await ct.async('string');
    if (!/<Default\s+Extension="png"/i.test(types)) types = types.replace(/(<Types\b[^>]*>)/, '$1<Default Extension="png" ContentType="image/png"/>');
    zip.file('[Content_Types].xml', types);
  }
  return images;
}

/** Date de modification du document (docProps/core.xml), si présente. */
async function touchCoreProps(zip) {
  const core = zip.file('docProps/core.xml');
  if (!core) return;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const xml = (await core.async('string'))
    .replace(/(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${now}$2`)
    .replace(/(<cp:lastModifiedBy>)[^<]*(<\/cp:lastModifiedBy>)/, '$1FichInter$2');
  zip.file('docProps/core.xml', xml);
}

/**
 * Fiche remplie : { buffer, checks } — checks : vérification de chaque champ dans le fichier produit (relu).
 * values : { [clé]: saisie } ; signatures : { [clé]: data URL PNG }.
 */
async function generate(templateBuffer, values, signatures) {
  const { zip, part, xml } = await open(templateBuffer);
  const images = await addSignatures(zip, part, signatures);
  const filled = Template.fill(xml, values || {}, images);
  zip.file(part, filled);
  await touchCoreProps(zip);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  // Relecture : le fichier produit est rouvert comme le ferait Word
  const back = await open(buffer);
  const checks = Template.verify(xml, back.xml, values || {}, images);
  for (const [key, img] of Object.entries(images)) {
    const media = back.zip.file(path.posix.join(path.posix.dirname(back.part), img.target));
    const item = checks.find((c) => c.key === key);
    if (item && !media) {
      item.ok = false;
      item.problem = 'Image de la signature absente du fichier.';
    }
  }
  return { buffer, checks };
}

/**
 * Vérifie une fiche déjà enregistrée (fiches récentes) : ses cases contiennent-elles encore les saisies ?
 * Une différence signale une fiche modifiée depuis (dans Word, par exemple).
 */
async function check(templateBuffer, ficheBuffer, values) {
  const tpl = await open(templateBuffer);
  const doc = await open(ficheBuffer);
  const images = {};
  for (const [key, v] of Object.entries(values || {})) {
    if (v && typeof v === 'object' && decodeSignature(v.image)) images[key] = { rId: 'rIdCheck', id: 1, cx: 1, cy: 1 };
  }
  return Template.verify(tpl.xml, doc.xml, values || {}, images);
}

module.exports = { open, describe, generate, check, decodeSignature };
