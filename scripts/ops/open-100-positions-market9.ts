/**
 * Open 100 positions at ~$100 USDC each across different price ranges on market 9.
 *
 * Generates diverse ranges: narrow (1-3 bins), medium (5-10 bins), wide (15-30 bins),
 * spread across the full $7.00–$11.00 range, with extra density near current AVAX price (~$8.80).
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-100-positions-market9.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const MARKET_ID = 9;
const TARGET_COST = 100_000_000n; // 100 USDC (6 decimals)
const TOLERANCE = 5_000_000n; // ±$5 acceptable
const SLIPPAGE_BPS = 500n; // 5%
const MAX_SEARCH_ITERS = 20;
const TOTAL_POSITIONS = 100;

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");

  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing core address in fuji.json");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const marketData = await core.markets(BigInt(MARKET_ID));
  const minTick = Number(marketData[12]);
  const maxTick = Number(marketData[13]);
  const tickSpacing = Number(marketData[14]);
  const d = 100; // cents → dollars

  console.log(`\nMarket #${MARKET_ID}`);
  console.log(`  Range: $${(minTick / d).toFixed(2)} – $${(maxTick / d).toFixed(2)}`);
  console.log(`  Tick spacing: $${(tickSpacing / d).toFixed(2)}`);

  // Approve 12,000 USDC (100 positions × $100 + buffer)
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`\nUSDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const approveAmount = 12_000_000_000n; // 12,000 USDC
  console.log(`Approving ${Number(approveAmount) / 1e6} USDC...`);
  await (await payment.approve(coreAddress, approveAmount)).wait();

  // Generate 100 diverse ranges
  const numBins = (maxTick - minTick) / tickSpacing; // 80
  const ranges: { lower: number; upper: number }[] = [];

  // Deterministic pseudo-random using simple LCG
  let seed = 42;
  function rand() {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  // Helper: random tick-aligned value in [lo, hi]
  function randTick(lo: number, hi: number): number {
    const bins = Math.floor((hi - lo) / tickSpacing);
    if (bins <= 0) return lo;
    const offset = Math.floor(rand() * bins) * tickSpacing;
    return lo + offset;
  }

  // Strategy: mix of narrow, medium, and wide ranges at various positions
  for (let i = 0; i < TOTAL_POSITIONS; i++) {
    let lower: number, upper: number;

    if (i < 30) {
      // 30 narrow positions (1-3 bins) clustered near AVAX price (~$8.80 = tick 880)
      const center = 880 + Math.floor((rand() - 0.5) * 60 / tickSpacing) * tickSpacing;
      const width = (1 + Math.floor(rand() * 3)) * tickSpacing;
      lower = Math.max(minTick, center - Math.floor(width / 2 / tickSpacing) * tickSpacing);
      upper = lower + width;
    } else if (i < 60) {
      // 30 medium positions (4-10 bins) spread across range
      const width = (4 + Math.floor(rand() * 7)) * tickSpacing;
      lower = randTick(minTick, maxTick - width);
      upper = lower + width;
    } else if (i < 80) {
      // 20 wide positions (10-25 bins) spread across range
      const width = (10 + Math.floor(rand() * 16)) * tickSpacing;
      lower = randTick(minTick, maxTick - width);
      upper = lower + width;
    } else {
      // 20 full-range-ish positions (30-60 bins)
      const width = (30 + Math.floor(rand() * Math.min(31, numBins - 30))) * tickSpacing;
      lower = randTick(minTick, maxTick - width);
      upper = lower + width;
    }

    // Clamp to market bounds
    lower = Math.max(minTick, lower);
    upper = Math.min(maxTick, upper);
    if (upper <= lower) upper = lower + tickSpacing;

    ranges.push({ lower, upper });
  }

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  // Binary search helper
  async function findQuantityForTarget(
    mktId: bigint, lower: bigint, upper: bigint,
  ): Promise<{ qty: bigint; cost: bigint } | null> {
    const probeQty = 1_000_000n;
    let probeCost: bigint;
    try {
      probeCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, probeQty);
    } catch {
      return null;
    }
    if (probeCost === 0n) return null;

    let lo = 1_000_000n;
    let hi = (probeQty * TARGET_COST * 3n) / probeCost;
    if (hi < lo) hi = lo * 1000n;

    for (let expand = 0; expand < 5; expand++) {
      try {
        const hiCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, hi);
        if (hiCost >= TARGET_COST) break;
        hi *= 3n;
      } catch {
        hi = hi * 2n / 3n;
        break;
      }
    }

    let bestQty = lo;
    let bestCost = probeCost;
    for (let iter = 0; iter < MAX_SEARCH_ITERS; iter++) {
      const mid = (lo + hi) / 2n;
      if (mid <= lo || mid >= hi) break;

      let midCost: bigint;
      try {
        midCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, mid);
      } catch {
        hi = mid;
        continue;
      }

      const diff = midCost > TARGET_COST ? midCost - TARGET_COST : TARGET_COST - midCost;
      if (diff < (bestCost > TARGET_COST ? bestCost - TARGET_COST : TARGET_COST - bestCost) ||
          (bestCost < TARGET_COST && midCost <= TARGET_COST && midCost > bestCost)) {
        bestQty = mid;
        bestCost = midCost;
      }

      if (diff <= TOLERANCE) break;

      if (midCost > TARGET_COST) {
        hi = mid;
      } else {
        lo = mid;
      }
    }

    return { qty: bestQty, cost: bestCost };
  }

  let totalCost = 0n;
  let opened = 0;
  let failed = 0;

  for (let i = 0; i < ranges.length; i++) {
    const { lower, upper } = ranges[i];
    const lowerStr = `$${(lower / d).toFixed(2)}`;
    const upperStr = `$${(upper / d).toFixed(2)}`;
    const numBinsInRange = (upper - lower) / tickSpacing;

    try {
      process.stdout.write(`[${i + 1}/${TOTAL_POSITIONS}] ${lowerStr}–${upperStr} (${numBinsInRange} bins) `);

      const result = await findQuantityForTarget(
        BigInt(MARKET_ID), BigInt(lower), BigInt(upper),
      );
      if (!result || result.qty === 0n) {
        console.log("SKIP");
        failed++;
        continue;
      }

      const { qty, cost } = result;
      const maxCost = cost + (cost * SLIPPAGE_BPS) / 10000n + 1n;

      const tx = await core.openPosition(
        BigInt(MARKET_ID), BigInt(lower), BigInt(upper), qty, maxCost,
      );
      const receipt = await tx.wait();

      let positionId = "?";
      for (const log of receipt?.logs ?? []) {
        try {
          const parsed = tradeIface.parseLog(log);
          if (parsed?.name === "PositionOpened") {
            positionId = parsed.args.positionId.toString();
            break;
          }
        } catch { /* ignore */ }
      }

      totalCost += cost;
      opened++;
      console.log(`#${positionId} qty=${(Number(qty) / 1e6).toFixed(1)} cost=$${(Number(cost) / 1e6).toFixed(2)}`);
    } catch (err: any) {
      failed++;
      console.log(`FAIL: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`\n========================================`);
  console.log(`Done! ${opened}/${TOTAL_POSITIONS} opened, ${failed} failed`);
  console.log(`Total cost: $${(Number(totalCost) / 1e6).toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
