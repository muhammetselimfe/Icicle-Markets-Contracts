/**
 * Three-step script: seed LP vault, settle expired markets, process daily batch.
 *
 * Step 1: Seed vault with USDC (approve + seedVault)
 * Step 2: Settle all unsettled expired markets via secondary settlement
 * Step 3: Process the daily batch (Fee Waterfall + vault accounting)
 *
 * Usage:
 *   npx hardhat run scripts/ops/seed-settle-batch.ts --network fuji
 *
 * Env:
 *   DEPLOYER_KEY — owner private key (required)
 *   SEED_AMOUNT  — vault seed amount in USDC (default: 100000)
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

// ─── Config ────────────────────────────────────────────────────────────────
const SEED_AMOUNT_USDC = Number(process.env.SEED_AMOUNT || "100000");
const SEED_AMOUNT_6DEC = BigInt(SEED_AMOUNT_USDC) * 1_000_000n;

const CHUNK_SIZE = 25;
const MAX_CHUNK_CALLS = 20;

// Settlement value: tick * 1e6
// AVAX ticks = cents, so settlementValue = price * 100 * 1e6
// WTI/XAU ticks = dollars, so settlementValue = price * 1e6
const TICK_DIVISOR: Record<string, number> = {
  AVAX: 100,
  WTI: 1,
  XAU: 1,
  BTC: 1,
};

type AssetType = "AVAX" | "WTI" | "XAU" | "BTC" | "UNKNOWN";

function detectAsset(minTick: bigint): AssetType {
  const min = Number(minTick);
  if (min < 30) return "AVAX";
  if (min >= 30 && min < 200) return "WTI";
  if (min >= 200 && min < 2000) return "AVAX";
  if (min >= 2000 && min < 20000) return "XAU";
  if (min >= 20000) return "BTC";
  return "UNKNOWN";
}

async function fetchRedstonePrice(feedId: string, tickDivisor: number): Promise<bigint> {
  const url = `https://api.redstone.finance/prices?symbol=${feedId}&provider=redstone&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Array<{ value: number }>;
  const price = data[0]?.value;
  if (!price || price <= 0) throw new Error(`Invalid price for ${feedId}`);
  const value = BigInt(Math.round(price * tickDivisor * 1_000_000));
  const expectedTick = Number(value / 1_000_000n);
  console.log(`  [price] ${feedId}: $${price}, divisor=${tickDivisor}, value=${value}, tick=${expectedTick}`);
  return value;
}

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const usdc = await ethers.getContractAt("IERC20", envData.contracts.PaymentToken);

  // ════════════════════════════════════════════════════════════════
  // STEP 1: Seed the vault
  // ════════════════════════════════════════════════════════════════
  const isSeeded = await core.isVaultSeeded();
  if (isSeeded) {
    console.log("\n[1/3] Vault already seeded, skipping.");
  } else {
    console.log(`\n[1/3] Seeding vault with ${SEED_AMOUNT_USDC} USDC...`);

    // Approve
    const allowance = await usdc.allowance(deployer.address, coreAddress);
    if (allowance < SEED_AMOUNT_6DEC) {
      console.log("  Approving USDC...");
      const approveTx = await usdc.approve(coreAddress, SEED_AMOUNT_6DEC);
      await approveTx.wait();
    }

    // Seed
    const seedTx = await core.seedVault(SEED_AMOUNT_6DEC);
    await seedTx.wait();
    console.log(`  tx: ${seedTx.hash}`);

    const nav = await core.getVaultNav();
    const batchId = await core.getCurrentBatchId();
    console.log(`  Vault seeded! NAV=${Number(nav) / 1e18} USDC, currentBatchId=${batchId}`);
  }

  // ════════════════════════════════════════════════════════════════
  // STEP 2: Settle all unsettled expired markets
  // ════════════════════════════════════════════════════════════════
  console.log("\n[2/3] Settling expired markets...");

  const nextId = Number(await core.nextMarketId());
  const now = Math.floor(Date.now() / 1000);
  let settledCount = 0;

  // Cache prices per asset
  const priceCache = new Map<string, bigint>();

  for (let i = 1; i <= nextId; i++) {
    const market = await core.markets(i);
    if (market.settled) continue;
    if (Number(market.numBins) === 0) continue;

    const settlementTs = Number(market.settlementTimestamp);
    if (now < settlementTs + 600) {
      // Still in settlement window or not expired yet
      console.log(`  Market #${i}: still active/in settlement window, skipping`);
      continue;
    }

    const asset = detectAsset(market.minTick);
    const feedId = asset === "UNKNOWN" ? "AVAX" : asset;
    const tickDivisor = TICK_DIVISOR[feedId] ?? 1;

    console.log(`  Market #${i} (${asset}): settling...`);

    // Get price (cached per asset)
    let settlementValue: bigint;
    if (priceCache.has(feedId)) {
      settlementValue = priceCache.get(feedId)!;
    } else {
      settlementValue = await fetchRedstonePrice(feedId, tickDivisor);
      priceCache.set(feedId, settlementValue);
    }

    // Step 2a: Mark as failed
    if (!market.failed) {
      try {
        const tx = await core.markSettlementFailed(i);
        await tx.wait();
        console.log(`    markSettlementFailed tx: ${tx.hash}`);
      } catch (err: any) {
        console.error(`    markSettlementFailed failed: ${err.reason || err.message}`);
        continue;
      }
    }

    // Step 2b: Finalize secondary settlement
    try {
      await core.finalizeSecondarySettlement.staticCall(i, settlementValue);
      const tx = await core.finalizeSecondarySettlement(i, settlementValue);
      await tx.wait();
      console.log(`    finalizeSecondarySettlement tx: ${tx.hash}`);
    } catch (err: any) {
      console.error(`    finalizeSecondarySettlement failed: ${err.reason || err.message}`);
      continue;
    }

    // Step 2c: Process settlement chunks if needed
    const updated = await core.markets(i);
    if (updated.settled && !updated.snapshotChunksDone) {
      let calls = 0;
      let m = updated;
      while (!m.snapshotChunksDone && calls < MAX_CHUNK_CALLS) {
        try {
          const tx = await core.requestSettlementChunks(i, CHUNK_SIZE);
          await tx.wait();
          m = await core.markets(i);
          calls++;
        } catch {
          // May revert if chunks already done internally
          m = await core.markets(i);
          break;
        }
      }
      console.log(`    chunks: ${calls} call(s), done=${m.snapshotChunksDone}`);
    }

    const final = await core.markets(i);
    console.log(`    Result: settled=${final.settled}, tick=${final.settlementTick}, value=${final.settlementValue}`);
    settledCount++;
  }

  console.log(`  Settled ${settledCount} market(s)`);

  // ════════════════════════════════════════════════════════════════
  // STEP 3: Process daily batches
  // ════════════════════════════════════════════════════════════════
  console.log("\n[3/3] Processing daily batches...");

  let currentBatchId = await core.getCurrentBatchId();
  let batchesProcessed = 0;

  while (true) {
    const nextBatchId = currentBatchId + 1n;
    const [total, resolved] = await core.getBatchMarketState(nextBatchId);

    if (total === 0n) {
      console.log(`  Batch ${nextBatchId}: no markets, stopping`);
      break;
    }

    if (resolved !== total) {
      console.log(`  Batch ${nextBatchId}: ${resolved}/${total} resolved, not ready`);
      break;
    }

    console.log(`  Processing batch ${nextBatchId} (${total} markets, all resolved)...`);
    try {
      const tx = await core.processDailyBatch(nextBatchId);
      await tx.wait();
      console.log(`    tx: ${tx.hash}`);
      batchesProcessed++;
      currentBatchId = nextBatchId;
    } catch (err: any) {
      console.error(`    Failed: ${err.reason || err.message}`);
      break;
    }
  }

  console.log(`  Processed ${batchesProcessed} batch(es)`);

  // ════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════
  console.log("\n=== Summary ===");
  const nav = await core.getVaultNav();
  const shares = await core.getVaultShares();
  const price = await core.getVaultPrice();
  const finalBatch = await core.getCurrentBatchId();
  console.log(`  Vault NAV: ${(Number(nav) / 1e18).toFixed(2)} USDC`);
  console.log(`  Vault shares: ${(Number(shares) / 1e18).toFixed(2)}`);
  console.log(`  Share price: ${(Number(price) / 1e18).toFixed(6)}`);
  console.log(`  Current batch: ${finalBatch}`);
  console.log(`  Markets settled: ${settledCount}`);
  console.log(`  Batches processed: ${batchesProcessed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
