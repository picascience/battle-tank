/*
 * BERSERKER (Rouge Néon) — GEN 2
 * Diagnostic Gen 1 (0,4 % de victoires, 5,6 s de survie) :
 *   - charge en ligne droite => cible parfaite pour la visée anticipée (2518 impacts du Sniper)
 *   - gaspille son dash pour combler la distance => plus d'esquive quand ça compte
 *   - 502 auto-impacts : tirs à bout portant qui rebondissent sur les obstacles et reviennent
 * Gen 2 :
 *   - déplacement par CHAMPS DE POTENTIEL ARTIFICIELS : attraction vers la cible, répulsion des
 *     trajectoires de balles (pondérée par 1/temps d'impact), des obstacles et des autres tanks
 *   - approche en serpentin (oscillation latérale) puis orbite agressive à ~150 px (circle-strafe)
 *   - dash réservé à l'esquive (sauf achèvement d'une cible <= 20 PV)
 *   - tir uniquement en ligne de vue dégagée + visée anticipée quadratique
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
    const c = Math.cos(d); const thr = speed * (c > 0.5 ? c : 0.2);
    return { throttle: rev ? -thr : thr, turnChassis: clamp(d / cfg.CHASSIS_TURN, -1, 1) };
  }
  function segDist(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
    return Math.hypot(ax + dx * t - px, ay + dy * t - py);
  }
  function clear(ax, ay, bx, by, obs, pad) { for (const o of obs) if (segDist(ax, ay, bx, by, o.x, o.y) < o.r + pad) return false; return true; }
  /** interception exacte : |P + V t - S| = v t  =>  (V.V - v²) t² + 2 (D.V) t + D.D = 0 */
  function intercept(sx, sy, tx, ty, vx, vy, v) {
    const dx = tx - sx, dy = ty - sy;
    const a = vx * vx + vy * vy - v * v, b = 2 * (dx * vx + dy * vy), c = dx * dx + dy * dy;
    let t;
    if (Math.abs(a) < 1e-6) t = -c / b;
    else { const disc = b * b - 4 * a * c; if (disc < 0) return null; const s = Math.sqrt(disc); const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a); t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2); }
    if (!(t > 0)) return null;
    return { x: tx + vx * t, y: ty + vy * t, t };
  }

  function decide(s) {
    const me = s.self, cfg = s.cfg, m = s.memory;
    const vis = s.enemies.filter((e) => e.visible);
    const pool = vis.length ? vis : s.enemies;
    if (!pool.length) return {};
    // cible : faible PV, proche, déjà engagée (proie facile)
    let tgt = null, best = -Infinity;
    for (const e of pool) {
      const sc = (100 - e.hp) * 1.2 - e.dist * 0.12 + e.recentDamage * 0.8 + (e.visible ? 30 : 0) + (m.tgt === e.id ? 25 : 0);
      if (sc > best) { best = sc; tgt = e; }
    }
    m.tgt = tgt.id;
    const dx = tgt.x - me.x, dy = tgt.y - me.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;

    // ---------- champ de potentiel ----------
    let fx = 0, fy = 0;
    const ORBIT = 150;
    const phase = Math.sin(s.tick / 22 + me.id) ; // serpentin
    m.spin = m.spin || (me.id % 2 ? 1 : -1);
    if (s.tick % 240 === 0) m.spin = -m.spin;
    if (d > ORBIT + 60) {
      fx += ux * 1.0 + -uy * phase * 0.75; fy += uy * 1.0 + ux * phase * 0.75;
    } else {
      const radial = (d - ORBIT) / 60;
      fx += ux * radial + -uy * m.spin * 1.1; fy += uy * radial + ux * m.spin * 1.1;
    }
    // répulsion des balles : on fuit perpendiculairement à la trajectoire
    let urgent = null;
    for (const b of s.bullets) {
      if (b.mine && b.bounces > 0) continue;
      const rx = me.x - b.x, ry = me.y - b.y, vv = b.vx * b.vx + b.vy * b.vy;
      const t = (rx * b.vx + ry * b.vy) / vv; if (t < 0 || t > 40) continue;
      const cx = me.x - (b.x + b.vx * t), cy = me.y - (b.y + b.vy * t); const cd = Math.hypot(cx, cy);
      if (cd > me.radius + 22) continue;
      let nx, ny; if (cd > 0.5) { nx = cx / cd; ny = cy / cd; } else { const vl = Math.sqrt(vv); nx = -b.vy / vl; ny = b.vx / vl; }
      const w = 3.2 / (1 + t * 0.15) * (1 - cd / (me.radius + 22) * 0.6);
      fx += nx * w; fy += ny * w;
      if (cd < me.radius + 6 && (!urgent || t < urgent.t)) urgent = { t, nx, ny };
    }
    // répulsion obstacles / murs / autres tanks
    for (const o of s.obstacles) {
      const ox = me.x - o.x, oy = me.y - o.y, od = Math.hypot(ox, oy) - o.r;
      if (od < 50) { const w = (50 - od) / 50 * 1.4; fx += ox / (od + o.r) * w; fy += oy / (od + o.r) * w; }
    }
    const wallM = 60;
    if (me.x < wallM) fx += (wallM - me.x) / wallM; if (me.x > cfg.W - wallM) fx -= (me.x - cfg.W + wallM) / wallM;
    if (me.y < wallM) fy += (wallM - me.y) / wallM; if (me.y > cfg.H - wallM) fy -= (me.y - cfg.H + wallM) / wallM;
    for (const e of vis) if (e.id !== tgt.id && e.dist < 220) { fx -= (e.x - me.x) / e.dist * 0.5; fy -= (e.y - me.y) / e.dist * 0.5; }
    const z = s.zone;
    if (z.active) { const zd = Math.hypot(me.x - z.x, me.y - z.y); if (zd > z.r - 80) { fx += (z.x - me.x) / zd * 3; fy += (z.y - me.y) / zd * 3; } }

    const out = driveDir(me, Math.atan2(fy, fx), cfg, 1);

    // ---------- visée / tir ----------
    const p = tgt.visible ? (intercept(me.x, me.y, tgt.x, tgt.y, tgt.vx, tgt.vy, cfg.BULLET_SPEED) || tgt) : tgt;
    const aim = Math.atan2(p.y - me.y, p.x - me.x);
    out.aimTurret = clamp(angDiff(me.turretAngle, aim) / cfg.TURRET_TURN, -1, 1);
    const tol = Math.atan2(cfg.TANK_R * 0.8, Math.max(40, d));
    out.shoot = tgt.visible && Math.abs(angDiff(me.turretAngle, aim)) < tol && clear(me.x, me.y, p.x, p.y, s.obstacles, cfg.BULLET_R + 2);

    // ---------- dash ----------
    if (me.dashCd <= 0) {
      if (urgent && urgent.t < 9) out.dash = Math.atan2(urgent.ny, urgent.nx);
      else if (tgt.visible && tgt.hp <= 20 && d > 200 && d < 380) out.dash = Math.atan2(uy, ux);
    }
    return out;
  }

  return { key: 'berserker', name: 'Berserker', color: '#ff2a6d', version: 'gen2', decide };
});
