/*
 * stars.js — Ciel étoilé animé en arrière-plan du HUB (canvas 2D, aucune dépendance).
 *
 *   - 3 profondeurs d'étoiles : les proches sont plus grosses, plus rapides et bougent plus avec la souris ;
 *   - scintillement, légère dérive, étoiles filantes de temps en temps ;
 *   - Starfield.warp() : effet « saut en hyperespace » (lancement d'une application) ;
 *   - Starfield.setAccent('#rrggbb') : teinte des étoiles proches selon l'application choisie ;
 *   - pause quand la fenêtre est cachée ; image fixe si le système demande de réduire les animations.
 */
'use strict';

(() => {
  // V3Redis Light : pas de ciel étoilé (aucune boucle d'animation, aucun calcul)
  if (document.documentElement.classList.contains('light')) return;
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let width = 0;
  let height = 0;
  let dpr = 1;
  let stars = [];
  let shooting = [];
  let nextShooting = 0;
  let warp = 0; // 0 → 1 : intensité du saut en hyperespace (décroît seule)
  // Saut maintenu (lancement d'une application) : plancher de l'intensité, atteint progressivement
  let holdTarget = 0;
  let hold = 0;
  let accent = [139, 109, 255];
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 }; // parallaxe lissée (-1 … 1)
  let raf = 0;
  let last = 0;

  const TINTS = [
    [255, 255, 255],
    [214, 226, 255],
    [255, 240, 225],
    [200, 210, 255],
  ];

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  function makeStar(randomY = true) {
    const z = Math.random() ** 1.8 * 0.85 + 0.15; // beaucoup d'étoiles lointaines, peu de proches
    return {
      x: Math.random() * width,
      y: randomY ? Math.random() * height : height + 4,
      z,
      r: 0.35 + z * 1.45,
      tint: TINTS[(Math.random() * TINTS.length) | 0],
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.6 + Math.random() * 2.2,
      accent: z > 0.78 && Math.random() < 0.45, // quelques étoiles proches prennent la couleur de l'application
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(700, Math.round((width * height) / 2200));
    stars = Array.from({ length: count }, () => makeStar(true));
    if (reduced.matches) draw(0, 0);
  }

  function spawnShootingStar(now) {
    const fromLeft = Math.random() < 0.5;
    const angle = (fromLeft ? 0.35 : Math.PI - 0.35) + (Math.random() - 0.5) * 0.3;
    const speed = 900 + Math.random() * 600;
    shooting.push({
      x: fromLeft ? Math.random() * width * 0.6 : width * 0.4 + Math.random() * width * 0.6,
      y: Math.random() * height * 0.45,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      duration: 0.7 + Math.random() * 0.5,
    });
    nextShooting = now + 2500 + Math.random() * 6000;
  }

  function draw(dt, now) {
    ctx.clearRect(0, 0, width, height);
    mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 3);
    mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 3);
    const cx = width / 2;
    const cy = height / 2;
    const w = warp;

    for (const s of stars) {
      // Dérive lente vers le haut (plus rapide pour les étoiles proches), accélérée pendant le saut
      s.y -= (6 + s.z * 14) * dt * (1 + w * 40);
      if (w > 0.02) {
        // Saut : les étoiles s'éloignent du centre
        const dx = s.x - cx;
        const dy = s.y - cy;
        s.x += dx * dt * w * 3.2 * s.z;
        s.y += dy * dt * w * 3.2 * s.z;
      }
      if (s.y < -6 || s.x < -40 || s.x > width + 40 || s.y > height + 40) {
        // Étoile sortie de l'écran : elle réapparaît en bas (dérive normale) ou près du centre (saut)
        Object.assign(s, makeStar(false));
        if (w > 0.02) {
          s.x = cx + (Math.random() - 0.5) * width * 0.3;
          s.y = cy + (Math.random() - 0.5) * height * 0.3;
        }
      }

      const px = s.x - mouse.x * 26 * s.z;
      const py = s.y - mouse.y * 18 * s.z;
      s.twinkle += s.twinkleSpeed * dt;
      const alpha = Math.max(0.12, Math.min(1, 0.35 + s.z * 0.55 + Math.sin(s.twinkle) * 0.3));
      const [r, g, b] = s.accent ? accent : s.tint;

      if (w > 0.05) {
        // Traînée dirigée depuis le centre
        const len = w * 60 * s.z;
        const ang = Math.atan2(py - cy, px - cx);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = s.r;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - Math.cos(ang) * len, py - Math.sin(ang) * len);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, s.r, 0, Math.PI * 2);
        ctx.fill();
        // Halo des étoiles les plus proches
        if (s.z > 0.82) {
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.12})`;
          ctx.beginPath();
          ctx.arc(px, py, s.r * 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Étoiles filantes
    if (!reduced.matches && now > nextShooting && w < 0.05) spawnShootingStar(now);
    shooting = shooting.filter((m) => {
      m.life += dt;
      const t = m.life / m.duration;
      if (t >= 1) return false;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      const tail = 140;
      const norm = Math.hypot(m.vx, m.vy);
      const tx = m.x - (m.vx / norm) * tail;
      const ty = m.y - (m.vy / norm) * tail;
      const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
      grad.addColorStop(0, `rgba(255,255,255,${0.95 * fade})`);
      grad.addColorStop(0.3, `rgba(${accent[0]},${accent[1]},${accent[2]},${0.45 * fade})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      return true;
    });

    // Le maintien monte en ~0,7 s et redescend plus doucement ; le saut ne descend jamais en dessous
    hold += (holdTarget - hold) * Math.min(1, dt * (holdTarget > hold ? 1.6 : 0.9));
    warp = Math.max(hold, warp - dt * 0.9);
  }

  function frame(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    draw(dt, now);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf || reduced.matches) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', (e) => {
    mouse.tx = (e.clientX / Math.max(1, width)) * 2 - 1;
    mouse.ty = (e.clientY / Math.max(1, height)) * 2 - 1;
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      stop();
      draw(0, 0);
    } else start();
  });

  resize();
  nextShooting = performance.now() + 1500;
  start();

  window.Starfield = {
    setAccent(hex) {
      const rgb = hexToRgb(hex);
      if (rgb) accent = rgb;
      if (reduced.matches) draw(0, 0);
    },
    /** Saut en hyperespace ponctuel (ignoré si les animations sont réduites). */
    warp() {
      if (!reduced.matches) warp = 1;
    },
    /** Saut maintenu : level 0 → 1 (0 = retour au ciel calme, progressivement). */
    hold(level) {
      holdTarget = reduced.matches ? 0 : Math.max(0, Math.min(1, Number(level) || 0));
    },
  };
})();
