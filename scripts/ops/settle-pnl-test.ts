/**
 * Settle markets #38, #39, #40 one-by-one, reading batch P&L between each.
 * Then settle #41 (α=1000 test).
 *
 * Settlement prices:
 *   #38 → $9.95 (center, tick=995) — 0σ
 *   #39 → $9.55 (2σ away, tick=955)
 *   #40 → $8.50 (edge, tick=850) — ~7σ
 *   #41 → live AVAX price
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const [deployer] = await ethers.getSigners();

  const currentBatch = Number(await core.getCurrentBatchId());
  console.log(`Current batch: ${currentBatch}`);

  // Read batch P&L helper
  async function readBatchPnl(label: string) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(currentBatch));
      const lt = Number(r[0]) / 1e18;
      const ft = Number(r[1]) / 1e18;
      console.log(`  [${label}] Batch ${currentBatch}: Lt=$${lt.toFixed(2)}, Ft=$${ft.toFixed(2)}, Net=$${(lt+ft).toFixed(2)}`);
      return { lt, ft };
    } catch(e: any) {
      console.log(`  [${label}] getDailyPnl error: ${e.message?.slice(0,80)}`);
      return { lt: 0, ft: 0 };
    }
  }

  // Settle a market via secondary settlement
  async function settleMarket(id: number, tick: number, label: string) {
    const mktId = BigInt(id);
    const settlementValue = BigInt(tick) * 1_000_000n;
    console.log(`\nSettling #${id} → tick=${tick} ($${(tick/100).toFixed(2)}) [${label}]`);

    // Step 1: markSettlementFailed
    try {
      const tx1 = await core.markSettlementFailed(mktId);
      await tx1.wait();
      console.log(`  markSettlementFailed OK`);
    } catch(e: any) {
      const msg = e.message || "";
      if (msg.includes("already") || msg.includes("settled")) {
        console.log(`  Already marked failed or settled`);
      } else {
        console.log(`  markSettlementFailed error: ${msg.slice(0,100)}`);
        return false;
      }
    }

    // Step 2: finalizeSecondarySettlement
    try {
      const tx2 = await core.finalizeSecondarySettlement(mktId, settlementValue);
      await tx2.wait();
      console.log(`  finalizeSecondarySettlement OK`);
    } catch(e: any) {
      console.log(`  finalizeSecondarySettlement error: ${(e.message || "").slice(0,100)}`);
      return false;
    }

    // Step 3: requestSettlementChunks
    try {
      const tx3 = await core.requestSettlementChunks(mktId, 25);
      await tx3.wait();
      console.log(`  requestSettlementChunks(25) OK`);
    } catch(e: any) {
      console.log(`  requestSettlementChunks error: ${(e.message || "").slice(0,100)}`);
    }

    // Check if settled
    const m = await core.markets(mktId);
    console.log(`  settled=${m.settled}, settleTick=${Number(m.settlementTick)}`);
    return m.settled;
  }

  // === Read initial batch state ===
  const before = await readBatchPnl("BEFORE any settlement");

  // === Settle #38 (center, $9.95) ===
  await settleMarket(38, 995, "center 0σ");
  const after38 = await readBatchPnl("AFTER #38");

  // === Settle #39 (2σ, $9.55) ===
  await settleMarket(39, 955, "2σ away");
  const after39 = await readBatchPnl("AFTER #39");

  // === Settle #40 (edge, $8.50) ===
  await settleMarket(40, 850, "edge 7σ");
  const after40 = await readBatchPnl("AFTER #40");

  // === Settle #41 (live price) ===
  // Use $9.89 as approximation (AVAX ~$9.89)
  console.log("\n--- Market #41 (α=1000, $26.8K volume) ---");
  const before41 = await readBatchPnl("BEFORE #41");
  await settleMarket(41, 989, "live ~$9.89");
  const after41 = await readBatchPnl("AFTER #41");

  // === Per-market P&L table ===
  console.log(`\n${"=".repeat(80)}`);
  console.log(`PER-MARKET P&L RESULTS`);
  console.log(`${"=".repeat(80)}`);

  const m38_lt = after38.lt - before.lt;
  const m38_ft = after38.ft - before.ft;
  const m39_lt = after39.lt - after38.lt;
  const m39_ft = after39.ft - after38.ft;
  const m40_lt = after40.lt - after39.lt;
  const m40_ft = after40.ft - after39.ft;
  const m41_lt = after41.lt - after40.lt;
  const m41_ft = after41.ft - after40.ft;

  console.log(`Market | Settle    | Dist | CLMSR P&L    | Fees       | Net Vault`);
  console.log(`-------|-----------|------|--------------|------------|----------`);
  console.log(`#38    | $9.95     | 0σ   | $${m38_lt.toFixed(2).padStart(10)} | $${m38_ft.toFixed(2).padStart(8)} | $${(m38_lt+m38_ft).toFixed(2)}`);
  console.log(`#39    | $9.55     | 2σ   | $${m39_lt.toFixed(2).padStart(10)} | $${m39_ft.toFixed(2).padStart(8)} | $${(m39_lt+m39_ft).toFixed(2)}`);
  console.log(`#40    | $8.50     | 7σ   | $${m40_lt.toFixed(2).padStart(10)} | $${m40_ft.toFixed(2).padStart(8)} | $${(m40_lt+m40_ft).toFixed(2)}`);
  console.log(`#41    | $9.89     | α1K  | $${m41_lt.toFixed(2).padStart(10)} | $${m41_ft.toFixed(2).padStart(8)} | $${(m41_lt+m41_ft).toFixed(2)}`);
  console.log(`${"=".repeat(80)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
