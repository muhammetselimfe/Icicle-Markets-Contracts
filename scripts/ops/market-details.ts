import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  console.log("Market | α    | Volume  | Bins | SettleTick | SettlePrice | Center | Dist");
  console.log("-------|------|---------|------|------------|-------------|--------|-----");

  for (const id of [35, 36, 37, 38, 39, 40, 41]) {
    const m = await core.markets(BigInt(id));
    const alpha = Number(m.liquidityParameter) / 1e18;
    const numBins = Number(m.numBins);
    const minTick = Number(m.minTick);
    const spacing = Number(m.tickSpacing);
    const settleTick = Number(m.settlementTick);
    const centerTick = minTick + Math.floor(numBins / 2) * spacing;
    const distBins = Math.abs(settleTick - centerTick) / spacing;
    
    // Max vault loss = α × ln(numBins)
    
    console.log(
      `#${id}    | ${alpha.toFixed(0).padStart(4)} | —       | ${numBins.toString().padStart(4)} | ${settleTick.toString().padStart(10)} | $${(settleTick/100).toFixed(2).padStart(8)} | $${(centerTick/100).toFixed(2)} | ${distBins.toFixed(0)} bins`
    );
  }

  // Batch 20527 totals
  const r = await core.getDailyPnl.staticCall(20527n);
  const lt = Number(r[0]) / 1e18;
  const ft = Number(r[1]) / 1e18;
  
  console.log(`\nBatch 20527 totals: Lt=$${lt.toFixed(2)}, Ft=$${ft.toFixed(2)}`);
  console.log(`\nα=100 markets (#35-40): 6 markets, max loss each = 100 × ln(80) = $${(100*Math.log(80)).toFixed(0)}`);
  console.log(`α=100 combined max loss = $${(6*100*Math.log(80)).toFixed(0)}`);
  console.log(`α=1000 market (#41): max loss = 1000 × ln(80) = $${(1000*Math.log(80)).toFixed(0)}`);
  console.log(`\nTotal max possible loss = $${(6*100*Math.log(80) + 1000*Math.log(80)).toFixed(0)}`);
  console.log(`Actual Lt = +$${lt.toFixed(2)} (vault GAINED, not lost)`);
  console.log(`\nψ_fee for batch 20527:`);
  if (lt < 0) {
    console.log(`  ψ_fee = ${ft / Math.abs(lt)}`);
  } else {
    console.log(`  ψ_fee = ∞ (no losses — vault profited from CLMSR)`);
    console.log(`  Vault earned $${lt.toFixed(2)} from CLMSR + $${ft.toFixed(2)} fees = $${(lt+ft).toFixed(2)} total`);
  }
}
main();
