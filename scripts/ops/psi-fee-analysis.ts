/**
 * ψ_fee Analysis — compute fee/loss ratio across all settled batches.
 *
 * Batch IDs are day-keys: batchId = (timestamp - 28800) / 86400 (PST day boundary)
 * Current batch ~20526 (March 2026). We scan a range around it.
 *
 * Usage:
 *   npx hardhat run scripts/ops/psi-fee-analysis.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

function toNumber(val: bigint): number {
  // Safe conversion for WAD-denominated values
  return Number(val) / 1e18;
}

function toNumberSigned(val: bigint): number {
  return Number(val) / 1e18;
}

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Get current batch ID
  const currentBatch = Number(await core.getCurrentBatchId());
  console.log(`Current batch ID: ${currentBatch}`);

  // Vault state
  try {
    const nav = await core.getVaultNav();
    const shares = await core.getVaultShares();
    const price = await core.getVaultPrice();
    const dd = await core.getVaultDrawdown();
    console.log(`\nVault State:`);
    console.log(`  NAV: $${toNumber(nav).toFixed(2)}`);
    console.log(`  Shares: ${toNumber(shares).toFixed(2)}`);
    console.log(`  Share price: $${toNumber(price).toFixed(6)}`);
    console.log(`  Drawdown: ${(Number(dd) / 1e16).toFixed(2)}%`);
  } catch (err: any) {
    console.log(`Vault state error: ${err.message?.slice(0, 80)}`);
  }

  // === Per-market analysis first (more reliable) ===
  console.log(`\n${"=".repeat(90)}`);
  console.log(`PER-MARKET DATA`);
  console.log(`${"=".repeat(90)}`);
  console.log(
    `${"#".padStart(3)} | ${"Status".padEnd(8)} | ${"α".padStart(5)} | ${"Bins".padStart(4)} | ${"Range".padEnd(16)} | ${"Fee Policy".padEnd(12)} | ${"SettleTick".padStart(10)}`
  );
  console.log("-".repeat(90));

  const settledMarkets: number[] = [];
  const activeMarkets: number[] = [];

  for (let m = 1; m <= 35; m++) {
    try {
      const market = await core.markets(BigInt(m));
      if (market.numBins === 0n) continue;

      const settled = market.settled;
      const alpha = toNumber(market.liquidityParameter);
      const numBins = Number(market.numBins);
      const minTick = Number(market.minTick);
      const maxTick = Number(market.maxTick);
      const spacing = Number(market.tickSpacing);
      const feePolicy = market.feePolicy as string;
      const settleTick = Number(market.settlementTick);

      const isCent = spacing < 10;
      const d = isCent ? 100 : 1;
      const rangeStr = `$${(minTick / d).toFixed(0)}–$${(maxTick / d).toFixed(0)}`;
      const status = settled ? "SETTLED" : "ACTIVE";
      const fpShort = feePolicy.slice(0, 6) + "..." + feePolicy.slice(-4);

      if (settled) settledMarkets.push(m);
      else activeMarkets.push(m);

      console.log(
        `${String(m).padStart(3)} | ${status.padEnd(8)} | ${alpha.toFixed(0).padStart(5)} | ${String(numBins).padStart(4)} | ${rangeStr.padEnd(16)} | ${fpShort.padEnd(12)} | ${settled ? String(settleTick / d).padStart(10) : "—".padStart(10)}`
      );
    } catch {
      // skip
    }
  }

  console.log(`\nSettled: ${settledMarkets.length} markets (${settledMarkets.join(", ")})`);
  console.log(`Active: ${activeMarkets.length} markets (${activeMarkets.join(", ")})`);

  // === Batch P&L analysis ===
  // Scan batches from (currentBatch - 60) to (currentBatch + 2)
  // This covers ~60 days of history
  console.log(`\n${"=".repeat(100)}`);
  console.log(`BATCH-BY-BATCH ψ_fee ANALYSIS`);
  console.log(`${"=".repeat(100)}`);
  console.log(
    `${"Batch".padStart(6)} | ${"Date".padEnd(10)} | ${"CLMSR P&L".padStart(12)} | ${"Fees".padStart(10)} | ${"Grant".padStart(10)} | ${"Pre-NAV".padStart(10)} | ${"ψ_fee".padStart(8)} | ${"Net".padStart(12)}`
  );
  console.log("-".repeat(100));

  let totalClmsr = 0;
  let totalFees = 0;
  let totalGrant = 0;
  let totalLoss = 0;
  let lossBatches = 0;
  let winBatches = 0;
  let processedCount = 0;

  const startBatch = Math.max(0, currentBatch - 60);
  const endBatch = currentBatch + 2;

  for (let b = startBatch; b <= endBatch; b++) {
    try {
      const result = await core.getDailyPnl(BigInt(b));
      const lt = result[0] as bigint;
      const ftot = result[1] as bigint;
      const gt = result[3] as bigint;
      const npre = result[4] as bigint;
      const processed = result[6] as boolean;

      // Skip batches with no data
      if (!processed && npre === 0n && lt === 0n && ftot === 0n) continue;

      const ltUsd = toNumberSigned(lt);
      const ftotUsd = toNumber(ftot);
      const gtUsd = toNumber(gt);
      const npreUsd = toNumber(npre);

      // Batch date: batchId * 86400 + 28800
      const batchTimestamp = b * 86400 + 28800;
      const dateStr = new Date(batchTimestamp * 1000).toISOString().slice(0, 10);

      const loss = Math.max(-ltUsd, 0);
      const psi = loss > 0.01 ? ftotUsd / loss : (ftotUsd > 0 ? Infinity : 0);
      const psiStr = psi === Infinity ? "∞" : psi.toFixed(3);

      const netVault = ltUsd + ftotUsd;
      const netStr = netVault >= 0 ? `+$${netVault.toFixed(2)}` : `-$${Math.abs(netVault).toFixed(2)}`;
      const ltStr = ltUsd >= 0 ? `+$${ltUsd.toFixed(2)}` : `-$${Math.abs(ltUsd).toFixed(2)}`;

      const proc = processed ? "" : " (pending)";
      console.log(
        `${String(b).padStart(6)} | ${dateStr} | ${ltStr.padStart(12)} | $${ftotUsd.toFixed(2).padStart(9)} | $${gtUsd.toFixed(2).padStart(9)} | $${npreUsd.toFixed(0).padStart(9)} | ${psiStr.padStart(8)} | ${netStr.padStart(12)}${proc}`
      );

      if (processed) {
        totalClmsr += ltUsd;
        totalFees += ftotUsd;
        totalGrant += gtUsd;
        if (ltUsd < -0.01) {
          lossBatches++;
          totalLoss += loss;
        } else {
          winBatches++;
        }
        processedCount++;
      }
    } catch {
      // batch doesn't exist or reverted, skip
    }
  }

  console.log("-".repeat(100));

  // === Summary ===
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY (${processedCount} processed batches)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Total CLMSR P&L:       $${totalClmsr >= 0 ? "+" : ""}${totalClmsr.toFixed(2)}`);
  console.log(`  Total fees earned:     $${totalFees.toFixed(2)}`);
  console.log(`  Total backstop grants: $${totalGrant.toFixed(2)}`);
  console.log(`  Net vault (CLMSR+fees): $${(totalClmsr + totalFees) >= 0 ? "+" : ""}${(totalClmsr + totalFees).toFixed(2)}`);
  console.log(`  Loss batches: ${lossBatches}, Profit batches: ${winBatches}`);

  if (totalLoss > 0.01) {
    const psiFee = totalFees / totalLoss;
    console.log(`\n  ────────────────────────────────`);
    console.log(`  ψ_fee = ${psiFee.toFixed(4)}`);
    console.log(`  ────────────────────────────────`);
    console.log(`  Fees cover ${(psiFee * 100).toFixed(1)}% of losses`);
    console.log(`  Need ψ_fee > 1.0 for sustainability`);

    const breakEvenBps = Math.round(100 * (totalLoss / totalFees));
    console.log(`\n  Break-even fee rate: ~${breakEvenBps}bps (currently 100bps)`);
    if (breakEvenBps > 100) {
      console.log(`  Need ${(breakEvenBps / 100).toFixed(1)}x current fees to break even`);
    } else {
      console.log(`  Current fee rate is sufficient!`);
    }
  } else if (totalFees > 0) {
    console.log(`\n  ψ_fee = ∞ (no losses!)`);
  } else {
    console.log(`\n  No processed batches with P&L data found.`);
    console.log(`  This likely means no batches have been processed via processDailyBatch().`);
    console.log(`  Markets may have settled but batch processing hasn't run.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
