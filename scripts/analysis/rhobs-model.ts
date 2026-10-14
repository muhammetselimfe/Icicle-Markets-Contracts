// Model the rhoBS (backstop = rhoBS x NAV) needed to stay ahead of worst-case batch loss.
//
// Two bounds:
//  1) PROVABLE: LMSR guarantees per-market LP loss <= alpha*ln(n). A batch with M markets
//     can lose at most M*alpha*ln(n) (all max out simultaneously). No assumptions.
//  2) REALISTIC: Monte Carlo over batches. Settlement is random, so most markets net
//     POSITIVE for the LP (traders lose, premiums kept); only some lose. The bad batches
//     are when many markets in the same batch lose at once. Calibrated to live results
//     (worst observed single-market loss ~= 0.66*alpha*ln(n); LP wins can exceed alpha*ln(n)).
//
// Run: NAV=120596 ALPHA=2000 NBINS=80 npx hardhat run scripts/analysis/rhobs-model.ts
const NAV = Number(process.env.NAV ?? 120596);
const ALPHA = Number(process.env.ALPHA ?? 2000);
const N = Number(process.env.NBINS ?? 80);
const FEE_BPS = Number(process.env.FEE_BPS ?? 100);
const TRIALS = Number(process.env.TRIALS ?? 200000);
const Lmax = ALPHA * Math.log(N);                 // per-market hard loss bound

// calibration (from live Fuji adversarial + drift markets)
const P_LOSS = 0.35;                              // P(settlement lands in/near the traded cluster)
const PREMIUM_X = 3.0;                            // premium volume ~ 3x Lmax per active market
function mulberry32(s: number) { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const U = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

// one market's LP P&L (signed). Loss is bounded by Lmax; wins can be larger (kept premium).
function marketPnl(r: () => number): number {
  const fee = (FEE_BPS / 10000) * PREMIUM_X * Lmax;   // fees cushion losses (loss-comp)
  if (r() < P_LOSS) return -U(r, 0.25, 0.70) * Lmax + fee;   // lands on cluster -> LP pays out
  return U(r, 0.0, 0.6) * Lmax + fee;                        // drifts off -> LP keeps premium
}

function worstBatchLossPct(M: number, r: () => number): { max: number; p999: number; p99: number } {
  const losses: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    let pnl = 0;
    for (let m = 0; m < M; m++) pnl += marketPnl(r);
    losses.push(pnl < 0 ? -pnl : 0);
  }
  losses.sort((a, b) => a - b);
  const q = (p: number) => losses[Math.min(losses.length - 1, Math.floor(p * losses.length))];
  return { max: losses[losses.length - 1] / NAV, p999: q(0.999) / NAV, p99: q(0.99) / NAV };
}

console.log(`NAV=$${NAV.toLocaleString()}  alpha=${ALPHA}  n=${N}  -> per-market hard loss bound Lmax = alpha*ln(n) = $${Lmax.toFixed(0)} (${(100*Lmax/NAV).toFixed(1)}% of NAV)`);
console.log(`fee=${FEE_BPS}bps  P(market loses)=${P_LOSS}  premium~${PREMIUM_X}x Lmax  trials=${TRIALS.toLocaleString()}\n`);
console.log(`M = markets settling in ONE batch`);
console.log(`M    provable(all-max)   realistic 99.9%    realistic 99%     -> recommended rhoBS`);
const rng = mulberry32(12345);
for (const M of [1, 2, 3, 5, 8, 12]) {
  const provable = M * Lmax / NAV;
  const { p999, p99 } = worstBatchLossPct(M, rng);
  // recommend: cover the 99.9th percentile bad batch with ~25% headroom, capped at provable
  const rec = Math.min(provable, p999 * 1.25);
  console.log(`${String(M).padStart(2)}   ${(100*provable).toFixed(1)}% ($${(M*Lmax).toFixed(0).padStart(6)})     ${(100*p999).toFixed(2)}%            ${(100*p99).toFixed(2)}%           ${(100*rec).toFixed(1)}%`);
}
console.log(`\nNote: provable = LMSR guarantee (all M markets hit absolute worst case at once — ~impossible).`);
console.log(`Recommended rhoBS covers the 99.9th-percentile bad batch + 25% headroom.`);
