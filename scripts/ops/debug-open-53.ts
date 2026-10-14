import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const [deployer] = await ethers.getSigners();

  const marketId = 53n;
  const lowerTick = 930n;
  const upperTick = 960n;
  const qty = 193750000n; // exact value from frontend log
  const maxCost = 100766575n; // exact value from frontend log

  const m = await core.markets(marketId);
  console.log(`Market #53: minTick=${m.minTick}, maxTick=${m.maxTick}, spacing=${m.tickSpacing}`);
  console.log(`  isSeeded=${m.isSeeded}, settled=${m.settled}`);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  console.log(`  blockTime=${now}, start=${m.startTimestamp}, end=${m.endTimestamp}`);
  console.log(`  started=${now >= Number(m.startTimestamp)}, ended=${now >= Number(m.endTimestamp)}`);

  // Check deployer USDC
  const paymentAddr = await core.paymentToken();
  const usdc = await ethers.getContractAt("IERC20", paymentAddr);
  const bal = await usdc.balanceOf(deployer.address);
  const allow = await usdc.allowance(deployer.address, env.contracts.IcicleOptionsCoreProxy);
  console.log(`\nDeployer USDC: bal=$${(Number(bal)/1e6).toFixed(2)}, allowance=$${(Number(allow)/1e6).toFixed(2)}`);

  // Test staticCall with exact frontend params
  console.log(`\nstaticCall openPosition(53, 930, 960, ${qty}, ${maxCost})...`);
  try {
    const result = await core.openPosition.staticCall(marketId, lowerTick, upperTick, qty, maxCost);
    console.log(`SUCCESS: positionId=${result}`);
  } catch (e: any) {
    try {
      const decoded = core.interface.parseError(e.data);
      console.log(`REVERT: ${decoded?.name}(${decoded?.args.join(", ")})`);
    } catch {
      console.log(`REVERT: ${e.message?.slice(0, 300)}`);
    }
  }

  // Test with small amount too
  console.log(`\nstaticCall openPosition(53, 930, 960, 1000000, 1000000)...`);
  try {
    const result = await core.openPosition.staticCall(marketId, lowerTick, upperTick, 1000000n, 1000000n);
    console.log(`SUCCESS: positionId=${result}`);
  } catch (e: any) {
    try {
      const decoded = core.interface.parseError(e.data);
      console.log(`REVERT: ${decoded?.name}(${decoded?.args.join(", ")})`);
    } catch {
      console.log(`REVERT: ${e.message?.slice(0, 300)}`);
    }
  }
}
main().catch(console.error);
