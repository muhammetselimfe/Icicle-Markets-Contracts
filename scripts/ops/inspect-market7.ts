import hre from "hardhat";
import fs from "fs";
import path from "path";

function resolveEnvName(): string {
  const raw = (process.env.ENV || process.env.TARGET_ENV || hre.network.name || "dev").trim();
  return raw === "hardhat" ? "local" : raw;
}

const envName = resolveEnvName();
const envPath = path.resolve(__dirname, `../environments/${envName}.json`);
const env = JSON.parse(fs.readFileSync(envPath, "utf8"));

async function main() {
  const core = await hre.ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const marketId = 7n;

  const market = await core.markets(marketId);
  const currentBatchId = await core.getCurrentBatchId();

  const BATCH_SECONDS = 86400n;
  const OFFSET = 28800n;
  const tSet = market.settlementTimestamp;
  const batchId = tSet < OFFSET ? 0n : (tSet - OFFSET) / BATCH_SECONDS;
  const targetBatchId = currentBatchId + 1n;

  const [lt, ftot, ft, gt, npre, pe, processed] = await core.getDailyPnl.staticCall(batchId);
  const [lt2, ftot2, ft2, gt2, npre2, pe2, processed2] = await core.getDailyPnl.staticCall(targetBatchId);

  const [total, resolved] = await core.getBatchMarketState(batchId);
  const [total2, resolved2] = await core.getBatchMarketState(targetBatchId);

  const out = {
    network: hre.network.name,
    core: await core.getAddress(),
    currentBatchId: currentBatchId.toString(),
    market: {
      settled: market.settled,
      failed: market.failed,
      settlementTimestamp: market.settlementTimestamp.toString(),
      settlementValue: market.settlementValue.toString(),
      settlementTick: market.settlementTick.toString(),
      settlementFinalizedAt: market.settlementFinalizedAt.toString(),
      openPositionCount: market.openPositionCount.toString(),
      snapshotChunksDone: market.snapshotChunksDone,
    },
    marketBatchId: batchId.toString(),
    marketBatchState: { total: total.toString(), resolved: resolved.toString() },
    marketBatchPnl: {
      lt: lt.toString(),
      ftot: ftot.toString(),
      ft: ft.toString(),
      gt: gt.toString(),
      npre: npre.toString(),
      pe: pe.toString(),
      processed,
    },
    targetBatchId: targetBatchId.toString(),
    targetBatchState: { total: total2.toString(), resolved: resolved2.toString() },
    targetBatchPnl: {
      lt: lt2.toString(),
      ftot: ftot2.toString(),
      ft: ft2.toString(),
      gt: gt2.toString(),
      npre: npre2.toString(),
      pe: pe2.toString(),
      processed: processed2,
    },
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
