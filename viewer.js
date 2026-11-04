/*
 * CYBER-TANK ARENA — viewer (rendu Canvas, live 60 FPS + lecteur de replays)
 */
(function () {
  'use strict';
  const { Match, CFG } = window.CTA;
  const KEYS = ['berserker', 'sniper', 'trickster', 'warlord'];
  const $ = (id) => document.getElementById(id);
  const canvas = $('arena'), ctx = canvas.getContext('2d');
  const W = CFG.W, H = CFG.H;

  // ---------------- état ----------------
  let src = null;          // { kind:'live'|'replay', meta, frames, match?, title }
  let idx = 0, acc = 0, playing = true, speed = 1;
  let report = null;
  let particles = [], treads = [], ghosts = [], texts = [], rings = [];
  let shake = 0, flash = 0;
  const bulletTrails = new Map();
  let hitFlash = {}, runStats = {}, feed = [], bannerShown = false;
  let teamSel = [-1, -1, -1, -1];   // alliances choisies (-1 = solo, 0 = équipe A, 1 = équipe B)
  const TEAM_COL = ['#00f0ff', '#ffc400'], TEAM_NAME = ['A', 'B'];

  // ---------------- chargement ----------------
  function loadScript(url) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = url + '?v=' + Date.now(); s.onload = res; s.onerror = () => rej(new Error(url)); document.body.appendChild(s); });
  }
  async function loadBots(gen) {
    window.CTA_BOTS = {};
    const base = gen === 'latest' ? 'bots/' : 'bots/archive/' + gen + '/';
    for (const k of KEYS) await loadScript(base + k + '.js');
    return KEYS.map((k) => window.CTA_BOTS[k]);
  }
  async function startLive() {
    setStatus('CHARGEMENT DES IA…');
    const gen = $('botGen').value;
    const bots = await loadBots(gen);
    const seed = (Math.random() * 1e9) >>> 0;
    const match = new Match({ bots, seed, teams: teamSel });
    setSource({ kind: 'live', match, meta: match.meta(), frames: [match.snapshot()],
      title: 'LIVE — IA ' + (gen === 'latest' ? 'dernière version' : gen.replace('_', ' ')) + ' — seed ' + seed });
    markButtons('live');
  }
  async function startReplay(gen) {
    setStatus('CHARGEMENT DU REPLAY GEN ' + gen + '…');
    const r = await fetch('replays/gen_' + gen + '.json?v=' + Date.now()).then((x) => x.json());
    setSource({ kind: 'replay', meta: r.meta, frames: r.frames, title: r.title + ' (seed ' + r.meta.seed + ')', gen });
    markButtons('gen' + gen);
  }
  function setSource(s) {
    src = s; idx = 0; acc = 0; playing = true; bannerShown = false;
    resetFX(); recomputeStats(0); buildTankCards();
    $('banner').className = ''; $('matchTitle').textContent = s.title;
    $('playBtn').textContent = '❚❚';
    setStatus(s.kind === 'live' ? '● LIVE' : '▶ REPLAY');
  }
  function resetFX() { particles = []; treads = []; ghosts = []; texts = []; rings = []; shake = 0; flash = 0; bulletTrails.clear(); hitFlash = {}; feed = []; renderFeed(); }

  // ---------------- avancement du temps ----------------
  function advance() {
    if (!src) return false;
    if (idx < src.frames.length - 1) { idx++; onTick(src.frames[idx], src.frames[idx - 1]); return true; }
    if (src.kind === 'live' && !src.match.over) {
      src.match.step(); src.frames.push(src.match.snapshot()); idx++; onTick(src.frames[idx], src.frames[idx - 1]); return true;
    }
    return false;
  }
  function seek(i) {
    idx = Math.max(0, Math.min(i, src.frames.length - 1));
    resetFX(); recomputeStats(idx); bannerShown = false; $('banner').className = '';
  }
  function recomputeStats(upTo) {
    runStats = {};
    src.meta.bots.forEach((b) => { runStats[b.id] = { shots: 0, hits: 0, dmg: 0, kills: 0, dashes: 0 }; });
    for (let i = 0; i <= upTo; i++) { const f = src.frames[i]; if (f.e) for (const e of f.e) countEvent(e); }
  }
  function countEvent(e, addFeed) {
    const s = runStats;
    if (e.k === 'shot') s[e.id].shots++;
    else if (e.k === 'hit' && e.by !== e.id) { s[e.by].hits++; s[e.by].dmg += e.dmg !== undefined ? e.dmg : CFG.BULLET_DMG; }
    else if (e.k === 'ram') { s[e.by].dmg += e.dmg; s[e.by].rams = (s[e.by].rams || 0) + 1; }
    else if (e.k === 'dash') s[e.id].dashes++;
    else if (e.k === 'death') { if (e.by >= 0) s[e.by].kills++; if (addFeed !== false) pushFeed(e); }
  }

  // ---------------- bruitages (WebAudio synthétisé, aucun fichier) ----------------
  const SFX = (function () {
    let ac = null, master = null, noiseBuf = null, muted = false, vol = 0.5;
    const lastPlay = {};
    function init() {
      if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      ac = new AC(); master = ac.createGain(); master.gain.value = muted ? 0 : vol;
      const comp = ac.createDynamicsCompressor(); master.connect(comp); comp.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    function out(x) {
      if (!ac.createStereoPanner) return master;
      const p = ac.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, ((x === undefined ? W / 2 : x) / W) * 2 - 1)) * 0.8;
      p.connect(master); return p;
    }
    // oscillateur avec glissement de fréquence
    function tone(o) {
      const t = ac.currentTime + (o.delay || 0), osc = ac.createOscillator(), g = ac.createGain();
      osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(o.f0, t);
      if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      osc.connect(g); g.connect(out(o.x)); osc.start(t); osc.stop(t + o.dur + 0.02);
    }
    // bruit filtré
    function noise(o) {
      const t = ac.currentTime + (o.delay || 0), s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = noiseBuf; f.type = o.ftype || 'lowpass'; f.frequency.setValueAtTime(o.fq0, t);
      if (o.fq1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.fq1), t + o.dur);
      g.gain.setValueAtTime(o.vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      s.connect(f); f.connect(g); g.connect(out(o.x)); s.start(t, Math.random() * 0.5); s.stop(t + o.dur + 0.02);
    }
    const sounds = {
      shot: (e) => { tone({ type: 'sawtooth', f0: 900, f1: 140, dur: 0.14, vol: 0.12, x: e.x }); noise({ ftype: 'highpass', fq0: 3000, dur: 0.05, vol: 0.08, x: e.x }); },
      hit: (e) => {
        noise({ fq0: 2500, fq1: 300, dur: 0.18, vol: 0.28, x: e.x }); tone({ type: 'square', f0: 220, f1: 60, dur: 0.15, vol: 0.18, x: e.x });
        if (e.armor) tone({ type: 'triangle', f0: 1400, f1: 900, dur: 0.2, vol: 0.14, x: e.x });
        if (e.bank) tone({ type: 'sine', f0: 600, f1: 1200, dur: 0.18, vol: 0.12, x: e.x });
      },
      ram: (e) => { noise({ fq0: 1800, fq1: 80, dur: 0.45, vol: 0.5, x: e.x }); tone({ type: 'sine', f0: 130, f1: 35, dur: 0.5, vol: 0.5, x: e.x }); tone({ type: 'square', f0: 90, f1: 40, dur: 0.3, vol: 0.2, x: e.x }); },
      bounce: (e) => tone({ type: 'sine', f0: 1500, f1: 700, dur: 0.07, vol: 0.07, x: e.x }),
      obs: (e) => { tone({ type: 'triangle', f0: 520, f1: 380, dur: 0.08, vol: 0.09, x: e.x }); noise({ ftype: 'bandpass', fq0: 1500, dur: 0.05, vol: 0.06, x: e.x }); },
      obsDown: (e) => { const o = src.meta.obstacles[e.o]; const x = o && o.x; noise({ fq0: 3500, fq1: 120, dur: 0.6, vol: 0.4, x }); tone({ type: 'sawtooth', f0: 400, f1: 50, dur: 0.5, vol: 0.18, x }); [0, 0.07, 0.14].forEach((d, i) => tone({ type: 'sine', f0: 1800 - i * 400, f1: 400, dur: 0.15, vol: 0.07, delay: d, x })); },
      dash: (e) => { const t = src.frames[idx].k[e.id]; noise({ ftype: 'bandpass', fq0: 600, fq1: 4500, dur: 0.22, vol: 0.2, x: t && t[0] }); tone({ type: 'sine', f0: 300, f1: 900, dur: 0.2, vol: 0.1, x: t && t[0] }); },
      death: (e) => {
        noise({ fq0: 4000, fq1: 60, dur: 1.1, vol: 0.7, x: e.x }); tone({ type: 'sine', f0: 160, f1: 28, dur: 1.0, vol: 0.7, x: e.x });
        tone({ type: 'sawtooth', f0: 700, f1: 40, dur: 0.8, vol: 0.2, x: e.x }); tone({ type: 'square', f0: 80, f1: 30, dur: 0.7, vol: 0.2, delay: 0.1, x: e.x });
      },
      storm: () => { [0, 0.28, 0.56].forEach((d) => { tone({ type: 'sawtooth', f0: 880, dur: 0.18, vol: 0.14, delay: d }); tone({ type: 'sawtooth', f0: 660, dur: 0.18, vol: 0.14, delay: d + 0.14 }); }); },
      win: () => { [523, 659, 784, 1047].forEach((f, i) => { tone({ type: 'square', f0: f, dur: 0.25, vol: 0.12, delay: i * 0.13 }); tone({ type: 'sine', f0: f / 2, dur: 0.3, vol: 0.14, delay: i * 0.13 }); }); },
      heal: () => { [440, 554, 659, 880].forEach((f, i) => tone({ type: 'sine', f0: f, dur: 0.22, vol: 0.14, delay: i * 0.07 })); },
      ally: () => { tone({ type: 'triangle', f0: 523, dur: 0.14, vol: 0.12 }); tone({ type: 'triangle', f0: 784, dur: 0.22, vol: 0.12, delay: 0.1 }); },
      delay: () => { tone({ type: 'sine', f0: 900, f1: 300, dur: 0.35, vol: 0.12 }); tone({ type: 'sine', f0: 450, f1: 150, dur: 0.35, vol: 0.1, delay: 0.1 }); },
      click: () => tone({ type: 'sine', f0: 700, f1: 500, dur: 0.05, vol: 0.08 }),
    };
    // limite de cadence par type (évite la saturation en x5 / mitraille)
    const minGap = { shot: 45, hit: 40, bounce: 70, obs: 70, dash: 80 };
    return {
      init,
      play(name, e) {
        if (!ac || muted || ac.state !== 'running' || !sounds[name]) return;
        const now = performance.now(), gap = minGap[name] || 0;
        if (gap && now - (lastPlay[name] || 0) < gap / Math.max(1, speed * 0.5)) return;
        lastPlay[name] = now; sounds[name](e || {});
      },
      setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : vol; },
      toggle() { init(); this.setMuted(!muted); return muted; },
      isMuted: () => muted,
    };
  })();
  // les navigateurs exigent un geste utilisateur avant de produire du son
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => SFX.init(), { once: false, passive: true }));

  // ---------------- événements -> effets ----------------
  function colorOf(id) { return src.meta.bots[id] ? src.meta.bots[id].color : '#fff'; }
  function onTick(f, prev) {
    // traînées des chenilles
    for (let i = 0; i < f.k.length; i++) {
      const t = f.k[i], p = prev.k[i]; if (!t[7]) continue;
      const mv = Math.hypot(t[0] - p[0], t[1] - p[1]);
      if (mv > 0.3) {
        const a = t[2], c = Math.cos(a), s = Math.sin(a);
        for (const side of [-1, 1]) treads.push({ x: t[0] - c * 14 - s * 11 * side, y: t[1] - s * 14 + c * 11 * side, a, life: 1, color: colorOf(i) });
        if (Math.random() < 0.35) particles.push({ x: t[0] - c * 18, y: t[1] - s * 18, vx: -c * 0.6 + (Math.random() - 0.5) * 0.6, vy: -s * 0.6 + (Math.random() - 0.5) * 0.6, life: 1, decay: 0.035, size: 2.2, color: colorOf(i), shape: 'dot' });
      }
      if (t[5] > CFG.DASH_CD - 14) ghosts.push({ x: t[0], y: t[1], a: t[2], ta: t[3], life: 1, color: colorOf(i) });
    }
    // historique des balles (traînées)
    const seen = new Set();
    for (const b of f.b) {
      seen.add(b[3]); let tr = bulletTrails.get(b[3]); if (!tr) { tr = []; bulletTrails.set(b[3], tr); }
      tr.push([b[0], b[1]]); if (tr.length > 7) tr.shift();
    }
    for (const id of bulletTrails.keys()) if (!seen.has(id)) bulletTrails.delete(id);
    if (!f.e) return;
    for (const e of f.e) {
      countEvent(e); SFX.play(e.k, e);
      switch (e.k) {
        case 'shot': burst(e.x, e.y, colorOf(e.id), 6, 2.2, 0.08, e.a, 0.5); break;
        case 'hit': {
          burst(e.x, e.y, colorOf(e.id), 16, 3.5, 0.05); burst(e.x, e.y, '#ffffff', 6, 2, 0.09);
          shake = Math.min(26, shake + (e.bank ? 9 : 6)); hitFlash[e.id] = 1;
          const dt = '-' + (e.dmg !== undefined ? Math.round(e.dmg) : 10);
          if (e.armor) burst(e.x, e.y, '#ffe08a', 10, 2.5, 0.07);
          texts.push({ x: e.x, y: e.y - 16, txt: e.armor ? dt + ' BLINDÉ' : e.bank ? dt + ' BANK!' : dt, color: e.armor ? '#ffe08a' : e.bank ? '#b44dff' : colorOf(e.by), life: 1 });
          break;
        }
        case 'ram': {
          shards(e.x, e.y, colorOf(e.by), 18, 5); burst(e.x, e.y, '#ffffff', 12, 3, 0.06);
          rings.push({ x: e.x, y: e.y, r: 8, life: 0.8, color: colorOf(e.by) });
          shake = Math.min(30, shake + 16); hitFlash[e.id] = 1;
          texts.push({ x: e.x, y: e.y - 22, txt: '-' + Math.round(e.dmg) + ' RAM!', color: colorOf(e.by), life: 1.3 });
          break;
        }
        case 'bounce': burst(e.x, e.y, '#9ffcff', 5, 1.6, 0.09); break;
        case 'obs': burst(e.x, e.y, '#ffd6ff', 4, 1.6, 0.08); break;
        case 'obsDown': {
          const o = src.meta.obstacles[e.o];
          shards(o.x, o.y, '#ff6cf0', 26, 5); rings.push({ x: o.x, y: o.y, r: o.r, life: 1, color: '#ff6cf0' }); shake = Math.min(30, shake + 12);
          break;
        }
        case 'dash': burst(src.frames[idx].k[e.id][0], src.frames[idx].k[e.id][1], colorOf(e.id), 14, 3, 0.05, e.dir + Math.PI, 0.8); break;
        case 'death': {
          const c = colorOf(e.id);
          shards(e.x, e.y, c, 46, 7); shards(e.x, e.y, '#ffffff', 14, 4);
          rings.push({ x: e.x, y: e.y, r: 10, life: 1, color: c }); rings.push({ x: e.x, y: e.y, r: 4, life: 1.3, color: '#ffffff' });
          shake = 34; flash = 0.55;
          break;
        }
        case 'storm': texts.push({ x: W / 2, y: H / 2, txt: '⚠ TEMPÊTE — LA ZONE SE REFERME', color: '#ff2a6d', life: 2.2, big: true }); break;
      }
    }
  }
  function burst(x, y, color, n, spd, decay, dir, spread) {
    for (let i = 0; i < n; i++) {
      const a = dir === undefined ? Math.random() * Math.PI * 2 : dir + (Math.random() - 0.5) * 2 * spread;
      const v = spd * (0.3 + Math.random());
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: decay * (0.7 + Math.random() * 0.6), size: 1.5 + Math.random() * 2.2, color, shape: 'dot' });
    }
  }
  function shards(x, y, color, n, spd) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = spd * (0.25 + Math.random());
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 0.012 + Math.random() * 0.02, size: 4 + Math.random() * 9,
        color, shape: Math.random() < 0.6 ? 'tri' : 'sq', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4 });
    }
  }

  // ---------------- rendu ----------------
  const gridCanvas = document.createElement('canvas'); gridCanvas.width = W; gridCanvas.height = H;
  (function drawGrid() {
    const g = gridCanvas.getContext('2d');
    const grd = g.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, 760);
    grd.addColorStop(0, '#120628'); grd.addColorStop(1, '#030108'); g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.lineWidth = 1;
    for (let i = 0; i <= W; i += 50) {
      const major = i % 250 === 0;
      g.strokeStyle = major ? 'rgba(255, 42, 220, 0.30)' : 'rgba(0, 240, 255, 0.09)';
      g.shadowColor = major ? '#ff2adc' : '#00f0ff'; g.shadowBlur = major ? 8 : 0;
      g.beginPath(); g.moveTo(i + 0.5, 0); g.lineTo(i + 0.5, H); g.stroke();
      g.beginPath(); g.moveTo(0, i + 0.5); g.lineTo(W, i + 0.5); g.stroke();
    }
    g.shadowBlur = 0;
  })();

  function rayEnd(x, y, a, obstacles, f) {
    const dx = Math.cos(a), dy = Math.sin(a); let tMin = Infinity;
    if (dx > 0) tMin = Math.min(tMin, (W - x) / dx); else if (dx < 0) tMin = Math.min(tMin, -x / dx);
    if (dy > 0) tMin = Math.min(tMin, (H - y) / dy); else if (dy < 0) tMin = Math.min(tMin, -y / dy);
    obstacles.forEach((o, i) => {
      if (!f.o[i]) return;
      const fx = x - o.x, fy = y - o.y; const b = fx * dx + fy * dy; const c = fx * fx + fy * fy - o.r * o.r; const disc = b * b - c;
      if (disc < 0) return; const t = -b - Math.sqrt(disc); if (t > 0 && t < tMin) tMin = t;
    });
    return [x + dx * tMin, y + dy * tMin];
  }

  function render(dt) {
    if (!src) return;
    const f = src.frames[idx], meta = src.meta;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    ctx.drawImage(gridCanvas, 0, 0);

    // tempête
    if (f.z < CFG.STORM_START_R) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
      ctx.beginPath(); ctx.rect(-50, -50, W + 100, H + 100); ctx.arc(W / 2, H / 2, f.z, 0, Math.PI * 2, true);
      ctx.fillStyle = `rgba(255, 20, 110, ${0.16 + pulse * 0.08})`; ctx.fill();
      ctx.beginPath(); ctx.arc(W / 2, H / 2, f.z, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff2a6d'; ctx.lineWidth = 4; ctx.shadowColor = '#ff2a6d'; ctx.shadowBlur = 25; ctx.stroke(); ctx.shadowBlur = 0;
    }

    // traces de chenilles
    for (const t of treads) {
      ctx.globalAlpha = t.life * 0.35; ctx.fillStyle = t.color;
      ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(t.a); ctx.fillRect(-2, -2.5, 4, 5); ctx.restore();
    }
    ctx.globalAlpha = 1;

    // obstacles
    meta.obstacles.forEach((o, i) => {
      const hp = f.o[i]; if (!hp) return;
      const k = hp / o.maxHp;
      const col = k > 0.6 ? '#00f0ff' : k > 0.3 ? '#b44dff' : '#ff2a6d';
      ctx.save(); ctx.translate(o.x, o.y);
      ctx.beginPath(); ctx.arc(0, 0, o.r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(10, 4, 26, 0.92)'; ctx.fill();
      ctx.shadowColor = col; ctx.shadowBlur = 18; ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.stroke();
      ctx.shadowBlur = 0; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
      ctx.beginPath(); for (let j = 0; j <= 6; j++) { const a = j * Math.PI / 3 + performance.now() / 4000; const r = o.r * 0.62; j ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.stroke();
      ctx.globalAlpha = 0.9; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, o.r + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.strokeStyle = col; ctx.stroke();
      ctx.restore();
    });

    // lasers de visée
    ctx.globalCompositeOperation = 'lighter';
    f.k.forEach((t, i) => {
      if (!t[7]) return;
      const sx = t[0] + Math.cos(t[3]) * 30, sy = t[1] + Math.sin(t[3]) * 30;
      const [ex, ey] = rayEnd(sx, sy, t[3], meta.obstacles, f);
      const g = ctx.createLinearGradient(sx, sy, ex, ey); const c = colorOf(i);
      g.addColorStop(0, hexA(c, 0.45)); g.addColorStop(1, hexA(c, 0.04));
      ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.setLineDash([10, 6]); ctx.lineDashOffset = -performance.now() / 30;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = hexA(c, 0.5); ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
    });
    // fantômes de dash
    for (const g of ghosts) { ctx.globalAlpha = g.life * 0.35; drawTank(g.x, g.y, g.a, g.ta, g.color, 0, true); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

    // liens d'alliance
    if (f.tm) {
      ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = 2; ctx.setLineDash([4, 8]); ctx.lineDashOffset = -performance.now() / 40;
      for (let i = 0; i < f.k.length; i++) for (let j = i + 1; j < f.k.length; j++) {
        if (f.tm[i] < 0 || f.tm[i] !== f.tm[j] || !f.k[i][7] || !f.k[j][7]) continue;
        ctx.strokeStyle = hexA(TEAM_COL[f.tm[i]] || '#fff', 0.55);
        ctx.beginPath(); ctx.moveTo(f.k[i][0], f.k[i][1]); ctx.lineTo(f.k[j][0], f.k[j][1]); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalCompositeOperation = 'source-over';
    }
    // tanks
    f.k.forEach((t, i) => { if (t[7]) drawTank(t[0], t[1], t[2], t[3], colorOf(i), hitFlash[i] || 0, false, t[4]); });

    // badges d'équipe
    if (f.tm) f.k.forEach((t, i) => {
      if (!t[7] || f.tm[i] < 0) return;
      const c = TEAM_COL[f.tm[i]] || '#fff';
      ctx.font = 'bold 12px Consolas'; ctx.textAlign = 'center'; ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 8;
      ctx.fillText('⚑ ' + (TEAM_NAME[f.tm[i]] || '?'), t[0], t[1] - 40); ctx.shadowBlur = 0;
    });
    // balles
    ctx.globalCompositeOperation = 'lighter';
    for (const b of f.b) {
      const c = colorOf(b[2]); const tr = bulletTrails.get(b[3]);
      if (tr && tr.length > 1) {
        ctx.strokeStyle = hexA(c, 0.5); ctx.lineWidth = 4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tr[0][0], tr[0][1]); for (const p of tr) ctx.lineTo(p[0], p[1]); ctx.stroke();
      }
      ctx.shadowColor = c; ctx.shadowBlur = 14; ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(b[0], b[1], 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hexA(c, 0.6); ctx.beginPath(); ctx.arc(b[0], b[1], 7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
    // particules
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
      if (p.shape === 'dot') { ctx.beginPath(); ctx.arc(p.x, p.y, p.size * p.life + 0.4, 0, Math.PI * 2); ctx.fill(); }
      else {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.strokeStyle = p.color; ctx.lineWidth = 1.5; ctx.shadowColor = p.color; ctx.shadowBlur = 10;
        ctx.beginPath();
        if (p.shape === 'tri') { ctx.moveTo(0, -p.size); ctx.lineTo(p.size * 0.87, p.size * 0.5); ctx.lineTo(-p.size * 0.87, p.size * 0.5); ctx.closePath(); }
        else ctx.rect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.stroke(); ctx.restore();
      }
    }
    for (const r of rings) {
      ctx.globalAlpha = Math.max(0, Math.min(1, r.life)); ctx.strokeStyle = r.color; ctx.lineWidth = 3 * r.life + 1; ctx.shadowColor = r.color; ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // textes flottants
    for (const t of texts) {
      ctx.globalAlpha = Math.min(1, t.life); ctx.fillStyle = t.color; ctx.shadowColor = t.color; ctx.shadowBlur = 12;
      ctx.font = t.big ? 'bold 38px Segoe UI' : 'bold 17px Consolas'; ctx.textAlign = 'center'; ctx.fillText(t.txt, t.x, t.y);
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.restore();
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(0, 0, W, H); }

    // mise à jour des effets (temps réel)
    const k = dt / 16.67;
    for (const p of particles) { p.x += p.vx * k; p.y += p.vy * k; p.vx *= Math.pow(0.95, k); p.vy *= Math.pow(0.95, k); p.life -= p.decay * k; if (p.rot !== undefined) p.rot += p.vr * k; }
    particles = particles.filter((p) => p.life > 0);
    for (const t of treads) t.life -= 0.006 * k; treads = treads.filter((t) => t.life > 0); if (treads.length > 1600) treads.splice(0, treads.length - 1600);
    for (const g of ghosts) g.life -= 0.06 * k; ghosts = ghosts.filter((g) => g.life > 0);
    for (const r of rings) { r.r += 6 * k; r.life -= 0.03 * k; } rings = rings.filter((r) => r.life > 0);
    for (const t of texts) { t.y -= (t.big ? 0.15 : 0.8) * k; t.life -= 0.02 * k; } texts = texts.filter((t) => t.life > 0);
    for (const id in hitFlash) { hitFlash[id] -= 0.08 * k; if (hitFlash[id] <= 0) delete hitFlash[id]; }
    shake *= Math.pow(0.86, k); flash = Math.max(0, flash - 0.04 * k);
  }

  function drawTank(x, y, a, ta, color, hf, ghost, hp) {
    ctx.save(); ctx.translate(x, y);
    ctx.save(); ctx.rotate(a);
    if (!ghost) { ctx.shadowColor = color; ctx.shadowBlur = 22; }
    ctx.fillStyle = 'rgba(8, 3, 18, 0.95)'; ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    roundRect(-20, -15, 40, 30, 6); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0; ctx.fillStyle = hexA(color, 0.55);
    ctx.fillRect(-21, -17, 42, 5); ctx.fillRect(-21, 12, 42, 5);
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(11, -5); ctx.lineTo(11, 5); ctx.fill();
    ctx.restore();
    ctx.rotate(ta);
    ctx.fillStyle = color; ctx.fillRect(4, -3, 24, 6);
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fillStyle = '#12051f'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    if (hf > 0) { ctx.globalAlpha = hf; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
    ctx.restore();
    if (!ghost && hp !== undefined) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 22, y - 34, 44, 5);
      ctx.fillStyle = hp > 50 ? color : hp > 25 ? '#ffc400' : '#ff2a6d'; ctx.fillRect(x - 22, y - 34, 44 * hp / 100, 5);
    }
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

  // ---------------- dashboard ----------------
  function buildTankCards() {
    $('tanks').innerHTML = src.meta.bots.map((b) => `
      <div class="tank" id="card${b.id}" style="border-color:${b.color}">
        <div class="top" style="color:${b.color}">${b.name.toUpperCase()}${b.traits && b.traits.frontArmor ? ' <span title="Blindage frontal, éperon, canon court" style="font-size:10px;opacity:.75">⛨ JUGGERNAUT</span>' : ''} <small id="cardS${b.id}"></small></div>
        <div class="bars">
          <span>PV</span><div class="bar"><i id="hp${b.id}" style="background:${b.color};box-shadow:0 0 8px ${b.color}"></i></div>
          <span>DASH</span><div class="bar"><i id="dc${b.id}" style="background:#9ffcff"></i></div>
          <span>ÉNERG</span><div class="bar"><i id="en${b.id}" style="background:#ffc400"></i></div>
        </div>
        <div class="mini" id="st${b.id}"></div>
        <div class="row ctl" style="margin-top:5px">
          <select class="teamSel" data-id="${b.id}" title="Alliance">
            <option value="-1">Solo</option><option value="0">⚑ Équipe A</option><option value="1">⚑ Équipe B</option>
          </select>
          <button class="healBtn" data-id="${b.id}" title="Rend 50 PV">✚ Soigner</button>
        </div>
      </div>`).join('');
    document.querySelectorAll('.teamSel').forEach((s) => { s.value = String(teamSel[s.dataset.id]); s.onchange = () => { teamSel[s.dataset.id] = parseInt(s.value, 10); applyTeams(); }; });
    document.querySelectorAll('.healBtn').forEach((b) => { b.onclick = () => healTank(parseInt(b.dataset.id, 10)); });
    liveOK = null;
  }

  // ---------------- commandes live : alliances, soin, délai de tempête ----------------
  let liveOK = null;
  function refreshLast() { // répercute l'état du moteur sur la dernière image (utile en pause)
    const s = src.match.snapshot(), L = src.frames[src.frames.length - 1];
    L.k = s.k; L.z = s.z; if (s.tm) L.tm = s.tm; else delete L.tm; if (s.m) L.m = s.m; else delete L.m;
  }
  function applyTeams() {
    if (!src) return;
    document.querySelectorAll('.teamSel').forEach((s) => { s.value = String(teamSel[s.dataset.id]); });
    if (src.kind === 'live') { src.match.setTeams(teamSel); refreshLast(); }
    if (teamSel.some((x) => x >= 0)) SFX.play('ally');
  }
  function healTank(id, amount) {
    if (!src || src.kind !== 'live' || src.match.over) return;
    const got = src.match.heal(id, amount === undefined ? 50 : amount); if (got <= 0) return;
    refreshLast();
    if (idx === src.frames.length - 1) {
      const t = src.frames[idx].k[id];
      burst(t[0], t[1], '#7dff7a', 22, 2.4, 0.04); rings.push({ x: t[0], y: t[1], r: 8, life: 0.9, color: '#7dff7a' });
      texts.push({ x: t[0], y: t[1] - 26, txt: '+' + Math.round(got) + ' PV', color: '#7dff7a', life: 1.2 });
    }
    SFX.play('heal');
  }
  function delayStorm(sec) {
    if (!src || src.kind !== 'live' || src.match.over) return;
    src.match.delayStorm(sec * CFG.TICKS_PER_SEC); refreshLast();
    texts.push({ x: W / 2, y: H / 2 - 60, txt: '⏳ TEMPÊTE +' + sec + ' s', color: '#9ffcff', life: 1.8, big: true });
    SFX.play('delay');
  }
  function updateLiveControls() {
    const ok = !!(src && src.kind === 'live' && !src.match.over);
    if (ok !== liveOK) {
      liveOK = ok;
      document.querySelectorAll('.ctl select, .ctl button, .liveCtl button').forEach((e) => { e.disabled = !ok; e.style.opacity = ok ? '' : '0.4'; });
      $('liveHint').textContent = ok ? '' : 'Disponible uniquement en match live en cours (⚡ Match live).';
    }
    if (ok) src.match.tanks.forEach((t) => { const b = document.querySelector('.healBtn[data-id="' + t.id + '"]'); if (b) b.disabled = !t.alive || t.hp >= CFG.MAX_HP; });
  }
  function updateDashboard() {
    if (!src) return;
    const f = src.frames[idx];
    f.k.forEach((t, i) => {
      $('hp' + i).style.width = t[4] + '%';
      $('dc' + i).style.width = (100 * (1 - t[5] / CFG.DASH_CD)) + '%';
      $('en' + i).style.width = t[6] + '%';
      $('card' + i).classList.toggle('dead', !t[7]);
      $('cardS' + i).textContent = t[7] ? Math.ceil(t[4]) + ' PV' + (t[5] <= 0 ? ' · DASH PRÊT' : '') : '✖ DÉTRUIT';
      const s = runStats[i];
      $('st' + i).textContent = `tirs ${s.shots} · touches ${s.hits} (${s.shots ? Math.round(100 * s.hits / s.shots) : 0}%) · dmg ${s.dmg} · kills ${s.kills} · dash ${s.dashes}${s.rams ? ' · béliers ' + s.rams : ''}`;
    });
    const sec = (f.t / CFG.TICKS_PER_SEC).toFixed(1);
    const stormIn = (f.m || CFG.MAX_TICKS) - f.t;
    updateLiveControls();
    $('matchInfo').textContent = stormIn > 0 ? `Tempête dans ${(stormIn / 60).toFixed(1)} s` : `TEMPÊTE ACTIVE — rayon ${f.z} px`;
    const tl = $('timeline'); tl.max = src.frames.length - 1; if (document.activeElement !== tl) tl.value = idx;
    $('tickLbl').textContent = `t=${f.t} (${sec}s) / ${src.kind === 'live' && !src.match.over ? '…' : src.frames[src.frames.length - 1].t}`;
    // fin de match
    const ended = idx === src.frames.length - 1 && (src.kind === 'replay' || src.match.over);
    if (ended && !bannerShown) {
      bannerShown = true;
      const alive = f.k.map((t, i) => [t, i]).filter(([t]) => t[7]);
      let w = alive.length === 1 ? alive[0][1] : -1;
      if (alive.length > 1) { alive.sort((a, b) => b[0][4] - a[0][4]); if (alive[0][0][4] > alive[1][0][4]) w = alive[0][1]; }
      const b = $('banner');
      const tm = f.tm, teamWin = alive.length > 1 && tm && alive.every(([, i]) => tm[i] >= 0 && tm[i] === tm[alive[0][1]]);
      if (teamWin) {
        const c = TEAM_COL[tm[alive[0][1]]] || '#fff', names = alive.map(([, i]) => src.meta.bots[i].name).join(' + ');
        b.innerHTML = `<div style="color:${c};text-shadow:0 0 20px ${c},0 0 50px ${c}">ÉQUIPE ${TEAM_NAME[tm[alive[0][1]]] || ''} WINS</div><small>${names} · ${(f.t / 60).toFixed(1)} s</small>`;
      } else if (w >= 0) { const bot = src.meta.bots[w]; b.innerHTML = `<div style="color:${bot.color};text-shadow:0 0 20px ${bot.color},0 0 50px ${bot.color}">${bot.name} WINS</div><small>${Math.ceil(f.k[w][4])} PV restants · ${(f.t / 60).toFixed(1)} s</small>`; }
      else b.innerHTML = '<div style="color:#fff;text-shadow:0 0 20px #fff">DRAW</div>';
      b.className = 'show'; SFX.play('win');
    }
  }
  function pushFeed(e) {
    const v = src.meta.bots[e.id], k = e.by >= 0 ? src.meta.bots[e.by] : null;
    feed.unshift(k ? `<span style="color:${k.color}">${k.name}</span> ✖ <span style="color:${v.color}">${v.name}</span>`
      : `<span style="color:#ff2a6d">☠ ${e.by === -1 ? 'Tempête/rebond' : ''}</span> ✖ <span style="color:${v.color}">${v.name}</span>`);
    feed = feed.slice(0, 6); renderFeed();
  }
  function renderFeed() { $('feed').innerHTML = feed.map((x) => `<div>${x}</div>`).join('') || '<div style="color:var(--muted)">—</div>'; }
  function setStatus(s) { $('status').textContent = s; }

  // ---------------- évolution (rapport) ----------------
  async function loadReport() {
    try { report = await fetch('evolution_report.json?v=' + Date.now()).then((r) => r.json()); }
    catch (e) { report = { generations: [] }; }
    const gens = report.generations || [];
    // boutons replays + sélecteur de version des IA
    const rb = $('replayBtns');
    gens.forEach((g) => { const b = document.createElement('button'); b.textContent = 'GEN ' + g.gen; b.id = 'btn_gen' + g.gen; b.onclick = () => startReplay(g.gen); rb.appendChild(b); });
    const sel = $('botGen');
    gens.forEach((g) => { const o = document.createElement('option'); o.value = 'gen_' + g.gen; o.textContent = 'Génération ' + g.gen; sel.appendChild(o); });
    // tableau winrate
    const tbl = $('wrTable');
    if (!gens.length) { tbl.innerHTML = '<tr><td>Aucune génération simulée</td></tr>'; $('notes').textContent = 'Lancez node sim/tournament.js --gen 1'; return; }
    const keys = KEYS;
    let html = '<tr><th>Gen</th>' + keys.map((k) => `<th style="color:${gens[0].stats[k].color}">${gens[0].stats[k].name.slice(0, 8)}</th>`).join('') + '</tr>';
    for (const g of gens) {
      const max = Math.max(...keys.map((k) => g.stats[k].winrate));
      html += `<tr><td>G${g.gen}</td>` + keys.map((k) => { const s = g.stats[k]; return `<td class="${s.winrate === max ? 'best' : ''}" style="color:${s.color}" title="précision ${(s.accuracy * 100).toFixed(1)}% · dmg ${s.avgDamage.toFixed(0)} · esquives ${s.avgDodges.toFixed(1)} · survie ${(s.avgSurvival / 60).toFixed(1)}s">${(s.winrate * 100).toFixed(1)}%<br><span style="opacity:.6;font-size:10px">${s.version}</span></td>`; }).join('') + '</tr>';
    }
    html += '<tr><td colspan="5" style="text-align:left;color:var(--muted);padding-top:6px">Précision / dégâts moyens (dernière gen)</td></tr>';
    const last = gens[gens.length - 1];
    html += '<tr><td>G' + last.gen + '</td>' + keys.map((k) => { const s = last.stats[k]; return `<td style="color:${s.color}">${(s.accuracy * 100).toFixed(0)}%<br>${s.avgDamage.toFixed(0)}</td>`; }).join('') + '</tr>';
    tbl.innerHTML = html;
    $('legend').innerHTML = keys.map((k) => `<span style="color:${last.stats[k].color}">${last.stats[k].name}</span>`).join('');
    drawChart(gens);
    // notes de l'ingénieur
    $('notes').innerHTML = gens.map((g) => {
      const n = g.notes; const lead = g.ranking.map((k) => g.stats[k].name).join(' > ');
      return `<div style="margin-bottom:10px"><b>GEN ${g.gen}</b> — ${g.matches} matchs en ${g.simSeconds.toFixed(1)} s · classement : ${lead}` +
        (n ? `${n.analysis ? '<br>' + n.analysis : ''}${n.changes ? '<ul>' + n.changes.map((c) => '<li>' + c + '</li>').join('') + '</ul>' : ''}` : '') + '</div>';
    }).join('');
  }
  function drawChart(gens) {
    const c = $('chart'), g = c.getContext('2d'); const w = c.width, h = c.height;
    const L = 70, R = 50, T = 20, B = 46;
    g.clearRect(0, 0, w, h); g.font = '20px Consolas'; g.fillStyle = '#8f7fb8';
    for (let p = 0; p <= 100; p += 25) {
      const y = T + (h - T - B) * (1 - p / 100);
      g.strokeStyle = 'rgba(255,42,220,0.15)'; g.lineWidth = 1; g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
      g.textAlign = 'right'; g.fillText(p + '%', L - 8, y + 6);
    }
    const n = gens.length; const xOf = (i) => (n === 1 ? (L + w - R) / 2 : L + (w - L - R) * i / (n - 1));
    g.textAlign = 'center'; gens.forEach((gg, i) => g.fillText('GEN ' + gg.gen, xOf(i), h - 14));
    for (const k of KEYS) {
      const col = gens[0].stats[k].color;
      g.strokeStyle = col; g.lineWidth = 4; g.shadowColor = col; g.shadowBlur = 14; g.beginPath();
      gens.forEach((gg, i) => { const y = T + (h - T - B) * (1 - gg.stats[k].winrate); i ? g.lineTo(xOf(i), y) : g.moveTo(xOf(i), y); });
      g.stroke();
      gens.forEach((gg, i) => { const y = T + (h - T - B) * (1 - gg.stats[k].winrate); g.fillStyle = col; g.beginPath(); g.arc(xOf(i), y, 7, 0, Math.PI * 2); g.fill(); });
      g.shadowBlur = 0;
    }
  }

  // ---------------- contrôles ----------------
  function markButtons(id) { document.querySelectorAll('#replayBtns button, #liveBtn').forEach((b) => b.classList.remove('on')); const el = id === 'live' ? $('liveBtn') : $('btn_' + id); if (el) el.classList.add('on'); }
  [0.5, 1, 2, 5].forEach((s) => {
    const b = document.createElement('button'); b.textContent = 'x' + s; if (s === 1) b.classList.add('on');
    b.onclick = () => { speed = s; document.querySelectorAll('#speeds button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
    $('speeds').appendChild(b);
  });
  $('muteBtn').onclick = () => { const m = SFX.toggle(); $('muteBtn').textContent = m ? '🔇' : '🔊'; if (!m) SFX.play('click'); };
  $('liveBtn').onclick = startLive;
  $('allyDuel').onclick = () => { teamSel = [0, 0, 1, 1]; applyTeams(); };
  $('allyNone').onclick = () => { teamSel = [-1, -1, -1, -1]; applyTeams(); };
  $('healAll').onclick = () => { if (src && src.kind === 'live') src.match.tanks.forEach((t) => healTank(t.id)); };
  $('storm10').onclick = () => delayStorm(10);
  $('storm30').onclick = () => delayStorm(30);
  $('playBtn').onclick = () => { playing = !playing; $('playBtn').textContent = playing ? '❚❚' : '▶'; };
  $('timeline').oninput = (e) => { if (src) seek(parseInt(e.target.value, 10)); };
  window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); } });

  // ---------------- boucle principale (60 FPS) ----------------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(50, now - last); last = now;
    if (src && playing) {
      acc += (dt / (1000 / CFG.TICKS_PER_SEC)) * speed;
      let n = 0; while (acc >= 1 && n < 30) { acc -= 1; n++; if (!advance()) { acc = 0; break; } }
    }
    render(dt); updateDashboard();
    requestAnimationFrame(loop);
  }
  (async function init() {
    await loadReport();
    const gens = (report && report.generations) || [];
    if (gens.length) await startReplay(gens[gens.length - 1].gen); else await startLive();
    requestAnimationFrame(loop);
  })().catch((e) => { setStatus('ERREUR : ' + e.message); console.error(e); });
})();
