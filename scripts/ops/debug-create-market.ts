import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", envData.contracts.IcicleOptionsCoreProxy);
  const [deployer] = await ethers.getSigners();

  // Check basic state
  const nextId = await core.nextMarketId();
  console.log(`Next market ID: ${nextId}`);

  const paused = await core.paused();
  console.log(`Paused: ${paused}`);

  const owner = await core.owner();
  console.log(`Owner: ${owner}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Is owner: ${owner.toLowerCase() === deployer.address.toLowerCase()}`);

  // Try a minimal createMarket with simple params
  const WAD = 10n ** 18n;
  const factors = Array(10).fill(WAD);
  const packed = ethers.solidityPacked(Array(10).fill("uint256"), factors);

  console.log("\nDeploying minimal SeedData (10 bins)...");
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packed);
  await seedData.waitForDeployment();
  console.log(`SeedData: ${seedData.target}`);

  const block = await ethers.provider.getBlock("latest");
  const now = block!.timestamp;
  const start = now + 30;
  const end = start + 900;

  const feePolicy = envData.contracts.FeePolicy200bps;
  console.log(`FeePolicy: ${feePolicy}`);

  // Check what currentBatchId is after processing
  const currentBatch = Number(await core.getCurrentBatchId());
  const batchForEnd = Math.floor(end / 86400);
  console.log(`\ncurrentBatchId: ${currentBatch}`);
  console.log(`Market end batch: ${batchForEnd}`);
  console.log(`Need: end batch > currentBatchId (${batchForEnd} > ${currentBatch} = ${batchForEnd > currentBatch})`);

  // If end batch <= currentBatch, we need to process the intermediate batches first
  // OR we just need the settlement to fall in a future batch
  if (batchForEnd <= currentBatch) {
    console.log(`\nBatch ${batchForEnd} is already processed. Need to process batch ${currentBatch + 1} first, or set end further in future.`);
  }

  console.log("\nTrying staticCall createMarket...");
  try {
    const result = await core.createMarket.staticCall(
      0, 10, 1,
      start, end, end,
      10, 100n * WAD, feePolicy, seedData.target,
    );
    console.log(`Result: ${result}`);
  } catch (e: any) {
    console.log(`Reverted: ${e.message?.slice(0, 200)}`);
    if (e.data) console.log(`Error data: ${e.data}`);
  }

  // Try with settlement in future batch
  const settleBatch = currentBatch + 1;
  const settleTs = settleBatch * 86400 + 60;
  console.log(`\nTrying with settlementTimestamp in batch ${settleBatch} (${new Date(settleTs*1000).toISOString()})...`);
  try {
    const result = await core.createMarket.staticCall(
      0, 10, 1,
      start, end, settleTs,
      10, 100n * WAD, feePolicy, seedData.target,
    );
    console.log(`Result: ${result}`);
  } catch (e: any) {
    console.log(`Reverted: ${e.message?.slice(0, 200)}`);
    if (e.data) console.log(`Error data: ${e.data}`);
    // Try decoding
    try {
      const errIface = new ethers.Interface(["error BatchAlreadyProcessed(uint64)", "error BatchNotProcessed(uint64)"]);
      const decoded = errIface.parseError(e.data);
      console.log(`Decoded: ${decoded?.name}(${decoded?.args})`);
    } catch {}
  }
}
main().catch(console.error);
