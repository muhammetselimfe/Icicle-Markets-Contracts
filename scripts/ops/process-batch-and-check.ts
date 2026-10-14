import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Vault state BEFORE
  console.log("=== VAULT STATE BEFORE BATCH PROCESSING ===\n");
  const navBefore = Number(await core.getVaultNav()) / 1e18;
  const sharesBefore = Number(await core.getVaultShares()) / 1e18;
  const priceBefore = Number(await core.getVaultPrice()) / 1e18;
  const ddBefore = Number(await core.getVaultDrawdown()) / 1e16;
  const [bsBefore, trBefore] = await core.getCapitalStack();
  const bsNavBefore = Number(bsBefore) / 1e18;
  const trNavBefore = Number(trBefore) / 1e18;

  console.log(`  LP Vault NAV:    $${navBefore.toFixed(2)}`);
  console.log(`  LP Shares:       ${sharesBefore.toFixed(2)}`);
  console.log(`  Share Price:     $${priceBefore.toFixed(6)}`);
  console.log(`  Drawdown:        ${ddBefore.toFixed(2)}%`);
  console.log(`  Backstop NAV:    $${bsNavBefore.toFixed(2)}`);
  console.log(`  Treasury NAV:    $${trNavBefore.toFixed(2)}`);

  // Check which batches to process
  const currentBatch = Number(await core.getCurrentBatchId());
  console.log(`\nCurrent batch ID: ${currentBatch}`);

  // Check batch 20527 (where all our test markets settled)
  for (const b of [20527]) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(b));
      const lt = Number(r[0]) / 1e18;
      const ftot = Number(r[1]) / 1e18;
      const ft = Number(r[2]) / 1e18;
      const gt = Number(r[3]) / 1e18;
      const npre = Number(r[4]) / 1e18;
      const processed = r[6];
      console.log(`\nBatch ${b}: processed=${processed}`);
      console.log(`  Lt=$${lt.toFixed(2)}, Ftot=$${ftot.toFixed(2)}, Ft=$${ft.toFixed(2)}, Grant=$${gt.toFixed(2)}, PreNAV=$${npre.toFixed(0)}`);
    } catch (e: any) {
      console.log(`Batch ${b}: error - ${e.message?.slice(0, 80)}`);
    }
  }

  // Process the batch
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PROCESSING BATCH ${currentBatch}...`);
  console.log(`${"=".repeat(60)}`);

  try {
    const tx = await core.processDailyBatch();
    const receipt = await tx.wait();
    console.log(`Tx: ${receipt?.hash}`);
    console.log("processDailyBatch OK!");
  } catch (e: any) {
    console.log(`processDailyBatch error: ${e.message?.slice(0, 200)}`);
    // Try with explicit batch ID
    try {
      console.log("Trying with explicit current batch...");
      const tx = await core.processDailyBatch();
      const receipt = await tx.wait();
      console.log(`Tx: ${receipt?.hash}`);
    } catch (e2: any) {
      console.log(`Still failed: ${e2.message?.slice(0, 200)}`);
    }
  }

  // Vault state AFTER
  console.log(`\n=== VAULT STATE AFTER BATCH PROCESSING ===\n`);
  const navAfter = Number(await core.getVaultNav()) / 1e18;
  const sharesAfter = Number(await core.getVaultShares()) / 1e18;
  const priceAfter = Number(await core.getVaultPrice()) / 1e18;
  const ddAfter = Number(await core.getVaultDrawdown()) / 1e16;
  const [bsAfter, trAfter] = await core.getCapitalStack();
  const bsNavAfter = Number(bsAfter) / 1e18;
  const trNavAfter = Number(trAfter) / 1e18;

  console.log(`  LP Vault NAV:    $${navAfter.toFixed(2)}`);
  console.log(`  LP Shares:       ${sharesAfter.toFixed(2)}`);
  console.log(`  Share Price:     $${priceAfter.toFixed(6)}`);
  console.log(`  Drawdown:        ${ddAfter.toFixed(2)}%`);
  console.log(`  Backstop NAV:    $${bsNavAfter.toFixed(2)}`);
  console.log(`  Treasury NAV:    $${trNavAfter.toFixed(2)}`);

  // Deltas
  console.log(`\n=== CHANGES ===\n`);
  console.log(`  LP Vault NAV:    ${navAfter >= navBefore ? "+" : ""}$${(navAfter - navBefore).toFixed(2)}`);
  console.log(`  Share Price:     ${priceAfter >= priceBefore ? "+" : ""}$${(priceAfter - priceBefore).toFixed(6)}`);
  console.log(`  Drawdown:        ${ddAfter >= ddBefore ? "+" : ""}${(ddAfter - ddBefore).toFixed(2)}%`);
  console.log(`  Backstop NAV:    ${bsNavAfter >= bsNavBefore ? "+" : ""}$${(bsNavAfter - bsNavBefore).toFixed(2)}`);
  console.log(`  Treasury NAV:    ${trNavAfter >= trNavBefore ? "+" : ""}$${(trNavAfter - trNavBefore).toFixed(2)}`);

  // Read processed batch data
  console.log(`\n=== PROCESSED BATCH DATA ===\n`);
  for (const b of [20527]) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(b));
      const lt = Number(r[0]) / 1e18;
      const ftot = Number(r[1]) / 1e18;
      const ft = Number(r[2]) / 1e18;
      const gt = Number(r[3]) / 1e18;
      const npre = Number(r[4]) / 1e18;
      const processed = r[6];
      console.log(`Batch ${b}: processed=${processed}`);
      console.log(`  CLMSR P&L (Lt): $${lt.toFixed(2)}`);
      console.log(`  Gross fees (Ftot): $${ftot.toFixed(2)}`);
      console.log(`  LP fees (Ft): $${ft.toFixed(2)}`);
      console.log(`  Backstop grant (Gt): $${gt.toFixed(2)}`);
      console.log(`  Pre-NAV: $${npre.toFixed(0)}`);
    } catch (e: any) {
      console.log(`Batch ${b}: ${e.message?.slice(0, 80)}`);
    }
  }

  // Fee waterfall config
  try {
    const wf = await core.getFeeWaterfallConfig();
    console.log(`\nFee Waterfall Config:`);
    console.log(`  pdd (drawdown threshold): ${Number(wf[0]) / 1e16}%`);
    console.log(`  rhoBS (backstop share): ${Number(wf[1]) / 1e16}%`);
    console.log(`  phiLP (LP share): ${Number(wf[2]) / 1e16}%`);
    console.log(`  phiBS (backstop share): ${Number(wf[3]) / 1e16}%`);
    console.log(`  phiTR (treasury share): ${Number(wf[4]) / 1e16}%`);
  } catch {}
}
main();
