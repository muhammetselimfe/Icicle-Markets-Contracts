import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const currentBatch = Number(await core.getCurrentBatchId());
  console.log(`Current batch: ${currentBatch}`);

  // Check batches 20526, 20527, 20528
  for (const b of [currentBatch - 1, currentBatch, currentBatch + 1]) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(b));
      const lt = Number(r[0]) / 1e18;
      const ft = Number(r[1]) / 1e18;
      const gt = Number(r[3]) / 1e18;
      const npre = Number(r[4]) / 1e18;
      const processed = r[6];
      console.log(`Batch ${b}: Lt=$${lt.toFixed(2)}, Ft=$${ft.toFixed(2)}, Grant=$${gt.toFixed(2)}, PreNAV=$${npre.toFixed(0)}, processed=${processed}`);
    } catch(e: any) {
      console.log(`Batch ${b}: error - ${e.message?.slice(0,80)}`);
    }
  }

  // Check settlement timestamps of markets #38-41 to see which batch they're in
  for (const id of [38, 39, 40, 41]) {
    const m = await core.markets(BigInt(id));
    const settleTs = Number(m.settlementTimestamp);
    const batchId = Math.floor((settleTs - 28800) / 86400);
    console.log(`Market #${id}: settlementTs=${settleTs} (${new Date(settleTs*1000).toISOString()}), batchId=${batchId}, settled=${m.settled}`);
  }
}
main();
