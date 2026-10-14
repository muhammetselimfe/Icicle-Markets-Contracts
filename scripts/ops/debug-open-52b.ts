import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const [deployer] = await ethers.getSigners();

  const marketId = 52n;
  const minTick = 745;
  const tickSpacing = 5;

  // $9.30-$9.60 range
  const loBin = (930 - minTick) / tickSpacing; // 37
  const hiBin = (960 - minTick) / tickSpacing - 1; // 42

  console.log(`loBin=${loBin}, hiBin=${hiBin}`);

  // Check deployer balance
  const paymentAddr = await core.paymentToken();
  const usdc = await ethers.getContractAt("IERC20", paymentAddr);
  const bal = await usdc.balanceOf(deployer.address);
  const allow = await usdc.allowance(deployer.address, env.contracts.IcicleOptionsCoreProxy);
  console.log(`Deployer balance: $${(Number(bal)/1e6).toFixed(2)}, allowance: $${(Number(allow)/1e6).toFixed(2)}`);

  // Try $5 trade
  const qty = ethers.parseUnits("5", 18);
  const maxCost = ethers.parseUnits("5", 6);

  console.log(`\nSimulating $5 openPosition from deployer...`);
  try {
    const result = await core.openPosition.staticCall(marketId, loBin, hiBin, qty, maxCost);
    console.log(`SUCCESS: positionId=${result}`);
  } catch (e: any) {
    console.log(`REVERTED: ${e.message?.slice(0, 300)}`);
  }

  // Try $100 trade
  const qty2 = ethers.parseUnits("100", 18);
  const maxCost2 = ethers.parseUnits("100", 6);

  console.log(`\nSimulating $100 openPosition from deployer...`);
  try {
    const result = await core.openPosition.staticCall(marketId, loBin, hiBin, qty2, maxCost2);
    console.log(`SUCCESS: positionId=${result}`);
  } catch (e: any) {
    console.log(`REVERTED: ${e.message?.slice(0, 300)}`);
  }

  // Check what the actual cost would be using quote
  try {
    const cost = await core.quoteCost(marketId, loBin, hiBin, qty2);
    console.log(`\nQuoted cost for 100 WAD in bins ${loBin}-${hiBin}: $${(Number(cost)/1e6).toFixed(4)}`);
  } catch (e: any) {
    console.log(`quoteCost failed: ${e.message?.slice(0, 200)}`);
  }
}
main().catch(console.error);
