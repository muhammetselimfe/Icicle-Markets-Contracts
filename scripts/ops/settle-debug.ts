import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const now = Math.floor(Date.now() / 1000);

  for (const id of [50, 51]) {
    try {
      const m = await core.markets(BigInt(id));
      if (Number(m.numBins) <= 1) { console.log(`#${id}: dummy market (bins=${m.numBins})\n`); continue; }

      const end = Number(m.endTimestamp);
      const settleTs = Number(m.settlementTimestamp);
      const settled = m.settled;
      const bins = Number(m.numBins);
      const positions = Number(m.openPositionCount);
      const alpha = Number(m.liquidityParameter) / 1e18;

      console.log(`#${id}:`);
      console.log(`  settled=${settled}, bins=${bins}, α=${alpha}, positions=${positions}`);
      console.log(`  end=${new Date(end*1000).toISOString()}`);
      console.log(`  settlementTs=${new Date(settleTs*1000).toISOString()}`);
      console.log(`  oracleWindowEnd=${new Date((settleTs+600)*1000).toISOString()}`);
      console.log(`  pendingOpsEnd=${new Date((settleTs+900)*1000).toISOString()}`);
      console.log(`  now=${new Date(now*1000).toISOString()}`);
      console.log(`  pastOracleWindow=${now > settleTs + 600}`);
      console.log(`  pastPendingOps=${now > settleTs + 900}`);

      // Check settlement state
      console.log(`  settlementTick=${Number(m.settlementTick)}`);

      // Try each step individually with error details
      try {
        await core.markSettlementFailed.staticCall(BigInt(id));
        console.log(`  markSettlementFailed: WOULD SUCCEED`);
      } catch (e: any) {
        const msg = e.message || "";
        // Try to find the error signature
        if (msg.includes("OracleWindowStillOpen")) console.log(`  markSettlementFailed: OracleWindowStillOpen`);
        else if (msg.includes("AlreadySettled")) console.log(`  markSettlementFailed: AlreadySettled`);
        else if (msg.includes("SettlementAlreadyFailed")) console.log(`  markSettlementFailed: SettlementAlreadyFailed`);
        else console.log(`  markSettlementFailed error: ${msg.slice(0, 150)}`);
      }

      try {
        const tick = 951;
        const sv = BigInt(tick) * 1_000_000n;
        await core.finalizeSecondarySettlement.staticCall(BigInt(id), sv);
        console.log(`  finalizeSecondarySettlement: WOULD SUCCEED`);
      } catch (e: any) {
        const msg = e.message || "";
        if (msg.includes("SettlementNotFailed")) console.log(`  finalizeSecondarySettlement: SettlementNotFailed (need markSettlementFailed first)`);
        else if (msg.includes("AlreadySettled")) console.log(`  finalizeSecondarySettlement: AlreadySettled`);
        else console.log(`  finalizeSecondarySettlement error: ${msg.slice(0, 150)}`);
      }

      console.log();
    } catch (e: any) {
      console.log(`#${id}: ${e.message?.slice(0, 100)}\n`);
    }
  }
}
main().catch(console.error);
