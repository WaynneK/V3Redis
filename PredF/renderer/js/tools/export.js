/*
 * PDF → Images / Texte — chaque page en image PNG ou JPEG (résolution au choix), ou le texte du PDF
 * dans un fichier .txt.
 */

import { api, h, segmented, plural, baseName, check, showResult, busy, toast, button, fmt } from '../core.js';
import { dropZone, docHeader, actionBar, optionGroup, pagesField } from '../components.js';
import { renderToImage, pageText, forget } from '../pdfview.js';

export function create() {
  const state = { file: null, mode: 'images', format: 'png', quality: 0.85, dpi: 150, pages: '' };
  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);

  function open(files) {
    const f = files.find((x) => x.kind === 'pdf');
    if (!f) return;
    if (state.file) {
      api.release([state.file.id]);
      forget(state.file.id);
    }
    state.file = f;
    state.pages = '';
    result.replaceChildren();
    render();
  }

  function close() {
    api.release([state.file.id]);
    forget(state.file.id);
    state.file = null;
    result.replaceChildren();
    render();
  }

  let field = null;
  let bar = null;
  let runBtn = null;
  let sizeNote = null;

  function selectedPages() {
    return field && field.state.pages ? field.state.pages : null;
  }

  function update() {
    const pages = selectedPages();
    const fp = state.file.info && state.file.info.firstPage;
    if (sizeNote && fp) {
      const w = Math.round((fp.width * state.dpi) / 72);
      const hh = Math.round((fp.height * state.dpi) / 72);
      sizeNote.textContent = `Page 1 : ${fmt(w)} × ${fmt(hh)} pixels`;
    }
    if (!bar) return;
    const n = pages ? pages.length : 0;
    bar.querySelector('.action-summary').textContent = pages ? (state.mode === 'images' ? `${plural(n, 'image')} ${state.format.toUpperCase()} à ${state.dpi} ppp` : `Texte de ${plural(n, 'page')}`) : 'Pages à corriger';
    runBtn.disabled = !pages || !n;
    runBtn.querySelector('span').textContent = state.mode === 'images' ? `Exporter ${plural(n, 'image')}` : 'Extraire le texte';
  }

  function render() {
    if (!state.file) {
      field = null;
      bar = null;
      body.replaceChildren(dropZone({ kind: 'pdf', title: 'Déposez le PDF à convertir', hint: 'ou cliquez pour le choisir — ses pages deviendront des images, ou son texte un fichier .txt', onFiles: open }));
      return;
    }
    field = pagesField({
      value: state.pages,
      count: () => state.file.pageCount,
      onChange: () => {
        state.pages = field.input.value;
        update();
      },
    });
    sizeNote = h('span', { class: 'field-note' });
    const imageOptions = h(
      'div',
      { class: 'options-row' },
      optionGroup(
        'Format',
        segmented(
          [
            ['png', 'PNG', 'Sans perte, idéal pour le texte et les schémas'],
            ['jpeg', 'JPEG', 'Plus léger, idéal pour les photos'],
          ],
          state.format,
          (v) => {
            state.format = v;
            qualityGroup.hidden = v !== 'jpeg';
            update();
          },
          { compact: true }
        ).el
      ),
      optionGroup(
        'Résolution',
        segmented(
          [
            [72, 'Écran · 72', '72 points par pouce'],
            [150, 'Standard · 150', '150 points par pouce'],
            [300, 'Impression · 300', '300 points par pouce'],
          ],
          state.dpi,
          (v) => {
            state.dpi = v;
            update();
          },
          { compact: true }
        ).el,
        sizeNote
      )
    );
    const qualityGroup = optionGroup(
      'Qualité JPEG',
      segmented(
        [
          [0.7, 'Légère'],
          [0.85, 'Bonne'],
          [0.95, 'Maximale'],
        ],
        state.quality,
        (v) => (state.quality = v),
        { compact: true }
      ).el
    );
    qualityGroup.hidden = state.format !== 'jpeg';
    imageOptions.append(qualityGroup);
    const textNote = h('p', { class: 'hint' }, 'Le texte est extrait tel qu\'il est enregistré dans le PDF. Les pages scannées (images) n\'en contiennent pas : PredF ne fait pas de reconnaissance de caractères.');
    const modeHolder = h('div', null, state.mode === 'images' ? imageOptions : textNote);
    runBtn = h('button', { type: 'button', class: 'btn primary' }, h('span', null, 'Exporter'));
    runBtn.addEventListener('click', () => (state.mode === 'images' ? exportImages() : extractText()));
    bar = actionBar('', runBtn);
    body.replaceChildren(
      docHeader(state.file, { onChange: open, onClose: close }),
      h(
        'div',
        { class: 'panel' },
        optionGroup(
          'Convertir en',
          segmented(
            [
              ['images', 'Images'],
              ['text', 'Texte (.txt)'],
            ],
            state.mode,
            (v) => {
              state.mode = v;
              modeHolder.replaceChildren(v === 'images' ? imageOptions : textNote);
              result.replaceChildren();
              update();
            }
          ).el
        ),
        field.el,
        modeHolder
      ),
      bar
    );
    update();
  }

  async function exportImages() {
    const pages = selectedPages();
    if (!pages || !pages.length) return;
    const file = state.file;
    const dir = await api.chooseExportDir(file.id);
    if (!check(dir)) return;
    const ext = state.format === 'png' ? 'png' : 'jpg';
    const type = state.format === 'png' ? 'image/png' : 'image/jpeg';
    const width = String(file.pageCount).length;
    busy.start('Export des images…', { cancellable: true });
    let written = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        if (busy.canceled) break;
        busy.progress(i, pages.length, `Page ${pages[i] + 1}…`);
        const img = await renderToImage(file.id, pages[i], { dpi: state.dpi, type, quality: state.quality });
        const res = await api.writeExport(dir.token, `${baseName(file.name)}_page-${String(pages[i] + 1).padStart(width, '0')}.${ext}`, img.bytes);
        if (!check(res)) break;
        written++;
      }
    } catch (err) {
      toast(`Export interrompu : ${err.message}`, 'error');
    } finally {
      busy.end();
    }
    if (written) showResult(result, { ok: true }, { title: `${plural(written, 'image enregistrée', 'images enregistrées')}${written < pages.length ? ` sur ${fmt(pages.length)}` : ''}`, folder: dir.dir });
  }

  async function extractText() {
    const pages = selectedPages();
    if (!pages || !pages.length) return;
    const file = state.file;
    busy.start('Extraction du texte…', { cancellable: true });
    const parts = [];
    let chars = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        if (busy.canceled) return;
        busy.progress(i, pages.length);
        const text = await pageText(file.id, pages[i]);
        chars += text.length;
        parts.push(`===== Page ${pages[i] + 1} =====\n\n${text}`);
      }
    } catch (err) {
      toast(`Extraction impossible : ${err.message}`, 'error');
      return;
    } finally {
      busy.end();
    }
    const full = parts.join('\n\n\n');
    if (!chars) {
      result.replaceChildren(h('div', { class: 'notice warn' }, 'Aucun texte trouvé : ces pages sont probablement des images (document scanné).'));
      return;
    }
    const area = h('textarea', { class: 'text-preview', readonly: true, spellcheck: 'false', 'aria-label': 'Texte extrait' });
    area.value = full;
    result.replaceChildren(
      h(
        'div',
        { class: 'panel text-result' },
        h('div', { class: 'text-head' }, h('strong', null, `${fmt(chars)} caractères sur ${plural(pages.length, 'page')}`), h('span', { class: 'spacer' }), button('Copier', { icon: 'copy', cls: 'small', onClick: async () => (await api.copy(full)) && toast('Texte copié dans le presse-papiers.') }), button('Enregistrer (.txt)', {
          icon: 'text',
          cls: 'small primary',
          onClick: async () => {
            const res = await api.saveText(`${baseName(file.name)}.txt`, full, file.id);
            if (check(res)) showResult(result, res, { title: 'Texte enregistré' });
          },
        })),
        area
      )
    );
  }

  render();
  return { el: root, accept: 'pdf', multiple: false, onFiles: open };
}
