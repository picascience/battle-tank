/*
 * TRICKSTER (Violet) — GEN 4 "Ray-Tracer"
 * Diagnostic Gen 3 (49 % -> 33 % -> 7,6 %, jamais modifié depuis la Gen 1) :
 *   - 1926 auto-impacts et 157 morts sans tueur : ses tirs par la bande lui reviennent dessus
 *   - précision 10,7 % : le miroir géométrique ignore le temps de vol réel (trajet 2x plus long)
 *     face à des cibles qui strafent désormais ; il tirait même en bande quand le tir direct était meilleur
 *   - orbite prévisible à 320 px exposée à 3 lignes de vue
 * Gen 4 :
 *   - SIMULATION BALISTIQUE COMPLÈTE : chaque angle candidat (direct, 4 bandes, perturbations) est
 *     ray-tracé tick par tick avec la vraie physique (rebonds murs + obstacles, durée de vie) contre la
 *     position FUTURE de la cible ; on garde le temps d'impact le plus court
 *   - garde-fou anti-suicide : tout tir dont le rebond repasse près de sa propre trajectoire est refusé
 *   - gâchette "vérifiée" : il ne tire que si l'angle ACTUEL du canon est un impact simulé
 *   - planificateur par échantillonnage qui cherche les positions HORS lignes de vue : il tire depuis
 *     la couverture grâce aux bandes (sur cibles vues il y a < 25 ticks, position extrapolée)
 */
