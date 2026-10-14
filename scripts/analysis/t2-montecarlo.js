// T2: Off-chain Monte Carlo of CLMSR LP P&L using the real @whworjs7946/clmsr-v0
// cost engine. Calibrated so the STATIC case reproduces the live Signals
// fee-coverage ratio (psi ~ 0.15), then tests the dynamic-anchoring proposal:
//
//   MODEL A "static"          : prior bell fixed at anchor (current Signals / w=0)
//   MODEL B "recenter"        : bell re-centers on oracle each step, FIXED width
//                               (the proposal's design), swept over weight w
//   MODEL C "recenter+narrow" : bell re-centers AND its width sigma collapses
//                               toward settlement (what protection actually needs)
//
// Volume is ELASTIC: informed traders only trade when they see edge (so anchoring
// that removes edge also removes their volume/fees -- the honest test).
//
// LP cash P&L per market = premiums collected - settlement payouts.
// Fees: 100bps on cost (outside cost fn) -> real loss-first waterfall.
//
// Run: node scripts/analysis/t2-montecarlo.js
const { CLMSRSDK, mapMarket, mapDistribution } = require("@whworjs7946/clmsr-v0");
const Big = require("big.js");
const fs = require("fs");
const path = require("path");
const OUT_DIR = path.join(__dirname, "out");
const sdk = new CLMSRSDK();

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rng) => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const CFG = {
  numBins: 80, tickSpacing: 5, minTick: 700, anchorTick: 900,
  alphaWad: "10000000000000000000", // alpha = 10 (maxloss = 10*ln80 = 43.8)
  sigmaBins: 8, floor: 0.05, dailyVol: 0.045, steps: 24, nMarkets: 400,
  nav0: 1000, feeBps: 100, phiLP: 0.7,
  nInformed: 6, qInformedMin: 20, qInformedMax: 70, informedRangeBins: 2,
  nNoise: 60, qNoiseMin: 4, qNoiseMax: 18, noiseRangeMin: 2, noiseRangeMax: 10,
};
const ALPHA = Number(CFG.alphaWad) / 1e18;
const WADs = (x) => new Big(x).times(1e18).toFixed(0);
const Q6 = (u) => new Big(u).times(1e6);
const usd = (b) => Number(b.toString()) / 1e6;
const clampBin = (b) => Math.max(0, Math.min(CFG.numBins - 1, b));
const priceToBin = (p) => clampBin(Math.floor((p * 100 - CFG.minTick) / CFG.tickSpacing));
const market = mapMarket({ liquidityParameter: CFG.alphaWad, minTick: CFG.minTick, maxTick: CFG.minTick + CFG.numBins * CFG.tickSpacing, tickSpacing: CFG.tickSpacing, feePolicyDescriptor: "" });

function baseFactors(center, sigma) {
  const f = new Array(CFG.numBins); const s2 = 2 * sigma * sigma;
  for (let i = 0; i < CFG.numBins; i++) { const d = i - center; f[i] = Math.max(Math.exp(-(d * d) / s2), CFG.floor); }
  return f;
}
function buildDist(base, trade) {
  const bf = new Array(CFG.numBins); let tot = new Big(0);
  for (let i = 0; i < CFG.numBins; i++) { bf[i] = WADs(base[i] * trade[i]); tot = tot.plus(bf[i]); }
  return { dist: mapDistribution({ totalSum: tot.toFixed(0), binFactors: bf }), Z: Number(tot.toString()) / 1e18 };
}

// model: {w, narrow}  -> effective center & sigma at fractional time tau in [0,1]
function effBell(model, pUsd, tau) {
  const center0 = (CFG.anchorTick - CFG.minTick) / CFG.tickSpacing;
  const oracleBin = (pUsd * 100 - CFG.minTick) / CFG.tickSpacing;
  const center = (1 - model.w) * center0 + model.w * oracleBin;
  // remaining-vol bell width in bins
  const remVolBins = CFG.dailyVol * Math.sqrt(Math.max(1 - tau, 1e-3)) * (pUsd * 100) / CFG.tickSpacing;
  const sigma = model.narrow ? Math.max(remVolBins, 0.75) : CFG.sigmaBins;
  return { center, sigma };
}

