/**
 * Open 10 test positions at different price ranges on the latest Trading market.
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-test-positions.ts --network fuji
 *
 * Requires DEPLOYER_KEY in env or .env file.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const QUANTITY = 1_000_000n; // 1 USDC per position
const MAX_COST_BPS_BUFFER = 500; // 5% slippage buffer

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");

  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing core address in fuji.json");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Find latest market
  const nextId = await core.nextMarketId();
  const lastId = Number(nextId);
  if (lastId === 0) throw new Error("No markets exist");

  // Find the latest Trading market — check if endTimestamp is in the future
  let marketId = 0;
  const now = Math.floor(Date.now() / 1000);
  for (let id = lastId; id >= 1; id--) {
    const m = await core.markets(BigInt(id));
    const endTs = Number(m[9]);
    if (endTs > now) {
      marketId = id;
      break;
    }
  }
  if (marketId === 0) throw new Error("No active Trading market found");

  // Read market params
  const marketData = await core.markets(BigInt(marketId));
  const minTick = Number(marketData[12]); // minTick field index
  const maxTick = Number(marketData[13]); // maxTick field index
  const tickSpacing = Number(marketData[14]); // tickSpacing field index

  const isCentBased = (maxTick - minTick) > 50;
  const divisor = isCentBased ? 100 : 1;

  console.log(`\nMarket #${marketId}`);
  console.log(`  Range: $${(minTick / divisor).toFixed(2)} – $${(maxTick / divisor).toFixed(2)}`);
  console.log(`  Tick spacing: ${tickSpacing} (= $${(tickSpacing / divisor).toFixed(2)})`);

  // Get payment token (USDC)
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);

  // Pre-approve a generous amount
  const approveAmount = QUANTITY * 100n; // enough for all positions
  console.log(`\nApproving ${Number(approveAmount) / 1e6} USDC...`);
  await (await payment.approve(coreAddress, approveAmount)).wait();

  // Define 10 positions with varying ranges centered around the middle of the market
  const center = Math.round((minTick + maxTick) / 2 / tickSpacing) * tickSpacing;
  const positions = [
    // Narrow positions near center (higher probability density)
    { lower: center - tickSpacing * 1, upper: center + tickSpacing * 1, qty: QUANTITY * 3n },
    { lower: center, upper: center + tickSpacing * 2, qty: QUANTITY * 2n },
    { lower: center - tickSpacing * 2, upper: center, qty: QUANTITY * 2n },
    // Medium-width positions around center
    { lower: center - tickSpacing * 3, upper: center + tickSpacing * 3, qty: QUANTITY * 2n },
    { lower: center + tickSpacing * 1, upper: center + tickSpacing * 5, qty: QUANTITY },
    { lower: center - tickSpacing * 5, upper: center - tickSpacing * 1, qty: QUANTITY },
    // Wider positions
    { lower: center - tickSpacing * 8, upper: center + tickSpacing * 2, qty: QUANTITY },
    { lower: center - tickSpacing * 2, upper: center + tickSpacing * 8, qty: QUANTITY },
    // Tail positions (low probability, wide)
    { lower: minTick, upper: center - tickSpacing * 5, qty: QUANTITY },
    { lower: center + tickSpacing * 5, upper: maxTick, qty: QUANTITY },
  ];

  // Clamp all positions within market bounds
  const clamped = positions.map((p) => ({
    lower: Math.max(minTick, p.lower),
    upper: Math.min(maxTick, p.upper),
    qty: p.qty,
  })).filter((p) => p.lower < p.upper);

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  for (let i = 0; i < clamped.length; i++) {
    const { lower, upper, qty } = clamped[i];
    const lowerStr = `$${(lower / divisor).toFixed(2)}`;
    const upperStr = `$${(upper / divisor).toFixed(2)}`;

    try {
      // Calculate cost
      const cost = await core.calculateOpenCost.staticCall(
        BigInt(marketId), BigInt(lower), BigInt(upper), qty,
      );
      const maxCost = cost + (cost * BigInt(MAX_COST_BPS_BUFFER)) / 10000n + 1n;

      console.log(`\n[${i + 1}/10] ${lowerStr} – ${upperStr} | qty=${Number(qty) / 1e6} USDC | cost≈$${(Number(cost) / 1e6).toFixed(4)}`);

      const tx = await core.openPosition(
        BigInt(marketId), BigInt(lower), BigInt(upper), qty, maxCost,
      );
      const receipt = await tx.wait();

      // Extract positionId from event
      let positionId: string = "?";
      for (const log of receipt?.logs ?? []) {
        try {
          const parsed = tradeIface.parseLog(log);
          if (parsed?.name === "PositionOpened") {
            positionId = parsed.args.positionId.toString();
            break;
          }
        } catch {
          // ignore
        }
      }

      console.log(`  ✓ Position #${positionId} | tx: ${tx.hash}`);
    } catch (err: any) {
      console.error(`  ✗ Failed: ${err.message?.slice(0, 100)}`);
    }
  }

  console.log("\nDone! 10 positions opened across different price ranges.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
