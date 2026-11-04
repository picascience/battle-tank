/*
 * BERSERKER (Rouge Néon) — GEN 1
 * Ultra-agressif : traque la cible la plus faible, fonce au corps-à-corps, dash pour combler la
 * distance, esquive par dash au tout dernier moment.
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
    const me = s.self, cfg = s.cfg;
    const vis = s.enemies.filter((e) => e.visible);
    const pool = vis.length ? vis : s.enemies;
    if (!pool.length) return {};
    // cible = la plus faible (puis la plus proche)
    let tgt = pool[0];
    for (const e of pool) if (e.hp < tgt.hp - 5 || (Math.abs(e.hp - tgt.hp) <= 5 && e.dist < tgt.dist)) tgt = e;
    const dx = tgt.x - me.x, dy = tgt.y - me.y, d = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
    let out = driveDir(me, ang, cfg, d < 70 ? 0.2 : 1);
    // zone de tempête : rester dedans
    const z = s.zone;
    if (z.active && Math.hypot(me.x - z.x, me.y - z.y) > z.r - 60) out = driveDir(me, Math.atan2(z.y - me.y, z.x - me.x), cfg, 1);
    out.aimTurret = clamp(angDiff(me.turretAngle, ang) / cfg.TURRET_TURN, -1, 1);
    out.shoot = tgt.visible && Math.abs(angDiff(me.turretAngle, ang)) < 0.12;
    if (me.dashCd <= 0) {
      const th = imminentThreat(s, 8);
      if (th) out.dash = th.d > 1 ? Math.atan2(-th.cy, -th.cx) : Math.atan2(th.b.vx, -th.b.vy);
      else if (tgt.visible && d > 300) out.dash = ang; // combler la distance
    }
    return out;
  }

  return { key: 'berserker', name: 'Berserker', color: '#ff2a6d', version: 'gen1', decide };
});
