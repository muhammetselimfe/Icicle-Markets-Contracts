import hre from "hardhat";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[process-batch-dev] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress, deployer);

  let currentBatchId = await core.currentBatchId();

  while (true) {
    const nextBatchId = currentBatchId + 1n;
    const [total, resolved] = await core.getBatchMarketState(nextBatchId);

    if (total === 0n) {
      console.log(`[process-batch-dev] stop: batch ${nextBatchId.toString()} has no markets`);
      break;
    }

    if (resolved !== total) {
      console.log(
        `[process-batch-dev] stop: batch ${nextBatchId.toString()} unresolved ${resolved.toString()}/${total.toString()}`
      );
      break;
    }

    console.log(`[process-batch-dev] processDailyBatch batchId=${nextBatchId.toString()}`);
    await (await core.processDailyBatch(nextBatchId)).wait();
    currentBatchId = nextBatchId;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
