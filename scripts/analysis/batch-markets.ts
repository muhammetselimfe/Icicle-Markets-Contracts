// Realistic batch of markets (local EVM, real v2 contracts, time fast-forwarded).
// Shows what LP / backstop / treasury(team) earn over many markets with the 70/20/10
// fee waterfall. Traders bet near the money; settlement follows a realistic price walk.
//
// Run: npx hardhat run scripts/analysis/batch-markets.ts
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../test/helpers/fullSystem";
import { deploySeedData } from "../../test/helpers";
import { uniformFactors, toBatchId, batchStartTimestamp, advancePastBatchEnd } from "../../test/helpers/constants";
import { authorisedWallets, buildRedstonePayload, submitWithPayload } from "../../test/helpers/redstone";

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const MIN = 700, MAX = 1100, SP = 5, N = 80, ANCHOR = 40;     // $7–$11, anchor $9
const ALPHA = ethers.parseEther("1500");
const FEE_BPS = 100;
const N_MARKETS = Number(process.env.N_MARKETS ?? 50);
const SETTLE_STD = 8;        // terminal price dispersion (bins) — matches the bell
const REFRESH = new ethers.Interface(["function refreshTradeOracle(uint256 marketId)"]);
const DP = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: 50000n * 1_000_000n, anchorCenterBin: ANCHOR };
const f = (x: bigint) => Number(ethers.formatUnits(x, 18));

function mulberry32(s: number) { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r: () => number) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const clamp = (b: number) => Math.max(0, Math.min(N - 1, b));

