// Controlled end-to-end LP test: open a large WINNABLE position, settle exactly where
// it wins, process the batch, and analyze realized LP P&L.
// Run (background): MARKET_ID=1 npx hardhat run scripts/ops/controlled-win-test.ts --network fuji
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const OFFSET = 28800;
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const [d] = await ethers.getSigners();
  const id = BigInt(process.env.MARKET_ID ?? "1");
  const now0 = async () => (await ethers.provider.getBlock("latest"))!.timestamp;

  let m = await core.markets(id);
  if (m.settled) { console.log("market already settled"); return; }
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing), numBins = Number(m.numBins);
  const oBin = Math.floor((Number(m.cachedOracleTick) - minTick) / sp);
  const winTick = minTick + oBin * sp;
  console.log(`market ${id}: oracleBin=${oBin} winTick=${winTick} ($${(winTick/100).toFixed(2)})`);

  // fund + open a large WINNABLE position (wide band around the oracle)
  const dec = Number(await token.decimals());
  await (await token.mint(d.address, 100000n * 10n ** BigInt(dec))).wait();
  await (await token.approve(env.contracts.IcicleOptionsCoreProxy, ethers.MaxUint256)).wait();
  const loB = Math.max(0, oBin - 3), hiB = Math.min(numBins - 1, oBin + 3);
  const lo = minTick + loB * sp, hi = minTick + (hiB + 1) * sp, q = 1000n * 1_000_000n;
  let now = await now0();
  if (now < Number(m.startTimestamp)) { await sleep(Number(m.startTimestamp) - now + 2); }
  const c = await core.calculateOpenCost.staticCall(id, lo, hi, q);
  await (await core.connect(d).openPosition(id, lo, hi, q, c * 2n + 5_000_000n, { gasLimit: 14_000_000 })).wait();
  console.log(`opened WINNABLE: bins[${loB}-${hiB}] ($${(lo/100).toFixed(2)}-$${(hi/100).toFixed(2)}) 1000u cost $${(Number(c)/1e6).toFixed(2)}`);

  m = await core.markets(id);
  const premiums = Number(ethers.formatUnits(m.accumulatedPremiums, 18));
  const feesAcc = Number(ethers.formatUnits(m.accumulatedFees, 18));

  // bring settlement to ~now (secondary path, controlled win)
  now = await now0();
  const settlement = now + 40, end = now + 20;
  await (await core.updateMarketTiming(id, Number(m.startTimestamp), end, settlement)).wait();
  const submitW = Number(await core.settlementSubmitWindow());
  const period = Number(await core.batchSeconds());
  const settleBatch = Math.floor((settlement - OFFSET) / period);
  console.log(`settlement -> now+40, settleBatch=${settleBatch}, submitWindow=${submitW}s, batchPeriod=${period}s`);

  // wait for submit window to expire so markSettlementFailed is allowed
  const failAt = settlement + submitW + 5;
  while ((now = await now0()) < failAt) { console.log(`  waiting markFailed (${failAt - now}s)`); await sleep(Math.min(30, failAt - now + 1)); }
  await (await core.markSettlementFailed(id)).wait();
  await (await core.finalizeSecondarySettlement(id, BigInt(winTick) * 1_000_000n)).wait();
  console.log(`settled (secondary) at tick ${winTick} -> winnable band WON`);
  for (let i = 0; i < 12; i++) { if ((await core.markets(id)).snapshotChunksDone) break; await (await core.requestSettlementChunks(id, 50)).wait(); }

  // wait for the batch to end, then process
  const batchEnd = (settleBatch + 1) * period + OFFSET;
  while ((now = await now0()) <= batchEnd) { console.log(`  waiting batch end (${batchEnd - now}s)`); await sleep(Math.min(60, batchEnd - now + 1)); }
  const navBefore = Number(ethers.formatUnits(await core.getVaultNav(), 18));
  await (await core.processDailyBatch(settleBatch)).wait();
  const navAfter = Number(ethers.formatUnits(await core.getVaultNav(), 18));
  const dp = await core.getDailyPnl(settleBatch);
  const lt = Number(ethers.formatUnits(dp[0], 18)), ftot = Number(ethers.formatUnits(dp[1], 18));

  console.log("\n================ LP P&L ANALYSIS (market " + id + ") ================");
  console.log(`settled at bin ${oBin} ($${(winTick/100).toFixed(2)}) -> the winnable position WON`);
  console.log(`premiums collected by LP : $${premiums.toFixed(2)}`);
  console.log(`fees collected           : $${feesAcc.toFixed(4)}`);
  console.log(`realized L_t             : $${lt.toFixed(2)}   (premiums - proceeds - payout)`);
  console.log(`LP NAV: $${navBefore.toFixed(2)} -> $${navAfter.toFixed(2)}   (${navAfter - navBefore >= 0 ? "+" : ""}${(navAfter - navBefore).toFixed(2)})`);
  console.log(navAfter >= navBefore ? `=> LP PROFIT $${(navAfter - navBefore).toFixed(2)}` : `=> LP LOSS $${(navBefore - navAfter).toFixed(2)}`);
  console.log("note: winnable positions are priced ~fairly (expensive), so a forced win is the");
  console.log("downside of a fair bet; over random settlement the LP nets ~0 + fees.");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
