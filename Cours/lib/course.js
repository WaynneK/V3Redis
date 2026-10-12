/*
 * course.js — Outils de l'application Cours, sans dépendance ni accès système.
 * Chargé par la page (<script>, objet global « Course »), par le processus principal et par les tests (require).
 *
 *   validate(content)            contrôle de lib/content.js (identifiants, couleurs, informations des PDF)
 *   titleFromFile(name)          « 01 - Adressage IP.pdf » → « Adressage IP »
 *   mergeDocuments(part, liste)  contenu du dossier de la partie (PDF seuls, cours en dossier) + content.js
 *   coverOf(cours)               PDF qui représente un cours : son condensé, sinon son premier PDF
 *   isSafeRel(chemin)            « Cours/Condensé/x.pdf » : chemin sûr dans le dossier d'une partie
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

  /**
   * Nom de fichier → titre lisible : sans extension, sans numéro d'ordre en tête, « _ » remplacés par des espaces,
   * nom tout en majuscules remis en minuscules (« NOTIONS DE BASE.pdf » → « Notions de base » ; les sigles courts
   * comme « DNS » sont gardés).
   */
  function titleFromFile(name) {
    const base = str(name).replace(/\.(pdf|png|jpe?g|gif|webp|bmp|mp4|m4v|webm|ogv|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i, '').replace(/[_]+/g, ' ');
    let t = base.replace(/^\s*\d+\s*[-–—.)_ ]\s*/, '').trim() || base.trim();
    if (t.length > 4 && t === t.toUpperCase() && /[A-ZÀ-Ý]/.test(t)) t = t.charAt(0) + t.slice(1).toLowerCase();
    return t;
  }

  const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;
  /** Nom de fichier PDF acceptable (pas de chemin, pas de caractères de contrôle). */
  const isPdfName = (name) => typeof name === 'string' && /\.pdf$/i.test(name) && !BAD_CHARS.test(name);
  /** Photo ou image (fichiers d'un cours en dossier). */
  const isImageName = (name) => typeof name === 'string' && /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) && !BAD_CHARS.test(name);
  /** Vidéo lisible par la visionneuse (Chromium). */
  const isVideoName = (name) => typeof name === 'string' && /\.(mp4|m4v|webm|ogv)$/i.test(name) && !BAD_CHARS.test(name);
  /** Document Office (ouvert avec le programme de l'ordinateur : Word, Excel, PowerPoint…). */
  const isOfficeName = (name) => typeof name === 'string' && /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i.test(name) && !BAD_CHARS.test(name);
  /** Sorte de fichier : 'pdf', 'image', 'video', 'office' ; '' : non pris en charge. */
  const kindOf = (name) => (isPdfName(name) ? 'pdf' : isImageName(name) ? 'image' : isVideoName(name) ? 'video' : isOfficeName(name) ? 'office' : '');
  /** Programme d'un document Office : 'word', 'excel', 'powerpoint' ou '' (autre). */
  const officeApp = (name) => (/\.(docx?|odt|rtf)$/i.test(name) ? 'word' : /\.(xlsx?|ods)$/i.test(name) ? 'excel' : /\.(pptx?|odp)$/i.test(name) ? 'powerpoint' : '');
  const KIND_ORDER = { pdf: 0, office: 1, image: 2, video: 3 };
  const isFolderName = (name) => typeof name === 'string' && Boolean(name.trim()) && name !== '.' && name !== '..' && !BAD_CHARS.test(name);
  /** Sous-dossier du condensé d'un cours : « Condensé », « Condensée », « Condensés »… */
  const isCondenseFolder = (name) => /^condens[ée]e?s?$/i.test(str(name).normalize('NFC').trim());

  /**
   * Chemin d'un fichier dans le dossier d'une partie, avec « / » : « x.pdf », « Cours/x.pdf »,
   * « Cours/Condensé/x.pdf » (trois niveaux au plus, aucun « .. », un PDF ou une image au bout).
   */
  function isSafeRel(rel) {
    if (typeof rel !== 'string') return false;
    const segs = rel.split('/');
    return segs.length <= 3 && segs.slice(0, -1).every(isFolderName) && kindOf(segs[segs.length - 1]) !== '';
  }

  /** « Architecture_et_Electricite - Mohssine.pdf » → { title: 'Architecture et Electricite', author: 'Mohssine' }. */
  function splitAuthor(name) {
    const t = titleFromFile(name);
    const m = /^(.+?)\s+[-–—]\s+([^-–—]+)$/.exec(t);
    return m ? { title: m[1].trim(), author: m[2].trim() } : { title: t, author: '' };
  }

  /** « 2026-10-05 » → millisecondes (midi, heure locale), ou 0. */
  const dayMs = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(str(iso)) ? new Date(`${iso}T12:00:00`).getTime() || 0 : 0);

  const LOGOS = ['microsoft']; // logos de partie dessinés par la page (renderer/app.js)
  /** Icônes de cours (content.js : icon), dessinées par la page (renderer/app.js, COURSE_ICONS). */
  const COURSE_ICONS = ['alimentation', 'cpu', 'carte-mere', 'chipset', 'bios', 'disque', 'codage', 'document'];

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
        // Cours en dossier : { folder, title?, description?, date?: 'AAAA-MM-JJ', files?: { 'nom.pdf': 'Titre' } }
        const key = d && d.folder !== undefined ? d.folder : d && d.file;
        if (d && d.folder !== undefined) {
          if (!isFolderName(d.folder)) errors.push(`${dw} : « folder » doit être un nom de dossier (sans / ni \\).`);
          if (d.date !== undefined && !dayMs(d.date)) errors.push(`${dw} : « date » doit être de la forme AAAA-MM-JJ.`);
          if (d.icon !== undefined && !COURSE_ICONS.includes(d.icon)) errors.push(`${dw} : icône inconnue (${COURSE_ICONS.join(', ')}).`);
          if (d.files !== undefined && (typeof d.files !== 'object' || Array.isArray(d.files) || d.files === null)) errors.push(`${dw} : « files » doit associer un nom de fichier à un titre.`);
        } else if (!d || !isPdfName(d.file)) errors.push(`${dw} : « file » doit être un nom de fichier .pdf (sans dossier), ou « folder » un dossier de cours.`);
        if (typeof key === 'string' && files.has(key.toLowerCase())) errors.push(`${dw} : « ${key} » en double.`);
        else if (typeof key === 'string') files.add(key.toLowerCase());
      });
    });
    return errors;
  }

  const natural = (a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' });

  /**
   * Contenu du dossier d'une partie + informations de content.js → cours affichés.
   * listing : { files: [{ file, size, mtime }], folders: [{ folder, files: [{ file, size, mtime }], condense: [...] }] }
   * (une liste seule = { files } : ancien format). « file » est le chemin dans le dossier de la partie (« / »).
   *   - PDF posé dans la partie : un cours d'un seul PDF (kind 'pdf') ;
   *   - dossier : un cours avec tous ses fichiers, PDF et photos (kind 'folder'), et son condensé (sous-dossier
   *     « Condensé ») : le PDF qui rassemble tout le cours.
   * Ordre : cours datés d'abord (chronologique), puis les autres par nom (« 2 » avant « 10 »).
   */
  function mergeDocuments(part, listing) {
    const list = Array.isArray(listing) ? { files: listing, folders: [] } : listing || {};
    const docs = Array.isArray(part.documents) ? part.documents : [];
    const extraFile = new Map(docs.filter((d) => d && d.folder === undefined && isPdfName(d.file)).map((d) => [d.file.toLowerCase(), d]));
    const extraFolder = new Map(docs.filter((d) => d && isFolderName(d.folder)).map((d) => [d.folder.toLowerCase(), d]));
    const fileEntry = (f, titles) => {
      const name = f.file.split('/').pop();
      const own = titles && typeof titles === 'object' ? str(titles[name]).trim() : '';
      return { partId: part.id, file: f.file, name, kind: kindOf(name), title: own || titleFromFile(name), size: Number(f.size) || 0, mtime: Number(f.mtime) || 0 };
    };
    const singles = (Array.isArray(list.files) ? list.files : [])
      .filter((f) => f && isPdfName(f.file))
      .map((f) => {
        const x = extraFile.get(f.file.toLowerCase()) || {};
        return {
          partId: part.id,
          file: f.file,
          kind: 'pdf',
          // Le titre enregistré dans un PDF est souvent inutilisable (« Microsoft Word - doc1.docx ») : le nom du fichier passe avant
          title: str(x.title).trim() || titleFromFile(f.file),
          description: str(x.description).trim() || str(f.pdfSubject).trim(),
          author: str(x.author).trim(), // sinon : auteur enregistré dans le PDF (lu avec l'aperçu)
          date: 0,
          size: Number(f.size) || 0,
          mtime: Number(f.mtime) || 0,
        };
      });
    // Cours déclarés dans content.js sans dossier (ou dossier vide) : affichés « à venir », sans fichier
    const found = (Array.isArray(list.folders) ? list.folders : []).filter((g) => g && isFolderName(g.folder));
    const declared = [...extraFolder.values()].filter((x) => !found.some((g) => g.folder.toLowerCase() === x.folder.toLowerCase())).map((x) => ({ folder: x.folder, files: [], condense: [] }));
    const folders = [...found, ...declared]
      .map((g) => {
        const x = extraFolder.get(g.folder.toLowerCase()) || {};
        const files = (Array.isArray(g.files) ? g.files : [])
          .filter((f) => f && isSafeRel(f.file))
          .map((f) => fileEntry(f, x.files))
          // PDF d'abord, puis documents Office, photos, vidéos ; chacun par nom
          .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || natural(a.name, b.name));
        const condensed = (Array.isArray(g.condense) ? g.condense : []).filter((f) => f && isSafeRel(f.file) && isPdfName(f.file.split('/').pop()));
        const c = condensed.length ? fileEntry(condensed.sort((a, b) => natural(a.file, b.file))[0], x.files) : null;
        // Condensé : auteur tiré du nom (« Sujet - Auteur.pdf ») ; titre de content.js s'il y en a un
        const sa = c ? splitAuthor(c.name) : null;
        const own = c && x.files && typeof x.files === 'object' ? str(x.files[c.name]).trim() : '';
        const condense = c ? { ...c, title: own || sa.title, author: sa.author, condense: true } : null;
        const all = condense ? [condense, ...files] : files;
        return {
          partId: part.id,
          file: g.folder, // identifiant du cours dans sa partie (statut, notes, sélection)
          kind: 'folder',
          title: str(x.title).trim() || titleFromFile(g.folder),
          description: str(x.description).trim(),
          author: str(x.author).trim(),
          date: dayMs(x.date),
          icon: COURSE_ICONS.includes(x.icon) ? x.icon : '', // icône du cours (liste, grande vignette)
          files,
          condense,
          size: all.reduce((n, f) => n + f.size, 0),
          mtime: all.reduce((n, f) => Math.max(n, f.mtime), 0),
          empty: !all.length, // cours annoncé, fichiers pas encore déposés
          declared: extraFolder.has(g.folder.toLowerCase()),
        };
      })
      // Dossier vide sans entrée dans content.js : ignoré ; cours déclaré : affiché même vide
      .filter((g) => !g.empty || g.declared);
    return [...singles, ...folders].sort((a, b) => (a.date && b.date ? a.date - b.date : a.date ? -1 : b.date ? 1 : natural(a.file, b.file)));
  }

  /** PDF qui représente un cours (aperçu, « Visionner », sommaire) : son condensé, sinon son premier PDF. */
  function coverOf(d) {
    if (!d) return null;
    if (d.kind !== 'folder') return d;
    return d.condense || d.files.find((f) => f.kind === 'pdf') || null;
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
        // Cours en dossier : ses fichiers et son condensé (titre, auteur) comptent aussi
        const inside = d.kind === 'folder' ? [...(d.files || []).map((f) => f.title), d.condense ? `${d.condense.title} ${d.condense.author} condensé` : ''] : [];
        const hay = fold([d.title, d.description, d.author, d.file, p.name, p.description, ...inside].join(' '));
        if (!words.every((w) => hay.includes(w))) continue;
        const score = words.filter((w) => fold(d.title).includes(w)).length * 10 + words.filter((w) => fold(d.description).includes(w)).length;
        out.push({ ...d, partName: p.name, score });
      }
    }
    return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'fr'));
  }

  return { COURSE_ICONS, fold, titleFromFile, isPdfName, isImageName, isVideoName, isOfficeName, officeApp, kindOf, isFolderName, isCondenseFolder, isSafeRel, splitAuthor, validate, mergeDocuments, coverOf, splitCode, sections, pdfDate, formatSize, search };
});
