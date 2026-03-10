/**
 * Open a single position costing ~100 USDC near current price.
 * Usage: npx hardhat run scripts/ops/open-single-100usd.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const TARGET_COST = 100_000_000n; // 100 USDC (6 decimals)
const SLIPPAGE_BPS = 500n; // 5%

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing core address");

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
  if (marketId === 0) throw new Error("No active market found");

  const mkt = await core.markets(BigInt(marketId));
  const minTick = Number(mkt[12]);
  const maxTick = Number(mkt[13]);
  const tickSpacing = Number(mkt[14]);
  const alpha = mkt[17];
  const isCentBased = (maxTick - minTick) > 50;
  const d = isCentBased ? 100 : 1;

  console.log(`\nMarket #${marketId}`);
  console.log(`  Range: $${(minTick / d).toFixed(2)} – $${(maxTick / d).toFixed(2)}, spacing=$${(tickSpacing / d).toFixed(2)}`);
  console.log(`  Alpha (liquidityParameter): ${ethers.formatEther(alpha)} WAD`);

  // Use a medium range around center (~current price area)
  // $8.70 – $9.10 = 8 bins for AVAX cents
  const lower = BigInt(870);
  const upper = BigInt(910);
  console.log(`\nTarget range: $${(Number(lower) / d).toFixed(2)} – $${(Number(upper) / d).toFixed(2)}`);

  // Probe cost at small quantity
  const probeQty = 1_000_000n; // 1 unit
  const probeCost = await core.calculateOpenCost.staticCall(BigInt(marketId), lower, upper, probeQty);
  console.log(`  Probe: qty=1 → cost=$${(Number(probeCost) / 1e6).toFixed(4)}`);

  // Find max valid quantity by doubling
  let validQty = probeQty;
  let validCost = probeCost;
  for (let i = 0; i < 30; i++) {
    const tryQty = validQty * 2n;
    try {
      const c = await core.calculateOpenCost.staticCall(BigInt(marketId), lower, upper, tryQty);
      validQty = tryQty;
      validCost = c;
      console.log(`  Double: qty=${(Number(validQty) / 1e6).toFixed(2)} → cost=$${(Number(validCost) / 1e6).toFixed(2)}`);
      if (c >= TARGET_COST) break;
    } catch (e: any) {
      console.log(`  Double: qty=${(Number(tryQty) / 1e6).toFixed(2)} → REVERTS (${e.message?.slice(0, 80)})`);
      // Binary search between validQty and tryQty to find true max
      let bLo = validQty;
      let bHi = tryQty;
      for (let j = 0; j < 15; j++) {
        const mid = (bLo + bHi) / 2n;
        if (mid <= bLo) break;
        try {
          const c = await core.calculateOpenCost.staticCall(BigInt(marketId), lower, upper, mid);
          bLo = mid;
          validQty = mid;
          validCost = c;
        } catch {
          bHi = mid;
        }
      }
      console.log(`  Max valid: qty=${(Number(validQty) / 1e6).toFixed(2)} → cost=$${(Number(validCost) / 1e6).toFixed(2)}`);
      break;
    }
  }

  if (validCost < TARGET_COST) {
    console.log(`\n⚠ Cannot spend $100 — max cost for this range is $${(Number(validCost) / 1e6).toFixed(2)}`);
    console.log(`  Using max quantity instead: ${(Number(validQty) / 1e6).toFixed(2)} units`);
  }

  // Binary search for target cost if we can reach it
  let bestQty = validQty;
  let bestCost = validCost;
  if (validCost >= TARGET_COST) {
    let lo = probeQty;
    let hi = validQty;
    for (let i = 0; i < 25; i++) {
      const mid = (lo + hi) / 2n;
      if (mid <= lo || mid >= hi) break;
      try {
        const c = await core.calculateOpenCost.staticCall(BigInt(marketId), lower, upper, mid);
        const diff = c > TARGET_COST ? c - TARGET_COST : TARGET_COST - c;
        const bestDiff = bestCost > TARGET_COST ? bestCost - TARGET_COST : TARGET_COST - bestCost;
        if (diff < bestDiff) { bestQty = mid; bestCost = c; }
        if (diff <= 2_000_000n) break; // within $2
        if (c > TARGET_COST) hi = mid; else lo = mid;
      } catch { hi = mid; }
    }
  }

  console.log(`\nFinal: qty=${(Number(bestQty) / 1e6).toFixed(2)} → cost=$${(Number(bestCost) / 1e6).toFixed(2)}`);

  // Approve USDC
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const maxCost = bestCost + (bestCost * SLIPPAGE_BPS) / 10000n + 1n;
  console.log(`Approving $${(Number(maxCost) / 1e6).toFixed(2)}...`);
  await (await payment.approve(coreAddress, maxCost)).wait();

  // Open position
  console.log(`\nOpening position...`);
  const tx = await core.openPosition(BigInt(marketId), lower, upper, bestQty, maxCost);
  const receipt = await tx.wait();

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = tradeIface.parseLog(log);
      if (parsed?.name === "PositionOpened") {
        console.log(`\n✓ Position #${parsed.args.positionId}`);
        console.log(`  Cost: $${(Number(parsed.args.cost) / 1e6).toFixed(2)}`);
        console.log(`  Qty: ${(Number(parsed.args.quantity) / 1e6).toFixed(2)}`);
        console.log(`  Tx: ${tx.hash}`);
        break;
      }
    } catch { /* ignore */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
