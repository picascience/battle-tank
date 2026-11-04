/*
 * SNIPER (Cyan) — GEN 2
 * Diagnostic Gen 1 (16 % de victoires) : excellente précision (43 %) mais
 *   - cadence ridicule (19 tirs/match) : seuil d'énergie >= 50 + tolérance angulaire fixe trop stricte
 *   - immobile derrière son obstacle et AUCUNE esquive (0,4 dash/match, 3,6 esquives) : le Warlord
 *     l'arrose (1964 impacts) et le Berserker l'atteint au contact
 * Gen 2 :
 *   - prédiction QUADRATIQUE : interception exacte + estimation de l'accélération de la cible
 *     (mémoire des vitesses) intégrée par itération P + V t + ½ A t², avec amortissement
 *   - tolérance de tir = taille angulaire réelle de la cible (atan(R/d)), énergie mini = 1 tir
 *   - kiting latéral : mitraillage perpendiculaire à ~470 px (cible mouvante = plus dure à toucher)
 *   - esquive par champ de potentiel + dash réservé aux balles imminentes / menace au contact
 *   - priorité à la menace : l'ennemi qui le vise / qui fonce sur lui
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

  /** Prédiction quadratique : solution exacte (vitesse constante) puis raffinement avec accélération */
  function predict(me, e, acc, cfg) {
    const v = cfg.BULLET_SPEED;
    const dx = e.x - me.x, dy = e.y - me.y;
    const a = e.vx * e.vx + e.vy * e.vy - v * v, b = 2 * (dx * e.vx + dy * e.vy), c = dx * dx + dy * dy;
    let t = Math.sqrt(c) / v;
    if (Math.abs(a) > 1e-6) { const disc = b * b - 4 * a * c; if (disc >= 0) { const s = Math.sqrt(disc); const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a); const tt = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2); if (tt > 0) t = tt; } }
    // raffinement : accélération amortie (le moteur applique un amortissement 0.92/tick)
    let px = e.x, py = e.y;
    for (let i = 0; i < 4; i++) {
      const k = Math.min(t, 40); // l'accélération observée ne dure pas éternellement
      px = e.x + e.vx * t + 0.5 * acc.x * k * k * 0.5; py = e.y + e.vy * t + 0.5 * acc.y * k * k * 0.5;
      px = clamp(px, cfg.TANK_R, cfg.W - cfg.TANK_R); py = clamp(py, cfg.TANK_R, cfg.H - cfg.TANK_R);
      t = Math.hypot(px - me.x, py - me.y) / v;
    }
    return { x: px, y: py, t };
  }

  function decide(s) {
    const me = s.self, cfg = s.cfg, m = s.memory;
    m.vel = m.vel || {};
    const vis = s.enemies.filter((e) => e.visible);
    const pool = vis.length ? vis : s.enemies;
    if (!pool.length) return {};
    // accélérations estimées (lissage exponentiel)
    const accOf = {};
    for (const e of vis) {
      const pv = m.vel[e.id]; let ax = 0, ay = 0;
      if (pv && pv.tick === s.tick - 1) { ax = (e.vx - pv.vx) * 0.5 + pv.ax * 0.5; ay = (e.vy - pv.vy) * 0.5 + pv.ay * 0.5; }
      m.vel[e.id] = { vx: e.vx, vy: e.vy, ax, ay, tick: s.tick }; accOf[e.id] = { x: ax, y: ay };
    }
    // cible = menace prioritaire
    let tgt = null, best = -Infinity;
    for (const e of pool) {
      const aimingAtMe = e.visible && Math.abs(angDiff(e.turretAngle, Math.atan2(me.y - e.y, me.x - e.x))) < 0.25;
      const sc = -e.dist * 0.15 + (aimingAtMe ? 45 : 0) + (100 - e.hp) * 0.6 + (e.visible ? 60 : 0) + (m.tgt === e.id ? 15 : 0);
      if (sc > best) { best = sc; tgt = e; }
    }
    m.tgt = tgt.id;
    let nearest = pool[0]; for (const e of pool) if (e.dist < nearest.dist) nearest = e;

    // ---------- déplacement : champ de potentiel ----------
    let fx = 0, fy = 0;
    const tdx = tgt.x - me.x, tdy = tgt.y - me.y, td = Math.hypot(tdx, tdy) || 1;
    const RANGE = me.energy < 30 ? 560 : 470;
    m.side = m.side || 1; if (s.tick % 150 === 0) m.side = -m.side;
    // composante radiale (garder la portée) + latérale (strafe)
    const radial = clamp((td - RANGE) / 120, -1.5, 1);
    fx += (tdx / td) * radial + (-tdy / td) * m.side * 0.8; fy += (tdy / td) * radial + (tdx / td) * m.side * 0.8;
    for (const e of vis) if (e.dist < 260) { const w = (260 - e.dist) / 260 * 2.2; fx -= (e.x - me.x) / e.dist * w; fy -= (e.y - me.y) / e.dist * w; }
    let urgent = null;
    for (const b of s.bullets) {
      if (b.mine && b.bounces > 0) continue;
      const rx = me.x - b.x, ry = me.y - b.y, vv = b.vx * b.vx + b.vy * b.vy;
      const t = (rx * b.vx + ry * b.vy) / vv; if (t < 0 || t > 50) continue;
      const cx = me.x - (b.x + b.vx * t), cy = me.y - (b.y + b.vy * t); const cd = Math.hypot(cx, cy);
      if (cd > me.radius + 22) continue;
      let nx, ny; if (cd > 0.5) { nx = cx / cd; ny = cy / cd; } else { const vl = Math.sqrt(vv); nx = -b.vy / vl; ny = b.vx / vl; }
      const w = 3.5 / (1 + t * 0.12);
      fx += nx * w; fy += ny * w;
      if (cd < me.radius + 6 && (!urgent || t < urgent.t)) urgent = { t, nx, ny };
    }
    for (const o of s.obstacles) {
      const ox = me.x - o.x, oy = me.y - o.y, od = Math.hypot(ox, oy) - o.r;
      if (od < 45) { const w = (45 - od) / 45 * 1.5; fx += ox / (od + o.r) * w; fy += oy / (od + o.r) * w; }
    }
    const wallM = 90;
    if (me.x < wallM) fx += (wallM - me.x) / wallM * 1.5; if (me.x > cfg.W - wallM) fx -= (me.x - cfg.W + wallM) / wallM * 1.5;
    if (me.y < wallM) fy += (wallM - me.y) / wallM * 1.5; if (me.y > cfg.H - wallM) fy -= (me.y - cfg.H + wallM) / wallM * 1.5;
    const z = s.zone;
    if (z.active) { const zd = Math.hypot(me.x - z.x, me.y - z.y); if (zd > z.r - 90) { fx += (z.x - me.x) / zd * 3; fy += (z.y - me.y) / zd * 3; } }
    const out = driveDir(me, Math.atan2(fy, fx), cfg, 1);

    // ---------- visée ----------
    const p = tgt.visible ? predict(me, tgt, accOf[tgt.id] || { x: 0, y: 0 }, cfg) : { x: tgt.x, y: tgt.y };
    const aim = Math.atan2(p.y - me.y, p.x - me.x);
    out.aimTurret = clamp(angDiff(me.turretAngle, aim) / cfg.TURRET_TURN, -1, 1);
    const dP = Math.hypot(p.x - me.x, p.y - me.y);
    const tol = Math.atan2(cfg.TANK_R * 0.7, dP);
    out.shoot = tgt.visible && Math.abs(angDiff(me.turretAngle, aim)) < tol && clear(me.x, me.y, p.x, p.y, s.obstacles, cfg.BULLET_R + 2);

    // ---------- dash ----------
    if (me.dashCd <= 0) {
      if (urgent && urgent.t < 8) out.dash = Math.atan2(urgent.ny, urgent.nx);
      else if (nearest.visible && nearest.dist < 140) out.dash = Math.atan2(me.y - nearest.y, me.x - nearest.x);
    }
    return out;
  }

  return { key: 'sniper', name: 'Sniper', color: '#00f0ff', version: 'gen2', decide };
});
