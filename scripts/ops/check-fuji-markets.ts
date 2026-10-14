import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const nextId = Number(await core.nextMarketId());
  const now = Math.floor(Date.now() / 1000);

  console.log("=== Icicle Options — Fuji Markets ===\n");
  console.log(`Total markets: ${nextId - 1}\n`);

  let totalLt = 0;
  let totalFees = 0;
  let marketsWithTrades = 0;

  for (let id = 1; id < nextId; id++) {
    try {
      const m = await core.markets(BigInt(id));
      if (Number(m.numBins) <= 1) continue; // skip dummy markets

      const alpha = Number(m.liquidityParameter) / 1e18;
      const bins = Number(m.numBins);
      const fees = Number(m.accumulatedFees) / 1e18;
      const deltaEt = Number(m.deltaEt) / 1e18;
      const positions = Number(m.openPositionCount);
      const settled = m.settled;
      const end = Number(m.endTimestamp);
      const status = settled ? "settled" : now < end ? "ACTIVE" : "expired";
      const maxLoss = alpha * Math.log(bins);
      const priorType = deltaEt > 0.1 ? "Bell" : "Uniform";

      // Get batch P&L if settled
      let lt = 0;
      let ftot = 0;

      console.log(`#${id}: ${status} | α=${alpha.toFixed(1)} | bins=${bins} | prior=${priorType} (ΔEt=${deltaEt.toFixed(1)}) | fees=$${fees.toFixed(2)} | maxLoss=$${maxLoss.toFixed(1)} | positions=${positions}`);

      if (settled) {
        console.log(`     settleTick=${Number(m.settlementTick)}`);
      }

      if (fees > 0 || positions > 0) marketsWithTrades++;
      totalFees += fees;
    } catch {}
  }

  // Check vault
  try {
    const nav = Number(await core.getVaultNav()) / 1e18;
    const price = Number(await core.getVaultPrice()) / 1e18;
    const dd = Number(await core.getVaultDrawdown()) / 1e16;
    console.log(`\n--- LP Vault ---`);
    console.log(`  NAV: $${nav.toFixed(2)}`);
    console.log(`  Share Price: $${price.toFixed(6)}`);
    console.log(`  Drawdown: ${dd.toFixed(2)}%`);
  } catch {}

  // Batches
  try {
    const currentBatch = Number(await core.getCurrentBatchId());
    const BATCH_OFFSET = 28800;
    console.log(`\n--- Batch P&L ---`);
    for (let bid = currentBatch; bid >= Math.max(0, currentBatch - 15); bid--) {
      try {
        const r = await core.getDailyPnl.staticCall(BigInt(bid));
        const lt = Number(r[0]) / 1e18;
        const ftot = Number(r[1]) / 1e18;
        const processed = r[6];
        if (lt !== 0 || ftot !== 0 || processed) {
          const net = lt + ftot;
          totalLt += lt;
          const batchStart = bid * 86400 + BATCH_OFFSET;
          const date = new Date(batchStart * 1000).toISOString().slice(0, 10);
          console.log(`  ${date} (${bid}): Lt=${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}, Fees=$${ftot.toFixed(2)}, Net=${net >= 0 ? "+" : ""}$${net.toFixed(2)} ${processed ? "✓" : "pending"}`);
        }
      } catch {}
    }
  } catch {}

  console.log(`\n--- Summary ---`);
  console.log(`  Markets with trades: ${marketsWithTrades}`);
  console.log(`  Total fees collected: $${totalFees.toFixed(2)}`);
}
main().catch(console.error);
