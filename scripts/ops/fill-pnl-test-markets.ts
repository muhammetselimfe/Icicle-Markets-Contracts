/**
 * Open identical ~$5K positions on markets #35, #36, #37 for P&L curve testing.
 * Same position set on each market so we can compare settlement at different prices.
 *
 * Usage:
 *   npx hardhat run scripts/ops/fill-pnl-test-markets.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const SLIPPAGE_BPS = 500n;
const MAX_SEARCH_ITERS = 18;
const BUDGET_PER_MARKET = 5_500_000_000n;

const MARKETS = [35, 36, 37];

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < 20_000_000_000n) {
    console.log("Approving 20K USDC...");
    await (await payment.approve(coreAddress, 20_000_000_000n)).wait();
  }

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

  // Build position templates (same for all markets)
  // Market params: minTick=795, maxTick=1195, spacing=5, 80 bins, center≈995
  const minTick = 795;
  const spacing = 5;
  const center = 995;

  interface PosTemplate { lower: number; upper: number; target: bigint; label: string; }
  const templates: PosTemplate[] = [];

  // Tight center: 10 positions ~$120 each = $1,200
  for (let i = -5; i < 5; i++) {
    const l = center + i * spacing;
    const u = l + spacing * (1 + Math.abs(i) % 2);
    templates.push({ lower: l, upper: u, target: 120_000_000n, label: "tight" });
  }

  // Medium center: 8 positions ~$100 each = $800
  for (let i = -4; i < 4; i++) {
    const w = (4 + Math.abs(i) % 3) * spacing;
    const l = center + i * 3 * spacing - Math.floor(w / 2 / spacing) * spacing;
    templates.push({ lower: l, upper: l + w, target: 100_000_000n, label: "medium" });
  }

  // Spread across inner range: 8 positions ~$80 each = $640
  for (let i = 0; i < 8; i++) {
    const innerStart = minTick + 16 * spacing;
    const step = 6 * spacing;
    const l = innerStart + i * step;
    templates.push({ lower: l, upper: l + 6 * spacing, target: 80_000_000n, label: "spread" });
  }

  // Fill gaps: stride 5, window 4 bins, ~$40 each
  for (let binStart = 0; binStart + 4 <= 80; binStart += 5) {
    const l = minTick + binStart * spacing;
    const u = l + 4 * spacing;
    const mid = l + 2 * spacing;
    const dist = Math.abs(mid - center) / spacing;
    const ratio = Math.min(1, dist / 40);
    const target = 50_000_000n - BigInt(Math.floor(Number(30_000_000n) * ratio));
    templates.push({ lower: l, upper: u, target, label: "fill" });
  }

  // Tails: 6 positions ~$20 each = $120
  for (let i = 0; i < 3; i++) {
    templates.push({ lower: minTick + i * 2 * spacing, upper: minTick + (i * 2 + 3) * spacing, target: 20_000_000n, label: "l-tail" });
    templates.push({ lower: 1195 - (i * 2 + 3) * spacing, upper: 1195 - i * 2 * spacing, target: 20_000_000n, label: "r-tail" });
  }

  console.log(`\nTemplate: ${templates.length} positions per market`);
  console.log(`Estimated: ~$5K per market, ~$15K total\n`);

  let grandTotal = 0n;
  let grandCount = 0;

  for (const mktNum of MARKETS) {
    const mktId = BigInt(mktNum);
    console.log(`${"=".repeat(60)}`);
    console.log(`Market #${mktNum}`);
    console.log(`${"=".repeat(60)}`);

    const market = await core.markets(mktId);
    if (market.settled) { console.log("  Already settled, skip"); continue; }
    const now = Math.floor(Date.now() / 1000);
    if (now >= Number(market.endTimestamp)) { console.log("  Expired, skip"); continue; }

    let opened = 0;
    let totalCost = 0n;

    for (const tmpl of templates) {
      if (totalCost >= BUDGET_PER_MARKET) break;

      const lo = Math.max(Number(market.minTick), Math.floor(tmpl.lower / spacing) * spacing);
      const up = Math.min(Number(market.maxTick), Math.ceil(tmpl.upper / spacing) * spacing);
      if (up <= lo) continue;

      try {
        const result = await findQuantity(mktId, BigInt(lo), BigInt(up), tmpl.target);
        if (!result || result.qty === 0n) continue;

        const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
        const tx = await core.openPosition(mktId, BigInt(lo), BigInt(up), result.qty, maxCost);
        await tx.wait();

        totalCost += result.cost;
        opened++;

        if (opened % 10 === 0) {
          console.log(`  ${opened} opened, $${(Number(totalCost) / 1e6).toFixed(0)} spent`);
        }
      } catch {}
    }

    console.log(`  Done: ${opened} positions, $${(Number(totalCost) / 1e6).toFixed(2)} volume`);
    grandTotal += totalCost;
    grandCount += opened;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`GRAND TOTAL: ${grandCount} positions, $${(Number(grandTotal) / 1e6).toFixed(2)} volume`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\nSettlement plan:`);
  console.log(`  #35 → center ($9.95, tick 995)`);
  console.log(`  #36 → 2σ away ($9.55, tick 955)`);
  console.log(`  #37 → edge ($8.50, tick 850)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
