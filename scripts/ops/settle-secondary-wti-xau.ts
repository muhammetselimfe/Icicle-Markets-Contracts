/**
 * Settle markets #24 (WTI) and #25 (XAU) via secondary settlement.
 * Primary oracle (Redstone) doesn't carry WTI/XAU on redstone-primary-prod.
 *
 * For market #25 (XAU), we also need to adjust timing first (updateMarketTiming).
 *
 * Prices from Redstone API:
 *   WTI: ~$94.18 → settlementValue = 94_180_000 → tick 94
 *   XAU: ~$5,106.81 → settlementValue = 5_106_810_000 → tick 5106
 *
 * Usage:
 *   npx hardhat run scripts/ops/settle-secondary-wti-xau.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const CHUNK_SIZE = 25;
const MAX_CHUNK_CALLS = 20;

interface SecondarySettleConfig {
  marketId: bigint;
  asset: string;
  settlementValue: bigint;
  needsTimingAdjust: boolean;
  feedDecimals: number;
}

const MARKETS: SecondarySettleConfig[] = [
  {
    marketId: 25n,
    asset: "XAU",
    // $5,106.81 * 1 (tickDivisor) * 1e6 = 5_106_810_000
    settlementValue: 5_106_810_000n,
    needsTimingAdjust: true, // needs timing adjustment
    feedDecimals: 8,
  },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in fuji.json");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const submitWindowSec = Number(await core.settlementSubmitWindow());
  const pendingOpsSec = Number(await core.pendingOpsWindow());
  console.log(`Settlement windows: submit=${submitWindowSec}s, pendingOps=${pendingOpsSec}s`);

  for (const cfg of MARKETS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`MARKET #${cfg.marketId} — ${cfg.asset}`);
    console.log("=".repeat(60));

    const before = await core.markets(cfg.marketId);
    console.log(`  settled=${before.settled}, failed=${before.failed}, numBins=${before.numBins}`);
    console.log(`  range: ${before.minTick} to ${before.maxTick}, spacing=${before.tickSpacing}`);

    if (before.settled) {
      console.log("  Already settled, skipping.");
      continue;
    }

    // Step 0: Adjust timing if needed (move endTimestamp to past)
    if (cfg.needsTimingAdjust) {
      const latestBlock = await ethers.provider.getBlock("latest");
      const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);

      // Set settlement to now - 540s (within submit window)
      const lagSec = 540;
      const settlementTs = now - lagSec;
      let endTs = settlementTs;
      let startTs = Number(before.startTimestamp);
      if (startTs >= endTs) startTs = endTs - 1;

      console.log(`  updateMarketTiming: start=${startTs}, end=${endTs}, settle=${settlementTs}`);
      await (await core.updateMarketTiming(cfg.marketId, startTs, endTs, settlementTs)).wait();

      // Wait for submit window to close (opsStart = settlementTs + submitWindowSec)
      const opsStart = settlementTs + submitWindowSec;
      const nowAfter = Math.floor(Date.now() / 1000);
      const waitSec = opsStart - nowAfter + 5; // +5s buffer for block lag
      if (waitSec > 0) {
        console.log(`  Waiting ${waitSec}s for PendingOps window to open...`);
        await sleep(waitSec * 1000);
      }
    } else {
      // Check if we need to wait for the submit window to close
      const settlementTs = Number(before.settlementTimestamp);
      const windowEnd = settlementTs + submitWindowSec;
      const now = Math.floor(Date.now() / 1000);
      if (now < windowEnd) {
        const waitSec = windowEnd - now + 1;
        console.log(`  Waiting ${waitSec}s for submit window to close...`);
        await sleep(waitSec * 1000);
      }
    }

    // Step 1: Mark as failed
    const m = await core.markets(cfg.marketId);
    if (!m.failed) {
      console.log(`  [1/3] markSettlementFailed...`);
      const tx = await core.markSettlementFailed(cfg.marketId);
      await tx.wait();
      console.log(`    tx: ${tx.hash}`);
    } else {
      console.log(`  [1/3] already marked failed`);
    }

    // Step 2: Finalize secondary settlement
    const expectedTick = Number(cfg.settlementValue) / 1_000_000;
    console.log(`  [2/3] finalizeSecondarySettlement (value=${cfg.settlementValue}, tick=${expectedTick})...`);
    // Static call first for error checking
    await core.finalizeSecondarySettlement.staticCall(cfg.marketId, cfg.settlementValue);
    const tx2 = await core.finalizeSecondarySettlement(cfg.marketId, cfg.settlementValue);
    await tx2.wait();
    console.log(`    tx: ${tx2.hash}`);

    // Step 3: Settlement chunks
    const updated = await core.markets(cfg.marketId);
    console.log(`  settled=${updated.settled}, settlementTick=${updated.settlementTick}, settlementValue=${updated.settlementValue}`);

    if (updated.settled && !updated.snapshotChunksDone) {
      console.log(`  [3/3] requestSettlementChunks...`);
      let calls = 0;
      let curr = updated;
      while (!curr.snapshotChunksDone && calls < MAX_CHUNK_CALLS) {
        try {
          const tx = await core.requestSettlementChunks(cfg.marketId, CHUNK_SIZE);
          await tx.wait();
        } catch (e: any) {
          console.log(`    chunk call ${calls + 1} reverted (likely done)`);
          break;
        }
        curr = await core.markets(cfg.marketId);
        calls++;
      }
      console.log(`    ${calls} chunk call(s), snapshotChunksDone=${curr.snapshotChunksDone}`);
    } else {
      console.log(`  [3/3] chunks already done or no positions`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
