/**
 * Open 10 positions at different price ranges, each costing ~100 USDC.
 *
 * Uses binary search on calculateOpenCost to find the quantity that
 * produces ~$100 cost for each range (CLMSR pricing is non-linear).
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-positions-100usd.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const TARGET_COST = 100_000_000n; // 100 USDC (6 decimals)
const TOLERANCE = 5_000_000n; // ±$5 acceptable
const SLIPPAGE_BPS = 500n; // 5%
const MAX_SEARCH_ITERS = 20;

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");

  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing core address in fuji.json");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Find latest active market
  const nextId = await core.nextMarketId();
  const now = Math.floor(Date.now() / 1000);
  let marketId = 0;
  for (let id = Number(nextId); id >= 1; id--) {
    const m = await core.markets(BigInt(id));
    if (Number(m[9]) > now) { marketId = id; break; }
  }
  if (marketId === 0) throw new Error("No active Trading market found");

  const marketData = await core.markets(BigInt(marketId));
  const minTick = Number(marketData[12]);
  const maxTick = Number(marketData[13]);
  const tickSpacing = Number(marketData[14]);
  const isCentBased = (maxTick - minTick) > 50;
  const d = isCentBased ? 100 : 1;

  console.log(`\nMarket #${marketId}`);
  console.log(`  Range: $${(minTick / d).toFixed(2)} – $${(maxTick / d).toFixed(2)}`);
  console.log(`  Tick spacing: $${(tickSpacing / d).toFixed(2)}`);

  // Approve 2000 USDC
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`\nUSDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const approveAmount = 2_000_000_000n;
  console.log(`Approving ${Number(approveAmount) / 1e6} USDC...`);
  await (await payment.approve(coreAddress, approveAmount)).wait();

  // 10 positions spread across the range
  const center = Math.round((minTick + maxTick) / 2 / tickSpacing) * tickSpacing;
  const ranges = [
    { lower: center - tickSpacing, upper: center + tickSpacing },
    { lower: center, upper: center + tickSpacing * 3 },
    { lower: center - tickSpacing * 3, upper: center },
    { lower: center - tickSpacing * 3, upper: center + tickSpacing * 3 },
    { lower: center + tickSpacing * 2, upper: center + tickSpacing * 7 },
    { lower: center - tickSpacing * 7, upper: center - tickSpacing * 2 },
    { lower: center - tickSpacing * 5, upper: center + tickSpacing * 5 },
    { lower: center, upper: center + tickSpacing * 10 },
    { lower: minTick, upper: minTick + tickSpacing * 10 },
    { lower: maxTick - tickSpacing * 10, upper: maxTick },
  ];

  const clamped = ranges.map((r) => ({
    lower: Math.max(minTick, r.lower),
    upper: Math.min(maxTick, r.upper),
  })).filter((r) => r.lower < r.upper);

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  // Helper: binary search for quantity that gives ~TARGET_COST
  async function findQuantityForTarget(
    mktId: bigint, lower: bigint, upper: bigint,
  ): Promise<{ qty: bigint; cost: bigint } | null> {
    // Start with a small probe to get cost-per-unit estimate
    const probeQty = 1_000_000n; // 1 USDC
    let probeCost: bigint;
    try {
      probeCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, probeQty);
    } catch {
      return null;
    }
    if (probeCost === 0n) return null;

    // Initial guess using linear extrapolation
    let lo = 1_000_000n; // 1 USDC
    let hi = (probeQty * TARGET_COST * 3n) / probeCost; // 3× linear estimate as upper bound
    if (hi < lo) hi = lo * 1000n;

    // Verify hi actually gives cost > target (expand if needed)
    for (let expand = 0; expand < 5; expand++) {
      try {
        const hiCost = await core.calculateOpenCost.staticCall(mktId, lower, upper, hi);
        if (hiCost >= TARGET_COST) break;
        hi *= 3n;
      } catch {
        hi = hi * 2n / 3n; // reduce if it reverts
        break;
      }
    }

    // Binary search
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

  for (let i = 0; i < clamped.length; i++) {
    const { lower, upper } = clamped[i];
    const lowerStr = `$${(lower / d).toFixed(2)}`;
    const upperStr = `$${(upper / d).toFixed(2)}`;

    try {
      console.log(`\n[${i + 1}/10] ${lowerStr} – ${upperStr} — searching for ~$100 qty...`);

      const result = await findQuantityForTarget(
        BigInt(marketId), BigInt(lower), BigInt(upper),
      );
      if (!result || result.qty === 0n) {
        console.log(`  SKIP (could not find valid quantity)`);
        continue;
      }

      const { qty, cost } = result;
      const maxCost = cost + (cost * SLIPPAGE_BPS) / 10000n + 1n;

      console.log(`  qty=${(Number(qty) / 1e6).toFixed(2)} | cost≈$${(Number(cost) / 1e6).toFixed(2)}`);

      const tx = await core.openPosition(
        BigInt(marketId), BigInt(lower), BigInt(upper), qty, maxCost,
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
      console.log(`  ✓ Position #${positionId} | tx: ${tx.hash}`);
    } catch (err: any) {
      console.error(`  ✗ Failed: ${err.message?.slice(0, 120)}`);
    }
  }

  console.log(`\nDone! ${opened}/10 positions opened. Total cost ≈ $${(Number(totalCost) / 1e6).toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
