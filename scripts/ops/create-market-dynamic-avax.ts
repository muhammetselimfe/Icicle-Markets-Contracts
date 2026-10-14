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
const sdk = require("@redstone-finance/sdk");

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

// --- Config ---
// v2.1: the anchor is fetched from the LIVE signed feed at run time (never hard-code a price —
// a stale anchor mis-centres the market), and volBins is DERIVED from the market duration:
//   volBins = dailyVol * sqrt(duration / 86400) * priceInTickUnits / tickSpacing
// (8 bins is only right for a 24h AVAX market; a 15-min market needs ~0.8).
const TICK_SPACING = 5;              // $0.05/bin
const NUM_BINS = 80;                 // $7.00–$11.00 span
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 24 * 60 * 60);
const CUTOFF_SEC = Number(process.env.CUTOFF_SEC ?? 900);      // v2.1: trading closes this long before settlement
const DAILY_VOL = Number(process.env.DAILY_VOL ?? 0.045);      // AVAX ~4.5 %/day; override per asset/regime
const ALPHA_WAD = ethers.parseEther(process.env.ALPHA ?? "100").toString(); // v2.1: lag-arb loss ∝ α; 50–100 for a ~$120k vault
const wad = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const W = WAD;                       // 1.0 = full oracle anchoring (LP safest; lower to leave trader edge)
const SIGMA_MIN = wad(0.75);         // floor bell width (non-binding while trading is open with a >=900s cutoff)
const TAU = wad(Number(process.env.TAU ?? 0.03)); // v2.1: tail-mass budget (3 %); floor derived from σ each trade
const PER_BIN_CAP = BigInt(process.env.PER_BIN_CAP_UNITS ?? "3600") * 1_000_000n; // v2.1: ≤ 3 % of NAV (checked on-chain when maxPerBinCapBps is set)

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddress = env.contracts.IcicleOptionsCoreProxy;
  const feePolicyAddress = env.contracts.FeePolicy100bps;
  if (!coreAddress || !feePolicyAddress) throw new Error("Missing core/feePolicy in fuji.json");

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  console.log(`Deployer: ${deployer.address}  Core: ${coreAddress}`);

  const auth = sdk.getSignersForDataServiceId("redstone-primary-prod");
  const pkgs = await sdk.requestDataPackages({ dataServiceId: "redstone-primary-prod", dataPackagesIds: ["AVAX"], uniqueSignersCount: 1, authorizedSigners: auth });
  const livePrice = Number(pkgs["AVAX"][0].dataPackage.dataPoints[0].toObj().value);
  const ANCHOR_PRICE = Math.round(livePrice * 100); // cents
  const volBins = DAILY_VOL * Math.sqrt(DURATION_SEC / 86400) * ANCHOR_PRICE / TICK_SPACING;
  const VOL_BINS = wad(volBins), SIGMA_MAX = wad(Math.max(volBins, 0.75));
  console.log(`Live AVAX $${livePrice.toFixed(4)} -> anchor ${ANCHOR_PRICE}c; duration ${DURATION_SEC}s -> volBins ${volBins.toFixed(2)}`);
  const centerTick = Math.round(ANCHOR_PRICE / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + (NUM_BINS - binsBelow) * TICK_SPACING;
  if ((maxTick - minTick) / TICK_SPACING !== NUM_BINS) throw new Error("bin mismatch");
  const anchorCenterBin = Math.floor((centerTick - minTick) / TICK_SPACING);

  const block = await ethers.provider.getBlock("latest");
  const now = block?.timestamp ?? Math.floor(Date.now() / 1000);
  const start = now + START_DELAY_SEC;
  const settlement = start + DURATION_SEC;
  const end = settlement - CUTOFF_SEC; // v2.1 cutoff

  const factors: bigint[] = Array(NUM_BINS).fill(WAD);
  const packed = ethers.solidityPacked(Array(NUM_BINS).fill("uint256"), factors);
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packed);
  await seedData.waitForDeployment();
  const seedDataAddress = seedData.target;

  const dp = {
    w: W, volBinsWad: VOL_BINS, sigmaMinWad: SIGMA_MIN, sigmaMaxWad: SIGMA_MAX,
    floorWad: TAU, perBinCap: PER_BIN_CAP, anchorCenterBin,
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
