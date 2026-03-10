import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

const AMOUNT_ENV = "SEED_VAULT_AMOUNT_USD";

function parseAmount(value?: string): bigint {
  if (!value) {
    throw new Error(`Missing ${AMOUNT_ENV} (expected human USD amount, 6 decimals)`);
  }
  return hre.ethers.parseUnits(value, 6);
}

export async function seedVaultAction(env: Environment) {
  const { ethers, network } = hre;
  console.log(`[seed-vault] environment=${env} network=${network.name}`);
  const [deployer] = await ethers.getSigners();

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const paymentTokenAddress = envData.contracts.PaymentToken;
  if (!paymentTokenAddress) throw new Error("Missing PaymentToken (payment token) in environment file");

  const amount6 = parseAmount(process.env[AMOUNT_ENV]);
  if (amount6 <= 0n) throw new Error(`${AMOUNT_ENV} must be > 0`);

  const payment = new ethers.Contract(
    paymentTokenAddress,
    ["function decimals() view returns (uint8)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    deployer
  );
  const decimals = Number(await payment.decimals());
  if (decimals !== 6) {
    throw new Error(`paymentToken.decimals must be 6 (got ${decimals})`);
  }

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const seeded = await core.isVaultSeeded();
  if (seeded) {
    console.log("[seed-vault] vault already seeded; skipping");
    return;
  }

  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < amount6) {
    await (await payment.approve(coreAddress, amount6)).wait();
  }

  await (await core.seedVault(amount6)).wait();
  console.log(`[seed-vault] seeded ${amount6.toString()} (6 decimals)`);
}
