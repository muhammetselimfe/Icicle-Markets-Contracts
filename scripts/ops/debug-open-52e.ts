import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Use TICKS not bins
  const marketId = 52n;
  const lowerTick = 930n;
  const upperTick = 960n;
  const qty = 1000000n; // 1 unit (6 decimals)
  const maxCost = 1000000n; // 1 USDC

  console.log("Testing openPosition with correct ticks from deployer...");
  console.log(`  market=${marketId}, ticks=[${lowerTick}, ${upperTick}], qty=${qty}, maxCost=${maxCost}`);

  try {
    const result = await core.openPosition.staticCall(marketId, lowerTick, upperTick, qty, maxCost);
    console.log(`SUCCESS: positionId=${result}`);
  } catch (e: any) {
    try {
      const decoded = core.interface.parseError(e.data);
      console.log(`REVERT: ${decoded?.name}(${decoded?.args.join(", ")})`);
    } catch {
      console.log(`REVERT: ${e.message?.slice(0, 200)}`);
    }
  }

  // Also try actually executing
  console.log("\nActually executing $1 trade...");
  try {
    const tx = await core.openPosition(marketId, lowerTick, upperTick, qty, maxCost);
    const receipt = await tx.wait();
    console.log(`TX SUCCESS: ${receipt?.hash}`);
  } catch (e: any) {
    console.log(`TX FAILED: ${e.message?.slice(0, 200)}`);
  }
}
main().catch(console.error);
