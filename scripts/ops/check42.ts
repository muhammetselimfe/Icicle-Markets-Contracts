import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const m = await core.markets(42n);
  const now = Math.floor(Date.now() / 1000);
  const end = Number(m.endTimestamp);
  const remaining = end - now;
  console.log(`Market #42: ends in ${remaining}s (${new Date(end*1000).toISOString()})`);
  console.log(`Now: ${new Date(now*1000).toISOString()}`);
  if (remaining <= 0) {
    console.log(`EXPIRED ${-remaining}s ago. Oracle window: ${600 + remaining}s remaining`);
  }
}
main();
