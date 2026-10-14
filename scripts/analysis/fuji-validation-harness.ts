// Fuji validation harness (runs on the in-process Hardhat EVM against the REAL
// compiled contracts via deployFullSystem). Drives N markets through the full
// lifecycle with informed + noise flow, then measures realized LP economics the
// same way T1 reads the live chain: getDailyPnl(batchId) -> (lt, ftot) and
// getVaultNav/getVaultPrice.
//
// This is the VALIDATION GATE instrument. Today it runs against the current
// STATIC pricing (reproduces the baseline loss against real bytecode). Once the
// PricingLayer v2 contracts are wired, point it at the dynamic core and require
// realized psi >= 1 over >= 30 markets before mainnet.
//
// Run: npx hardhat run scripts/analysis/fuji-validation-harness.ts
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../test/helpers/fullSystem";
import { deploySeedData } from "../../test/helpers";
import {
  uniformFactors,
  toBatchId,
  batchStartTimestamp,
  advancePastBatchEnd,
} from "../../test/helpers/constants";
import {
  authorisedWallets,
  buildRedstonePayload,
  submitWithPayload,
} from "../../test/helpers/redstone";

// ---- config ----
const N_MARKETS = Number(process.env.N_MARKETS ?? 10);
const DEBUG = process.env.DEBUG === "1";
const MIN_TICK = 700, MAX_TICK = 1100, SPACING = 5;
const NUM_BINS = (MAX_TICK - MIN_TICK) / SPACING; // 80
const ANCHOR_BIN = 40;                            // tick 900
const ALPHA = ethers.parseEther("10");            // maxloss ~ 10*ln80 = 43.8
const SEED_USDC = 10_000_000_000n;                // 10000 USDC -> NAV ~10000 (survives the run)
const FEE_BPS = 100;
const SIGMA_BINS = 8;                             // settlement dispersion
const N_NOISE = 6, Q_NOISE = 5, Q_INFORMED = 60;  // 6-dec units applied below

// deterministic RNG (Date/Math.random discouraged)
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rng: () => number) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const clampBin = (b: number) => Math.max(0, Math.min(NUM_BINS - 1, b));
const binToTicks = (b: number) => [MIN_TICK + b * SPACING, MIN_TICK + (b + 1) * SPACING];
const fmtWad = (x: bigint) => Number(ethers.formatUnits(x, 18));

