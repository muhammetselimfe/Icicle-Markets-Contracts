/**
 * Wait for market #42 oracle window to expire, then settle at $9.55 (tick 955, 2σ).
 * Compare σ=8 vs σ=4 at same settlement distance.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const m = await core.markets(42n);
  const end = Number(m.endTimestamp);
  const now = Math.floor(Date.now() / 1000);
  const waitSec = (end + 610) - now; // 600s oracle window + 10s buffer

  if (waitSec > 0) {
    console.log(`Waiting ${waitSec}s for oracle window to expire...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }

  console.log("Settling #42 at tick 955 ($9.55, 2σ)...");

  // markSettlementFailed
  const tx1 = await core.markSettlementFailed(42n);
  await tx1.wait();
  console.log("markSettlementFailed OK");

  // finalizeSecondarySettlement
  const settlementValue = 955n * 1_000_000n;
  const tx2 = await core.finalizeSecondarySettlement(42n, settlementValue);
  await tx2.wait();
  console.log("finalizeSecondarySettlement OK");

  // requestSettlementChunks
  const tx3 = await core.requestSettlementChunks(42n, 25);
  await tx3.wait();
  console.log("requestSettlementChunks OK");

  // Verify
  const settled = await core.markets(42n);
  console.log(`settled=${settled.settled}, settleTick=${Number(settled.settlementTick)}`);

  // Read per-market P&L from MarketPnlRecorded event
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
      if (parsed?.name === "MarketPnlRecorded" && Number(parsed.args.marketId) === 42) {
        const lt = Number(parsed.args.lt) / 1e18;
        const ftot = Number(parsed.args.ftot) / 1e18;
        console.log(`\n=== Market #42 (σ=8) vs #39 (σ=4) — both at $9.55 (2σ) ===`);
        console.log(`#42 (σ=8): Lt=${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}, Fees=$${ftot.toFixed(2)}, Net=${(lt+ftot) >= 0 ? "+" : ""}$${(lt+ftot).toFixed(2)}`);
        console.log(`#39 (σ=4): Lt=+$607.48, Fees=$25.79, Net=+$633.27`);
        console.log(`\nDifference: vault earned $${((lt+ftot) - 633.27).toFixed(2)} ${(lt+ftot) < 633.27 ? "LESS" : "MORE"} with σ=8`);
        if (lt < 0) {
          console.log(`ψ_fee = ${(ftot / Math.abs(lt)).toFixed(4)}`);
        } else {
          console.log(`ψ_fee = ∞ (vault still profited from CLMSR)`);
        }
      }
    } catch {}
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
