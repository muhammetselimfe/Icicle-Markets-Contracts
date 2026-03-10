import hre from "hardhat";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name);
  const envData = loadEnvironment(env);

  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) {
    throw new Error(`Missing IcicleOptionsCoreProxy in ${env} environment file`);
  }

  const submitRaw = envData.config?.settlementSubmitWindow;
  const opsRaw = envData.config?.pendingOpsWindow;
  const claimRaw = envData.config?.settlementFinalizeDeadline;
  if (!submitRaw || !opsRaw || !claimRaw) {
    throw new Error(`Missing settlement timeline config in ${env} environment file`);
  }

  const submitWindow = BigInt(submitRaw);
  const opsWindow = BigInt(opsRaw);
  const claimDelay = BigInt(claimRaw);

  if (claimDelay !== submitWindow + opsWindow) {
    throw new Error(
      `Invalid timeline invariant: submit=${submitWindow} ops=${opsWindow} claim=${claimDelay}`
    );
  }

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const tx = await core.setSettlementTimeline(submitWindow, opsWindow, claimDelay);
  await tx.wait();
  console.log(
    `[set-timeline] env=${env} submit=${submitWindow} ops=${opsWindow} claim=${claimDelay}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
