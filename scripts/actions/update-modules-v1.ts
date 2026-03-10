import hre from "hardhat";
import { loadEnvironment, recordDeployment, updateContracts } from "../utils/environment";
import { writeReleaseSnapshot } from "../utils/release";
import type { Environment } from "../types/environment";

type ModuleKey = "TradeModule" | "MarketLifecycleModule" | "OracleModule" | "RiskModule" | "LPVaultModule";

const MODULE_ALIASES: Record<string, ModuleKey> = {
  trade: "TradeModule",
  trademodule: "TradeModule",
  lifecycle: "MarketLifecycleModule",
  marketlifecycle: "MarketLifecycleModule",
  marketlifecyclemodule: "MarketLifecycleModule",
  oracle: "OracleModule",
  oraclemodule: "OracleModule",
  risk: "RiskModule",
  riskmodule: "RiskModule",
  vault: "LPVaultModule",
  lpvault: "LPVaultModule",
  lpvaultmodule: "LPVaultModule",
};

function parseModulesToUpdate(): Set<ModuleKey> {
  const raw = process.env.MODULES;
  if (!raw) {
    return new Set<ModuleKey>(["TradeModule", "MarketLifecycleModule", "OracleModule"]);
  }
  const result = new Set<ModuleKey>();
  for (const entry of raw.split(",")) {
    const normalized = entry.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!normalized) continue;
    const moduleName = MODULE_ALIASES[normalized];
    if (!moduleName) {
      throw new Error(`Unknown module "${entry}". Expected trade, lifecycle, oracle, risk, vault.`);
    }
    result.add(moduleName);
  }
  if (!result.size) {
    throw new Error("MODULES is set but no valid entries were provided");
  }
  return result;
}

export async function updateModulesAction(env: Environment) {
  const { ethers, network } = hre;
  console.log(`[update-modules] environment=${env} network=${network.name}`);
  const [deployer] = await ethers.getSigners();

  const envData = loadEnvironment(env);
  const coreProxyAddr = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreProxyAddr) {
    throw new Error("Missing IcicleOptionsCoreProxy in environment file");
  }

  const modulesToUpdate = parseModulesToUpdate();
  const updateTrade = modulesToUpdate.has("TradeModule");
  const updateLifecycle = modulesToUpdate.has("MarketLifecycleModule");
  const updateOracle = modulesToUpdate.has("OracleModule");
  const updateRisk = modulesToUpdate.has("RiskModule");
  const updateVault = modulesToUpdate.has("LPVaultModule");

  let lazyAddress = envData.contracts.LazyMulSegmentTree;
  if (updateTrade || updateLifecycle) {
    const lazy = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();
    await lazy.waitForDeployment();
    lazyAddress = lazy.target.toString();
  }

  let tradeModuleAddr = envData.contracts.TradeModule;
  if (updateTrade) {
    if (!lazyAddress) throw new Error("LazyMulSegmentTree is required for TradeModule deployment");
    const tradeModule = await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyAddress },
      })
    ).deploy();
    await tradeModule.waitForDeployment();
    tradeModuleAddr = tradeModule.target.toString();
  } else if (!tradeModuleAddr) {
    throw new Error("Missing TradeModule address in environment file");
  }

  let lifecycleModuleAddr = envData.contracts.MarketLifecycleModule;
  if (updateLifecycle) {
    if (!lazyAddress) throw new Error("LazyMulSegmentTree is required for MarketLifecycleModule deployment");
    const lifecycleModule = await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazyAddress },
      })
    ).deploy();
    await lifecycleModule.waitForDeployment();
    lifecycleModuleAddr = lifecycleModule.target.toString();
  } else if (!lifecycleModuleAddr) {
    throw new Error("Missing MarketLifecycleModule address in environment file");
  }

  let oracleModuleAddr = envData.contracts.OracleModule;
  if (updateOracle) {
    const oracleModule = await (await ethers.getContractFactory("OracleModule")).deploy();
    await oracleModule.waitForDeployment();
    oracleModuleAddr = oracleModule.target.toString();
  } else if (!oracleModuleAddr) {
    throw new Error("Missing OracleModule address in environment file");
  }

  let riskModuleAddr = envData.contracts.RiskModule ?? ethers.ZeroAddress;
  if (updateRisk) {
    const riskModule = await (await ethers.getContractFactory("RiskModule")).deploy();
    await riskModule.waitForDeployment();
    riskModuleAddr = riskModule.target.toString();
  }

  let vaultModuleAddr = envData.contracts.LPVaultModule ?? envData.contracts.VaultModule ?? ethers.ZeroAddress;
  if (updateVault) {
    const vaultModule = await (await ethers.getContractFactory("LPVaultModule")).deploy();
    await vaultModule.waitForDeployment();
    vaultModuleAddr = vaultModule.target.toString();
  }

  const core = await ethers.getContractAt("IcicleOptionsCore", coreProxyAddr);
  const modulesTx = await core.setModules(
    tradeModuleAddr,
    lifecycleModuleAddr,
    riskModuleAddr,
    vaultModuleAddr,
    oracleModuleAddr
  );
  await modulesTx.wait();

  const updatedContracts = {
    TradeModule: tradeModuleAddr,
    MarketLifecycleModule: lifecycleModuleAddr,
    OracleModule: oracleModuleAddr,
    ...(lazyAddress ? { LazyMulSegmentTree: lazyAddress } : {}),
    ...(updateRisk ? { RiskModule: riskModuleAddr } : {}),
    ...(updateVault ? { LPVaultModule: vaultModuleAddr } : {}),
  };
  updateContracts(env, updatedContracts);

  const { data: updatedEnv, record } = recordDeployment(env, {
    action: "update-modules",
    deployer: deployer.address,
  });
  writeReleaseSnapshot(env, updatedEnv);

  console.log(`[update-modules] completed (version=${record.version})`);
}
