import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

// Deploys new implementations/modules to prod and prints Safe-ready calldata.
// Does NOT attempt any owner-only state changes (Safe will execute those).
async function main() {
  const env = "prod" as const;
  const { ethers, network } = hre;

  if (network.name !== env) {
    throw new Error(`Network mismatch: expected --network ${env} got ${network.name}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("Missing deployer signer. Ensure DEPLOYER_KEY is set.");
  }

  const envData = loadEnvironment(env);
  const coreProxy = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreProxy) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const existingTrade = envData.contracts.TradeModule;
  const existingOracle = envData.contracts.OracleModule;
  const existingRisk = envData.contracts.RiskModule;
  const existingVault = envData.contracts.LPVaultModule ?? envData.contracts.VaultModule;
  const existingLazy = envData.contracts.LazyMulSegmentTree;

  if (!existingTrade) throw new Error("Missing TradeModule in environment file");
  if (!existingOracle) throw new Error("Missing OracleModule in environment file");
  if (!existingRisk) throw new Error("Missing RiskModule in environment file");
  if (!existingVault) throw new Error("Missing LPVaultModule/VaultModule in environment file");
  if (!existingLazy) throw new Error("Missing LazyMulSegmentTree in environment file");

  const chain = await ethers.provider.getNetwork();
  console.log(`[hotfix-deploy] env=${env} network=${network.name} chainId=${chain.chainId.toString()}`);
  console.log(`[hotfix-deploy] deployer=${deployer.address}`);
  console.log(`[hotfix-deploy] coreProxy=${coreProxy}`);
  console.log("[hotfix-deploy] existing modules:");
  console.log(`  TradeModule=${existingTrade}`);
  console.log(`  MarketLifecycleModule=${envData.contracts.MarketLifecycleModule ?? "MISSING"}`);
  console.log(`  RiskModule=${existingRisk}`);
  console.log(`  LPVaultModule=${existingVault}`);
  console.log(`  OracleModule=${existingOracle}`);
  console.log(`  LazyMulSegmentTree=${existingLazy}`);

  // 1) Deploy new Core implementation (UUPS).
  const coreImpl = await (await ethers.getContractFactory("IcicleOptionsCore")).deploy();
  await coreImpl.waitForDeployment();
  const coreImplAddr = coreImpl.target.toString();
  console.log(`[hotfix-deploy] new IcicleOptionsCore implementation=${coreImplAddr}`);

  // 2) Deploy new MarketLifecycleModule linked against existing LazyMulSegmentTree.
  const lifecycleModule = await (
    await ethers.getContractFactory("MarketLifecycleModule", {
      libraries: { LazyMulSegmentTree: existingLazy },
    })
  ).deploy();
  await lifecycleModule.waitForDeployment();
  const lifecycleAddr = lifecycleModule.target.toString();
  console.log(`[hotfix-deploy] new MarketLifecycleModule=${lifecycleAddr}`);

  // 3) Deploy new LPVaultModule.
  const vaultModule = await (await ethers.getContractFactory("LPVaultModule")).deploy();
  await vaultModule.waitForDeployment();
  const vaultAddr = vaultModule.target.toString();
  console.log(`[hotfix-deploy] new LPVaultModule=${vaultAddr}`);

  // Safe calldata: interact with the CORE PROXY address using the IcicleOptionsCore ABI.
  const coreIface = (await ethers.getContractFactory("IcicleOptionsCore")).interface;

  const setModulesCalldata = coreIface.encodeFunctionData("setModules", [
    existingTrade,
    lifecycleAddr,
    existingRisk,
    vaultAddr,
    existingOracle,
  ]);

  // Recommended: atomic upgrade + setModules (single Safe tx, no pause).
  const upgradeAndSetModulesCalldata = coreIface.encodeFunctionData("upgradeToAndCall", [
    coreImplAddr,
    setModulesCalldata,
  ]);

  console.log("");
  console.log("[SAFE TX 1] atomic upgrade + setModules (recommended)");
  console.log(`  to:    ${coreProxy}`);
  console.log("  value: 0");
  console.log(`  data:  ${upgradeAndSetModulesCalldata}`);
  console.log("  decoded:");
  console.log(`    upgradeToAndCall(newImpl=${coreImplAddr}, data=setModules(...))`);

  console.log("");
  console.log("[SAFE TX 2] setModules (optional, if not using SAFE TX 1)");
  console.log(`  to:    ${coreProxy}`);
  console.log("  value: 0");
  console.log(`  data:  ${setModulesCalldata}`);
  console.log("  decoded:");
  console.log(
    `    setModules(trade=${existingTrade}, lifecycle=${lifecycleAddr}, risk=${existingRisk}, vault=${vaultAddr}, oracle=${existingOracle})`
  );

  console.log("");
  console.log("[hotfix-deploy] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
