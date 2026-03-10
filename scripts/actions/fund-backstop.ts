import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

const AMOUNT_ENV = "FUND_BACKSTOP_AMOUNT_USD";

function parseAmount(value?: string): bigint {
  if (!value) {
    throw new Error(`Missing ${AMOUNT_ENV} (expected human USD amount, 6 decimals)`);
  }
  return hre.ethers.parseUnits(value, 6);
}

export async function fundBackstopAction(env: Environment) {
  const { ethers, network } = hre;
  console.log(`[fund-backstop] environment=${env} network=${network.name}`);
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
  const [backstopNav] = await core.getCapitalStack();
  if (backstopNav > 0n) {
    console.log(`[fund-backstop] backstop already funded (nav=${backstopNav.toString()}); skipping`);
    return;
  }

  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < amount6) {
    await (await payment.approve(coreAddress, amount6)).wait();
  }

  await (await core.fundBackstop(amount6)).wait();
  console.log(`[fund-backstop] funded ${amount6.toString()} (6 decimals)`);
}
