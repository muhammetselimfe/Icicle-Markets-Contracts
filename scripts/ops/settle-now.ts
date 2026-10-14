import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const res = await fetch("https://api.redstone.finance/prices?symbol=AVAX&provider=redstone&limit=1");
  const data = await res.json() as any[];
  const livePrice = data[0]?.value;
  const tick = Math.round(livePrice * 100);
  const settlementValue = BigInt(tick) * 1_000_000n;
  console.log(`AVAX: $${livePrice?.toFixed(4)}, tick=${tick}\n`);

  for (const id of [50, 51]) {
    try {
      const m = await core.markets(BigInt(id));
      if (Number(m.numBins) <= 1) { console.log(`#${id}: skip (dummy)`); continue; }
      if (m.settled) { console.log(`#${id}: already settled`); continue; }

      console.log(`#${id}: settling...`);
      await (await core.markSettlementFailed(BigInt(id))).wait();
      console.log(`  markSettlementFailed OK`);
      await (await core.finalizeSecondarySettlement(BigInt(id), settlementValue)).wait();
      console.log(`  finalizeSecondarySettlement OK`);
      await (await core.requestSettlementChunks(BigInt(id), 25)).wait();
      console.log(`  requestSettlementChunks OK`);

      const s = await core.markets(BigInt(id));
      console.log(`  settled=${s.settled}, tick=${Number(s.settlementTick)}`);
    } catch (e: any) {
      console.log(`#${id} error: ${e.message?.slice(0, 120)}`);
    }
  }
}
main().catch(console.error);
