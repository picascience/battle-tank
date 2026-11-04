/*
 * TRICKSTER (Violet) — GEN 1
 * Spécialiste de l'esquive et du rebond. Analyse chaque balle en vol (produit scalaire pour le
 * temps d'approche, produit vectoriel pour le côté de passage) et s'écarte de la trajectoire.
 * Tire de préférence par la bande (miroir de la cible par rapport aux murs).
 */
(function (root, factory) {
  const bot = factory();
  if (typeof module === 'object' && module.exports) module.exports = bot;
  else { root.CTA_BOTS = root.CTA_BOTS || {}; root.CTA_BOTS[bot.key] = bot; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }
  function driveDir(me, dir, cfg, speed) {
    let d = angDiff(me.angle, dir), rev = false;
    if (Math.abs(d) > Math.PI / 2) { d = angDiff(me.angle, dir + Math.PI); rev = true; }
    const c = Math.cos(d); const thr = speed * (c > 0.6 ? c : 0.15);
    return { throttle: rev ? -thr : thr, turnChassis: clamp(d / cfg.CHASSIS_TURN, -1, 1) };
  }
  function segDist(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
    return Math.hypot(ax + dx * t - px, ay + dy * t - py);
  }
  function clear(ax, ay, bx, by, obs, pad) { for (const o of obs) if (segDist(ax, ay, bx, by, o.x, o.y) < o.r + pad) return false; return true; }

  /** vecteur d'évitement de toutes les balles menaçantes */
  function evade(s) {
    const me = s.self; let ex = 0, ey = 0, urgent = null;
    for (const b of s.bullets) {
      if (b.mine && b.bounces > 0) continue;
      const rx = me.x - b.x, ry = me.y - b.y, vv = b.vx * b.vx + b.vy * b.vy;
      const t = (rx * b.vx + ry * b.vy) / vv; if (t < 0 || t > 45) continue;
      const cx = b.x + b.vx * t - me.x, cy = b.y + b.vy * t - me.y; const d = Math.hypot(cx, cy);
      if (d > me.radius + 14) continue;
      // produit vectoriel v x r : de quel côté de la trajectoire je me trouve
      const cross = b.vx * ry - b.vy * rx; const sgn = cross >= 0 ? 1 : -1;
      const vl = Math.sqrt(vv); const nx = (-b.vy / vl) * sgn, ny = (b.vx / vl) * sgn;
      const w = 1 / (t + 1);
      ex += nx * w; ey += ny * w;
      if (!urgent || t < urgent.t) urgent = { t, nx, ny, d };
    }
    return { ex, ey, urgent };
  }

  function bankShot(me, tx, ty, obs, W, H, BR) {
    const opts = [];
    // [axe, coordonnée du mur] : le point miroir de la cible derrière chaque mur
    const walls = [['x', BR], ['x', W - BR], ['y', BR], ['y', H - BR]];
    for (const [axis, w] of walls) {
      const mx = axis === 'x' ? 2 * w - tx : tx, my = axis === 'y' ? 2 * w - ty : ty;
      // point de rebond = intersection du segment me->miroir avec le mur
      const k = axis === 'x' ? (w - me.x) / (mx - me.x) : (w - me.y) / (my - me.y);
      if (!(k > 0 && k < 1)) continue;
      const bx = me.x + (mx - me.x) * k, by = me.y + (my - me.y) * k;
      if (bx < 0 || bx > W || by < 0 || by > H) continue;
      if (!clear(me.x, me.y, bx, by, obs, 5) || !clear(bx, by, tx, ty, obs, 5)) continue;
      opts.push({ ang: Math.atan2(my - me.y, mx - me.x), len: Math.hypot(mx - me.x, my - me.y) });
    }
    opts.sort((a, b) => a.len - b.len);
    return opts[0] || null;
  }

  function decide(s) {
    const me = s.self, cfg = s.cfg;
    const vis = s.enemies.filter((e) => e.visible);
    const pool = vis.length ? vis : s.enemies;
    if (!pool.length) return {};
    let tgt = pool[0]; for (const e of pool) if (e.dist < tgt.dist) tgt = e;
    const dx = tgt.x - me.x, dy = tgt.y - me.y, d = Math.hypot(dx, dy);

    // --- mouvement : esquive prioritaire, sinon orbite autour de la cible à ~320 px ---
    const ev = evade(s);
    let out;
    if (Math.hypot(ev.ex, ev.ey) > 0.02) out = driveDir(me, Math.atan2(ev.ey, ev.ex), cfg, 1);
    else {
      const tang = Math.atan2(dy, dx) + Math.PI / 2;
      const radial = clamp((d - 320) / 200, -1, 1);
      const mx = Math.cos(tang) + (dx / d) * radial, my = Math.sin(tang) + (dy / d) * radial;
      out = driveDir(me, Math.atan2(my, mx), cfg, 0.85);
    }
    const z = s.zone;
    if (z.active && Math.hypot(me.x - z.x, me.y - z.y) > z.r - 60) out = driveDir(me, Math.atan2(z.y - me.y, z.x - me.x), cfg, 1);
    if (me.dashCd <= 0 && ev.urgent && ev.urgent.t < 7) out.dash = Math.atan2(ev.urgent.ny, ev.urgent.nx);

    // --- tir : bande en priorité (signature), sinon tir direct anticipé ---
    let px = tgt.x, py = tgt.y;
    for (let i = 0; i < 2; i++) { const t = Math.hypot(px - me.x, py - me.y) / cfg.BULLET_SPEED; px = tgt.x + tgt.vx * t; py = tgt.y + tgt.vy * t; }
    const bank = bankShot(me, px, py, s.obstacles, cfg.W, cfg.H, cfg.BULLET_R);
    let aim = null;
    if (bank && bank.len < 900) aim = bank.ang;
    else if (clear(me.x, me.y, px, py, s.obstacles, 4)) aim = Math.atan2(py - me.y, px - me.x);
    else aim = Math.atan2(dy, dx);
    out.aimTurret = clamp(angDiff(me.turretAngle, aim) / cfg.TURRET_TURN, -1, 1);
    out.shoot = tgt.visible && Math.abs(angDiff(me.turretAngle, aim)) < 0.06;
    return out;
  }

  return { key: 'trickster', name: 'Trickster', color: '#b44dff', version: 'gen1', decide };
});
