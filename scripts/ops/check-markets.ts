import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  for (const id of [38, 39, 40, 41]) {
    try {
      const m = await core.markets(BigInt(id));
      const now = Math.floor(Date.now() / 1000);
      const end = Number(m.endTimestamp);
      const settled = m.settled;
      const state = Number(m.state);
      const elapsed = now - end;
      console.log(`#${id}: settled=${settled}, state=${state}, ended ${elapsed}s ago, settleTick=${Number(m.settlementTick)}`);
    } catch(e: any) { console.log(`#${id}: error - ${e.message?.slice(0,80)}`); }
  }
}
main();
