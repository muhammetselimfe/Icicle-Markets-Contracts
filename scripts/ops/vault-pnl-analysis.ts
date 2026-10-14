import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  console.log("=== Vault P&L Analysis (no batch processing) ===\n");

  // Vault state
  const nav = Number(await core.getVaultNav()) / 1e18;
  const price = Number(await core.getVaultPrice()) / 1e18;
  const dd = Number(await core.getVaultDrawdown()) / 1e16;
  const [bs, tr] = await core.getCapitalStack();
  console.log("--- Current Vault ---");
  console.log(`  NAV:         $${nav.toFixed(2)}`);
  console.log(`  Share Price: $${price.toFixed(6)}`);
  console.log(`  Drawdown:    ${dd.toFixed(2)}%`);
  console.log(`  Backstop:    $${(Number(bs)/1e18).toFixed(2)}`);
  console.log(`  Treasury:    $${(Number(tr)/1e18).toFixed(2)}`);

  // Processed batches
  const currentBatch = Number(await core.getCurrentBatchId());
  const BATCH_OFFSET = 28800;
  console.log(`\n--- Processed Batches ---`);
  console.log(`  Current batch pointer: ${currentBatch}`);

  let totalLt = 0;
  let totalFtot = 0;
  let batchCount = 0;
  for (let bid = currentBatch; bid >= Math.max(0, currentBatch - 30); bid--) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(bid));
      const lt = Number(r[0]) / 1e18;
      const ftot = Number(r[1]) / 1e18;
      const processed = r[6];
      if (lt !== 0 || ftot !== 0 || processed) {
        const net = lt + ftot;
        totalLt += lt;
        totalFtot += ftot;
        if (lt !== 0 || ftot !== 0) batchCount++;
        const batchStart = bid * 86400 + BATCH_OFFSET;
        const date = new Date(batchStart * 1000).toISOString().slice(0, 10);
        console.log(`  ${date} (${bid}): Lt=${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}, Fees=$${ftot.toFixed(2)}, Net=${net >= 0 ? "+" : ""}$${net.toFixed(2)} ${processed ? "✓" : "pending"}`);
      }
    } catch {}
  }

  console.log(`\n--- Processed Totals ---`);
  console.log(`  Total Lt:   ${totalLt >= 0 ? "+" : ""}$${totalLt.toFixed(2)}`);
  console.log(`  Total Ftot: $${totalFtot.toFixed(2)}`);
  console.log(`  Total Net:  ${(totalLt + totalFtot) >= 0 ? "+" : ""}$${(totalLt + totalFtot).toFixed(2)}`);
  console.log(`  Batches with P&L: ${batchCount}`);

  // Unprocessed: check all settled markets and their batch assignments
  const nextId = Number(await core.nextMarketId());
  const now = Math.floor(Date.now() / 1000);

  console.log(`\n--- Pending (Unprocessed) Market P&L ---`);
  let pendingLt = 0;
  let pendingFees = 0;
  let pendingMarkets = 0;

  // Collect all settled markets and figure out which batch they belong to
  for (let id = 1; id < nextId; id++) {
    try {
      const m = await core.markets(BigInt(id));
      if (Number(m.numBins) <= 1) continue;
      if (!m.settled) continue;

      const fees = Number(m.accumulatedFees) / 1e18;
      const deltaEt = Number(m.deltaEt) / 1e18;
      const alpha = Number(m.liquidityParameter) / 1e18;
      const bins = Number(m.numBins);
      const positions = Number(m.openPositionCount);
      const settleTick = Number(m.settlementTick);
      const settleTs = Number(m.settlementTimestamp);
      const settleBatch = Math.floor((settleTs - BATCH_OFFSET) / 86400);

      // Check if this market's batch is already processed
      if (settleBatch <= currentBatch) continue; // already processed

      // This market is in an unprocessed batch
      pendingMarkets++;
      pendingFees += fees;

      // We can't easily compute Lt per-market from on-chain without events
      // But we can estimate from deltaEt and fees
      console.log(`  #${id}: batch=${settleBatch}, α=${alpha.toFixed(0)}, bins=${bins}, positions=${positions}, fees=$${fees.toFixed(2)}, ΔEt=$${deltaEt.toFixed(1)}, settleTick=${settleTick}`);
    } catch {}
  }

  // Check pending batches for aggregate P&L
  console.log(`\n--- Pending Batch Aggregates ---`);
  let pendingBatchLt = 0;
  let pendingBatchFtot = 0;
  const todayBatch = Math.floor((now - BATCH_OFFSET) / 86400);
  for (let bid = currentBatch + 1; bid <= todayBatch + 1; bid++) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(bid));
      const lt = Number(r[0]) / 1e18;
      const ftot = Number(r[1]) / 1e18;
      const processed = r[6];
      if (lt !== 0 || ftot !== 0) {
        pendingBatchLt += lt;
        pendingBatchFtot += ftot;
        const batchStart = bid * 86400 + BATCH_OFFSET;
        const date = new Date(batchStart * 1000).toISOString().slice(0, 10);
        console.log(`  ${date} (${bid}): Lt=${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}, Fees=$${ftot.toFixed(2)}, Net=${(lt+ftot) >= 0 ? "+" : ""}$${(lt+ftot).toFixed(2)} [PENDING]`);
      }
    } catch {}
  }

  console.log(`\n--- Full Picture ---`);
  console.log(`  Processed:  Lt=${totalLt >= 0 ? "+" : ""}$${totalLt.toFixed(2)}, Fees=$${totalFtot.toFixed(2)}, Net=${(totalLt+totalFtot) >= 0 ? "+" : ""}$${(totalLt+totalFtot).toFixed(2)}`);
  console.log(`  Pending:    Lt=${pendingBatchLt >= 0 ? "+" : ""}$${pendingBatchLt.toFixed(2)}, Fees=$${pendingBatchFtot.toFixed(2)}, Net=${(pendingBatchLt+pendingBatchFtot) >= 0 ? "+" : ""}$${(pendingBatchLt+pendingBatchFtot).toFixed(2)}`);
  const allLt = totalLt + pendingBatchLt;
  const allFtot = totalFtot + pendingBatchFtot;
  console.log(`  ALL:        Lt=${allLt >= 0 ? "+" : ""}$${allLt.toFixed(2)}, Fees=$${allFtot.toFixed(2)}, Net=${(allLt+allFtot) >= 0 ? "+" : ""}$${(allLt+allFtot).toFixed(2)}`);
  console.log(`  ψ_fee (fees/|loss|): ${allLt < 0 ? (allFtot / Math.abs(allLt)).toFixed(4) : "N/A (no loss)"}`);

  // Contract balance
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const bal = await payment.balanceOf(env.contracts.IcicleOptionsCoreProxy);
  console.log(`\n--- Contract Balance ---`);
  console.log(`  USDC: $${(Number(bal) / 1e6).toFixed(2)}`);
}
main().catch(console.error);
