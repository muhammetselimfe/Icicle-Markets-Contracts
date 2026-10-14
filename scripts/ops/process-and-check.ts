import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // BEFORE
  console.log("=== BEFORE ===\n");
  const navB = Number(await core.getVaultNav()) / 1e18;
  const priceB = Number(await core.getVaultPrice()) / 1e18;
  const ddB = Number(await core.getVaultDrawdown()) / 1e16;
  const [bsB, trB] = await core.getCapitalStack();
  console.log(`  LP Vault NAV:  $${navB.toFixed(2)}`);
  console.log(`  Share Price:   $${priceB.toFixed(6)}`);
  console.log(`  Drawdown:      ${ddB.toFixed(2)}%`);
  console.log(`  Backstop:      $${(Number(bsB)/1e18).toFixed(2)}`);
  console.log(`  Treasury:      $${(Number(trB)/1e18).toFixed(2)}`);

  // Find the current batch to process
  const currentBatch = Number(await core.getCurrentBatchId());
  console.log(`\nCurrent batch ID: ${currentBatch}`);

  // Try processing batches starting from 20528 up to current
  const todayBatch = Math.floor(Date.now() / 1000 / 86400);
  for (let bid = 20528; bid <= todayBatch; bid++) {
    console.log(`\nProcessing batch ${bid}...`);
    try {
      const tx = await core.processDailyBatch(bid);
      const receipt = await tx.wait();
      console.log(`Tx: ${receipt?.hash}`);
      console.log(`Batch ${bid} processed!`);
    } catch (e: any) {
      console.log(`Batch ${bid} skip: ${e.message?.slice(0, 150)}`);
    }
  }

  // AFTER
  console.log(`\n=== AFTER ===\n`);
  const navA = Number(await core.getVaultNav()) / 1e18;
  const priceA = Number(await core.getVaultPrice()) / 1e18;
  const ddA = Number(await core.getVaultDrawdown()) / 1e16;
  const [bsA, trA] = await core.getCapitalStack();
  console.log(`  LP Vault NAV:  $${navA.toFixed(2)}`);
  console.log(`  Share Price:   $${priceA.toFixed(6)}`);
  console.log(`  Drawdown:      ${ddA.toFixed(2)}%`);
  console.log(`  Backstop:      $${(Number(bsA)/1e18).toFixed(2)}`);
  console.log(`  Treasury:      $${(Number(trA)/1e18).toFixed(2)}`);

  // DELTAS
  console.log(`\n=== CHANGES ===\n`);
  console.log(`  LP Vault NAV:  ${navA >= navB ? "+" : ""}$${(navA - navB).toFixed(2)}`);
  console.log(`  Share Price:   ${priceA >= priceB ? "+" : ""}$${(priceA - priceB).toFixed(6)}`);
  console.log(`  Drawdown:      ${ddA >= ddB ? "+" : ""}${(ddA - ddB).toFixed(2)}%`);
  console.log(`  Backstop:      ${Number(bsA) >= Number(bsB) ? "+" : ""}$${(Number(bsA)/1e18 - Number(bsB)/1e18).toFixed(2)}`);
  console.log(`  Treasury:      ${Number(trA) >= Number(trB) ? "+" : ""}$${(Number(trA)/1e18 - Number(trB)/1e18).toFixed(2)}`);

  // Batch data post-process — show all recent batches
  for (let bid = 20527; bid <= todayBatch; bid++) {
    console.log(`\n=== BATCH ${bid} DATA ===\n`);
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(bid));
      console.log(`  CLMSR P&L (Lt): $${(Number(r[0])/1e18).toFixed(2)}`);
      console.log(`  Gross fees (Ftot): $${(Number(r[1])/1e18).toFixed(2)}`);
      console.log(`  LP fees (Ft): $${(Number(r[2])/1e18).toFixed(2)}`);
      console.log(`  Backstop grant (Gt): $${(Number(r[3])/1e18).toFixed(2)}`);
      console.log(`  Pre-NAV: $${(Number(r[4])/1e18).toFixed(0)}`);
      console.log(`  Processed: ${r[6]}`);
    } catch {
      console.log(`  (no data)`);
    }
  }
}
main();
