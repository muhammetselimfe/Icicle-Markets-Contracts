import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy!);
  const nextId = await core.nextMarketId();
  console.log("nextMarketId:", nextId.toString());
  const now = Math.floor(Date.now() / 1000);
  for (let i = 1; i <= Number(nextId); i++) {
    const state = await core.getMarketState(BigInt(i));
    const m = await core.markets(BigInt(i));
    const endTs = Number(m[9]);
    console.log(`Market #${i}: state=${state}, minTick=${m[12]}, maxTick=${m[13]}, spacing=${m[14]}, endTs=${endTs}, endsIn=${endTs - now}s`);
  }
}
main().catch(console.error);
