/**
 * Create 15-min AVAX market (α=1000, σ=8, 200bps) + fill with bell-shaped positions.
 * Positions concentrated near center (live price) — simulates realistic trader behavior.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n;
const MAX_FACTOR = WAD * 100n;
const TICK_SPACING = 5;
const NUM_BINS = 80;
const DURATION_SEC = 15 * 60;
const ALPHA_WAD = "1000000000000000000000"; // 1000 WAD
const SIGMA_BINS = 8;
const BATCH_OFFSET = 28800;

function generateGaussianFactors(numBins: number, centerBin: number, sigma: number): bigint[] {
  const factors: bigint[] = [];
  for (let i = 0; i < numBins; i++) {
    const d = i - centerBin;
    const val = Math.exp(-(d * d) / (2 * sigma * sigma));
    let f = BigInt(Math.round(val * 1e18));
    if (f < MIN_FACTOR) f = MIN_FACTOR;
    if (f > MAX_FACTOR) f = MAX_FACTOR;
    factors.push(f);
  }
  return factors;
}

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const feeAddr = env.contracts.FeePolicy200bps;
  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddr);

  // 1) Fetch live AVAX price
  const res = await fetch("https://api.redstone.finance/prices?symbol=AVAX&provider=redstone&limit=1");
  const data = await res.json() as any[];
  const livePrice = data[0]?.value;
  if (!livePrice) throw new Error("Failed to fetch AVAX price");

  const anchorTick = Math.round(livePrice * 100);
  const centerTick = Math.round(anchorTick / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + (NUM_BINS - binsBelow) * TICK_SPACING;
  const centerBin = Math.floor((anchorTick - minTick) / TICK_SPACING);

  console.log(`Live AVAX: $${livePrice.toFixed(4)} → center tick ${centerTick}`);
  console.log(`Range: $${(minTick/100).toFixed(2)} – $${(maxTick/100).toFixed(2)}, ${NUM_BINS} bins`);
  console.log(`α=1000, σ=8, 200bps\n`);

  // 2) Deploy SeedData
  const factors = generateGaussianFactors(NUM_BINS, centerBin, SIGMA_BINS);
  const packed = ethers.solidityPacked(Array(factors.length).fill("uint256"), factors);
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packed);
  await seedData.waitForDeployment();

  // 3) Timestamps — handle batch conflict
  const block = await ethers.provider.getBlock("latest");
  const now = block!.timestamp;
  const startTs = now + 10;
  const endTs = startTs + DURATION_SEC;

  const currentBatchId = Number(await core.getCurrentBatchId());
  const endBatch = Math.floor((endTs - BATCH_OFFSET) / 86400);
  let settleTs = endTs;
  if (endBatch <= currentBatchId) {
    settleTs = (currentBatchId + 1) * 86400 + BATCH_OFFSET + 60;
    console.log(`Batch ${endBatch} processed. Settlement pushed to batch ${currentBatchId + 1}`);
  }

  console.log(`Trading: ${new Date(startTs*1000).toISOString()} → ${new Date(endTs*1000).toISOString()}`);
  console.log(`Settlement: ${new Date(settleTs*1000).toISOString()}\n`);

  // 4) Create market
  const tx = await core.createMarket(
    minTick, maxTick, TICK_SPACING,
    startTs, endTs, settleTs,
    NUM_BINS, BigInt(ALPHA_WAD), feeAddr, seedData.target,
    { gasLimit: 8_000_000 },
  );
  await tx.wait();

  const marketId = Number(await core.nextMarketId());
  console.log(`Market #${marketId} created!`);

  // 5) Seed
  let remaining = NUM_BINS;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 50);
    await (await core.seedNextChunks(marketId, chunk)).wait();
    remaining -= chunk;
  }
  console.log("Seeded!\n");

  // 6) Approve USDC
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const allowance = await payment.allowance(deployer.address, coreAddr);
  if (allowance < 50_000_000_000n) {
    await (await payment.approve(coreAddr, 50_000_000_000n)).wait();
  }

  // 7) Bell-shaped positions — heavier near center, lighter at edges
  const MKT = BigInt(marketId);
  interface Pos { lower: number; upper: number; target: bigint; label: string; }
  const positions: Pos[] = [];

  // Layer 1: Bullseye — exact center, 5 heavy positions ($300 each)
  for (let i = 0; i < 5; i++) {
    positions.push({ lower: centerTick - TICK_SPACING, upper: centerTick + TICK_SPACING, target: 300_000_000n, label: "bullseye" });
  }

  // Layer 2: Near center ±1-3 bins ($200 each)
  for (let off = -3; off <= 3; off++) {
    if (off === 0) continue;
    const l = centerTick + off * TICK_SPACING;
    positions.push({ lower: l - TICK_SPACING, upper: l + TICK_SPACING, target: 200_000_000n, label: "near" });
  }

  // Layer 3: Medium range ±4-8 bins ($120 each, wider spans)
  for (let off = -8; off <= 8; off += 2) {
    if (Math.abs(off) < 4) continue;
    const l = centerTick + off * TICK_SPACING;
    positions.push({ lower: l - 2 * TICK_SPACING, upper: l + 2 * TICK_SPACING, target: 120_000_000n, label: "medium" });
  }

  // Layer 4: Wide bets covering center ($150 each, big ranges)
  positions.push({ lower: centerTick - 10 * TICK_SPACING, upper: centerTick + 10 * TICK_SPACING, target: 150_000_000n, label: "wide" });
  positions.push({ lower: centerTick - 15 * TICK_SPACING, upper: centerTick + 15 * TICK_SPACING, target: 150_000_000n, label: "wide" });
  positions.push({ lower: centerTick - 5 * TICK_SPACING, upper: centerTick + 5 * TICK_SPACING, target: 200_000_000n, label: "wide" });

  // Layer 5: Outer ring ±10-20 bins ($60 each)
  for (let off = -20; off <= 20; off += 4) {
    if (Math.abs(off) < 10) continue;
    const l = centerTick + off * TICK_SPACING;
    if (l < minTick || l + 3 * TICK_SPACING > maxTick) continue;
    positions.push({ lower: l, upper: l + 3 * TICK_SPACING, target: 60_000_000n, label: "outer" });
  }

  // Layer 6: Tail bets ($25 each)
  for (let i = 0; i < 4; i++) {
    const lLeft = minTick + i * 3 * TICK_SPACING;
    const lRight = maxTick - (i + 1) * 3 * TICK_SPACING;
    if (lLeft + 3 * TICK_SPACING <= maxTick) {
      positions.push({ lower: lLeft, upper: lLeft + 3 * TICK_SPACING, target: 25_000_000n, label: "tail" });
    }
    if (lRight >= minTick) {
      positions.push({ lower: lRight, upper: lRight + 3 * TICK_SPACING, target: 25_000_000n, label: "tail" });
    }
  }

  console.log(`Opening ${positions.length} bell-shaped positions...\n`);

  // Binary search for quantity
  async function findQty(lower: bigint, upper: bigint, target: bigint): Promise<{qty: bigint; cost: bigint} | null> {
    const probe = 1_000_000n;
    let pc: bigint;
    try { pc = await core.calculateOpenCost.staticCall(MKT, lower, upper, probe); } catch { return null; }
    if (pc === 0n) return null;

    let lo = 1_000_000n;
    let hi = (probe * target * 3n) / pc;
    if (hi < lo) hi = lo * 1000n;
    for (let e = 0; e < 5; e++) {
      try { if (await core.calculateOpenCost.staticCall(MKT, lower, upper, hi) >= target) break; hi *= 3n; }
      catch { hi = hi * 2n / 3n; break; }
    }

    let bestQty = lo, bestCost = pc;
    for (let iter = 0; iter < 18; iter++) {
      const mid = (lo + hi) / 2n;
      if (mid <= lo || mid >= hi) break;
      let mc: bigint;
      try { mc = await core.calculateOpenCost.staticCall(MKT, lower, upper, mid); } catch { hi = mid; continue; }
      const bd = bestCost > target ? bestCost - target : target - bestCost;
      const md = mc > target ? mc - target : target - mc;
      if (md < bd) { bestQty = mid; bestCost = mc; }
      if (md <= 5_000_000n) break;
      if (mc > target) hi = mid; else lo = mid;
    }
    return { qty: bestQty, cost: bestCost };
  }

  let opened = 0, totalCost = 0n;
  const layerCosts: Record<string, { count: number; cost: bigint }> = {};

  for (const p of positions) {
    const lo = Math.max(minTick, Math.floor(p.lower / TICK_SPACING) * TICK_SPACING);
    const up = Math.min(maxTick, Math.ceil(p.upper / TICK_SPACING) * TICK_SPACING);
    if (up <= lo) continue;

    try {
      const r = await findQty(BigInt(lo), BigInt(up), p.target);
      if (!r || r.qty === 0n) continue;
      const maxCost = r.cost + (r.cost * 500n) / 10000n + 1n;
      const tx = await core.openPosition(MKT, BigInt(lo), BigInt(up), r.qty, maxCost);
      await tx.wait();
      totalCost += r.cost;
      opened++;

      if (!layerCosts[p.label]) layerCosts[p.label] = { count: 0, cost: 0n };
      layerCosts[p.label].count++;
      layerCosts[p.label].cost += r.cost;

      if (opened % 10 === 0) {
        console.log(`  ${opened} opened, $${(Number(totalCost)/1e6).toFixed(0)} spent`);
      }
    } catch {}
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Market #${marketId} — AVAX 15-min, α=1000, σ=8, 200bps`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Total: ${opened} positions, $${(Number(totalCost)/1e6).toFixed(2)} volume\n`);
  console.log(`Position layers:`);
  for (const [label, data] of Object.entries(layerCosts)) {
    console.log(`  ${label}: ${data.count} positions, $${(Number(data.cost)/1e6).toFixed(2)}`);
  }
  console.log(`\nTrading ends: ${new Date(endTs * 1000).toISOString()}`);
  console.log(`Settlement: ${new Date(settleTs * 1000).toISOString()}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
