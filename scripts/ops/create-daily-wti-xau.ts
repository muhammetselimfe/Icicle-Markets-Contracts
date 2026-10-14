/**
 * Create corrected daily WTI and XAU markets with dollar-based ticks.
 * WTI: spacing=1 ($1/bin), 80 bins
 * XAU: spacing=5 ($5/bin), 80 bins
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n;
const MAX_FACTOR = WAD * 100n;
const ALPHA_WAD = "100000000000000000000"; // 100 WAD
const SEED_CHUNK_SIZE = 50;
const SIGMA_BINS = 8;
const NUM_BINS = 80;
const DURATION_SEC = 24 * 60 * 60;
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
  console.log("Fetching live prices...\n");
  const wtiRes = await fetch("https://api.redstone.finance/prices?symbol=WTI&provider=redstone&limit=1");
  const wtiData = await wtiRes.json() as any[];
  const wtiPrice = wtiData[0]?.value;

  const xauRes = await fetch("https://api.redstone.finance/prices?symbol=XAU&provider=redstone&limit=1");
  const xauData = await xauRes.json() as any[];
  const xauPrice = xauData[0]?.value;

  console.log(`  WTI: $${wtiPrice?.toFixed(2)}`);
  console.log(`  XAU: $${xauPrice?.toFixed(2)}`);

  if (!wtiPrice || !xauPrice) throw new Error("Failed to fetch prices");

  // Timing
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const currentBatch = Number(await core.getCurrentBatchId());
  const nextBatchStart = (currentBatch + 1) * BATCH_SECONDS + BATCH_TZ_OFFSET;
  const startTimestamp = now + 30;
  const endTimestamp = startTimestamp + DURATION_SEC;
  const settlementTimestamp = Math.max(endTimestamp, nextBatchStart + 60);

  console.log(`\nStart: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}\n`);

  // ===== WTI: dollar ticks, spacing=1 ($1/bin) =====
  const wtiSpacing = 1;
  const wtiAnchor = Math.round(wtiPrice); // dollar ticks
  const wtiCenter = Math.round(wtiAnchor / wtiSpacing) * wtiSpacing;
  const wtiBelow = Math.floor(NUM_BINS / 2);
  const wtiMin = Math.max(wtiSpacing, wtiCenter - wtiBelow * wtiSpacing);
  const wtiMax = wtiCenter + (NUM_BINS - wtiBelow) * wtiSpacing;
  const wtiCenterBin = Math.floor((wtiAnchor - wtiMin) / wtiSpacing);

  console.log(`${"=".repeat(60)}`);
  console.log(`WTI — Daily Market (dollar ticks)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Price: $${wtiPrice.toFixed(2)} → anchor tick ${wtiAnchor}`);
  console.log(`  Range: $${wtiMin} – $${wtiMax} ($1/bin, 80 bins)`);
  console.log(`  Center: $${wtiCenter} (bin ${wtiCenterBin})`);
  console.log(`  σ=8 bins ($${8 * wtiSpacing})`);

  const wtiFactors = generateGaussianFactors(NUM_BINS, wtiCenterBin, SIGMA_BINS);
  const wtiPacked = ethers.solidityPacked(Array(wtiFactors.length).fill("uint256"), wtiFactors);

  console.log("  Deploying SeedData...");
  const wtiSeed = await (await ethers.getContractFactory("SeedData")).deploy(wtiPacked);
  await wtiSeed.waitForDeployment();

  console.log("  Creating market...");
  const wtiTxData = core.interface.encodeFunctionData("createMarket", [
    wtiMin, wtiMax, wtiSpacing,
    startTimestamp, endTimestamp, settlementTimestamp,
    NUM_BINS, BigInt(ALPHA_WAD), feePolicyAddress, wtiSeed.target,
  ]);
  const blockGasLimit = latestBlock?.gasLimit ?? 0n;
  const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
  await (await deployer.sendTransaction({ to: coreAddress, data: wtiTxData, ...overrides })).wait();

  const wtiMarketId = await core.nextMarketId();
  console.log(`  Market ID: ${wtiMarketId}`);

  let remaining = NUM_BINS;
  while (remaining > 0) {
    const count = Math.min(remaining, SEED_CHUNK_SIZE);
    await (await core.seedNextChunks(wtiMarketId, count)).wait();
    remaining -= count;
  }
  console.log(`  Seeded!\n`);

  // ===== XAU: dollar ticks, spacing=5 ($5/bin) =====
  const xauSpacing = 5;
  const xauAnchor = Math.round(xauPrice); // dollar ticks
  const xauCenter = Math.round(xauAnchor / xauSpacing) * xauSpacing;
  const xauBelow = Math.floor(NUM_BINS / 2);
  const xauMin = Math.max(xauSpacing, xauCenter - xauBelow * xauSpacing);
  const xauMax = xauCenter + (NUM_BINS - xauBelow) * xauSpacing;
  const xauCenterBin = Math.floor((xauAnchor - xauMin) / xauSpacing);

  console.log(`${"=".repeat(60)}`);
  console.log(`XAU — Daily Market (dollar ticks)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Price: $${xauPrice.toFixed(2)} → anchor tick ${xauAnchor}`);
  console.log(`  Range: $${xauMin} – $${xauMax} ($5/bin, 80 bins)`);
  console.log(`  Center: $${xauCenter} (bin ${xauCenterBin})`);
  console.log(`  σ=8 bins ($${8 * xauSpacing})`);

  const xauFactors = generateGaussianFactors(NUM_BINS, xauCenterBin, SIGMA_BINS);
  const xauPacked = ethers.solidityPacked(Array(xauFactors.length).fill("uint256"), xauFactors);

  console.log("  Deploying SeedData...");
  const xauSeed = await (await ethers.getContractFactory("SeedData")).deploy(xauPacked);
  await xauSeed.waitForDeployment();

  console.log("  Creating market...");
  const xauTxData = core.interface.encodeFunctionData("createMarket", [
    xauMin, xauMax, xauSpacing,
    startTimestamp, endTimestamp, settlementTimestamp,
    NUM_BINS, BigInt(ALPHA_WAD), feePolicyAddress, xauSeed.target,
  ]);
  await (await deployer.sendTransaction({ to: coreAddress, data: xauTxData, ...overrides })).wait();

  const xauMarketId = await core.nextMarketId();
  console.log(`  Market ID: ${xauMarketId}`);

  remaining = NUM_BINS;
  while (remaining > 0) {
    const count = Math.min(remaining, SEED_CHUNK_SIZE);
    await (await core.seedNextChunks(xauMarketId, count)).wait();
    remaining -= count;
  }
  console.log(`  Seeded!\n`);

  console.log(`${"=".repeat(60)}`);
  console.log("DONE");
  console.log(`${"=".repeat(60)}`);
  console.log(`  WTI: Market #${wtiMarketId}, $${wtiMin}–$${wtiMax} ($1/bin)`);
  console.log(`  XAU: Market #${xauMarketId}, $${xauMin}–$${xauMax} ($5/bin)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
