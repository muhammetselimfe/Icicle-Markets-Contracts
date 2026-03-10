import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  loadEnvironment,
  recordDeployment,
  updateConfig,
  updateContracts,
} from "../utils/environment";
import { writeReleaseSnapshot } from "../utils/release";
import type { Environment } from "../types/environment";
import { predictCreate2 } from "./predict-create2";

const CHAIN_ID_GUARD: Partial<Record<Environment, number>> = {
  dev: 5115,
  prod: 4114,
  fuji: 43113,
};

interface ManualInputs {
  ownerSafe: string;
  paymentTokenAddress: string;
  operatorAllowlist: string;
  settlement: { submitWindowSec: string; pendingOpsWindowSec: string };
  redstone: {
    feedId: string;
    feedDecimals: string;
    maxSampleDistanceSec: string;
    futureToleranceSec: string;
  };
  risk: { lambda: string; kDrawdown: string; enforceAlpha: string };
  feeWaterfall: { rhoBS: string; phiLP: string; phiBS: string; phiTR: string };
  withdrawalLagBatches: string;
  lpShare: { name: string; symbol: string };
  create2: { release: string; vanityPrefix: string; maxNonce: string };
}

const SHARED_DEFAULTS: Omit<ManualInputs, "ownerSafe" | "paymentTokenAddress" | "operatorAllowlist" | "redstone"> = {
  settlement: {
    submitWindowSec: "600",
    pendingOpsWindowSec: "300",
  },
  risk: {
    lambda: "0.3",
    kDrawdown: "1",
    enforceAlpha: "0",
  },
  feeWaterfall: {
    rhoBS: "0.2",
    phiLP: "0.7",
    phiBS: "0.2",
    phiTR: "0.1",
  },
  withdrawalLagBatches: "0",
  lpShare: {
    name: "Icicle Options LP",
    symbol: "ICOLP",
  },
  create2: {
    release: "v1",
    vanityPrefix: "0x516",
    maxNonce: "1000000",
  },
};

const ENV_INPUTS: Partial<Record<Environment, ManualInputs>> = {
  dev: {
    ownerSafe: "0x0e5ed8B5Be63bf1f92Cc9A516B7cAADa1AeA6Bf8",
    paymentTokenAddress: "0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D",
    operatorAllowlist: "0xe0785a8cDc92bAe49Ae7aA6C99B602e3CC43F7eD",
    redstone: {
      feedId: "BTC",
      feedDecimals: "8",
      maxSampleDistanceSec: "600",
      futureToleranceSec: "60",
    },
    ...SHARED_DEFAULTS,
  },
  fuji: {
    ownerSafe: "",
    paymentTokenAddress: "",
    operatorAllowlist: "",
    redstone: {
      feedId: "AVAX",
      feedDecimals: "8",
      maxSampleDistanceSec: "600",
      futureToleranceSec: "60",
    },
    ...SHARED_DEFAULTS,
  },
};

function getInputs(env: Environment): ManualInputs {
  const inputs = ENV_INPUTS[env];
  if (!inputs) {
    throw new Error(`No deploy inputs configured for environment '${env}'`);
  }
  return inputs;
}

function parseAddressList(value: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBigInt(value: string, label: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} must be an integer (got ${value})`);
  }
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number (got ${value})`);
  }
  return parsed;
}

function wad(value: string): bigint {
  return hre.ethers.parseUnits(value, 18);
}

