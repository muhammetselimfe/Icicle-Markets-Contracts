/**
 * Create 3 daily markets: AVAX, WTI, XAU
 * α=100, σ=8, 200bps, 80 bins, $0.05 spacing
 * Fetches live prices from Redstone before creating.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n;
const MAX_FACTOR = WAD * 100n;

const TICK_SPACING = 5;
const NUM_BINS = 80;
const DURATION_SEC = 24 * 60 * 60;
const ALPHA_WAD = "100000000000000000000"; // 100 WAD
const SEED_CHUNK_SIZE = 50;
const SIGMA_BINS = 8;
const BATCH_SECONDS = 86400;
const BATCH_TZ_OFFSET = 28800;

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

interface MarketConfig {
  name: string;
  feed: string;
  tickDivisor: number; // cents=100, dollars=1
}

const MARKETS: MarketConfig[] = [
  { name: "AVAX", feed: "AVAX", tickDivisor: 100 },
  { name: "WTI", feed: "WTI", tickDivisor: 100 },
  { name: "XAU", feed: "XAU", tickDivisor: 100 },
];

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const feePolicyAddress = envData.contracts.FeePolicy200bps;
  if (!coreAddress || !feePolicyAddress) throw new Error("Missing addresses");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}\n`);
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Fetch live prices
  console.log("Fetching live prices from Redstone...\n");
  const prices: Record<string, number> = {};
  for (const m of MARKETS) {
    try {
      const res = await fetch(`https://api.redstone.finance/prices?symbol=${m.feed}&provider=redstone&limit=1`);
      const data = await res.json() as any[];
      prices[m.name] = data[0]?.value;
      console.log(`  ${m.name}: $${prices[m.name]?.toFixed(4)}`);
    } catch (e) {
      console.log(`  ${m.name}: FAILED to fetch price`);
    }
  }

  // Batch timing
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const currentBatch = Number(await core.getCurrentBatchId());
  const nextBatchStart = (currentBatch + 1) * BATCH_SECONDS + BATCH_TZ_OFFSET;

  const startTimestamp = now + 30; // start in 30s
  const endTimestamp = startTimestamp + DURATION_SEC;
  // Settlement must be in an unprocessed batch
  const settlementTimestamp = Math.max(endTimestamp, nextBatchStart + 60);

  console.log(`\nBatch ${currentBatch}, next batch starts: ${new Date(nextBatchStart * 1000).toISOString()}`);
  console.log(`Start: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}`);
  console.log(`Settle: ${new Date(settlementTimestamp * 1000).toISOString()}\n`);

  for (const m of MARKETS) {
    const price = prices[m.name];
    if (!price) { console.log(`Skipping ${m.name} — no price\n`); continue; }

    const anchorTick = Math.round(price * m.tickDivisor);
    const centerTick = Math.round(anchorTick / TICK_SPACING) * TICK_SPACING;
    const binsBelow = Math.floor(NUM_BINS / 2);
    const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
    const maxTick = centerTick + (NUM_BINS - binsBelow) * TICK_SPACING;
    const computedBins = (maxTick - minTick) / TICK_SPACING;
    if (computedBins !== NUM_BINS) { console.log(`${m.name}: bin mismatch ${computedBins} != ${NUM_BINS}`); continue; }

    const centerBin = Math.floor((anchorTick - minTick) / TICK_SPACING);
    const d = m.tickDivisor;

    console.log(`${"=".repeat(60)}`);
    console.log(`${m.name} — Daily Market`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Live price: $${price.toFixed(4)}`);
    console.log(`  Anchor tick: ${anchorTick} ($${(anchorTick/d).toFixed(2)})`);
    console.log(`  Range: $${(minTick/d).toFixed(2)} – $${(maxTick/d).toFixed(2)}`);
    console.log(`  Center: $${(centerTick/d).toFixed(2)} (bin ${centerBin})`);
    console.log(`  σ=8 bins ($${(8 * TICK_SPACING / d).toFixed(2)})`);
    console.log(`  α=100, 200bps, 80 bins`);

    const factors = generateGaussianFactors(NUM_BINS, centerBin, SIGMA_BINS);
    const packedFactors = ethers.solidityPacked(Array(factors.length).fill("uint256"), factors);

    console.log("  Deploying SeedData...");
    const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packedFactors);
    await seedData.waitForDeployment();

    console.log("  Creating market...");
    const alphaWad = BigInt(ALPHA_WAD);
    const txData = core.interface.encodeFunctionData("createMarket", [
      minTick, maxTick, TICK_SPACING,
      startTimestamp, endTimestamp, settlementTimestamp,
      NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
    ]);
    const blockGasLimit = latestBlock?.gasLimit ?? 0n;
    const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
    const tx = await deployer.sendTransaction({ to: coreAddress, data: txData, ...overrides });
    await tx.wait();

    const marketId = await core.nextMarketId();
    console.log(`  Market ID: ${marketId}`);

    let remaining = NUM_BINS;
    while (remaining > 0) {
      const count = Math.min(remaining, SEED_CHUNK_SIZE);
      await (await core.seedNextChunks(marketId, count)).wait();
      remaining -= count;
    }
    console.log(`  Seeded! ✓`);
    console.log("");
  }

  console.log(`${"=".repeat(60)}`);
  console.log("ALL MARKETS CREATED");
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
