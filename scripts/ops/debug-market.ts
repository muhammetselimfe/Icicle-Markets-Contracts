/**
 * Debug market 9: test calculateOpenCost with various quantities.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const marketId = 9;
  const m = await core.markets(BigInt(marketId));
  const minTick = Number(m[12]);
  const maxTick = Number(m[13]);
  const tickSpacing = Number(m[14]);
  const alpha = m[17];

  console.log(`Market #${marketId}:`);
  console.log(`  Range: ticks ${minTick}–${maxTick}, spacing=${tickSpacing}`);
  console.log(`  Alpha: ${ethers.formatEther(alpha)} WAD`);
  console.log(`  numBins: ${m[4]}, openPositionCount: ${m[5]}`);
  console.log(`  isSeeded: ${m[0]}, settled: ${m[1]}, failed: ${m[3]}`);
  console.log(`  Start: ${new Date(Number(m[8]) * 1000).toISOString()}`);
  console.log(`  End: ${new Date(Number(m[9]) * 1000).toISOString()}`);

  // Test 8 bins near current price ($8.75-$9.15)
  const lower = BigInt(875);
  const upper = BigInt(915);
  console.log(`\n8 bins: ticks ${lower}–${upper} ($8.75-$9.15)`);
  for (const qty of [1_000_000n, 10_000_000n, 100_000_000n, 200_000_000n, 500_000_000n, 1_000_000_000n, 5_000_000_000n, 10_000_000_000n]) {
    try {
      const cost = await core.calculateOpenCost.staticCall(BigInt(marketId), lower, upper, qty);
      console.log(`  qty=${(Number(qty) / 1e6).toFixed(0).padStart(8)} → cost=$${(Number(cost) / 1e6).toFixed(2)}`);
    } catch {
      console.log(`  qty=${(Number(qty) / 1e6).toFixed(0).padStart(8)} → REVERTS`);
    }
  }

  // Full range
  console.log(`\nFull range: ticks ${minTick}–${maxTick}`);
  for (const qty of [1_000_000n, 100_000_000n, 500_000_000n, 1_000_000_000n, 5_000_000_000n, 10_000_000_000n]) {
    try {
      const cost = await core.calculateOpenCost.staticCall(BigInt(marketId), BigInt(minTick), BigInt(maxTick), qty);
      console.log(`  qty=${(Number(qty) / 1e6).toFixed(0).padStart(8)} → cost=$${(Number(cost) / 1e6).toFixed(2)}`);
    } catch {
      console.log(`  qty=${(Number(qty) / 1e6).toFixed(0).padStart(8)} → REVERTS`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
