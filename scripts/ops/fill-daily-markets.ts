/**
 * Fill active daily markets #45 (AVAX), #48 (WTI), #49 (XAU) with ~$5K each.
 * Same position template: tight center + medium + spread + fill + tails.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const SLIPPAGE_BPS = 500n;
const MAX_SEARCH_ITERS = 18;
const BUDGET_PER_MARKET = 5_500_000_000n;

interface MarketDef {
  id: bigint;
  name: string;
}

const MARKETS: MarketDef[] = [
  { id: 45n, name: "AVAX" },
  { id: 48n, name: "WTI" },
  { id: 49n, name: "XAU" },
];

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
  if (allowance < 50_000_000_000n) {
    console.log("Approving 50K USDC...");
    await (await payment.approve(coreAddress, 50_000_000_000n)).wait();
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

  let grandTotal = 0n;
  let grandCount = 0;

  for (const mkt of MARKETS) {
    const market = await core.markets(mkt.id);
    if (market.settled) { console.log(`\n${mkt.name} (#${mkt.id}): Already settled, skip`); continue; }
    const now = Math.floor(Date.now() / 1000);
    if (now >= Number(market.endTimestamp)) { console.log(`\n${mkt.name} (#${mkt.id}): Expired, skip`); continue; }

    const minTick = Number(market.minTick);
    const maxTick = Number(market.maxTick);
    const spacing = Number(market.tickSpacing);
    const numBins = Number(market.numBins);
    const center = minTick + Math.floor(numBins / 2) * spacing;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`${mkt.name} — Market #${mkt.id}`);
    console.log(`Range: ${minTick}–${maxTick}, spacing=${spacing}, center=${center}`);
    console.log(`${"=".repeat(60)}`);

    interface PosTemplate { lower: number; upper: number; target: bigint; label: string; }
    const templates: PosTemplate[] = [];

    // Tight center: 10 positions ~$150 each = $1,500
    for (let i = -5; i < 5; i++) {
      const l = center + i * spacing;
      const u = l + spacing * (1 + Math.abs(i) % 2);
      templates.push({ lower: l, upper: Math.min(u, maxTick), target: 150_000_000n, label: "tight" });
    }

    // Medium center: 10 positions ~$120 each = $1,200
    for (let i = -5; i < 5; i++) {
      const width = (4 + (Math.abs(i) % 3)) * spacing;
      const l = center + i * 3 * spacing - Math.floor(width / 2 / spacing) * spacing;
      templates.push({
        lower: Math.max(minTick, l),
        upper: Math.min(maxTick, l + width),
        target: 120_000_000n,
        label: "medium",
      });
    }

    // Wide spread: 8 positions ~$100 each = $800
    const innerStart = minTick + Math.floor(numBins * 0.2) * spacing;
    const spreadStep = Math.floor((numBins * 0.6) / 8) * spacing;
    for (let i = 0; i < 8; i++) {
      const l = innerStart + i * spreadStep;
      templates.push({
        lower: l,
        upper: Math.min(maxTick, l + 6 * spacing),
        target: 100_000_000n,
        label: "spread",
      });
    }

    // Fill gaps: stride 5, window 4 bins
    for (let binStart = 0; binStart + 4 <= numBins; binStart += 5) {
      const l = minTick + binStart * spacing;
      const u = l + 4 * spacing;
      const mid = l + 2 * spacing;
      const dist = Math.abs(mid - center) / spacing;
      const ratio = Math.min(1, dist / (numBins / 2));
      const target = 60_000_000n - BigInt(Math.floor(Number(40_000_000n) * ratio));
      templates.push({ lower: l, upper: u, target, label: "fill" });
    }

    // Tails: 6 positions ~$25 each = $150
    for (let i = 0; i < 3; i++) {
      templates.push({ lower: minTick + i * 2 * spacing, upper: minTick + (i * 2 + 3) * spacing, target: 25_000_000n, label: "l-tail" });
      templates.push({ lower: maxTick - (i * 2 + 3) * spacing, upper: maxTick - i * 2 * spacing, target: 25_000_000n, label: "r-tail" });
    }

    let opened = 0;
    let totalCost = 0n;

    for (const tmpl of templates) {
      if (totalCost >= BUDGET_PER_MARKET) break;
      const lo = Math.max(minTick, Math.floor(tmpl.lower / spacing) * spacing);
      const up = Math.min(maxTick, Math.ceil(tmpl.upper / spacing) * spacing);
      if (up <= lo) continue;

      try {
        const result = await findQuantity(mkt.id, BigInt(lo), BigInt(up), tmpl.target);
        if (!result || result.qty === 0n) continue;
        const maxCost = result.cost + (result.cost * SLIPPAGE_BPS) / 10000n + 1n;
        const tx = await core.openPosition(mkt.id, BigInt(lo), BigInt(up), result.qty, maxCost);
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
}

main().catch((err) => { console.error(err); process.exit(1); });
