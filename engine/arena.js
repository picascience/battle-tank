/*
 * CYBER-TANK ARENA : AI EVOLUTION — moteur de jeu
 * JavaScript pur, sans DOM : fonctionne sous Node.js (require) et dans le navigateur (window.CTA).
 * Déterministe : un même seed + mêmes bots => exactement le même match (permet de re-simuler un
 * match pour en enregistrer le replay sans payer le coût d'enregistrement sur les 500 matchs).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CTA = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = Object.freeze({
    W: 1000, H: 1000, TICKS_PER_SEC: 60,
    MAX_TICKS: 1500,        // fin du temps réglementaire -> tempête
    STORM_DURATION: 600,    // durée du rétrécissement de la zone
    HARD_CAP: 2400,         // arrêt absolu (victoire aux PV)
    TANK_R: 18, ACCEL: 0.24, DAMPING: 0.92,
    CHASSIS_TURN: 0.07, TURRET_TURN: 0.12,
    MAX_HP: 100, MAX_ENERGY: 100, ENERGY_REGEN: 0.8, SHOT_COST: 25, SHOT_CD: 12,
    DASH_CD: 180, DASH_IMPULSE: 9,
    BULLET_SPEED: 8, BULLET_R: 4, BULLET_DMG: 10, BULLET_LIFE: 170, BULLET_BOUNCES: 1,
    OBSTACLE_HP: 200, VISION: 700, BULLET_SENSE: 450,
    STORM_START_R: 720, STORM_END_R: 50, STORM_DMG: 0.35, RECENT_WINDOW: 90,
    CRATE_HEAL: 50, CRATE_R: 16     // caisse de soin
  });

  // ---------- utilitaires ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const r1 = (v) => Math.round(v * 10) / 10;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  /**
   * Traits de châssis (optionnels, déclarés par le module du bot via `traits`). Chaque avantage a
   * une contrepartie, et les valeurs sont bornées par le moteur.
   *  - frontArmor : réduction des dégâts des balles arrivant dans le cône avant (±45°) du châssis
   *  - ramDamage  : dégâts de base infligés en percutant un tank (+ bonus selon la vitesse d'impact)
   *  - bulletLife : durée de vie des balles (canon court = portée réduite)
   */
  const TRAIT_LIMITS = { frontArmor: [0, 0.5], ramDamage: [0, 8], bulletLife: [60, CFG.BULLET_LIFE] };
  function sanitizeTraits(tr) {
    const out = { frontArmor: 0, ramDamage: 0, bulletLife: CFG.BULLET_LIFE };
    if (tr && typeof tr === 'object') for (const k in TRAIT_LIMITS) if (typeof tr[k] === 'number' && isFinite(tr[k])) out[k] = clamp(tr[k], TRAIT_LIMITS[k][0], TRAIT_LIMITS[k][1]);
    return out;
  }
  function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

  /** distance d'un point au segment [a,b] */
  function segPointDist(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
    const qx = ax + dx * t - px, qy = ay + dy * t - py; return Math.sqrt(qx * qx + qy * qy);
  }
  function lineOfSight(ax, ay, bx, by, obstacles, pad) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]; if (!o.alive) continue;
      if (segPointDist(ax, ay, bx, by, o.x, o.y) < o.r + (pad || 0)) return false;
    }
    return true;
  }

  /** 1 obstacle central + 4 obstacles en symétrie de rotation (90°), paramètres tirés du seed */
  function makeObstacles(rng) {
    const c = CFG.W / 2; const rot = rng() * Math.PI / 2;
    const d = 200 + rng() * 90, r = 36 + rng() * 16;
    const obs = [{ x: c, y: c, r: 62 + rng() * 14 }];
    for (let k = 0; k < 4; k++) {
      const a = rot + k * Math.PI / 2; obs.push({ x: c + Math.cos(a) * d, y: c + Math.sin(a) * d, r });
    }
    return obs.map((o, i) => ({ id: i, x: r1(o.x), y: r1(o.y), r: r1(o.r), hp: CFG.OBSTACLE_HP, maxHp: CFG.OBSTACLE_HP, alive: true }));
  }

  // ---------- Match ----------
  class Match {
    /**
     * @param {{bots:Array<{key,name,color,decide}>, seed:number, record?:boolean}} opts
     */
    constructor(opts) {
      this.seed = opts.seed >>> 0;
      this.rng = mulberry32(this.seed ^ 0xA5A5A5A5);
      this.record = !!opts.record;
      this.tick = 0; this.over = false; this.winner = -1; this.endReason = null;
      this.obstacles = makeObstacles(this.rng);
      // délai de tempête (modifiable en cours de match) et alliances (équipe -1 = en solo)
      this.maxTicks = CFG.MAX_TICKS; this.hardCap = CFG.HARD_CAP;
      this.teams = (opts.bots || []).map((b, i) => (opts.teams && Number.isInteger(opts.teams[i]) ? opts.teams[i] : -1));
      this.crate = null; this.pending = []; this.crateSeek = opts.crateSeek !== false;
      this.bullets = []; this.nextBulletId = 1;
      this.events = []; this.frames = this.record ? [] : null;
      this.deathOrder = []; this.totalHits = 0; this.totalDamage = 0;
      const W = CFG.W, H = CFG.H, m = 90;
      const corners = [[m, m], [W - m, m], [W - m, H - m], [m, H - m]];
      for (let i = corners.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [corners[i], corners[j]] = [corners[j], corners[i]]; }
      this.tanks = opts.bots.map((b, i) => {
        const [x, y] = corners[i % 4]; const a = Math.atan2(H / 2 - y, W / 2 - x);
        return {
          id: i, key: b.key, name: b.name, color: b.color, decide: b.decide, traits: sanitizeTraits(b.traits), ramCd: 0,
          x, y, vx: 0, vy: 0, angle: a, turretAngle: a,
          hp: CFG.MAX_HP, energy: CFG.MAX_ENERGY, shootCd: 0, dashCd: 60,
          alive: true, deathTick: null, killedBy: null, lastHitBy: -1, lastHitTick: -999,
          memory: {}, rng: mulberry32((this.seed + 1) * 2654435761 + i * 40503),
          lastSeen: {}, damageLog: [], errors: 0, lastAction: null,
          stats: { shots: 0, hits: 0, damageDealt: 0, damageTaken: 0, dodges: 0, kills: 0, selfHits: 0,
            bankHits: 0, stormDamage: 0, dashes: 0, survival: 0, hitsBy: {}, rams: 0, armorBlocked: 0 }
        };
      });
      // initialisation de la mémoire "dernière position connue" (les spawns sont publics)
      for (const t of this.tanks) for (const o of this.tanks) if (o !== t) t.lastSeen[o.id] = { x: o.x, y: o.y, vx: 0, vy: 0, hp: o.hp, tick: 0 };
      if (this.record) this.frames.push(this.snapshot());
    }

    /** deux tanks distincts de la même équipe (>= 0) sont alliés : pas de dégâts entre eux */
    allied(a, b) { return a !== b && this.teams[a] >= 0 && this.teams[a] === this.teams[b]; }
    setTeams(teams) { this.teams = this.tanks.map((t, i) => (Number.isInteger(teams[i]) ? teams[i] : -1)); }
    /** soigne un tank vivant ; renvoie les PV réellement rendus */
    heal(id, amount) {
      const t = this.tanks[id]; if (!t || !t.alive || this.over) return 0;
      const before = t.hp; t.hp = Math.min(CFG.MAX_HP, t.hp + (amount === undefined ? 50 : amount));
      return t.hp - before;
    }
    /** fait apparaître une caisse de soin à un endroit libre ; false s'il y en a déjà une */
    spawnCrate() {
      if (this.crate || this.over) return false;
      const z = this.zone(), m = 110;
      for (let n = 0; n < 80; n++) {
        const x = m + this.rng() * (CFG.W - 2 * m), y = m + this.rng() * (CFG.H - 2 * m);
        if (Math.hypot(x - z.x, y - z.y) > z.r - 70) continue;
        if (this.obstacles.some((o) => o.alive && Math.hypot(x - o.x, y - o.y) < o.r + 45)) continue;
        if (this.tanks.some((t) => t.alive && Math.hypot(x - t.x, y - t.y) < 120)) continue;
        this.crate = { x: r1(x), y: r1(y), heal: CFG.CRATE_HEAL };
        this.pending.push({ k: 'crateSpawn', x: this.crate.x, y: this.crate.y });
        return true;
      }
      return false;
    }
    /** pilotage vers la caisse : remplace le déplacement du bot (tir, visée et dash restent les siens) */
    seekCrate(t, a) {
      const c = this.crate; let tx = c.x, ty = c.y;
      for (const o of this.obstacles) { // contournement d'un obstacle sur la trajectoire
        if (!o.alive || segPointDist(t.x, t.y, c.x, c.y, o.x, o.y) >= o.r + CFG.TANK_R + 6) continue;
        const dx = c.x - t.x, dy = c.y - t.y, l2 = dx * dx + dy * dy || 1;
        const u = clamp(((o.x - t.x) * dx + (o.y - t.y) * dy) / l2, 0, 1);
        let vx = o.x - (t.x + dx * u), vy = o.y - (t.y + dy * u), vl = Math.hypot(vx, vy);
        if (vl < 1) { vx = -dy; vy = dx; vl = Math.hypot(vx, vy) || 1; }
        const k = o.r + CFG.TANK_R + 35; tx = o.x - vx / vl * k; ty = o.y - vy / vl * k; break;
      }
      const diff = wrapAngle(Math.atan2(ty - t.y, tx - t.x) - t.angle);
      return Object.assign({}, a, { turnChassis: clamp(diff / CFG.CHASSIS_TURN, -1, 1), throttle: Math.abs(diff) < 1.0 ? 1 : 0.25 });
    }
    /** repousse l'arrivée de la tempête (en ticks) */
    delayStorm(ticks) { this.maxTicks += ticks; this.hardCap += ticks; }

    zone() {
      const t = this.tick - this.maxTicks;
      if (t < 0) return { active: false, x: CFG.W / 2, y: CFG.H / 2, r: CFG.STORM_START_R };
      const k = clamp(t / CFG.STORM_DURATION, 0, 1);
      return { active: true, x: CFG.W / 2, y: CFG.H / 2, r: CFG.STORM_START_R + (CFG.STORM_END_R - CFG.STORM_START_R) * k };
    }

    recentDamage(t) {
      let s = 0; const lim = this.tick - CFG.RECENT_WINDOW;
      for (let i = t.damageLog.length - 1; i >= 0; i--) { if (t.damageLog[i][0] < lim) break; s += t.damageLog[i][1]; }
      return s;
    }

    /** Capteurs : ce que le tank `t` perçoit (brouillard de guerre) */
    buildState(t) {
      const enemies = [], allies = [];
      for (const o of this.tanks) {
        if (o === t || !o.alive) continue;
        if (this.allied(t.id, o.id)) { allies.push({ id: o.id, name: o.name, x: o.x, y: o.y, vx: o.vx, vy: o.vy, angle: o.angle, turretAngle: o.turretAngle, hp: o.hp }); continue; }
        const dx = o.x - t.x, dy = o.y - t.y; const d = Math.sqrt(dx * dx + dy * dy);
        const visible = d <= CFG.VISION && lineOfSight(t.x, t.y, o.x, o.y, this.obstacles, 0);
        if (visible) {
          t.lastSeen[o.id] = { x: o.x, y: o.y, vx: o.vx, vy: o.vy, hp: o.hp, tick: this.tick };
          enemies.push({ id: o.id, name: o.name, visible: true, x: o.x, y: o.y, vx: o.vx, vy: o.vy, angle: o.angle,
            turretAngle: o.turretAngle, hp: o.hp, dashCd: o.dashCd, energy: o.energy, recentDamage: this.recentDamage(o), traits: o.traits,
            lastSeenTick: this.tick, dist: d });
        } else {
          const ls = t.lastSeen[o.id];
          const ddx = ls.x - t.x, ddy = ls.y - t.y;
          enemies.push({ id: o.id, name: o.name, visible: false, x: ls.x, y: ls.y, vx: ls.vx, vy: ls.vy, angle: 0, turretAngle: 0,
            hp: ls.hp, dashCd: 0, energy: 0, recentDamage: 0, traits: o.traits, lastSeenTick: ls.tick, dist: Math.sqrt(ddx * ddx + ddy * ddy) });
        }
      }
      const bullets = [];
      const s2 = CFG.BULLET_SENSE * CFG.BULLET_SENSE;
      for (const b of this.bullets) {
        const dx = b.x - t.x, dy = b.y - t.y;
        if (dx * dx + dy * dy <= s2) bullets.push({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, owner: b.owner, mine: b.owner === t.id, bounces: b.bounces });
      }
      const obstacles = [];
      for (const o of this.obstacles) if (o.alive) obstacles.push({ id: o.id, x: o.x, y: o.y, r: o.r, hp: o.hp });
      return {
        tick: this.tick, maxTicks: this.maxTicks, arena: { w: CFG.W, h: CFG.H }, cfg: CFG,
        self: { id: t.id, name: t.name, x: t.x, y: t.y, vx: t.vx, vy: t.vy, angle: t.angle, turretAngle: t.turretAngle,
          hp: t.hp, maxHp: CFG.MAX_HP, energy: t.energy, maxEnergy: CFG.MAX_ENERGY, shootCd: t.shootCd, dashCd: t.dashCd,
          radius: CFG.TANK_R, recentDamage: this.recentDamage(t), lastHitBy: t.lastHitBy, lastHitTick: t.lastHitTick,
          traits: t.traits, ramCd: t.ramCd, team: this.teams[t.id] },
        crate: this.crate ? { x: this.crate.x, y: this.crate.y, heal: this.crate.heal } : null,
        enemies, allies, bullets, obstacles, zone: this.zone(),
        aliveCount: this.tanks.filter((x) => x.alive).length,
        random: t.rng, memory: t.memory
      };
    }

    emit(e) { this.events.push(e); }

    step() {
      if (this.over) return;
      this.events = this.pending; this.pending = [];
      const tanks = this.tanks;
      // 1) décisions (toutes prises sur le même instant)
      const actions = tanks.map((t) => {
        if (!t.alive) return null;
        let a = null;
        try { a = t.decide(this.buildState(t)) || {}; } catch (err) { t.errors++; if (t.errors < 3 && typeof console !== 'undefined') console.error('[' + t.name + ']', err && err.message); a = {}; }
        return a;
      });
      // 2) application des commandes
      for (const t of tanks) {
        if (!t.alive) continue;
        const a = this.crate && this.crateSeek ? this.seekCrate(t, actions[t.id]) : actions[t.id];
        const throttle = clamp(num(a.throttle, 0), -1, 1);
        t.angle = wrapAngle(t.angle + clamp(num(a.turnChassis, 0), -1, 1) * CFG.CHASSIS_TURN);
        t.turretAngle = wrapAngle(t.turretAngle + clamp(num(a.aimTurret, 0), -1, 1) * CFG.TURRET_TURN);
        t.vx += Math.cos(t.angle) * throttle * CFG.ACCEL;
        t.vy += Math.sin(t.angle) * throttle * CFG.ACCEL;
        if (a.dash && t.dashCd <= 0) {
          const dir = typeof a.dash === 'number' && isFinite(a.dash) ? a.dash : (throttle < 0 ? t.angle + Math.PI : t.angle);
          t.vx += Math.cos(dir) * CFG.DASH_IMPULSE; t.vy += Math.sin(dir) * CFG.DASH_IMPULSE;
          t.dashCd = CFG.DASH_CD; t.stats.dashes++;
          this.emit({ k: 'dash', id: t.id, dir: r3(dir) });
        }
        if (a.shoot && t.shootCd <= 0 && t.energy >= CFG.SHOT_COST) {
          const L = CFG.TANK_R + 8;
          const b = { id: this.nextBulletId++, owner: t.id, x: t.x + Math.cos(t.turretAngle) * L, y: t.y + Math.sin(t.turretAngle) * L,
            vx: Math.cos(t.turretAngle) * CFG.BULLET_SPEED, vy: Math.sin(t.turretAngle) * CFG.BULLET_SPEED,
            bounces: CFG.BULLET_BOUNCES, life: t.traits.bulletLife, minD: {} };
          this.bullets.push(b);
          t.energy -= CFG.SHOT_COST; t.shootCd = CFG.SHOT_CD; t.stats.shots++;
          this.emit({ k: 'shot', id: t.id, b: b.id, x: r1(b.x), y: r1(b.y), a: r3(t.turretAngle) });
        }
        t.energy = Math.min(CFG.MAX_ENERGY, t.energy + CFG.ENERGY_REGEN);
        if (t.shootCd > 0) t.shootCd--;
        if (t.dashCd > 0) t.dashCd--;
        if (t.ramCd > 0) t.ramCd--;
        t.lastAction = a;
      }
      // 3) déplacements + collisions des tanks
      const R = CFG.TANK_R;
      for (const t of tanks) {
        if (!t.alive) continue;
        t.vx *= CFG.DAMPING; t.vy *= CFG.DAMPING;
        t.x += t.vx; t.y += t.vy;
        if (t.x < R) { t.x = R; t.vx = Math.max(0, t.vx); } if (t.x > CFG.W - R) { t.x = CFG.W - R; t.vx = Math.min(0, t.vx); }
        if (t.y < R) { t.y = R; t.vy = Math.max(0, t.vy); } if (t.y > CFG.H - R) { t.y = CFG.H - R; t.vy = Math.min(0, t.vy); }
        for (const o of this.obstacles) {
          if (!o.alive) continue;
          const dx = t.x - o.x, dy = t.y - o.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.001; const min = o.r + R;
          if (d < min) { const nx = dx / d, ny = dy / d; t.x = o.x + nx * min; t.y = o.y + ny * min; const vn = t.vx * nx + t.vy * ny; if (vn < 0) { t.vx -= vn * nx; t.vy -= vn * ny; } }
        }
      }
      for (let i = 0; i < tanks.length; i++) for (let j = i + 1; j < tanks.length; j++) {
        const a = tanks[i], b = tanks[j]; if (!a.alive || !b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
        if (d < 2 * R) {
          const p = (2 * R - d) / 2, nx = dx / d, ny = dy / d; a.x -= nx * p; a.y -= ny * p; b.x += nx * p; b.y += ny * p;
          // éperonnage : vitesse d'approche le long de la normale
          const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          for (const [rammer, victim, sgn] of [[a, b, 1], [b, a, -1]]) {
            if (!rammer.traits.ramDamage || rammer.ramCd > 0 || closing < 1.2 || this.allied(rammer.id, victim.id)) continue;
            // le bélier doit frapper avec l'avant de son châssis
            const toV = Math.atan2(ny * sgn, nx * sgn);
            if (Math.abs(wrapAngle(toV - rammer.angle)) > Math.PI / 3) continue;
            const dmg = Math.min(20, rammer.traits.ramDamage + closing * 1.4);
            this.applyDamage(victim, rammer.id, dmg, 'ram', (a.x + b.x) / 2, (a.y + b.y) / 2);
            rammer.stats.rams++; rammer.ramCd = 30;
            victim.vx += nx * sgn * 4; victim.vy += ny * sgn * 4; // recul
          }
        }
      }
      // 3b) ramassage de la caisse de soin : le tank le plus proche au contact l'emporte
      if (this.crate) {
        let best = null, bd = Infinity;
        for (const t of tanks) {
          if (!t.alive) continue;
          const d = Math.hypot(t.x - this.crate.x, t.y - this.crate.y);
          if (d < R + CFG.CRATE_R && d < bd) { best = t; bd = d; }
        }
        if (best) {
          const got = Math.min(CFG.MAX_HP, best.hp + this.crate.heal) - best.hp; best.hp += got;
          this.emit({ k: 'pickup', id: best.id, x: this.crate.x, y: this.crate.y, heal: r1(got) });
          this.crate = null;
        }
      }
      // 4) projectiles
      const BR = CFG.BULLET_R; const keep = [];
      for (const b of this.bullets) {
        b.x += b.vx; b.y += b.vy; b.life--;
        let dead = b.life <= 0; let hitTank = null;
        // murs de l'arène : 1 rebond
        if (!dead && (b.x < BR || b.x > CFG.W - BR)) {
          if (b.bounces > 0) { b.vx = -b.vx; b.x = b.x < BR ? 2 * BR - b.x : 2 * (CFG.W - BR) - b.x; b.bounces--; this.emit({ k: 'bounce', x: r1(b.x), y: r1(b.y) }); } else dead = true;
        }
        if (!dead && (b.y < BR || b.y > CFG.H - BR)) {
          if (b.bounces > 0) { b.vy = -b.vy; b.y = b.y < BR ? 2 * BR - b.y : 2 * (CFG.H - BR) - b.y; b.bounces--; this.emit({ k: 'bounce', x: r1(b.x), y: r1(b.y) }); } else dead = true;
        }
        // obstacles : destructibles ET rebondissants
        if (!dead) for (const o of this.obstacles) {
          if (!o.alive) continue;
          const dx = b.x - o.x, dy = b.y - o.y; const d = Math.sqrt(dx * dx + dy * dy);
          if (d < o.r + BR) {
            o.hp -= CFG.BULLET_DMG;
            this.emit({ k: 'obs', o: o.id, x: r1(b.x), y: r1(b.y) });
            if (o.hp <= 0) { o.alive = false; o.hp = 0; this.emit({ k: 'obsDown', o: o.id, x: o.x, y: o.y }); }
            if (b.bounces > 0 && o.alive) {
              const nx = dx / (d || 1), ny = dy / (d || 1); const vn = b.vx * nx + b.vy * ny;
              b.vx -= 2 * vn * nx; b.vy -= 2 * vn * ny; b.x = o.x + nx * (o.r + BR + 0.5); b.y = o.y + ny * (o.r + BR + 0.5); b.bounces--;
              this.emit({ k: 'bounce', x: r1(b.x), y: r1(b.y) });
            } else dead = true;
            break;
          }
        }
        // tanks
        if (!dead) for (const t of tanks) {
          if (!t.alive) continue;
          if (t.id === b.owner && b.bounces === CFG.BULLET_BOUNCES) continue; // pas d'auto-dégât avant rebond
          if (this.allied(b.owner, t.id)) continue; // les balles traversent les alliés
          const dx = t.x - b.x, dy = t.y - b.y; const d = Math.sqrt(dx * dx + dy * dy);
          if (t.id !== b.owner && (b.minD[t.id] === undefined || d < b.minD[t.id])) b.minD[t.id] = d;
          if (d < R + BR) { hitTank = t; dead = true; break; }
        }
        if (hitTank) this.applyHit(b, hitTank);
        if (dead) {
          // balles esquivées : passées à moins de 50 px d'un tank sans le toucher
          for (const id in b.minD) { const t = tanks[id]; if (t.alive && t !== hitTank && b.minD[id] < 50) t.stats.dodges++; }
        } else keep.push(b);
      }
      this.bullets = keep;
      // 5) tempête
      const z = this.zone();
      if (z.active) {
        if (this.tick === this.maxTicks) this.emit({ k: 'storm' });
        const dmg = CFG.STORM_DMG * (1 + (this.tick - this.maxTicks) / 300);
        for (const t of tanks) {
          if (!t.alive) continue;
          const dx = t.x - z.x, dy = t.y - z.y;
          if (dx * dx + dy * dy > z.r * z.r) { t.hp -= dmg; t.stats.stormDamage += dmg; t.stats.damageTaken += dmg; }
        }
      }
      // 6) morts
      const dying = tanks.filter((t) => t.alive && t.hp <= 0);
      for (const t of dying) {
        t.alive = false; t.hp = 0; t.deathTick = this.tick;
        const killer = (this.tick - t.lastHitTick < 240 && t.lastHitBy >= 0 && t.lastHitBy !== t.id) ? t.lastHitBy : -1;
        t.killedBy = killer; if (killer >= 0) tanks[killer].stats.kills++;
        this.emit({ k: 'death', id: t.id, by: killer, x: r1(t.x), y: r1(t.y) });
      }
      if (dying.length) this.deathOrder.push(dying.map((t) => t.id));
      this.tick++;
      for (const t of tanks) if (t.alive) t.stats.survival = this.tick;
      // 7) fin de match
      const alive = tanks.filter((t) => t.alive);
      if (alive.length <= 1) { this.finish(alive.length ? alive[0].id : -1, alive.length ? 'last-standing' : 'draw'); }
      else if (alive.every((t) => this.teams[t.id] >= 0 && this.teams[t.id] === this.teams[alive[0].id])) {
        alive.sort((a, b) => b.hp - a.hp); this.finish(alive[0].id, 'team'); // victoire d'équipe
      }
      else if (this.tick >= this.hardCap) {
        alive.sort((a, b) => b.hp - a.hp);
        this.finish(alive[0].hp > alive[1].hp ? alive[0].id : -1, 'hard-cap');
      }
      if (this.record) this.frames.push(this.snapshot());
    }

    applyHit(b, t) {
      let dmg = CFG.BULLET_DMG; const shooter = this.tanks[b.owner];
      // blindage frontal : la balle arrive-t-elle dans le cône avant (±45°) du châssis ?
      let armored = 0;
      if (t.traits.frontArmor > 0 && Math.abs(wrapAngle(Math.atan2(-b.vy, -b.vx) - t.angle)) < Math.PI / 4) {
        const blocked = dmg * t.traits.frontArmor; dmg -= blocked; t.stats.armorBlocked += blocked; armored = 1;
      }
      if (b.owner === t.id) t.stats.selfHits++;
      else {
        shooter.stats.hits++;
        if (b.bounces < CFG.BULLET_BOUNCES) shooter.stats.bankHits++;
        t.stats.hitsBy[b.owner] = (t.stats.hitsBy[b.owner] || 0) + 1;
      }
      this.totalHits++;
      this.applyDamage(t, b.owner, dmg, 'hit', b.x, b.y, { bank: b.bounces < CFG.BULLET_BOUNCES ? 1 : 0, armor: armored });
    }

    applyDamage(t, by, dmg, kind, x, y, extra) {
      t.hp -= dmg; t.stats.damageTaken += dmg; t.damageLog.push([this.tick, dmg]);
      t.lastHitBy = by; t.lastHitTick = this.tick;
      if (by !== t.id) this.tanks[by].stats.damageDealt += dmg;
      this.totalDamage += dmg;
      if (kind === 'ram') this.totalHits++;
      this.emit(Object.assign({ k: kind, by, id: t.id, x: r1(x), y: r1(y), dmg: r1(dmg) }, extra || {}));
    }

    finish(winner, reason) {
      this.over = true; this.winner = winner; this.endReason = reason;
      const alive = this.tanks.filter((t) => t.alive).sort((a, b) => b.hp - a.hp);
      // classement : vivants (par PV) puis morts dans l'ordre inverse de décès
      const placement = {}; let place = 1;
      for (const t of alive) placement[t.id] = place++;
      for (let i = this.deathOrder.length - 1; i >= 0; i--) { const g = this.deathOrder[i]; for (const id of g) placement[id] = place; place += g.length; }
      this.placement = placement;
    }

    run() { while (!this.over) this.step(); return this.result(); }

    result() {
      const w = this.winner >= 0 ? this.tanks[this.winner] : null;
      const totalDashes = this.tanks.reduce((s, t) => s + t.stats.dashes, 0);
      const bankHits = this.tanks.reduce((s, t) => s + t.stats.bankHits, 0);
      // "meilleur match" = serré (vainqueur à peu de PV) + explosif (beaucoup d'impacts, de dashs, de rebonds gagnants)
      const excitement = (w ? (100 - Math.max(0, w.hp)) * 2.2 : 60) + this.totalHits * 1.6 + totalDashes * 0.4 + bankHits * 4 + (this.endReason === 'last-standing' ? 25 : 0);
      return {
        seed: this.seed, ticks: this.tick, winner: this.winner, winnerKey: w ? w.key : null, endReason: this.endReason,
        placement: this.placement, excitement: Math.round(excitement * 10) / 10,
        tanks: this.tanks.map((t) => ({ id: t.id, key: t.key, name: t.name, hp: Math.max(0, r1(t.hp)), alive: t.alive, deathTick: t.deathTick,
          killedBy: t.killedBy, errors: t.errors, stats: t.stats }))
      };
    }

    /** Image compacte du monde (utilisée pour les replays ET le rendu live) */
    snapshot() {
      const f = {
        t: this.tick,
        k: this.tanks.map((t) => [r1(t.x), r1(t.y), r3(t.angle), r3(t.turretAngle), r1(Math.max(0, t.hp)), t.dashCd, Math.round(t.energy), t.alive ? 1 : 0]),
        b: this.bullets.map((b) => [r1(b.x), r1(b.y), b.owner, b.id]),
        o: this.obstacles.map((o) => (o.alive ? o.hp : 0)),
        z: Math.round(this.zone().r)
      };
      if (this.crate) f.c = [this.crate.x, this.crate.y];
      if (this.maxTicks !== CFG.MAX_TICKS) f.m = this.maxTicks;
      if (this.teams.some((x) => x >= 0)) f.tm = this.teams.slice();
      if (this.events.length) f.e = this.events;
      return f;
    }

    meta() {
      return {
        seed: this.seed, cfg: CFG,
        bots: this.tanks.map((t) => ({ id: t.id, key: t.key, name: t.name, color: t.color, traits: t.traits })),
        obstacles: this.obstacles.map((o) => ({ id: o.id, x: o.x, y: o.y, r: o.r, maxHp: o.maxHp }))
      };
    }
  }

  return { CFG, Match, mulberry32, lineOfSight, segPointDist, wrapAngle };
});
