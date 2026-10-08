/*
 * Compresser — réduire le poids d'un PDF.
 *  - Sans perte : structure réécrite (objets inutilisés retirés, flux d'objets compressés), texte intact.
 *  - Équilibrée / Forte / Maximale : chaque page est redessinée en image JPEG (résolution et qualité
 *    décroissantes). Gain important sur les scans et les PDF chargés d'images ; le texte n'est plus
 *    sélectionnable.
 * Le résultat est comparé à l'original avant d'être enregistré.
 */

import { api, h, icon, plural, baseName, check, showResult, busy, toast, button, formatBytes } from '../core.js';
import { dropZone, docHeader, actionBar } from '../components.js';
import { renderToImage, forget } from '../pdfview.js';

const LEVELS = [
  { id: 'lossless', title: 'Sans perte', desc: 'Nettoie et réorganise la structure du fichier. Gain modeste, rien ne change à l\'écran.', tag: 'Texte conservé', ok: true },
  { id: 'balanced', title: 'Équilibrée', desc: 'Pages en images à 150 ppp, bonne qualité. Idéal pour les scans.', tag: 'Pages en images', dpi: 150, quality: 0.75 },
  { id: 'strong', title: 'Forte', desc: 'Pages en images à 110 ppp. Fichier léger, lecture à l\'écran confortable.', tag: 'Pages en images', dpi: 110, quality: 0.6 },
  { id: 'max', title: 'Maximale', desc: 'Pages en images à 72 ppp. Le plus léger possible, pour l\'envoi par e-mail.', tag: 'Pages en images', dpi: 72, quality: 0.5 },
];

