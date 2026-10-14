// T2 (robust core): the per-unit adverse-selection asymmetry, computed with the
// REAL @whworjs7946/clmsr-v0 cost engine. This is model-independent: it does not
// depend on assumptions about how many traders show up, only on CLMSR math + a
// stale-vs-anchored prior. It explains the live psi=0.15 directly.
//
// Setup: market created with prior bell centered at the anchor. Over the day the
// oracle price drifts `d` bins away and settles there. We compare, per 1 unit:
//   - TOXIC unit:  trader buys the (drifted) winning bin -> LP loss = 1 - cost
//   - fee earned on that unit (100bps of cost)
//   - how many such fee streams are needed to cover one toxic loss
// for STATIC prior (w=0) vs ORACLE-ANCHORED prior (w=1).
//
// Run: node scripts/analysis/t2-asymmetry.js
const { CLMSRSDK, mapMarket, mapDistribution } = require("@whworjs7946/clmsr-v0");
const Big = require("big.js");
const fs = require("fs");
const path = require("path");
const sdk = new CLMSRSDK();

const N = 80, sp = 5, minT = 700, anchorBin = 40, sigma = 8, floor = 0.05;
const ALPHA_WAD = "10000000000000000000"; // alpha = 10
const FEE_BPS = 100;
const market = mapMarket({ liquidityParameter: ALPHA_WAD, minTick: minT, maxTick: minT + N * sp, tickSpacing: sp, feePolicyDescriptor: "" });

function bell(center, sig = sigma) {
  const f = []; for (let i = 0; i < N; i++) { const d = i - center; f.push(Math.max(Math.exp(-(d * d) / (2 * sig * sig)), floor)); }
  return f;
}
function dist(base) {
  let tot = new Big(0); const bf = base.map((x) => { const w = new Big(x).times(1e18).toFixed(0); tot = tot.plus(w); return w; });
  return { d: mapDistribution({ totalSum: tot.toFixed(0), binFactors: bf }), Z: Number(tot.toString()) / 1e18 };
}
const costUnit = (distObj, bin) => {
  const lo = minT + bin * sp, hi = lo + sp;
  try { return Number(sdk.calculateOpenCost(lo, hi, new Big("1000000"), distObj, market).cost) / 1e6; }
  catch { return NaN; }
};

(async () => {
  console.log("=== T2 ADVERSE-SELECTION ASYMMETRY (real CLMSR engine) ===");
  console.log(`alpha=10  bins=${N}  sigma=${sigma}  fee=${FEE_BPS}bps  payout=1.0/unit\n`);
  const NARROW = 1.5; // late-day remaining-vol bell width (bins)
  console.log("LP loss per 1 unit bought on the bin that actually wins (toxic flow):");
  console.log("driftBins  STATIC(w=0)        ANCHORED wideσ8     ANCHORED+NARROW σ1.5");
  console.log("           winPx   LP_loss    winPx   LP_loss    winPx   LP_loss");
  const rows = [];
  for (const d of [0, 2, 4, 6, 8, 10, 14, 20]) {
    const winBin = Math.min(N - 1, anchorBin + d);
    const cS = costUnit(dist(bell(anchorBin)).d, winBin);          // static: prior stays at anchor
    const cA = costUnit(dist(bell(winBin)).d, winBin);             // anchored, wide sigma
    const cAN = costUnit(dist(bell(winBin, NARROW)).d, winBin);    // anchored + narrow sigma
    const row = { driftBins: d, static: { winPx: cS, loss: 1 - cS }, anchoredWide: { winPx: cA, loss: 1 - cA }, anchoredNarrow: { winPx: cAN, loss: 1 - cAN } };
    rows.push(row);
    const f = (c) => `${c.toFixed(4)}  ${(1 - c).toFixed(4)}`;
    console.log(`${String(d).padStart(6)}     ${f(cS)}    ${f(cA)}    ${f(cAN)}`);
  }
  const feeOnUnit = (px) => px * FEE_BPS / 10000;
  const big = rows.find((r) => r.driftBins === 10);
  console.log("\nReading (per toxic unit, payout = $1):");
  console.log(`  STATIC, 10-bin drift: winner priced $${big.static.winPx.toFixed(4)} -> LP loses $${big.static.loss.toFixed(3)};`);
  console.log(`    fee earned = $${feeOnUnit(big.static.winPx).toExponential(2)}. Break-even needs ${(big.static.loss / feeOnUnit(big.static.winPx)).toFixed(0)} fee-units per toxic unit.`);
  console.log(`  ANCHORED wide-σ (proposal's re-center): winner STILL only $${big.anchoredWide.winPx.toFixed(4)} -> LP loses $${big.anchoredWide.loss.toFixed(3)}.`);
  console.log(`    Re-centering ALONE barely helps: the σ=8 bell spreads probability so the`);
  console.log(`    modal bin is underpriced even when correctly centered.`);
  console.log(`  ANCHORED+NARROW (σ→remaining vol): winner $${big.anchoredNarrow.winPx.toFixed(4)} -> LP loses $${big.anchoredNarrow.loss.toFixed(3)}.`);
  console.log(`    Only collapsing σ to true terminal vol prices the winner correctly --`);
  console.log(`    but that erases late-game edge, so the toxic volume (and its fees) vanish.`);
  console.log(`\nBottom line: fee per toxic unit (~1e-4..1e-3) is 3-4 orders of magnitude below`);
  console.log(`the loss (~$1). No fee rate closes that gap; this is exactly why the LIVE`);
  console.log(`contract realized psi=0.15. The fix is correct PRICING (re-center + narrow),`);
  console.log(`not fees -- and correct pricing removes the trader edge that creates volume.`);

  fs.writeFileSync(path.join(__dirname, "out", "t2-asymmetry.json"), JSON.stringify({ N, sigma, narrow: NARROW, alpha: 10, feeBps: FEE_BPS, rows }, null, 2));
  console.log(`\nwrote ${path.join(__dirname, "out", "t2-asymmetry.json")}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
