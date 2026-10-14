// Post-settlement analysis: market 4 outcome + LP / treasury / backstop state.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const fmt = (x: bigint, d = 18) => Number(ethers.formatUnits(x, d));
  const id = BigInt(process.env.MARKET_ID ?? "4");

  const m = await core.markets(id);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing);
  const sBin = (Number(m.settlementTick) - minTick) / sp;
  const prem = fmt(m.accumulatedPremiums), proc = fmt(m.accumulatedProceeds), fees = fmt(m.accumulatedFees);
  console.log(`================ MARKET ${id} ================`);
  console.log(`settled=${m.settled} settleTick=${Number(m.settlementTick)} ($${(Number(m.settlementTick)/100).toFixed(2)}) bin=${sBin}  positions=${m.openPositionCount}`);
  console.log(`premiums collected : $${prem.toFixed(2)}`);
  console.log(`proceeds (sells)   : $${proc.toFixed(2)}`);
  console.log(`fees               : $${fees.toFixed(2)}`);

  // batch P&L
  const period = Number(await core.batchSeconds()) || 86400;
  const batchId = Math.floor((Number(m.settlementTimestamp) - 28800) / period);
  try {
    const dp = await core.getDailyPnl(batchId);
    console.log(`\nbatch ${batchId} daily P&L: L_t=$${fmt(dp[0]).toFixed(2)}  fees=$${fmt(dp[1]).toFixed(2)}`);
  } catch (e: any) { console.log(`\nbatch ${batchId} P&L read failed: ${(e.shortMessage||e.message||"").slice(0,40)}`); }

  // capital stack
  const nav = fmt(await core.getVaultNav());
  const cap = await core.getCapitalStack();
  console.log(`\n================ CAPITAL STACK (now) ================`);
  console.log(`LP NAV (vault)  : $${nav.toFixed(2)}`);
  console.log(`Backstop        : $${fmt(cap[0]).toFixed(2)}`);
  console.log(`Treasury (team) : $${fmt(cap[1]).toFixed(2)}`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
