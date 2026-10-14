// Open realistic, meaningfully-sized test positions on a live dynamic market.
// Varied sizes (hundreds–thousands of units) across a spread of bins so the
// frontend shows real dollar bets, not cent-sized dust.
// Run: MARKET_ID=4 npx hardhat run scripts/ops/open-real-positions.ts --network fuji
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const position = await ethers.getContractAt("IcicleOptionsPosition", env.contracts.IcicleOptionsPositionProxy);
  const [d] = await ethers.getSigners();
  const id = BigInt(process.env.MARKET_ID ?? "4");

  const m = await core.markets(id);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing), nb = Number(m.numBins);
  const oBin = Math.floor((Number(m.cachedOracleTick) - minTick) / sp);
  console.log(`market ${id}: oracleTick=${Number(m.cachedOracleTick)} ($${(Number(m.cachedOracleTick)/100).toFixed(2)}) oracleBin=${oBin} cap=${Number(m.perBinCap)/1e6}u`);

  const dec = Number(await token.decimals());
  await (await token.mint(d.address, 1_000_000n * 10n ** BigInt(dec))).wait();
  await (await token.approve(await core.getAddress(), ethers.MaxUint256)).wait();

  // realistic spread: [loBinOffset, hiBinOffset, units]
  const orders: [number, number, number][] = [
    [0, 1, 2000],     // at-money 2-bin band, big
    [-1, 1, 1200],    // straddle
    [2, 4, 800],      // upside tilt
    [-4, -2, 600],    // downside tilt
    [-1, 0, 1500],    // at-money
    [3, 6, 400],      // far upside, small
  ];
  console.log("\n band               units    cost        $/unit   positionId");
  let tot = 0;
  for (const [lo0, hi0, units] of orders) {
    const loB = Math.max(0, oBin + lo0), hiB = Math.min(nb - 1, oBin + hi0);
    const lo = minTick + loB * sp, hi = minTick + (hiB + 1) * sp, q = BigInt(units) * 1_000_000n;
    try {
      const c = await core.calculateOpenCost.staticCall(id, lo, hi, q);
      await (await core.connect(d).openPosition(id, lo, hi, q, c * 2n + 5_000_000n, { gasLimit: 14_000_000 })).wait();
      const ids = await position.getPositionsByOwner(d.address);
      const pid = ids[ids.length - 1];
      tot += Number(c) / 1e6;
      console.log(`[${String(loB).padStart(2)}-${String(hiB).padStart(2)}] $${(lo/100).toFixed(2)}-$${(hi/100).toFixed(2)}  ${String(units).padStart(6)}  ${("$"+(Number(c)/1e6).toFixed(2)).padStart(10)}  ${(Number(c)/1e6/units).toFixed(3)}    #${pid}`);
    } catch (e: any) {
      console.log(`[${String(loB).padStart(2)}-${String(hiB).padStart(2)}]  rejected: ${(e.shortMessage||e.message||"").slice(0,45)}`);
    }
  }
  const m2 = await core.markets(id);
  console.log(`\ntotal premium paid : $${tot.toFixed(2)}  openPositions=${m2.openPositionCount}`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
