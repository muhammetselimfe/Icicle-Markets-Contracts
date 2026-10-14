// Compute the LP's EXPECTED P&L on a live market from ALL open positions:
//   E[P&L] = premiums collected − Σ (position qty × P(its range wins | current bell))
// P(range wins) is the LP's own implied probability (marginal cost of 1 unit over the
// range). If premiums ≥ Σ qty·P(win), the LP is profitable in expectation despite the
// adversarial flow. Also reports worst-case (the single most-loaded bin winning).
//
// Run: MARKET_ID=58 npx hardhat run scripts/ops/analyze-lp-live.ts --network fuji
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddr);
  const id = BigInt(process.env.MARKET_ID ?? "58");
  const m = await core.markets(id);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing), numBins = Number(m.numBins);
  const oBin = Math.floor((Number(m.cachedOracleTick) - minTick) / sp);
  console.log(`market ${id}: oracleBin=${oBin} ($${(Number(m.cachedOracleTick)/100).toFixed(2)}) premiumsCollected=$${Number(ethers.formatUnits(m.accumulatedPremiums,18)).toFixed(2)} fees=$${Number(ethers.formatUnits(m.accumulatedFees,18)).toFixed(2)}`);

  // gather all PositionOpened for this market
  const iface = new ethers.Interface(["event PositionOpened(uint256 indexed positionId,address indexed trader,uint256 indexed marketId,int256 lowerTick,int256 upperTick,uint128 quantity,uint256 cost)"]);
  const topic = ethers.id("PositionOpened(uint256,address,uint256,int256,int256,uint128,uint256)");
  const mTopic = ethers.zeroPadValue(ethers.toBeHex(id), 32);
  const latest = await ethers.provider.getBlockNumber();
  let logs: any[] = [];
  for (let to = latest; to > latest - 40000 && logs.length < 200; to -= 2000) {
    try { logs = (await ethers.provider.getLogs({ address: coreAddr, fromBlock: to - 1999, toBlock: to, topics: [topic, null, null, mTopic] })).concat(logs); } catch {}
  }
  const positions = logs.map((l) => { const d = iface.parseLog(l)!; return { lo: Number(d.args.lowerTick), hi: Number(d.args.upperTick), qty: Number(d.args.quantity) / 1e6, cost: Number(d.args.cost) / 1e6 }; });
  console.log(`open positions found: ${positions.length}`);

  // per-bin payout liability (a position pays its qty if settlement lands anywhere in its range)
  const binLiab = new Array(numBins).fill(0);
  let premiums = 0;
  for (const p of positions) {
    premiums += p.cost;
    const loB = Math.max(0, Math.floor((p.lo - minTick) / sp));
    const hiB = Math.min(numBins - 1, Math.floor((p.hi - minTick) / sp) - 1);
    for (let b = loB; b <= hiB; b++) binLiab[b] += p.qty;
  }

  // P(bin wins) = the LP's TRUE settlement belief = the BASE bell (oracle-anchored,
  // remaining-vol sigma), NOT the effective implied price — which traders pump by
  // buying. Using the effective price would be circular (measuring payout against
  // manipulated prices). Compute the base bell off-chain.
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const total = Number(m.endTimestamp) - Number(m.startTimestamp);
  const remaining = Math.max(0, Number(m.endTimestamp) - now);
  const volBins = Number(m.dynVolBinsWad) / 1e18;
  const sigMin = Number(m.dynSigmaMinWad) / 1e18, sigMax = Number(m.dynSigmaMaxWad) / 1e18, floor = Number(m.dynFloorWad) / 1e18;
  let sigma = volBins * Math.sqrt(total > 0 ? remaining / total : 0);
  sigma = Math.min(sigMax, Math.max(sigMin, sigma));
  const center = oBin; // w=1 → bell centered at oracle bin
  const bell: number[] = [];
  let bellSum = 0;
  for (let b = 0; b < numBins; b++) { const v = Math.max(Math.exp(-((b - center) ** 2) / (2 * sigma * sigma)), floor); bell.push(v); bellSum += v; }
  console.log(`base bell: center=${center} sigma=${sigma.toFixed(2)} bins (remaining ${(remaining/3600).toFixed(1)}h)`);

  let expectedPayout = 0, worstBin = 0, worstLiab = 0;
  for (let b = 0; b < numBins; b++) {
    if (binLiab[b] === 0) continue;
    const pWin = bell[b] / bellSum;          // true settlement probability of bin b
    expectedPayout += binLiab[b] * pWin;
    if (binLiab[b] > worstLiab) { worstLiab = binLiab[b]; worstBin = b; }
  }

  const epl = premiums - expectedPayout;
  console.log(`\nLP premiums collected:      $${premiums.toFixed(2)}`);
  console.log(`LP expected payout:         $${expectedPayout.toFixed(2)}  (Σ qty·P(win) under current bell)`);
  console.log(`LP EXPECTED P&L:            $${epl.toFixed(2)}  ${epl >= 0 ? "→ PROFITABLE in expectation ✓" : "→ LOSING in expectation ⚠"}`);
  console.log(`Worst-case bin: ${worstBin} ($${((minTick+worstBin*sp)/100).toFixed(2)}) liability $${worstLiab.toFixed(0)} → if it wins, LP P&L = $${(premiums - worstLiab).toFixed(2)}`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
