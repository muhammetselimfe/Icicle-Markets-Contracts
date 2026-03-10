/**
 * Settle expired test markets (#1, #2) via secondary settlement,
 * then create a new 1-hour AVAX market on Fuji.
 *
 * Usage:
 *   npx hardhat run scripts/ops/settle-and-create-1hr-avax.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;

// --- Settlement config ---
const MARKETS_TO_SETTLE = [1, 2];
const SETTLEMENT_VALUE = 9_000_000n; // $9 in 6 decimals (AVAX ~$9)

// --- New market config ---
const ANCHOR_PRICE = 9;      // AVAX ~$9
const TICK_SPACING = 1;      // $1 per tick
const NUM_BINS = 10;         // range: $4 – $14
const DURATION_SEC = 60 * 60; // 1 hour
const START_DELAY_SEC = 10;   // start 10s from now
const ALPHA_WAD = "100000000000000000000"; // 100 WAD (test liquidity)
const SEED_CHUNK_SIZE = 50;

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");

  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const feePolicyAddress = envData.contracts.FeePolicy10bps;
  if (!coreAddress || !feePolicyAddress) {
    throw new Error("Missing core or feePolicy address in fuji.json");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // ========== PART 1: Settle existing markets ==========
  console.log("\n=== Settling expired markets ===");

  for (const id of MARKETS_TO_SETTLE) {
    const marketId = BigInt(id);
    console.log(`\n--- Market #${id} ---`);

    const market = await core.markets(marketId);
    if (market.settled) {
      console.log(`  Already settled, skipping`);
      continue;
    }

    // Step 1: Mark as failed (if not already failed)
    if (!market.failed) {
      console.log(`  Marking as failed...`);
      try {
        const tx = await core.markSettlementFailed(marketId);
        await tx.wait();
        console.log(`  Marked failed: ${tx.hash}`);
      } catch (err: any) {
        console.error(`  markSettlementFailed failed:`, err.message || err);
        continue;
      }
    } else {
      console.log(`  Already marked as failed`);
    }

    // Step 2: Finalize secondary settlement with manual price
    console.log(`  Finalizing secondary settlement (value=${SETTLEMENT_VALUE})...`);
    try {
      // Static call first
      await core.finalizeSecondarySettlement.staticCall(marketId, SETTLEMENT_VALUE);
      const tx = await core.finalizeSecondarySettlement(marketId, SETTLEMENT_VALUE);
      await tx.wait();
      console.log(`  Settled: ${tx.hash}`);
    } catch (err: any) {
      console.error(`  finalizeSecondarySettlement failed:`, err.message || err);
      continue;
    }

    // Step 3: Process settlement chunks (if any positions exist)
    const updated = await core.markets(marketId);
    if (updated.settled && !updated.snapshotChunksDone) {
      console.log(`  Processing settlement chunks...`);
      let calls = 0;
      let m = updated;
      while (!m.snapshotChunksDone && calls < 20) {
        const tx = await core.requestSettlementChunks(marketId, 25);
        await tx.wait();
        m = await core.markets(marketId);
        calls++;
      }
      console.log(`  Chunks done (${calls} calls)`);
    }

    console.log(`  Market #${id} settled successfully!`);
  }

  // ========== PART 2: Create new 1-hour market ==========
  console.log("\n=== Creating new 1-hour AVAX market ===");

  const centerTick = Math.round(ANCHOR_PRICE / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const binsAbove = NUM_BINS - binsBelow;
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + binsAbove * TICK_SPACING;
  const computedBins = (maxTick - minTick) / TICK_SPACING;

  if (computedBins !== NUM_BINS) {
    throw new Error(`Bin mismatch: expected=${NUM_BINS} got=${computedBins}`);
  }

  console.log(`Ticks: [${minTick}, ${maxTick}) spacing=${TICK_SPACING} bins=${NUM_BINS}`);
  console.log(`Price range: $${minTick} – $${maxTick}`);

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const startTimestamp = now + START_DELAY_SEC;
  const endTimestamp = startTimestamp + DURATION_SEC;
  const settlementTimestamp = endTimestamp;

  console.log(`Start: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}`);

  // Generate uniform prior factors
  const factors: bigint[] = Array(NUM_BINS).fill(WAD);
  const packedFactors = ethers.solidityPacked(
    Array(factors.length).fill("uint256"),
    factors,
  );

  // Deploy SeedData
  console.log("Deploying SeedData...");
  const seedData = await (
    await ethers.getContractFactory("SeedData")
  ).deploy(packedFactors);
  await seedData.waitForDeployment();
  const seedDataAddress = seedData.target;
  console.log(`SeedData: ${seedDataAddress}`);

  // Static call to verify params
  const alphaWad = BigInt(ALPHA_WAD);
  try {
    const marketId = await core.createMarket.staticCall(
      minTick,
      maxTick,
      TICK_SPACING,
      startTimestamp,
      endTimestamp,
      settlementTimestamp,
      NUM_BINS,
      alphaWad,
      feePolicyAddress,
      seedDataAddress,
    );
    console.log(`Static call OK — would create marketId=${marketId}`);
  } catch (err) {
    console.error("Static call failed:", err);
    throw err;
  }

  // Execute createMarket
  console.log("Creating market...");
  const blockGasLimit = latestBlock?.gasLimit ?? 0n;
  const txData = core.interface.encodeFunctionData("createMarket", [
    minTick,
    maxTick,
    TICK_SPACING,
    startTimestamp,
    endTimestamp,
    settlementTimestamp,
    NUM_BINS,
    alphaWad,
    feePolicyAddress,
    seedDataAddress,
  ]);
  const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
  const tx = await deployer.sendTransaction({
    to: coreAddress,
    data: txData,
    ...overrides,
  });
  const receipt = await tx.wait();
  console.log(`Tx: ${receipt?.hash}`);

  const marketId = await core.nextMarketId();
  console.log(`Market created! marketId=${marketId}`);

  // Seed bins
  let remaining = NUM_BINS;
  while (remaining > 0) {
    const count = Math.min(remaining, SEED_CHUNK_SIZE);
    console.log(`Seeding ${count} bins (${remaining} remaining)...`);
    const seedTx = await core.seedNextChunks(marketId, count);
    await seedTx.wait();
    remaining -= count;
  }

  console.log("\n=== Done! ===");
  console.log(`  Settled markets: ${MARKETS_TO_SETTLE.join(", ")}`);
  console.log(`  New Market ID: ${marketId}`);
  console.log(`  Range: $${minTick} – $${maxTick}`);
  console.log(`  Bins: ${NUM_BINS}`);
  console.log(`  Duration: ${DURATION_SEC / 60} minutes (1 hour)`);
  console.log(`  Start: ${new Date(startTimestamp * 1000).toLocaleTimeString()}`);
  console.log(`  End:   ${new Date(endTimestamp * 1000).toLocaleTimeString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
