/*
 * BERSERKER (Rouge Néon) — GEN 3 "Stalker"
 * Diagnostic Gen 2 (2,4 %) : l'esquive s'est améliorée (11,8 esquives/match, survie x2) mais il est
 * TOUJOURS le premier focus : en fonçant dès le spawn il devient l'ennemi le plus proche de tout le
 * monde (99,6 dégâts reçus/match, 4671 impacts encaissés, placement moyen 3,29).
 * Gen 3 :
 *   - PLANIFICATEUR LOCAL PAR ÉCHANTILLONNAGE : 33 positions candidates évaluées à chaque tick
 *     (danger balistique, exposition aux lignes de vue ennemies, portée voulue, tempête, inertie)
 *   - deux phases : TRAQUE (rester hors des lignes de vue, ~380 px) puis ENGAGEMENT total dès que la
 *     proie est affaiblie, déjà en duel, ou en 1v1 / tempête -> corps-à-corps à 140 px
 *   - dash d'achèvement seulement si la cible n'a plus son dash (elle ne peut plus fuir)
 *   - menace balistique calculée en vitesse RELATIVE (balle - tank) pour une esquive exacte
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

  /** Évalue des positions candidates autour du tank et retourne la meilleure */
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
        // danger balistique
        for (const b of s.bullets) {
          if (!threatening(b)) continue;
          const rx = cx - b.x, ry = cy - b.y, vv = b.vx * b.vx + b.vy * b.vy;
          const t = (rx * b.vx + ry * b.vy) / vv; if (t < 0 || t > 50) continue;
          const cd = hyp(cx - (b.x + b.vx * t), cy - (b.y + b.vy * t));
          if (cd < R + 14) cost += (R + 14 - cd) * 4 / (1 + t * 0.04);
        }
        // exposition aux lignes de vue
        for (const e of watchers) {
          const ed = hyp(cx - e.x, cy - e.y);
          if (ed > cfg.VISION || !clear(cx, cy, e.x, e.y, s.obstacles, 2)) continue;
          const isT = o.tgt && e.id === o.tgt.id;
          cost += (isT ? o.expoT : o.expo) * (0.4 + e.hp / 100) * (ed < 300 ? 1.3 : 1);
        }
        // portée désirée vis-à-vis de la cible
        if (o.tgt) {
          const td = hyp(cx - o.tgt.x, cy - o.tgt.y);
          cost += Math.abs(td - o.range) * o.rangeW;
          if (o.losBonus && clear(cx, cy, o.tgt.x, o.tgt.y, s.obstacles, 3)) cost -= o.losBonus;
        }
        const z = s.zone;
        if (z.active) { const zd = hyp(cx - z.x, cy - z.y); if (zd > z.r - 70) cost += (zd - z.r + 70) * 2; }
        // inertie (évite les oscillations)
        if (rad > 0 && m.lastDir !== undefined) cost += Math.abs(angDiff(a, m.lastDir)) * 3;
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
    const pool = vis.length ? vis : s.enemies;
    if (!pool.length) return {};
    let tgt = null, best = -Infinity;
    for (const e of pool) {
      const sc = (100 - e.hp) * 1.3 - e.dist * 0.1 + e.recentDamage * 1.2 + (e.visible ? 20 : 0) + (m.tgt === e.id ? 25 : 0);
      if (sc > best) { best = sc; tgt = e; }
    }
    m.tgt = tgt.id;
    const d = tgt.dist;
    const inDuel = tgt.recentDamage >= 20 && Math.abs(angDiff(tgt.turretAngle, Math.atan2(me.y - tgt.y, me.x - tgt.x))) > 0.5;
    // un 3e tank qui nous voit = risque de se faire "third-party" pendant la charge
    const watchers = vis.filter((e) => e.id !== tgt.id && e.dist < 560).length;
    const opening = tgt.hp <= 50 || inDuel || me.hp - tgt.hp >= 30;
    const commit = s.aliveCount <= 2 || s.zone.active || tgt.hp <= 25 || (opening && watchers === 0) || (m.commitUntil || 0) > s.tick;
    if (commit && !(m.commitUntil > s.tick)) m.commitUntil = s.tick + 90; // une fois lancé, on va au bout
    if (watchers > 0 && me.hp < 40 && s.aliveCount > 2 && !s.zone.active) m.commitUntil = 0; // repli si un rôdeur arrive
    m.mode = commit ? 'ENGAGE' : 'STALK';

    const goal = commit
      ? plan(s, { tgt, range: 140, rangeW: 1.1, expo: 22, expoT: 0, losBonus: 25 })
      : plan(s, { tgt, range: 380, rangeW: 0.35, expo: 30, expoT: 30, losBonus: 0 });

    let out = goal && goal.rad > 0 ? driveDir(me, Math.atan2(goal.y - me.y, goal.x - me.x), cfg, 1) : { throttle: 0, turnChassis: 0 };

    // menace imminente (vitesse relative)
    let urgent = null;
    for (const b of s.bullets) {
      if (!threatening(b)) continue;
      const rvx = b.vx - me.vx, rvy = b.vy - me.vy, vv = rvx * rvx + rvy * rvy;
      const rx = me.x - b.x, ry = me.y - b.y; const t = (rx * rvx + ry * rvy) / vv;
      if (t < 0 || t > 10) continue;
      const cx = me.x - (b.x + rvx * t), cy = me.y - (b.y + rvy * t); const cd = hyp(cx, cy);
      if (cd < me.radius + 5 && (!urgent || t < urgent.t)) {
        let nx, ny; if (cd > 0.5) { nx = cx / cd; ny = cy / cd; } else { const vl = Math.sqrt(vv); nx = -rvy / vl; ny = rvx / vl; }
        urgent = { t, nx, ny };
      }
    }

    // visée / tir
    const p = tgt.visible ? (intercept(me.x, me.y, tgt.x, tgt.y, tgt.vx, tgt.vy, cfg.BULLET_SPEED) || tgt) : tgt;
    const aim = Math.atan2(p.y - me.y, p.x - me.x);
    out.aimTurret = clamp(angDiff(me.turretAngle, aim) / cfg.TURRET_TURN, -1, 1);
    const tol = Math.atan2(cfg.TANK_R * 0.8, Math.max(40, d));
    const range = commit ? 700 : 450;
    out.shoot = tgt.visible && d < range && Math.abs(angDiff(me.turretAngle, aim)) < tol && clear(me.x, me.y, p.x, p.y, s.obstacles, cfg.BULLET_R + 2);

    if (me.dashCd <= 0) {
      if (urgent && urgent.t < 8) out.dash = Math.atan2(urgent.ny, urgent.nx);
      else if (commit && tgt.visible && tgt.hp <= 40 && tgt.dashCd > 30 && d > 200 && d < 340 && clear(me.x, me.y, tgt.x, tgt.y, s.obstacles, cfg.TANK_R)) out.dash = Math.atan2(tgt.y - me.y, tgt.x - me.x);
    }
    return out;
  }

  return { key: 'berserker', name: 'Berserker', color: '#ff2a6d', version: 'gen3', decide };
});
