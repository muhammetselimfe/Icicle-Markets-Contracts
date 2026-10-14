import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const m = await core.markets(50n);
  const now = Math.floor(Date.now() / 1000);
  const end = Number(m.endTimestamp);
  const settle = Number(m.settlementTimestamp);
  const windowEnd = settle + 600;

  console.log(`End:          ${new Date(end*1000).toISOString()}`);
  console.log(`Settlement:   ${new Date(settle*1000).toISOString()}`);
  console.log(`Window ends:  ${new Date(windowEnd*1000).toISOString()}`);
  console.log(`Now:          ${new Date(now*1000).toISOString()}`);
  console.log(`Wait needed:  ${windowEnd - now}s`);
  console.log(`Settled:      ${m.settled}`);
}
main();
