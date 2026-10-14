import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const marketId = 51n;
  const lower = 960n;  // $9.60
  const upper = 965n;  // $9.65

  // Check market state
  const m = await core.markets(marketId);
  const now = Math.floor(Date.now() / 1000);
  console.log(`Market #51: seeded=${m.isSeeded}, settled=${m.settled}`);
  console.log(`Now: ${now}, start: ${m.startTimestamp}, end: ${m.endTimestamp}`);
  console.log(`Trading active: ${now >= Number(m.startTimestamp) && now < Number(m.endTimestamp)}`);
  console.log(`Alpha: ${Number(m.liquidityParameter)/1e18}`);
  console.log(`Range: ${m.minTick}–${m.maxTick}, spacing=${m.tickSpacing}\n`);

  // Try to calculate cost first
  const qty = 1_000_000n; // small probe
  try {
    const cost = await core.calculateOpenCost.staticCall(marketId, lower, upper, qty);
    console.log(`calculateOpenCost(qty=1e6): $${(Number(cost)/1e6).toFixed(4)}`);
  } catch (e: any) {
    console.log(`calculateOpenCost failed: ${e.message?.slice(0, 200)}`);
  }

  // Find qty for $100
  const target = 100_000_000n; // $100
  try {
    const probeCost = await core.calculateOpenCost.staticCall(marketId, lower, upper, 1_000_000n);
    const estQty = (1_000_000n * target) / probeCost;
    console.log(`\nEstimated qty for $100: ${estQty}`);

    const actualCost = await core.calculateOpenCost.staticCall(marketId, lower, upper, estQty);
    console.log(`Actual cost at that qty: $${(Number(actualCost)/1e6).toFixed(2)}`);

    // Now try the actual openPosition
    const maxCost = actualCost + (actualCost * 500n) / 10000n + 1n;
    console.log(`\nTrying openPosition(${marketId}, ${lower}, ${upper}, ${estQty}, maxCost=$${(Number(maxCost)/1e6).toFixed(2)})...`);

    const result = await core.openPosition.staticCall(marketId, lower, upper, estQty, maxCost);
    console.log(`staticCall passed! positionId=${result}`);
  } catch (e: any) {
    console.log(`\nError: ${e.message?.slice(0, 300)}`);
    if (e.data) {
      console.log(`Error data: ${e.data}`);
      // Try decoding common errors
      const errorsAbi = [
        "error AlphaExceedsLimit(uint256 marketId)",
        "error MarketNotActive(uint256 marketId)",
        "error MarketNotSeeded(uint256 marketId)",
        "error InsufficientPayment(uint256 required, uint256 provided)",
        "error InvalidTickRange(int256 lower, int256 upper)",
        "error SlippageExceeded(uint256 cost, uint256 maxCost)",
      ];
      try {
        const iface = new ethers.Interface(errorsAbi);
        const decoded = iface.parseError(e.data);
        console.log(`Decoded: ${decoded?.name}(${decoded?.args.join(", ")})`);
      } catch {}
    }
  }
}
main().catch(console.error);
