import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", envData.contracts.IcicleOptionsCoreProxy);

  const block = await ethers.provider.getBlock("latest");
  const now = block!.timestamp;
  const submitWindow = await core.settlementSubmitWindow();
  const pendingOps = await core.pendingOpsWindow();

  const m2 = await core.markets(2n);
  const setTs = Number(m2.settlementTimestamp);
  const opsStart = setTs + Number(submitWindow);
  const opsEnd = opsStart + Number(pendingOps);

  console.log("now:", now, new Date(Number(now) * 1000).toISOString());
  console.log("settled:", m2.settled, "failed:", m2.failed);
  console.log("startTimestamp:", m2.startTimestamp.toString(), new Date(Number(m2.startTimestamp) * 1000).toISOString());
  console.log("endTimestamp:", m2.endTimestamp.toString(), new Date(Number(m2.endTimestamp) * 1000).toISOString());
  console.log("settlementTimestamp:", setTs, new Date(setTs * 1000).toISOString());
  console.log("submitWindow:", submitWindow.toString(), "pendingOps:", pendingOps.toString());
  console.log("opsStart:", opsStart, new Date(opsStart * 1000).toISOString());
  console.log("opsEnd:", opsEnd, new Date(opsEnd * 1000).toISOString());
  console.log("now >= opsStart:", now >= opsStart);
  console.log("now >= opsEnd:", now >= opsEnd);

  const state = await core.getMarketState(2n);
  console.log("getMarketState(2):", state.toString());
}

main().catch((err) => { console.error(err); process.exit(1); });
