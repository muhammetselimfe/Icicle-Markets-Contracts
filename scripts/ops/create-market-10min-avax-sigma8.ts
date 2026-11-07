/**
 * Create a 10-minute AVAX market with alpha=100, bell curve prior (σ=8), 200bps fees.
 * Wider σ = flatter curve = fairer trader prices. Testing if vault still breaks even.
 *
 * Usage:
 *   npx hardhat run scripts/ops/create-market-10min-avax-sigma8.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n;
const MAX_FACTOR = WAD * 100n;

const ANCHOR_PRICE = 989;
const TICK_SPACING = 5;
const NUM_BINS = 80;
const DURATION_SEC = 10 * 60;
const ALPHA_WAD = "100000000000000000000"; // 100 WAD
const SEED_CHUNK_SIZE = 50;
const SIGMA_BINS = 8; // wider bell curve — fairer for traders

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
  if (!coreAddress || !feePolicyAddress) throw new Error("Missing core or feePolicy");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const centerTick = Math.round(ANCHOR_PRICE / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const binsAbove = NUM_BINS - binsBelow;
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + binsAbove * TICK_SPACING;
  const computedBins = (maxTick - minTick) / TICK_SPACING;
  if (computedBins !== NUM_BINS) throw new Error(`Bin mismatch: expected=${NUM_BINS} got=${computedBins}`);

  const centerBin = Math.floor((ANCHOR_PRICE - minTick) / TICK_SPACING);

  console.log(`\n=== AVAX 10-min α=100 σ=8 Market ===`);
  console.log(`Ticks: [${minTick}, ${maxTick}) spacing=${TICK_SPACING} bins=${NUM_BINS}`);
  console.log(`Price range: $${(minTick / 100).toFixed(2)} – $${(maxTick / 100).toFixed(2)}`);
  console.log(`Anchor: $${(ANCHOR_PRICE / 100).toFixed(2)} (center bin=${centerBin})`);
  console.log(`Sigma: ${SIGMA_BINS} bins ($${(SIGMA_BINS * TICK_SPACING / 100).toFixed(2)})`);
  console.log(`Alpha: 100 WAD (max loss: $${(100 * Math.log(NUM_BINS)).toFixed(0)})`);
  console.log(`Fee: 2% (200bps), Duration: 10 minutes`);

  const factors = generateGaussianFactors(NUM_BINS, centerBin, SIGMA_BINS);

  // Compare σ=4 vs σ=8 at key bins
  const factors4 = generateGaussianFactors(NUM_BINS, centerBin, 4);
  console.log(`\nσ=4 vs σ=8 factor comparison:`);
  for (const offset of [0, 5, 10, 15, 20, 30]) {
    const bin = centerBin + offset;
    if (bin < NUM_BINS) {
      const f4 = Number(factors4[bin]) / 1e18;
      const f8 = Number(factors[bin]) / 1e18;
      console.log(`  +${offset} bins: σ4=${f4.toFixed(4)}, σ8=${f8.toFixed(4)} (${(f8/f4).toFixed(2)}x flatter)`);
    }
  }

  const packedFactors = ethers.solidityPacked(
    Array(factors.length).fill("uint256"),
    factors,
  );

  console.log("\nDeploying SeedData...");
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packedFactors);
  await seedData.waitForDeployment();
  console.log(`SeedData: ${seedData.target}`);

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);

  const startTimestamp = now + 10;
  const endTimestamp = startTimestamp + DURATION_SEC;
  const settlementTimestamp = endTimestamp;

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
    console.warn("Static call failed:", (err as Error).message?.slice(0, 120) ?? err);
  }

  console.log("Creating market...");
  const blockGasLimit = latestBlock?.gasLimit ?? 0n;
  const txData = core.interface.encodeFunctionData("createMarket", [
    minTick, maxTick, TICK_SPACING,
    startTimestamp, endTimestamp, settlementTimestamp,
    NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
  ]);
  const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
  const tx = await deployer.sendTransaction({ to: coreAddress, data: txData, ...overrides });
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
  console.log(`  σ=8 (wider curve — testing fairer trader pricing)`);
  console.log(`  Range: $${(minTick / 100).toFixed(2)} – $${(maxTick / 100).toFixed(2)}`);
  console.log(`  Alpha: 100, Fee: 200bps, Duration: 10 min`);
}

main().catch((err) => { console.error(err); process.exit(1); });