function writePredicted(env: Environment, prediction: unknown) {
  const outputPath = path.join("scripts", "environments", `${env}.predicted.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(prediction, null, 2));
  return outputPath;
}

export async function deployAction(env: Environment) {
  const { ethers, network } = hre;
  console.log(`[deploy] environment=${env} network=${network.name}`);
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const inputs = getInputs(env);
  const envData = loadEnvironment(env);

  const { chainId } = await ethers.provider.getNetwork();
  const expectedChainId = CHAIN_ID_GUARD[env];
  if (expectedChainId && Number(chainId) !== expectedChainId) {
    throw new Error(
      `ChainId mismatch: expected=${expectedChainId} got=${chainId}`
    );
  }

  const submitWindow = parseBigInt(
    inputs.settlement.submitWindowSec,
    "SETTLEMENT_SUBMIT_WINDOW"
  );
  const pendingOpsWindow = parseBigInt(
    inputs.settlement.pendingOpsWindowSec,
    "SETTLEMENT_PENDING_OPS_WINDOW"
  );
  const claimDelay = submitWindow + pendingOpsWindow;

  const redstoneFeedDecimals = parseNumber(
    inputs.redstone.feedDecimals,
    "REDSTONE_FEED_DECIMALS"
  );
  const redstoneMaxSampleDistance = parseBigInt(
    inputs.redstone.maxSampleDistanceSec,
    "REDSTONE_MAX_SAMPLE_DISTANCE"
  );
  const redstoneFutureTolerance = parseBigInt(
    inputs.redstone.futureToleranceSec,
    "REDSTONE_FUTURE_TOLERANCE"
  );

  const ownerSafe = inputs.ownerSafe || deployer.address;
  const operatorAllowlist = parseAddressList(inputs.operatorAllowlist);
  const resolvedOperators = operatorAllowlist.length
    ? operatorAllowlist
    : [deployer.address];

  const withdrawalLagBatches = parseNumber(
    inputs.withdrawalLagBatches,
    "WITHDRAWAL_LAG_BATCHES"
  );
  if (withdrawalLagBatches < 0) {
    throw new Error("WITHDRAWAL_LAG_BATCHES must be >= 0");
  }

  const riskLambda = wad(inputs.risk.lambda);
  const riskKDrawdown = wad(inputs.risk.kDrawdown);
  const riskEnforceAlpha =
    inputs.risk.enforceAlpha === "1" || inputs.risk.enforceAlpha === "true";
  const rhoBS = wad(inputs.feeWaterfall.rhoBS);
  const phiLP = wad(inputs.feeWaterfall.phiLP);
  const phiBS = wad(inputs.feeWaterfall.phiBS);
  const phiTR = wad(inputs.feeWaterfall.phiTR);

  let paymentAddress = inputs.paymentTokenAddress;
  if (env === "prod" && !paymentAddress) {
    throw new Error(
      "PAYMENT_TOKEN_ADDRESS is required for prod (no mock payment token deployment)"
    );
  }
  if (paymentAddress) {
    console.log(`[deploy] using existing payment token=${paymentAddress}`);
  } else {
    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    await payment.waitForDeployment();
    paymentAddress = payment.target.toString();
  }

  const decimalsContract = new ethers.Contract(
    paymentAddress,
    ["function decimals() view returns (uint8)"],
    deployer
  );
  const paymentDecimals = Number(await decimalsContract.decimals());
  if (paymentDecimals !== 6) {
    throw new Error(`paymentToken.decimals must be 6 (got ${paymentDecimals})`);
  }

  async function resolveImpl(label: string, contractName: string, existing?: string): Promise<string> {
    if (existing) {
      const code = await ethers.provider.getCode(existing);
      if (code !== "0x") {
        console.log(`[deploy] reusing ${label}=${existing}`);
        return existing;
      }
      console.warn(`[deploy] ${label} has no code at ${existing}; redeploying`);
    }

    const factory = await ethers.getContractFactory(contractName);
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    return impl.target.toString();
  }

  const nullFeePolicy = await (
    await ethers.getContractFactory("NullFeePolicy")
  ).deploy();
  await nullFeePolicy.waitForDeployment();

  const feePolicy10bps = await (
    await ethers.getContractFactory("PercentFeePolicy10bps")
  ).deploy();
  await feePolicy10bps.waitForDeployment();

  const feePolicy50bps = await (
    await ethers.getContractFactory("PercentFeePolicy50bps")
  ).deploy();
  await feePolicy50bps.waitForDeployment();

  const feePolicy100bps = await (
    await ethers.getContractFactory("PercentFeePolicy100bps")
  ).deploy();
  await feePolicy100bps.waitForDeployment();

  const feePolicy200bps = await (
    await ethers.getContractFactory("PercentFeePolicy200bps")
  ).deploy();
  await feePolicy200bps.waitForDeployment();

  const lazy = await (
    await ethers.getContractFactory("LazyMulSegmentTree")
  ).deploy();
  await lazy.waitForDeployment();

  const tradeModule = await (
    await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: lazy.target },
    })
  ).deploy();
  await tradeModule.waitForDeployment();

  const lifecycleModule = await (
    await ethers.getContractFactory("MarketLifecycleModule", {
      libraries: { LazyMulSegmentTree: lazy.target },
    })
  ).deploy();
  await lifecycleModule.waitForDeployment();

  const oracleModule = await (
    await ethers.getContractFactory("OracleModule")
  ).deploy();
  await oracleModule.waitForDeployment();

  const riskModule = await (
    await ethers.getContractFactory("RiskModule")
  ).deploy();
  await riskModule.waitForDeployment();

  const vaultModule = await (
    await ethers.getContractFactory("LPVaultModule")
  ).deploy();
  await vaultModule.waitForDeployment();

  const coreImplAddress = await resolveImpl(
    "IcicleOptionsCoreImplementation",
    "IcicleOptionsCore",
    envData.contracts.IcicleOptionsCoreImplementation
  );
  const positionImplAddress = await resolveImpl(
    "IcicleOptionsPositionImplementation",
    "IcicleOptionsPosition",
    envData.contracts.IcicleOptionsPositionImplementation
  );
  const lpShareImplAddress = await resolveImpl(
    "IcicleOptionsLPShareImplementation",
    "IcicleOptionsLPShare",
    envData.contracts.IcicleOptionsLPShareImplementation
  );

  const create2FactoryAddress = await (async () => {
    const existing =
      envData.contracts.IcicleOptionsCreate2Factory ??
      envData.contracts.Create2Factory;
    if (existing) {
      const code = await ethers.provider.getCode(existing);
      if (code !== "0x") {
        return existing;
      }
      if (env === "prod") {
        throw new Error(`IcicleOptionsCreate2Factory has no code at ${existing}`);
      }
      console.warn(
        `[deploy] IcicleOptionsCreate2Factory not found at ${existing}; redeploying`
      );
    }
    const factory = await (
      await ethers.getContractFactory("IcicleOptionsCreate2Factory")
    ).deploy(deployer.address);
    await factory.waitForDeployment();
    return factory.target.toString();
  })();

  const factoryContract = await ethers.getContractAt(
    "IcicleOptionsCreate2Factory",
    create2FactoryAddress
  );
  const allowedDeployer = await factoryContract.allowedDeployer();
  if (allowedDeployer.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `IcicleOptionsCreate2Factory allowedDeployer mismatch: expected ${deployer.address} got ${allowedDeployer}`
    );
  }

  const prediction = await predictCreate2({
    env,
    chainId: Number(chainId),
    deployerEOA: deployer.address,
    create2Factory: create2FactoryAddress,
    coreImpl: coreImplAddress,
    positionImpl: positionImplAddress,
    lpShareImpl: lpShareImplAddress,
    release: inputs.create2.release,
    vanityPrefix: inputs.create2.vanityPrefix,
    maxNonce: parseNumber(inputs.create2.maxNonce, "CORE_VANITY_MAX_NONCE"),
  });

  const predictedPath = writePredicted(env, prediction);
  console.log(`[deploy] predicted addresses written to ${predictedPath}`);

  const deployerAddress = prediction.contracts.IcicleOptionsDeployer;
  const deployerFactory = await ethers.getContractFactory("IcicleOptionsDeployer");
  const deployerInitCode = ethers.concat([
    deployerFactory.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [deployer.address]),
  ]);

  const deployerCode = await ethers.provider.getCode(deployerAddress);
  if (deployerCode === "0x") {
    const deployTx = await factoryContract.deploy(
      prediction.create2.salts.DEPLOYER.salt,
      deployerInitCode
    );
    await deployTx.wait();
  }

  const deployerCodeAfter = await ethers.provider.getCode(deployerAddress);
  if (deployerCodeAfter === "0x") {
    throw new Error(`IcicleOptionsDeployer was not deployed at ${deployerAddress}`);
  }

  const coreParams = {
    paymentToken: paymentAddress,
    positionContract: prediction.contracts.IcicleOptionsPositionProxy,
    lpShareToken: prediction.contracts.IcicleOptionsLPShareProxy,
    tradeModule: tradeModule.target.toString(),
    lifecycleModule: lifecycleModule.target.toString(),
    riskModule: riskModule.target.toString(),
    vaultModule: vaultModule.target.toString(),
    oracleModule: oracleModule.target.toString(),
    ownerSafe,
    settlementSubmitWindow: submitWindow,
    pendingOpsWindow: pendingOpsWindow,
    claimDelaySeconds: claimDelay,
    redstoneFeedId: ethers.encodeBytes32String(inputs.redstone.feedId),
    redstoneFeedDecimals: redstoneFeedDecimals,
    maxSampleDistance: redstoneMaxSampleDistance,
    futureTolerance: redstoneFutureTolerance,
    lambda: riskLambda,
    kDrawdown: riskKDrawdown,
    enforceAlpha: riskEnforceAlpha,
    rhoBS,
    phiLP,
    phiBS,
    phiTR,
    withdrawalLagBatches,
    operatorAllowlist: resolvedOperators,
  };

  const deployerContract = await ethers.getContractAt(
    "IcicleOptionsDeployer",
    deployerAddress
  );
  const deployAllTx = await deployerContract.deployAllDeterministic(
    coreImplAddress,
    positionImplAddress,
    lpShareImplAddress,
    prediction.create2.salts.CORE_PROXY.salt,
    prediction.create2.salts.POSITION_PROXY.salt,
    prediction.create2.salts.LPSHARE_PROXY.salt,
    prediction.contracts.IcicleOptionsCoreProxy,
    prediction.contracts.IcicleOptionsPositionProxy,
    prediction.contracts.IcicleOptionsLPShareProxy,
    coreParams,
    inputs.lpShare.name,
    inputs.lpShare.symbol
  );
  const deployReceipt = await deployAllTx.wait();
  console.log(
    `[deploy] deployAllDeterministic tx=${deployAllTx.hash} block=${deployReceipt?.blockNumber}`
  );

  updateContracts(env, {
    IcicleOptionsCreate2Factory: create2FactoryAddress,
    IcicleOptionsDeployer: deployerAddress,
    IcicleOptionsCoreProxy: prediction.contracts.IcicleOptionsCoreProxy,
    IcicleOptionsCoreImplementation: coreImplAddress,
    IcicleOptionsPositionProxy: prediction.contracts.IcicleOptionsPositionProxy,
    IcicleOptionsPositionImplementation: positionImplAddress,
    IcicleOptionsLPShareProxy: prediction.contracts.IcicleOptionsLPShareProxy,
    IcicleOptionsLPShareImplementation: lpShareImplAddress,
    IcicleOptionsLPShare: prediction.contracts.IcicleOptionsLPShareProxy,
    TradeModule: tradeModule.target.toString(),
    MarketLifecycleModule: lifecycleModule.target.toString(),
    OracleModule: oracleModule.target.toString(),
    RiskModule: riskModule.target.toString(),
    LPVaultModule: vaultModule.target.toString(),
    FeePolicyNull: nullFeePolicy.target.toString(),
    FeePolicy10bps: feePolicy10bps.target.toString(),
    FeePolicy50bps: feePolicy50bps.target.toString(),
    FeePolicy100bps: feePolicy100bps.target.toString(),
    FeePolicy200bps: feePolicy200bps.target.toString(),
    PaymentToken: paymentAddress,
    LazyMulSegmentTree: lazy.target.toString(),
  });

  updateConfig(env, {
    settlementSubmitWindow: submitWindow.toString(),
    settlementFinalizeDeadline: claimDelay.toString(),
    pendingOpsWindow: pendingOpsWindow.toString(),
    redstoneFeedId: inputs.redstone.feedId,
    redstoneFeedDecimals,
    redstoneMaxSampleDistance: redstoneMaxSampleDistance.toString(),
    redstoneFutureTolerance: redstoneFutureTolerance.toString(),
    lpShareTokenName: inputs.lpShare.name,
    lpShareTokenSymbol: inputs.lpShare.symbol,
    operatorAllowlist: resolvedOperators,
    owners: {
      core: ownerSafe,
      position: ownerSafe,
      lpShare: ownerSafe,
    },
    deployerEOA: deployer.address,
  });

  const { data: envSnapshot, record } = recordDeployment(env, {
    action: "deploy",
    deployer: deployer.address,
  });
  writeReleaseSnapshot(env, envSnapshot);

  console.log(`[deploy] completed (version=${record.version})`);
}
