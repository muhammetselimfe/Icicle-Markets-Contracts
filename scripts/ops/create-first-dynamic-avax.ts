// Create the FIRST v2 dynamic market on Fuji (AVAX).
// 1) switch the global Redstone feed to AVAX (safe: no active markets depend on the
//    current XAU feed). 2) fetch the live AVAX price for the anchor. 3) createMarketDynamic
//    + seed. Then run scripts/ops/refresh-trade-oracle.ts as the keeper.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

// market shape
const TICK_SPACING = 5;          // $0.05/bin
const NUM_BINS = 80;             // $4.00 span
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 24 * 60 * 60);
const ALPHA = process.env.ALPHA ?? "2000";                       // WAD alpha; deep market (maxloss = alpha*ln80)
const PER_BIN_CAP_UNITS = BigInt(process.env.PER_BIN_CAP_UNITS ?? "20000"); // max payout units per bin
// dynamic config
const DP = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: PER_BIN_CAP_UNITS * 1_000_000n, anchorCenterBin: 40 };

async function liveAvaxCents(): Promise<number> {
  try {
    const r = await fetch("https://api.redstone.finance/prices?symbols=AVAX&provider=redstone-primary-prod");
    const j: any = await r.json();
    const px = j?.AVAX?.value;
    if (px && px > 0) return Math.round(px * 100);
  } catch {}
  if (process.env.ANCHOR_CENTS) return Number(process.env.ANCHOR_CENTS);
  throw new Error("could not fetch live AVAX price; set ANCHOR_CENTS env");
}

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const feeAddr = env.contracts.FeePolicy100bps;
  const [deployer] = await ethers.getSigners();

  // 1) ensure feed = AVAX
  const AVAX = ethers.encodeBytes32String("AVAX");
  const cur = await core.redstoneFeedId();
  if (cur !== AVAX) {
    console.log(`[feed] switching redstoneFeedId ${cur} -> AVAX`);
    await (await core.setRedstoneConfig(AVAX, 8, 600, 60)).wait();
    console.log(`[feed] now ${await core.redstoneFeedId()}`);
  } else {
    console.log("[feed] already AVAX");
  }

  // 2) live anchor
  const anchorCents = await liveAvaxCents();
  const centerTick = Math.round(anchorCents / TICK_SPACING) * TICK_SPACING;
  const minTick = centerTick - 40 * TICK_SPACING;
  const maxTick = centerTick + 40 * TICK_SPACING;
  const anchorCenterBin = (centerTick - minTick) / TICK_SPACING;
  console.log(`[market] live AVAX = $${(anchorCents / 100).toFixed(2)} -> ticks [${minTick},${maxTick}) ($${(minTick/100).toFixed(2)}-$${(maxTick/100).toFixed(2)}) bins=${NUM_BINS}`);

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const start = now + 30;
  const end = start + DURATION_SEC;
  const settlement = end; // 24h out -> next daily batch (satisfies settlementBatch > currentBatchId)

  // 3) seed data + create
  const factors = Array(NUM_BINS).fill(WAD);
  const packed = ethers.solidityPacked(Array(NUM_BINS).fill("uint256"), factors);
  const seed = await (await ethers.getContractFactory("SeedData")).deploy(packed);
  await seed.waitForDeployment();

  const dp = { ...DP, anchorCenterBin };
  const alphaWad = ethers.parseEther(ALPHA);
  console.log(`[market] alpha=${ALPHA} WAD (maxloss=$${(Number(ALPHA)*Math.log(NUM_BINS)).toFixed(0)}), perBinCap=${PER_BIN_CAP_UNITS} units`);
  const args = [minTick, maxTick, TICK_SPACING, start, end, settlement, NUM_BINS, alphaWad, feeAddr, await seed.getAddress()] as const;
  const marketId = await core.createMarketDynamic.staticCall(...args, dp);
  console.log(`[market] static OK -> marketId=${marketId}; creating...`);
  await (await core.createMarketDynamic(...args, dp)).wait();
  const createdId = await core.nextMarketId();

  let remaining = NUM_BINS;
  while (remaining > 0) { const c = Math.min(remaining, 50); await (await core.seedNextChunks(createdId, c)).wait(); remaining -= c; }

  const m = await core.markets(createdId);
  console.log(`\n✅ Dynamic AVAX market created: marketId=${createdId}`);
  console.log(`   dynamicEnabled=${m.dynamicEnabled} seeded=${m.isSeeded} w=${Number(m.dynW)/1e18} alpha=${Number(m.liquidityParameter)/1e18}`);
  console.log(`   trading: ${new Date(start*1000).toISOString()} -> ${new Date(end*1000).toISOString()}`);
  console.log(`\nNEXT: run the oracle keeper so trades price against a fresh feed:`);
  console.log(`   MARKET_ID=${createdId} INTERVAL_SEC=60 ONCE=0 npx hardhat run scripts/ops/refresh-trade-oracle.ts --network fuji`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message, e.data ?? ""); process.exit(1); });
