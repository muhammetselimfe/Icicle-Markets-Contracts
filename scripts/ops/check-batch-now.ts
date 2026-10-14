import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const BATCH_OFFSET = 28800;
  const currentBatchId = Number(await core.getCurrentBatchId());
  const now = Math.floor(Date.now() / 1000);
  const todayBatch = Math.floor((now - BATCH_OFFSET) / 86400);
  const batchStart = todayBatch * 86400 + BATCH_OFFSET;
  const batchEnd = batchStart + 86400;

  console.log(`Current processed batch: ${currentBatchId}`);
  console.log(`Today's batch: ${todayBatch}`);
  console.log(`Today batch window: ${new Date(batchStart*1000).toISOString()} → ${new Date(batchEnd*1000).toISOString()}`);
  console.log(`Now: ${new Date(now*1000).toISOString()}`);
  console.log(`\nCan create market settling in batch ${todayBatch}? ${todayBatch > currentBatchId ? "YES" : "NO (already processed)"}`);

  // If a 15-min market ends now + 15min, what batch does it land in?
  const end15 = now + 15 * 60;
  const endBatch = Math.floor((end15 - BATCH_OFFSET) / 86400);
  console.log(`\n15-min market ending at ${new Date(end15*1000).toISOString()} → batch ${endBatch}`);
  console.log(`Can settle in batch ${endBatch}? ${endBatch > currentBatchId ? "YES" : "NO"}`);
}
main();
