import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const userAddr = "0x06200eC0Ea4E888EcfD6EB4F7Aec78e672d84370";
  const marketId = 52n;

  // Market info
  const m = await core.markets(marketId);
  const minTick = Number(m.minTick);
  const tickSpacing = Number(m.tickSpacing);
  const bins = Number(m.numBins);
  const now = Math.floor(Date.now() / 1000);
  const end = Number(m.endTimestamp);
  const start = Number(m.startTimestamp);

  console.log(`Market #52: minTick=${minTick}, spacing=${tickSpacing}, bins=${bins}`);
  console.log(`  start=${new Date(start*1000).toISOString()}, end=${new Date(end*1000).toISOString()}`);
  console.log(`  now=${new Date(now*1000).toISOString()}`);
  console.log(`  settled=${m.settled}, isSeeded=${m.isSeeded}`);
  console.log(`  trading active: ${now >= start && now < end}`);

  // User's range: $9.30-$9.60
  // minTick=745, spacing=5, so tick 930 = bin (930-745)/5 = 37, tick 960 = bin (960-745)/5 = 43
  const loBin = (930 - minTick) / tickSpacing;
  const hiBin = (960 - minTick) / tickSpacing - 1; // hiBin is inclusive
  console.log(`\nUser range: $9.30-$9.60 -> loBin=${loBin}, hiBin=${hiBin}`);

  // Check USDC balance and allowance
  const paymentAddr = await core.paymentToken();
  const usdc = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await usdc.balanceOf(userAddr);
  const allowance = await usdc.allowanceOf ? 0 : await usdc.allowance(userAddr, env.contracts.IcicleOptionsCoreProxy);
  console.log(`Balance: $${(Number(balance) / 1e6).toFixed(2)}`);
  console.log(`Allowance: $${(Number(allowance) / 1e6).toFixed(2)}`);

  // Try to simulate openPosition
  const qty = ethers.parseUnits("100", 18); // 100 WAD
  const maxCost = ethers.parseUnits("100", 6); // 100 USDC (6 decimals)

  console.log(`\nSimulating openPosition(${marketId}, ${loBin}, ${hiBin}, ${qty}, ${maxCost})...`);

  try {
    const result = await core.openPosition.staticCall(
      marketId, loBin, hiBin, qty, maxCost,
      { from: userAddr }
    );
    console.log(`SUCCESS: positionId=${result}`);
  } catch (e: any) {
    console.log(`REVERTED: ${e.message}`);

    // Try to decode error
    const msg = e.message || "";
    if (msg.includes("InsufficientAllowance")) console.log("  -> User needs to approve more USDC");
    if (msg.includes("InsufficientBalance")) console.log("  -> User doesn't have enough USDC");
    if (msg.includes("MarketNotActive")) console.log("  -> Market not active (trading window)");
    if (msg.includes("MarketNotSeeded")) console.log("  -> Market not seeded");
    if (msg.includes("CostExceedsMax")) console.log("  -> Cost exceeds maxCost parameter");
    if (msg.includes("InvalidBinRange")) console.log("  -> Invalid bin range");
  }

  // Also try with a smaller amount
  console.log(`\nTrying $10 instead...`);
  const qty2 = ethers.parseUnits("10", 18);
  const maxCost2 = ethers.parseUnits("10", 6);
  try {
    const result = await core.openPosition.staticCall(
      marketId, loBin, hiBin, qty2, maxCost2,
      { from: userAddr }
    );
    console.log(`SUCCESS: positionId=${result}`);
  } catch (e: any) {
    console.log(`REVERTED: ${e.message?.slice(0, 200)}`);
  }
}
main().catch(console.error);
