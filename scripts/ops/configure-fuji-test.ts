// Configure the fresh Fuji v2 deployment for clean testing:
//   - 15-min batches (batchSeconds=900)
//   - short settlement windows (submit 120 / ops 60 / claim 180)
//   - AVAX feed, feedDecimals=6 (cent ticks)
//   - seed a known vault
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const SEED_UNITS = 100_000n; // 100k test USD vault

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const [deployer] = await ethers.getSigners();
  console.log(`core=${env.contracts.IcicleOptionsCoreProxy} deployer=${deployer.address}`);

  console.log("setBatchSeconds(900)..."); await (await core.setBatchSeconds(900)).wait();
  console.log("setSettlementTimeline(120,60,180)..."); await (await core.setSettlementTimeline(120, 60, 180)).wait();
  const AVAX = ethers.encodeBytes32String("AVAX");
  console.log("setRedstoneConfig(AVAX,6,600,60)..."); await (await core.setRedstoneConfig(AVAX, 6, 600, 60)).wait();

  const dec = Number(await token.decimals());
  const seed = SEED_UNITS * 10n ** BigInt(dec);
  console.log(`mint+seedVault ${SEED_UNITS}...`);
  await (await token.mint(deployer.address, seed * 3n)).wait();          // extra for trading later
  await (await token.approve(env.contracts.IcicleOptionsCoreProxy, ethers.MaxUint256)).wait();
  await (await core.seedVault(seed)).wait();

  console.log("\n=== configured ===");
  console.log("batchSeconds   ", (await core.batchSeconds()).toString(), "(15 min)");
  console.log("submitWindow   ", (await core.settlementSubmitWindow()).toString());
  console.log("pendingOps     ", (await core.pendingOpsWindow()).toString());
  console.log("feedId         ", await core.redstoneFeedId(), `("${Buffer.from((await core.redstoneFeedId()).slice(2),"hex").toString("utf8").replace(/\0+$/,"")}")`);
  console.log("feedDecimals   ", (await core.redstoneFeedDecimals()).toString());
  console.log("vault NAV      ", ethers.formatUnits(await core.getVaultNav(), 18));
  console.log("vault price    ", ethers.formatUnits(await core.getVaultPrice(), 18));
  console.log("nextMarketId   ", (await core.nextMarketId()).toString());
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
