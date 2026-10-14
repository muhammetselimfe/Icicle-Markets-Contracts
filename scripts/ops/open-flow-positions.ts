// Drive MIXED flow into a live dynamic market to test LP profitability:
//   - noise traders: random bins around the oracle (wide), random sizes, some multi-bin ranges
//   - informed traders: at/adjacent to the oracle bin, larger sizes
// Env: MARKET_ID (required) N_NOISE=16 N_INFORMED=3 SEED=7 NOISE_SIGMA_BINS=10
// Run: MARKET_ID=7 npx hardhat run scripts/ops/open-flow-positions.ts --network fuji
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r: () => number) { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const [trader] = await ethers.getSigners();
  const marketId = BigInt(process.env.MARKET_ID!);
  const nNoise = Number(process.env.N_NOISE ?? 16), nInformed = Number(process.env.N_INFORMED ?? 3);
  const noiseSigma = Number(process.env.NOISE_SIGMA_BINS ?? 10);
  const r = rng(Number(process.env.SEED ?? 7));

  const m = await core.markets(marketId);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing), numBins = Number(m.numBins);
  const oBin = Math.floor((Number(m.cachedOracleTick) - minTick) / sp);
  const clampBin = (b: number) => Math.max(0, Math.min(numBins - 1, Math.round(b)));
  console.log(`market ${marketId}: oracle $${(Number(m.cachedOracleTick)/100).toFixed(2)} bin=${oBin} (cached ${new Date(Number(m.cachedOracleTs)*1000).toISOString()})`);

  const dec = Number(await token.decimals());
  const bal = await token.balanceOf(trader.address);
  if (bal < 10000n * 10n ** BigInt(dec)) { await (await token.mint(trader.address, 100000n * 10n ** BigInt(dec))).wait(); console.log("minted 100000 test USD"); }
  if ((await token.allowance(trader.address, await core.getAddress())) < bal) await (await token.approve(await core.getAddress(), ethers.MaxUint256)).wait();

  type Order = { kind: string; loBin: number; hiBin: number; units: number };
  const orders: Order[] = [];
  for (let i = 0; i < nNoise; i++) {
    const c = clampBin(oBin + gauss(r) * noiseSigma);
    const width = r() < 0.7 ? 1 : 1 + Math.floor(r() * 4);          // 70% single-bin, else 2-4 bins
    const lo = clampBin(c - Math.floor(width / 2)), hi = clampBin(lo + width - 1);
    orders.push({ kind: "noise", loBin: lo, hiBin: hi, units: 5 + Math.floor(r() * 36) }); // 5-40 units
  }
  for (let i = 0; i < nInformed; i++) {
    const c = clampBin(oBin + Math.round(gauss(r) * 0.6));              // at/adjacent to oracle
    orders.push({ kind: "informed", loBin: c, hiBin: c, units: 20 + Math.floor(r() * 21) }); // 20-40 units
  }
  // interleave so informed flow arrives throughout, not all at the end
  orders.sort(() => r() - 0.5);

  console.log(`\n#   kind      range              units   cost      $/unit`);
  let totalCost = 0, n = 0;
  for (const o of orders) {
    const lo = minTick + o.loBin * sp, hi = minTick + (o.hiBin + 1) * sp;
    const q = BigInt(o.units) * 1_000_000n;
    let cost: bigint;
    try { cost = await core.calculateOpenCost.staticCall(marketId, lo, hi, q); }
    catch (e: any) { console.log(`--  ${o.kind.padEnd(8)} quote failed: ${(e.shortMessage || e.message).slice(0, 60)}`); continue; }
    const maxCost = cost + cost / 2n + 2_000_000n;
    // retry: the keeper shares this signer, so nonce races happen
    let ok = false, lastErr = "";
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        await (await core.connect(trader).openPosition(marketId, lo, hi, q, maxCost, { gasLimit: 12_000_000 })).wait();
        ok = true;
      } catch (e: any) { lastErr = (e.shortMessage || e.message).slice(0, 60); await new Promise((r) => setTimeout(r, 3000)); }
    }
    if (ok) {
      n++; totalCost += Number(cost) / 1e6;
      console.log(`${String(n).padStart(2)}  ${o.kind.padEnd(8)}  $${(lo/100).toFixed(2)}-$${(hi/100).toFixed(2)}   ${String(o.units).padStart(4)}   ${(Number(cost)/1e6).toFixed(4).padStart(8)}  ${(Number(cost)/1e6/o.units).toFixed(4)}`);
    } else console.log(`--  ${o.kind.padEnd(8)} open failed: ${lastErr}`);
  }
  const m2 = await core.markets(marketId);
  console.log(`\nopened ${n}/${orders.length} positions, total premium paid $${totalCost.toFixed(2)}`);
  console.log(`market: openPositions=${m2.openPositionCount} accumulatedPremiums=$${Number(ethers.formatUnits(m2.accumulatedPremiums,18)).toFixed(4)} fees=$${Number(ethers.formatUnits(m2.accumulatedFees,18)).toFixed(4)}`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