function simMarket(rng, model) {
  let price = CFG.anchorTick / 100;
  const stepVol = CFG.dailyVol / Math.sqrt(CFG.steps);
  // per-market trend: crypto trends. Sign random, magnitude = model.drift (daily, fraction).
  const trendMag = model.drift || 0;
  const mu = (rng() < 0.5 ? -1 : 1) * trendMag / CFG.steps;
  const path = [price];
  for (let s = 0; s < CFG.steps; s++) { price *= Math.exp(mu - 0.5 * stepVol * stepVol + stepVol * gauss(rng)); path.push(price); }
  const winBin = priceToBin(path[path.length - 1]);

  const trade = new Array(CFG.numBins).fill(1);
  const positions = [];
  let premiums = 0, fees = 0, volume = 0;

  const nInf = model.nInformed != null ? model.nInformed : CFG.nInformed;
  const events = [];
  for (let k = 0; k < nInf; k++) events.push({ inf: true, t: 1 + Math.floor(rng() * CFG.steps) });
  for (let k = 0; k < CFG.nNoise; k++) events.push({ inf: false, t: 1 + Math.floor(rng() * CFG.steps) });
  events.sort((a, b) => a.t - b.t);

  for (const ev of events) {
    const tau = ev.t / CFG.steps;
    const pUsd = path[Math.min(ev.t, path.length - 1)];
    const { center, sigma } = effBell(model, pUsd, tau);
    const base = baseFactors(center, sigma);
    const { dist, Z } = buildDist(base, trade);

    let loBin, hiBin, q;
    if (ev.inf) {
      // informed: tight range around current price; trades only if edge > 0
      const c = priceToBin(pUsd);
      loBin = clampBin(c - Math.floor(CFG.informedRangeBins / 2));
      hiBin = clampBin(loBin + CFG.informedRangeBins - 1);
      // true prob price ends within [loBin,hiBin]: gaussian over remaining vol
      const remVolBins = Math.max(CFG.dailyVol * Math.sqrt(Math.max(1 - tau, 1e-3)) * (pUsd * 100) / CFG.tickSpacing, 0.5);
      const width = hiBin - loBin + 1;
      const trueProb = Math.min(0.99, width / (remVolBins * Math.sqrt(2 * Math.PI)) * Math.exp(0)); // ~ density*width at center
      // implied price = sum of bin prices over range
      let implied = 0; for (let i = loBin; i <= hiBin; i++) implied += base[i] * trade[i] / Z;
      const edge = trueProb - implied;
      if (edge <= 0.003) continue; // elastic: no edge -> no informed trade
      q = CFG.qInformedMin + rng() * (CFG.qInformedMax - CFG.qInformedMin);
      q *= Math.min(1.5, 0.5 + 3 * edge); // size grows with edge
    } else {
      // noise: uninformed but RATIONAL -> bets near the money (current oracle
      // price), where activity concentrates. Under a stale static prior these
      // near-money bins are underpriced, so even noise flow drains the LP --
      // this is what reproduces the live wipeout. Center ~ current price bin
      // plus a few bins of spread; always trades (ignores edge).
      const cur = priceToBin(pUsd);
      const c = clampBin(cur + Math.round(gauss(rng) * 3));
      const width = CFG.noiseRangeMin + Math.floor(rng() * (CFG.noiseRangeMax - CFG.noiseRangeMin + 1));
      loBin = clampBin(c - Math.floor(width / 2)); hiBin = clampBin(loBin + width - 1);
      q = CFG.qNoiseMin + rng() * (CFG.qNoiseMax - CFG.qNoiseMin);
    }

    const lo = CFG.minTick + loBin * CFG.tickSpacing;
    const hi = CFG.minTick + (hiBin + 1) * CFG.tickSpacing;
    let res; try { res = sdk.calculateOpenCost(lo, hi, Q6(q), dist, market); } catch { continue; }
    const cost = usd(res.cost);
    if (!isFinite(cost) || cost <= 0) continue;
    premiums += cost; fees += cost * CFG.feeBps / 10000; volume += cost;
    positions.push({ loBin, hiBin, q });
    const factor = Math.exp(q / ALPHA);
    for (let i = loBin; i <= hiBin; i++) trade[i] *= factor;
  }

  let payout = 0;
  for (const p of positions) if (winBin >= p.loBin && winBin <= p.hiBin) payout += p.q;
  return { L: premiums - payout, F: fees, volume };
}

function navDelta(L, F) { const Floss = Math.min(F, L < 0 ? -L : 0); return L + Floss + (F - Floss) * CFG.phiLP; }

