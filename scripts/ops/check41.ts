import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const nextId = await core.nextMarketId();
  console.log(`nextMarketId: ${nextId}`);
  const m = await core.markets(41n);
  console.log(`#41: settled=${m.settled}, alpha=${Number(m.liquidityParameter)/1e18}, bins=${m.numBins}, range=${m.minTick}-${m.maxTick}, spacing=${m.tickSpacing}, settleTick=${m.settlementTick}, fee=${m.feePolicy}`);
  console.log(`  start=${new Date(Number(m.startTimestamp)*1000).toISOString()}, end=${new Date(Number(m.endTimestamp)*1000).toISOString()}`);
}
main();
