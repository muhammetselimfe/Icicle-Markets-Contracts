/**
 * Check Signals Protocol vault state on Citrea mainnet (prod).
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("prod");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  console.log("=== Signals Protocol — Citrea Mainnet ===\n");
  console.log(`Core: ${env.contracts.IcicleOptionsCoreProxy}`);

  // Vault state
  const nav = Number(await core.getVaultNav()) / 1e18;
  const price = Number(await core.getVaultPrice()) / 1e18;
  const dd = Number(await core.getVaultDrawdown()) / 1e16;
  const [bs, tr] = await core.getCapitalStack();
  console.log(`\n--- LP Vault ---`);
  console.log(`  NAV:           $${nav.toFixed(2)}`);
  console.log(`  Share Price:   $${price.toFixed(6)}`);
  console.log(`  Drawdown:      ${dd.toFixed(2)}%`);
  console.log(`  Backstop:      $${(Number(bs)/1e18).toFixed(2)}`);
  console.log(`  Treasury:      $${(Number(tr)/1e18).toFixed(2)}`);

  // Total supply of LP shares
  const lpShare = await ethers.getContractAt("IERC20", env.contracts.IcicleOptionsLPShareProxy);
  const totalShares = Number(await lpShare.totalSupply()) / 1e18;
  console.log(`  Total Shares:  ${totalShares.toFixed(2)}`);

  // Batch info
  const currentBatch = Number(await core.getCurrentBatchId());
  console.log(`\n--- Batches ---`);
  console.log(`  Current batch: ${currentBatch}`);

  // Recent batch P&L
  for (let bid = currentBatch; bid >= Math.max(0, currentBatch - 5); bid--) {
    try {
      const r = await core.getDailyPnl.staticCall(BigInt(bid));
      const lt = Number(r[0]) / 1e18;
      const ftot = Number(r[1]) / 1e18;
      const processed = r[6];
      if (lt !== 0 || ftot !== 0 || processed) {
        console.log(`  Batch ${bid}: Lt=$${lt.toFixed(2)}, Ftot=$${ftot.toFixed(2)}, processed=${processed}`);
      }
    } catch {}
  }

  // Market count
  const nextId = Number(await core.nextMarketId());
  console.log(`\n--- Markets ---`);
  console.log(`  Total markets created: ${nextId}`);

  // Check last few markets
  let activeCount = 0;
  let settledCount = 0;
  for (let id = Math.max(1, nextId - 10); id < nextId; id++) {
    try {
      const m = await core.markets(BigInt(id));
      const settled = m.settled;
      const end = Number(m.endTimestamp);
      const now = Math.floor(Date.now() / 1000);
      const isActive = !settled && now < end;

      if (isActive) activeCount++;
      if (settled) settledCount++;

      const status = settled ? "settled" : isActive ? "ACTIVE" : "expired (unsettled)";
      const alpha = Number(m.liquidityParameter) / 1e18;
      console.log(`  #${id}: ${status}, α=${alpha}, bins=${m.numBins}, end=${new Date(end*1000).toISOString()}`);
    } catch {}
  }

  console.log(`\n  Active: ${activeCount}, Settled (last 10): ${settledCount}`);

  // Payment token balance
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const vaultBalance = await payment.balanceOf(env.contracts.IcicleOptionsCoreProxy);
  console.log(`\n--- Contract USDC ---`);
  console.log(`  Balance: $${(Number(vaultBalance) / 1e6).toFixed(2)}`);
}
main().catch(console.error);
