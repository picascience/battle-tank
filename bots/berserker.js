/*
 * BERSERKER (Rouge Néon) — GEN 5 "Juggernaut"
 * Constat Gen 4 : à armes identiques, l'archétype corps-à-corps est structurellement perdant
 * (0,4 %). Gen 5 = changement de CHÂSSIS (traits du moteur), avec contrepartie :
 *   + blindage frontal : -50 % de dégâts pour les balles arrivant dans le cône avant (±45°)
 *   + éperon : 6 dégâts + bonus de vitesse d'impact (max 20) en percutant nez en avant
 *   - canon court : balles de 70 ticks au lieu de 170 (portée ~560 px au lieu de ~1360)
 * Comportement : marche avant forcée en engagement (blindage face à la cible), charge de contact
 * sous 160 px, dash-bélier, et à l'arrêt il présente son avant à la menace la plus proche.
 * (testé puis rejeté : engagement précoce dès qu'un seul tank surveille -> classement 2,92 -> 3,19)
 * --- historique Gen 4 "Stalker II" ---
 * Diagnostic Gen 3 (4 %) + mesures dans la méta Gen 4 : 74 % de ses dégâts sont encaissés en phase de
 * traque, et 70 % des impacts reçus arrivent quand il est à moins de 120 px d'un mur (coincé, exposé
 * aux bandes du nouveau Trickster) ; 212 auto-impacts.
 * Gen 4 :
 *   - coût de bord dans le planificateur (les murs sont des pièges)
 *   - gâchette vérifiée par la simulation balistique complète (plus d'auto-impacts ni de tirs perdus)
 *   - tourelle furtive en traque : le canon ne pointe sur personne tant qu'il ne frappe pas
 *   - (testé puis rejeté : traque lointaine à 620 px, "vendetta" contre le dernier agresseur)
 * --- historique Gen 3 ---
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
  function driveForward(me, dir, cfg) {
    const d = angDiff(me.angle, dir); const c = Math.cos(d);
    return { throttle: c > 0.3 ? c : 0.15, turnChassis: clamp(d / cfg.CHASSIS_TURN, -1, 1) };
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

  /** Ray-tracing d'un tir avec la physique exacte du moteur. */
  function simShot(s, ang, tgt) {
    const cfg = s.cfg, me = s.self, R = cfg.TANK_R, BR = cfg.BULLET_R, W = cfg.W, H = cfg.H;
    const L = R + 8;
    let x = me.x + Math.cos(ang) * L, y = me.y + Math.sin(ang) * L;
    let vx = Math.cos(ang) * cfg.BULLET_SPEED, vy = Math.sin(ang) * cfg.BULLET_SPEED, bounces = cfg.BULLET_BOUNCES;
    const hitR2 = (R + BR - 3) * (R + BR - 3), selfR2 = (R + BR + 18) * (R + BR + 18);
    for (let t = 1, life = (me.traits && me.traits.bulletLife) || cfg.BULLET_LIFE; t <= life; t++) {
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
        // Gen 4 : les murs sont des pièges (bandes adverses, aucune échappatoire) -> coût de bord
        const edge = Math.min(cx, cy, cfg.W - cx, cfg.H - cy); if (edge < 150) cost += (150 - edge) * 0.35;
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
    // Gen 4 : la rage se déchaîne quand l'arène se resserre (tempête / 1v1) ou sur une proie à l'agonie
    const opening = tgt.hp <= 50 || inDuel || me.hp - tgt.hp >= 30;
    const commit = s.aliveCount <= 2 || s.zone.active || (opening && watchers === 0) || (m.commitUntil || 0) > s.tick;
    if (commit && !(m.commitUntil > s.tick)) m.commitUntil = s.tick + 90; // une fois lancé, on va au bout
    if (watchers > 0 && me.hp < 40 && s.aliveCount > 2 && !s.zone.active) m.commitUntil = 0; // repli si un rôdeur arrive
    m.mode = commit ? 'ENGAGE' : 'STALK';

    const goal = commit
      ? plan(s, { tgt, range: 130, rangeW: 1.1, expo: 20, expoT: 0, losBonus: 25 })
      : plan(s, { tgt, range: 380, rangeW: 0.35, expo: 30, expoT: 30, losBonus: 0 });

    let out = goal && goal.rad > 0 ? driveDir(me, Math.atan2(goal.y - me.y, goal.x - me.x), cfg, 1) : { throttle: 0, turnChassis: 0 };
    // GEN 5 — BLINDAGE FRONTAL : en engagement on avance TOUJOURS nez en avant (jamais en marche arrière)
    const toT = Math.atan2(tgt.y - me.y, tgt.x - me.x);
    if (commit && goal && goal.rad > 0) out = driveForward(me, Math.atan2(goal.y - me.y, goal.x - me.x), cfg);
    // charge finale : à moins de 160 px on fonce droit dans la cible pour l'éperonner
    if (commit && tgt.visible && d < 160) out = driveForward(me, toT, cfg);
    // à l'arrêt : présenter l'avant blindé à la menace principale
    if (!(goal && goal.rad > 0)) {
      let threat = null; for (const e of vis) if (!threat || e.dist < threat.dist) threat = e;
      if (threat) out.turnChassis = clamp(angDiff(me.angle, Math.atan2(threat.y - me.y, threat.x - me.x)) / cfg.CHASSIS_TURN, -1, 1);
    }

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
    // TOURELLE FURTIVE : en traque, le canon ne pointe sur personne (Warlord et Sniper ciblent en
    // priorité "celui qui me vise") ; il ne se braque qu'au moment de frapper
    const strike = commit || (tgt.visible && tgt.hp <= 40 && d < 450) || (tgt.visible && s.tick - me.lastHitTick < 90 && me.lastHitBy === tgt.id);
    let turretGoal = aim;
    if (!strike) {
      let bestA = aim, bestClear = -1;
      for (const off of [0.5, -0.5, 0.8, -0.8]) {
        const a = aim + off; let minSep = Math.PI;
        for (const e of vis) minSep = Math.min(minSep, Math.abs(angDiff(a, Math.atan2(e.y - me.y, e.x - me.x))));
        if (minSep > bestClear) { bestClear = minSep; bestA = a; }
      }
      turretGoal = bestA;
    }
    out.aimTurret = clamp(angDiff(me.turretAngle, turretGoal) / cfg.TURRET_TURN, -1, 1);
    const tol = Math.atan2(cfg.TANK_R * 0.8, Math.max(40, d));
    const range = strike ? 700 : 450;
    // gâchette vérifiée par simulation balistique (fini les auto-impacts et les tirs perdus)
    out.shoot = tgt.visible && d < range && me.shootCd <= 0 && me.energy >= cfg.SHOT_COST && Math.abs(angDiff(me.turretAngle, aim)) < tol * 2 && !!simShot(s, me.turretAngle, tgt);

    if (me.dashCd <= 0) {
      // dash-bélier : impact à grande vitesse, nez en avant (jusqu'à 20 dégâts)
      if (commit && tgt.visible && me.ramCd <= 0 && d < 150 && Math.abs(angDiff(me.angle, toT)) < 0.35 && clear(me.x, me.y, tgt.x, tgt.y, s.obstacles, cfg.TANK_R)) out.dash = toT;
      else if (urgent && urgent.t < 8) out.dash = Math.atan2(urgent.ny, urgent.nx);
      else if (commit && tgt.visible && tgt.hp <= 40 && tgt.dashCd > 30 && d > 200 && d < 340 && clear(me.x, me.y, tgt.x, tgt.y, s.obstacles, cfg.TANK_R)) out.dash = Math.atan2(tgt.y - me.y, tgt.x - me.x);
    }
    return out;
  }

  return { key: 'berserker', name: 'Berserker', color: '#ff2a6d', version: 'gen5', decide,
    // Châssis 'Juggernaut' : blindage frontal (-50 % de dégâts dans le cône avant), éperon, mais canon court
    traits: { frontArmor: 0.5, ramDamage: 6, bulletLife: 70 } };
});
