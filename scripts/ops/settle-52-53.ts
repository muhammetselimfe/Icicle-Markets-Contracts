import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Fetch live AVAX price for settlement
  const res = await fetch("https://api.redstone.finance/prices?symbol=AVAX&provider=redstone&limit=1");
  const data = await res.json() as any[];
  const livePrice = data[0]?.value;
  if (!livePrice) throw new Error("Failed to fetch AVAX price");
  const settlementValue = BigInt(Math.round(livePrice * 100 * 1e6)); // cents * 1e6
  const tick = Number(settlementValue) / 1e6;
  console.log(`AVAX: $${livePrice.toFixed(4)} -> settlementValue=${settlementValue} -> tick=${tick}`);

  for (const id of [52, 53]) {
    console.log(`\n=== Market #${id} ===`);
    const m = await core.markets(BigInt(id));
    console.log(`  settled=${m.settled}, failed=${m.failed}, positions=${m.openPositionCount}`);

    if (m.settled) {
      console.log("  Already settled, skipping.");
      continue;
    }

    // Mark settlement failed (oracle window expired)
    if (!m.failed) {
      try {
        const tx1 = await core.markSettlementFailed(id);
        await tx1.wait();
        console.log("  markSettlementFailed: OK");
      } catch (e: any) {
        console.log(`  markSettlementFailed: ${e.message?.slice(0, 150)}`);
      }
    } else {
      console.log("  Already marked failed.");
    }

    // Finalize with current price
    try {
      const tx2 = await core.finalizeSecondarySettlement(id, settlementValue);
      await tx2.wait();
      console.log(`  finalizeSecondarySettlement(${settlementValue}): OK -> tick=${tick}`);
    } catch (e: any) {
      console.log(`  finalizeSecondarySettlement: ${e.message?.slice(0, 150)}`);
    }

    // Snapshot if positions exist
    const m2 = await core.markets(BigInt(id));
    if (Number(m2.openPositionCount) > 0 && !m2.snapshotChunksDone) {
      try {
        const tx3 = await core.requestSettlementChunks(id, 50);
        await tx3.wait();
        console.log("  requestSettlementChunks: OK");
      } catch (e: any) {
        console.log(`  requestSettlementChunks: ${e.message?.slice(0, 150)}`);
      }
    }

    const mFinal = await core.markets(BigInt(id));
    console.log(`  Final: settled=${mFinal.settled}, tick=${mFinal.settlementTick}`);
  }
}
main().catch(console.error);
