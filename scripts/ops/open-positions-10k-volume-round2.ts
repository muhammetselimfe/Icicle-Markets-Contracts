/**
 * Round 2: Open more positions with higher quantities to reach $10k volume.
 * Round 1 spent ~$1,600 across 99 positions. Need ~$8,400 more.
 * Increase quantities to $500-$1000 per position, ~10 positions per market.
 * Also add some very concentrated positions near center for higher cost.
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-positions-10k-volume-round2.ts --network fuji
 */
import hre from "hardhat";

const MARKET_IDS = [23, 24, 25];
const APPROVE_AMOUNT = 50_000_000_000n; // $50,000 USDC approval
const CORE_ADDRESS = "0x5163b4aB77650D1D937a5c5E6B0d012e4659546e";
const USDC_ADDRESS = "0x12ecFc9715cEA5DAd986F5B59848aEc7044e66E8";

interface Position {
  lower: number;
  upper: number;
  quantity: bigint;
}

function generateRound2Positions(
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

  // Large single-bin positions right at center: very high cost per unit
  add(centerTick - tickSpacing, centerTick, 1_000_000_000n); // $1000 single bin
  add(centerTick, centerTick + tickSpacing, 1_000_000_000n); // $1000 single bin
  add(centerTick - 2 * tickSpacing, centerTick - tickSpacing, 800_000_000n);
  add(centerTick + tickSpacing, centerTick + 2 * tickSpacing, 800_000_000n);

  // Large 2-3 bin positions near center
  add(centerTick - 2 * tickSpacing, centerTick, 700_000_000n);
  add(centerTick, centerTick + 2 * tickSpacing, 700_000_000n);
  add(centerTick - 3 * tickSpacing, centerTick, 600_000_000n);
  add(centerTick, centerTick + 3 * tickSpacing, 600_000_000n);

  // Large 4-5 bin positions
  add(centerTick - 2 * tickSpacing, centerTick + 3 * tickSpacing, 500_000_000n);
  add(centerTick - 3 * tickSpacing, centerTick + 2 * tickSpacing, 500_000_000n);

  // Medium positions with high quantity, spread wider
  add(centerTick - 5 * tickSpacing, centerTick + 5 * tickSpacing, 500_000_000n);
  add(centerTick - 8 * tickSpacing, centerTick + 2 * tickSpacing, 400_000_000n);
  add(centerTick - 2 * tickSpacing, centerTick + 8 * tickSpacing, 400_000_000n);

  // Wide positions with big qty
  add(centerTick - 10 * tickSpacing, centerTick + 10 * tickSpacing, 300_000_000n);
  add(centerTick - 15 * tickSpacing, centerTick + 5 * tickSpacing, 300_000_000n);
  add(centerTick - 5 * tickSpacing, centerTick + 15 * tickSpacing, 300_000_000n);

  return positions;
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", CORE_ADDRESS);
  const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);

  const balance = await usdc.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  // Approve
  console.log(`Approving $${Number(APPROVE_AMOUNT) / 1e6} USDC...`);
  await (await usdc.approve(CORE_ADDRESS, APPROVE_AMOUNT)).wait();
  console.log("Approved.");

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  const anchors: Record<number, number> = { 23: 989, 24: 95, 25: 5105 };
  const grandTotals = { opened: 0, failed: 0, totalCost: 0n };

  for (const marketId of MARKET_IDS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`MARKET #${marketId} — ROUND 2`);
    console.log("=".repeat(60));

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
    console.log(`  Range: ${minTick}–${maxTick}, spacing=${tickSpacing}, bins=${numBins}`);
    console.log(`  Time remaining: ${Math.max(0, endTs - now)}s`);

    if (!isSeeded || settled || failed || now > endTs) {
      console.log("  SKIP: not tradeable");
      continue;
    }

    const positions = generateRound2Positions(minTick, maxTick, tickSpacing, numBins, anchors[marketId]);
    console.log(`  Generated ${positions.length} position specs`);

    let opened = 0;
    let failedCount = 0;
    let marketCost = 0n;

    for (let i = 0; i < positions.length; i++) {
      const { lower, upper, quantity } = positions[i];
      const binCount = (upper - lower) / tickSpacing;
      const maxCost = quantity * 5n + 50_000_000n; // bigger buffer for large positions

      const nowInner = Math.floor(Date.now() / 1000);
      if (nowInner > endTs) {
        console.log(`  TIME EXPIRED — stopping`);
        break;
      }

      try {
        const cost = await core.calculateOpenCost.staticCall(
          BigInt(marketId), BigInt(lower), BigInt(upper), quantity,
        );

        if (cost > maxCost) {
          console.log(`  [${i + 1}/${positions.length}] ${lower}–${upper} (${binCount}bins, $${Number(quantity)/1e6}) SKIP: cost=$${(Number(cost) / 1e6).toFixed(2)}`);
          failedCount++;
          continue;
        }

        const maxCostActual = cost + cost / 5n + 5_000_000n;
        const tx = await core.openPosition(
          BigInt(marketId), BigInt(lower), BigInt(upper), quantity, maxCostActual,
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

        opened++;
        marketCost += cost;
        console.log(`  [${i + 1}/${positions.length}] ${lower}–${upper} (${binCount}bins, $${Number(quantity)/1e6}) OK pos#${positionId} cost=$${(Number(cost) / 1e6).toFixed(2)}`);
      } catch (err: any) {
        failedCount++;
        const msg = err.message?.slice(0, 120) || "unknown error";
        console.log(`  [${i + 1}/${positions.length}] ${lower}–${upper} (${binCount}bins) FAIL: ${msg}`);
      }
    }

    console.log(`\n  Market #${marketId} R2: ${opened} opened, ${failedCount} failed, cost=$${(Number(marketCost) / 1e6).toFixed(2)}`);
    grandTotals.opened += opened;
    grandTotals.failed += failedCount;
    grandTotals.totalCost += marketCost;
  }

  const balanceAfter = await usdc.balanceOf(deployer.address);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`ROUND 2 TOTAL: ${grandTotals.opened} opened, ${grandTotals.failed} failed`);
  console.log(`Round 2 cost: $${(Number(grandTotals.totalCost) / 1e6).toFixed(2)}`);
  console.log(`USDC balance: $${(Number(balanceAfter) / 1e6).toFixed(2)}`);
  console.log(`USDC spent this round: $${(Number(balance - balanceAfter) / 1e6).toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
