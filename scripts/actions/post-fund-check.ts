import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

export async function postFundCheckAction(env: Environment) {
  const { ethers, network } = hre;
  console.log(`[post-fund-check] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const seeded = await core.isVaultSeeded();
  if (!seeded) throw new Error("Vault is not seeded");

  const [backstopNav, treasuryNav] = await core.getCapitalStack();
  if (backstopNav === 0n) {
    throw new Error("Backstop NAV is zero");
  }

  console.log(`[post-fund-check] seeded=${seeded} backstop=${backstopNav} treasury=${treasuryNav}`);
}
