/*
 * fields.js — Règles communes aux champs d'une fiche (processus principal et page) :
 *   - type d'un champ d'après son intitulé (date, heure, e-mail, texte long…) ;
 *   - mise en forme d'une saisie telle qu'elle est écrite dans la fiche (dates à la française…) ;
 *   - aides à la saisie (date du jour, valeur mémorisée, référence de dossier) ;
 *   - nom du fichier généré.
 * Module UMD : require() dans Node, window.Fields dans la page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fields = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Minuscules, sans accents, apostrophes droites, espaces simples. */
  function norm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[’‘`]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** Hauteur de ligne (twips) à partir de laquelle une case est un texte long. */
  const TALL_ROW = 900;

  const LONG_TEXT = /(description|diagnostic|actions?\b|remarque|recommandation|observation|message|changement|pieces|logiciels|information|commentaire|detail|travaux|constat|probleme rencontre)/;

  /**
   * Type d'un champ texte d'après son intitulé et la hauteur de sa ligne dans le modèle :
   * 'signature' | 'email' | 'tel' | 'datetime' | 'date' | 'time' | 'textarea' | 'text'.
   */
  function guessKind(label, rowHeight) {
    const n = norm(label);
    if (/signature|signe par|visa\b/.test(n)) return 'signature';
    if (/\b(e-?mail|mail|courriel|adresse electronique)\b/.test(n)) return 'email';
    // « portable » / « mobile » seuls désignent aussi un ordinateur : téléphone seulement avec « numéro »
    if (/(telephone|\btel\b|\bfax\b)/.test(n) || (/\b(portable|mobile)\b/.test(n) && /(numero|n°|\bno\b)/.test(n))) return 'tel';
    if (/\bdate\b/.test(n) && /\bheure\b/.test(n)) return 'datetime';
    if (/\bdate\b|\bjusqu'au\b|\becheance\b/.test(n)) return 'date';
    // « Heure d'arrivée » : une heure ; « Nombre d'heures », « Heures facturées » : du texte
    if (/\bheure\b/.test(n) && !/(nombre|\bnb\b|total|temps|duree|tarif|taux)/.test(n)) return 'time';
    if ((rowHeight || 0) >= TALL_ROW || LONG_TEXT.test(n)) return 'textarea';
    return 'text';
  }

  /** Nombre de lignes conseillé pour un texte long (d'après la hauteur de la ligne du modèle). */
  function rowsFor(rowHeight) {
    if (!rowHeight || rowHeight < TALL_ROW) return 3;
    return Math.max(3, Math.min(10, Math.round(rowHeight / 280)));
  }

  // ---------------------------------------------------------------------------
  // Dates et heures (saisies au format des champs HTML, écrites à la française)
  // ---------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');

  /** « 2026-10-13 » → « 13/10/2026 » (sinon le texte tel quel). */
  function frDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || '').trim();
  }

  /** « 14:30 » → « 14h30 ». */
  function frTime(v) {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v || '').trim());
    return m ? `${pad(m[1])}h${m[2]}` : String(v || '').trim();
  }

  /** « 2026-10-13T14:30 » → « 13/10/2026 à 14h30 ». */
  function frDateTime(v) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(v || '').trim());
    return m ? `${frDate(m[1])} à ${frTime(m[2])}` : String(v || '').trim();
  }

  function isoToday(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function isoTime(now = new Date()) {
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  /** Durée entre deux heures « HH:MM » (passage de minuit compris) : « 1h30 », « 45 min », ou ''. */
  function duration(from, to) {
    const a = /^(\d{1,2}):(\d{2})$/.exec(String(from || ''));
    const b = /^(\d{1,2}):(\d{2})$/.exec(String(to || ''));
    if (!a || !b) return '';
    let mins = Number(b[1]) * 60 + Number(b[2]) - (Number(a[1]) * 60 + Number(a[2]));
    if (mins < 0) mins += 24 * 60;
    if (mins === 0) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h${m ? pad(m) : ''}` : `${m} min`;
  }

  /** Saisie d'un champ simple (texte, date…) telle qu'elle est écrite dans la fiche. */
  function formatValue(kind, v) {
    const s = typeof v === 'string' ? v : '';
    if (kind === 'date') return frDate(s);
    if (kind === 'time') return frTime(s);
    if (kind === 'datetime') return frDateTime(s);
    return s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  }

  // ---------------------------------------------------------------------------
  // Valeurs d'un champ (forme des saisies) et texte affiché / écrit
  // ---------------------------------------------------------------------------
  //   text…      : '…'
  //   choice     : { selected: [index…], extra: { [index]: '…' } }
  //   check      : true / false
  //   blanks     : ['…', '…']
  //   signature  : { name: '…', image: 'data:image/png;base64,…' | '' }

  /** Le champ est-il rempli ? */
  function isFilled(field, value) {
    if (field.kind === 'choice') return Boolean(value && Array.isArray(value.selected) && value.selected.length);
    if (field.kind === 'check') return value === true;
    if (field.kind === 'blanks') return Array.isArray(value) && value.some((v) => String(v || '').trim());
    if (field.kind === 'signature') return Boolean(value && (String(value.name || '').trim() || value.image));
    return typeof value === 'string' && value.trim() !== '';
  }

  /** Texte d'une option choisie (avec sa précision éventuelle : « Autre : imprimante »). */
  function optionText(field, index, value) {
    const opt = field.options[index];
    if (!opt) return '';
    const extra = opt.extra && value && value.extra ? formatValue(opt.extra.kind, String(value.extra[index] || '')).trim() : '';
    return extra ? `${opt.label} : ${extra}` : opt.label;
  }

  /** Résumé lisible d'une saisie (récapitulatif et vérification). '' si vide. */
  function display(field, value) {
    if (!isFilled(field, value)) return '';
    switch (field.kind) {
      case 'choice':
        return value.selected
          .filter((i) => field.options[i])
          .sort((a, b) => a - b)
          .map((i) => optionText(field, i, value))
          .join(' · ');
      case 'check':
        return field.options[0] ? field.options[0].label : 'Oui';
      case 'blanks':
        return field.blanks.map((b, i) => formatValue(b.kind, String(value[i] || '')).trim()).filter(Boolean).join(' · ');
      case 'signature': {
        const name = String(value.name || '').trim();
        return [name, value.image ? 'signature manuscrite' : ''].filter(Boolean).join(' · ');
      }
      default:
        return formatValue(field.kind, value);
    }
  }

  // ---------------------------------------------------------------------------
  // Aides à la saisie
  // ---------------------------------------------------------------------------

  /**
   * Aides proposées pour un champ (d'après son intitulé) :
   *   today    : date du jour par défaut (date de l'intervention, « Fait à … le »)
   *   remember : la dernière valeur saisie est reprise (technicien, lieu de signature)
   *   ref      : bouton « Générer » une référence de dossier
   *   now      : bouton « Maintenant » (heures)
   *   duration : durée calculée à partir des heures d'arrivée et de fin
   */
  function assistOf(field) {
    const n = norm(field.label);
    const a = {};
    if (field.kind === 'date' && /intervention|^date$|^le$/.test(n)) a.today = true;
    if (field.kind === 'time' || field.kind === 'datetime') a.now = true;
    if (/technicien|intervenant|\bagent\b/.test(n) && field.kind !== 'signature') a.remember = true;
    if (field.kind === 'signature' && /technicien|intervenant/.test(n)) a.remember = true;
    if (/^((ref|reference|n°|no|numero)\.? (du |de )?)?dossier\b/.test(n)) a.ref = true;
    if (/^(temps|duree)\b/.test(n)) a.duration = true;
    if (field.kind === 'blanks') {
      a.blanks = field.blanks.map((b) => (b.kind === 'date' ? { today: true } : /fait a/.test(n) ? { remember: true } : {}));
    }
    return a;
  }

  /** Référence de dossier : INT-AAAAMMJJ-NN (NN : numéro du jour). */
  function makeRef(now, counter) {
    const d = now || new Date();
    return `INT-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(Math.max(1, counter || 1))}`;
  }

  // ---------------------------------------------------------------------------
  // Fichier généré
  // ---------------------------------------------------------------------------

  /** Nom de fichier sûr (Windows, macOS, Linux). */
  function safeFileName(s, max = 80) {
    const clean = String(s || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    const cut = clean.length > max ? clean.slice(0, max).trim() : clean;
    return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cut) ? `_${cut}` : cut;
  }

  /** Premier champ texte rempli dont l'intitulé correspond. */
  function findText(schema, values, re) {
    for (const s of schema.sections) {
      for (const f of s.fields) {
        if (re.test(norm(f.label)) && typeof values[f.key] === 'string' && values[f.key].trim() && f.kind !== 'textarea') {
          return values[f.key].trim().replace(/^(m\.|mr\.?|mme|mlle|monsieur|madame)\s+/i, '');
        }
      }
    }
    return '';
  }

  /** « Fiche d'intervention - Dupont - 13-10-2026 » (sans extension). */
  function fileTitle(schema, values, now) {
    const who = findText(schema, values, /^(client|nom du client|societe|raison sociale|entreprise)/) || findText(schema, values, /societe|raison sociale|client/);
    let when = '';
    for (const s of schema.sections) {
      for (const f of s.fields) {
        if (!when && f.kind === 'date' && /intervention/.test(norm(f.label)) && /^\d{4}-\d{2}-\d{2}$/.test(values[f.key] || '')) when = values[f.key];
      }
    }
    const d = when || isoToday(now);
    const date = `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
    return safeFileName(['Fiche d\'intervention', who, date].filter(Boolean).join(' - '));
  }

  return { norm, guessKind, rowsFor, TALL_ROW, frDate, frTime, frDateTime, isoToday, isoTime, duration, formatValue, isFilled, optionText, display, assistOf, makeRef, safeFileName, fileTitle };
});