export function create() {
  const state = { file: null, level: 'balanced', output: null }; // output : { id, size, pages, level }
  const body = h('div', { class: 'tool-body' });
  const result = h('div', { class: 'tool-result' });
  const root = h('div', { class: 'tool-inner' }, body, result);

  function dropOutput() {
    if (state.output) api.releasePending(state.output.id);
    state.output = null;
  }

  function open(files) {
    const f = files.find((x) => x.kind === 'pdf');
    if (!f) return;
    dropOutput();
    if (state.file) {
      api.release([state.file.id]);
      forget(state.file.id);
    }
    state.file = f;
    result.replaceChildren();
    render();
  }

  function close() {
    dropOutput();
    api.release([state.file.id]);
    forget(state.file.id);
    state.file = null;
    result.replaceChildren();
    render();
  }

  function render() {
    if (!state.file) {
      body.replaceChildren(dropZone({ kind: 'pdf', title: 'Déposez le PDF à alléger', onFiles: open }));
      return;
    }
    const cards = LEVELS.map((l) => {
      const input = h('input', { type: 'radio', name: 'compress-level', value: l.id });
      input.checked = state.level === l.id;
      input.addEventListener('change', () => {
        state.level = l.id;
        dropOutput();
        result.replaceChildren();
      });
      return h('label', { class: 'level-card' }, input, h('span', { class: 'level-title' }, l.title, h('span', { class: `tag ${l.ok ? 'ok' : 'warn'}` }, l.tag)), h('span', { class: 'level-desc' }, l.desc));
    });
    body.replaceChildren(
      docHeader(state.file, { onChange: open, onClose: close }),
      h('div', { class: 'level-grid', role: 'radiogroup', 'aria-label': 'Niveau de compression' }, cards),
      h('p', { class: 'hint' }, 'Les niveaux « pages en images » ne gardent pas le texte sélectionnable ni les liens. Le résultat est comparé à l\'original avant l\'enregistrement.'),
      actionBar(`Taille actuelle : ${formatBytes(state.file.size)}`, button('Compresser', { icon: 'compress', cls: 'primary', onClick: run }))
    );
  }

  async function run() {
    dropOutput();
    result.replaceChildren();
    const file = state.file;
    const level = LEVELS.find((l) => l.id === state.level);
    let res;
    if (level.id === 'lossless') {
      busy.start('Réécriture du fichier…');
      try {
        res = await api.optimize(file.id);
      } finally {
        busy.end();
      }
    } else {
      const job = await api.rasterStart();
      if (!check(job)) return;
      busy.start('Compression…', { cancellable: true });
      try {
        for (let i = 0; i < file.pageCount; i++) {
          if (busy.canceled) {
            await api.rasterCancel(job.id);
            return;
          }
          busy.progress(i, file.pageCount, `Page ${i + 1} sur ${file.pageCount}…`);
          const img = await renderToImage(file.id, i, { dpi: level.dpi, type: 'image/jpeg', quality: level.quality });
          const added = await api.rasterAdd(job.id, img.bytes, img.widthPt, img.heightPt);
          if (!check(added)) return;
        }
        busy.progress(file.pageCount, file.pageCount, 'Assemblage…');
        res = await api.rasterFinish(job.id, { title: file.info && file.info.title, author: file.info && file.info.author });
      } catch (err) {
        await api.rasterCancel(job.id);
        toast(`Compression impossible : ${err.message}`, 'error');
        return;
      } finally {
        busy.end();
      }
    }
    if (!check(res)) return;
    state.output = { ...res, level: level.id };
    showComparison(level);
  }

  function showComparison(level) {
    const before = state.file.size;
    const after = state.output.size;
    const gain = 1 - after / before;
    const better = gain >= 0.01; // moins de 1 % : pas de gain réel
    // Barres à la même échelle : la plus grande des deux tailles occupe toute la largeur
    const scale = Math.max(before, after);
    const barBefore = h('span', { class: 'cmp-fill before' });
    const barAfter = h('span', { class: 'cmp-fill after' });
    barBefore.style.width = `${Math.max(2, (before / scale) * 100)}%`;
    barAfter.style.width = `${Math.max(2, (after / scale) * 100)}%`;
    const badge = better ? `−${Math.round(gain * 100)} %` : after > before * 2 ? `× ${(after / before).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}` : after > before * 1.01 ? `+${Math.round(-gain * 100)} %` : 'Aucun gain';
    const why =
      level.id === 'lossless'
        ? 'Ce PDF est déjà optimisé : il n\'y a rien à gagner sans perte. Essayez un niveau « pages en images » si c\'est un scan.'
        : 'Ce PDF contient surtout du texte et des formes : le transformer en images l\'alourdit. Gardez l\'original ou essayez « Sans perte ».';
    const save = button(better ? 'Enregistrer le PDF compressé' : 'Enregistrer quand même', {
      icon: 'check',
      cls: better ? 'primary' : '',
      onClick: async () => {
        const res = await api.savePending(state.output.id, `${baseName(state.file.name)}_compresse.pdf`, state.file.id);
        if (check(res)) showResult(result, res, { title: 'PDF compressé enregistré', detail: `${formatBytes(res.size)} au lieu de ${formatBytes(before)}` });
      },
    });
    result.replaceChildren(
      h(
        'div',
        { class: `panel comparison${better ? '' : ' worse'}` },
        h('div', { class: 'cmp-head' }, h('strong', null, `Niveau « ${level.title} »`), h('span', { class: `gain ${better ? 'ok' : 'warn'}` }, badge)),
        h('div', { class: 'cmp-row' }, h('span', null, 'Avant'), h('div', { class: 'cmp-bar' }, barBefore), h('strong', null, formatBytes(before))),
        h('div', { class: 'cmp-row' }, h('span', null, 'Après'), h('div', { class: 'cmp-bar' }, barAfter), h('strong', null, formatBytes(after))),
        better ? null : h('p', { class: 'notice warn' }, icon('warn'), h('span', null, why)),
        h('div', { class: 'cmp-actions' }, save, h('span', { class: 'muted' }, plural(state.output.pages, 'page')))
      )
    );
  }

  render();
  return { el: root, accept: 'pdf', multiple: false, onFiles: open };
}
