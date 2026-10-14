import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const userAddr = "0x06200eC0Ea4E888EcfD6EB4F7Aec78e672d84370";
  const marketId = 51n;
  const lower = 960n;
  const upper = 965n;

  // Binary search for $100 quantity
  const target = 100_000_000n;
  let lo = 1_000_000n;
  let hi = 10_000_000_000n;

  // Expand hi if needed
  for (let i = 0; i < 5; i++) {
    try {
      const c = await core.calculateOpenCost.staticCall(marketId, lower, upper, hi);
      if (c >= target) break;
      hi *= 3n;
    } catch { hi = hi * 2n / 3n; break; }
  }

  let bestQty = lo, bestCost = 0n;
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2n;
    if (mid <= lo || mid >= hi) break;
    try {
      const c = await core.calculateOpenCost.staticCall(marketId, lower, upper, mid);
      const diff = c > target ? c - target : target - c;
      const bestDiff = bestCost > target ? bestCost - target : target - bestCost;
      if (diff < bestDiff) { bestQty = mid; bestCost = c; }
      if (diff <= 1_000_000n) break;
      if (c > target) hi = mid; else lo = mid;
    } catch {
      console.log(`  calculateOpenCost reverts at qty=${mid}`);
      hi = mid;
    }
  }

  console.log(`Target: $100`);
  console.log(`Best qty: ${bestQty}`);
  console.log(`Best cost: $${(Number(bestCost)/1e6).toFixed(2)}`);

  // Now try openPosition with that qty
  const maxCost = bestCost + (bestCost * 500n) / 10000n + 1n;
  console.log(`maxCost: $${(Number(maxCost)/1e6).toFixed(2)}`);

  // Simulate from user
  const calldata = core.interface.encodeFunctionData("openPosition", [
    marketId, lower, upper, bestQty, maxCost
  ]);

  try {
    await ethers.provider.call({ to: env.contracts.IcicleOptionsCoreProxy, from: userAddr, data: calldata });
    console.log(`\nUser eth_call: PASSED`);
  } catch (e: any) {
    console.log(`\nUser eth_call: REVERTED`);
    console.log(`Error: ${e.message?.slice(0, 300)}`);
    if (e.data) {
      console.log(`Data: ${e.data}`);
      const allErrors = [
        "error AlphaExceedsLimit(uint256)",
        "error CostExceedsMaximum(uint256,uint256)",
        "error ERC20InsufficientAllowance(address,uint256,uint256)",
        "error ERC20InsufficientBalance(address,uint256,uint256)",
      ];
      try {
        const decoded = new ethers.Interface(allErrors).parseError(e.data);
        console.log(`Decoded: ${decoded?.name}(${decoded?.args.join(", ")})`);
      } catch {}
    }
  }

  // Also try from deployer
  try {
    await core.openPosition.staticCall(marketId, lower, upper, bestQty, maxCost);
    console.log(`Deployer staticCall: PASSED`);
  } catch (e: any) {
    console.log(`Deployer staticCall: REVERTED — ${e.message?.slice(0, 200)}`);
  }
}
main().catch(console.error);
