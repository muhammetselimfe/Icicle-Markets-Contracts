import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const [deployer] = await ethers.getSigners();

  // Check current state
  const [bsBefore, trBefore] = await core.getCapitalStack();
  const bsNav = Number(bsBefore) / 1e18;
  console.log(`Current backstop: $${bsNav.toFixed(2)}`);

  const target = 40_000;
  const needed = target - bsNav;
  console.log(`Target: $${target}`);
  console.log(`Need to add: $${needed.toFixed(2)}`);

  // amount6 = USDC with 6 decimals
  const amount6 = BigInt(Math.ceil(needed)) * 1_000_000n;
  console.log(`Funding ${Number(amount6) / 1e6} USDC...`);

  // Approve USDC
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(deployer.address);
  console.log(`USDC balance: $${(Number(balance) / 1e6).toFixed(2)}`);

  const allowance = await payment.allowance(deployer.address, env.contracts.IcicleOptionsCoreProxy);
  if (allowance < amount6) {
    console.log("Approving...");
    await (await payment.approve(env.contracts.IcicleOptionsCoreProxy, amount6)).wait();
  }

  // Fund backstop
  const tx = await core.fundBackstop(amount6);
  await tx.wait();
  console.log("fundBackstop OK!");

  // Check after
  const [bsAfter, trAfter] = await core.getCapitalStack();
  console.log(`\nBackstop: $${(Number(bsAfter)/1e18).toFixed(2)}`);
  console.log(`Treasury: $${(Number(trAfter)/1e18).toFixed(2)}`);

  const navAfter = Number(await core.getVaultNav()) / 1e18;
  const bTarget = 0.30 * navAfter;
  console.log(`\nVault NAV: $${navAfter.toFixed(2)}`);
  console.log(`Backstop target (30% of NAV): $${bTarget.toFixed(2)}`);
  console.log(`Backstop surplus: $${(Number(bsAfter)/1e18 - bTarget).toFixed(2)}`);
  console.log(`\nTreasury should now receive fees on next batch!`);
}
main();
