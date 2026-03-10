/**
 * Create a 1-day AVAX market with $0.05 price ticks on Fuji.
 *
 * Ticks are stored as cents (integers). E.g. tick=900 → $9.00.
 * tickSpacing=5 → $0.05 per bin.
 * Range: $7.00 – $11.00 → ticks 700 – 1100, 80 bins.
 *
 * Usage:
 *   npx hardhat run scripts/ops/create-market-1day-avax-5cent.ts --network fuji
 *
 * Requires DEPLOYER_KEY in env or .env file.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;

// --- Config ---
const ANCHOR_PRICE = 900; // $9.00 in cents
const TICK_SPACING = 5; // $0.05 per tick
const NUM_BINS = 80; // range: $7.00 – $11.00
const DURATION_SEC = 24 * 60 * 60; // 1 day
const START_DELAY_SEC = 10; // start 10s from now
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
  const owner = await core.owner();
  console.log(`Core owner: ${owner}`);

  // Compute tick bounds centered on anchor price (in cents)
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
  console.log(`Price range: $${(minTick / 100).toFixed(2)} – $${(maxTick / 100).toFixed(2)}`);

  // Timestamps
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const startTimestamp = now + START_DELAY_SEC;
  const endTimestamp = startTimestamp + DURATION_SEC;
  const settlementTimestamp = endTimestamp;

  console.log(`Start: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}`);

  // Generate uniform prior factors (simple for test market)
  const factors: bigint[] = Array(NUM_BINS).fill(WAD); // 1 WAD each = uniform
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

  console.log("\nMarket ready!");
  console.log(`  Market ID: ${marketId}`);
  console.log(`  Range: $${(minTick / 100).toFixed(2)} – $${(maxTick / 100).toFixed(2)}`);
  console.log(`  Tick spacing: $${(TICK_SPACING / 100).toFixed(2)} (${TICK_SPACING} cents)`);
  console.log(`  Bins: ${NUM_BINS}`);
  console.log(`  Trading: ${DURATION_SEC / 3600} hours`);
  console.log(`  Start: ${new Date(startTimestamp * 1000).toLocaleTimeString()}`);
  console.log(`  End:   ${new Date(endTimestamp * 1000).toLocaleTimeString()}`);
  console.log(`\n  NOTE: Ticks are in cents. Settlement value must also be in cents.`);
  console.log(`        e.g. AVAX at $9.12 → settlement tick = 912`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
