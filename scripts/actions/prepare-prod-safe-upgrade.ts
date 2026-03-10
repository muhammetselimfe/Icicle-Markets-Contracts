import fs from "fs";
import path from "path";
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

type ModuleKey =
  | "TradeModule"
  | "MarketLifecycleModule"
  | "OracleModule"
  | "RiskModule"
  | "LPVaultModule";

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

const DEFAULT_MODULES: ModuleKey[] = [
  "TradeModule",
  "MarketLifecycleModule",
  "LPVaultModule",
];

function parseModulesToDeploy(): Set<ModuleKey> {
  const raw = process.env.MODULES;
  if (!raw) return new Set<ModuleKey>(DEFAULT_MODULES);

  const out = new Set<ModuleKey>();
  for (const piece of raw.split(",")) {
    const key = piece.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key) continue;
    const moduleName = MODULE_ALIASES[key];
    if (!moduleName) {
      throw new Error(
        `Unknown module "${piece}". Expected trade,lifecycle,oracle,risk,vault`
      );
    }
    out.add(moduleName);
  }
  if (!out.size) {
    throw new Error("MODULES is set but no valid module key was parsed");
  }
  return out;
}

function requireAddress(
  value: string | undefined,
  label: string
): string {
  if (!value) {
    throw new Error(`Missing ${label} in environment file`);
  }
  return value;
}

