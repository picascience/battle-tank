/*
 * SNIPER (Cyan) — GEN 1
 * Mathématique : visée anticipée (lead targeting itératif), garde ses distances (~480 px), se met
 * à couvert derrière les obstacles pendant qu'il recharge son énergie, ne tire que des tirs propres.
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

  function decide(s) {
    const me = s.self, cfg = s.cfg, m = s.memory;
    const vis = s.enemies.filter((e) => e.visible);
    const pool = vis.length ? vis : s.enemies;
    if (!pool.length) return {};
    let tgt = pool[0]; for (const e of pool) if (e.dist < tgt.dist) tgt = e;
    const nearest = tgt;

    // --- lead targeting linéaire (3 itérations du point fixe t = d(t)/v) ---
    let px = tgt.x, py = tgt.y;
    for (let i = 0; i < 3; i++) {
      const t = Math.hypot(px - me.x, py - me.y) / cfg.BULLET_SPEED;
      px = tgt.x + tgt.vx * t; py = tgt.y + tgt.vy * t;
    }
    const aimAng = Math.atan2(py - me.y, px - me.x);

    // --- positionnement : couverture la plus proche, côté opposé à l'ennemi le plus proche ---
    let goal = null, best = Infinity;
    for (const o of s.obstacles) {
      const ax = o.x - nearest.x, ay = o.y - nearest.y, al = Math.hypot(ax, ay) || 1;
      const wantPeek = me.energy >= 50;
      // point de "peek" (décalé sur le côté) si on peut tirer, sinon point caché
      const side = wantPeek ? 0.9 : 0;
      const nx = ax / al, ny = ay / al;
      const cx = o.x + (nx + -ny * side) * (o.r + 34), cy = o.y + (ny + nx * side) * (o.r + 34);
      const dToEnemy = Math.hypot(cx - nearest.x, cy - nearest.y);
      if (dToEnemy < 300 || cx < 30 || cy < 30 || cx > 970 || cy > 970) continue;
      const cost = Math.hypot(cx - me.x, cy - me.y) + Math.abs(dToEnemy - 480) * 0.5;
      if (cost < best) { best = cost; goal = { x: cx, y: cy }; }
    }
    let out;
    if (nearest.dist < 300) out = driveDir(me, Math.atan2(me.y - nearest.y, me.x - nearest.x), cfg, 1);
    else if (goal && Math.hypot(goal.x - me.x, goal.y - me.y) > 15) out = driveDir(me, Math.atan2(goal.y - me.y, goal.x - me.x), cfg, 0.9);
    else out = { throttle: 0, turnChassis: 0 };
    const z = s.zone;
    if (z.active && Math.hypot(me.x - z.x, me.y - z.y) > z.r - 60) out = driveDir(me, Math.atan2(z.y - me.y, z.x - me.x), cfg, 1);

    out.aimTurret = clamp(angDiff(me.turretAngle, aimAng) / cfg.TURRET_TURN, -1, 1);
    out.shoot = tgt.visible && Math.abs(angDiff(me.turretAngle, aimAng)) < 0.05 && me.energy >= 50 && clear(me.x, me.y, px, py, s.obstacles, 4);
    if (me.dashCd <= 0 && nearest.visible && nearest.dist < 160) out.dash = Math.atan2(me.y - nearest.y, me.x - nearest.x);
    m.last = tgt.id;
    return out;
  }

  return { key: 'sniper', name: 'Sniper', color: '#00f0ff', version: 'gen1', decide };
});
