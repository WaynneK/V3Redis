/*
 * capture-guide.js — Captures annotées du guide (npm run guide:captures).
 *
 * Ouvre l'application avec un profil temporaire, simule un Windows Server du domaine lab.local (détection et
 * exécution remplacées : AUCUNE commande n'est lancée), charge le projet d'exemple, puis capture chaque écran
 * décrit par AgepedeGuide.SHOT_SPECS, en thème clair puis sombre, et mesure la position des repères.
 * Résultat : renderer/assets/guide/<écran>-light|dark.png et renderer/js/guide-shots.js.
 * À relancer après une modification de l'interface. Non inclus dans l'application compilée.
 */
'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT_IMG = path.join(ROOT, 'renderer', 'assets', 'guide');
const OUT_JS = path.join(ROOT, 'renderer', 'js', 'guide-shots.js');
const MARKER_GAP = 13; // repère posé juste à côté de l'élément, sans cacher son texte
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const ud = path.join(os.tmpdir(), 'agepede-capture-guide');
  fs.rmSync(ud, { recursive: true, force: true });
  app.setPath('userData', ud);

  // --- Environnement simulé : contrôleur de domaine, outils AD présents, pas encore administrateur ---
  const Runner = require(`${ROOT}/lib/runner.js`);
  Runner.detectEnvironment = async () => ({
    platform: 'win32', isWindows: true, osRelease: '10.0.20348', installationType: 'Server', isServer: true,
    tools: { dsadd: true, dsmod: true, dsquery: true, dsget: true, icacls: true },
    isAdmin: false, domain: { dns: 'lab.local', netbios: 'LAB', dn: 'DC=lab,DC=local' }, joined: true,
  });
  const realRunSteps = Runner.runSteps;
  Runner.runSteps = (steps, opts) => {
    let checks = 0;
    const run = (line) =>
      new Promise((resolve) =>
        setTimeout(() => {
          const look = /^dsquery user -samid (\S+) -limit 1$/.exec(line);
          if (look) {
            if (look[1] === 'cbernard') return resolve({ exitCode: 0, stdout: '', output: '' });
            const dn = `"CN=${look[1]},OU=Utilisateurs,OU=Paris,DC=lab,DC=local"\r\n`;
            return resolve({ exitCode: 0, stdout: dn, output: dn });
          }
          if (/\| findstr "="$/.test(line) || /^if exist/.test(line)) {
            checks++;
            // L'OU Paris existe déjà ; le reste est à créer
            if (/"OU=Paris,DC=lab,DC=local" -scope base/.test(line)) return resolve({ exitCode: 0, stdout: '"OU=Paris,DC=lab,DC=local"\r\n', output: '"OU=Paris,DC=lab,DC=local"\r\n' });
            return resolve({ exitCode: 1, stdout: '', output: '' });
          }
          // Erreur de démonstration : mot de passe refusé par la stratégie du domaine
          if (/^dsadd user .*-samid cbernard /.test(line)) {
            const out = 'dsadd a échoué :0x800708c5:Le mot de passe ne répond pas aux spécifications de la stratégie de mot de passe.\r\n';
            return resolve({ exitCode: 0x800708c5 | 0, stdout: '', output: out });
          }
          if (/^icacls/.test(line)) return resolve({ exitCode: 0, stdout: 'Fichier traité : D:\\Partages\r\nTraitement réussi de 1 fichiers ; échec du traitement de 0 fichiers\r\n', output: 'Fichier traité : D:\\Partages\r\nTraitement réussi de 1 fichiers ; échec du traitement de 0 fichiers\r\n' });
          if (/^if not exist/.test(line)) return resolve({ exitCode: 0, stdout: '', output: '' });
          const m = /^(dsadd|dsmod) \w+ "([^"]+)"/.exec(line);
          const out = m ? `${m[1]} réussite :${m[2]}\r\n` : '';
          resolve({ exitCode: 0, stdout: out, output: out });
        }, 25)
      );
    return realRunSteps(steps, { ...opts, run, platform: 'win32' });
  };
  // Confirmation d'exécution : « Exécuter »
  dialog.showMessageBox = async () => ({ response: 0 });

  require(`${ROOT}/main.js`);

  app.whenReady().then(async () => {
    try {
      let win;
      while (!(win = BrowserWindow.getAllWindows().find((w) => w.isVisible() && w.getBounds().width > 600))) await sleep(100);
      const errors = [];
      win.webContents.on('console-message', (e) => e.level === 'error' && errors.push(e.message));
      win.setContentSize(1240, 800);
      win.center();
      const js = (code) => win.webContents.executeJavaScript(code);
      await sleep(1500);

      // Visite du premier lancement : vérifiée puis fermée
      console.log('visite affichée au 1er lancement :', await js(`!!document.querySelector('.tour-layer')`));
      await js(`[...document.querySelectorAll('.tour-bubble button')].find(b => b.textContent === 'Plus tard').click(); 0`);
      await js(`window.AgepedeGuide.loadExample(); 0`);
      await sleep(600);
      const clean = `document.getElementById('toasts').textContent=''; document.activeElement && document.activeElement.blur(); 0`;

      const specs = await js('JSON.parse(JSON.stringify(window.AgepedeGuide.SHOT_SPECS))');
      fs.rmSync(OUT_IMG, { recursive: true, force: true });
      fs.mkdirSync(OUT_IMG, { recursive: true });
      const shots = {};
      const { nativeTheme } = require('electron');
      for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      await js(`window.AgepedeGuide.loadExample(); 0`);
      await sleep(800);
      for (const [id, spec] of Object.entries(specs)) {
        await js(`document.getElementById('tab-${spec.tab}').click(); document.querySelector('.views').scrollTop = 0; 0`);
        await sleep(300);
        if (id === 'globals') {
          // Une ligne en erreur pour montrer le contrôle immédiat
          await js(`(() => { const i = document.querySelector('#grid-globals tr.ghost input[data-field="name"]'); i.focus(); i.value = 'GG_Achats;'; i.dispatchEvent(new Event('input', { bubbles: true })); })(); 0`);
          await sleep(900);
        }
        if (id === 'locals') {
          await js(`(() => { const i = document.getElementById('dl-helper-gg'); i.value = 'GG_RH'; })(); 0`);
        }
        if (id === 'run') {
          await js(`document.getElementById('btn-run').click(); 0`);
          for (let i = 0; i < 100 && (await js(`!document.getElementById('btn-stop').hidden`)); i++) await sleep(100);
          await sleep(400); // la ligne en erreur se déplie d'elle-même
        }
        await js(clean);
        await sleep(250);
        if (spec.scroll) await js(`document.querySelector(${JSON.stringify(spec.scroll)}).scrollIntoView({ block: 'start' }); 0`);
        if (spec.logScroll) await js(`(() => { const r = document.querySelector(${JSON.stringify(spec.logScroll)}); const w = r.closest('.log-wrap'); w.scrollTop = r.offsetTop - w.querySelector('thead').offsetHeight; })(); 0`);
        await sleep(200);
        // Zone capturée et position des repères (en % de la zone)
        const geo = await js(`(() => {
          const spec = ${JSON.stringify(spec)};
          const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
          let area = { x: 0, y: 0, width: W, height: H };
          if (spec.crop) { const r = document.querySelector(spec.crop).getBoundingClientRect(); area = { x: 0, y: 0, width: W, height: Math.ceil(r.bottom + 6) }; }
          // Exécution : on garde le panneau d'exécution, le journal et ses détails
          if (spec.scroll) { area = { x: 0, y: 0, width: W, height: H }; }
          const markers = spec.markers.map(([sel, anchor], i) => {
            const e = document.querySelector(sel);
            if (!e) return { n: i + 1, missing: sel };
            const r = e.getBoundingClientRect();
            const gap = ${MARKER_GAP};
            let x = r.left + r.width / 2, y = r.top + r.height / 2;
            if (anchor === 'l') x = Math.max(gap, r.left - gap);
            if (anchor === 'r') x = Math.min(W - gap, r.right + gap);
            if (anchor === 't') y = Math.max(gap, r.top - gap);
            if (anchor === 'b') y = Math.min(H - gap, r.bottom + gap);
            const pct = (v, a, s) => Math.round(((v - a) / s) * 10000) / 100;
            // Le repère doit tomber sur l'élément lui-même (pas caché par un défilement ou un autre élément)
            const hit = document.elementFromPoint(Math.min(Math.max(r.left + Math.min(r.width / 2, 20), 1), W - 1), Math.min(Math.max(r.top + r.height / 2, 1), H - 1));
            const visible = Boolean(hit && (e.contains(hit) || hit.contains(e) || e.closest('tr') === (hit.closest && hit.closest('tr'))));
            return { n: i + 1, x: pct(x, area.x, area.width), y: pct(y, area.y, area.height), visible };
          });
          return { area, markers };
        })()`);
        const missing = geo.markers.filter((m) => m.missing);
        if (missing.length) console.log(`  ! ${id} : repères introuvables`, missing.map((m) => `${m.n}=${m.missing}`).join(', '));
        const hidden = geo.markers.filter((m) => !m.missing && !m.visible);
        if (hidden.length) console.log(`  ! ${id} : repères sur un élément masqué`, hidden.map((m) => m.n).join(', '));
        const img = await win.webContents.capturePage(geo.area);
        const out = img.resize({ width: geo.area.width, quality: 'best' });
        const size = out.getSize();
        const file = `${id}-${theme}.png`;
        fs.writeFileSync(path.join(OUT_IMG, file), out.toPNG());
        const markers = geo.markers.filter((m) => !m.missing).map(({ n, x, y }) => ({ n, x, y }));
        if (theme === 'light') shots[id] = { src: `assets/guide/${file}`, w: size.width, h: size.height, markers };
        else {
          shots[id].dark = `assets/guide/${file}`;
          const drift = markers.some((m, k) => !shots[id].markers[k] || Math.abs(m.x - shots[id].markers[k].x) > 0.5 || Math.abs(m.y - shots[id].markers[k].y) > 0.5);
          if (drift) console.log(`  ! ${id} : repères différents entre clair et sombre`);
        }
        console.log(`  ${file} ${size.width}×${size.height}, ${markers.length} repères, ${Math.round(out.toPNG().length / 1024)} Ko`);
        if (id === 'globals') {
          // Retire la ligne en erreur : rechargement de l'exemple (« Ne pas enregistrer » à la question)
          await js(`window.AgepedeGuide.loadExample(); 0`);
          await sleep(300);
          await js(`(() => { const b = [...document.querySelectorAll('#ask-actions button')].find(x => x.textContent === 'Ne pas enregistrer'); if (b) b.click(); })(); 0`);
          await sleep(300);
        }
        await sleep(300);
      }
      }
      nativeTheme.themeSource = 'system';
      const header = '// Captures du guide : générées par le script de capture (voir guide.js). Ne pas modifier à la main.\n';
      fs.writeFileSync(OUT_JS, `${header}window.GUIDE_SHOTS = ${JSON.stringify(shots, null, 2)};\n`, 'utf8');
      console.log('guide-shots.js écrit ; erreurs console :', errors.length ? errors : 'aucune');
    } catch (err) {
      console.log('ERREUR HARNAIS', err && err.stack);
    }
    app.exit(0);
  });
} catch (err) {
  console.log('ERREUR HARNAIS', err && err.stack);
  app.exit(1);
}