function getTimestampTag(now: Date): string {
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}Z`;
}

function printCopyBlock(label: string, value: string): void {
  console.log("");
  console.log(`----- COPY ${label} -----`);
  console.log(value);
  console.log(`----- END ${label} -----`);
}

function writeCopyFile(
  dir: string,
  fileName: string,
  value: string
): void {
  fs.writeFileSync(path.join(dir, fileName), `${value}\n`);
}

async function main() {
  const env = "prod" as const;
  const { ethers, network } = hre;
  if (network.name !== env) {
    throw new Error(`Network mismatch: expected --network ${env}, got ${network.name}`);
  }

  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== 4114) {
    throw new Error(`ChainId mismatch: expected 4114, got ${chainId}`);
  }

  const envData = loadEnvironment(env);
  const modulesToDeploy = parseModulesToDeploy();
  const deployTrade = modulesToDeploy.has("TradeModule");
  const deployLifecycle = modulesToDeploy.has("MarketLifecycleModule");
  const deployOracle = modulesToDeploy.has("OracleModule");
  const deployRisk = modulesToDeploy.has("RiskModule");
  const deployVault = modulesToDeploy.has("LPVaultModule");

  const coreProxy = requireAddress(envData.contracts.IcicleOptionsCoreProxy, "IcicleOptionsCoreProxy");
  const existingTrade = requireAddress(envData.contracts.TradeModule, "TradeModule");
  const existingLifecycle = requireAddress(
    envData.contracts.MarketLifecycleModule,
    "MarketLifecycleModule"
  );
  const existingOracle = requireAddress(envData.contracts.OracleModule, "OracleModule");
  const existingRisk = requireAddress(envData.contracts.RiskModule, "RiskModule");
  const existingVault = requireAddress(
    envData.contracts.LPVaultModule ?? envData.contracts.VaultModule,
    "LPVaultModule/VaultModule"
  );
  const existingLazy = requireAddress(
    envData.contracts.LazyMulSegmentTree,
    "LazyMulSegmentTree"
  );

  console.log(`[prepare-safe-upgrade] env=${env} network=${network.name} chainId=${chainId.toString()}`);
  console.log(`[prepare-safe-upgrade] deployer=${deployer.address}`);
  console.log(`[prepare-safe-upgrade] modules=${Array.from(modulesToDeploy).join(",")}`);

  const coreImpl = await (await ethers.getContractFactory("IcicleOptionsCore")).deploy();
  await coreImpl.waitForDeployment();
  const newCoreImpl = coreImpl.target.toString();

  let lazyAddress = existingLazy;
  if (deployTrade || deployLifecycle) {
    const lazy = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();
    await lazy.waitForDeployment();
    lazyAddress = lazy.target.toString();
  }

  let tradeModule = existingTrade;
  if (deployTrade) {
    const trade = await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyAddress },
      })
    ).deploy();
    await trade.waitForDeployment();
    tradeModule = trade.target.toString();
  }

  let lifecycleModule = existingLifecycle;
  if (deployLifecycle) {
    const lifecycle = await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazyAddress },
      })
    ).deploy();
    await lifecycle.waitForDeployment();
    lifecycleModule = lifecycle.target.toString();
  }

  let oracleModule = existingOracle;
  if (deployOracle) {
    const oracle = await (await ethers.getContractFactory("OracleModule")).deploy();
    await oracle.waitForDeployment();
    oracleModule = oracle.target.toString();
  }

  let riskModule = existingRisk;
  if (deployRisk) {
    const risk = await (await ethers.getContractFactory("RiskModule")).deploy();
    await risk.waitForDeployment();
    riskModule = risk.target.toString();
  }

  let vaultModule = existingVault;
  if (deployVault) {
    const vault = await (await ethers.getContractFactory("LPVaultModule")).deploy();
    await vault.waitForDeployment();
    vaultModule = vault.target.toString();
  }

  const coreIface = (await ethers.getContractFactory("IcicleOptionsCore")).interface;
  const setModulesCalldata = coreIface.encodeFunctionData("setModules", [
    tradeModule,
    lifecycleModule,
    riskModule,
    vaultModule,
    oracleModule,
  ]);
  const upgradeToAndCallCalldata = coreIface.encodeFunctionData("upgradeToAndCall", [
    newCoreImpl,
    setModulesCalldata,
  ]);

  const safeAbi = [
    {
      type: "function",
      name: "upgradeToAndCall",
      stateMutability: "payable",
      inputs: [
        { name: "newImplementation", type: "address" },
        { name: "data", type: "bytes" },
      ],
      outputs: [],
    },
    {
      type: "function",
      name: "setModules",
      stateMutability: "nonpayable",
      inputs: [
        { name: "tradeModule_", type: "address" },
        { name: "lifecycleModule_", type: "address" },
        { name: "riskModule_", type: "address" },
        { name: "vaultModule_", type: "address" },
        { name: "oracleModule_", type: "address" },
      ],
      outputs: [],
    },
  ] as const;

  const plan = {
    generatedAt: new Date().toISOString(),
    network: env,
    chainId: Number(chainId),
    deployer: deployer.address,
    coreProxy,
    deployed: {
      IcicleOptionsCoreImplementation: newCoreImpl,
      LazyMulSegmentTree: lazyAddress,
      TradeModule: tradeModule,
      MarketLifecycleModule: lifecycleModule,
      OracleModule: oracleModule,
      RiskModule: riskModule,
      LPVaultModule: vaultModule,
    },
    modulesDeployed: Array.from(modulesToDeploy),
    safe: {
      to: coreProxy,
      value: "0",
      abi: safeAbi,
      method: "upgradeToAndCall(address newImplementation, bytes data)",
      args: {
        newImplementation: newCoreImpl,
        data: setModulesCalldata,
      },
      calldata: upgradeToAndCallCalldata,
    },
    debug: {
      setModulesCalldata,
    },
  };

  const tag = getTimestampTag(new Date());
  const outPath = path.join("releases", "prod", `${tag}-safe-upgrade-plan.json`);
  const copyDir = path.join("releases", "prod", `${tag}-safe-copy`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(copyDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
  writeCopyFile(copyDir, "01-to.txt", coreProxy);
  writeCopyFile(copyDir, "02-value.txt", "0");
  writeCopyFile(copyDir, "03-core-abi.json", JSON.stringify(safeAbi));
  writeCopyFile(
    copyDir,
    "04-method.txt",
    "upgradeToAndCall(address newImplementation, bytes data)"
  );
  writeCopyFile(copyDir, "05-arg-newImplementation.txt", newCoreImpl);
  writeCopyFile(copyDir, "06-arg-data-setModulesCalldata.txt", setModulesCalldata);
  writeCopyFile(copyDir, "07-calldata-upgradeToAndCall.txt", upgradeToAndCallCalldata);

  console.log("");
  console.log("==============================================");
  console.log("Safe Manual Execution (Citrea) [OWNER ONLY]");
  console.log("==============================================");
  console.log("1) Safe -> New Transaction -> Contract Interaction");
  console.log("2) To = Core proxy, Value = 0");
  console.log("3) Paste ABI, choose upgradeToAndCall");
  console.log("4) Fill args or paste calldata in Data field");
  printCopyBlock("1_TO_CORE", coreProxy);
  printCopyBlock("2_VALUE", "0");
  printCopyBlock("3_CORE_ABI", JSON.stringify(safeAbi));
  printCopyBlock(
    "4_METHOD",
    "upgradeToAndCall(address newImplementation, bytes data)"
  );
  printCopyBlock("5_ARG_NEW_IMPLEMENTATION", newCoreImpl);
  printCopyBlock("6_ARG_DATA_SET_MODULES_CALLDATA", setModulesCalldata);
  printCopyBlock("7_CALLDATA_DIRECT_PASTE", upgradeToAndCallCalldata);
  console.log("");
  console.log("[Deployed contracts for env update after Safe execution]");
  console.log(`IcicleOptionsCoreImplementation: ${newCoreImpl}`);
  console.log(`LazyMulSegmentTree: ${lazyAddress}`);
  console.log(`TradeModule: ${tradeModule}`);
  console.log(`MarketLifecycleModule: ${lifecycleModule}`);
  console.log(`OracleModule: ${oracleModule}`);
  console.log(`RiskModule: ${riskModule}`);
  console.log(`LPVaultModule: ${vaultModule}`);
  console.log("");
  console.log(`[prepare-safe-upgrade] plan saved: ${outPath}`);
  console.log(`[prepare-safe-upgrade] copy files: ${copyDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
