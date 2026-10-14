/**
 * Open test positions across calibrated-sigma markets (#30-32).
 * Generates ~$10K+ total volume with a mix of:
 *   - Center positions (likely winners, expensive)
 *   - Tail positions (unlikely, cheap — to test "price crush" scenarios)
 *
 * Uses binary search on calculateOpenCost to target ~$100 per position.
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-positions-calibrated.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const TARGET_COST = 100_000_000n; // $100 USDC (6 decimals)
const TAIL_TARGET = 30_000_000n;  // $30 for tail bets (cheaper)
const TOLERANCE = 8_000_000n;     // ±$8 acceptable
const SLIPPAGE_BPS = 500n;        // 5%
const MAX_SEARCH_ITERS = 20;

interface MarketJob {
  marketId: number;
  name: string;
  positionsCenter: number;  // how many center/likely positions
  positionsTail: number;    // how many tail/unlikely positions
}

// Markets 30-32 are calibrated sigma markets
const JOBS: MarketJob[] = [
  { marketId: 30, name: "AVAX (σ=4)",  positionsCenter: 25, positionsTail: 10 },
  { marketId: 31, name: "WTI (σ=2)",   positionsCenter: 25, positionsTail: 10 },
  { marketId: 32, name: "XAU (σ=7)",   positionsCenter: 25, positionsTail: 10 },
];

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  // Check and approve USDC
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const approveAmount = 20_000_000_000n; // 20K USDC
  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < approveAmount) {
    console.log("Approving 20,000 USDC...");
    await (await payment.approve(coreAddress, approveAmount)).wait();
  }

  // Binary search helper
  async function findQuantity(
    mktId: bigint, lower: bigint, upper: bigint, targetCost: bigint,
  ): Promise<{ qty: bigint; cost: bigint } | null> {
    const probeQty = 1_000_000n;
    let probeCost: bigint;
    try {
      probeCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, probeQty);
    } catch { return null; }
    if (probeCost === 0n) return null;

    let lo = 1_000_000n;
    let hi = (probeQty * targetCost * 3n) / probeCost;
    if (hi < lo) hi = lo * 1000n;

    for (let expand = 0; expand < 5; expand++) {
      try {
        const hiCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, hi);
        if (hiCost >= targetCost) break;
        hi *= 3n;
      } catch { hi = hi * 2n / 3n; break; }
    }

    let bestQty = lo;
    let bestCost = probeCost;
    for (let iter = 0; iter < MAX_SEARCH_ITERS; iter++) {
      const mid = (lo + hi) / 2n;
      if (mid <= lo || mid >= hi) break;

      let midCost: bigint;
      try {
        midCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, mid);
      } catch { hi = mid; continue; }

      const bestDiff = bestCost > targetCost ? bestCost - targetCost : targetCost - bestCost;
      const midDiff = midCost > targetCost ? midCost - targetCost : targetCost - midCost;

      if (midDiff < bestDiff) {
        bestQty = mid;
        bestCost = midCost;
      }
      if (midDiff <= TOLERANCE) break;
      if (midCost > targetCost) { hi = mid; } else { lo = mid; }
    }

    return { qty: bestQty, cost: bestCost };
  }

  let grandTotal = 0n;
  let grandCount = 0;

  for (const job of JOBS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${job.name} — Market #${job.marketId}`);
    console.log(`${"=".repeat(60)}`);

    const market = await core.markets(BigInt(job.marketId));
    if (market.numBins === 0n) {
      console.log("  Market not found, skipping");
      continue;
    }
    if (market.settled) {
      console.log("  Market already settled, skipping");
      continue;
    }

    const minTick = Number(market.minTick);
    const maxTick = Number(market.maxTick);
    const spacing = Number(market.tickSpacing);
    const numBins = Number(market.numBins);
    const center = minTick + Math.floor(numBins / 2) * spacing;
    const endTs = Number(market.endTimestamp);
    const now = Math.floor(Date.now() / 1000);

    if (now >= endTs) {
      console.log("  Market expired, skipping");
      continue;
    }

    const isCentBased = spacing < 10; // AVAX uses spacing=5 (cents)
    const d = isCentBased ? 100 : 1;
    const minsLeft = Math.round((endTs - now) / 60);

    console.log(`  Range: $${(minTick / d).toFixed(2)} – $${(maxTick / d).toFixed(2)}`);
    console.log(`  Center: $${(center / d).toFixed(2)}, spacing: $${(spacing / d).toFixed(2)}`);
    console.log(`  Bins: ${numBins}, ${minsLeft} min remaining`);

    let opened = 0;
    let totalCost = 0n;

    // === CENTER POSITIONS (likely winners, ~$100 each) ===
    console.log(`\n  --- Center positions (${job.positionsCenter}) ---`);

    const centerRanges: { lower: number; upper: number; label: string }[] = [];

    for (let i = 0; i < job.positionsCenter; i++) {
      let lower: number, upper: number, label: string;

      if (i < 5) {
        // Tight 1-2 bin positions right at center
        const offset = (i - 2) * spacing;
        lower = center + offset;
        upper = lower + spacing * (1 + (i % 2));
        label = "tight-center";
      } else if (i < 12) {
        // Medium 3-5 bin positions near center
        const width = (3 + (i % 3)) * spacing;
        const offset = ((i - 8) * spacing);
        lower = center + offset - Math.floor(width / 2 / spacing) * spacing;
        upper = lower + width;
        label = "med-center";
      } else if (i < 18) {
        // Wider 6-10 bin positions around center
        const width = (6 + (i % 5)) * spacing;
        const shift = ((i - 15) * 2) * spacing;
        lower = center + shift - Math.floor(width / 2 / spacing) * spacing;
        upper = lower + width;
        label = "wide-center";
      } else {
        // Spread positions across the inner half of the range
        const rangeWidth = (maxTick - minTick);
        const innerStart = minTick + Math.floor(rangeWidth * 0.25 / spacing) * spacing;
        const innerEnd = minTick + Math.floor(rangeWidth * 0.75 / spacing) * spacing;
        const step = Math.floor((innerEnd - innerStart) / (job.positionsCenter - 18 + 1) / spacing) * spacing;
        const pos = innerStart + (i - 18) * step;
        const width = (4 + (i % 4)) * spacing;
        lower = pos;
        upper = pos + width;
        label = "inner-spread";
      }

      // Clamp and align
      lower = Math.max(minTick, Math.floor(lower / spacing) * spacing);
      upper = Math.min(maxTick, Math.ceil(upper / spacing) * spacing);
      if (upper <= lower) upper = lower + spacing;
      if (upper > maxTick) { lower = maxTick - spacing * 2; upper = maxTick; }

      centerRanges.push({ lower, upper, label });
    }

    for (const { lower, upper, label } of centerRanges) {
      try {
        const result = await findQuantity(BigInt(job.marketId), BigInt(lower), BigInt(upper), TARGET_COST);
        if (!result || result.qty === 0n) {
          console.log(`    SKIP ${label} [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}]: no valid qty`);
          continue;
        }

        const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
        const tx = await core.openPosition(BigInt(job.marketId), BigInt(lower), BigInt(upper), result.qty, maxCost);
        const receipt = await tx.wait();

        let posId = "?";
        for (const log of receipt?.logs ?? []) {
          try {
            const parsed = tradeIface.parseLog(log);
            if (parsed?.name === "PositionOpened") { posId = parsed.args.positionId.toString(); break; }
          } catch { /* skip */ }
        }

        totalCost += result.cost;
        opened++;
        console.log(`    #${posId} ${label} [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}] cost=$${(Number(result.cost)/1e6).toFixed(2)}`);
      } catch (err: any) {
        const reason = err.reason || err.message || "";
        console.error(`    FAIL ${label} [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}]: ${reason.slice(0, 80)}`);
      }
    }

    // === TAIL POSITIONS (unlikely, cheap — "crush test") ===
    console.log(`\n  --- Tail positions (${job.positionsTail}) — unlikely bins ---`);

    const tailRanges: { lower: number; upper: number; label: string }[] = [];

    for (let i = 0; i < job.positionsTail; i++) {
      let lower: number, upper: number, label: string;

      if (i < job.positionsTail / 2) {
        // Far left tail
        const width = (3 + (i % 4)) * spacing;
        lower = minTick + i * spacing * 2;
        upper = lower + width;
        label = "left-tail";
      } else {
        // Far right tail
        const idx = i - Math.floor(job.positionsTail / 2);
        const width = (3 + (idx % 4)) * spacing;
        upper = maxTick - idx * spacing * 2;
        lower = upper - width;
        label = "right-tail";
      }

      // Clamp and align
      lower = Math.max(minTick, Math.floor(lower / spacing) * spacing);
      upper = Math.min(maxTick, Math.ceil(upper / spacing) * spacing);
      if (upper <= lower) upper = lower + spacing;

      tailRanges.push({ lower, upper, label });
    }

    for (const { lower, upper, label } of tailRanges) {
      try {
        const result = await findQuantity(BigInt(job.marketId), BigInt(lower), BigInt(upper), TAIL_TARGET);
        if (!result || result.qty === 0n) {
          console.log(`    SKIP ${label} [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}]: no valid qty`);
          continue;
        }

        const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
        const tx = await core.openPosition(BigInt(job.marketId), BigInt(lower), BigInt(upper), result.qty, maxCost);
        const receipt = await tx.wait();

        let posId = "?";
        for (const log of receipt?.logs ?? []) {
          try {
            const parsed = tradeIface.parseLog(log);
            if (parsed?.name === "PositionOpened") { posId = parsed.args.positionId.toString(); break; }
          } catch { /* skip */ }
        }

        totalCost += result.cost;
        opened++;
        console.log(`    #${posId} ${label} [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}] cost=$${(Number(result.cost)/1e6).toFixed(2)}`);
      } catch (err: any) {
        const reason = err.reason || err.message || "";
        console.error(`    FAIL ${label} [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}]: ${reason.slice(0, 80)}`);
      }
    }

    console.log(`\n  Summary: ${opened} positions, total cost $${(Number(totalCost) / 1e6).toFixed(2)}`);
    grandTotal += totalCost;
    grandCount += opened;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`GRAND TOTAL: ${grandCount} positions, $${(Number(grandTotal) / 1e6).toFixed(2)} volume`);
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
