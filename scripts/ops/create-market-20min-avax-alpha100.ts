/**
 * Create a 20-minute AVAX market with alpha=100, bell curve prior (σ=4), 200bps fees.
 *
 * Alpha=100 → max vault loss = 100 × ln(80) ≈ $438
 * At 200bps, break-even volume = $438 / 0.02 = $21.9K
 *
 * Usage:
 *   npx hardhat run scripts/ops/create-market-20min-avax-alpha100.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n;
const MAX_FACTOR = WAD * 100n;

// --- Config ---
const ANCHOR_PRICE = 989; // $9.89 in cents — update to current AVAX price
const TICK_SPACING = 5; // $0.05 per bin
const NUM_BINS = 80;
const DURATION_SEC = 20 * 60; // 20 minutes
const ALPHA_WAD = "100000000000000000000"; // 100 WAD
const SEED_CHUNK_SIZE = 50;
const SIGMA_BINS = 4; // tight bell curve — vault edge
const BATCH_SECONDS = 86400;
const BATCH_TZ_OFFSET = 28800; // PST offset

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
  if (!coreAddress || !feePolicyAddress) {
    throw new Error("Missing core or feePolicy address in fuji.json");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

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

  console.log(`\n=== AVAX 20-min α=100 Market ===`);
  console.log(`Ticks: [${minTick}, ${maxTick}) spacing=${TICK_SPACING} bins=${NUM_BINS}`);
  console.log(`Price range: $${(minTick / 100).toFixed(2)} – $${(maxTick / 100).toFixed(2)}`);
  console.log(`Anchor: $${(ANCHOR_PRICE / 100).toFixed(2)} (center bin=${centerBin})`);
  console.log(`Sigma: ${SIGMA_BINS} bins ($${(SIGMA_BINS * TICK_SPACING / 100).toFixed(2)})`);
  console.log(`Alpha: 100 WAD (max loss: $${(100 * Math.log(NUM_BINS)).toFixed(0)})`);
  console.log(`Fee: 2% (FeePolicy200bps)`);
  console.log(`Duration: 20 minutes`);

  const factors = generateGaussianFactors(NUM_BINS, centerBin, SIGMA_BINS);

  console.log(`\nFactor distribution (sample):`);
  const sampleBins = [0, 10, 20, 30, centerBin - 5, centerBin, centerBin + 5, 50, 60, 70, 79];
  for (const b of sampleBins) {
    if (b >= 0 && b < NUM_BINS) {
      const tick = minTick + b * TICK_SPACING;
      const fVal = Number(factors[b]) / 1e18;
      const bar = "█".repeat(Math.round(fVal * 20));
      console.log(`  Bin ${String(b).padStart(2)}: $${(tick / 100).toFixed(2)} → ${fVal.toFixed(4)} ${bar}`);
    }
  }

  const packedFactors = ethers.solidityPacked(
    Array(factors.length).fill("uint256"),
    factors,
  );

  console.log("\nDeploying SeedData...");
  const seedData = await (
    await ethers.getContractFactory("SeedData")
  ).deploy(packedFactors);
  await seedData.waitForDeployment();
  console.log(`SeedData: ${seedData.target}`);

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);

  // Settlement must land in an unprocessed batch.
  // Get current batch ID and compute next batch boundary.
  const currentBatch = Number(await core.getCurrentBatchId());
  const nextBatchStart = (currentBatch + 1) * BATCH_SECONDS + BATCH_TZ_OFFSET;

  // Ensure settlement is in the next batch. If the natural end (now + 20min)
  // is before the batch boundary, push settlement to the boundary.
  const naturalEnd = now + 10 + DURATION_SEC;
  const settlementTimestamp = Math.max(naturalEnd, nextBatchStart + 60);
  // Start trading 20 minutes before settlement
  const endTimestamp = settlementTimestamp;
  const startTimestamp = Math.max(now + 10, endTimestamp - DURATION_SEC);

  console.log(`\nBatch ${currentBatch} already processed.`);
  console.log(`Next batch (${currentBatch + 1}) starts: ${new Date(nextBatchStart * 1000).toISOString()}`);
  console.log(`Trading window: ${((endTimestamp - startTimestamp) / 60).toFixed(0)} minutes`);

  console.log(`\nStart: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}`);

  const alphaWad = BigInt(ALPHA_WAD);
  try {
    const marketId = await core.createMarket.staticCall(
      minTick, maxTick, TICK_SPACING,
      startTimestamp, endTimestamp, settlementTimestamp,
      NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
    );
    console.log(`Static call OK — marketId=${marketId}`);
  } catch (err) {
    console.warn("Static call failed (proceeding with raw tx):", (err as Error).message ?? err);
  }

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
  console.log(`  Prior: Bell curve (σ=${SIGMA_BINS} bins = $${(SIGMA_BINS * TICK_SPACING / 100).toFixed(2)})`);
  console.log(`  Range: $${(minTick / 100).toFixed(2)} – $${(maxTick / 100).toFixed(2)}`);
  console.log(`  Anchor: $${(ANCHOR_PRICE / 100).toFixed(2)}`);
  console.log(`  Bins: ${NUM_BINS}, spacing: $${(TICK_SPACING / 100).toFixed(2)}`);
  console.log(`  Alpha: 100 WAD (max loss: $${(100 * Math.log(NUM_BINS)).toFixed(0)})`);
  console.log(`  Fee: 2% (200bps)`);
  console.log(`  Duration: 20 minutes`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
