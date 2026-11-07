import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const nextId = Number(await core.nextMarketId());
  console.log(`Total markets: ${nextId - 1}\n`);

  for (let id = 1; id < nextId; id++) {
    try {
      const m = await core.markets(BigInt(id));
      if (m.numBins === 0n) { console.log(`#${id}: empty/invalid\n`); continue; }

      const alpha = Number(m.liquidityParameter) / 1e18;
      const numBins = Number(m.numBins);
      const minTick = Number(m.minTick);
      const maxTick = Number(m.maxTick);
      const spacing = Number(m.tickSpacing);
      const settled = m.settled;
      const settleTick = Number(m.settlementTick);
      const startTs = Number(m.startTimestamp);
      const endTs = Number(m.endTimestamp);
      const feePolicy = m.feePolicy as string;
      const duration = (endTs - startTs) / 60;
      const centerTick = minTick + Math.floor(numBins / 2) * spacing;

      // Determine fee rate from known addresses
      const fpLower = feePolicy.toLowerCase();
      let feeLabel = feePolicy.slice(0,6) + "..." + feePolicy.slice(-4);
      if (fpLower.includes("b472")) feeLabel = "0bps";
      else if (fpLower.includes("16e8")) feeLabel = "10bps";
      else if (fpLower.includes("8129")) feeLabel = "50bps";
      else if (fpLower.includes("61a8")) feeLabel = "100bps";
      else if (fpLower.includes("38fe")) feeLabel = "200bps";

      // Determine tick unit (cents vs dollars)
      const isCents = spacing < 10;
      const d = isCents ? 100 : 1;
      const unit = isCents ? "cents" : "dollars";

      const maxLoss = alpha * Math.log(numBins);

      const startDate = new Date(startTs * 1000).toISOString();
      const endDate = new Date(endTs * 1000).toISOString();

      let settleInfo = "";
      if (settled) {
        const distBins = Math.abs(settleTick - centerTick) / spacing;
        settleInfo = `SETTLED at tick ${settleTick} ($${(settleTick/d).toFixed(2)}), ${distBins} bins from center`;
      } else {
        const now = Math.floor(Date.now() / 1000);
        if (now < startTs) settleInfo = "NOT STARTED";
        else if (now < endTs) settleInfo = "ACTIVE (trading open)";
        else settleInfo = "EXPIRED (unsettled)";
      }

      console.log(`=== Market #${id} ===`);
      console.log(`  Status:    ${settleInfo}`);
      console.log(`  Range:     $${(minTick/d).toFixed(2)} – $${(maxTick/d).toFixed(2)} (ticks ${minTick}–${maxTick}, ${unit})`);
      console.log(`  Bins:      ${numBins}, spacing=${spacing} ($${(spacing/d).toFixed(2)} per bin)`);
      console.log(`  Center:    $${(centerTick/d).toFixed(2)} (tick ${centerTick})`);
      console.log(`  Alpha:     ${alpha} (max vault loss: $${maxLoss.toFixed(0)})`);
      console.log(`  Fee:       ${feeLabel}`);
      console.log(`  Duration:  ${duration.toFixed(0)} min`);
      console.log(`  Start:     ${startDate}`);
      console.log(`  End:       ${endDate}`);
      console.log(``);
    } catch(e: any) {
      console.log(`#${id}: error - ${e.message?.slice(0,80)}\n`);
    }
  }
}
main();
