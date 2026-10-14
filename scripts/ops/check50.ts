import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const m = await core.markets(50n);
  console.log(`#50: settled=${m.settled}, tick=${Number(m.settlementTick)}, positions=${Number(m.openPositionCount)}`);
}
main().catch(console.error);
