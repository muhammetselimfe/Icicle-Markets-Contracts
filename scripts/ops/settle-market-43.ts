/**
 * Wait for market #43 oracle window, then settle at live AVAX price (~$10.35).
 * Positions were bell-shaped around $9.55 — all losers since price went up.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const m = await core.markets(43n);
  const end = Number(m.endTimestamp);
  const now = Math.floor(Date.now() / 1000);
  const waitSec = (end + 610) - now;

  if (waitSec > 0) {
    console.log(`Waiting ${waitSec}s for oracle window to expire...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }

  // Settle at $10.35 (tick 1035)
  const settleTick = 1035;
  const settlementValue = BigInt(settleTick) * 1_000_000n;
  console.log(`Settling #43 at tick ${settleTick} ($${(settleTick/100).toFixed(2)})...`);

  const tx1 = await core.markSettlementFailed(43n);
  await tx1.wait();
  console.log("markSettlementFailed OK");

  const tx2 = await core.finalizeSecondarySettlement(43n, settlementValue);
  await tx2.wait();
  console.log("finalizeSecondarySettlement OK");

  const tx3 = await core.requestSettlementChunks(43n, 25);
  await tx3.wait();
  console.log("requestSettlementChunks OK");

  const settled = await core.markets(43n);
  console.log(`settled=${settled.settled}, settleTick=${Number(settled.settlementTick)}`);

  // Read per-market P&L
  const latestBlock = await ethers.provider.getBlockNumber();
  const lifecycleArtifact = await hre.artifacts.readArtifact("MarketLifecycleModule");
  const lifecycleIface = new ethers.Interface(lifecycleArtifact.abi);

  const logs = await ethers.provider.getLogs({
    address: env.contracts.IcicleOptionsCoreProxy,
    fromBlock: latestBlock - 100,
    toBlock: latestBlock,
  });

  for (const log of logs) {
    try {
      const parsed = lifecycleIface.parseLog(log);
      if (parsed?.name === "MarketPnlRecorded" && Number(parsed.args.marketId) === 43) {
        const lt = Number(parsed.args.lt) / 1e18;
        const ftot = Number(parsed.args.ftot) / 1e18;
        const net = lt + ftot;
        console.log(`\n=== Market #43 Results ===`);
        console.log(`Settlement: $10.35 (9 bins above center $9.89)`);
        console.log(`Positions: bell-shaped around $9.55 (ALL losers)`);
        console.log(`CLMSR P&L (Lt): ${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}`);
        console.log(`Fees (Ftot): $${ftot.toFixed(2)}`);
        console.log(`Net vault: ${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
        console.log(`\nComparison (all σ=8, α=100, 200bps):`);
        console.log(`#42 (spread positions, settle $9.55 2σ):  Net=+$1,417.97`);
        console.log(`#43 (win-bell positions, settle $10.35):  Net=${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
      }
    } catch {}
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
