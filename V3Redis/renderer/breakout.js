/*
 * breakout.js — Casse-brique, édition ASCII (pour passer le temps).
 *
 * Caché dans le HUB : 5 clics rapides sur le bouton « Actualiser » l'ouvrent (app.js).
 * Tout est du texte : cadre +--+ |, briques [===] / [###] (2 coups), raquette <=======>, balle o.
 * Commandes : ← → (ou A / D, ou la souris), Espace pour lancer la balle ou mettre en pause, R pour rejouer,
 * Échap pour quitter. Meilleur score gardé dans le navigateur de V3Redis (localStorage).
 * Le DOM est construit sans innerHTML ; la boucle ne tourne que pendant que le jeu est ouvert.
 */
'use strict';

(() => {
  const COLS = 50; // largeur de l'aire de jeu (sans le cadre)
  const ROWS = 20; // hauteur de l'aire de jeu
  const BRICK_W = 5; // « [===] »
  const BRICKS_PER_ROW = COLS / BRICK_W;
  const BRICK_TOP = 2; // première rangée de briques
  const PADDLE_ROW = ROWS - 2;
  const PADDLE_W = 9;
  const PADDLE_SPEED = 42; // colonnes par seconde au clavier
  const LIVES = 3;
  const BEST_KEY = 'hub.breakout.best';
  const FRAME_MS = 1000 / 40; // 40 images par seconde suffisent pour du texte

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const store = {
    get() {
      try {
        return Number(localStorage.getItem(BEST_KEY)) || 0;
      } catch {
        return 0;
      }
    },
    set(v) {
      try {
        localStorage.setItem(BEST_KEY, String(v));
      } catch {
        // sans conséquence
      }
    },
  };

  // ------------------------------------------------------------------ état

  const g = {
    open: false,
    root: null,
    screen: null,
    hud: null,
    raf: 0,
    last: 0,
    acc: 0,
    keys: { left: false, right: false },
    mouseCol: null,
    // partie
    level: 1,
    score: 0,
    best: 0,
    lives: LIVES,
    bricks: [], // [rangée][colonne] = coups restants (0 = cassée)
    paddle: (COLS - PADDLE_W) / 2,
    ball: { x: 0, y: 0, dx: 0, dy: 0, stuck: true },
    speed: 0,
    phase: 'ready', // ready | play | pause | lost | over | won
    banner: '',
    bannerUntil: 0,
  };

  /** Disposition des briques du niveau n : plus de rangées, briques solides en haut, trous un niveau sur deux. */
  function buildLevel(n) {
    const rows = Math.min(3 + n, 8);
    const tough = Math.min(n - 1, rows - 1);
    g.bricks = [];
    for (let r = 0; r < rows; r++) {
      const line = [];
      for (let c = 0; c < BRICKS_PER_ROW; c++) {
        let hp = r < tough ? 2 : 1;
        if (n % 2 === 0 && (r + c) % 4 === 3) hp = 0; // damier troué
        if (n % 3 === 0 && (c === 0 || c === BRICKS_PER_ROW - 1) && r % 2 === 0) hp = 0;
        line.push(hp);
      }
      g.bricks.push(line);
    }
    g.speed = Math.min(15 + (n - 1) * 2, 28);
  }

  function bricksLeft() {
    return g.bricks.reduce((n, line) => n + line.filter((hp) => hp > 0).length, 0);
  }

  function resetBall() {
    g.ball = { x: g.paddle + PADDLE_W / 2, y: PADDLE_ROW - 1, dx: 0, dy: 0, stuck: true };
  }

  function newGame() {
    g.level = 1;
    g.score = 0;
    g.lives = LIVES;
    g.paddle = (COLS - PADDLE_W) / 2;
    buildLevel(1);
    resetBall();
    g.phase = 'ready';
    flash('NIVEAU 1', 1500);
  }

  function flash(text, ms) {
    g.banner = text;
    g.bannerUntil = performance.now() + ms;
  }

  function launch() {
    const b = g.ball;
    const dir = Math.random() < 0.5 ? -1 : 1;
    b.dx = dir * (0.35 + Math.random() * 0.25);
    b.dy = -Math.sqrt(1 - b.dx * b.dx);
    b.stuck = false;
    g.phase = 'play';
  }

  // ------------------------------------------------------------------ physique

  /** Brique touchée en (colonne, rangée) de l'aire de jeu : true si la balle doit rebondir. */
  function hitBrick(cx, cy) {
    const r = cy - BRICK_TOP;
    if (r < 0 || r >= g.bricks.length || cx < 0 || cx >= COLS) return false;
    const c = Math.floor(cx / BRICK_W);
    if (!g.bricks[r][c]) return false;
    g.bricks[r][c] -= 1;
    g.score += g.bricks[r][c] ? 5 : 10 * g.level;
    return true;
  }

  function step(dt) {
    // Raquette : clavier ou souris
    if (g.mouseCol != null) g.paddle = g.mouseCol - PADDLE_W / 2;
    if (g.keys.left) g.paddle -= PADDLE_SPEED * dt;
    if (g.keys.right) g.paddle += PADDLE_SPEED * dt;
    g.paddle = Math.max(0, Math.min(COLS - PADDLE_W, g.paddle));

    const b = g.ball;
    if (b.stuck) {
      b.x = g.paddle + PADDLE_W / 2;
      b.y = PADDLE_ROW - 1;
      return;
    }
    if (g.phase !== 'play') return;

    // Une rangée fait environ deux colonnes à l'écran : la vitesse verticale est divisée par deux
    const mx = b.dx * g.speed * dt;
    const my = (b.dy * g.speed * dt) / 2;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(mx), Math.abs(my)) / 0.4));
    for (let i = 0; i < n; i++) {
      let nx = b.x + mx / n;
      if (nx < 0 || nx >= COLS) {
        b.dx = -b.dx;
        nx = Math.max(0, Math.min(COLS - 0.001, nx));
      } else if (hitBrick(Math.floor(nx), Math.floor(b.y))) {
        b.dx = -b.dx;
        nx = b.x;
      }
      let ny = b.y + my / n;
      if (ny < 0) {
        b.dy = Math.abs(b.dy);
        ny = 0;
      } else if (hitBrick(Math.floor(nx), Math.floor(ny))) {
        b.dy = -b.dy;
        ny = b.y;
      } else if (b.dy > 0 && Math.floor(b.y) < PADDLE_ROW && Math.floor(ny) >= PADDLE_ROW && nx >= g.paddle - 0.5 && nx < g.paddle + PADDLE_W + 0.5) {
        // Rebond sur la raquette : l'angle dépend de l'endroit touché
        const rel = Math.max(-1, Math.min(1, ((nx - g.paddle) / PADDLE_W) * 2 - 1));
        b.dx = rel * 0.82;
        b.dy = -Math.sqrt(1 - b.dx * b.dx);
        ny = PADDLE_ROW - 0.01;
      }
      b.x = nx;
      b.y = ny;
      if ((mx || my) && b.y >= ROWS) return loseLife();
    }
    // Limite les trajectoires presque horizontales (la balle tournerait sans fin)
    if (Math.abs(b.dy) < 0.3) {
      b.dy = Math.sign(b.dy || -1) * 0.3;
      b.dx = Math.sign(b.dx || 1) * Math.sqrt(1 - 0.09);
    }
    if (!bricksLeft()) nextLevel();
  }

  function loseLife() {
    g.lives -= 1;
    if (g.lives <= 0) {
      g.phase = 'over';
      saveBest();
      return;
    }
    resetBall();
    g.phase = 'ready';
    flash(`BALLE PERDUE - ${g.lives} RESTANTE${g.lives > 1 ? 'S' : ''}`, 1600);
  }

  function nextLevel() {
    g.score += 50 * g.level;
    g.level += 1;
    buildLevel(g.level);
    resetBall();
    g.phase = 'ready';
    flash(`NIVEAU ${g.level}`, 1600);
    saveBest();
  }

  function saveBest() {
    if (g.score > g.best) {
      g.best = g.score;
      store.set(g.best);
    }
  }

  // ------------------------------------------------------------------ rendu texte

  const BRICK_TXT = { 1: '[===]', 2: '[###]' };

  /** Grille de caractères + classe de chaque caractère, puis regroupement en <span> par classe. */
  function render() {
    const W = COLS + 2;
    const chars = [];
    const cls = [];
    const put = (row, col, text, c) => {
      for (let i = 0; i < text.length; i++) {
        const x = col + i;
        if (x < 0 || x >= W) continue;
        chars[row][x] = text[i];
        cls[row][x] = c;
      }
    };
    for (let r = 0; r < ROWS + 2; r++) {
      chars.push(new Array(W).fill(' '));
      cls.push(new Array(W).fill(''));
    }
    // Cadre (le bas est ouvert : c'est là que la balle se perd)
    put(0, 0, `+${'-'.repeat(COLS)}+`, 'bk-wall');
    for (let r = 1; r <= ROWS; r++) {
      put(r, 0, '|', 'bk-wall');
      put(r, W - 1, '|', 'bk-wall');
    }
    put(ROWS + 1, 0, `+${' '.repeat(COLS)}+`, 'bk-wall');
    put(ROWS + 1, 1, '.'.repeat(COLS), 'bk-void');
    // Briques
    g.bricks.forEach((line, r) => {
      line.forEach((hp, c) => {
        if (hp) put(1 + BRICK_TOP + r, 1 + c * BRICK_W, BRICK_TXT[hp], `bk-b${r % 6}${hp > 1 ? ' bk-tough' : ''}`);
      });
    });
    // Raquette et balle
    const px = Math.round(g.paddle);
    put(1 + PADDLE_ROW, 1 + px, `<${'='.repeat(PADDLE_W - 2)}>`, 'bk-paddle');
    const b = g.ball;
    if (g.phase !== 'over' && b.y < ROWS) put(1 + Math.floor(b.y), 1 + Math.floor(b.x), 'o', 'bk-ball');
    // Message au centre
    const msg = message();
    if (msg) {
      const row = 1 + Math.floor(ROWS * 0.62);
      msg.forEach((line, i) => {
        const text = ` ${line} `;
        put(row + i, 1 + Math.floor((COLS - text.length) / 2), text, 'bk-msg');
      });
    }

    const frag = document.createDocumentFragment();
    for (let r = 0; r < chars.length; r++) {
      const div = el('div', 'bk-line');
      let start = 0;
      for (let x = 1; x <= W; x++) {
        if (x === W || cls[r][x] !== cls[r][start]) {
          const text = chars[r].slice(start, x).join('');
          div.appendChild(cls[r][start] ? el('span', cls[r][start], text) : document.createTextNode(text));
          start = x;
        }
      }
      frag.appendChild(div);
    }
    g.screen.replaceChildren(frag);

    g.hud.textContent = `SCORE ${String(g.score).padStart(5, '0')}   NIVEAU ${g.level}   VIES ${'o '.repeat(Math.max(0, g.lives)).trim() || '-'}   RECORD ${String(Math.max(g.best, g.score)).padStart(5, '0')}`;
  }

  function message() {
    if (g.phase === 'over') return ['G A M E   O V E R', `score ${g.score}${g.score >= g.best && g.score > 0 ? '  -  NOUVEAU RECORD !' : ''}`, '[R] rejouer   [Echap] quitter'];
    if (g.phase === 'pause') return ['P A U S E', '[Espace] reprendre'];
    if (performance.now() < g.bannerUntil) return [g.banner];
    if (g.phase === 'ready') return ['[Espace] lancer la balle'];
    return null;
  }

  // ------------------------------------------------------------------ boucle

  function frame(now) {
    if (!g.open) return;
    g.raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - g.last) / 1000);
    g.last = now;
    g.acc += dt * 1000;
    if (g.acc < FRAME_MS) return;
    const elapsed = g.acc / 1000;
    g.acc = 0;
    step(elapsed);
    render();
  }

  // ------------------------------------------------------------------ commandes

  function onKey(e) {
    if (!g.open) return;
    // Le jeu garde le clavier : rien ne part vers le HUB (Entrée lancerait l'application choisie, etc.)
    e.stopImmediatePropagation();
    const down = e.type === 'keydown';
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a' || k === 'q') {
      g.keys.left = down;
      g.mouseCol = null;
    } else if (k === 'arrowright' || k === 'd') {
      g.keys.right = down;
      g.mouseCol = null;
    } else if (down && (k === ' ' || k === 'spacebar')) {
      if (g.phase === 'ready') launch();
      else if (g.phase === 'play') g.phase = 'pause';
      else if (g.phase === 'pause') g.phase = 'play';
    } else if (down && k === 'r') {
      newGame();
    } else if (down && k === 'escape') {
      close();
    } else if (k !== 'tab') return;
    e.preventDefault();
  }

  function onPointer(e) {
    const r = g.screen.getBoundingClientRect();
    const charW = r.width / (COLS + 2);
    g.mouseCol = (e.clientX - r.left) / charW - 1;
  }

  function onClickScreen() {
    if (g.phase === 'ready') launch();
    else if (g.phase === 'pause') g.phase = 'play';
    else if (g.phase === 'over') newGame();
  }

  /** Fenêtre cachée ou quittée : pause automatique. */
  function autoPause() {
    g.keys.left = g.keys.right = false;
    if (g.phase === 'play') g.phase = 'pause';
  }

  // ------------------------------------------------------------------ ouverture / fermeture

  function build() {
    const root = el('div', 'breakout');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Casse-brique, édition ASCII');
    root.hidden = true;
    const panel = el('div', 'bk-panel');
    const head = el('header', 'bk-head');
    const title = el('h2', 'bk-title', 'CASSE-BRIQUE');
    title.appendChild(el('span', 'bk-edition', 'ASCII EDITION'));
    const quit = el('button', 'bk-close', '[x]');
    quit.type = 'button';
    quit.title = 'Quitter (Échap)';
    quit.addEventListener('click', close);
    head.append(title, quit);
    g.hud = el('div', 'bk-hud');
    g.screen = el('pre', 'bk-screen');
    g.screen.setAttribute('aria-hidden', 'true');
    g.screen.addEventListener('pointermove', onPointer);
    g.screen.addEventListener('click', onClickScreen);
    const help = el('p', 'bk-help', '<- -> ou souris : raquette | [Espace] lancer / pause | [R] rejouer | [Echap] quitter');
    panel.append(head, g.hud, g.screen, help);
    root.appendChild(panel);
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close();
    });
    document.body.appendChild(root);
    g.root = root;
  }

  function open() {
    if (g.open) return;
    if (!g.root) build();
    g.best = store.get();
    g.open = true;
    g.root.hidden = false;
    newGame();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', autoPause);
    document.addEventListener('visibilitychange', autoPause);
    g.last = performance.now();
    g.acc = FRAME_MS;
    g.raf = requestAnimationFrame(frame);
    if (window.Starfield && window.Starfield.hold) window.Starfield.hold(0);
  }

  function close() {
    if (!g.open) return;
    saveBest();
    g.open = false;
    cancelAnimationFrame(g.raf);
    g.root.hidden = true;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('blur', autoPause);
    document.removeEventListener('visibilitychange', autoPause);
    g.keys.left = g.keys.right = false;
    const refresh = $('refresh');
    if (refresh) refresh.focus();
  }

  window.Breakout = { open, close, isOpen: () => g.open };
})();
