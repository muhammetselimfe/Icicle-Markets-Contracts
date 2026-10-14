import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const m = await core.markets(43n);
  const now = Math.floor(Date.now() / 1000);
  const end = Number(m.endTimestamp);
  const start = Number(m.startTimestamp);
  console.log(`Now: ${new Date(now*1000).toISOString()}`);
  console.log(`End: ${new Date(end*1000).toISOString()}`);
  console.log(`Status: ${now < start ? "NOT STARTED" : now < end ? "ACTIVE" : "EXPIRED"} (${now >= end ? `expired ${now-end}s ago` : `${end-now}s remaining`})`);
}
main();
