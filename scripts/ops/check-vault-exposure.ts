/**
 * Check LP vault balance vs worst-case payout exposure on market 9.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const marketId = 9n;
  const m = await core.markets(marketId);
  const minTick = Number(m[12]);
  const maxTick = Number(m[13]);
  const tickSpacing = Number(m[14]);

  // Get LP vault state
  const lpShareAddr = envData.contracts.IcicleOptionsLPShareProxy;
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);

  // Contract's total USDC balance
  const contractBalance = await payment.balanceOf(coreAddress);
  console.log(`Contract USDC balance: $${(Number(contractBalance) / 1e6).toFixed(2)}`);

  // Get all PositionOpened events for market 9 to sum quantities per bin
  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);
  const currentBlock = await ethers.provider.getBlockNumber();
  const fromBlock = currentBlock - 100000;

  const filter = {
    address: coreAddress,
    topics: [
      tradeIface.getEvent("PositionOpened")!.topicHash,
      null, null,
      ethers.zeroPadValue(ethers.toBeHex(marketId), 32),
    ],
  };

  // Track quantity per bin (worst case: all quantity in one bin wins)
  let totalQty = 0n;
  let totalCost = 0n;
  let posCount = 0;

  // Also track quantity per tick to find max exposure at any single tick
  const qtyPerTick = new Map<number, bigint>();

  for (let from = fromBlock; from <= currentBlock; from += 2048) {
    const to = Math.min(from + 2047, currentBlock);
    try {
      const logs = await ethers.provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const parsed = tradeIface.parseLog(log);
        if (parsed) {
          totalQty += parsed.args.quantity;
          totalCost += parsed.args.cost;
          posCount++;

          // Spread quantity across bins this position covers
          const lower = Number(parsed.args.lowerTick);
          const upper = Number(parsed.args.upperTick);
          const qty = parsed.args.quantity;
          for (let tick = lower; tick < upper; tick += tickSpacing) {
            qtyPerTick.set(tick, (qtyPerTick.get(tick) ?? 0n) + qty);
          }
        }
      }
    } catch { /* skip */ }
  }

  // Find the tick with max quantity exposure
  let maxTickQty = 0n;
  let maxTick2 = 0;
  for (const [tick, qty] of qtyPerTick) {
    if (qty > maxTickQty) {
      maxTickQty = qty;
      maxTick2 = tick;
    }
  }

  console.log(`\nMarket #9 stats:`);
  console.log(`  Positions: ${posCount}`);
  console.log(`  Total cost paid by traders: $${(Number(totalCost) / 1e6).toFixed(2)}`);
  console.log(`  Total quantity (all positions): ${(Number(totalQty) / 1e6).toFixed(2)} shares`);
  console.log(`\nWorst-case payout (if settlement hits the most loaded tick):`);
  console.log(`  Tick $${(maxTick2 / 100).toFixed(2)}: ${(Number(maxTickQty) / 1e6).toFixed(2)} shares = $${(Number(maxTickQty) / 1e6).toFixed(2)} payout`);
  console.log(`\nCan vault cover worst case?`);
  console.log(`  Contract balance: $${(Number(contractBalance) / 1e6).toFixed(2)}`);
  console.log(`  Max payout needed: $${(Number(maxTickQty) / 1e6).toFixed(2)}`);
  console.log(`  ${Number(contractBalance) >= Number(maxTickQty) ? '✓ YES' : '✗ NO — vault is underfunded'}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
