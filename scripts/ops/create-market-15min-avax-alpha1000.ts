/**
 * Create 15-min AVAX market: α=1000, σ=8, 200bps, anchored at LIVE price.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n;
const MAX_FACTOR = WAD * 100n;

const TICK_SPACING = 5;
const NUM_BINS = 80;
const DURATION_SEC = 15 * 60;
const ALPHA_WAD = "1000000000000000000000"; // 1000 WAD
const SEED_CHUNK_SIZE = 50;
const SIGMA_BINS = 8;

function generateGaussianFactors(numBins: number, centerBin: number, sigma: number): bigint[] {
  const factors: bigint[] = [];
  for (let i = 0; i < numBins; i++) {
    const distance = i - centerBin;
    const exponent = -(distance * distance) / (2 * sigma * sigma);
    const value = Math.exp(exponent);
    let factorWad = BigInt(Math.round(value * 1e18));
    if (factorWad < MIN_FACTOR) factorWad = MIN_FACTOR;
    if (factorWad > MAX_FACTOR) factorWad = MAX_FACTOR;
    factors.push(factorWad);
  }
  return factors;
}

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const feePolicyAddress = envData.contracts.FeePolicy200bps;
  if (!coreAddress || !feePolicyAddress) throw new Error("Missing addresses");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Fetch live AVAX price
  const res = await fetch("https://api.redstone.finance/prices?symbol=AVAX&provider=redstone&limit=1");
  const data = await res.json() as any[];
  const livePrice = data[0]?.value;
  if (!livePrice) throw new Error("Failed to fetch AVAX price");

  const ANCHOR_PRICE = Math.round(livePrice * 100); // cents
  console.log(`Live AVAX: $${livePrice.toFixed(4)} → anchor tick ${ANCHOR_PRICE}`);

  const centerTick = Math.round(ANCHOR_PRICE / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + (NUM_BINS - binsBelow) * TICK_SPACING;
  const computedBins = (maxTick - minTick) / TICK_SPACING;
  if (computedBins !== NUM_BINS) throw new Error(`Bin mismatch: ${computedBins} != ${NUM_BINS}`);

  const centerBin = Math.floor((ANCHOR_PRICE - minTick) / TICK_SPACING);

  console.log(`\n=== AVAX 15-min α=1000 σ=8 Market ===`);
  console.log(`Range: $${(minTick/100).toFixed(2)} – $${(maxTick/100).toFixed(2)}`);
  console.log(`Center: $${(centerTick/100).toFixed(2)} (bin ${centerBin})`);
  console.log(`Alpha: 1000 WAD (max loss: $${(1000 * Math.log(NUM_BINS)).toFixed(0)})`);
  console.log(`Duration: 15 minutes`);
  console.log(`Fee: 200bps, σ=8`);

  const factors = generateGaussianFactors(NUM_BINS, centerBin, SIGMA_BINS);
  const packedFactors = ethers.solidityPacked(Array(factors.length).fill("uint256"), factors);

  console.log("\nDeploying SeedData...");
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packedFactors);
  await seedData.waitForDeployment();

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const startTimestamp = now + 10;
  const endTimestamp = startTimestamp + DURATION_SEC;

  // Check if settlement batch would conflict with already-processed batches
  // Contract uses BATCH_TIMEZONE_OFFSET = 28800 (8h UTC): batchId = (ts - 28800) / 86400
  const BATCH_OFFSET = 28800;
  const currentBatchId = Number(await core.getCurrentBatchId());
  const endBatch = Math.floor((endTimestamp - BATCH_OFFSET) / 86400);
  console.log(`Current processed batch: ${currentBatchId}, end batch: ${endBatch}`);

  // If end batch is already processed, push settlement to next unprocessed batch
  let settlementTimestamp = endTimestamp;
  if (endBatch <= currentBatchId) {
    // Next batch starts at (currentBatchId + 1) * 86400 + BATCH_OFFSET
    settlementTimestamp = (currentBatchId + 1) * 86400 + BATCH_OFFSET + 60;
    console.log(`Batch ${endBatch} already processed. Pushing settlement to batch ${currentBatchId + 1}`);
    console.log(`  Trading: 15 min as normal. Settlement delayed to ${new Date(settlementTimestamp * 1000).toISOString()}`);
  }

  console.log(`Start: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}`);

  const alphaWad = BigInt(ALPHA_WAD);

  // Use staticCall first to check for revert reason
  try {
    await core.createMarket.staticCall(
      minTick, maxTick, TICK_SPACING,
      startTimestamp, endTimestamp, settlementTimestamp,
      NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
    );
    console.log("staticCall passed, sending tx...");
  } catch (e: any) {
    console.log(`staticCall revert: ${e.message?.slice(0, 300)}`);
    throw e;
  }

  const tx = await core.createMarket(
    minTick, maxTick, TICK_SPACING,
    startTimestamp, endTimestamp, settlementTimestamp,
    NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
    { gasLimit: 8_000_000 },
  );
  await tx.wait();

  const nextId = Number(await core.nextMarketId());
  const marketId = nextId; // nextMarketId was incremented in createMarket, so the created market = nextMarketId value
  console.log(`\nMarket created! ID=${marketId}`);

  // Check if already seeded
  const m = await core.markets(BigInt(marketId));
  if (!m.isSeeded) {
    let remaining = NUM_BINS;
    while (remaining > 0) {
      const count = Math.min(remaining, SEED_CHUNK_SIZE);
      await (await core.seedNextChunks(marketId, count)).wait();
      remaining -= count;
    }
    console.log("Seeded!");
  } else {
    console.log("Already seeded!");
  }
  console.log(`\nMarket #${marketId} — AVAX 15-min, α=1000, σ=8, 200bps`);
  console.log(`Trading ends: ${new Date(endTimestamp * 1000).toISOString()}`);
  console.log(`Settlement: ${new Date(settlementTimestamp * 1000).toISOString()}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
