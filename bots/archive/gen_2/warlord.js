/*
 * WARLORD (Or) — GEN 1
 * Opportuniste tactique : tient le centre de la carte, évite les mêlées, préserve ses PV et ne
 * frappe que les tanks déjà engagés dans un duel (third-partying) ou ceux qui le menacent.
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
  function imminentThreat(s, horizon) {
    const me = s.self; let best = null;
    for (const b of s.bullets) {
      if (b.mine && b.bounces > 0) continue;
      const rx = me.x - b.x, ry = me.y - b.y, vv = b.vx * b.vx + b.vy * b.vy;
      const t = (rx * b.vx + ry * b.vy) / vv; if (t < 0 || t > horizon) continue;
      const cx = b.x + b.vx * t - me.x, cy = b.y + b.vy * t - me.y; const d = Math.hypot(cx, cy);
      if (d < me.radius + 6 && (!best || t < best.t)) best = { b, t, d, cx, cy };
    }
    return best;
  }

  function decide(s) {
    const me = s.self, cfg = s.cfg, m = s.memory;
    const cx = cfg.W / 2, cy = cfg.H / 2;
    const center = s.obstacles.find((o) => Math.hypot(o.x - cx, o.y - cy) < 5);
    const ring = (center ? center.r : 0) + 90;
    const vis = s.enemies.filter((e) => e.visible);

    // --- choix de cible : les tanks déjà en duel (recentDamage) ou qui me visent ---
    let tgt = null, bestScore = -Infinity;
    for (const e of vis) {
      const aimingAtMe = Math.abs(angDiff(e.turretAngle, Math.atan2(me.y - e.y, me.x - e.x))) < 0.2;
      const engaged = e.recentDamage > 0 || aimingAtMe || e.hp <= 30;
      if (!engaged) continue;
      const sc = e.recentDamage * 2 + (100 - e.hp) - e.dist / 10 + (aimingAtMe ? 40 : 0);
      if (sc > bestScore) { bestScore = sc; tgt = e; }
    }
    // --- mouvement : orbite lente autour du centre, recul si mêlée ---
    const close = vis.filter((e) => e.dist < 350);
    let out;
    if (close.length >= 2 || (me.hp < 50 && close.some((e) => e.dist < 250))) {
      let ax = 0, ay = 0; for (const e of close) { ax += (me.x - e.x) / e.dist; ay += (me.y - e.y) / e.dist; }
      out = driveDir(me, Math.atan2(ay, ax), cfg, 1);
    } else {
      m.orbit = m.orbit === undefined ? Math.atan2(me.y - cy, me.x - cx) : m.orbit + 0.004;
      const gx = cx + Math.cos(m.orbit) * ring, gy = cy + Math.sin(m.orbit) * ring;
      const dd = Math.hypot(gx - me.x, gy - me.y);
      out = dd > 20 ? driveDir(me, Math.atan2(gy - me.y, gx - me.x), cfg, 0.8) : { throttle: 0, turnChassis: 0 };
    }
    // --- visée ---
    const look = tgt || vis.sort((a, b) => a.dist - b.dist)[0] || s.enemies[0];
    if (look) {
      let px = look.x, py = look.y;
      for (let i = 0; i < 2; i++) { const t = Math.hypot(px - me.x, py - me.y) / cfg.BULLET_SPEED; px = look.x + look.vx * t; py = look.y + look.vy * t; }
      const aim = Math.atan2(py - me.y, px - me.x);
      out.aimTurret = clamp(angDiff(me.turretAngle, aim) / cfg.TURRET_TURN, -1, 1);
      out.shoot = !!tgt && Math.abs(angDiff(me.turretAngle, aim)) < 0.08;
    }
    if (me.dashCd <= 0) { const th = imminentThreat(s, 10); if (th) out.dash = th.d > 1 ? Math.atan2(-th.cy, -th.cx) : Math.atan2(th.b.vx, -th.b.vy); }
    return out;
  }

  return { key: 'warlord', name: 'Warlord', color: '#ffc400', version: 'gen1', decide };
});
