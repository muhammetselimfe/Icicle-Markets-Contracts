import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const nextId = Number(await core.nextMarketId());
  console.log(`nextMarketId: ${nextId}`);

  // Check markets 49, 50, 51
  for (let id = 49; id <= nextId; id++) {
    try {
      const m = await core.markets(BigInt(id));
      console.log(`\nMarket #${id}: seeded=${m.isSeeded}, settled=${m.settled}, numBins=${m.numBins}, alpha=${Number(m.liquidityParameter)/1e18}`);
      if (!m.isSeeded && Number(m.numBins) > 0) {
        console.log(`  Seeding market #${id}...`);
        let remaining = Number(m.numBins);
        while (remaining > 0) {
          const count = Math.min(remaining, 50);
          await (await core.seedNextChunks(id, count)).wait();
          remaining -= count;
          console.log(`  Seeded chunk, ${remaining} remaining`);
        }
        console.log(`  Market #${id} seeded!`);
      }
    } catch (e: any) {
      console.log(`Market #${id}: ${e.message?.slice(0, 80)}`);
    }
  }
}
main().catch(console.error);
