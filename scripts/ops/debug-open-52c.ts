import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const marketId = 52n;

  const m = await core.markets(marketId);
  console.log("Market state:");
  console.log(`  minTick=${m.minTick}, maxTick=${m.maxTick}, spacing=${m.tickSpacing}`);
  console.log(`  numBins=${m.numBins}, isSeeded=${m.isSeeded}`);
  console.log(`  settled=${m.settled}`);
  console.log(`  start=${Number(m.startTimestamp)}, end=${Number(m.endTimestamp)}`);

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  console.log(`  blockTime=${now}`);
  console.log(`  started=${now >= Number(m.startTimestamp)}`);
  console.log(`  ended=${now >= Number(m.endTimestamp)}`);

  // Try different bin ranges
  for (const [lo, hi] of [[37, 42], [39, 41], [40, 40], [0, 0], [0, 79]]) {
    for (const amt of [1, 5]) {
      const qty = ethers.parseUnits(String(amt), 18);
      const maxCost = ethers.parseUnits(String(amt), 6);
      try {
        await core.openPosition.staticCall(marketId, lo, hi, qty, maxCost);
        console.log(`  [${lo}-${hi}] $${amt}: OK`);
      } catch (e: any) {
        // Try to get error data
        const data = e.data || e.error?.data || "";
        console.log(`  [${lo}-${hi}] $${amt}: REVERT ${data ? data.slice(0, 20) : e.message?.slice(0, 80)}`);
      }
    }
  }
}
main().catch(console.error);
