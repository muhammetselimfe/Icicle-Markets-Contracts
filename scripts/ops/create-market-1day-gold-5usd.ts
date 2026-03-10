/**
 * Create a 1-day Gold (XAU) market with $5 price ticks on Fuji.
 *
 * Ticks are stored as dollars (integers). E.g. tick=5100 → $5,100.
 * tickSpacing=5 → $5 per bin.
 * Range: $4,930 – $5,430 → ticks 4930 – 5430, 100 bins.
 *
 * Usage:
 *   npx hardhat run scripts/ops/create-market-1day-gold-5usd.ts --network fuji
 *
 * Requires DEPLOYER_KEY in env or .env file.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;

// --- Config ---
const ANCHOR_PRICE = 5180; // $5,180 in dollars
const TICK_SPACING = 5; // $5 per bin
const NUM_BINS = 100; // range: ~±$250 from anchor
const DURATION_SEC = 24 * 60 * 60; // 1 day
const START_DELAY_SEC = 10; // start 10s from now
const ALPHA_WAD = "10000000000000000000000"; // 10,000 WAD (higher liquidity)
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

  // Compute tick bounds centered on anchor price (in dollars)
  const centerTick = Math.round(ANCHOR_PRICE / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const binsAbove = NUM_BINS - binsBelow;
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + binsAbove * TICK_SPACING;
  const computedBins = (maxTick - minTick) / TICK_SPACING;

  if (computedBins !== NUM_BINS) {
    throw new Error(`Bin mismatch: expected=${NUM_BINS} got=${computedBins}`);
  }

  console.log(`\n=== Gold (XAU) Market ===`);
  console.log(`Ticks: [${minTick}, ${maxTick}) spacing=${TICK_SPACING} bins=${NUM_BINS}`);
  console.log(`Price range: $${minTick.toLocaleString()} – $${maxTick.toLocaleString()}`);
  console.log(`Alpha: 10,000 WAD`);

  // Timestamps
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
  console.log("\nDeploying SeedData...");
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

  // nextMarketId = ID of the last created market
  const marketId = await core.nextMarketId();
  console.log(`Market created! marketId=${marketId}`);

  // Seed bins in chunks
  let remaining = NUM_BINS;
  while (remaining > 0) {
    const count = Math.min(remaining, SEED_CHUNK_SIZE);
    console.log(`Seeding ${count} bins (${remaining} remaining)...`);
    const seedTx = await core.seedNextChunks(marketId, count);
    await seedTx.wait();
    remaining -= count;
  }

  console.log("\n=== Market Ready! ===");
  console.log(`  Market ID: ${marketId}`);
  console.log(`  Asset: Gold (XAU)`);
  console.log(`  Range: $${minTick.toLocaleString()} – $${maxTick.toLocaleString()}`);
  console.log(`  Tick spacing: $${TICK_SPACING}`);
  console.log(`  Bins: ${NUM_BINS}`);
  console.log(`  Alpha: 10,000 WAD`);
  console.log(`  Trading: ${DURATION_SEC / 3600} hours`);
  console.log(`  Start: ${new Date(startTimestamp * 1000).toLocaleTimeString()}`);
  console.log(`  End:   ${new Date(endTimestamp * 1000).toLocaleTimeString()}`);
  console.log(`\n  NOTE: Ticks are in dollars. Settlement value must also be in dollars.`);
  console.log(`        e.g. Gold at $5,180.50 → settlement tick = 5180`);
  console.log(`        Oracle feed: "XAU" (Redstone, 8 decimals)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
