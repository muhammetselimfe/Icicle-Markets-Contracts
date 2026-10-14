/**
 * Open 100 test positions in each of 3 markets (#20 AVAX, #21 WTI, #22 XAU).
 * ~$10 per position, spread across different range widths.
 *
 * Strategy per market (100 positions):
 *   20 single-bin near center
 *   20 narrow 2-3 bin near center
 *   20 medium 5-8 bin spread across range
 *   20 wide 10-15 bin
 *   20 very wide 15-25 bin across tails
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-positions-300-test.ts --network fuji
 */
import hre from "hardhat";

const MARKET_IDS = [20, 21, 22];
const QUANTITY = 10_000_000n; // $10 in 6-decimal USDC
const MAX_COST = 30_000_000n; // $30 max cost (3x buffer)
const APPROVE_AMOUNT = 5_000_000_000n; // $5000 USDC approval

const CORE_ADDRESS = "0x5163b4aB77650D1D937a5c5E6B0d012e4659546e";
const USDC_ADDRESS = "0x12ecFc9715cEA5DAd986F5B59848aEc7044e66E8";

interface MarketParams {
  minTick: number;
  maxTick: number;
  tickSpacing: number;
  numBins: number;
}

function generatePositions(p: MarketParams): Array<{ lower: number; upper: number }> {
  const { minTick, maxTick, tickSpacing, numBins } = p;
  const center = Math.round((minTick + maxTick) / 2 / tickSpacing) * tickSpacing;
  const positions: Array<{ lower: number; upper: number }> = [];

  // Helper: clamp ticks to valid range
  const clamp = (lower: number, upper: number) => ({
    lower: Math.max(minTick, lower),
    upper: Math.min(maxTick, upper),
  });

  // Helper: add position with slight offset to spread them out
  const add = (lower: number, upper: number) => {
    const c = clamp(lower, upper);
    if (c.lower < c.upper) positions.push(c);
  };

  // --- GROUP 1: 20 single-bin positions near center ---
  // Spread across center ±10 bins
  for (let i = 0; i < 20; i++) {
    const offset = (i - 10) * tickSpacing;
    const tick = center + offset;
    add(tick, tick + tickSpacing);
  }

  // --- GROUP 2: 20 narrow 2-3 bin positions near center ---
  for (let i = 0; i < 20; i++) {
    const width = (i % 2 === 0) ? 2 : 3;
    // Spread across center ±15 bins
    const offset = (i - 10) * tickSpacing;
    const tick = center + offset;
    add(tick, tick + width * tickSpacing);
  }

  // --- GROUP 3: 20 medium 5-8 bin positions spread across range ---
  const rangeStep = Math.floor(numBins / 20);
  for (let i = 0; i < 20; i++) {
    const width = 5 + (i % 4); // 5,6,7,8 bins
    const startBin = i * rangeStep;
    const lower = minTick + startBin * tickSpacing;
    add(lower, lower + width * tickSpacing);
  }

  // --- GROUP 4: 20 wide 10-15 bin positions ---
  for (let i = 0; i < 20; i++) {
    const width = 10 + (i % 6); // 10-15 bins
    // Spread evenly across the range
    const startBin = Math.floor((i / 20) * (numBins - width));
    const lower = minTick + startBin * tickSpacing;
    add(lower, lower + width * tickSpacing);
  }

  // --- GROUP 5: 20 very wide 15-25 bin positions across tails ---
  for (let i = 0; i < 20; i++) {
    const width = 15 + (i % 11); // 15-25 bins
    let startBin: number;
    if (i < 7) {
      // Lower tail
      startBin = i * 3;
    } else if (i < 14) {
      // Upper tail
      startBin = numBins - width - (i - 7) * 3;
    } else {
      // Mixed / spanning center
      startBin = Math.floor((numBins - width) * (i - 14) / 6);
    }
    startBin = Math.max(0, Math.min(numBins - width, startBin));
    const lower = minTick + startBin * tickSpacing;
    add(lower, lower + width * tickSpacing);
  }

  return positions;
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", CORE_ADDRESS);
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);

  // Check balance
  const balance = await usdc.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  // Approve
  console.log(`Approving $${Number(APPROVE_AMOUNT) / 1e6} USDC...`);
  await (await usdc.approve(CORE_ADDRESS, APPROVE_AMOUNT)).wait();
  console.log("Approved.");

  // Get TradeModule ABI for event parsing
  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  const grandTotals = { opened: 0, failed: 0, totalCost: 0n };

  for (const marketId of MARKET_IDS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`MARKET #${marketId}`);
    console.log("=".repeat(60));

    // Read market data
    const m = await core.markets(BigInt(marketId));
    const isSeeded = m[0];
    const settled = m[1];
    const failed = m[3];
    const numBins = Number(m[4]);
    const startTs = Number(m[8]);
    const endTs = Number(m[9]);
    const minTick = Number(m[12]);
    const maxTick = Number(m[13]);
    const tickSpacing = Number(m[14]);

    const now = Math.floor(Date.now() / 1000);

    console.log(`  Range: ${minTick} – ${maxTick}, spacing=${tickSpacing}, bins=${numBins}`);
    console.log(`  Seeded: ${isSeeded}, Settled: ${settled}, Failed: ${failed}`);
    console.log(`  Trading: ${new Date(startTs * 1000).toISOString()} – ${new Date(endTs * 1000).toISOString()}`);

    if (!isSeeded) {
      console.log("  SKIP: Market not seeded");
      continue;
    }
    if (settled || failed) {
      console.log("  SKIP: Market already settled or failed");
      continue;
    }
    if (now < startTs) {
      console.log(`  WARNING: Trading hasn't started yet (starts in ${startTs - now}s)`);
    }
    if (now > endTs) {
      console.log("  SKIP: Trading has ended");
      continue;
    }

    // Generate 100 positions
    const positions = generatePositions({ minTick, maxTick, tickSpacing, numBins });
    console.log(`  Generated ${positions.length} position specs`);

    let opened = 0;
    let failedCount = 0;
    let marketCost = 0n;

    for (let i = 0; i < positions.length; i++) {
      const { lower, upper } = positions[i];
      const binCount = (upper - lower) / tickSpacing;

      try {
        // Get cost quote first
        const cost = await core.calculateOpenCost.staticCall(
          BigInt(marketId),
          BigInt(lower),
          BigInt(upper),
          QUANTITY,
        );

        if (cost > MAX_COST) {
          console.log(`  [${i + 1}/100] ${lower}–${upper} (${binCount}bins) SKIP: cost=$${(Number(cost) / 1e6).toFixed(2)} > max`);
          failedCount++;
          continue;
        }

        // Open position with cost + 10% slippage as maxCost
        const maxCostActual = cost + cost / 10n + 1_000_000n;
        const tx = await core.openPosition(
          BigInt(marketId),
          BigInt(lower),
          BigInt(upper),
          QUANTITY,
          maxCostActual,
        );
        const receipt = await tx.wait();

        // Parse position ID from event
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

        opened++;
        marketCost += cost;
        console.log(`  [${i + 1}/100] ${lower}–${upper} (${binCount}bins) OK pos#${positionId} cost=$${(Number(cost) / 1e6).toFixed(2)}`);
      } catch (err: any) {
        failedCount++;
        const msg = err.message?.slice(0, 100) || "unknown error";
        console.log(`  [${i + 1}/100] ${lower}–${upper} (${binCount}bins) FAIL: ${msg}`);
      }
    }

    console.log(`\n  Market #${marketId} summary: ${opened} opened, ${failedCount} failed, cost=$${(Number(marketCost) / 1e6).toFixed(2)}`);
    grandTotals.opened += opened;
    grandTotals.failed += failedCount;
    grandTotals.totalCost += marketCost;
  }

  // Final balance
  const balanceAfter = await usdc.balanceOf(deployer.address);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`GRAND TOTAL: ${grandTotals.opened} opened, ${grandTotals.failed} failed`);
  console.log(`Total cost: $${(Number(grandTotals.totalCost) / 1e6).toFixed(2)}`);
  console.log(`USDC balance before: $${(Number(balance) / 1e6).toFixed(2)}`);
  console.log(`USDC balance after: $${(Number(balanceAfter) / 1e6).toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
