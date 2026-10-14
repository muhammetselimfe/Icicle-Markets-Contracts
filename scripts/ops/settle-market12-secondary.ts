/**
 * Settle expired market #12 (AVAX/USD) via secondary settlement.
 * Uses the historical Redstone AVAX price at settlement time:
 *   $9.3934 at 2026-03-10T13:57:00 UTC (timestamp 1773151020000)
 *
 * Steps:
 *   1. markSettlementFailed(12)
 *   2. finalizeSecondarySettlement(12, 9393409)  — 6 decimals
 *   3. requestSettlementChunks(12, 25)           — snapshot loop
 *
 * Usage:
 *   npx hardhat run scripts/ops/settle-market12-secondary.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const MARKET_ID = 12n;
// AVAX price at settlement time: $9.3934089947025 (Redstone, 2026-03-10T13:57:00 UTC)
// AVAX ticks are in cents. Contract: tick = settlementValue / 1e6
// So: settlementValue = price * 100 (cents) * 1e6 = 9.3934 * 100 * 1e6 = 939_340_900
// Expected tick: 939_340_900 / 1e6 = 939 (= $9.35-$9.40 bin)
// NOTE: Market #12 was already incorrectly settled with 9_393_409 (tick 700).
//       This script cannot fix it since settled=true. Kept for reference.
const SETTLEMENT_VALUE = 939_340_900n;

const CHUNK_SIZE = 25;
const MAX_CHUNK_CALLS = 20;

async function main() {
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in fuji.json");

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await hre.ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Read current state
  const before = await core.markets(MARKET_ID);
  console.log(`Market #${MARKET_ID} before:`, {
    settled: before.settled,
    failed: before.failed,
    ticks: `${before.minTick}-${before.maxTick}`,
    numBins: Number(before.numBins),
  });

  if (before.settled) {
    console.log("Already settled, nothing to do.");
    return;
  }

  // Step 1: Mark as failed
  if (!before.failed) {
    console.log("[1/3] markSettlementFailed...");
    const tx = await core.markSettlementFailed(MARKET_ID);
    await tx.wait();
    console.log(`  tx: ${tx.hash}`);
  } else {
    console.log("[1/3] already marked failed");
  }

  // Step 2: Finalize secondary settlement with historical price
  console.log(`[2/3] finalizeSecondarySettlement (value=${SETTLEMENT_VALUE}, ~$${Number(SETTLEMENT_VALUE) / 1_000_000})...`);
  await core.finalizeSecondarySettlement.staticCall(MARKET_ID, SETTLEMENT_VALUE);
  const tx2 = await core.finalizeSecondarySettlement(MARKET_ID, SETTLEMENT_VALUE);
  await tx2.wait();
  console.log(`  tx: ${tx2.hash}`);

  // Step 3: Process settlement chunks
  const updated = await core.markets(MARKET_ID);
  if (updated.settled && !updated.snapshotChunksDone) {
    console.log("[3/3] requestSettlementChunks...");
    let calls = 0;
    let m = updated;
    while (!m.snapshotChunksDone && calls < MAX_CHUNK_CALLS) {
      const tx = await core.requestSettlementChunks(MARKET_ID, CHUNK_SIZE);
      await tx.wait();
      m = await core.markets(MARKET_ID);
      calls++;
    }
    console.log(`  done (${calls} chunk call(s)), snapshotChunksDone=${m.snapshotChunksDone}`);
  } else {
    console.log("[3/3] chunks already done or no positions");
  }

  // Verify
  const after = await core.markets(MARKET_ID);
  console.log(`\nMarket #${MARKET_ID} after:`, {
    settled: after.settled,
    failed: after.failed,
    settlementValue: after.settlementValue.toString(),
    settlementTick: after.settlementTick.toString(),
    settlementFinalizedAt: after.settlementFinalizedAt.toString(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
