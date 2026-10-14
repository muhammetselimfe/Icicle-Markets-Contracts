// A/B test: STATIC vs DYNAMIC pricing on the REAL v2 contracts (in-process EVM).
// Same trader flow and price paths for both, so the only difference is the pricing
// engine. Trades act on the OBSERVABLE oracle price (refreshed each step for dynamic)
// — not secret foreknowledge of settlement — so dynamic pricing can actually defend.
//
// Trending random-walk price; informed buys the current oracle bin each step; noise
// random. Settlement = final price. Measures realized psi = fees/losses + NAV/market.
//
// Run: npx hardhat run scripts/analysis/v2-ab-test.ts
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../test/helpers/fullSystem";
import { deploySeedData } from "../../test/helpers";
import { uniformFactors, toBatchId, batchStartTimestamp, advancePastBatchEnd } from "../../test/helpers/constants";
import { authorisedWallets, buildRedstonePayload } from "../../test/helpers/redstone";

const N_MARKETS = Number(process.env.N_MARKETS ?? 8);
const MIN_TICK = 700, MAX_TICK = 1100, SPACING = 5, NUM_BINS = 80, ANCHOR_BIN = 40;
const ALPHA = ethers.parseEther("10");
const SEED_USDC = 10_000_000_000n;     // 10000 USDC
const FEE_BPS = 100;
const STEPS = 6, Q_INFORMED = 30, Q_NOISE = 5, DRIFT_BINS = 2.2; // per-step trend
const WAD = 10n ** 18n;
const wadF = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const f6 = (x: bigint) => Number(ethers.formatUnits(x, 18));
const clampBin = (b: number) => Math.max(0, Math.min(NUM_BINS - 1, b));
const binTicks = (b: number) => [MIN_TICK + b * SPACING, MIN_TICK + (b + 1) * SPACING];

function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(rng: () => number) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const REFRESH_IFACE = new ethers.Interface(["function refreshTradeOracle(uint256 marketId)"]);

// pre-generate price paths (bins per step) so STATIC and DYNAMIC see identical flow
function makePaths(seed: number) {
  const rng = mulberry32(seed);
  const paths: { bins: number[]; settle: number; noiseBins: number[] }[] = [];
  for (let m = 0; m < N_MARKETS; m++) {
    const dir = rng() < 0.5 ? -1 : 1;
    let b = ANCHOR_BIN; const bins: number[] = [];
    for (let s = 0; s < STEPS; s++) { b = clampBin(Math.round(b + dir * DRIFT_BINS + gauss(rng) * 1.5)); bins.push(b); }
    const settle = bins[bins.length - 1];
    const noiseBins = Array.from({ length: STEPS }, () => Math.floor(rng() * NUM_BINS));
    paths.push({ bins, settle, noiseBins });
  }
  return paths;
}

