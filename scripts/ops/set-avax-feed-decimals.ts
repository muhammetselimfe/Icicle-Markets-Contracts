// Set redstoneFeedDecimals=6 so the Redstone AVAX price (8-dec) maps to CENT ticks
// (price*1e8 -> settlementValue = price*1e8 -> tick = price*100 = cents), matching
// cent-based AVAX markets. (feedDecimals=8 yields dollar ticks, correct for XAU/BTC.)
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const AVAX = ethers.encodeBytes32String("AVAX");
  console.log(`current feedDecimals=${await core.redstoneFeedDecimals()} -> setting 6`);
  await (await core.setRedstoneConfig(AVAX, 6, 600, 60)).wait();
  console.log(`feedDecimals now ${await core.redstoneFeedDecimals()}, feedId ${await core.redstoneFeedId()}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
