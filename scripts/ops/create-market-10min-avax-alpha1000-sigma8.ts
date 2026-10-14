/**
 * Create 10-min AVAX market: α=1000, σ=8, 200bps, anchored at LIVE price.
 * Fetches current AVAX price from Redstone before creating.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;
const MIN_FACTOR = WAD / 100n;
const MAX_FACTOR = WAD * 100n;

const TICK_SPACING = 5;
const NUM_BINS = 80;
const DURATION_SEC = 10 * 60;
const ALPHA_WAD = "1000000000000000000000"; // 1000 WAD
const SEED_CHUNK_SIZE = 50;
const SIGMA_BINS = 8;

function generateGaussianFactors(numBins: number, centerBin: number, sigma: number): bigint[] {
  const factors: bigint[] = [];
  for (let i = 0; i < numBins; i++) {
    const distance = i - centerBin;
    const exponent = -(distance * distance) / (2 * sigma * sigma);
    const value = Math.exp(exponent);
    let factorWad = BigInt(Math.round(value * 1e18));
    if (factorWad < MIN_FACTOR) factorWad = MIN_FACTOR;
    if (factorWad > MAX_FACTOR) factorWad = MAX_FACTOR;
    factors.push(factorWad);
  }
  return factors;
}

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const feePolicyAddress = envData.contracts.FeePolicy200bps;
  if (!coreAddress || !feePolicyAddress) throw new Error("Missing addresses");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Fetch live AVAX price from Redstone
  const res = await fetch("https://api.redstone.finance/prices?symbol=AVAX&provider=redstone&limit=1");
  const data = await res.json() as any[];
  const livePrice = data[0]?.value;
  if (!livePrice) throw new Error("Failed to fetch AVAX price");

  const ANCHOR_PRICE = Math.round(livePrice * 100); // cents
  console.log(`\nLive AVAX: $${livePrice.toFixed(4)} → anchor tick ${ANCHOR_PRICE}`);

  const centerTick = Math.round(ANCHOR_PRICE / TICK_SPACING) * TICK_SPACING;
  const binsBelow = Math.floor(NUM_BINS / 2);
  const minTick = Math.max(TICK_SPACING, centerTick - binsBelow * TICK_SPACING);
  const maxTick = centerTick + (NUM_BINS - binsBelow) * TICK_SPACING;
  const computedBins = (maxTick - minTick) / TICK_SPACING;
  if (computedBins !== NUM_BINS) throw new Error(`Bin mismatch: ${computedBins} != ${NUM_BINS}`);

  const centerBin = Math.floor((ANCHOR_PRICE - minTick) / TICK_SPACING);

  console.log(`\n=== AVAX 10-min α=1000 σ=8 Market ===`);
  console.log(`Range: $${(minTick/100).toFixed(2)} – $${(maxTick/100).toFixed(2)}`);
  console.log(`Center: $${(centerTick/100).toFixed(2)} (bin ${centerBin})`);
  console.log(`Alpha: 1000 (max loss: $${(1000 * Math.log(NUM_BINS)).toFixed(0)})`);

  const factors = generateGaussianFactors(NUM_BINS, centerBin, SIGMA_BINS);
  const packedFactors = ethers.solidityPacked(Array(factors.length).fill("uint256"), factors);

  console.log("Deploying SeedData...");
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packedFactors);
  await seedData.waitForDeployment();

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const startTimestamp = now + 10;
  const endTimestamp = startTimestamp + DURATION_SEC;

  console.log(`Start: ${new Date(startTimestamp * 1000).toISOString()}`);
  console.log(`End:   ${new Date(endTimestamp * 1000).toISOString()}`);

  const alphaWad = BigInt(ALPHA_WAD);
  const txData = core.interface.encodeFunctionData("createMarket", [
    minTick, maxTick, TICK_SPACING,
    startTimestamp, endTimestamp, endTimestamp,
    NUM_BINS, alphaWad, feePolicyAddress, seedData.target,
  ]);
  const blockGasLimit = latestBlock?.gasLimit ?? 0n;
  const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
  const tx = await deployer.sendTransaction({ to: coreAddress, data: txData, ...overrides });
  await tx.wait();

  const marketId = await core.nextMarketId();
  console.log(`Market created! ID=${marketId}`);

  let remaining = NUM_BINS;
  while (remaining > 0) {
    const count = Math.min(remaining, SEED_CHUNK_SIZE);
    await (await core.seedNextChunks(marketId, count)).wait();
    remaining -= count;
  }
  console.log("Seeded!");

  // Now open positions — mix of smart bets near current price and spread bets
  const MKT = BigInt(Number(marketId));
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < 50_000_000_000n) {
    await (await payment.approve(coreAddress, 50_000_000_000n)).wait();
  }

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  // Position templates
  interface Pos { lower: number; upper: number; target: bigint; label: string; }
  const positions: Pos[] = [];

  // === "Smart trader" positions — centered on current price ===
  // These will likely WIN if price stays near $10.35

  // Bullseye: exact current price bin, heavy bets
  const priceTick = centerTick; // anchored at live price
  for (let i = 0; i < 5; i++) {
    positions.push({ lower: priceTick - TICK_SPACING, upper: priceTick + TICK_SPACING, target: 500_000_000n, label: "bullseye" });
  }

  // Near price: ±1-3 bins
  for (let off = -3; off <= 3; off++) {
    if (off === 0) continue;
    positions.push({ lower: priceTick + off * TICK_SPACING - TICK_SPACING, upper: priceTick + off * TICK_SPACING + TICK_SPACING, target: 300_000_000n, label: "near" });
  }

  // Wider ranges covering price
  positions.push({ lower: priceTick - 5 * TICK_SPACING, upper: priceTick + 5 * TICK_SPACING, target: 400_000_000n, label: "wide-win" });
  positions.push({ lower: priceTick - 8 * TICK_SPACING, upper: priceTick + 8 * TICK_SPACING, target: 300_000_000n, label: "wide-win" });

  // === "Dumb trader" positions — away from price ===
  // These will LOSE — vault keeps premiums
  for (let off of [-15, -12, -10, 10, 12, 15]) {
    const l = priceTick + off * TICK_SPACING;
    positions.push({ lower: l, upper: l + 3 * TICK_SPACING, target: 200_000_000n, label: "away" });
  }

  // Fill some gaps
  for (let i = 0; i < 8; i++) {
    const l = minTick + i * 10 * TICK_SPACING;
    positions.push({ lower: l, upper: l + 5 * TICK_SPACING, target: 100_000_000n, label: "fill" });
  }

  console.log(`\nOpening ${positions.length} positions...`);

  // Binary search helper
  async function findQty(lower: bigint, upper: bigint, target: bigint): Promise<{qty: bigint; cost: bigint} | null> {
    const probe = 1_000_000n;
    let probeCost: bigint;
    try { probeCost = await core.calculateOpenCost.staticCall(MKT, lower, upper, probe); } catch { return null; }
    if (probeCost === 0n) return null;

    let lo = 1_000_000n;
    let hi = (probe * target * 3n) / probeCost;
    if (hi < lo) hi = lo * 1000n;

    for (let e = 0; e < 5; e++) {
      try {
        if (await core.calculateOpenCost.staticCall(MKT, lower, upper, hi) >= target) break;
        hi *= 3n;
      } catch { hi = hi * 2n / 3n; break; }
    }

    let bestQty = lo, bestCost = probeCost;
    for (let iter = 0; iter < 18; iter++) {
      const mid = (lo + hi) / 2n;
      if (mid <= lo || mid >= hi) break;
      let midCost: bigint;
      try { midCost = await core.calculateOpenCost.staticCall(MKT, lower, upper, mid); } catch { hi = mid; continue; }
      const bd = bestCost > target ? bestCost - target : target - bestCost;
      const md = midCost > target ? midCost - target : target - midCost;
      if (md < bd) { bestQty = mid; bestCost = midCost; }
      if (md <= 5_000_000n) break;
      if (midCost > target) hi = mid; else lo = mid;
    }
    return { qty: bestQty, cost: bestCost };
  }

  let opened = 0, totalCost = 0n, winCost = 0n, lossCost = 0n;
  const BUDGET = 25_000_000_000n;

  for (const p of positions) {
    if (totalCost >= BUDGET) break;
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

      // Track win vs loss positions
      const isWinner = lo <= priceTick && up > priceTick;
      if (isWinner) winCost += r.cost; else lossCost += r.cost;

      if (opened % 5 === 0) {
        console.log(`  ${opened} opened, $${(Number(totalCost)/1e6).toFixed(0)} spent`);
      }
    } catch {}
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Market #${marketId} Ready for Battle`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Total: ${opened} positions, $${(Number(totalCost)/1e6).toFixed(2)} volume`);
  console.log(`  Winning positions (cover current price): $${(Number(winCost)/1e6).toFixed(2)}`);
  console.log(`  Losing positions (miss current price): $${(Number(lossCost)/1e6).toFixed(2)}`);
  console.log(`  Win/Loss ratio: ${(Number(winCost)/Number(lossCost)).toFixed(2)}`);
  console.log(`  α=1000, max vault loss: $${(1000*Math.log(80)).toFixed(0)}`);
  console.log(`\n  Go open your positions on the UI to try to rob the vault!`);
  console.log(`  Market ends: ${new Date(endTimestamp * 1000).toISOString()}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
