import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("prod");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Check a few Signals markets to read their actual bin factors
  // We'll use the segment tree to read current factors for settled markets
  // Market #51 is the latest with trades (α=8.05, 60 bins)

  for (const marketId of [51, 40, 30, 20]) {
    try {
      const m = await core.markets(BigInt(marketId));
      const bins = Number(m.numBins);
      const alpha = Number(m.liquidityParameter) / 1e18;
      if (bins <= 1) continue;

      console.log(`\n=== Market #${marketId} (α=${alpha.toFixed(2)}, bins=${bins}) ===`);

      // Read individual bin factors via getBinFactor if available
      // Or we can read the probability of each bin
      let minFactor = Infinity;
      let maxFactor = 0;
      let factors: number[] = [];

      for (let bin = 0; bin < bins; bin++) {
        try {
          const prob = await core.getBinProbability(BigInt(marketId), BigInt(bin));
          const p = Number(prob) / 1e18;
          factors.push(p);
          if (p < minFactor) minFactor = p;
          if (p > maxFactor) maxFactor = p;
        } catch {
          break;
        }
      }

      if (factors.length > 0) {
        console.log(`  Bin probabilities (${factors.length} bins):`);
        console.log(`  Min: ${minFactor.toFixed(6)} (${(minFactor * 100).toFixed(4)}%)`);
        console.log(`  Max: ${maxFactor.toFixed(6)} (${(maxFactor * 100).toFixed(4)}%)`);
        console.log(`  Ratio max/min: ${(maxFactor / minFactor).toFixed(1)}x`);
        console.log(`  Max return on cheapest bin: ~${(1 / minFactor).toFixed(0)}x`);

        // Show first 5 and last 5
        console.log(`  First 5: ${factors.slice(0, 5).map(f => f.toFixed(6)).join(', ')}`);
        console.log(`  Center 5: ${factors.slice(Math.floor(bins/2) - 2, Math.floor(bins/2) + 3).map(f => f.toFixed(6)).join(', ')}`);
        console.log(`  Last 5: ${factors.slice(-5).map(f => f.toFixed(6)).join(', ')}`);
      } else {
        console.log("  Could not read bin probabilities");

        // Try reading factors directly from segment tree
        // Or try getMarketState
        try {
          const state = await core.getMarketPricing(BigInt(marketId));
          console.log("  Market pricing:", state);
        } catch (e: any) {
          console.log("  getMarketPricing failed:", e.message?.slice(0, 100));
        }
      }
    } catch (e: any) {
      console.log(`Market #${marketId}: ${e.message?.slice(0, 100)}`);
    }
  }
}
main().catch(console.error);