(function (root, factory) {
  const bot = factory();
  if (typeof module === 'object' && module.exports) module.exports = bot;
  else { root.CTA_BOTS = root.CTA_BOTS || {}; root.CTA_BOTS[bot.key] = bot; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const hyp = (x, y) => Math.sqrt(x * x + y * y);
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
  const threatening = (b) => !(b.mine && b.bounces > 0);

  /** Ray-tracing d'un tir avec la physique exacte du moteur. */
  function simShot(s, ang, tgt) {
    const cfg = s.cfg, me = s.self, R = cfg.TANK_R, BR = cfg.BULLET_R, W = cfg.W, H = cfg.H;
    const L = R + 8;
    let x = me.x + Math.cos(ang) * L, y = me.y + Math.sin(ang) * L;
    let vx = Math.cos(ang) * cfg.BULLET_SPEED, vy = Math.sin(ang) * cfg.BULLET_SPEED, bounces = cfg.BULLET_BOUNCES;
    const hitR2 = (R + BR - 3) * (R + BR - 3), selfR2 = (R + BR + 18) * (R + BR + 18);
    for (let t = 1; t <= cfg.BULLET_LIFE; t++) {
      x += vx; y += vy;
      if (x < BR || x > W - BR) { if (!bounces) return null; vx = -vx; x = x < BR ? 2 * BR - x : 2 * (W - BR) - x; bounces--; }
      if (y < BR || y > H - BR) { if (!bounces) return null; vy = -vy; y = y < BR ? 2 * BR - y : 2 * (H - BR) - y; bounces--; }
      for (const o of s.obstacles) {
        const dx = x - o.x, dy = y - o.y, rr = o.r + BR;
        if (dx * dx + dy * dy < rr * rr) {
          if (!bounces || o.hp <= cfg.BULLET_DMG) return null;
          const d = Math.sqrt(dx * dx + dy * dy) || 1, nx = dx / d, ny = dy / d, vn = vx * nx + vy * ny;
          vx -= 2 * vn * nx; vy -= 2 * vn * ny; x = o.x + nx * (rr + 0.5); y = o.y + ny * (rr + 0.5); bounces--;
          break;
        }
      }
      const tx = clamp(tgt.x + tgt.vx * t, R, W - R), ty = clamp(tgt.y + tgt.vy * t, R, H - R);
      if ((x - tx) * (x - tx) + (y - ty) * (y - ty) < hitR2) return { t, bank: bounces < cfg.BULLET_BOUNCES };
      if (bounces < cfg.BULLET_BOUNCES) { // la balle a rebondi : peut-elle me toucher ?
        const k = Math.min(t, 25), mx = me.x + me.vx * k, my = me.y + me.vy * k;
        if ((x - mx) * (x - mx) + (y - my) * (y - my) < selfR2) return null;
      }
    }
    return null;
  }

  /** Angles candidats : interception directe + 4 bandes (miroir de la position future), +/- perturbations */
  function candidateAngles(s, tgt) {
    const me = s.self, cfg = s.cfg, BR = cfg.BULLET_R, v = cfg.BULLET_SPEED;
    const out = [];
    const lead = (len) => { const t = len / v; return [clamp(tgt.x + tgt.vx * t, 0, cfg.W), clamp(tgt.y + tgt.vy * t, 0, cfg.H)]; };
    let [px, py] = lead(hyp(tgt.x - me.x, tgt.y - me.y));
    for (let i = 0; i < 2; i++) [px, py] = lead(hyp(px - me.x, py - me.y));
    const a0 = Math.atan2(py - me.y, px - me.x);
    for (const da of [0, -0.02, 0.02, -0.045, 0.045]) out.push(a0 + da);
    const walls = [['x', BR], ['x', cfg.W - BR], ['y', BR], ['y', cfg.H - BR]];
    for (const [axis, w] of walls) {
      let [qx, qy] = [tgt.x, tgt.y];
      for (let i = 0; i < 3; i++) {
        const mx = axis === 'x' ? 2 * w - qx : qx, my = axis === 'y' ? 2 * w - qy : qy;
        [qx, qy] = lead(hyp(mx - me.x, my - me.y));
      }
      const mx = axis === 'x' ? 2 * w - qx : qx, my = axis === 'y' ? 2 * w - qy : qy;
      const ab = Math.atan2(my - me.y, mx - me.x);
      for (const da of [0, -0.015, 0.015]) out.push(ab + da);
    }
    return out;
  }

  function plan(s, o) {
    const me = s.self, cfg = s.cfg, m = s.memory, R = cfg.TANK_R;
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
          if (cd < R + 16) cost += (R + 16 - cd) * 4.5 / (1 + t * 0.04);
        }
        for (const e of watchers) {
          const ed = hyp(cx - e.x, cy - e.y);
          if (ed > cfg.VISION || !clear(cx, cy, e.x, e.y, s.obstacles, 2)) continue;
          cost += o.expo * (0.4 + e.hp / 100) * (ed < 300 ? 1.4 : 1);
        }
        if (o.tgt) cost += Math.abs(hyp(cx - o.tgt.x, cy - o.tgt.y) - o.range) * o.rangeW;
        // rester loin des coins (les bandes y sont impossibles et on s'y fait coincer)
        const edge = Math.min(cx, cy, cfg.W - cx, cfg.H - cy); if (edge < 110) cost += (110 - edge) * 0.25;
        const z = s.zone;
        if (z.active) { const zd = hyp(cx - z.x, cy - z.y); if (zd > z.r - 70) cost += (zd - z.r + 70) * 2; }
        if (rad > 0 && m.lastDir !== undefined) cost += Math.abs(angDiff(a, m.lastDir)) * 3;
        if (rad === 0) cost += 5;
        if (!best || cost < best.cost) best = { x: cx, y: cy, cost, a, rad };
      }
    }
    if (best && best.rad > 0) m.lastDir = best.a;
    m.planGoal = best; m.planTick = s.tick;
    return best;
  }

  function decide(s) {
    const me = s.self, cfg = s.cfg, m = s.memory;
    if (!s.enemies.length) return {};
    // cibles tirables : visibles, ou vues il y a < 25 ticks (position extrapolée -> tir de bande à l'aveugle)
    const shootable = [];
    for (const e of s.enemies) {
      const age = s.tick - e.lastSeenTick;
      if (age > 25) continue;
      shootable.push(e.visible ? e : Object.assign({}, e, { x: clamp(e.x + e.vx * age, 20, cfg.W - 20), y: clamp(e.y + e.vy * age, 20, cfg.H - 20) }));
    }
    let tgt = null, best = -Infinity;
    for (const e of (shootable.length ? shootable : s.enemies)) {
      const sc = -e.dist * 0.1 + (100 - e.hp) * 0.7 + e.recentDamage * 0.5 + (m.tgt === e.id ? 15 : 0);
      if (sc > best) { best = sc; tgt = e; }
    }
    m.tgt = tgt.id;

    // ---------- déplacement ----------
    const lowHp = me.hp < 40 && s.aliveCount > 2;
    const goal = plan(s, { tgt, range: s.aliveCount <= 2 ? 320 : 400, rangeW: 0.3, expo: lowHp ? 34 : 22 });
    const out = goal && goal.rad > 0 ? driveDir(me, Math.atan2(goal.y - me.y, goal.x - me.x), cfg, 1) : { throttle: 0, turnChassis: 0 };

    // ---------- esquive d'urgence (produit vectoriel, vitesse relative) ----------
    if (me.dashCd <= 0) {
      let urgent = null;
      for (const b of s.bullets) {
        if (!threatening(b)) continue;
        const rvx = b.vx - me.vx, rvy = b.vy - me.vy, vv = rvx * rvx + rvy * rvy;
        const rx = me.x - b.x, ry = me.y - b.y, t = (rx * rvx + ry * rvy) / vv;
        if (t < 0 || t > 8) continue;
        const cd = hyp(me.x - (b.x + rvx * t), me.y - (b.y + rvy * t));
        if (cd < me.radius + 5 && (!urgent || t < urgent.t)) {
          const cross = rvx * ry - rvy * rx, sgn = cross >= 0 ? 1 : -1, vl = Math.sqrt(vv);
          urgent = { t, nx: (-rvy / vl) * sgn, ny: (rvx / vl) * sgn };
        }
      }
      if (urgent) out.dash = Math.atan2(urgent.ny, urgent.nx);
    }

    // ---------- visée par ray-tracing ----------
    const ready = shootable.some((e) => e.id === tgt.id);
    if (ready && (s.tick % 3 === 0 || m.aimTgt !== tgt.id || m.aim === undefined)) {
      let bestShot = null;
      for (const a of candidateAngles(s, tgt)) {
        const r = simShot(s, a, tgt); if (!r) continue;
        const cost = r.t + (r.bank ? 4 : 0) + Math.abs(angDiff(me.turretAngle, a)) / cfg.TURRET_TURN; // le temps de rotation compte
        if (!bestShot || cost < bestShot.cost) bestShot = { a, cost };
      }
      m.aim = bestShot ? bestShot.a : Math.atan2(tgt.y - me.y, tgt.x - me.x); m.aimTgt = tgt.id; m.aimOk = !!bestShot;
    }
    const aim = m.aim !== undefined ? m.aim : Math.atan2(tgt.y - me.y, tgt.x - me.x);
    out.aimTurret = clamp(angDiff(me.turretAngle, aim) / cfg.TURRET_TURN, -1, 1);
    // gâchette vérifiée : le canon, tel qu'il est orienté MAINTENANT, produit-il un impact sûr ?
    out.shoot = false;
    if (ready && m.aimOk && me.shootCd <= 0 && me.energy >= cfg.SHOT_COST && Math.abs(angDiff(me.turretAngle, aim)) < 0.06) {
      out.shoot = !!simShot(s, me.turretAngle, tgt);
    }
    return out;
  }

  return { key: 'trickster', name: 'Trickster', color: '#b44dff', version: 'gen4', decide };
});
