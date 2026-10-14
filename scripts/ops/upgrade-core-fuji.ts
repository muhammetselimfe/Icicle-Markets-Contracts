// Surgical Core-proxy upgrade for the v2 rollout on Fuji.
// The Fuji proxy was deployed via the custom Create2 deployer, so it isn't in the
// OZ upgrades manifest -> forceImport registers it, then we upgrade ONLY the Core
// (the only contract changed for v2; Position/LPShare are untouched).
//
// Safety: validateUpgrade runs the storage-layout check before sending the tx.
// Our change is append-only (Market struct fields; no top-level storage change),
// which is an OZ-safe operation.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers, upgrades } = hre;
  const env = loadEnvironment("fuji");
  const coreProxy = env.contracts.IcicleOptionsCoreProxy;
  const [deployer] = await ethers.getSigners();
  console.log(`[upgrade-core] proxy=${coreProxy} deployer=${deployer.address}`);

  const factory = await ethers.getContractFactory("IcicleOptionsCore");

  // 1) register the existing proxy in the OZ manifest (deployed outside the plugin)
  console.log("[upgrade-core] forceImport...");
  await upgrades.forceImport(coreProxy, factory, { kind: "uups" });

  // 2) storage-layout validation gate (append-only must pass)
  console.log("[upgrade-core] validateUpgrade...");
  await upgrades.validateUpgrade(coreProxy, factory, { kind: "uups", unsafeAllow: ["delegatecall"] });
  console.log("[upgrade-core] storage layout OK");

  // 3) upgrade
  console.log("[upgrade-core] upgradeProxy...");
  const upgraded = await upgrades.upgradeProxy(coreProxy, factory, { kind: "uups", unsafeAllow: ["delegatecall"] });
  await upgraded.waitForDeployment();
  const impl = await upgrades.erc1967.getImplementationAddress(coreProxy);
  console.log(`[upgrade-core] done. new implementation=${impl}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