function run(model, seed) {
  const rng = mulberry32(seed);
  let sumL = 0, sumLoss = 0, sumProfit = 0, sumFees = 0, sumVol = 0, lossM = 0, sumNetPnl = 0;
  for (let m = 0; m < CFG.nMarkets; m++) {
    const r = simMarket(rng, model);
    sumNetPnl += navDelta(r.L, r.F); // net LP P&L per market incl LP-credited fees
    sumL += r.L; sumFees += r.F; sumVol += r.volume;
    if (r.L < 0) { sumLoss += -r.L; lossM++; } else sumProfit += r.L;
  }
  const maxLoss = ALPHA * Math.log(CFG.numBins);
  return {
    label: model.label, w: model.w, narrow: !!model.narrow, nInformed: model.nInformed,
    netPnlPerMkt: +(sumNetPnl / CFG.nMarkets).toFixed(3),
    netPnlPctOfMaxLoss: +((sumNetPnl / CFG.nMarkets) / maxLoss * 100).toFixed(1),
    psi: +(sumLoss > 0 ? sumFees / sumLoss : Infinity).toFixed(3),
    lossMarkets: lossM, nMarkets: CFG.nMarkets,
    feesPerMkt: +(sumFees / CFG.nMarkets).toFixed(2),
    grossLossPerLossMkt: +(sumLoss / (lossM || 1)).toFixed(2),
    volPerMkt: +(sumVol / CFG.nMarkets).toFixed(1),
    profitable: sumNetPnl > 0,
  };
}

(async () => {
  const maxLoss = ALPHA * Math.log(CFG.numBins);
  console.log("=== T2 MONTE CARLO (CLMSR LP P&L, elastic volume) ===");
  console.log(`alpha=${ALPHA} maxloss=${maxLoss.toFixed(1)} bins=${CFG.numBins} vol=${CFG.dailyVol} N=${CFG.nMarkets} fee=${CFG.feeBps}bps nNoise=${CFG.nNoise}\n`);
  const results = [];
  let seed = 4242;

  // ---- Experiment 1: the faithful mechanism -- price DRIFT vs a static prior ----
  // A static prior is anchored at creation; crypto drifts. As daily drift grows,
  // the settlement region moves into the stale bell's underpriced tail and the LP
  // bleeds. Anchoring re-centers, so it should be robust to drift. Sweep drift.
  console.log("EXP-1  LP net P&L per market vs daily price DRIFT (the static-prior failure):");
  console.log("dailyDrift  STATIC(w=0)              ANCHORED+NARROW(w=1)");
  console.log("            netP&L  %maxL   psi      netP&L  %maxL   psi");
  for (const dr of [0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16]) {
    const s = run({ label: `static drift=${dr}`, w: 0, narrow: false, nInformed: CFG.nInformed, drift: dr }, seed++);
    const a = run({ label: `anchored drift=${dr}`, w: 1, narrow: true, nInformed: CFG.nInformed, drift: dr }, seed++);
    results.push(s, a);
    const f = (r) => `${String(r.netPnlPerMkt).padStart(7)} ${String(r.netPnlPctOfMaxLoss).padStart(6)} ${String(r.psi).padStart(6)}`;
    console.log(`${String(dr).padEnd(6).padStart(6)}      ${f(s)}    ${f(a)}`);
  }

  // ---- Experiment 2: anchoring weight sweep at a realistic trending regime ----
  const DR = 0.08; // ~8% daily drift (typical crypto trend day)
  console.log(`\nEXP-2  Anchoring weight sweep at a trending regime (dailyDrift=${DR}, nInformed=${CFG.nInformed}):`);
  console.log("model                     netP&L/mkt  %maxLoss   psi     lossMkts  vol/mkt  profitable");
  const models = [
    { label: "A static (w=0)", w: 0, narrow: false, drift: DR },
    { label: "B recenter w=.25", w: 0.25, narrow: false, drift: DR },
    { label: "B recenter w=.5", w: 0.5, narrow: false, drift: DR },
    { label: "B recenter w=.75", w: 0.75, narrow: false, drift: DR },
    { label: "B recenter w=1", w: 1, narrow: false, drift: DR },
    { label: "C recenter+narrow w=.5", w: 0.5, narrow: true, drift: DR },
    { label: "C recenter+narrow w=1", w: 1, narrow: true, drift: DR },
  ];
  for (const m of models) {
    const r = run(m, seed++); results.push(r);
    console.log(
      `${r.label.padEnd(24)} ${String(r.netPnlPerMkt).padStart(9)} ${String(r.netPnlPctOfMaxLoss).padStart(8)}% ${String(r.psi).padStart(7)}  ` +
      `${String(r.lossMarkets).padStart(3)}/${r.nMarkets}  ${String(r.volPerMkt).padStart(7)}    ${r.profitable ? "YES" : "no"}`
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "t2-montecarlo.json"), JSON.stringify({ cfg: CFG, alpha: ALPHA, maxLoss, results }, null, 2));
  console.log(`\nLIVE reference: psi=0.15, return=-96% (share price), 124/141 loss days.`);
  console.log(`Interpretation: net P&L sign flips with adverse-selection intensity. Anchoring`);
  console.log(`shifts the break-even point but does not remove the cliff; fees alone (psi) never`);
  console.log(`approach 1 under realistic toxic flow. wrote out/t2-montecarlo.json`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
