/**
 * Open ~33 test positions in each of 3 markets (#23 AVAX, #24 WTI, #25 XAU).
 * Target ~$3,333 per market, ~$10,000 total volume.
 * Alpha=1,000 WAD so positions are cheaper per unit.
 * $100-$200 per position face value.
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-positions-10k-volume.ts --network fuji
 */
import hre from "hardhat";

const MARKET_IDS = [23, 24, 25];
const APPROVE_AMOUNT = 50_000_000_000n; // $50,000 USDC approval
const CORE_ADDRESS = "0x5163b4aB77650D1D937a5c5E6B0d012e4659546e";
const USDC_ADDRESS = "0x12ecFc9715cEA5DAd986F5B59848aEc7044e66E8";

interface MarketParams {
  minTick: number;
  maxTick: number;
  tickSpacing: number;
  numBins: number;
  anchor: number;
}

interface Position {
  lower: number;
  upper: number;
  quantity: bigint;
}

function generatePositions(p: MarketParams): Position[] {
  const { minTick, maxTick, tickSpacing, numBins, anchor } = p;
  const positions: Position[] = [];

  const clamp = (lower: number, upper: number) => ({
    lower: Math.max(minTick, lower),
    upper: Math.min(maxTick, upper),
  });

  const add = (lower: number, upper: number, qty: bigint) => {
    const c = clamp(lower, upper);
    if (c.lower < c.upper) positions.push({ ...c, quantity: qty });
  };

  // Align anchor to tick grid
  const centerTick = Math.round(anchor / tickSpacing) * tickSpacing;

  // --- GROUP 1: 10 single-bin or 2-bin near center (30%) --- $100-$150 each
  for (let i = 0; i < 10; i++) {
    const offset = (i - 5) * tickSpacing;
    const tick = centerTick + offset;
    const width = (i % 3 === 0) ? 2 : 1; // mix of 1 and 2 bins
    const qty = (i % 2 === 0) ? 150_000_000n : 100_000_000n; // $100-$150
    add(tick, tick + width * tickSpacing, qty);
  }

  // --- GROUP 2: 10 medium 3-5 bins near center (30%) --- $100 each
  for (let i = 0; i < 10; i++) {
    const width = 3 + (i % 3); // 3,4,5 bins
    const offset = (i - 5) * 2 * tickSpacing;
    const tick = centerTick + offset;
    add(tick, tick + width * tickSpacing, 100_000_000n);
  }

  // --- GROUP 3: 7 wide 8-15 bins (20%) --- $100-$200 each
  for (let i = 0; i < 7; i++) {
    const width = 8 + (i % 8); // 8-15 bins
    // Spread across range
    const startBin = Math.floor((i / 7) * Math.max(0, numBins - width));
    const lower = minTick + startBin * tickSpacing;
    const qty = (i % 2 === 0) ? 200_000_000n : 100_000_000n;
    add(lower, lower + width * tickSpacing, qty);
  }

  // --- GROUP 4: 6 very wide 15-25 bins across range (20%) --- $100-$200 each
  for (let i = 0; i < 6; i++) {
    const maxWidth = Math.min(25, numBins - 1);
    const minWidth = Math.min(15, maxWidth);
    const width = minWidth + (i % Math.max(1, maxWidth - minWidth + 1));
    let startBin: number;
    if (i < 2) {
      // Lower portion
      startBin = i * 3;
    } else if (i < 4) {
      // Upper portion
      startBin = Math.max(0, numBins - width - (i - 2) * 3);
    } else {
      // Spanning center
      startBin = Math.max(0, Math.floor((numBins - width) / 2) + (i - 4) * 3);
    }
    startBin = Math.max(0, Math.min(numBins - width, startBin));
    const lower = minTick + startBin * tickSpacing;
    const qty = (i % 2 === 0) ? 200_000_000n : 150_000_000n;
    add(lower, lower + width * tickSpacing, qty);
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
  const approveTx = await usdc.approve(CORE_ADDRESS, APPROVE_AMOUNT);
  await approveTx.wait();
  console.log("Approved.");

  // Get TradeModule ABI for event parsing
  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  // Market anchors (approximate current prices)
  const anchors: Record<number, number> = {
    23: 989,  // AVAX ~$9.89
    24: 95,   // WTI ~$95
    25: 5105, // XAU ~$5105
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
    const positions = generatePositions({
      minTick,
      maxTick,
      tickSpacing,
      numBins,
      anchor: anchors[marketId] ?? Math.round((minTick + maxTick) / 2),
    });
    console.log(`  Generated ${positions.length} position specs`);

    let opened = 0;
    let failedCount = 0;
    let marketCost = 0n;

    for (let i = 0; i < positions.length; i++) {
      const { lower, upper, quantity } = positions[i];
      const binCount = (upper - lower) / tickSpacing;
      const maxCost = quantity * 3n + 10_000_000n;

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

        // Open position with cost + 15% slippage buffer
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
