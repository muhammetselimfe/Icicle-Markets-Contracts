/**
 * Wait for market #44 oracle window, then settle at $11.00 (tick 1100).
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const m = await core.markets(44n);
  const end = Number(m.endTimestamp);
  const now = Math.floor(Date.now() / 1000);
  const waitSec = (end + 610) - now;

  if (waitSec > 0) {
    console.log(`Waiting ${waitSec}s for oracle window to expire...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }

  const settleTick = 1100; // $11.00
  const settlementValue = BigInt(settleTick) * 1_000_000n;
  console.log(`Settling #44 at tick ${settleTick} ($${(settleTick/100).toFixed(2)})...`);

  const tx1 = await core.markSettlementFailed(44n);
  await tx1.wait();
  console.log("markSettlementFailed OK");

  const tx2 = await core.finalizeSecondarySettlement(44n, settlementValue);
  await tx2.wait();
  console.log("finalizeSecondarySettlement OK");

  const tx3 = await core.requestSettlementChunks(44n, 25);
  await tx3.wait();
  console.log("requestSettlementChunks OK");

  const settled = await core.markets(44n);
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
      if (parsed?.name === "MarketPnlRecorded" && Number(parsed.args.marketId) === 44) {
        const lt = Number(parsed.args.lt) / 1e18;
        const ftot = Number(parsed.args.ftot) / 1e18;
        const net = lt + ftot;
        console.log(`\n=== Market #44 Results (α=1000, σ=8, settled $11.00) ===`);
        console.log(`CLMSR P&L (Lt): ${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}`);
        console.log(`Fees (Ftot): $${ftot.toFixed(2)}`);
        console.log(`Net vault: ${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
        console.log(`Max possible loss was: $4,382`);
        if (lt < 0) {
          console.log(`ψ_fee = ${(ftot / Math.abs(lt)).toFixed(4)}`);
          console.log(`Vault ${net >= 0 ? "SURVIVED" : "LOST"} — fees ${net >= 0 ? "covered" : "didn't cover"} losses`);
        } else {
          console.log(`ψ_fee = ∞ (vault profited)`);
        }
      }
    } catch {}
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
