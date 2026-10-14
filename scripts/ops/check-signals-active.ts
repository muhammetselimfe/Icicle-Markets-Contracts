import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("prod");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const nextId = Number(await core.nextMarketId());
  console.log(`nextMarketId: ${nextId}\n`);

  // Check all markets from 50 onwards
  for (let id = 50; id <= nextId + 2; id++) {
    try {
      const m = await core.markets(BigInt(id));
      if (Number(m.numBins) === 0) continue;
      const end = Number(m.endTimestamp);
      const settle = Number(m.settlementTimestamp);
      const now = Math.floor(Date.now() / 1000);
      const alpha = Number(m.liquidityParameter) / 1e18;
      const minT = Number(m.minTick);
      const maxT = Number(m.maxTick);
      const spacing = Number(m.tickSpacing);
      const status = m.settled ? "SETTLED" : now < end ? "ACTIVE" : "EXPIRED";
      const remaining = end - now;

      console.log(`Market #${id}: ${status}`);
      console.log(`  Range: $${minT.toLocaleString()} – $${maxT.toLocaleString()}, spacing=$${spacing}`);
      console.log(`  Bins: ${m.numBins}, α=${alpha.toFixed(2)}`);
      console.log(`  End: ${new Date(end * 1000).toISOString()} (${remaining > 0 ? `${(remaining/3600).toFixed(1)}h left` : "ended"})`);
      console.log(`  Settlement: ${new Date(settle * 1000).toISOString()}`);
      console.log(`  Settled: ${m.settled}, settleTick: ${Number(m.settlementTick)}`);

      // Check accumulated fees
      console.log(`  Accumulated fees: $${(Number(m.accumulatedFees) / 1e18).toFixed(2)}`);
      console.log(`  DeltaEt: $${(Number(m.deltaEt) / 1e18).toFixed(2)}`);
      console.log();
    } catch (e: any) {
      // Market doesn't exist
    }
  }

  // Also check current batch
  const currentBatch = Number(await core.getCurrentBatchId());
  const BATCH_OFFSET = 28800;
  const now = Math.floor(Date.now() / 1000);
  const todayBatch = Math.floor((now - BATCH_OFFSET) / 86400);
  console.log(`Current processed batch: ${currentBatch}`);
  console.log(`Today's batch: ${todayBatch}`);

  // Check unprocessed batches
  for (let bid = currentBatch + 1; bid <= todayBatch; bid++) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(bid));
      console.log(`Batch ${bid}: Lt=$${(Number(r[0])/1e18).toFixed(2)}, Ftot=$${(Number(r[1])/1e18).toFixed(2)}, processed=${r[6]}`);
    } catch {}
  }
}
main().catch(console.error);
