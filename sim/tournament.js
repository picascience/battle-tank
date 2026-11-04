#!/usr/bin/env node
/*
 * Simulateur headless : node sim/tournament.js --gen 1 [--matches 500]
 *  - lance N matchs free-for-all (4 bots) sans rendu
 *  - affiche un tableau complet de statistiques + diagnostics (matrices de kills / dégâts)
 *  - re-simule le "meilleur match" (seed déterministe) en mode enregistrement -> replays/gen_X.json
 *  - archive le code des bots de la génération -> bots/archive/gen_X/
 *  - met à jour evolution_report.json (lu par l'interface web)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Match, CFG } = require(path.join(ROOT, 'engine', 'arena.js'));

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const GEN = parseInt(arg('gen', '1'), 10);
const N = parseInt(arg('matches', '500'), 10);
const NO_SAVE = args.includes('--dry');
const KEYS = ['berserker', 'sniper', 'trickster', 'warlord'];

function loadBots() {
  return KEYS.map((k) => { const p = path.join(ROOT, 'bots', k + '.js'); delete require.cache[require.resolve(p)]; return require(p); });
}
const bots = loadBots();

// ---------- simulation ----------
const agg = {};
for (const b of bots) agg[b.key] = { name: b.name, color: b.color, version: b.version, wins: 0, place: 0, shots: 0, hits: 0, dmg: 0, taken: 0,
  dodges: 0, survival: 0, kills: 0, selfHits: 0, bankHits: 0, storm: 0, dashes: 0, stormDeaths: 0, rams: 0, armor: 0, errors: 0, killedBy: {}, hitsBy: {} };
let draws = 0, totalTicks = 0; const reasons = {}; let best = null;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const seed = GEN * 100000 + i;
  const res = new Match({ bots, seed }).run();
  totalTicks += res.ticks; reasons[res.endReason] = (reasons[res.endReason] || 0) + 1;
  if (res.winner < 0) draws++;
  for (const t of res.tanks) {
    const a = agg[t.key], s = t.stats;
    if (res.winner === t.id) a.wins++;
    a.place += res.placement[t.id]; a.shots += s.shots; a.hits += s.hits; a.dmg += s.damageDealt; a.taken += s.damageTaken;
    a.dodges += s.dodges; a.survival += s.survival; a.kills += s.kills; a.selfHits += s.selfHits; a.bankHits += s.bankHits;
    a.storm += s.stormDamage; a.dashes += s.dashes; a.errors += t.errors; a.rams += s.rams || 0; a.armor += s.armorBlocked || 0;
    if (!t.alive) {
      const by = t.killedBy >= 0 ? res.tanks[t.killedBy].key : 'tempête/aucun';
      a.killedBy[by] = (a.killedBy[by] || 0) + 1;
      if (t.killedBy < 0 && s.stormDamage > 0) a.stormDeaths++;
    }
    for (const id in s.hitsBy) { const k = res.tanks[id].key; a.hitsBy[k] = (a.hitsBy[k] || 0) + s.hitsBy[id]; }
  }
  if (!best || res.excitement > best.excitement) best = res;
}
const elapsed = (Date.now() - t0) / 1000;

// ---------- affichage ----------
const pct = (x) => (x * 100).toFixed(1) + '%';
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', berserker: '\x1b[91m', sniper: '\x1b[96m', trickster: '\x1b[95m', warlord: '\x1b[93m' };
console.log(`\n${C.bold}=== CYBER-TANK ARENA :: GÉNÉRATION ${GEN} :: ${N} matchs en ${elapsed.toFixed(2)} s (${(N / elapsed).toFixed(0)} matchs/s) ===${C.reset}`);
console.log(`Durée moyenne : ${(totalTicks / N).toFixed(0)} ticks  | Fins : ${Object.entries(reasons).map(([k, v]) => k + '=' + v).join(', ')} | Nuls : ${draws}\n`);
const cols = [['Bot', 11], ['Ver', 5], ['Win%', 7], ['Place', 6], ['Préc.', 7], ['Dmg/m', 7], ['Reçus/m', 8], ['Kills/m', 8], ['Esquiv/m', 9], ['Survie', 7], ['Tirs/m', 7], ['Bande', 6], ['AutoHit', 8], ['Tempête', 8], ['Dash/m', 7], ['Bélier/m', 9], ['Blindé/m', 9]];
console.log(C.bold + cols.map(([n, w], i) => (i < 2 ? pad(n, w) : lpad(n, w))).join(' ') + C.reset);
const stats = {};
const ranking = Object.keys(agg).sort((a, b) => agg[b].wins - agg[a].wins);
for (const k of ranking) {
  const a = agg[k];
  const row = {
    name: a.name, color: a.color, version: a.version,
    winrate: a.wins / N, avgPlacement: a.place / N, accuracy: a.shots ? a.hits / a.shots : 0,
    avgDamage: a.dmg / N, avgDamageTaken: a.taken / N, avgKills: a.kills / N, avgDodges: a.dodges / N,
    avgSurvival: a.survival / N, avgShots: a.shots / N, bankHits: a.bankHits, selfHits: a.selfHits,
    avgStormDamage: a.storm / N, stormDeaths: a.stormDeaths, avgDashes: a.dashes / N, avgRams: a.rams / N, avgArmorBlocked: a.armor / N, errors: a.errors,
    killedBy: a.killedBy, hitsTakenBy: a.hitsBy
  };
  stats[k] = row;
  const vals = [a.name, a.version, pct(row.winrate), row.avgPlacement.toFixed(2), pct(row.accuracy), row.avgDamage.toFixed(1), row.avgDamageTaken.toFixed(1),
    row.avgKills.toFixed(2), row.avgDodges.toFixed(1), (row.avgSurvival / CFG.TICKS_PER_SEC).toFixed(1) + 's', row.avgShots.toFixed(1), a.bankHits, a.selfHits, row.avgStormDamage.toFixed(1), row.avgDashes.toFixed(1), row.avgRams.toFixed(2), row.avgArmorBlocked.toFixed(1)];
  console.log(C[k] + vals.map((v, i) => (i < 2 ? pad(v, cols[i][1]) : lpad(v, cols[i][1]))).join(' ') + C.reset);
}
console.log(`\n${C.bold}Matrice des éliminations (ligne = victime, colonne = tueur)${C.reset}`);
const heads = [...KEYS, 'tempête/aucun'];
console.log(pad('', 11) + heads.map((h) => lpad(h.slice(0, 10), 11)).join(''));
for (const k of KEYS) console.log(C[k] + pad(agg[k].name, 11) + C.reset + heads.map((h) => lpad(agg[k].killedBy[h] || 0, 11)).join(''));
console.log(`\n${C.bold}Matrice des impacts reçus (ligne = touché, colonne = tireur)${C.reset}`);
console.log(pad('', 11) + KEYS.map((h) => lpad(h.slice(0, 10), 11)).join(''));
for (const k of KEYS) console.log(C[k] + pad(agg[k].name, 11) + C.reset + KEYS.map((h) => lpad(agg[k].hitsBy[h] || 0, 11)).join(''));
const errs = KEYS.filter((k) => agg[k].errors); if (errs.length) console.log('\n⚠ erreurs runtime : ' + errs.map((k) => k + '=' + agg[k].errors).join(', '));

// ---------- meilleur match -> replay ----------
console.log(`\n${C.bold}Meilleur match${C.reset} : seed ${best.seed}, ${best.ticks} ticks, vainqueur ${best.winnerKey || 'aucun'} (${best.winner >= 0 ? best.tanks[best.winner].hp : 0} PV), score d'intensité ${best.excitement}`);
if (NO_SAVE) { console.log('(--dry : rien n\'est sauvegardé)\n'); process.exit(0); }

const rec = new Match({ bots, seed: best.seed, record: true });
const recRes = rec.run();
const replay = { gen: GEN, title: `Génération ${GEN} — meilleur match`, meta: rec.meta(), result: recRes, frames: rec.frames };
fs.mkdirSync(path.join(ROOT, 'replays'), { recursive: true });
const replayFile = `replays/gen_${GEN}.json`;
fs.writeFileSync(path.join(ROOT, replayFile), JSON.stringify(replay));
console.log(`Replay enregistré : ${replayFile} (${rec.frames.length} frames, ${(fs.statSync(path.join(ROOT, replayFile)).size / 1024).toFixed(0)} Ko)`);

// archive du code des bots de cette génération (rejouable en live dans le viewer)
const arch = path.join(ROOT, 'bots', 'archive', 'gen_' + GEN);
fs.mkdirSync(arch, { recursive: true });
for (const k of KEYS) fs.copyFileSync(path.join(ROOT, 'bots', k + '.js'), path.join(arch, k + '.js'));
console.log(`Code des bots archivé : bots/archive/gen_${GEN}/`);

// rapport d'évolution
const reportPath = path.join(ROOT, 'evolution_report.json');
let report = { title: 'CYBER-TANK ARENA : AI EVOLUTION', generations: [] };
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) { /* nouveau rapport */ }
let notes = {};
try { notes = JSON.parse(fs.readFileSync(path.join(__dirname, 'notes.json'), 'utf8')); } catch (e) { /* pas de notes */ }
const entry = {
  gen: GEN, matches: N, date: new Date().toISOString(), simSeconds: elapsed, avgTicks: totalTicks / N, endReasons: reasons, draws,
  ranking, stats, bestMatch: { seed: best.seed, file: replayFile, ticks: recRes.ticks, winner: recRes.winnerKey, excitement: best.excitement },
  notes: notes[String(GEN)] || null
};
report.generations = (report.generations || []).filter((g) => g.gen !== GEN).concat([entry]).sort((a, b) => a.gen - b.gen);
for (const g of report.generations) if (notes[String(g.gen)]) g.notes = notes[String(g.gen)]; // notes rétroactives
report.updated = new Date().toISOString();
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log('Rapport mis à jour : evolution_report.json\n');
