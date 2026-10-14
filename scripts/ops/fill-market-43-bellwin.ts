/**
 * Fill market #43 with bell-shaped positions centered on the WINNING bin (tick 955 = $9.55).
 * Simulates smart traders who correctly predict settlement.
 * ~$3K total volume, heavily concentrated around $9.55.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const SLIPPAGE_BPS = 500n;
const MAX_SEARCH_ITERS = 18;
const BUDGET = 3_500_000_000n;
const MKT = 43n;
const WIN_TICK = 955; // where we'll settle — $9.55

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < 10_000_000_000n) {
    await (await payment.approve(coreAddress, 10_000_000_000n)).wait();
  }

  const market = await core.markets(MKT);
  const spacing = 5;
  const minTick = Number(market.minTick);
  const maxTick = Number(market.maxTick);

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

  // Bell-shaped positions centered on WIN_TICK (955)
  // Gaussian distribution: most volume at 955, tapering off
  interface PosTemplate { lower: number; upper: number; target: bigint; label: string; }
  const templates: PosTemplate[] = [];

  // Layer 1: Exact winning bin — 5 positions, $200 each = $1,000
  for (let i = 0; i < 5; i++) {
    templates.push({ lower: WIN_TICK - spacing, upper: WIN_TICK + spacing, target: 200_000_000n, label: "bullseye" });
  }

  // Layer 2: ±1-2 bins from winner — 6 positions, $120 each = $720
  for (let offset = -2; offset <= 2; offset++) {
    if (offset === 0) continue;
    const l = WIN_TICK + offset * spacing - spacing;
    const u = WIN_TICK + offset * spacing + spacing;
    templates.push({ lower: l, upper: u, target: 120_000_000n, label: "near-win" });
  }
  // One wider near-win
  templates.push({ lower: WIN_TICK - 3 * spacing, upper: WIN_TICK + 3 * spacing, target: 200_000_000n, label: "near-win-wide" });

  // Layer 3: ±3-5 bins — 6 positions, $80 each = $480
  for (let offset of [-5, -4, -3, 3, 4, 5]) {
    const l = WIN_TICK + offset * spacing - spacing;
    const u = WIN_TICK + offset * spacing + spacing;
    templates.push({ lower: l, upper: u, target: 80_000_000n, label: "mid-ring" });
  }

  // Layer 4: ±6-10 bins — 6 positions, $50 each = $300
  for (let offset of [-10, -8, -6, 6, 8, 10]) {
    const l = WIN_TICK + offset * spacing - spacing;
    const u = WIN_TICK + offset * spacing + 2 * spacing;
    templates.push({ lower: l, upper: u, target: 50_000_000n, label: "outer" });
  }

  // Layer 5: Wider ranges that include winner — 4 positions, $100 each = $400
  templates.push({ lower: WIN_TICK - 10 * spacing, upper: WIN_TICK + 10 * spacing, target: 100_000_000n, label: "wide-win" });
  templates.push({ lower: WIN_TICK - 8 * spacing, upper: WIN_TICK + 5 * spacing, target: 100_000_000n, label: "wide-win" });
  templates.push({ lower: WIN_TICK - 5 * spacing, upper: WIN_TICK + 8 * spacing, target: 100_000_000n, label: "wide-win" });
  templates.push({ lower: WIN_TICK - 15 * spacing, upper: WIN_TICK + 15 * spacing, target: 100_000_000n, label: "wide-win" });

  console.log(`\n${templates.length} position templates, all centered around $${(WIN_TICK/100).toFixed(2)}`);
  console.log(`Budget: $${Number(BUDGET)/1e6}\n`);

  let opened = 0;
  let totalCost = 0n;

  for (const tmpl of templates) {
    if (totalCost >= BUDGET) break;
    const lo = Math.max(minTick, Math.floor(tmpl.lower / spacing) * spacing);
    const up = Math.min(maxTick, Math.ceil(tmpl.upper / spacing) * spacing);
    if (up <= lo) continue;

    try {
      const result = await findQuantity(BigInt(lo), BigInt(up), tmpl.target);
      if (!result || result.qty === 0n) continue;
      const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
      const tx = await core.openPosition(MKT, BigInt(lo), BigInt(up), result.qty, maxCost);
      await tx.wait();
      totalCost += result.cost;
      opened++;
      if (opened % 5 === 0) {
        console.log(`  ${opened} opened, $${(Number(totalCost) / 1e6).toFixed(0)} spent [${tmpl.label}]`);
      }
    } catch {}
  }

  console.log(`\nDone: ${opened} positions, $${(Number(totalCost) / 1e6).toFixed(2)} volume`);
  console.log(`All positions concentrated around winning bin $9.55`);
}
main().catch((err) => { console.error(err); process.exit(1); });
