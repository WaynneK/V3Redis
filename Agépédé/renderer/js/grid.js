/*
 * grid.js — Tableau de saisie d'Agépédé (une instance par onglet : OU, GG, DL, permissions).
 *
 * - chaque ligne est une suite de champs ; le tableau modifie directement le tableau de lignes du projet ;
 * - une ligne vide est toujours présente en bas : dès qu'on y tape, elle devient une vraie ligne ;
 * - Entrée / Maj+Entrée : ligne suivante / précédente (même colonne), Tab : cellule suivante,
 *   Ctrl+Suppr : supprimer la ligne ; ↑ / ↓ hors listes de suggestions ;
 * - coller un bloc copié depuis Excel (plusieurs lignes / colonnes séparées par des tabulations) remplit le
 *   tableau à partir de la cellule active (Agdlp.parsePasted) ;
 * - surlignage des erreurs / avertissements par cellule, avec le message en info-bulle.
 */
'use strict';

(() => {
  const norm = (s) =>
    String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

  class Grid {
    /**
     * opts : {
     *   table: 'ous' | 'globals' | 'locals' | 'permissions',
     *   el: conteneur,
     *   columns: [{ key, label, type: 'text'|'select', options: [{ value, label }], list: id de datalist,
     *               multi: true (liste séparée par des virgules), placeholder, width, coerce(value) }],
     *   getRows: () => tableau de lignes (référence vivante du projet),
     *   newRow: () => nouvelle ligne avec un id,
     *   onChange: (reason) => void, // 'edit' | 'add' | 'delete' | 'paste'
     *   onDelete: (row, index) => void,
     *   onPasted: (count) => void,
     *   multiOptions: (column) => string[] // suggestions des colonnes « multi »
     * }
     */
    constructor(opts) {
      this.o = opts;
      this.table = opts.table;
      this.columns = opts.columns;
      this.el = opts.el;
      this.build();
    }

    rows() {
      return this.o.getRows();
    }

    build() {
      this.el.textContent = '';
      const table = document.createElement('table');
      table.className = 'grid';
      table.dataset.table = this.table;
      const colgroup = document.createElement('colgroup');
      const addCol = (w) => {
        const c = document.createElement('col');
        if (w) c.style.width = w;
        colgroup.appendChild(c);
      };
      addCol('42px');
      for (const col of this.columns) addCol(col.width || '');
      addCol('34px');
      table.appendChild(colgroup);

      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      const th0 = document.createElement('th');
      th0.className = 'num';
      th0.textContent = 'N°';
      tr.appendChild(th0);
      for (const col of this.columns) {
        const th = document.createElement('th');
        th.textContent = col.label;
        if (col.help) th.title = col.help;
        tr.appendChild(th);
      }
      const thx = document.createElement('th');
      thx.className = 'act';
      tr.appendChild(thx);
      thead.appendChild(tr);
      table.appendChild(thead);

      this.tbody = document.createElement('tbody');
      table.appendChild(this.tbody);
      this.el.appendChild(table);

      this.foot = document.createElement('div');
      this.foot.className = 'grid-foot';
      this.el.appendChild(this.foot);

      this.tbody.addEventListener('input', (e) => this.onInput(e));
      this.tbody.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT') this.onInput(e);
      });
      this.tbody.addEventListener('keydown', (e) => this.onKeyDown(e));
      this.tbody.addEventListener('paste', (e) => this.onPaste(e));
      this.tbody.addEventListener('focusin', (e) => this.onFocusIn(e));
      this.tbody.addEventListener('focusout', (e) => this.onFocusOut(e));
      this.tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.row-del');
        if (btn) this.deleteRow(btn.closest('tr').dataset.rowId);
      });
      this.render();
    }

    // ------------------------------------------------------------------ rendu

    makeCell(col, row) {
      const td = document.createElement('td');
      td.dataset.field = col.key;
      let input;
      if (col.type === 'select') {
        input = document.createElement('select');
        for (const opt of col.options) {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          input.appendChild(o);
        }
        const value = row ? row[col.key] : col.defaultValue;
        if (value != null && value !== '' && !col.options.some((o) => o.value === value)) {
          // Valeur inconnue (fichier importé) : affichée telle quelle, signalée par la vérification
          const o = document.createElement('option');
          o.value = value;
          o.textContent = `⚠ ${value}`;
          input.appendChild(o);
        }
        input.value = value == null ? '' : value;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        if (col.list) input.setAttribute('list', col.multi ? 'dl-multi' : col.list);
        input.value = row && row[col.key] != null ? String(row[col.key]) : '';
        if (!row && col.placeholder) input.placeholder = col.placeholder;
      }
      input.className = 'cell';
      input.dataset.field = col.key;
      input.setAttribute('aria-label', col.label);
      td.appendChild(input);
      return td;
    }

    makeRow(row, index) {
      const tr = document.createElement('tr');
      const num = document.createElement('td');
      num.className = 'num';
      tr.appendChild(num);
      for (const col of this.columns) tr.appendChild(this.makeCell(col, row));
      const act = document.createElement('td');
      act.className = 'act';
      tr.appendChild(act);
      if (row) this.setRealRow(tr, row, index);
      else {
        tr.className = 'ghost';
        num.textContent = '+';
        num.title = 'Nouvelle ligne : tapez ou collez ici';
      }
      return tr;
    }

    setRealRow(tr, row, index) {
      tr.classList.remove('ghost');
      tr.dataset.rowId = row.id;
      const num = tr.firstChild;
      num.textContent = String(index + 1);
      num.title = '';
      const act = tr.lastChild;
      if (!act.firstChild) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'row-del';
        del.tabIndex = -1;
        del.title = 'Supprimer la ligne (Ctrl+Suppr)';
        del.setAttribute('aria-label', 'Supprimer la ligne');
        del.textContent = '×';
        act.appendChild(del);
      }
      for (const ph of tr.querySelectorAll('input[placeholder]')) ph.removeAttribute('placeholder');
    }

    render() {
      const active = document.activeElement;
      let restore = null;
      if (active && this.tbody.contains(active)) {
        const tr = active.closest('tr');
        restore = { rowId: tr.dataset.rowId || null, ghost: tr.classList.contains('ghost'), field: active.dataset.field };
      }
      const frag = document.createDocumentFragment();
      this.rows().forEach((row, i) => frag.appendChild(this.makeRow(row, i)));
      frag.appendChild(this.makeRow(null));
      this.tbody.textContent = '';
      this.tbody.appendChild(frag);
      this.updateFoot();
      if (restore) {
        const tr = restore.rowId ? this.trOf(restore.rowId) : this.tbody.lastChild;
        const input = tr && tr.querySelector(`[data-field="${restore.field}"]`);
        if (input) input.focus();
      }
      if (this.lastIssues) this.applyIssues(this.lastIssues);
    }

    updateFoot() {
      const n = this.rows().length;
      this.foot.textContent = n
        ? `${n} ligne${n > 1 ? 's' : ''} · Entrée : ligne suivante · Ctrl+Suppr : supprimer la ligne · collez un bloc copié depuis Excel pour remplir plusieurs lignes`
        : 'Tapez dans la ligne vide ou collez un bloc copié depuis Excel (colonnes dans l\'ordre du tableau).';
    }

    trOf(rowId) {
      return this.tbody.querySelector(`tr[data-row-id="${cssEscape(rowId)}"]`);
    }

    renumber() {
      let i = 0;
      for (const tr of this.tbody.children) {
        if (tr.classList.contains('ghost')) continue;
        tr.firstChild.textContent = String(++i);
      }
      this.updateFoot();
    }

    // ------------------------------------------------------------------ saisie

    rowById(id) {
      return this.rows().find((r) => r.id === id) || null;
    }

    /** La ligne vide du bas devient une vraie ligne ; une nouvelle ligne vide est ajoutée dessous. */
    materialize(tr) {
      const row = this.o.newRow();
      for (const input of tr.querySelectorAll('[data-field]')) {
        if (input.tagName === 'TD') continue;
        const col = this.columns.find((c) => c.key === input.dataset.field);
        if (col) row[col.key] = input.value;
      }
      this.rows().push(row);
      this.setRealRow(tr, row, this.rows().length - 1);
      this.tbody.appendChild(this.makeRow(null));
      this.updateFoot();
      return row;
    }

    onInput(e) {
      const input = e.target;
      if (!input.classList.contains('cell')) return;
      const tr = input.closest('tr');
      const field = input.dataset.field;
      if (tr.classList.contains('ghost')) {
        this.materialize(tr);
        this.o.onChange('add');
      } else {
        const row = this.rowById(tr.dataset.rowId);
        if (!row) return;
        row[field] = input.value;
        this.o.onChange('edit');
      }
      const col = this.columns.find((c) => c.key === field);
      if (col && col.multi) this.fillMultiList(input, col);
    }

    onFocusIn(e) {
      const input = e.target;
      if (!input.classList || !input.classList.contains('cell')) return;
      const col = this.columns.find((c) => c.key === input.dataset.field);
      if (col && col.multi) this.fillMultiList(input, col);
    }

    /** Une ligne entièrement vide que l'on quitte est retirée (sauf la ligne vide du bas). */
    onFocusOut(e) {
      const tr = e.target.closest && e.target.closest('tr');
      if (!tr || tr.classList.contains('ghost') || !tr.dataset.rowId) return;
      if (e.relatedTarget && tr.contains(e.relatedTarget)) return;
      const row = this.rowById(tr.dataset.rowId);
      if (!row || !this.isBlank(row)) return;
      const rows = this.rows();
      const index = rows.indexOf(row);
      if (index < 0) return;
      rows.splice(index, 1);
      tr.remove();
      this.renumber();
      this.o.onChange('delete');
    }

    isBlank(row) {
      return this.columns.every((c) => c.type === 'select' || String(row[c.key] == null ? '' : row[c.key]).trim() === '');
    }

    /**
     * Suggestions d'une colonne « liste séparée par des virgules » : la liste de suggestions reprend le début
     * déjà saisi, pour que le choix d'un nom complète la liste au lieu de la remplacer.
     */
    fillMultiList(input, col) {
      const dl = document.getElementById('dl-multi');
      if (!dl) return;
      const value = input.value;
      const cut = value.lastIndexOf(',');
      const prefix = cut >= 0 ? `${value.slice(0, cut + 1).replace(/\s*$/, '')} ` : '';
      const already = new Set(
        value
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
      const names = (this.o.multiOptions ? this.o.multiOptions(col) : []).filter((n) => !already.has(n.toLowerCase()));
      dl.textContent = '';
      for (const n of names.slice(0, 500)) {
        const o = document.createElement('option');
        o.value = prefix + n;
        dl.appendChild(o);
      }
    }

    focusCell(tr, field) {
      if (!tr) return false;
      const input = tr.querySelector(`.cell[data-field="${field}"]`);
      if (!input) return false;
      input.focus();
      if (input.select && input.tagName === 'INPUT') input.select();
      return true;
    }

    onKeyDown(e) {
      const input = e.target;
      if (!input.classList.contains('cell')) return;
      const tr = input.closest('tr');
      const field = input.dataset.field;
      if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const target = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
        this.focusCell(target, field);
        return;
      }
      const hasList = input.hasAttribute('list') || input.tagName === 'SELECT';
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!hasList || e.ctrlKey)) {
        e.preventDefault();
        this.focusCell(e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling, field);
        return;
      }
      if (e.key === 'Delete' && e.ctrlKey && tr.dataset.rowId) {
        e.preventDefault();
        const next = tr.nextElementSibling;
        const nextId = next && next.dataset.rowId;
        this.deleteRow(tr.dataset.rowId);
        this.focusCell(nextId ? this.trOf(nextId) : this.tbody.lastChild, field);
      }
    }

    // ------------------------------------------------------------------ lignes

    addRow() {
      const ghost = this.tbody.lastChild;
      this.focusCell(ghost, this.columns[0].key);
      ghost.scrollIntoView({ block: 'nearest' });
    }

    deleteRow(rowId) {
      const rows = this.rows();
      const index = rows.findIndex((r) => r.id === rowId);
      if (index < 0) return;
      const [row] = rows.splice(index, 1);
      const tr = this.trOf(rowId);
      if (tr) tr.remove();
      this.renumber();
      this.o.onChange('delete');
      if (this.o.onDelete && !this.isBlank(row)) this.o.onDelete(row, index);
    }

    // ------------------------------------------------------------------ coller depuis Excel

    coerce(col, value) {
      const v = String(value == null ? '' : value).trim();
      return col.coerce ? col.coerce(v) : v;
    }

    onPaste(e) {
      const input = e.target.closest ? e.target.closest('.cell') : null;
      if (!input) return;
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      const trimmed = text.replace(/[\r\n]+$/, '');
      const col0 = this.columns.findIndex((c) => c.key === input.dataset.field);
      if (!/[\t\r\n]/.test(trimmed)) {
        // Valeur simple : collage normal (sauf liste déroulante, remplie avec la valeur reconnue)
        if (input.tagName === 'SELECT' && trimmed) {
          e.preventDefault();
          const v = this.coerce(this.columns[col0], trimmed);
          if ([...input.options].some((o) => o.value === v)) {
            input.value = v;
            this.onInput({ target: input });
          }
        }
        return;
      }
      e.preventDefault();
      let matrix;
      try {
        matrix = Agdlp.parsePasted(text);
      } catch {
        matrix = null;
      }
      if (matrix && !Array.isArray(matrix) && Array.isArray(matrix.rows)) matrix = matrix.rows;
      if (!Array.isArray(matrix)) {
        matrix = trimmed.split(/\r?\n/).map((line) => line.split('\t'));
      }
      matrix = matrix.filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? '' : c).trim() !== ''));
      if (!matrix.length) return;

      // Ligne d'en-têtes copiée avec le bloc : ignorée si elle reprend les noms des colonnes
      const first = matrix[0];
      const headerHits = first.filter((cell, c) => {
        const col = this.columns[col0 + c];
        if (!col) return false;
        const n = norm(cell);
        return n && (n === norm(col.label) || n === norm(col.key) || (col.aliases || []).some((a) => norm(a) === n));
      }).length;
      if (headerHits > 0 && headerHits >= Math.ceil(Math.min(first.length, this.columns.length - col0) / 2)) matrix = matrix.slice(1);
      if (!matrix.length) return;

      const tr = input.closest('tr');
      const rows = this.rows();
      let start = tr.classList.contains('ghost') ? rows.length : rows.findIndex((r) => r.id === tr.dataset.rowId);
      if (start < 0) start = rows.length;
      for (let r = 0; r < matrix.length; r += 1) {
        let row = rows[start + r];
        if (!row) {
          row = this.o.newRow();
          rows.push(row);
        }
        matrix[r].forEach((value, c) => {
          const col = this.columns[col0 + c];
          if (col) row[col.key] = this.coerce(col, value);
        });
      }
      const focusId = rows[start] && rows[start].id;
      this.render();
      this.focusCell(focusId ? this.trOf(focusId) : null, input.dataset.field);
      this.o.onChange('paste');
      if (this.o.onPasted) this.o.onPasted(matrix.length);
    }

    // ------------------------------------------------------------------ vérification

    /**
     * issues : [{ level: 'error'|'warning', id, field, message }] pour ce tableau.
     * Les cellules concernées sont surlignées, le message est en info-bulle.
     */
    applyIssues(issues) {
      this.lastIssues = issues;
      for (const el of this.tbody.querySelectorAll('.has-error, .has-warning, .row-error, .row-warning')) {
        el.classList.remove('has-error', 'has-warning', 'row-error', 'row-warning');
        if (el.tagName === 'TD') el.removeAttribute('title');
        else if (el.firstChild) el.firstChild.removeAttribute('title');
      }
      const byCell = new Map();
      for (const it of issues) {
        if (it.id == null) continue;
        const tr = this.trOf(it.id);
        if (!tr) continue;
        let target = it.field ? tr.querySelector(`td[data-field="${cssEscape(it.field)}"]`) : null;
        if (!target) target = tr.firstChild; // erreur de ligne : signalée sur le numéro
        const entry = byCell.get(target) || { tr, level: 'warning', messages: [] };
        if (it.level === 'error') entry.level = 'error';
        entry.messages.push(it.message);
        byCell.set(target, entry);
      }
      for (const [td, entry] of byCell) {
        const msg = entry.messages.join('\n');
        if (td === entry.tr.firstChild) {
          entry.tr.classList.add(entry.level === 'error' ? 'row-error' : 'row-warning');
          td.title = msg;
        } else {
          td.classList.add(entry.level === 'error' ? 'has-error' : 'has-warning');
          td.title = msg;
          if (!entry.tr.classList.contains('row-error')) entry.tr.classList.add(entry.level === 'error' ? 'row-error' : 'row-warning');
          if (entry.level === 'error') entry.tr.classList.remove('row-warning');
        }
      }
    }

    /** Va à une cellule (depuis la liste de vérification) et la fait clignoter. */
    reveal(rowId, field) {
      const tr = this.trOf(rowId);
      if (!tr) return false;
      const col = this.columns.some((c) => c.key === field) ? field : this.columns[0].key;
      const td = tr.querySelector(`td[data-field="${cssEscape(col)}"]`);
      td.scrollIntoView({ block: 'center' });
      this.focusCell(tr, col);
      td.classList.remove('flash');
      void td.offsetWidth; // relance l'animation
      td.classList.add('flash');
      setTimeout(() => td.classList.remove('flash'), 1700);
      return true;
    }
  }

  window.Grid = Grid;
})();
