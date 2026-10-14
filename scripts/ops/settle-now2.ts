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
  const sv = BigInt(tick) * 1_000_000n;
  console.log(`AVAX: $${livePrice?.toFixed(4)}, tick=${tick}\n`);

  for (const id of [51, 50]) {
    try {
      const m = await core.markets(BigInt(id));
      if (Number(m.numBins) <= 1 || m.settled) { console.log(`#${id}: skip (settled=${m.settled}, bins=${m.numBins})`); continue; }

      console.log(`#${id}: step 1 — markSettlementFailed`);
      const tx1 = await core.markSettlementFailed(BigInt(id));
      await tx1.wait();
      console.log(`  done`);

      console.log(`#${id}: step 2 — finalizeSecondarySettlement (tick=${tick})`);
      const tx2 = await core.finalizeSecondarySettlement(BigInt(id), sv);
      await tx2.wait();
      console.log(`  done`);

      console.log(`#${id}: step 3 — requestSettlementChunks`);
      const tx3 = await core.requestSettlementChunks(BigInt(id), 25);
      await tx3.wait();
      console.log(`  done`);

      const s = await core.markets(BigInt(id));
      console.log(`#${id}: settled=${s.settled}, settleTick=${Number(s.settlementTick)}\n`);
    } catch (e: any) {
      console.log(`#${id} error: ${e.message?.slice(0, 150)}\n`);
    }
  }
}
main().catch(console.error);
