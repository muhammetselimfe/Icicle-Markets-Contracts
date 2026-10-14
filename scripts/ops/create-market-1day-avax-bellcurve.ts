/**
 * Create a 1-day AVAX market with bell curve (Gaussian) prior on Fuji.
 *
 * Bins near the current price get higher factors (more expensive),
 * tail bins get lower factors. This gives the vault a risk premium.
 *
 * Usage:
 *   npx hardhat run scripts/ops/create-market-1day-avax-bellcurve.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n; // 0.01 WAD — contract minimum
const MAX_FACTOR = WAD * 100n; // 100 WAD — contract maximum

// --- Config ---
const ANCHOR_PRICE = 857; // $8.57 in cents (current AVAX price ~$8.57)
const TICK_SPACING = 5; // $0.05 per bin
const NUM_BINS = 80; // range: +/-$2 from anchor
const DURATION_SEC = 24 * 60 * 60; // 1 day
const START_DELAY_SEC = 10; // 10s delay
const ALPHA_WAD = "1000000000000000000000"; // 1,000 WAD
const SEED_CHUNK_SIZE = 50;

// Bell curve config — calibrated sigma=4 bins ($0.20 daily vol band)
const SIGMA_BINS = 4;

/**
 * Generate Gaussian bell curve factors.
 * Center bin gets 1 WAD, tails decay towards MIN_FACTOR.
 */
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
  const feePolicyAddress = envData.contracts.FeePolicy100bps;
  if (!coreAddress || !feePolicyAddress) {
    throw new Error("Missing core or feePolicy address in fuji.json");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

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

  const centerBin = Math.floor((ANCHOR_PRICE - minTick) / TICK_SPACING);

  console.log(`\n=== AVAX Daily Bell Curve Market ===`);
  console.log(`Ticks: [${minTick}, ${maxTick}) spacing=${TICK_SPACING} bins=${NUM_BINS}`);
  console.log(`Price range: $${(minTick / 100).toFixed(2)} - $${(maxTick / 100).toFixed(2)}`);
  console.log(`Anchor: $${(ANCHOR_PRICE / 100).toFixed(2)} (center bin=${centerBin})`);
  console.log(`Sigma: ${SIGMA_BINS} bins ($${(SIGMA_BINS * TICK_SPACING / 100).toFixed(2)})`);
  console.log(`Alpha: 1,000 WAD`);
  console.log(`Fee: 1% (FeePolicy100bps)`);
  console.log(`Duration: 24 hours`);

  // Generate bell curve factors
  const factors = generateGaussianFactors(NUM_BINS, centerBin, SIGMA_BINS);

  // Print factor distribution
  console.log(`\nFactor distribution (sample):`);
  const sampleBins = [0, 10, 20, 30, centerBin - 5, centerBin, centerBin + 5, 50, 60, 70, 79];
  for (const b of sampleBins) {
    if (b >= 0 && b < NUM_BINS) {
      const tick = minTick + b * TICK_SPACING;
      const fVal = Number(factors[b]) / 1e18;
      const bar = "█".repeat(Math.round(fVal * 20));
      console.log(`  Bin ${String(b).padStart(2)}: $${(tick / 100).toFixed(2)} -> ${fVal.toFixed(4)} ${bar}`);
    }
  }

  // Timestamps
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const startTimestamp = now + START_DELAY_SEC;
  const endTimestamp = startTimestamp + DURATION_SEC;
  const settlementTimestamp = endTimestamp;

  console.log(`\nStart: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}`);

  // Pack factors
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
  console.log(`SeedData: ${seedData.target}`);

  // Static call
  const alphaWad = BigInt(ALPHA_WAD);
  try {
    const marketId = await core.createMarket.staticCall(
      minTick, maxTick, TICK_SPACING,
      startTimestamp, endTimestamp, settlementTimestamp,
      NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
    );
    console.log(`Static call OK - marketId=${marketId}`);
  } catch (err) {
    console.error("Static call failed:", err);
    throw err;
  }

  // Execute
  console.log("Creating market...");
  const blockGasLimit = latestBlock?.gasLimit ?? 0n;
  const txData = core.interface.encodeFunctionData("createMarket", [
    minTick, maxTick, TICK_SPACING,
    startTimestamp, endTimestamp, settlementTimestamp,
    NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
  ]);
  const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
  const tx = await deployer.sendTransaction({
    to: coreAddress, data: txData, ...overrides,
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

  console.log(`\n=== Market Ready! ===`);
  console.log(`  Market ID: ${marketId}`);
  console.log(`  Prior: Bell curve (sigma=${SIGMA_BINS} bins)`);
  console.log(`  Range: $${(minTick / 100).toFixed(2)} - $${(maxTick / 100).toFixed(2)}`);
  console.log(`  Anchor: $${(ANCHOR_PRICE / 100).toFixed(2)}`);
  console.log(`  Bins: ${NUM_BINS}, spacing: $${(TICK_SPACING / 100).toFixed(2)}`);
  console.log(`  Alpha: 1,000 WAD`);
  console.log(`  Fee: 1%`);
  console.log(`  Duration: 24 hours`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
