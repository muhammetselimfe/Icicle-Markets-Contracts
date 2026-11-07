import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  for (const id of [45, 48, 49]) {
    const m = await core.markets(BigInt(id));
    const endTs = Number(m.endTimestamp);
    const settleTs = Number(m.settlementTimestamp);
    const batchForEnd = Math.floor(endTs / 86400);
    console.log(`Market #${id}: settled=${m.settled}, settleTick=${m.settlementTick}, endTs=${endTs} (batch ${batchForEnd}), settleTs=${settleTs}`);
  }

  const currentBatch = Number(await core.getCurrentBatchId());
  const now = Math.floor(Date.now() / 1000);
  const todayBatch = Math.floor(now / 86400);
  console.log(`\nCurrent contract batch: ${currentBatch}`);
  console.log(`Today's batch: ${todayBatch}`);
  console.log(`Now: ${now}`);

  // Check if batch 20528 has data
  for (const bid of [20528, todayBatch]) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(bid));
      console.log(`\nBatch ${bid}: Lt=$${(Number(r[0])/1e18).toFixed(2)}, Ftot=$${(Number(r[1])/1e18).toFixed(2)}, processed=${r[6]}`);
    } catch (e: any) {
      console.log(`\nBatch ${bid}: ${e.message?.slice(0, 100)}`);
    }
  }
}
main();
