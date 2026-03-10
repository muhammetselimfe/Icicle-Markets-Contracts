/**
 * Check total volume spent on market 9 by reading PositionOpened events.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const marketId = 9n;

  // Get market creation block by scanning recent blocks
  const m = await core.markets(marketId);
  const startTs = Number(m[8]);
  console.log(`Market #9 started: ${new Date(startTs * 1000).toISOString()}`);
  console.log(`Open positions: ${m[5]}`);

  // Get PositionOpened events for market 9
  const currentBlock = await ethers.provider.getBlockNumber();
  console.log(`Current block: ${currentBlock}`);

  // Scan last 100k blocks in 2048-block chunks
  const fromBlock = Math.max(0, currentBlock - 100000);
  let totalCost = 0n;
  let posCount = 0;
  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  const filter = {
    address: coreAddress,
    topics: [
      tradeIface.getEvent("PositionOpened")!.topicHash,
      null, // positionId (any)
      null, // trader (any)
      ethers.zeroPadValue(ethers.toBeHex(marketId), 32), // marketId = 9
    ],
  };

  for (let from = fromBlock; from <= currentBlock; from += 2048) {
    const to = Math.min(from + 2047, currentBlock);
    try {
      const logs = await ethers.provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const parsed = tradeIface.parseLog(log);
        if (parsed) {
          const cost = parsed.args.cost;
          const qty = parsed.args.quantity;
          const lower = parsed.args.lowerTick;
          const upper = parsed.args.upperTick;
          totalCost += cost;
          posCount++;
          console.log(`  #${parsed.args.positionId}: ticks ${lower}–${upper}, qty=${(Number(qty) / 1e6).toFixed(2)}, cost=$${(Number(cost) / 1e6).toFixed(2)}`);
        }
      }
    } catch { /* skip chunk */ }
  }

  console.log(`\n=== TOTAL ===`);
  console.log(`Positions: ${posCount}`);
  console.log(`Total cost: $${(Number(totalCost) / 1e6).toFixed(2)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