async function main() {
  const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
  const { owner, users, core, payment } = sys;
  const coreAddr = await core.getAddress();
  const feePolicy = await (await ethers.getContractFactory("MockFeePolicy")).deploy(FEE_BPS);
  const feeAddr = await feePolicy.getAddress();

  const latest = BigInt(await time.latest());
  const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;
  await payment.connect(owner).approve(coreAddr, ethers.MaxUint256);
  await time.setNextBlockTimestamp(Number(seedTime));
  await core.connect(owner).seedVault(SEED_USDC);
  const traders = users.slice(0, 4);
  for (const t of traders) { await payment.transfer(t.address, 200_000_000_000n); await payment.connect(t).approve(coreAddr, ethers.MaxUint256); }

  // v2.1: σ calibrated to the sim's 600 s market (8 bins is the 24h value and was 12x too wide here);
  // floorWad is the tail-mass budget τ; cap sized to the 10k vault.
  const VOL_BINS = 0.045 * Math.sqrt(600 / 86400) * (MIN_TICK + ANCHOR_BIN * SPACING) / SPACING; // ≈ 0.68 bins
  const dp = { w: WAD, volBinsWad: wadF(VOL_BINS), sigmaMinWad: wadF(0.75), sigmaMaxWad: wadF(Math.max(VOL_BINS, 0.75)), floorWad: wadF(0.03), perBinCap: 300n * 1_000_000n, anchorCenterBin: ANCHOR_BIN };

  async function refreshOracle(marketId: bigint, bin: number, atTs: number) {
    const humanPrice = MIN_TICK + bin * SPACING; // feed BTC dec8 -> /100 -> *1e6 ; humanPrice == tick
    const payload = buildRedstonePayload(humanPrice, atTs - 1, authorisedWallets);
    const base = REFRESH_IFACE.encodeFunctionData("refreshTradeOracle", [marketId]);
    await owner.sendTransaction({ to: coreAddr, data: base + payload.replace(/^0x/, "") });
  }

  async function runMode(dynamic: boolean) {
    const paths = makePaths(123456); // identical for both modes
    let sumLoss = 0, sumProfit = 0, sumFees = 0, lossM = 0; const navStart = f6(await core.getVaultNav.staticCall());
    for (let i = 0; i < N_MARKETS; i++) {
      const pointer = Number(await core.getCurrentBatchId());
      const base = batchStartTimestamp(BigInt(pointer) + 1n);
      const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
      const seedData = await deploySeedData(uniformFactors(NUM_BINS));
      const mkArgs = [MIN_TICK, MAX_TICK, SPACING, Number(start), Number(end), Number(tSet), NUM_BINS, ALPHA, feeAddr, await seedData.getAddress()] as const;
      let marketId: bigint;
      if (dynamic) { marketId = await core.createMarketDynamic.staticCall(...mkArgs, dp); await core.createMarketDynamic(...mkArgs, dp); }
      else { marketId = await core.createMarket.staticCall(...mkArgs); await core.createMarket(...mkArgs); }
      while (!(await (core as any).markets(marketId)).isSeeded) await core.seedNextChunks(marketId, 50);

      const { bins, settle, noiseBins } = paths[i];
      const stepDt = Number(end - start) / (STEPS + 1);
      for (let s = 0; s < STEPS; s++) {
        const ts = Number(start) + Math.floor(stepDt * (s + 1));
        await time.increaseTo(ts);
        if (dynamic) await refreshOracle(marketId, bins[s], ts);
        // informed buys the current observable oracle bin
        await tradeBin(marketId, bins[s], Q_INFORMED, traders[0]);
        // noise buys a random bin
        await tradeBin(marketId, noiseBins[s], Q_NOISE, traders[1 + (s % 3)]);
      }

      // settle at final price
      const settleTick = MIN_TICK + settle * SPACING;
      await time.setNextBlockTimestamp(Number(tSet + 2n));
      const { submitWithPayload } = await import("../../test/helpers/redstone");
      const payload = buildRedstonePayload(settleTick, Number(tSet + 1n), authorisedWallets);
      await submitWithPayload(core, owner, marketId, payload);
      await time.setNextBlockTimestamp(Number(tSet + 12n));
      await core.connect(owner).finalizePrimarySettlement(marketId);

      const batchId = toBatchId(tSet);
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);
      const dpnl = await core.getDailyPnl.staticCall(batchId);
      const lt = f6(dpnl[0]), ftot = f6(dpnl[1]);
      sumFees += ftot; if (lt < 0) { sumLoss += -lt; lossM++; } else sumProfit += lt;
    }
    const navEnd = f6(await core.getVaultNav.staticCall());
    return { psi: sumLoss > 0 ? sumFees / sumLoss : Infinity, sumLoss, sumProfit, sumFees, lossM, navDelta: navEnd - navStart };
  }

  async function tradeBin(marketId: bigint, bin: number, qUnits: number, who: any) {
    const [lo, hi] = binTicks(bin);
    const qty = BigInt(qUnits) * 1_000_000n;
    let cost: bigint; try { cost = await core.calculateOpenCost.staticCall(marketId, lo, hi, qty); } catch { return; }
    const maxCost = cost + cost / 2n + 2_000_000n;
    await core.connect(who).openPosition(marketId, lo, hi, qty, maxCost).catch(() => {});
  }

  console.log("=== v2 A/B: STATIC vs DYNAMIC (real contracts, identical flow) ===");
  console.log(`bins=${NUM_BINS} alpha=${f6(ALPHA)} steps=${STEPS} drift=${DRIFT_BINS}bins/step markets=${N_MARKETS}\n`);
  const stat = await runMode(false);
  const dyn = await runMode(true);
  const show = (n: string, r: any) => console.log(
    `${n.padEnd(9)} psi=${(r.psi).toFixed(3).padStart(7)}  grossLoss=${r.sumLoss.toFixed(2).padStart(9)}  grossProfit=${r.sumProfit.toFixed(2).padStart(8)}  fees=${r.sumFees.toFixed(3).padStart(7)}  lossMkts=${r.lossM}/${N_MARKETS}  NAVΔ=${r.navDelta.toFixed(2)}`
  );
  show("STATIC", stat); show("DYNAMIC", dyn);
  console.log(`\nGATE: dynamic psi should be >> static psi (target >= 1). ` +
    `static=${stat.psi.toFixed(3)} dynamic=${dyn.psi.toFixed(3)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
