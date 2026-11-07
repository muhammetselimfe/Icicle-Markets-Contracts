/**
 * Fill market #42 (σ=8 test) with ~$3K positions — same templates as #38-40.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const SLIPPAGE_BPS = 500n;
const MAX_SEARCH_ITERS = 18;
const BUDGET = 3_500_000_000n;
const MKT = 42n;

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < 10_000_000_000n) {
    console.log("Approving 10K USDC...");
    await (await payment.approve(coreAddress, 10_000_000_000n)).wait();
  }

  const market = await core.markets(MKT);
  const minTick = 795;
  const spacing = 5;
  const center = 995;

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

  interface PosTemplate { lower: number; upper: number; target: bigint; label: string; }
  const templates: PosTemplate[] = [];

  // Tight center: 10 positions ~$120 each
  for (let i = -5; i < 5; i++) {
    const l = center + i * spacing;
    const u = l + spacing * (1 + Math.abs(i) % 2);
    templates.push({ lower: l, upper: u, target: 120_000_000n, label: "tight" });
  }

  // Medium center: 8 positions ~$100 each
  for (let i = -4; i < 4; i++) {
    const w = (4 + Math.abs(i) % 3) * spacing;
    const l = center + i * 3 * spacing - Math.floor(w / 2 / spacing) * spacing;
    templates.push({ lower: l, upper: l + w, target: 100_000_000n, label: "medium" });
  }

  // Spread across inner range: 8 positions ~$80 each
  for (let i = 0; i < 8; i++) {
    const innerStart = minTick + 16 * spacing;
    const step = 6 * spacing;
    const l = innerStart + i * step;
    templates.push({ lower: l, upper: l + 6 * spacing, target: 80_000_000n, label: "spread" });
  }

  // Fill gaps
  for (let binStart = 0; binStart + 4 <= 80; binStart += 5) {
    const l = minTick + binStart * spacing;
    const u = l + 4 * spacing;
    const mid = l + 2 * spacing;
    const dist = Math.abs(mid - center) / spacing;
    const ratio = Math.min(1, dist / 40);
    const target = 50_000_000n - BigInt(Math.floor(Number(30_000_000n) * ratio));
    templates.push({ lower: l, upper: u, target, label: "fill" });
  }

  // Tails
  for (let i = 0; i < 3; i++) {
    templates.push({ lower: minTick + i * 2 * spacing, upper: minTick + (i * 2 + 3) * spacing, target: 20_000_000n, label: "l-tail" });
    templates.push({ lower: 1195 - (i * 2 + 3) * spacing, upper: 1195 - i * 2 * spacing, target: 20_000_000n, label: "r-tail" });
  }

  console.log(`\nTemplate: ${templates.length} positions, budget $${Number(BUDGET)/1e6}`);

  let opened = 0;
  let totalCost = 0n;

  for (const tmpl of templates) {
    if (totalCost >= BUDGET) break;
    const lo = Math.max(Number(market.minTick), Math.floor(tmpl.lower / spacing) * spacing);
    const up = Math.min(Number(market.maxTick), Math.ceil(tmpl.upper / spacing) * spacing);
    if (up <= lo) continue;

    try {
      const result = await findQuantity(BigInt(lo), BigInt(up), tmpl.target);
      if (!result || result.qty === 0n) continue;
      const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
      const tx = await core.openPosition(MKT, BigInt(lo), BigInt(up), result.qty, maxCost);
      await tx.wait();
      totalCost += result.cost;
      opened++;
      if (opened % 10 === 0) {
        console.log(`  ${opened} opened, $${(Number(totalCost) / 1e6).toFixed(0)} spent`);
      }
    } catch {}
  }

  console.log(`\nDone: ${opened} positions, $${(Number(totalCost) / 1e6).toFixed(2)} volume`);
}
main().catch((err) => { console.error(err); process.exit(1); });
