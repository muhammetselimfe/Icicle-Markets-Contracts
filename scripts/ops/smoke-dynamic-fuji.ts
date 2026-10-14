// Functional smoke test (staticCall — creates NO live state): proves the v2
// Core wrapper -> module path for createMarketDynamic executes (routing + risk gate
// + lifecycle logic) and returns a marketId. Deploys a throwaway SeedData (1 tx).
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const feeAddr = env.contracts.FeePolicy100bps;

  const NUM_BINS = 80, MIN = 700, MAX = 1100, SP = 5;
  const factors = Array(NUM_BINS).fill(WAD);
  const packed = ethers.solidityPacked(Array(NUM_BINS).fill("uint256"), factors);
  const seed = await (await ethers.getContractFactory("SeedData")).deploy(packed);
  await seed.waitForDeployment();

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const settlement = now + 2 * 86400; // 2 days out -> a future batch
  const start = now + 60, end = settlement - 3600;
  const dp = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: 50000n * 1_000_000n, anchorCenterBin: 40 };
  const args = [MIN, MAX, SP, start, end, settlement, NUM_BINS, ethers.parseEther("10"), feeAddr, await seed.getAddress()] as const;

  const marketId = await core.createMarketDynamic.staticCall(...args, dp);
  console.log(`createMarketDynamic.staticCall OK -> would create marketId=${marketId}`);
  console.log("v2 dynamic path executes end-to-end (Core wrapper -> risk gate -> MarketLifecycle). No live state created.");
}
main().catch((e) => { console.error("SMOKE FAILED:", e.shortMessage || e.message); process.exit(1); });
