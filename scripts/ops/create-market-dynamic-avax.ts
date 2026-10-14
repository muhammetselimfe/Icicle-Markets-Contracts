/**
 * Create a 1-day AVAX market with v2 DYNAMIC pricing (oracle-anchored,
 * volatility-adaptive sigma) on Fuji.
 *
 * Requires the v2 contracts (PricingLayer + dynamic TradeModule/MarketLifecycle/
 * OracleModule) deployed/upgraded on the target network first.
 *
 * Usage:
 *   npx hardhat run scripts/ops/create-market-dynamic-avax.ts --network fuji
 *
 * After creation, keep the trade oracle fresh by periodically calling
 * refreshTradeOracle(marketId) with a Redstone payload — see
 * scripts/ops/refresh-trade-oracle.ts.
 *
 * Requires DEPLOYER_KEY in env or .env file.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

// --- Config ---
const ANCHOR_PRICE = 955;            // $9.55 in cents (set to live price before running)
const TICK_SPACING = 5;              // $0.05/bin
const NUM_BINS = 80;                 // $7.00–$11.00 span
const DURATION_SEC = 24 * 60 * 60;
const START_DELAY_SEC = 10;
const ALPHA_WAD = "10000000000000000000"; // 10 WAD (maxloss ~ 10*ln80 = 43.8)
const SEED_CHUNK_SIZE = 50;

// --- Dynamic pricing config ---
const W = WAD;                       // 1.0 = full oracle anchoring (LP safest; lower to leave trader edge)
const VOL_BINS = 8n * WAD;           // terminal std ~8 bins (~4.4% daily at $9.55, $0.05 bins)
const SIGMA_MIN = wad(0.75);         // floor bell width (prevents degenerate spike)
const SIGMA_MAX = 8n * WAD;          // opening width
const FLOOR = wad(0.05);             // min base factor
const PER_BIN_CAP = BigInt(process.env.PER_BIN_CAP_UNITS ?? "50000") * 1_000_000n; // hard tail-loss bound (units, 6-dec). Must be > 0.

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddress = env.contracts.IcicleOptionsCoreProxy;
  const feePolicyAddress = env.contracts.FeePolicy100bps;
  if (!coreAddress || !feePolicyAddress) throw new Error("Missing core/feePolicy in fuji.json");

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  console.log(`Deployer: ${deployer.address}  Core: ${coreAddress}`);

  const centerTick = Math.round(ANCHOR_PRICE / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + (NUM_BINS - binsBelow) * TICK_SPACING;
  if ((maxTick - minTick) / TICK_SPACING !== NUM_BINS) throw new Error("bin mismatch");
  const anchorCenterBin = Math.floor((centerTick - minTick) / TICK_SPACING);

  const block = await ethers.provider.getBlock("latest");
  const now = block?.timestamp ?? Math.floor(Date.now() / 1000);
  const start = now + START_DELAY_SEC;
  const end = start + DURATION_SEC;
  const settlement = end;

  const factors: bigint[] = Array(NUM_BINS).fill(WAD);
  const packed = ethers.solidityPacked(Array(NUM_BINS).fill("uint256"), factors);
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packed);
  await seedData.waitForDeployment();
  const seedDataAddress = seedData.target;

  const dp = {
    w: W, volBinsWad: VOL_BINS, sigmaMinWad: SIGMA_MIN, sigmaMaxWad: SIGMA_MAX,
    floorWad: FLOOR, perBinCap: PER_BIN_CAP, anchorCenterBin,
  };
  const baseArgs = [minTick, maxTick, TICK_SPACING, start, end, settlement, NUM_BINS, BigInt(ALPHA_WAD), feePolicyAddress, seedDataAddress] as const;

  const marketId = await core.createMarketDynamic.staticCall(...baseArgs, dp);
  console.log(`Static OK — would create dynamic marketId=${marketId}`);

  const tx = await core.createMarketDynamic(...baseArgs, dp);
  await tx.wait();
  const createdId = await core.nextMarketId();
  console.log(`Dynamic market created! marketId=${createdId}`);

  let remaining = NUM_BINS;
  while (remaining > 0) {
    const count = Math.min(remaining, SEED_CHUNK_SIZE);
    await (await core.seedNextChunks(createdId, count)).wait();
    remaining -= count;
  }

  console.log("\nDynamic market ready.");
  console.log(`  marketId=${createdId}  range $${(minTick / 100).toFixed(2)}–$${(maxTick / 100).toFixed(2)}  bins=${NUM_BINS}`);
  console.log(`  w=${Number(W) / 1e18} volBins=${Number(VOL_BINS) / 1e18} sigmaMin=${Number(SIGMA_MIN) / 1e18} alpha=${Number(ALPHA_WAD) / 1e18}`);
  console.log(`  NEXT: run refresh-trade-oracle.ts on a ~60s cadence so trades price against a fresh oracle.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
