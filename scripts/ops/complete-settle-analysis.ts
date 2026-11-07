// Finish the controlled test: wait for the settled market's batch to end, process it,
// and analyze realized LP P&L.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
const OFFSET = 28800;
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const id = BigInt(process.env.MARKET_ID ?? "1");
  const now0 = async () => (await ethers.provider.getBlock("latest"))!.timestamp;

  const m = await core.markets(id);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing);
  const winBin = (Number(m.settlementTick) - minTick) / sp;
  const premiums = Number(ethers.formatUnits(m.accumulatedPremiums, 18));
  const period = Number(await core.batchSeconds());
  const settleBatch = Math.floor((Number(m.settlementTimestamp) - OFFSET) / period);
  const batchEnd = (settleBatch + 1) * period + OFFSET;

  let now = await now0();
  while (now <= batchEnd) { console.log(`waiting batch end (${batchEnd - now}s)`); await sleep(Math.min(30, batchEnd - now + 2)); now = await now0(); }

  const cur = Number(await core.getCurrentBatchId());
  console.log(`settleBatch=${settleBatch} currentBatchId=${cur} (need batchId==currentBatchId+1=${cur + 1})`);
  const navBefore = Number(ethers.formatUnits(await core.getVaultNav(), 18));
  await (await core.processDailyBatch(settleBatch)).wait();
  const navAfter = Number(ethers.formatUnits(await core.getVaultNav(), 18));
  const dp = await core.getDailyPnl.staticCall(settleBatch);
  const lt = Number(ethers.formatUnits(dp[0], 18)), ftot = Number(ethers.formatUnits(dp[1], 18));

  console.log("\n================ LP P&L ANALYSIS (market " + id + ") ================");
  console.log(`settled at bin ${winBin} ($${(Number(m.settlementTick)/100).toFixed(2)}) -> winnable band [36-42] WON`);
  console.log(`premiums collected by LP : $${premiums.toFixed(2)}`);
  console.log(`realized L_t             : $${lt.toFixed(2)}   (= premiums - proceeds - payout)`);
  console.log(`implied payout to winners: $${(premiums - lt).toFixed(2)}`);
  console.log(`fees                     : $${ftot.toFixed(4)}`);
  console.log(`LP NAV: $${navBefore.toFixed(2)} -> $${navAfter.toFixed(2)}   (${navAfter - navBefore >= 0 ? "+" : ""}${(navAfter - navBefore).toFixed(2)})`);
  console.log(navAfter >= navBefore ? `=> LP PROFIT $${(navAfter - navBefore).toFixed(2)}` : `=> LP LOSS $${(navBefore - navAfter).toFixed(2)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
