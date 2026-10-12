/*
 * course.js — Outils de l'application Cours, sans dépendance ni accès système.
 * Chargé par la page (<script>, objet global « Course »), par le processus principal et par les tests (require).
 *
 *   validate(content)            contrôle de lib/content.js (identifiants, couleurs, informations des PDF)
 *   titleFromFile(name)          « 01 - Adressage IP.pdf » → « Adressage IP »
 *   mergeDocuments(part, files)  PDF trouvés dans le dossier de la partie + informations de content.js
 *   search(parts, query)         recherche dans les titres et descriptions (accents et casse ignorés)
 *   sections(signets)            sommaire d'un résumé (signets du PDF), codes A1 / 2.3 repérés
 *   pdfDate(« D:2026… »)         date enregistrée dans un PDF → millisecondes
 *   formatSize(octets)           « 1,2 Mo »
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Course = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const str = (v) => (v === undefined || v === null ? '' : String(v));

  /** Clé de comparaison : sans accents, sans casse, espaces réduits. */
  function fold(s) {
    return str(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** Nom de fichier → titre lisible : sans extension, sans numéro d'ordre en tête, « _ » remplacés par des espaces. */
  function titleFromFile(name) {
    const base = str(name).replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
    const cleaned = base.replace(/^\s*\d+\s*[-–—.)_ ]\s*/, '').trim();
    return cleaned || base.trim();
  }

  /** Nom de fichier PDF acceptable (pas de chemin, pas de caractères de contrôle). */
  const isPdfName = (name) => typeof name === 'string' && /\.pdf$/i.test(name) && !/[\\/:*?"<>|\u0000-\u001f]/.test(name);

  const LOGOS = ['microsoft']; // logos de partie dessinés par la page (renderer/app.js)

  function validate(content) {
    const errors = [];
    const parts = content && Array.isArray(content.parts) ? content.parts : null;
    if (!parts || !parts.length) return ['Aucune partie dans le contenu.'];
    const ids = new Set();
    parts.forEach((p, i) => {
      const where = `Partie ${i + 1}${p && p.name ? ` (${p.name})` : ''}`;
      if (!p || typeof p !== 'object') return errors.push(`${where} : invalide.`);
      if (!/^[a-z0-9-]+$/.test(str(p.id))) errors.push(`${where} : identifiant invalide (lettres minuscules, chiffres, tirets).`);
      else if (ids.has(p.id)) errors.push(`${where} : identifiant « ${p.id} » en double.`);
      ids.add(p.id);
      if (!str(p.name).trim()) errors.push(`${where} : nom manquant.`);
      if (!/^#[0-9a-f]{6}$/i.test(str(p.accent))) errors.push(`${where} : couleur invalide (forme #rrggbb).`);
      if (p.logo !== undefined && !LOGOS.includes(p.logo)) errors.push(`${where} : logo inconnu (${LOGOS.join(', ')}).`);
      if (p.documents !== undefined && !Array.isArray(p.documents)) errors.push(`${where} : « documents » doit être une liste.`);
      const files = new Set();
      (Array.isArray(p.documents) ? p.documents : []).forEach((d, j) => {
        const dw = `${where}, document ${j + 1}`;
        if (!d || !isPdfName(d.file)) errors.push(`${dw} : « file » doit être un nom de fichier .pdf (sans dossier).`);
        else if (files.has(d.file.toLowerCase())) errors.push(`${dw} : « ${d.file} » en double.`);
        else files.add(d.file.toLowerCase());
      });
    });
    return errors;
  }

  /**
   * PDF trouvés dans le dossier de la partie ([{ file, size, mtime, pdfSubject? }]) + informations de
   * content.js → documents affichés, rangés par nom de fichier (ordre naturel : « 2 » avant « 10 »).
   */
  function mergeDocuments(part, files) {
    const extra = new Map((Array.isArray(part.documents) ? part.documents : []).filter((d) => d && isPdfName(d.file)).map((d) => [d.file.toLowerCase(), d]));
    return (Array.isArray(files) ? files : [])
      .filter((f) => f && isPdfName(f.file))
      .sort((a, b) => a.file.localeCompare(b.file, 'fr', { numeric: true, sensitivity: 'base' }))
      .map((f) => {
        const x = extra.get(f.file.toLowerCase()) || {};
        return {
          partId: part.id,
          file: f.file,
          // Le titre enregistré dans un PDF est souvent inutilisable (« Microsoft Word - doc1.docx ») : le nom du fichier passe avant
          title: str(x.title).trim() || titleFromFile(f.file),
          description: str(x.description).trim() || str(f.pdfSubject).trim(),
          author: str(x.author).trim(), // sinon : auteur enregistré dans le PDF (lu avec l'aperçu)
          size: Number(f.size) || 0,
          mtime: Number(f.mtime) || 0,
        };
      });
  }

  const MAX_SECTIONS = 40; // par niveau : un sommaire reste lisible

  /** « A1Les définitions » / « 2.3 DNS » / « 2. DNS » → { code, title } (pas de code : code vide). */
  function splitCode(title) {
    const t = str(title).replace(/\s+/g, ' ').trim();
    const m =
      /^([A-Z]\d{1,2})(?=[\s.:)–—-]|[A-ZÀ-Ý])[\s.:)–—-]*(.+)$/.exec(t) || // A1, B12
      /^(\d{1,2}(?:\.\d{1,2})+)\.?\s+(.+)$/.exec(t) || // 2.3
      /^(\d{1,2})(?:[.)]\s*|\s+[–—-]\s+)(.+)$/.exec(t); // 2. / 2) / 2 - (« 3 types » reste un titre)
    return m ? { code: m[1], title: m[2].trim() } : { code: '', title: t };
  }

  /**
   * Sommaire d'un résumé à partir des signets du PDF : [{ title, page, items?: [{ title, page }] }]
   * → [{ code, title, page, items: [{ code, title, page }] }] (deux niveaux).
   * Codes repérés en tête des titres (« A1 », « 2.3 ») ; une partie sans code prend la lettre commune de ses
   * sections (A1, A2… → A). La page de garde (page 1, sans sections, à côté de parties qui en ont) est retirée.
   */
  function sections(outline) {
    const pageOf = (p) => (Number.isInteger(Number(p)) && Number(p) >= 1 ? Number(p) : null);
    const clean = (list, depth) =>
      (Array.isArray(list) ? list : [])
        .filter((o) => o && str(o.title).trim())
        .slice(0, MAX_SECTIONS)
        .map((o) => {
          const { code, title } = splitCode(o.title);
          const items = depth ? [] : clean(o.items, depth + 1);
          let c = code;
          if (!c && items.length) {
            const letters = new Set(items.map((i) => (/^[A-Z](?=\d)/.exec(i.code) || [''])[0]));
            if (letters.size === 1 && !letters.has('')) c = [...letters][0];
          }
          return { code: c, title, page: pageOf(o.page), items };
        });
    const top = clean(outline, 0);
    const structured = top.some((o) => o.items.length);
    return top.filter((o) => !(structured && o.page === 1 && !o.items.length));
  }

  /** Date enregistrée dans un PDF (« D:20261010150248+02'00' ») → millisecondes, ou null. */
  function pdfDate(value) {
    const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(str(value).trim());
    if (!m) return null;
    const [y, mo = '01', d = '01', hh = '00', mi = '00', ss = '00'] = m.slice(1, 7);
    let t = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
    if (m[7] === '+' || m[7] === '-') t -= (m[7] === '+' ? 1 : -1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000;
    return Number.isFinite(t) ? t : null;
  }

  /** « 1,2 Mo », « 340 Ko » */
  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1048576) return `${(n / 1048576).toFixed(1).replace('.', ',')} Mo`;
    return `${Math.max(1, Math.round(n / 1024))} Ko`;
  }

  /**
   * Recherche : chaque mot doit apparaître dans le titre, la description, le nom du fichier ou la partie.
   * parts : [{ id, name, description, documents: [document affiché] }] → [{ partId, file, title, … , score }].
   */
  function search(parts, query) {
    const words = fold(query).split(' ').filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const p of parts || []) {
      for (const d of p.documents || []) {
        const hay = fold([d.title, d.description, d.author, d.file, p.name, p.description].join(' '));
        if (!words.every((w) => hay.includes(w))) continue;
        const score = words.filter((w) => fold(d.title).includes(w)).length * 10 + words.filter((w) => fold(d.description).includes(w)).length;
        out.push({ ...d, partName: p.name, score });
      }
    }
    return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'fr'));
  }

  return { fold, titleFromFile, isPdfName, validate, mergeDocuments, splitCode, sections, pdfDate, formatSize, search };
});