async function main() {
  const rng = mulberry32(424242);
  // 70/20/10 waterfall, backstop coverage target 20%, lambda 0.3
  const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5, phiLP: wad(0.7), phiBS: wad(0.2), phiTR: wad(0.1), rhoBS: wad(0.2), lambda: wad(0.3) });
  const { owner, users, core, payment } = sys;
  const coreAddr = await core.getAddress();
  const fee = await (await ethers.getContractFactory("MockFeePolicy")).deploy(FEE_BPS);
  const feeAddr = await fee.getAddress();

  const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
  await payment.connect(owner).approve(coreAddr, ethers.MaxUint256);
  await time.setNextBlockTimestamp(Number(seedTime));
  await core.connect(owner).seedVault(1_000_000_000_000n); // 1,000,000 vault
  await core.connect(owner).fundBackstop(200_000_000_000n); // 200,000 backstop
  for (const t of users) { await payment.transfer(t.address, 100_000_000_000_000n); await payment.connect(t).approve(coreAddr, ethers.MaxUint256); }

  const cap0 = await core.getCapitalStack();
  const nav0 = f(await core.getVaultNav.staticCall());
  console.log(`start: LP NAV $${nav0.toFixed(0)}  backstop $${f(cap0[0]).toFixed(0)}  treasury $${f(cap0[1]).toFixed(0)}`);
  console.log(`config: alpha=${f(ALPHA)} fee=${FEE_BPS}bps split 70/20/10  markets=${N_MARKETS}\n`);

  const refresh = async (id: bigint, hp: number) => { const ts = await time.latest(); const pl = buildRedstonePayload(hp, ts - 1, authorisedWallets); await owner.sendTransaction({ to: coreAddr, data: REFRESH.encodeFunctionData("refreshTradeOracle", [id]) + pl.replace(/^0x/, "") }); };
  const buy = async (who: any, id: bigint, loB: number, hiB: number, units: number) => {
    const lo = MIN + loB * SP, hi = MIN + (hiB + 1) * SP, q = BigInt(units) * 1_000_000n;
    try { const c = await core.calculateOpenCost.staticCall(id, lo, hi, q); await core.connect(who).openPosition(id, lo, hi, q, c * 2n + 5_000_000n, { gasLimit: 14_000_000 }); return Number(c) / 1e6; } catch { return 0; }
  };

  let totFees = 0, totVol = 0, lpBet = 0;
  console.log("mkt   volume   fees    settleBin  LP NAV       backstop     treasury");
  for (let i = 0; i < N_MARKETS; i++) {
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    const id: bigint = await core.createMarketDynamic.staticCall(...args, DP);
    await core.createMarketDynamic(...args, DP);
    while (!(await core.markets(id)).isSeeded) await core.seedNextChunks(id, 50);

    await time.increaseTo(Number(start) + 50);
    await refresh(id, MIN + ANCHOR * SP);
    // realistic flow: 12-20 traders bet near the money, mixed range widths + sizes
    const nT = 12 + Math.floor(rng() * 9);
    let vol = 0;
    for (let k = 0; k < nT; k++) {
      const center = clamp(ANCHOR + Math.round(gauss(rng) * 4));
      const width = 1 + Math.floor(rng() * 5);
      const loB = clamp(center - (width >> 1)), hiB = clamp(loB + width - 1);
      const units = 20 + Math.floor(rng() * 230);   // ~$ exposure spread
      vol += await buy(users[k % users.length], id, loB, hiB, units);
    }

    // settlement: realistic price walk from the anchor
    const winBin = clamp(ANCHOR + Math.round(gauss(rng) * SETTLE_STD));
    await time.setNextBlockTimestamp(Number(tSet + 2n));
    await submitWithPayload(core, owner, id, buildRedstonePayload(MIN + winBin * SP, Number(tSet + 1n), authorisedWallets));
    await time.setNextBlockTimestamp(Number(tSet + 12n));
    await core.connect(owner).finalizePrimarySettlement(id);
    const batchId = toBatchId(tSet);
    await advancePastBatchEnd(batchId);
    await core.processDailyBatch(batchId);

    const dp = await core.getDailyPnl.staticCall(batchId);
    const ftot = f(dp[1]); const lt = f(dp[0]);
    totFees += ftot; totVol += vol; lpBet += lt;
    if (i % 10 === 0 || i === N_MARKETS - 1) {
      const cap = await core.getCapitalStack();
      console.log(`${String(i).padStart(3)}  ${vol.toFixed(0).padStart(7)}  ${ftot.toFixed(2).padStart(6)}  ${String(winBin).padStart(7)}    ${f(await core.getVaultNav.staticCall()).toFixed(2).padStart(10)}  ${f(cap[0]).toFixed(2).padStart(10)}  ${f(cap[1]).toFixed(2).padStart(9)}`);
    }
  }

  const capF = await core.getCapitalStack();
  const navF = f(await core.getVaultNav.staticCall());
  console.log(`\n================ ${N_MARKETS}-MARKET SUMMARY ================`);
  console.log(`total premium volume : $${totVol.toFixed(0)}`);
  console.log(`total fees generated : $${totFees.toFixed(2)}  (100bps of volume)`);
  console.log(`LP bet P&L (variance): $${lpBet.toFixed(2)}  (fair pricing -> ~0 over many markets)`);
  console.log(`\n           start        end          earned`);
  console.log(`LP NAV     $${nav0.toFixed(0).padEnd(10)} $${navF.toFixed(2).padEnd(11)} ${(navF - nav0 >= 0 ? "+" : "")}$${(navF - nav0).toFixed(2)}`);
  console.log(`Backstop   $${f(cap0[0]).toFixed(0).padEnd(10)} $${f(capF[0]).toFixed(2).padEnd(11)} +$${(f(capF[0]) - f(cap0[0])).toFixed(2)}`);
  console.log(`Treasury   $${f(cap0[1]).toFixed(0).padEnd(10)} $${f(capF[1]).toFixed(2).padEnd(11)} +$${(f(capF[1]) - f(cap0[1])).toFixed(2)}  <- team`);
  console.log(`\nper market: ${(totFees / N_MARKETS).toFixed(2)} fees -> LP ${(0.7 * totFees / N_MARKETS).toFixed(2)} / backstop ${(0.2 * totFees / N_MARKETS).toFixed(2)} / treasury ${(0.1 * totFees / N_MARKETS).toFixed(2)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
