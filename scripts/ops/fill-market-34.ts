/**
 * Open ~$5K of positions on market #34 (α=100, 200bps, bell curve σ=4).
 *
 * Mix of center + tail positions to simulate realistic trading.
 *
 * Usage:
 *   npx hardhat run scripts/ops/fill-market-34.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const SLIPPAGE_BPS = 500n;
const MAX_SEARCH_ITERS = 18;
const BUDGET = 5_500_000_000n; // ~$5.5K budget (slightly over $5K to account for fees)

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

  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < BUDGET) {
    console.log("Approving USDC...");
    await (await payment.approve(coreAddress, 10_000_000_000n)).wait();
  }

  const MKT = 34n;
  const market = await core.markets(MKT);
  const minTick = Number(market.minTick); // 790
  const maxTick = Number(market.maxTick); // 1190
  const spacing = Number(market.tickSpacing); // 5
  const numBins = Number(market.numBins); // 80
  const center = minTick + Math.floor(numBins / 2) * spacing; // 990 = $9.90

  console.log(`\nMarket #34: $${(minTick/100).toFixed(2)} – $${(maxTick/100).toFixed(2)}, ${numBins} bins`);
  console.log(`Center: $${(center/100).toFixed(2)}, α=100, fee=200bps`);

  // Binary search for quantity
  async function findQuantity(
    lower: bigint, upper: bigint, targetCost: bigint,
  ): Promise<{ qty: bigint; cost: bigint } | null> {
    const probeQty = 1_000_000n;
    let probeCost: bigint;
    try {
      probeCost = await core.calculateOpenCost.staticCall(MKT, lower, upper, probeQty);
    } catch { return null; }
    if (probeCost === 0n) return null;

    let lo = 1_000_000n;
    let hi = (probeQty * targetCost * 3n) / probeCost;
    if (hi < lo) hi = lo * 1000n;

    for (let expand = 0; expand < 5; expand++) {
      try {
        const hiCost = await core.calculateOpenCost.staticCall(MKT, lower, upper, hi);
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
        midCost = await core.calculateOpenCost.staticCall(MKT, lower, upper, mid);
      } catch { hi = mid; continue; }

      const bestDiff = bestCost > targetCost ? bestCost - targetCost : targetCost - bestCost;
      const midDiff = midCost > targetCost ? midCost - targetCost : targetCost - midCost;
      if (midDiff < bestDiff) { bestQty = mid; bestCost = midCost; }
      if (midDiff <= 5_000_000n) break;
      if (midCost > targetCost) { hi = mid; } else { lo = mid; }
    }

    return { qty: bestQty, cost: bestCost };
  }

  // Build position list: center-heavy + fill gaps + tails
  const positions: { lower: number; upper: number; target: bigint; label: string }[] = [];

  // 1. Tight center positions (~$150 each) — 10 positions ≈ $1,500
  for (let i = -5; i < 5; i++) {
    const l = center + i * spacing;
    const u = l + spacing * (1 + Math.abs(i) % 2);
    positions.push({ lower: l, upper: Math.min(u, maxTick), target: 150_000_000n, label: "tight" });
  }

  // 2. Medium center positions (~$120 each) — 10 positions ≈ $1,200
  for (let i = -5; i < 5; i++) {
    const width = (4 + (Math.abs(i) % 3)) * spacing;
    const l = center + i * 3 * spacing - Math.floor(width / 2 / spacing) * spacing;
    positions.push({
      lower: Math.max(minTick, l),
      upper: Math.min(maxTick, l + width),
      target: 120_000_000n,
      label: "medium",
    });
  }

  // 3. Wide spread across inner 60% — 8 positions ≈ $800
  const innerStart = minTick + Math.floor(numBins * 0.2) * spacing;
  const innerEnd = minTick + Math.floor(numBins * 0.8) * spacing;
  const spreadStep = Math.floor((innerEnd - innerStart) / 8 / spacing) * spacing;
  for (let i = 0; i < 8; i++) {
    const l = innerStart + i * spreadStep;
    const width = 6 * spacing;
    positions.push({
      lower: l,
      upper: Math.min(maxTick, l + width),
      target: 100_000_000n,
      label: "spread",
    });
  }

  // 4. Full-range walk (fill gaps) — stride 5, window 4 bins, ~$40 each
  for (let binStart = 0; binStart + 4 <= numBins; binStart += 5) {
    const l = minTick + binStart * spacing;
    const u = l + 4 * spacing;
    const midpoint = l + 2 * spacing;
    const dist = Math.abs(midpoint - center) / spacing;
    const maxDist = numBins / 2;
    const ratio = Math.min(1, dist / maxDist);
    const target = 60_000_000n - BigInt(Math.floor(Number(40_000_000n) * ratio));
    positions.push({ lower: l, upper: u, target, label: "fill" });
  }

  // 5. Tail positions — 6 positions ≈ $150
  for (let i = 0; i < 3; i++) {
    positions.push({ lower: minTick + i * 2 * spacing, upper: minTick + (i * 2 + 3) * spacing, target: 25_000_000n, label: "left-tail" });
    positions.push({ lower: maxTick - (i * 2 + 3) * spacing, upper: maxTick - i * 2 * spacing, target: 25_000_000n, label: "right-tail" });
  }

  console.log(`\nPlanned: ${positions.length} positions`);

  let opened = 0;
  let totalCost = 0n;

  for (let i = 0; i < positions.length; i++) {
    if (totalCost >= BUDGET) {
      console.log(`\nBudget reached ($${(Number(totalCost) / 1e6).toFixed(0)}), stopping`);
      break;
    }

    const { lower, upper, target, label } = positions[i];
    const lo = Math.max(minTick, Math.floor(lower / spacing) * spacing);
    const up = Math.min(maxTick, Math.ceil(upper / spacing) * spacing);
    if (up <= lo) continue;

    try {
      const result = await findQuantity(BigInt(lo), BigInt(up), target);
      if (!result || result.qty === 0n) continue;

      const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
      const tx = await core.openPosition(MKT, BigInt(lo), BigInt(up), result.qty, maxCost);
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
        console.log(`  ${opened} opened, $${(Number(totalCost) / 1e6).toFixed(0)} spent — latest: #${posId} [${label}] [$${(lo / 100).toFixed(2)}–$${(up / 100).toFixed(2)}] $${(Number(result.cost) / 1e6).toFixed(0)}`);
      }
    } catch (err: any) {
      const reason = err.reason || err.message || "";
      if (!reason.includes("AlphaExceedsLimit")) {
        // silent skip for most errors
      }
    }
  }

  const fees = Number(totalCost) / 1e6 * 0.02;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DONE: ${opened} positions, $${(Number(totalCost) / 1e6).toFixed(2)} volume`);
  console.log(`Expected fees at 200bps: $${fees.toFixed(2)}`);
  console.log(`Max vault loss: $438`);
  console.log(`Projected ψ_fee: ${(fees / 438).toFixed(3)}`);
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
