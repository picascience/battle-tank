/*
 * WARLORD (Or) — GEN 3
 * Diagnostic Gen 2 (34 % -> 14,4 %) : le nouveau Sniper kite à distance sans jamais "entrer en
 * duel", donc le Warlord (qui ne tire que sur les tanks déjà engagés) ne riposte presque pas ; son
 * orbite prévisible autour du centre le rend facile à toucher (1651 impacts du Sniper, 1740 du
 * Trickster), précision 16 % (visée linéaire 2 itérations sur cibles qui mitraillent latéralement).
 * Gen 3 :
 *   - détection de DUEL réelle : un ennemi dont la tourelle vise un AUTRE tank à portée = proie
 *   - planificateur par échantillonnage (danger balistique, exposition, contrôle du centre)
 *   - riposte immédiate sur tout ennemi qui le vise, visée par interception quadratique,
 *     tolérance = taille angulaire, portée max 600 px
 *   - gestion d'énergie en rafale : il accumule puis vide 4 tirs quand la fenêtre s'ouvre
 *   - mode survie (< 35 PV) : couverture maximale ; 1v1 final : agression contrôlée à 300 px
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
    return hyp(ax + dx * t - px, ay + dy * t - py);
  }
  function clear(ax, ay, bx, by, obs, pad) { for (const o of obs) if (segDist(ax, ay, bx, by, o.x, o.y) < o.r + pad) return false; return true; }
  function intercept(sx, sy, tx, ty, vx, vy, v) {
    const dx = tx - sx, dy = ty - sy;
    const a = vx * vx + vy * vy - v * v, b = 2 * (dx * vx + dy * vy), c = dx * dx + dy * dy;
    let t;
    if (Math.abs(a) < 1e-6) t = -c / b;
    else { const disc = b * b - 4 * a * c; if (disc < 0) return null; const s = Math.sqrt(disc); const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a); t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2); }
    if (!(t > 0)) return null;
    return { x: tx + vx * t, y: ty + vy * t, t };
  }
  const hyp = (x, y) => Math.sqrt(x * x + y * y);
  const threatening = (b) => !(b.mine && b.bounces > 0);

  function plan(s, o) {
    const me = s.self, cfg = s.cfg, m = s.memory, R = cfg.TANK_R;
    // re-planification 1 tick sur 2 (performances), sauf si une balle est proche
    if (s.tick % 2 === 1 && m.planGoal && m.planTick === s.tick - 1 && !s.bullets.some((b) => threatening(b) && Math.abs(b.x - me.x) + Math.abs(b.y - me.y) < 160)) return m.planGoal;
    const watchers = s.enemies.filter((e) => e.visible || s.tick - e.lastSeenTick < 90);
    let best = null;
    for (let ring = 0; ring < 3; ring++) {
      const rad = [0, 45, 100][ring]; const n = ring === 0 ? 1 : 16;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU; const cx = me.x + Math.cos(a) * rad, cy = me.y + Math.sin(a) * rad;
        if (cx < R + 8 || cy < R + 8 || cx > cfg.W - R - 8 || cy > cfg.H - R - 8) continue;
        let blocked = false; for (const ob of s.obstacles) if (hyp(cx - ob.x, cy - ob.y) < ob.r + R + 4) { blocked = true; break; }
        if (blocked) continue;
        let cost = 0;
        for (const b of s.bullets) {
          if (!threatening(b)) continue;
          const rx = cx - b.x, ry = cy - b.y, vv = b.vx * b.vx + b.vy * b.vy;
          const t = (rx * b.vx + ry * b.vy) / vv; if (t < 0 || t > 50) continue;
          const cd = hyp(cx - (b.x + b.vx * t), cy - (b.y + b.vy * t));
          if (cd < R + 14) cost += (R + 14 - cd) * 4 / (1 + t * 0.04);
        }
        for (const e of watchers) {
          const ed = hyp(cx - e.x, cy - e.y);
          if (ed > cfg.VISION || !clear(cx, cy, e.x, e.y, s.obstacles, 2)) continue;
          const isT = o.tgt && e.id === o.tgt.id;
          cost += (isT ? o.expoT : o.expo) * (0.4 + e.hp / 100) * (ed < 300 ? 1.4 : 1);
        }
        if (o.tgt) {
          const td = hyp(cx - o.tgt.x, cy - o.tgt.y);
          cost += Math.abs(td - o.range) * o.rangeW;
          if (o.losBonus && clear(cx, cy, o.tgt.x, o.tgt.y, s.obstacles, 3)) cost -= o.losBonus;
        }
        if (o.centerW) { const cd = hyp(cx - cfg.W / 2, cy - cfg.H / 2); cost += Math.max(0, cd - 260) * o.centerW; }
        const z = s.zone;
        if (z.active) { const zd = hyp(cx - z.x, cy - z.y); if (zd > z.r - 70) cost += (zd - z.r + 70) * 2; }
        if (rad > 0 && m.lastDir !== undefined) cost += Math.abs(angDiff(a, m.lastDir)) * 3;
        // ne pas rester immobile : une cible immobile est une cible morte
        if (rad === 0) cost += 6;
        if (!best || cost < best.cost) best = { x: cx, y: cy, cost, a, rad };
      }
    }
    if (best && best.rad > 0) m.lastDir = best.a;
    m.planGoal = best; m.planTick = s.tick;
    return best;
  }

  function decide(s) {
    const me = s.self, cfg = s.cfg, m = s.memory;
    const vis = s.enemies.filter((e) => e.visible);
    const all = s.enemies;
    if (!all.length) return {};
    // --- lecture tactique : qui vise qui ? ---
    const aimingAt = (e, x, y) => Math.abs(angDiff(e.turretAngle, Math.atan2(y - e.y, x - e.x))) < 0.22;
    let tgt = null, best = -Infinity;
    for (const e of vis) {
      const atMe = aimingAt(e, me.x, me.y) && e.dist < 650;
      let duel = e.recentDamage > 0;
      for (const o of vis) if (o !== e && hyp(o.x - e.x, o.y - e.y) < 650 && aimingAt(e, o.x, o.y)) duel = true;
      const sc = (duel ? 50 : 0) + (atMe ? 60 : 0) + (100 - e.hp) * 0.9 - e.dist * 0.08 + (m.tgt === e.id ? 15 : 0);
      if (sc > best) { best = sc; tgt = e; }
    }
    if (!tgt) { tgt = all[0]; for (const e of all) if (e.dist < tgt.dist) tgt = e; }
    m.tgt = tgt.id;

    const lowHp = me.hp < 35 && s.aliveCount > 2 && !s.zone.active;
    const finale = s.aliveCount <= 2 || s.zone.active;
    const goal = lowHp
      ? plan(s, { tgt, range: 500, rangeW: 0.1, expo: 45, expoT: 45, losBonus: 0, centerW: 0 })
      : finale
        ? plan(s, { tgt, range: 300, rangeW: 0.6, expo: 10, expoT: 6, losBonus: 25, centerW: 0.05 })
        : plan(s, { tgt, range: 360, rangeW: 0.25, expo: 22, expoT: 8, losBonus: 14, centerW: 0.08 });
    const out = goal && goal.rad > 0 ? driveDir(me, Math.atan2(goal.y - me.y, goal.x - me.x), cfg, 1) : { throttle: 0, turnChassis: 0 };

    // --- visée / rafales ---
    const p = tgt.visible ? (intercept(me.x, me.y, tgt.x, tgt.y, tgt.vx, tgt.vy, cfg.BULLET_SPEED) || tgt) : tgt;
    const aim = Math.atan2(p.y - me.y, p.x - me.x);
    out.aimTurret = clamp(angDiff(me.turretAngle, aim) / cfg.TURRET_TURN, -1, 1);
    const dP = hyp(p.x - me.x, p.y - me.y);
    const tol = Math.atan2(cfg.TANK_R * 0.75, Math.max(40, dP));
    if (me.energy >= 95) m.burst = true; if (me.energy < cfg.SHOT_COST) m.burst = false;
    const urgentTarget = aimingAt(tgt, me.x, me.y) || tgt.hp <= 30 || finale;
    out.shoot = tgt.visible && dP < 600 && (m.burst || urgentTarget) && Math.abs(angDiff(me.turretAngle, aim)) < tol && clear(me.x, me.y, p.x, p.y, s.obstacles, cfg.BULLET_R + 2);

    // --- esquive par dash (vitesse relative) ---
    if (me.dashCd <= 0) {
      let urgent = null;
      for (const b of s.bullets) {
        if (!threatening(b)) continue;
        const rvx = b.vx - me.vx, rvy = b.vy - me.vy, vv = rvx * rvx + rvy * rvy;
        const rx = me.x - b.x, ry = me.y - b.y; const t = (rx * rvx + ry * rvy) / vv;
        if (t < 0 || t > 8) continue;
        const cx = me.x - (b.x + rvx * t), cy = me.y - (b.y + rvy * t); const cd = hyp(cx, cy);
        if (cd < me.radius + 5 && (!urgent || t < urgent.t)) {
          let nx, ny; if (cd > 0.5) { nx = cx / cd; ny = cy / cd; } else { const vl = Math.sqrt(vv); nx = -rvy / vl; ny = rvx / vl; }
          urgent = { t, nx, ny };
        }
      }
      if (urgent) out.dash = Math.atan2(urgent.ny, urgent.nx);
    }
    return out;
  }

  return { key: 'warlord', name: 'Warlord', color: '#ffc400', version: 'gen3', decide };
});
