/*
 * agdlp.js — Moteur AGDLP d'Agépédé (aucune dépendance, aucun accès système).
 *
 * Chargé tel quel par l'interface (<script>, objet global « Agdlp ») et par le processus principal
 * (require) : l'aperçu des commandes, le script .bat exporté et l'exécution utilisent exactement
 * les mêmes lignes de commande.
 *
 * Modèle AGDLP : comptes (A) → groupes globaux (G) → groupes domaine local (DL) → permissions (P).
 * Les objets sont créés avec les outils classiques de cmd.exe : dsadd, dsmod, dsquery, icacls.
 * Les références (syntaxe vérifiée, sources) sont dans docs/COMMANDES.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Agdlp = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes
  // ---------------------------------------------------------------------------

  const TABLES = ['ous', 'globals', 'locals', 'permissions'];

  /** Préfixes conseillés (convention de nommage, simple avertissement). */
  const PREFIXES = { global: 'GG_', local: 'DL_' };

  /** Droits NTFS proposés : (OI)(CI) = hérités par les fichiers et sous-dossiers. */
  const RIGHTS = {
    R: { label: 'Lecture', icacls: '(OI)(CI)RX' },
    RW: { label: 'Modification', icacls: '(OI)(CI)M' },
    F: { label: 'Contrôle total', icacls: '(OI)(CI)F' },
  };

  /** Colonnes des tableaux (import / export CSV, collage depuis Excel). */
  const COLUMNS = {
    ous: [
      { key: 'name', label: 'Nom' },
      { key: 'parent', label: 'OU parente' },
      { key: 'description', label: 'Description' },
    ],
    globals: [
      { key: 'name', label: 'Nom' },
      { key: 'ou', label: 'OU' },
      { key: 'description', label: 'Description' },
      { key: 'members', label: 'Membres (utilisateurs)' },
    ],
    locals: [
      { key: 'name', label: 'Nom' },
      { key: 'ou', label: 'OU' },
      { key: 'description', label: 'Description' },
      { key: 'members', label: 'Membres (groupes globaux)' },
    ],
    permissions: [
      { key: 'path', label: 'Dossier' },
      { key: 'group', label: 'Groupe DL' },
      { key: 'right', label: 'Droit (R, RW, F)' },
    ],
  };

  /** Limites (voir docs/COMMANDES.md). */
  const LIMITS = {
    ou: 64, // longueur maximale d'un nom d'OU (KB 909264)
    cn: 64, // attribut cn (nom du groupe dans l'annuaire)
    samCompat: 20, // sAMAccountName : 20 caractères pour les clients « antérieurs à Windows 2000 »
    user: 20, // un nom d'ouverture de session (utilisateur) ne dépasse jamais 20 caractères
    path: 240,
    description: 1024,
  };

  // Caractères refusés partout : ils cassent la ligne de commande ou sont interprétés par cmd.exe
  // (" ferme les guillemets, % et ! développent des variables, ^ & | < > sont des opérateurs).
  const CMD_FORBIDDEN = ['"', '%', '!', '^', '&', '|', '<', '>'];
  // Caractères interdits dans un sAMAccountName (learn.microsoft.com : SAM-Account-Name), plus @.
  const SAM_FORBIDDEN = ['"', '/', '\\', '[', ']', ':', ';', '|', '=', ',', '+', '*', '?', '<', '>', '@'];
  const PATH_FORBIDDEN = CMD_FORBIDDEN.concat(['*', '?', '/']);
  // Caractères à échapper dans une valeur de DN (learn.microsoft.com : Distinguished Names).
  const DN_SPECIALS = /[,+"\\<>;=/]/g;

  const KIND_LABELS = { ou: "Le nom d'OU", group: 'Le nom de groupe', user: "Le nom d'utilisateur", path: 'Le chemin', desc: 'La description' };

  // ---------------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------------

  function str(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  }

  /** Clé de comparaison : AD ignore la casse ET les accents (« Comptabilité » = « comptabilite »). */
  function nameKey(s) {
    return str(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  }

  let idCounter = 0;
  /** Identifiant de ligne simple (pas de dépendance crypto). */
  function newId() {
    idCounter = (idCounter + 1) % 1679616;
    return 'r' + Date.now().toString(36) + idCounter.toString(36).padStart(4, '0') + Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0');
  }

  /** Argument de ligne de commande : entre guillemets sauf s'il ne contient que lettres, chiffres, _ . - */
  function arg(value) {
    const s = str(value);
    return /^[\p{L}\p{N}_.-]+$/u.test(s) ? s : `"${s}"`;
  }

  function firstChar(list, s) {
    for (const ch of s) if (list.includes(ch)) return ch;
    return null;
  }

  function showChar(ch) {
    if (ch === ' ') return 'espace';
    return `« ${ch} »`;
  }

  // ---------------------------------------------------------------------------
  // Domaine et noms distinctifs (DN)
  // ---------------------------------------------------------------------------

  /** « lab.local » → « DC=lab,DC=local ». */
  function domainToDn(dns) {
    return str(dns)
      .trim()
      .replace(/\.+$/, '')
      .split('.')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => 'DC=' + escapeRdn(p))
      .join(',');
  }

  /** Découpe un DN en RDN en respectant les virgules échappées (« \, »). */
  function splitDn(dn) {
    const parts = [];
    let cur = '';
    const s = str(dn);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        cur += ch + s[i + 1];
        i++;
      } else if (ch === ',') {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  /** « DC=lab,DC=local » → « lab.local » (les RDN autres que DC sont ignorés). */
  function dnToDomain(dn) {
    return splitDn(dn)
      .map((p) => /^dc\s*=\s*(.+)$/i.exec(p))
      .filter(Boolean)
      .map((m) => m[1].replace(/\\(.)/g, '$1'))
      .join('.');
  }

  /**
   * Échappe une valeur de RDN : , + " \ < > ; = / précédés d'une barre oblique inverse,
   * espace ou # en tête, espace en fin, retours chariot / ligne en hexadécimal (\0D, \0A).
   */
  function escapeRdn(value) {
    let s = str(value).replace(DN_SPECIALS, (c) => '\\' + c);
    s = s.replace(/\r/g, '\\0D').replace(/\n/g, '\\0A');
    if (/^[ #]/.test(s)) s = '\\' + s;
    if (/ $/.test(s) && !/\\ $/.test(s)) s = s.slice(0, -1) + '\\ ';
    return s;
  }

  /** Découpe un chemin d'OU « Paris/Compta » (séparateur /, ou \ toléré). */
  function ouSegments(path) {
    return str(path)
      .split(/[/\\]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /** Chemin d'OU (de haut en bas) → DN : « Paris/Compta » → « OU=Compta,OU=Paris,<base> ». */
  function ouPathToDn(path, baseDn) {
    const segs = ouSegments(path);
    const base = str(baseDn).trim();
    if (!segs.length) return base;
    const rdns = segs.reverse().map((s) => 'OU=' + escapeRdn(s));
    return base ? rdns.join(',') + ',' + base : rdns.join(',');
  }

  /** Conteneur d'un groupe : chemin d'OU, ou le conteneur par défaut CN=Users si vide. */
  function containerDn(ouPath, baseDn) {
    if (!ouSegments(ouPath).length) return 'CN=Users,' + str(baseDn).trim();
    return ouPathToDn(ouPath, baseDn);
  }

  /** Chemin complet d'une ligne d'OU : parent + nom. */
  function ouFullPath(row) {
    return ouSegments(str(row && row.parent)).concat(ouSegments(str(row && row.name))).join('/');
  }

  /** Échappement d'une valeur dans un filtre LDAP (RFC 4515) : \ * ( ) NUL. */
  function escapeFilter(value) {
    return str(value).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  }

  /** Base DN du projet : domain.dn s'il est saisi, sinon dérivé du nom DNS. */
  function baseDnOf(domain) {
    const d = domain || {};
    return str(d.dn).trim() || domainToDn(d.dns);
  }

  /** Nom NetBIOS pour icacls : saisi, sinon première étiquette du nom DNS en majuscules. */
  function netbiosOf(domain) {
    const d = domain || {};
    const n = str(d.netbios).trim();
    if (n) return n;
    const first = (str(d.dns).trim() || dnToDomain(d.dn)).split('.')[0] || '';
    return first.toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // Membres et droits
  // ---------------------------------------------------------------------------

  /**
   * « jdupont, mmartin; pdurand » → ['jdupont', 'mmartin', 'pdurand'] (sans doublons, casse et
   * accents ignorés). Séparateurs : , ; tabulation et retour à la ligne. L'espace ne sépare que si
   * aucun de ces séparateurs n'est utilisé (« jdupont mmartin ») : on peut ainsi citer un groupe
   * existant dont le nom contient des espaces (« Utilisateurs du domaine, GG_Compta »).
   */
  function splitMembers(text) {
    const list = Array.isArray(text) ? text.map(str).join('\n') : str(text);
    const out = [];
    const seen = new Set();
    const tokens = /[,;\t\r\n]/.test(list.trim()) ? list.split(/[,;\t\r\n]+/) : list.split(/\s+/);
    for (const raw of tokens) {
      const name = raw.trim().replace(/\s+/g, ' ');
      if (!name) continue;
      const k = nameKey(name);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
    return out;
  }

  /** « Lecture » / « RX » / « modification » / « Contrôle total » … → 'R' | 'RW' | 'F' ('' si inconnu). */
  function normalizeRight(value) {
    const k = nameKey(value).replace(/[\s_-]+/g, ' ').trim();
    if (!k) return '';
    if (['r', 'rx', 'l', 'lecture', 'lire', 'read', 'lecture seule', 'lecture et execution'].includes(k)) return 'R';
    if (['rw', 'm', 'modification', 'modifier', 'modify', 'ecriture', 'lecture/ecriture', 'lecture ecriture', 'w'].includes(k)) return 'RW';
    if (['f', 'ct', 'controle total', 'total', 'full', 'full control', 'tout'].includes(k)) return 'F';
    return '';
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Vérifie un nom avant de l'écrire dans une ligne de commande.
   * kind : 'ou' | 'group' | 'user' | 'path' | 'desc'. Renvoie null ou un message d'erreur.
   */
  function validateName(kind, name) {
    const what = KIND_LABELS[kind] || 'La valeur';
    if (typeof name !== 'string' && typeof name !== 'number') return `${what} est vide.`;
    const s = String(name);
    if (kind === 'desc' && !s) return null;
    if (!s.trim()) return `${what} est vide.`;
    if (s !== s.trim()) return `${what} « ${s.trim()} » commence ou se termine par un espace.`;
    if (/[\u0000-\u001f\u007f]/.test(s)) return `${what} contient un retour à la ligne ou un caractère de contrôle.`;

    if (kind === 'desc') {
      const bad = firstChar(['"', '%', '!'], s);
      if (bad) return `${what} contient ${showChar(bad)} : ce caractère casse la ligne de commande.`;
      if (s.length > LIMITS.description) return `${what} dépasse ${LIMITS.description} caractères.`;
      return null;
    }

    if (kind === 'path') return validatePath(s);

    const cmdBad = firstChar(CMD_FORBIDDEN, s);
    if (cmdBad) return `${what} « ${s} » contient ${showChar(cmdBad)} : ce caractère est interprété par l'invite de commandes (cmd.exe).`;

    if (kind === 'ou') {
      if (/[/\\]/.test(s)) return `${what} « ${s} » contient « / » ou « \\ » : ces caractères séparent les niveaux d'OU (saisissez l'OU parente dans la colonne « OU parente »).`;
      if (s.length > LIMITS.ou) return `${what} « ${s} » dépasse ${LIMITS.ou} caractères (limite Active Directory).`;
      return null;
    }

    // Groupes et utilisateurs : règles du sAMAccountName.
    const samBad = firstChar(SAM_FORBIDDEN, s);
    if (samBad) return `${what} « ${s} » contient ${showChar(samBad)}, interdit dans un nom de compte Active Directory (" / \\ [ ] : ; | = , + * ? < > @).`;
    if (/^\.+$/.test(s)) return `${what} ne peut pas être composé uniquement de points.`;
    if (kind === 'user') {
      if (s.length > LIMITS.user) return `${what} « ${s} » dépasse ${LIMITS.user} caractères : un nom d'ouverture de session (pré-Windows 2000) est limité à 20 caractères.`;
      return null;
    }
    if (s.length > LIMITS.cn) return `${what} « ${s} » dépasse ${LIMITS.cn} caractères (limite de l'attribut cn).`;
    return null;
  }

  function validatePath(s) {
    const bad = firstChar(PATH_FORBIDDEN, s);
    if (bad) return `Le chemin « ${s} » contient ${showChar(bad)} : caractère interdit (chemins Windows avec « \\ » uniquement).`;
    const local = /^[A-Za-z]:\\/.test(s);
    const unc = /^\\\\[^\\]+\\[^\\]+/.test(s);
    if (!local && !unc) return `Le chemin « ${s} » doit être absolu : D:\\Partages\\Compta ou \\\\serveur\\partage\\dossier.`;
    if (s.indexOf(':', local ? 2 : 0) !== -1) return `Le chemin « ${s} » contient « : » ailleurs qu'après la lettre de lecteur.`;
    if (/\\\\/.test(s.slice(2))) return `Le chemin « ${s} » contient deux « \\ » consécutifs.`;
    const trimmed = cleanPath(s);
    if (/^[A-Za-z]:$/.test(trimmed)) return `Le chemin « ${s} » est la racine d'un lecteur : choisissez un dossier (ex. ${trimmed}\\Partages\\Compta).`;
    if (trimmed.split('\\').some((seg) => seg === '..' || seg === '.')) return `Le chemin « ${s} » contient « . » ou « .. » : saisissez un chemin complet.`;
    if (s.length > LIMITS.path) return `Le chemin « ${s} » dépasse ${LIMITS.path} caractères.`;
    return null;
  }

  /** Retire les « \ » finaux (un « \" » serait lu comme un guillemet littéral par les programmes). */
  function cleanPath(p) {
    let s = str(p).trim();
    while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
    if (/^[A-Za-z]:\\$/.test(s)) s = s.slice(0, 2);
    return s;
  }

  /** Avertissements sur un nom valide (compatibilité, conventions). */
  function nameWarnings(kind, name) {
    const s = str(name);
    const out = [];
    if (kind === 'group' && s.length > LIMITS.samCompat) {
      out.push(`« ${s} » dépasse ${LIMITS.samCompat} caractères : accepté par Active Directory, mais déconseillé pour la compatibilité « pré-Windows 2000 ».`);
    }
    if ((kind === 'group' || kind === 'user') && s.endsWith('.')) out.push(`« ${s} » se termine par un point : déconseillé pour un nom de compte.`);
    if (/[()]/.test(s) && (kind === 'group' || kind === 'user')) out.push(`« ${s} » contient des parenthèses : accepté, mais source d'erreurs dans les scripts.`);
    return out;
  }

  function validateDomain(domain, issues, needNetbios) {
    const d = domain || {};
    const dns = str(d.dns).trim();
    const dn = str(d.dn).trim();
    const nb = str(d.netbios).trim();
    const push = (field, message, level) => issues[level || 'errors'].push({ table: 'domain', id: null, field, message });
    if (!dns && !dn) push('dns', 'Indiquez le nom DNS du domaine (ex. lab.local).');
    if (dns) {
      const labels = dns.replace(/\.$/, '').split('.');
      if (labels.some((l) => !/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) {
        push('dns', `Nom de domaine « ${dns} » invalide : lettres, chiffres et tirets séparés par des points (ex. lab.local).`);
      } else if (labels.length < 2) {
        push('dns', `Le domaine « ${dns} » n'a qu'une étiquette : un domaine Active Directory a normalement la forme entreprise.local.`, 'warnings');
      }
    }
    if (dn) {
      const parts = splitDn(dn);
      if (!parts.length || parts.some((p) => !/^dc\s*=\s*[^=]+$/i.test(p))) {
        push('dn', `DN du domaine « ${dn} » invalide : forme attendue DC=lab,DC=local.`);
      } else if (dns && nameKey(dnToDomain(dn)) !== nameKey(dns.replace(/\.$/, ''))) {
        push('dn', `Le DN « ${dn} » ne correspond pas au domaine « ${dns} » : c'est le DN qui sera utilisé.`, 'warnings');
      } else if (firstChar(CMD_FORBIDDEN, dn)) {
        push('dn', `Le DN « ${dn} » contient un caractère interdit.`);
      }
    }
    if (nb) {
      if (nb.length > 15 || /[\\/:*?"<>|,~!@#$%^&'.(){}_\s]/.test(nb)) push('netbios', `Nom NetBIOS « ${nb} » invalide (15 caractères maximum, sans ponctuation).`);
    } else if (needNetbios && dns) {
      push('netbios', `Nom NetBIOS non renseigné : « ${netbiosOf(d)} » sera utilisé pour icacls (vérifiez qu'il est correct).`, 'warnings');
    }
  }

  /**
   * Contrôle complet du projet avant génération.
   * Renvoie { errors: [...], warnings: [...] }, chaque élément { table, id, field, message }.
   */
  function validateProject(project) {
    const p = normalizeProject(project);
    const issues = { errors: [], warnings: [] };
    const err = (table, id, field, message) => issues.errors.push({ table, id, field, message });
    const warn = (table, id, field, message) => issues.warnings.push({ table, id, field, message });

    const total = p.ous.length + p.globals.length + p.locals.length + p.permissions.length;
    if (!total) err('domain', null, null, 'Rien à créer : ajoutez au moins une OU, un groupe ou une permission.');
    validateDomain(p.domain, issues, p.permissions.length > 0);

    // --- OU ---------------------------------------------------------------
    const ouPaths = new Map(); // clé du chemin complet → ligne
    for (const row of p.ous) {
      const e = validateName('ou', row.name);
      if (e) err('ous', row.id, 'name', e);
      const parentSegs = ouSegments(row.parent);
      for (const seg of parentSegs) {
        const pe = validateName('ou', seg);
        if (pe) {
          err('ous', row.id, 'parent', `OU parente « ${row.parent} » : ${pe}`);
          break;
        }
      }
      const de = validateName('desc', row.description);
      if (de) err('ous', row.id, 'description', de);
      if (e) continue;
      const key = nameKey(ouFullPath(row));
      if (ouPaths.has(key)) err('ous', row.id, 'name', `L'OU « ${ouFullPath(row)} » est déjà dans le tableau (doublon, casse et accents ignorés).`);
      else ouPaths.set(key, row);
    }
    const ouKnown = (path) => ouPaths.has(nameKey(ouSegments(path).join('/')));
    for (const row of p.ous) {
      const parent = ouSegments(row.parent).join('/');
      if (parent && !ouKnown(parent)) warn('ous', row.id, 'parent', `L'OU parente « ${parent} » n'est pas dans le tableau : elle doit déjà exister dans l'Active Directory.`);
    }

    // --- Groupes ----------------------------------------------------------
    const groups = new Map(); // clé → { scope: 'global' | 'local', row }
    const checkGroupRow = (row, scope, table) => {
      const e = validateName('group', row.name);
      if (e) err(table, row.id, 'name', e);
      else {
        for (const w of nameWarnings('group', row.name)) warn(table, row.id, 'name', w);
        const prefix = scope === 'global' ? PREFIXES.global : PREFIXES.local;
        if (!nameKey(row.name).startsWith(prefix.toLowerCase())) {
          warn(table, row.id, 'name', `Convention de nommage : un groupe ${scope === 'global' ? 'global' : 'domaine local'} commence d'habitude par « ${prefix} » (ex. ${prefix}${scope === 'global' ? 'Compta' : 'Compta_RW'}).`);
        }
        const key = nameKey(row.name);
        if (groups.has(key)) {
          const other = groups.get(key);
          err(table, row.id, 'name', `Le groupe « ${row.name} » existe déjà dans le tableau des groupes ${other.scope === 'global' ? 'globaux' : 'domaine local'} (doublon, casse et accents ignorés).`);
        } else groups.set(key, { scope, row });
      }
      const ouSegs = ouSegments(row.ou);
      let ouError = false;
      for (const seg of ouSegs) {
        const oe = validateName('ou', seg);
        if (oe) {
          err(table, row.id, 'ou', `OU « ${row.ou} » : ${oe}`);
          ouError = true;
          break;
        }
      }
      if (!ouError && ouSegs.length && !ouKnown(row.ou)) {
        warn(table, row.id, 'ou', `L'OU « ${ouSegs.join('/')} » n'est pas dans le tableau des OU : elle doit déjà exister dans l'Active Directory.`);
      }
      const de = validateName('desc', row.description);
      if (de) err(table, row.id, 'description', de);
    };
    for (const row of p.globals) checkGroupRow(row, 'global', 'globals');
    for (const row of p.locals) checkGroupRow(row, 'local', 'locals');
    const scopeOf = (name) => {
      const g = groups.get(nameKey(name));
      return g ? g.scope : null;
    };

    // Membres des groupes globaux : des comptes utilisateurs (A → G).
    const inSomeDl = new Set();
    for (const row of p.globals) {
      for (const m of splitMembers(row.members)) {
        const mk = nameKey(m);
        if (mk === nameKey(row.name)) {
          err('globals', row.id, 'members', `Le groupe « ${row.name} » ne peut pas être membre de lui-même.`);
          continue;
        }
        const scope = scopeOf(m);
        if (scope === 'local') {
          err('globals', row.id, 'members', `« ${m} » est un groupe domaine local : un groupe global ne peut pas contenir de groupe domaine local (règle Active Directory, contraire à AGDLP).`);
          continue;
        }
        if (scope === 'global') {
          warn('globals', row.id, 'members', `« ${m} » est un groupe global imbriqué dans « ${row.name} » : possible dans le même domaine, mais hors du schéma AGDLP strict (les comptes vont dans un GG, les GG dans des DL).`);
          continue;
        }
        const e = validateName('user', m);
        if (e) {
          err('globals', row.id, 'members', e);
          continue;
        }
        if (mk.startsWith(PREFIXES.local.toLowerCase())) {
          warn('globals', row.id, 'members', `« ${m} » ressemble à un groupe domaine local absent du tableau : il sera cherché comme utilisateur, et un groupe global ne peut pas contenir de groupe domaine local.`);
        } else if (mk.startsWith(PREFIXES.global.toLowerCase())) {
          warn('globals', row.id, 'members', `« ${m} » ressemble à un groupe absent du tableau : les membres d'un groupe global sont cherchés comme comptes utilisateurs (dsquery user).`);
        }
      }
    }

    // Membres des groupes domaine local : des groupes globaux (G → DL).
    const dlEdges = new Map(); // DL → DL (détection des boucles)
    for (const row of p.locals) {
      for (const m of splitMembers(row.members)) {
        const mk = nameKey(m);
        if (mk === nameKey(row.name)) {
          err('locals', row.id, 'members', `Le groupe « ${row.name} » ne peut pas être membre de lui-même.`);
          continue;
        }
        const e = validateName('group', m);
        if (e) {
          err('locals', row.id, 'members', e);
          continue;
        }
        const scope = scopeOf(m);
        if (scope === 'global') {
          inSomeDl.add(mk);
        } else if (scope === 'local') {
          warn('locals', row.id, 'members', `« ${m} » est un groupe domaine local imbriqué dans « ${row.name} » : autorisé dans le même domaine, mais hors du schéma AGDLP strict (préférez y mettre des groupes globaux).`);
          if (!dlEdges.has(nameKey(row.name))) dlEdges.set(nameKey(row.name), []);
          dlEdges.get(nameKey(row.name)).push(mk);
        } else {
          warn('locals', row.id, 'members', `« ${m} » n'est pas dans le tableau des groupes globaux : groupe supposé existant dans l'Active Directory (il sera cherché avec dsquery group).`);
        }
      }
    }
    // Imbrication circulaire DL ↔ DL : Active Directory l'accepte, mais elle n'a aucun sens.
    const reported = new Set();
    for (const start of dlEdges.keys()) {
      const stack = [[start, [start]]];
      const seen = new Set();
      while (stack.length) {
        const [node, trail] = stack.pop();
        for (const next of dlEdges.get(node) || []) {
          if (next === start) {
            const cycleKey = trail.slice().sort().join('|');
            if (!reported.has(cycleKey)) {
              reported.add(cycleKey);
              const row = groups.get(start).row;
              warn('locals', row.id, 'members', `Imbrication circulaire : ${trail.map((k) => groups.get(k).row.name).join(' → ')} → ${row.name}.`);
            }
          } else if (!seen.has(next)) {
            seen.add(next);
            stack.push([next, trail.concat(next)]);
          }
        }
      }
    }

    // --- Permissions ------------------------------------------------------
    const permKeys = new Set();
    const dlWithPerm = new Set();
    for (const row of p.permissions) {
      const pe = validateName('path', row.path);
      if (pe) err('permissions', row.id, 'path', pe);
      const ge = validateName('group', row.group);
      if (ge) err('permissions', row.id, 'group', ge);
      else {
        const scope = scopeOf(row.group);
        if (scope === 'global') {
          warn('permissions', row.id, 'group', `« ${row.group} » est un groupe global : en AGDLP, les droits se donnent aux groupes domaine local (mettez ${row.group} dans un DL et donnez le droit au DL).`);
        } else if (scope === 'local') {
          dlWithPerm.add(nameKey(row.group));
        } else {
          warn('permissions', row.id, 'group', `« ${row.group} » n'est pas dans le tableau des groupes domaine local : groupe supposé existant dans l'Active Directory.`);
        }
      }
      if (!RIGHTS[row.right]) err('permissions', row.id, 'right', `Droit « ${row.right} » inconnu : choisissez R (Lecture), RW (Modification) ou F (Contrôle total).`);
      if (!pe && !ge) {
        const k = nameKey(cleanPath(row.path)) + '|' + nameKey(row.group);
        if (permKeys.has(k)) warn('permissions', row.id, 'group', `« ${row.group} » reçoit déjà un droit sur « ${cleanPath(row.path)} » : les droits s'additionnent.`);
        permKeys.add(k);
      }
      if (!pe && RIGHTS[row.right] && row.right === 'F') {
        warn('permissions', row.id, 'right', `Contrôle total sur « ${cleanPath(row.path)} » : le groupe pourra aussi modifier les autorisations du dossier.`);
      }
    }

    // --- Esprit AGDLP -----------------------------------------------------
    for (const row of p.locals) {
      if (validateName('group', row.name)) continue;
      if (!dlWithPerm.has(nameKey(row.name)) && !isNestedDl(p, row.name)) {
        warn('locals', row.id, 'name', `Le groupe domaine local « ${row.name} » ne reçoit aucune permission dans le tableau des permissions.`);
      }
    }
    for (const row of p.globals) {
      if (validateName('group', row.name)) continue;
      if (p.locals.length && !inSomeDl.has(nameKey(row.name)) && !isNestedGg(p, row.name)) {
        warn('globals', row.id, 'name', `Le groupe global « ${row.name} » n'est membre d'aucun groupe domaine local du tableau.`);
      }
      if (!splitMembers(row.members).length) warn('globals', row.id, 'members', `Le groupe global « ${row.name} » n'a aucun membre.`);
    }
    return issues;
  }

  function isNestedDl(p, name) {
    const k = nameKey(name);
    return p.locals.some((r) => splitMembers(r.members).some((m) => nameKey(m) === k));
  }
  function isNestedGg(p, name) {
    const k = nameKey(name);
    return p.globals.some((r) => splitMembers(r.members).some((m) => nameKey(m) === k));
  }

  // ---------------------------------------------------------------------------
  // Plan d'exécution
  // ---------------------------------------------------------------------------

  /** Test d'existence lisible par cmd : code de sortie 0 et une ligne de DN si l'objet existe. */
  function existsCheck(dn) {
    return `dsquery * "${dn}" -scope base 2>nul | findstr "="`;
  }

  /**
   * Ajout d'un membre existant dans l'AD (connu seulement par son sAMAccountName) :
   * 1) dsquery … | findstr "=" vérifie qu'il existe (dsquery renvoie 0 même sans résultat,
   *    findstr renvoie 1 s'il n'a rien trouvé) ; sinon message + code 1 via « cmd /c exit 1 » ;
   * 2) for /f récupère son DN et le passe à dsmod ("%~u" retire puis remet les guillemets,
   *    que dsquery en mette ou non) ; « @ » évite l'écho de la commande.
   * En ligne de commande interactive la variable s'écrit %u ; toBatch() la double (%%u).
   */
  function lookupMemberCommand(type, samid, groupDn) {
    const q = lookupQuery(type, samid);
    const who = /[()]/.test(samid) ? '' : ` : ${samid}`; // une « ) » fermerait le bloc ( … )
    // Parenthèses externes obligatoires : cmd lit « A || (B) && C » comme « A || (B && C) ».
    return `(${q} | findstr "=" >nul || (echo    Introuvable dans l'Active Directory${who}& cmd /c exit 1)) && for /f "delims=" %u in ('${q}') do @dsmod group "${groupDn}" -addmbr "%~u"`;
  }

  /** Recherche (lecture seule) du DN d'un utilisateur ou d'un groupe d'après son sAMAccountName. */
  function lookupQuery(type, samid) {
    return `dsquery ${type === 'group' ? 'group' : 'user'} -samid ${arg(samid)} -limit 1`;
  }

  /**
   * Ajout d'un membre dont le DN est connu. Utilisé par lib/runner.js après avoir fait lui-même la recherche
   * lookupQuery() : le DN trouvé passe alors directement dans la ligne de commande (Unicode), sans le
   * décodage de « for /f », peu fiable pour un DN accentué quand cmd.exe n'a pas de console.
   */
  function addMemberCommand(groupDn, memberDn) {
    return `dsmod group "${groupDn}" -addmbr "${memberDn}"`;
  }

  /**
   * Construit la liste ordonnée des étapes.
   * Ordre : OU (parents d'abord) → groupes globaux → groupes domaine local → appartenances
   * (utilisateurs → GG, GG → DL) → dossiers (option) → droits icacls.
   * Les lignes invalides (voir validateProject) sont ignorées : aucune commande dangereuse n'est produite.
   */
  function plan(project) {
    const p = normalizeProject(project);
    const base = baseDnOf(p.domain);
    const netbios = netbiosOf(p.domain);
    const steps = [];
    let n = 0;
    const add = (step) => {
      n++;
      const full = Object.assign({ id: `${step.kind}-${n}`, needs: [] }, step);
      full.needs = full.needs.filter(Boolean);
      steps.push(full);
      return full.id;
    };
    if (!base || validateDomainQuick(p.domain)) return steps;

    // --- OU (tri stable par profondeur : un parent passe toujours avant ses enfants) ---
    const ouStep = new Map(); // clé de chemin → id d'étape
    const ous = p.ous
      .map((row, index) => ({ row, index, path: ouFullPath(row) }))
      .filter((o) => !validateName('ou', o.row.name) && ouSegments(o.row.parent).every((s) => !validateName('ou', s)) && !validateName('desc', o.row.description))
      .sort((a, b) => ouSegments(a.path).length - ouSegments(b.path).length || a.index - b.index);
    for (const o of ous) {
      const key = nameKey(o.path);
      if (ouStep.has(key)) continue; // doublon
      const dn = ouPathToDn(o.path, base);
      const desc = str(o.row.description);
      const parentKey = nameKey(ouSegments(o.row.parent).join('/'));
      const id = add({
        kind: 'ou',
        table: 'ous',
        rowId: o.row.id,
        label: `Créer l'OU ${o.path}`,
        dn,
        command: `dsadd ou "${dn}"` + (desc ? ` -desc "${desc}"` : ''),
        check: existsCheck(dn),
        needs: [ouStep.get(parentKey)],
      });
      ouStep.set(key, id);
    }
    const ouNeed = (path) => ouStep.get(nameKey(ouSegments(path).join('/')));

    // --- Groupes ---
    const groupInfo = new Map(); // clé → { dn, scope, stepId, name }
    const addGroup = (row, scope, table) => {
      if (validateName('group', row.name) || validateName('desc', row.description)) return;
      if (ouSegments(row.ou).some((s) => validateName('ou', s))) return;
      const key = nameKey(row.name);
      if (groupInfo.has(key)) return;
      const dn = `CN=${escapeRdn(row.name)},${containerDn(row.ou, base)}`;
      const desc = str(row.description);
      const id = add({
        kind: 'group',
        table,
        rowId: row.id,
        label: `Créer le groupe ${scope === 'global' ? 'global' : 'domaine local'} ${row.name}`,
        dn,
        command: `dsadd group "${dn}" -secgrp yes -scope ${scope === 'global' ? 'g' : 'l'} -samid ${arg(row.name)}` + (desc ? ` -desc "${desc}"` : ''),
        check: existsCheck(dn),
        needs: [ouNeed(row.ou)],
      });
      groupInfo.set(key, { dn, scope, stepId: id, name: row.name, rowId: row.id });
    };
    for (const row of p.globals) addGroup(row, 'global', 'globals');
    for (const row of p.locals) addGroup(row, 'local', 'locals');

    // --- Appartenances ---
    const addMembers = (row, table) => {
      const g = groupInfo.get(nameKey(row.name));
      if (!g || g.rowId !== row.id) return; // ligne invalide ou doublon : rien à ajouter
      for (const m of splitMembers(row.members)) {
        const mk = nameKey(m);
        if (mk === nameKey(row.name)) continue;
        const known = groupInfo.get(mk);
        if (known) {
          if (g.scope === 'global' && known.scope === 'local') continue; // interdit (GG ⊄ DL)
          add({
            kind: 'member',
            table,
            rowId: row.id,
            label: `Ajouter ${known.name} dans ${g.name}`,
            dn: g.dn,
            member: { name: known.name, dn: known.dn, lookup: null },
            command: addMemberCommand(g.dn, known.dn),
            check: `dsquery * "${known.dn}" -scope base -filter "(memberOf=${escapeFilter(g.dn)})" 2>nul | findstr "="`,
            needs: [g.stepId, known.stepId],
          });
          continue;
        }
        const type = table === 'globals' ? 'user' : 'group';
        if (validateName(type, m)) continue;
        const cls = type === 'user' ? '(objectCategory=person)(objectClass=user)' : '(objectCategory=group)';
        add({
          kind: 'member',
          table,
          rowId: row.id,
          label: `Ajouter ${m} dans ${g.name}`,
          dn: g.dn,
          member: { name: m, dn: null, lookup: type, query: lookupQuery(type, m) },
          command: lookupMemberCommand(type, m, g.dn),
          check: `dsquery * domainroot -filter "(&${cls}(sAMAccountName=${escapeFilter(m)})(memberOf=${escapeFilter(g.dn)}))" 2>nul | findstr "="`,
          needs: [g.stepId],
        });
      }
    };
    for (const row of p.globals) addMembers(row, 'globals');
    for (const row of p.locals) addMembers(row, 'locals');

    // --- Dossiers et droits ---
    const perms = p.permissions.filter((r) => !validateName('path', r.path) && !validateName('group', r.group) && RIGHTS[r.right]);
    const folderStep = new Map();
    if (p.options.createFolders) {
      for (const r of perms) {
        const path = cleanPath(r.path);
        const key = nameKey(path);
        if (folderStep.has(key)) continue;
        folderStep.set(
          key,
          add({
            kind: 'folder',
            table: 'permissions',
            rowId: r.id,
            label: `Créer le dossier ${path}`,
            dn: null,
            command: `if not exist "${path}" mkdir "${path}"`,
            check: `if exist "${path}\\" (echo "${path}") else (cmd /c exit 1)`,
          })
        );
      }
    }
    for (const r of perms) {
      const path = cleanPath(r.path);
      const right = RIGHTS[r.right];
      const g = groupInfo.get(nameKey(r.group));
      const groupName = g ? g.name : r.group;
      add({
        kind: 'acl',
        table: 'permissions',
        rowId: r.id,
        label: `Donner ${right.label} à ${groupName} sur ${path}`,
        dn: null,
        command: `icacls "${path}" /grant "${netbios}\\${groupName}:${right.icacls}"`,
        check: null,
        needs: [g && g.stepId, folderStep.get(nameKey(path))],
      });
    }
    return steps;
  }

  function validateDomainQuick(domain) {
    const issues = { errors: [], warnings: [] };
    validateDomain(domain, issues, false);
    return issues.errors.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Script .bat
  // ---------------------------------------------------------------------------

  /** Texte sûr pour une ligne « rem » / « echo » (pas de caractères interprétés par cmd). */
  function safeText(s) {
    return str(s).replace(/[\r\n]+/g, ' ').replace(/[%!^&|<>"]/g, '').trim();
  }

  function formatDate(date) {
    if (typeof date === 'string') return safeText(date);
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  /**
   * Script batch complet (fins de ligne CRLF). À enregistrer en UTF-8 sans BOM.
   * Chaque étape : echo [n/N] libellé → test d'existence (étape ignorée si déjà faite) → commande
   * → comptage des échecs. Les tests « if %errorlevel% neq 0 » sont hors de tout bloc ( … ) :
   * pas de piège d'expansion retardée, et les codes négatifs (HRESULT) sont aussi comptés.
   */
  function toBatch(steps, options) {
    const opts = options || {};
    const list = Array.isArray(steps) ? steps : [];
    const total = list.length;
    let domainText = '';
    if (opts.domain && typeof opts.domain === 'object') {
      const dns = safeText(opts.domain.dns);
      const nb = safeText(opts.domain.netbios);
      domainText = dns + (nb ? ` (${nb})` : '');
    } else domainText = safeText(opts.domain);
    const title = safeText(opts.title) || 'Création AGDLP';
    const L = [];
    L.push('@echo off');
    L.push('setlocal');
    // Page de code d'origine de la console (850 en français) : reprise le temps des recherches « for /f »
    L.push('for /f "tokens=2 delims=:." %%c in (\'chcp\') do set /a AGP_CP=%%c');
    L.push('if not defined AGP_CP set AGP_CP=850');
    L.push('chcp 65001 >nul');
    L.push('rem ==========================================================================');
    L.push(`rem  ${title}`);
    L.push(`rem  Généré par Agépédé le ${formatDate(opts.date)}${domainText ? ' - domaine ' + domainText : ''}`);
    L.push('rem  À exécuter en administrateur sur un contrôleur de domaine');
    L.push('rem  ou sur un poste avec les outils RSAT AD DS - dsadd, dsmod, dsquery, icacls.');
    L.push('rem  Fichier enregistré en UTF-8 sans BOM : la ligne chcp 65001 ci-dessus');
    L.push('rem  permet à cmd.exe de lire correctement les accents.');
    L.push('rem  Les objets déjà présents sont détectés et ignorés : le script peut être relancé.');
    L.push('rem  Pas de pause à la fin : le script peut tourner sans surveillance.');
    L.push("rem  Code de sortie = nombre d'étapes en échec - 0 si tout s'est bien passé.");
    L.push('rem ==========================================================================');
    L.push('');
    const usesDs = list.some((s) => ['ou', 'group', 'member'].includes(s.kind));
    const usesAcl = list.some((s) => s.kind === 'acl');
    if (usesDs) L.push("where dsadd >nul 2>&1 || (echo ERREUR : dsadd est introuvable. Lancez ce script sur un contrôleur de domaine ou installez les outils RSAT AD DS.& exit /b 1)");
    if (usesAcl) L.push('where icacls >nul 2>&1 || (echo ERREUR : icacls est introuvable.& exit /b 1)');
    L.push("net session >nul 2>&1 || echo ATTENTION : l'invite de commandes ne semble pas lancée en administrateur.");
    L.push('set /a ERR=0');
    L.push('set /a DEJA=0');
    list.forEach((step, i) => {
      const num = i + 1;
      const end = `:etape_${num}_fin`;
      L.push('');
      L.push(`echo [${num}/${total}] ${safeText(step.label)}`);
      // Dossiers : « if not exist … mkdir » se suffit ; droits : icacls /grant peut être rejoué.
      if (step.check && step.kind !== 'folder') {
        L.push(`${toBatchLine(step.check)} >nul`);
        L.push(`if not errorlevel 1 (set /a DEJA+=1 & echo    Déjà fait : étape ignorée.& goto ${end})`);
      }
      // « if not exist … mkdir » ne touche pas au code d'erreur quand le dossier existe :
      // on le remet à 0 pour ne pas hériter de l'échec de l'étape précédente.
      if (step.kind === 'folder') L.push('cmd /c exit 0');
      if (step.kind === 'member' && step.member && step.member.lookup && step.member.query) {
        // Recherche du membre par « for /f » : cmd.exe décode la sortie de dsquery avec la page de code active
        // au début de la LIGNE. Elle doit être celle d'origine (850 en français, celle des outils ds*), pas UTF-8 :
        // sinon un DN accentué arrive déformé à dsmod. Le DN du groupe et la requête sont donc mis dans des
        // variables tant que le script est en UTF-8, puis les lignes suivantes (ASCII seulement) s'exécutent
        // dans la page d'origine ; le code de retour est gardé avant de revenir en UTF-8.
        const who = /[()]/.test(step.member.name) ? '' : ' : %AGP_M%'; // une « ) » fermerait le bloc ( … )
        L.push(`set "AGP_G=${step.dn}"`);
        L.push(`set "AGP_Q=${step.member.query}"`);
        L.push(`set "AGP_M=${step.member.name}"`);
        L.push('chcp %AGP_CP% >nul');
        L.push(`(%AGP_Q% | findstr "=" >nul || (echo    Introuvable dans l'Active Directory${who}& cmd /c exit 1)) && for /f "delims=" %%u in ('%AGP_Q%') do @dsmod group "%AGP_G%" -addmbr "%%~u"`);
        L.push('set /a AGP_RC=%errorlevel%');
        L.push('chcp 65001 >nul');
        L.push(`if %AGP_RC% neq 0 (set /a ERR+=1 & echo    ECHEC de l'étape ${num}.)`);
      } else {
        L.push(toBatchLine(step.command));
        L.push(`if %errorlevel% neq 0 (set /a ERR+=1 & echo    ECHEC de l'étape ${num}.)`);
      }
      L.push(end);
    });
    L.push('');
    L.push('echo.');
    L.push(`echo Terminé : ${total} étape(s), %DEJA% déjà faite(s), %ERR% en échec.`);
    L.push('exit /b %ERR%');
    return L.join('\r\n') + '\r\n';
  }

  /** Ligne interactive → ligne de fichier .bat : les % (variables de for) sont doublés. */
  function toBatchLine(line) {
    return str(line).replace(/%/g, '%%');
  }

  // ---------------------------------------------------------------------------
  // CSV et collage Excel
  // ---------------------------------------------------------------------------

  function csvCell(v) {
    const s = str(v);
    return /[;"\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Lignes → CSV pour Excel FR : séparateur « ; », CRLF, BOM UTF-8 en tête (accents corrects). */
  function toCsv(rows, columns) {
    const cols = Array.isArray(columns) ? columns : [];
    const lines = [cols.map((c) => csvCell(c.label)).join(';')];
    for (const row of Array.isArray(rows) ? rows : []) lines.push(cols.map((c) => csvCell(row ? row[c.key] : '')).join(';'));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  /** Séparateur le plus fréquent hors guillemets sur la première ligne non vide (« ; » prioritaire). */
  function detectDelimiter(text) {
    const counts = { ';': 0, '\t': 0, ',': 0 };
    let inQuotes = false;
    let seen = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (ch === '\n' || ch === '\r')) {
        if (seen) break;
      } else if (!inQuotes && ch in counts) counts[ch]++;
      if (!/[\s]/.test(ch)) seen = true;
    }
    let best = ';';
    for (const d of [';', '\t', ',']) if (counts[d] > counts[best]) best = d;
    return best;
  }

  /** Analyseur commun : guillemets (seulement en début de cellule), "" échappés, CRLF/LF/CR. */
  function parseDelimited(text, delimiter) {
    const s = str(text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let i = 0;
    let atStart = true;
    let quoted = false;
    const endCell = () => {
      row.push(cell);
      cell = '';
      atStart = true;
      quoted = false;
    };
    const endRow = () => {
      endCell();
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    };
    while (i < s.length) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          quoted = false;
          i++;
          continue;
        }
        cell += ch;
        i++;
        continue;
      }
      if (atStart && ch === '"') {
        quoted = true;
        atStart = false;
        i++;
        continue;
      }
      if (ch === delimiter) {
        endCell();
        i++;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        endRow();
        i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      cell += ch;
      atStart = false;
      i++;
    }
    if (cell !== '' || row.length) endRow();
    return rows;
  }

  /** CSV → tableau de tableaux (séparateur ; , ou tabulation détecté automatiquement). */
  function parseCsv(text) {
    const s = str(text).replace(/^\uFEFF/, '');
    return parseDelimited(s, detectDelimiter(s));
  }

  /** Texte collé depuis Excel (tabulations, cellules multilignes entre guillemets) → tableau de tableaux. */
  function parsePasted(text) {
    const s = str(text).replace(/^\uFEFF/, '');
    if (!s.includes('\t') && s.includes(';')) return parseDelimited(s, ';');
    return parseDelimited(s, '\t');
  }

  function headerAliases(col) {
    const label = nameKey(col.label);
    return new Set([label, nameKey(col.key), label.replace(/\s*\(.*\)\s*$/, '').trim()]);
  }

  /** Tableau de tableaux importé → lignes { id, … } du tableau donné (en-tête ignoré s'il est reconnu). */
  function rowsFromTable(table, arrays) {
    const cols = COLUMNS[table];
    if (!cols) return [];
    let data = Array.isArray(arrays) ? arrays.filter(Array.isArray) : [];
    if (data.length) {
      const aliases = cols.map(headerAliases);
      const first = data[0].map((c) => nameKey(c));
      const nonEmpty = first.filter(Boolean);
      const isHeader = nonEmpty.length > 0 && nonEmpty.every((cell) => aliases.some((set) => set.has(cell)));
      if (isHeader) data = data.slice(1);
    }
    const out = [];
    for (const arr of data) {
      const cells = cols.map((_, i) => str(arr[i]).trim());
      if (cells.every((c) => !c)) continue;
      const row = { id: newId() };
      cols.forEach((c, i) => {
        row[c.key] = cells[i];
      });
      if (table === 'permissions') row.right = normalizeRight(row.right) || row.right.toUpperCase();
      if (table === 'globals' || table === 'locals') row.members = splitMembers(row.members).join(', ');
      if (table === 'ous') row.parent = ouSegments(row.parent).join('/');
      out.push(row);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Projet
  // ---------------------------------------------------------------------------

  function emptyProject() {
    return {
      version: 1,
      domain: { dns: '', dn: '', netbios: '' },
      options: { createFolders: false },
      ous: [],
      globals: [],
      locals: [],
      permissions: [],
    };
  }

  const ROW_FIELDS = {
    ous: ['name', 'parent', 'description'],
    globals: ['name', 'ou', 'description', 'members'],
    locals: ['name', 'ou', 'description', 'members'],
    permissions: ['path', 'group', 'right'],
  };

  /** Complète et nettoie un projet chargé (JSON) ; ne lève jamais d'exception. */
  function normalizeProject(obj) {
    let src = obj;
    if (typeof src === 'string') {
      try {
        src = JSON.parse(src.replace(/^\uFEFF/, ''));
      } catch (e) {
        src = null;
      }
    }
    const p = emptyProject();
    if (!src || typeof src !== 'object' || Array.isArray(src)) return p;
    const d = src.domain && typeof src.domain === 'object' ? src.domain : {};
    p.domain = { dns: str(d.dns).trim(), dn: str(d.dn).trim(), netbios: str(d.netbios).trim() };
    const o = src.options && typeof src.options === 'object' ? src.options : {};
    p.options = { createFolders: o.createFolders === true || o.createFolders === 'true' || o.createFolders === 1 };
    const ids = new Set();
    for (const table of TABLES) {
      const rows = Array.isArray(src[table]) ? src[table] : [];
      for (const r of rows) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
        let id = str(r.id).trim();
        if (!id || ids.has(id)) id = newId();
        ids.add(id);
        const row = { id };
        for (const f of ROW_FIELDS[table]) {
          let v = r[f];
          if (f === 'members' && Array.isArray(v)) v = v.map(str).filter(Boolean).join(', ');
          row[f] = str(v);
        }
        if (table === 'permissions') row.right = normalizeRight(row.right) || row.right.trim().toUpperCase();
        p[table].push(row);
      }
    }
    return p;
  }

  // ---------------------------------------------------------------------------
  // Classement des résultats
  // ---------------------------------------------------------------------------

  // Codes HRESULT (0x8007xxxx = erreur Win32 xxxx) — voir docs/COMMANDES.md.
  const EXISTS_CODES = {
    '80071392': 'objet déjà existant (ERROR_OBJECT_ALREADY_EXISTS)',
    '80072071': 'nom déjà utilisé dans ce conteneur (ERROR_DS_OBJ_STRING_NAME_EXISTS)',
    '80070562': 'déjà membre du groupe (ERROR_MEMBER_IN_ALIAS)',
    '80070528': 'déjà membre du groupe (ERROR_MEMBER_IN_GROUP)',
    '8007200d': 'valeur déjà présente (ERROR_DS_ATTRIBUTE_OR_VALUE_EXISTS)',
  };
  const ERROR_CODES = {
    '80070524': 'Un compte portant ce nom (sAMAccountName) existe déjà ailleurs dans le domaine.',
    '80070526': 'Un groupe portant ce nom (sAMAccountName) existe déjà ailleurs dans le domaine.',
    '80070563': 'Un groupe portant ce nom (sAMAccountName) existe déjà ailleurs dans le domaine.',
    '80072030': "Objet introuvable dans l'annuaire : vérifiez que l'OU parente, le groupe ou le membre existe.",
    '80070525': 'Compte utilisateur introuvable.',
    '80070527': 'Groupe introuvable.',
    '8007056b': "Le membre à ajouter n'existe pas.",
    '80072032': 'Nom distinctif (DN) mal formé.',
    '80072035': 'Le serveur refuse la demande (opération non autorisée sur cet objet).',
    '8007202f': "Violation de contrainte de l'annuaire (nom trop long ou valeur refusée).",
    '80072098': "Droits insuffisants dans l'Active Directory : utilisez un compte administrateur du domaine.",
    '80070005': "Accès refusé : lancez l'application en administrateur.",
    '8007203a': "Contrôleur de domaine injoignable (le serveur n'est pas opérationnel).",
    '8007054b': 'Domaine introuvable ou injoignable.',
    '8007202b': "Renvoi vers un autre serveur : l'objet est dans un autre domaine.",
    '80072144': 'Un groupe global ne peut pas contenir de groupe domaine local (règle AGDLP / Active Directory).',
    '80072145': 'Un groupe global ne peut pas contenir de groupe universel.',
    '80072147': "Un groupe global ne peut contenir que des comptes de son propre domaine.",
    '80072148': "Un groupe domaine local ne peut pas contenir de groupe domaine local d'un autre domaine.",
    '80070534': "Aucun mappage entre noms de comptes et SID : le groupe est inconnu (vérifiez le nom NetBIOS et que le groupe existe).",
    '80070002': 'Fichier ou dossier introuvable.',
    '80070003': 'Chemin introuvable.',
    '80070057': 'Paramètre incorrect.',
  };
  /** Codes de sortie Win32 « nus » (icacls, cmd) ramenés à leur HRESULT. */
  const WIN32_EXIT = { 2: '80070002', 3: '80070003', 5: '80070005', 87: '80070057', 1332: '80070534', 1378: '80070562', 1320: '80070528' };

  function hex8(n) {
    return (Number(n) >>> 0).toString(16).padStart(8, '0');
  }

  /** Premières lignes utiles d'une sortie, pour le journal. */
  function excerpt(output) {
    const lines = str(output)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^(type\s+\S+\s+\/\?|tapez\s+\S+\s+\/\?)/i.test(l));
    const s = lines.slice(0, 2).join(' — ');
    return s.length > 300 ? s.slice(0, 297) + '…' : s;
  }

  /**
   * Classe le résultat d'une commande : { status: 'ok' | 'exists' | 'error', message, code }.
   * Priorité au code de sortie et aux codes hexadécimaux (les messages sont traduits sur un
   * serveur français) ; les phrases anglaises / françaises ne servent qu'en dernier recours.
   */
  function classifyResult(result) {
    const r = result || {};
    const kind = r.kind || '';
    const output = str(r.output);
    const exitCode = r.exitCode === undefined || r.exitCode === null ? null : Number(r.exitCode);
    if (exitCode === null && !output) return { status: 'error', message: "La commande n'a pas pu être lancée.", code: null };
    // Code 0 = succès, sauf si un outil ds* annonce lui-même son échec (« dsadd failed: » /
    // « dsadd a échoué : ») — ne pas chercher « failed » seul : icacls affiche
    // « Failed processing 0 files » quand tout va bien.
    const dsFailed = /^\s*(dsadd|dsmod|dsquery|dsget)\s*(failed|a\s+échoué|a\s+echoue|:\s*échec)/im.test(output);
    if (exitCode === 0 && !dsFailed) {
      return { status: 'ok', message: kind === 'member' ? 'Membre ajouté.' : kind === 'acl' ? 'Droit appliqué.' : kind === 'folder' ? 'Dossier prêt.' : 'Créé.', code: null };
    }
    const codes = [];
    if (exitCode !== null && exitCode !== 0 && !isNaN(exitCode)) {
      const h = hex8(exitCode);
      if (h.startsWith('8')) codes.push(h);
      else if (WIN32_EXIT[exitCode]) codes.push(WIN32_EXIT[exitCode]);
    }
    for (const m of output.matchAll(/0x([0-9a-f]{8})\b/gi)) codes.push(m[1].toLowerCase());
    for (const m of output.matchAll(/(?:^|[^0-9a-z_])(8007[0-9a-f]{4})(?![0-9a-z_])/gi)) codes.push(m[1].toLowerCase());

    for (const c of codes) {
      if (EXISTS_CODES[c]) {
        const member = kind === 'member' || c === '80070562' || c === '80070528' || c === '8007200d';
        return { status: 'exists', message: member ? 'Déjà membre du groupe.' : "Existe déjà dans l'Active Directory.", code: '0x' + c };
      }
    }
    for (const c of codes) {
      if (ERROR_CODES[c]) return { status: 'error', message: ERROR_CODES[c] + (excerpt(output) ? ` (${excerpt(output)})` : ''), code: '0x' + c };
    }
    if (exitCode === 9009) return { status: 'error', message: "Commande introuvable : les outils Active Directory (RSAT) ne sont pas installés.", code: null };
    // Dernier recours : textes anglais / français connus.
    if (/already a member|déjà membre|deja membre/i.test(output)) return { status: 'exists', message: 'Déjà membre du groupe.', code: null };
    if (/already exists|existe déjà|existe deja|already in use|déjà utilisé/i.test(output)) {
      return { status: 'exists', message: kind === 'member' ? 'Déjà membre du groupe.' : "Existe déjà dans l'Active Directory.", code: null };
    }
    const code = codes.length ? '0x' + codes[0] : exitCode ? '0x' + hex8(exitCode) : null;
    const ex = excerpt(output);
    return { status: 'error', message: `Échec${exitCode ? ` (code ${exitCode})` : ''}${ex ? ' : ' + ex : '.'}`, code };
  }

  return {
    PREFIXES,
    RIGHTS,
    COLUMNS,
    LIMITS,
    domainToDn,
    dnToDomain,
    splitDn,
    escapeRdn,
    escapeFilter,
    ouPathToDn,
    containerDn,
    ouFullPath,
    baseDnOf,
    netbiosOf,
    splitMembers,
    normalizeRight,
    nameKey,
    validateName,
    nameWarnings,
    validateProject,
    plan,
    lookupQuery,
    addMemberCommand,
    toBatch,
    toBatchLine,
    toCsv,
    parseCsv,
    parsePasted,
    rowsFromTable,
    newId,
    emptyProject,
    normalizeProject,
    classifyResult,
    cleanPath,
  };
});
