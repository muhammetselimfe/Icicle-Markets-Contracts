// Adversarial LP stress on a LIVE dynamic market: stack HUGE positions on the
// highest-probability bins (at/near the live oracle price) to try to make the LP lose.
// If AVAX holds near the anchor through settlement, these win big and the LP pays out.
//
// Run: MARKET_ID=2 STACK_UNITS=8000 npx hardhat run scripts/ops/stress-lp-live.ts --network fuji
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const [d] = await ethers.getSigners();
  const id = BigInt(process.env.MARKET_ID ?? "2");
  const stack = BigInt(process.env.STACK_UNITS ?? "8000"); // units per buy (6-dec)

  const m = await core.markets(id);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing), nb = Number(m.numBins);
  const oBin = Math.floor((Number(m.cachedOracleTick) - minTick) / sp);
  console.log(`market ${id}: oracleTick=${Number(m.cachedOracleTick)} ($${(Number(m.cachedOracleTick)/100).toFixed(2)}) oracleBin=${oBin} cap=${Number(m.perBinCap)/1e6}u`);

  // fund big
  const dec = Number(await token.decimals());
  await (await token.mint(d.address, 5_000_000n * 10n ** BigInt(dec))).wait();
  await (await token.approve(await core.getAddress(), ethers.MaxUint256)).wait();

  // wait for trading to open
  let now = (await ethers.provider.getBlock("latest"))!.timestamp;
  if (now < Number(m.startTimestamp)) { await new Promise((r) => setTimeout(r, (Number(m.startTimestamp) - now + 3) * 1000)); }

  // attack: pile size onto the at-money band [oBin-2 .. oBin+2] in repeated buys until the
  // per-bin cap rejects further size. Concentrated on the most-likely-to-win bins.
  const bands = [[oBin, oBin], [oBin - 1, oBin + 1], [oBin - 2, oBin + 2], [oBin, oBin], [oBin - 1, oBin + 1]];
  let totCost = 0, filled = 0, capHits = 0;
  console.log("\nattempt  band            units    cost        result");
  for (let i = 0; i < bands.length; i++) {
    const loB = Math.max(0, bands[i][0]), hiB = Math.min(nb - 1, bands[i][1]);
    const lo = minTick + loB * sp, hi = minTick + (hiB + 1) * sp, q = stack * 1_000_000n;
    try {
      const c = await core.calculateOpenCost.staticCall(id, lo, hi, q);
      await (await core.connect(d).openPosition(id, lo, hi, q, c * 2n + 5_000_000n, { gasLimit: 14_000_000 })).wait();
      totCost += Number(c) / 1e6; filled++;
      console.log(`${String(i + 1).padStart(7)}  [${String(loB).padStart(2)}-${String(hiB).padStart(2)}] $${(lo/100).toFixed(2)}-$${(hi/100).toFixed(2)}  ${String(stack).padStart(6)}  ${("$" + (Number(c)/1e6).toFixed(2)).padStart(10)}  FILLED`);
    } catch (e: any) {
      capHits++;
      const msg = (e.shortMessage || e.message || "").slice(0, 40);
      console.log(`${String(i + 1).padStart(7)}  [${String(loB).padStart(2)}-${String(hiB).padStart(2)}] $${(lo/100).toFixed(2)}-$${(hi/100).toFixed(2)}  ${String(stack).padStart(6)}  ${"reject".padStart(10)}  ${msg}`);
    }
  }

  const m2 = await core.markets(id);
  const prem = Number(ethers.formatUnits(m2.accumulatedPremiums, 18));
  console.log(`\n${filled}/${bands.length} buys filled (${capHits} rejected by per-bin cap)`);
  console.log(`total premium paid into LP : $${totCost.toFixed(2)}`);
  console.log(`market accumulatedPremiums : $${prem.toFixed(2)}  openPositions=${m2.openPositionCount}`);
  console.log(`\nLP downside if AVAX settles in [${oBin-2}-${oBin+2}]: capped at perBinCap*payout per bin.`);
  console.log(`If AVAX MOVES away from $${(Number(m.cachedOracleTick)/100).toFixed(2)}, these positions lose and the LP keeps $${totCost.toFixed(2)}.`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
