// Market-level LP P&L for a SETTLED dynamic market (does not need batch processing):
//   L_t  = accumulatedPremiums − accumulatedProceeds − Σ payout(winning positions)
//   net  = L_t + fees
// Payout liability is rebuilt from PositionOpened events (a position pays qty if settlementTick ∈ [lo, hi)).
// Run: MARKET_ID=7 npx hardhat run scripts/ops/market-lp-pnl.ts --network fuji
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddr);
  const id = BigInt(process.env.MARKET_ID!);
  const m = await core.markets(id);
  const sTick = Number(m.settlementTick);
  const premiums = Number(ethers.formatUnits(m.accumulatedPremiums, 18));
  const proceeds = Number(ethers.formatUnits(m.accumulatedProceeds, 18));
  const fees = Number(ethers.formatUnits(m.accumulatedFees, 18));
  console.log(`market ${id}: settled=${m.settled} settlementTick=${sTick} ($${(sTick/100).toFixed(2)}) positions=${m.openPositionCount}`);

  const iface = new ethers.Interface(["event PositionOpened(uint256 indexed positionId,address indexed trader,uint256 indexed marketId,int256 lowerTick,int256 upperTick,uint128 quantity,uint256 cost)"]);
  const topic = ethers.id("PositionOpened(uint256,address,uint256,int256,int256,uint128,uint256)");
  const mTopic = ethers.zeroPadValue(ethers.toBeHex(id), 32);
  const latest = await ethers.provider.getBlockNumber();
  const lookback = Number(process.env.LOOKBACK_BLOCKS ?? 6000);
  let logs: any[] = [];
  for (let to = latest; to > latest - lookback; to -= 2000) {
    logs = (await ethers.provider.getLogs({ address: coreAddr, fromBlock: Math.max(0, to - 1999), toBlock: to, topics: [topic, null, null, mTopic] })).concat(logs);
  }
  let payout = 0, winners = 0, costSum = 0;
  for (const l of logs) {
    const d = iface.parseLog(l)!;
    const lo = Number(d.args.lowerTick), hi = Number(d.args.upperTick), qty = Number(d.args.quantity) / 1e6;
    costSum += Number(d.args.cost) / 1e6;
    if (m.settled && lo <= sTick && sTick < hi) { payout += qty; winners++; }
  }
  const Lt = premiums - proceeds - payout;
  console.log(`positions found: ${logs.length} (winners: ${winners}); Σcost from events $${costSum.toFixed(4)}`);
  console.log(`premiums   $${premiums.toFixed(4)}`);
  console.log(`proceeds   $${proceeds.toFixed(4)}`);
  console.log(`payout     $${payout.toFixed(4)}`);
  console.log(`L_t        $${Lt.toFixed(4)}   (premiums − proceeds − payout)`);
  console.log(`fees       $${fees.toFixed(4)}`);
  console.log(`LP net     $${(Lt + fees).toFixed(4)}   → ${Lt + fees >= 0 ? "PROFIT" : "LOSS"}`);
  if (payout > 0) console.log(`ψ (fees/loss) = ${(fees / Math.max(0, -Lt) || Infinity).toFixed(3)}`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
