import hre from "hardhat";
import { loadEnvironment, recordDeployment, updateContracts } from "../utils/environment";
import { writeReleaseSnapshot } from "../utils/release";
import type { Environment } from "../types/environment";

export async function upgradeAction(env: Environment) {
  const { ethers, upgrades, network } = hre;
  console.log(`[upgrade] environment=${env} network=${network.name}`);
  const [deployer] = await ethers.getSigners();
  const envData = loadEnvironment(env);

  const coreProxyAddr = envData.contracts.IcicleOptionsCoreProxy;
  const positionProxyAddr = envData.contracts.IcicleOptionsPositionProxy;
  const lpShareProxyAddr = envData.contracts.IcicleOptionsLPShareProxy ?? envData.contracts.IcicleOptionsLPShare;
  if (!coreProxyAddr || !positionProxyAddr) {
    throw new Error("Missing proxy addresses in environment file");
  }

  const coreFactory = await ethers.getContractFactory("IcicleOptionsCore");
  const upgradedCore = await upgrades.upgradeProxy(coreProxyAddr, coreFactory, {
    kind: "uups",
    unsafeAllow: ["delegatecall"],
  });
  await upgradedCore.waitForDeployment();
  const newCoreImpl = await upgrades.erc1967.getImplementationAddress(await upgradedCore.getAddress());

  const positionFactory = await ethers.getContractFactory("IcicleOptionsPosition");
  const upgradedPosition = await upgrades.upgradeProxy(positionProxyAddr, positionFactory, { kind: "uups" });
  await upgradedPosition.waitForDeployment();
  const newPositionImpl = await upgrades.erc1967.getImplementationAddress(await upgradedPosition.getAddress());

  let newLpShareImpl: string | undefined;
  if (lpShareProxyAddr) {
    const lpShareFactory = await ethers.getContractFactory("IcicleOptionsLPShare");
    const upgradedLpShare = await upgrades.upgradeProxy(lpShareProxyAddr, lpShareFactory, { kind: "uups" });
    await upgradedLpShare.waitForDeployment();
    newLpShareImpl = await upgrades.erc1967.getImplementationAddress(await upgradedLpShare.getAddress());
  }

  updateContracts(env, {
    IcicleOptionsCoreImplementation: newCoreImpl,
    IcicleOptionsPositionImplementation: newPositionImpl,
    ...(newLpShareImpl ? { IcicleOptionsLPShareImplementation: newLpShareImpl } : {}),
  });

  const { data: updatedEnv, record } = recordDeployment(env, {
    action: "upgrade",
    deployer: deployer.address,
  });
  writeReleaseSnapshot(env, updatedEnv);

  console.log(`[upgrade] completed (version=${record.version})`);
}
