/**
 * Create a 15-minute AVAX test market on Fuji.
 *
 * Usage:
 *   npx hardhat run scripts/ops/create-market-15min-avax.ts --network fuji
 *
 * Requires DEPLOYER_KEY in env or .env file.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;

// --- Config ---
const ANCHOR_PRICE = 9; // AVAX ~$9
const TICK_SPACING = 1; // $1 per tick
const NUM_BINS = 10; // range: $4 – $14
const DURATION_SEC = 15 * 60; // 15 minutes
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

  // Compute tick bounds centered on anchor price
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

  // Seed bins
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
  console.log(`  Range: $${minTick} – $${maxTick}`);
  console.log(`  Bins: ${NUM_BINS}`);
  console.log(`  Trading: ${DURATION_SEC / 60} minutes`);
  console.log(`  Start: ${new Date(startTimestamp * 1000).toLocaleTimeString()}`);
  console.log(`  End:   ${new Date(endTimestamp * 1000).toLocaleTimeString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
