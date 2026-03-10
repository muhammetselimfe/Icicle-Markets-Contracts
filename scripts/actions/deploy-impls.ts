import hre from "hardhat";
import { loadEnvironment, recordDeployment, updateContracts } from "../utils/environment";
import { writeReleaseSnapshot } from "../utils/release";
import type { Environment } from "../types/environment";

export async function deployImplsAction(env: Environment) {
  const { ethers, network } = hre;
  console.log(`[deploy-impls] environment=${env} network=${network.name}`);
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const envData = loadEnvironment(env);

  let create2FactoryAddress =
    envData.contracts.IcicleOptionsCreate2Factory ?? envData.contracts.Create2Factory;
  if (!create2FactoryAddress) {
    const factory = await (
      await ethers.getContractFactory("IcicleOptionsCreate2Factory")
    ).deploy(deployer.address);
    await factory.waitForDeployment();
    create2FactoryAddress = factory.target.toString();
  }

  const factoryCode = await ethers.provider.getCode(create2FactoryAddress);
  if (factoryCode === "0x") {
    throw new Error(`IcicleOptionsCreate2Factory has no code at ${create2FactoryAddress}`);
  }

  const coreImpl = await (await ethers.getContractFactory("IcicleOptionsCore")).deploy();
  await coreImpl.waitForDeployment();

  const positionImpl = await (
    await ethers.getContractFactory("IcicleOptionsPosition")
  ).deploy();
  await positionImpl.waitForDeployment();

  const lpShareImpl = await (await ethers.getContractFactory("IcicleOptionsLPShare")).deploy();
  await lpShareImpl.waitForDeployment();

  updateContracts(env, {
    IcicleOptionsCreate2Factory: create2FactoryAddress,
    IcicleOptionsCoreImplementation: coreImpl.target.toString(),
    IcicleOptionsPositionImplementation: positionImpl.target.toString(),
    IcicleOptionsLPShareImplementation: lpShareImpl.target.toString(),
  });

  const { data: envSnapshot, record } = recordDeployment(env, {
    action: "deploy-impls",
    deployer: deployer.address,
  });
  writeReleaseSnapshot(env, envSnapshot);

  console.log(`[deploy-impls] completed (version=${record.version})`);
}
