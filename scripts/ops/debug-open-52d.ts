import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const [deployer] = await ethers.getSigners();

  const marketId = 52n;

  // Market: minTick=745, maxTick=1145, spacing=5
  // User wants $9.30-$9.60 -> ticks 930, 960

  // Try with CORRECT ticks
  console.log("=== Testing with ticks (what contract expects) ===");
  for (const [lo, hi] of [[930n, 960n], [945n, 950n], [745n, 750n]]) {
    const qty = 1000000n; // 1 unit in 6 decimals
    const maxCost = 1000000n; // 1 USDC
    try {
      await core.openPosition.staticCall(marketId, lo, hi, qty, maxCost);
      console.log(`  ticks [${lo}-${hi}]: OK`);
    } catch (e: any) {
      const errData = e.data || "";
      console.log(`  ticks [${lo}-${hi}]: REVERT`);
      // Try to decode
      try {
        const iface = core.interface;
        const decoded = iface.parseError(errData);
        console.log(`    Error: ${decoded?.name}(${decoded?.args.join(", ")})`);
      } catch {
        console.log(`    Raw: ${errData.slice(0, 40)}`);
      }
    }
  }

  // Check: maybe the frontend sends prices in dollars not cents?
  console.log("\n=== Testing with dollar prices (possible frontend bug) ===");
  for (const [lo, hi] of [[9300000n, 9600000n], [93n, 96n]]) {
    const qty = 1000000n;
    const maxCost = 1000000n;
    try {
      await core.openPosition.staticCall(marketId, lo, hi, qty, maxCost);
      console.log(`  [${lo}-${hi}]: OK`);
    } catch (e: any) {
      try {
        const decoded = core.interface.parseError(e.data);
        console.log(`  [${lo}-${hi}]: ${decoded?.name}(${decoded?.args.join(", ")})`);
      } catch {
        console.log(`  [${lo}-${hi}]: REVERT`);
      }
    }
  }
}
main().catch(console.error);
