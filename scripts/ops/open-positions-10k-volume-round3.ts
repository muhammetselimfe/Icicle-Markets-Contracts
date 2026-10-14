/**
 * Round 3: Open ~50 test positions in each of 3 markets (#26 AVAX, #27 WTI, #28 XAU).
 * Target ~$3,333 per market, ~$10,000 total volume.
 * Alpha=1,000 WAD, bell curve prior.
 *
 * Position mix per market (50 total):
 * - 10 single-bin near center: qty=$100
 * - 10 narrow 2-3 bins near center: qty=$150
 * - 10 medium 5-8 bins spread: qty=$200
 * - 10 wide 10-15 bins: qty=$200
 * - 10 very wide 15-25 bins: qty=$250
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-positions-10k-volume-round3.ts --network fuji
 */
import hre from "hardhat";

const MARKET_IDS = [26, 27, 28];
const APPROVE_AMOUNT = 50_000_000_000n; // $50,000 USDC approval
const CORE_ADDRESS = "0x5163b4aB77650D1D937a5c5E6B0d012e4659546e";
const USDC_ADDRESS = "0x12ecFc9715cEA5DAd986F5B59848aEc7044e66E8";

interface Position {
  lower: number;
  upper: number;
  quantity: bigint;
}

function generatePositions(
  minTick: number,
  maxTick: number,
  tickSpacing: number,
  numBins: number,
  anchor: number,
): Position[] {
  const positions: Position[] = [];
  const centerTick = Math.round(anchor / tickSpacing) * tickSpacing;

  const clamp = (lower: number, upper: number) => ({
    lower: Math.max(minTick, lower),
    upper: Math.min(maxTick, upper),
  });

  const add = (lower: number, upper: number, qty: bigint) => {
    const c = clamp(lower, upper);
    if (c.lower < c.upper) positions.push({ ...c, quantity: qty });
  };

  // --- GROUP 1: 10 single-bin near center, qty=$100 ---
  for (let i = 0; i < 10; i++) {
    const offset = (i - 5) * tickSpacing;
    const tick = centerTick + offset;
    add(tick, tick + tickSpacing, 100_000_000n);
  }

  // --- GROUP 2: 10 narrow 2-3 bins near center, qty=$150 ---
  for (let i = 0; i < 10; i++) {
    const width = (i % 2 === 0) ? 2 : 3; // alternate 2 and 3 bins
    const offset = (i - 5) * tickSpacing;
    const tick = centerTick + offset;
    add(tick, tick + width * tickSpacing, 150_000_000n);
  }

  // --- GROUP 3: 10 medium 5-8 bins spread across range, qty=$200 ---
  for (let i = 0; i < 10; i++) {
    const width = 5 + (i % 4); // 5,6,7,8 bins
    // Spread positions across the range, centered around different points
    const spreadOffset = (i - 5) * 3 * tickSpacing;
    const tick = centerTick + spreadOffset - Math.floor(width / 2) * tickSpacing;
    add(tick, tick + width * tickSpacing, 200_000_000n);
  }

  // --- GROUP 4: 10 wide 10-15 bins, qty=$200 ---
  for (let i = 0; i < 10; i++) {
    const width = 10 + (i % 6); // 10,11,12,13,14,15 bins
    // Distribute across the range
    const maxStart = numBins - width;
    const startBin = Math.max(0, Math.min(maxStart, Math.floor((i / 10) * maxStart)));
    const lower = minTick + startBin * tickSpacing;
    add(lower, lower + width * tickSpacing, 200_000_000n);
  }

  // --- GROUP 5: 10 very wide 15-25 bins, qty=$250 ---
  for (let i = 0; i < 10; i++) {
    const maxWidth = Math.min(25, numBins - 1);
    const minWidth = Math.min(15, maxWidth);
    const widthRange = Math.max(1, maxWidth - minWidth + 1);
    const width = minWidth + (i % widthRange);
    const maxStart = Math.max(0, numBins - width);
    // Spread evenly
    const startBin = Math.max(0, Math.min(maxStart, Math.floor((i / 10) * maxStart)));
    const lower = minTick + startBin * tickSpacing;
    add(lower, lower + width * tickSpacing, 250_000_000n);
  }

  return positions;
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", CORE_ADDRESS);
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);

  // Check balance
  const balance = await usdc.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  if (balance < 15_000_000_000n) {
    console.log("WARNING: Balance may be insufficient for $10k volume");
  }

  // Approve
  console.log(`Approving $${Number(APPROVE_AMOUNT) / 1e6} USDC...`);
  await (await usdc.approve(CORE_ADDRESS, APPROVE_AMOUNT)).wait();
  console.log("Approved.");

  // Get TradeModule ABI for event parsing
  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  // Market anchors (approximate current prices)
  const anchors: Record<number, number> = {
    26: 995,  // AVAX ~$9.95
    27: 94,   // WTI ~$94
    28: 5105, // XAU ~$5105
  };

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
    console.log(`  Time remaining: ${Math.max(0, endTs - now)}s`);

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

    // Generate positions
    const positions = generatePositions(minTick, maxTick, tickSpacing, numBins, anchors[marketId] ?? Math.round((minTick + maxTick) / 2));
    console.log(`  Generated ${positions.length} position specs`);

    let opened = 0;
    let failedCount = 0;
    let marketCost = 0n;

    for (let i = 0; i < positions.length; i++) {
      const { lower, upper, quantity } = positions[i];
      const binCount = (upper - lower) / tickSpacing;
      const maxCost = quantity * 2n + 5_000_000n; // qty * 2 + $5 buffer

      // Check time
      const nowInner = Math.floor(Date.now() / 1000);
      if (nowInner > endTs) {
        console.log(`  [${i + 1}/${positions.length}] TIME EXPIRED — stopping market #${marketId}`);
        break;
      }

      try {
        // Get cost quote
        const cost = await core.calculateOpenCost.staticCall(
          BigInt(marketId),
          BigInt(lower),
          BigInt(upper),
          quantity,
        );

        if (cost > maxCost) {
          console.log(`  [${i + 1}/${positions.length}] ${lower}–${upper} (${binCount}bins, $${Number(quantity)/1e6}) SKIP: cost=$${(Number(cost) / 1e6).toFixed(2)} > max=$${Number(maxCost)/1e6}`);
          failedCount++;
          continue;
        }

        // Open position with cost + ~15% slippage buffer
        const maxCostActual = cost + cost / 7n + 2_000_000n;
        const tx = await core.openPosition(
          BigInt(marketId),
          BigInt(lower),
          BigInt(upper),
          quantity,
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
        console.log(`  [${i + 1}/${positions.length}] ${lower}–${upper} (${binCount}bins, $${Number(quantity)/1e6}) OK pos#${positionId} cost=$${(Number(cost) / 1e6).toFixed(2)}`);
      } catch (err: any) {
        failedCount++;
        const msg = err.message?.slice(0, 120) || "unknown error";
        console.log(`  [${i + 1}/${positions.length}] ${lower}–${upper} (${binCount}bins) FAIL: ${msg}`);
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
  console.log(`USDC spent: $${(Number(balance - balanceAfter) / 1e6).toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
