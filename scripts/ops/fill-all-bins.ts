/**
 * Fill ALL bins across calibrated-sigma markets (#30-32) so every price
 * range has some trader activity. Walks through the entire range in
 * overlapping 3-5 bin windows, spending ~$30-50 per position in tails
 * and ~$50-80 in the middle zone. Target: ~$10K additional volume.
 *
 * Usage:
 *   npx hardhat run scripts/ops/fill-all-bins.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const SLIPPAGE_BPS = 500n;
const MAX_SEARCH_ITERS = 18;
const BUDGET_PER_MARKET = 3_400_000_000n; // ~$3,400 per market ≈ $10.2K total

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

  // Approve USDC
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const approveAmount = 15_000_000_000n;
  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < approveAmount) {
    console.log("Approving 15,000 USDC...");
    await (await payment.approve(coreAddress, approveAmount)).wait();
  }

  // Binary search for quantity
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
      if (midDiff < bestDiff) { bestQty = mid; bestCost = midCost; }
      if (midDiff <= 5_000_000n) break;
      if (midCost > targetCost) { hi = mid; } else { lo = mid; }
    }

    return { qty: bestQty, cost: bestCost };
  }

  const markets = [
    { id: 30, name: "AVAX (σ=4)" },
    { id: 31, name: "WTI (σ=2)" },
    { id: 32, name: "XAU (σ=7)" },
  ];

  let grandTotal = 0n;
  let grandCount = 0;

  for (const mkt of markets) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${mkt.name} — Market #${mkt.id}`);
    console.log(`${"=".repeat(60)}`);

    const market = await core.markets(BigInt(mkt.id));
    if (market.numBins === 0n || market.settled) {
      console.log("  Skipping (not found or settled)");
      continue;
    }

    const minTick = Number(market.minTick);
    const maxTick = Number(market.maxTick);
    const spacing = Number(market.tickSpacing);
    const numBins = Number(market.numBins);
    const center = minTick + Math.floor(numBins / 2) * spacing;
    const endTs = Number(market.endTimestamp);
    const now = Math.floor(Date.now() / 1000);

    if (now >= endTs) { console.log("  Expired, skipping"); continue; }

    const isCentBased = spacing < 10;
    const d = isCentBased ? 100 : 1;

    console.log(`  Range: $${(minTick/d).toFixed(2)} – $${(maxTick/d).toFixed(2)}, ${numBins} bins`);
    console.log(`  Center: $${(center/d).toFixed(2)}`);

    // Walk through the ENTIRE range in steps, covering every bin.
    // Use overlapping 3-5 bin windows to ensure full coverage.
    // Spend more on center bins (closer to current price) and less on tails.

    const positions: { lower: number; upper: number; target: bigint }[] = [];

    // Strategy: step through bins with a stride of 3, using 4-bin wide windows.
    // This creates overlapping coverage. Vary cost by distance from center.
    const stride = 3; // step by 3 bins
    const windowBins = 4; // each position covers 4 bins

    for (let binStart = 0; binStart + windowBins <= numBins; binStart += stride) {
      const lower = minTick + binStart * spacing;
      const upper = lower + windowBins * spacing;

      // Distance from center (in bins)
      const midpoint = lower + (windowBins * spacing) / 2;
      const distFromCenter = Math.abs(midpoint - center) / spacing;
      const maxDist = numBins / 2;

      // Scale cost: center gets $80, far tails get $20
      // Linear interpolation
      const centerTarget = 80_000_000n; // $80
      const tailTarget = 20_000_000n;   // $20
      const ratio = Math.min(1, distFromCenter / maxDist);
      const target = centerTarget - BigInt(Math.floor(Number(centerTarget - tailTarget) * ratio));

      positions.push({ lower, upper, target });
    }

    // Also add some single-bin positions at the very extremes to ensure coverage
    for (let i = 0; i < 3; i++) {
      positions.push({ lower: minTick + i * spacing, upper: minTick + (i + 2) * spacing, target: 15_000_000n });
      positions.push({ lower: maxTick - (i + 2) * spacing, upper: maxTick - i * spacing, target: 15_000_000n });
    }

    console.log(`  Planned: ${positions.length} positions to fill gaps`);

    let opened = 0;
    let totalCost = 0n;

    for (let i = 0; i < positions.length; i++) {
      if (totalCost >= BUDGET_PER_MARKET) {
        console.log(`  Budget reached ($${(Number(totalCost)/1e6).toFixed(0)}), stopping`);
        break;
      }

      const { lower, upper, target } = positions[i];

      try {
        const result = await findQuantity(BigInt(mkt.id), BigInt(lower), BigInt(upper), target);
        if (!result || result.qty === 0n) continue;

        const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
        const tx = await core.openPosition(BigInt(mkt.id), BigInt(lower), BigInt(upper), result.qty, maxCost);
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

        if (opened % 5 === 0) {
          console.log(`  ${opened} opened, $${(Number(totalCost)/1e6).toFixed(0)} spent — latest: #${posId} [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}] $${(Number(result.cost)/1e6).toFixed(0)}`);
        }
      } catch (err: any) {
        const reason = err.reason || err.message || "";
        if (!reason.includes("AlphaExceedsLimit")) {
          console.error(`  FAIL [$${(lower/d).toFixed(2)}–$${(upper/d).toFixed(2)}]: ${reason.slice(0, 80)}`);
        }
      }
    }

    console.log(`  Done: ${opened} positions, $${(Number(totalCost)/1e6).toFixed(2)} spent`);
    grandTotal += totalCost;
    grandCount += opened;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`GRAND TOTAL: ${grandCount} positions, $${(Number(grandTotal)/1e6).toFixed(2)} volume`);
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