async function main() {
  const rng = mulberry32(20260623);
  const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
  const { owner, users, core, payment } = sys;
  const coreAddr = await core.getAddress();

  // 100bps fee policy (deployFullSystem's MockFeePolicy is 0bps)
  const feePolicy = await (await ethers.getContractFactory("MockFeePolicy")).deploy(FEE_BPS);
  const feeAddr = await feePolicy.getAddress();

  // seed vault at a clean batch boundary (mirrors VaultWithMarkets timing)
  const latest = BigInt(await time.latest());
  const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;
  await payment.connect(owner).approve(coreAddr, ethers.MaxUint256);
  await time.setNextBlockTimestamp(Number(seedTime));
  await core.connect(owner).seedVault(SEED_USDC);

  // fund traders
  const traders = users.slice(0, 4);
  for (const t of traders) {
    await payment.transfer(t.address, 100_000_000_000n); // 100k USDC
    await payment.connect(t).approve(coreAddr, ethers.MaxUint256);
  }

  console.log("=== FUJI VALIDATION HARNESS (real contracts, static pricing) ===");
  console.log(`bins=${NUM_BINS} alpha=${fmtWad(ALPHA)} maxloss=${(fmtWad(ALPHA) * Math.log(NUM_BINS)).toFixed(1)} fee=${FEE_BPS}bps seedNAV~${Number(SEED_USDC) / 1e6}\n`);
  console.log("mkt  winBin  navBefore  navAfter   L_t       fees     dNAV");

  let sumLt = 0, sumLoss = 0, sumProfit = 0, sumFees = 0, lossM = 0, profitM = 0;
  const navPath: number[] = [];

  for (let i = 0; i < N_MARKETS; i++) {
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n); // start of settlement batch (= pointer+1)
    const tSet = base + 2000n;
    const start = base + 1100n;
    const end = base + 1700n;

    // create market with uniform prior (current deployment uses uniform seeds)
    const seedData = await deploySeedData(uniformFactors(NUM_BINS));
    const marketId: bigint = await core.createMarket.staticCall(
      MIN_TICK, MAX_TICK, SPACING, Number(start), Number(end), Number(tSet),
      NUM_BINS, ALPHA, feeAddr, await seedData.getAddress()
    );
    await core.createMarket(
      MIN_TICK, MAX_TICK, SPACING, Number(start), Number(end), Number(tSet),
      NUM_BINS, ALPHA, feeAddr, await seedData.getAddress()
    );
    while (!(await (core as any).markets(marketId)).isSeeded) {
      await core.seedNextChunks(marketId, 50);
    }

    // settlement bin (GBM-ish dispersion around anchor)
    const winBin = clampBin(Math.round(ANCHOR_BIN + gauss(rng) * SIGMA_BINS));

    // ---- trading window: noise + one informed (buys the winner) ----
    let ts = start + 10n;
    const trade = async (bin: number, qtyUnits: number, who: any) => {
      const [lo, hi] = binToTicks(bin);
      const qty = BigInt(qtyUnits) * 1_000_000n; // 6-dec
      await time.increaseTo(Number(ts)); // advance LATEST block so the staticCall sees trading-open
      ts += 20n;
      const cost: bigint = await core.calculateOpenCost.staticCall(marketId, lo, hi, qty);
      const maxCost = cost + cost / 2n + 1_000_000n;
      if (DEBUG) console.log(`   trade bin=${bin} q=${qtyUnits} cost=${ethers.formatUnits(cost, 6)} maxCost=${ethers.formatUnits(maxCost, 6)}`);
      await core.connect(who).openPosition(marketId, lo, hi, qty, maxCost);
    };
    for (let k = 0; k < N_NOISE; k++) {
      await trade(Math.floor(rng() * NUM_BINS), Q_NOISE, traders[k % traders.length]);
    }
    // informed: buys the eventual winner late (toxic flow)
    await trade(winBin, Q_INFORMED, traders[0]);

    // ---- settle at winBin ----
    const settleTick = MIN_TICK + winBin * SPACING; // humanPrice = tick (feed BTC dec8 -> /100 -> *1e6)
    const priceTs = tSet + 1n;
    await time.setNextBlockTimestamp(Number(tSet + 2n));
    const payload = buildRedstonePayload(Number(settleTick), Number(priceTs), authorisedWallets);
    await submitWithPayload(core, owner, marketId, payload);

    await time.setNextBlockTimestamp(Number(tSet + 12n)); // > submit(5)+ops(5)
    await core.connect(owner).finalizePrimarySettlement(marketId);

    // ---- process batch & measure ----
    const batchId = toBatchId(tSet);
    const navBefore = fmtWad(await core.getVaultNav.staticCall());
    await advancePastBatchEnd(batchId);
    await core.processDailyBatch(batchId);
    const navAfter = fmtWad(await core.getVaultNav.staticCall());

    const dp = await core.getDailyPnl.staticCall(batchId);
    const lt = fmtWad(dp[0]); const ftot = fmtWad(dp[1]);
    sumLt += lt; sumFees += ftot;
    if (lt < 0) { sumLoss += -lt; lossM++; } else if (lt > 0) { sumProfit += lt; profitM++; }
    navPath.push(navAfter);

    console.log(
      `${String(i).padStart(3)}  ${String(winBin).padStart(5)}  ${navBefore.toFixed(3).padStart(9)}  ${navAfter.toFixed(3).padStart(8)}  ` +
      `${lt.toFixed(3).padStart(8)}  ${ftot.toFixed(4).padStart(7)}  ${(navAfter - navBefore).toFixed(3).padStart(7)}`
    );
  }

  const psi = sumLoss > 0 ? sumFees / sumLoss : Infinity;
  const finalPrice = fmtWad(await core.getVaultPrice.staticCall());
  console.log("\n=== AGGREGATE (real contract execution) ===");
  console.log(`markets ${N_MARKETS}  loss ${lossM} / profit ${profitM}`);
  console.log(`sum L_t ${sumLt.toFixed(3)}   gross loss ${sumLoss.toFixed(3)}   gross profit ${sumProfit.toFixed(3)}`);
  console.log(`total fees ${sumFees.toFixed(4)}`);
  console.log(`psi = fees/loss = ${psi.toFixed(3)}   (GATE for v2: require >= 1)`);
  console.log(`vault NAV ${navPath[navPath.length - 1].toFixed(2)}  share price ${finalPrice.toFixed(6)}`);
  console.log(`\nNote: static pricing -> expect psi << 1 (reproduces live 0.15 & the baseline loss).`);
  console.log(`This same harness, pointed at PricingLayer v2, is the >=1 gate.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
