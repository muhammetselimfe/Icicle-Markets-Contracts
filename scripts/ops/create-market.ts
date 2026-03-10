import hre from "hardhat";
import { loadEnvironment, normalizeEnvironment, updateConfig } from "../utils/environment";
import type { Environment } from "../types/environment";

type LiquidityMode = "auto" | "manual";
type BaseFactorsMode = "uniform" | "custom";

interface CreateMarketConfig {
  skipStaticCall: boolean;
  feePolicyAddress: string;
  vault: {
    seedAmountUsd: string;
    withdrawalLagBatches: number;
  };
  risk: {
    lambda: string;
    kDrawdown: string;
    enforceAlpha: boolean;
  };
  feeWaterfall: {
    rhoBS: string;
    phiLP: string;
    phiBS: string;
    phiTR: string;
  };
  capitalStack: {
    backstopNavUsd: string;
    treasuryNavUsd: string;
  };
  settlement: {
    submitWindowSec: number;
    pendingOpsWindowSec: number;
    claimDelaySec: number;
  };
  redstone: {
    feedId: string;
    feedDecimals: number;
    maxSampleDistanceSec: number;
    futureToleranceSec: number;
  };
  market: {
    minTick: number;
    maxTick: number;
    tickSpacing: number;
    startDelaySec: number;
    durationSec: number;
    settlementDelaySec: number;
    seedChunkSize: number;
    liquidity: {
      mode: LiquidityMode;
      safetyFactor: string;
      manualAlphaWad: string;
    };
    baseFactors: {
      mode: BaseFactorsMode;
      customWad: string[];
    };
  };
}

// === Editable config (top-level) ============================================
const CONFIG: CreateMarketConfig = {
  skipStaticCall: true,
  feePolicyAddress: "", // required
  vault: {
    seedAmountUsd: "100000", // 6 decimals
    withdrawalLagBatches: 0,
  },
  risk: {
    lambda: "0.3", // WAD
    kDrawdown: "1.0", // WAD
    enforceAlpha: true,
  },
  feeWaterfall: {
    rhoBS: "0.2", // WAD
    phiLP: "0.7", // WAD
    phiBS: "0.2", // WAD
    phiTR: "0.1", // WAD
  },
  capitalStack: {
    backstopNavUsd: "100000", // WAD (USD value)
    treasuryNavUsd: "0", // WAD (USD value)
  },
  settlement: {
    submitWindowSec: 600,
    pendingOpsWindowSec: 300,
    claimDelaySec: 900,
  },
  redstone: {
    feedId: "BTC",
    feedDecimals: 8,
    maxSampleDistanceSec: 600,
    futureToleranceSec: 60,
  },
  market: {
    minTick: 70000,
    maxTick: 90000,
    tickSpacing: 200,
    startDelaySec: 7 * 24 * 3600,
    durationSec: 24 * 3600,
    settlementDelaySec: 0,
    seedChunkSize: 50,
    liquidity: {
      mode: "manual", // "auto" | "manual"
      safetyFactor: "0.8", // applies only for auto
      manualAlphaWad: "1000000000000000000000", // set when mode=manual
    },
    baseFactors: {
      mode: "uniform", // "uniform" | "custom"
      customWad: [] as string[], // only used if mode=custom
    },
  },
};

// === Helpers ================================================================
const USD_DECIMALS = 6;
const WAD_DECIMALS = 18;
const WAD = 10n ** 18n;
const BATCH_SECONDS = 86400;
const BATCH_TIMEZONE_OFFSET = 8 * 3600;

function usd6(value: string): bigint {
  return hre.ethers.parseUnits(value, USD_DECIMALS);
}

function wad(value: string): bigint {
  return hre.ethers.parseUnits(value, WAD_DECIMALS);
}

function toWadFromUsd6(value6: bigint): bigint {
  return value6 * 10n ** 12n;
}

function computeNumBins(minTick: number, maxTick: number, tickSpacing: number): number {
  const range = maxTick - minTick;
  if (tickSpacing <= 0 || range <= 0 || range % tickSpacing !== 0) {
    throw new Error("Invalid ticks: (maxTick - minTick) must be divisible by tickSpacing");
  }
  return range / tickSpacing;
}

function toBatchId(timestamp: number): number {
  const adjusted = timestamp - BATCH_TIMEZONE_OFFSET;
  return Math.floor(Math.max(0, adjusted) / BATCH_SECONDS);
}

async function decodeRevert(err: unknown) {
  const data =
    (err as { data?: string })?.data ??
    (err as { error?: { data?: string } })?.error?.data ??
    (err as { error?: { error?: { data?: string } } })?.error?.error?.data;
  if (!data) {
    console.error(err);
    return;
  }

  try {
    const artifact = await hre.artifacts.readArtifact("IcicleOptionsErrors");
    const iface = new hre.ethers.Interface(artifact.abi);
    const parsed = iface.parseError(data);
    console.error(`[create-market] reverted with ${parsed?.name}`);
    if (parsed?.args?.length) {
      console.error(parsed.args);
    }
  } catch (parseErr) {
    console.error("[create-market] revert data (unparsed)", data);
    console.error(parseErr);
  }
}

async function resolveAlphaWad(params: {
  navWad: bigint;
  drawdownWad: bigint;
  lambdaWad: bigint;
  kDrawdownWad: bigint;
  numBins: number;
  enforceAlpha: boolean;
  riskModuleAddress: string;
}): Promise<bigint> {
  if (CONFIG.market.liquidity.mode === "manual") {
    if (!CONFIG.market.liquidity.manualAlphaWad) {
      throw new Error("manualAlphaWad is required when liquidity.mode is manual");
    }
    return BigInt(CONFIG.market.liquidity.manualAlphaWad);
  }

  const riskModule = await hre.ethers.getContractAt("RiskModule", params.riskModuleAddress);
  const lnN = await riskModule.lnWad(params.numBins);
  if (lnN === 0n) {
    throw new Error("lnN returned zero; numBins too small?");
  }

  const alphaBase = (params.lambdaWad * params.navWad) / WAD;
  const alphaBaseDiv = (alphaBase * WAD) / lnN;
  let alphaLimit = alphaBaseDiv;
  if (params.enforceAlpha) {
    const kDD = (params.kDrawdownWad * params.drawdownWad) / WAD;
    const factor = kDD >= WAD ? 0n : WAD - kDD;
    alphaLimit = (alphaBaseDiv * factor) / WAD;
  }

  const safetyFactorWad = hre.ethers.parseUnits(CONFIG.market.liquidity.safetyFactor, WAD_DECIMALS);
  const alphaSafe = (alphaLimit * safetyFactorWad) / WAD;
  console.log(
    `[create-market] alphaBase=${alphaBaseDiv.toString()} alphaLimit=${alphaLimit.toString()} peakDrawdown=${params.drawdownWad.toString()}`
  );
  if (alphaSafe === 0n) {
    throw new Error("alphaWad computed as zero; adjust safetyFactor or risk config");
  }
  return alphaSafe;
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[create-market] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const paymentTokenAddress = envData.contracts.PaymentToken;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");
  if (!paymentTokenAddress) throw new Error("Missing PaymentToken in environment file");

  const feePolicyAddress = CONFIG.feePolicyAddress;
  if (!feePolicyAddress) {
    throw new Error("feePolicyAddress is required in CONFIG");
  }

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const payment = new ethers.Contract(
    paymentTokenAddress,
    [
      "function decimals() view returns (uint8)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    deployer
  );
  const paymentDecimals = Number(await payment.decimals());
  if (paymentDecimals !== 6) {
    throw new Error(`paymentToken.decimals must be 6 (got ${paymentDecimals})`);
  }
  const owner = await core.owner();
  const paused = await core.paused();
  const lifecycleModule = await core.lifecycleModule();
  const riskModuleAddr = await core.riskModule();
  console.log(`[create-market] coreOwner=${owner} caller=${deployer.address} paused=${paused}`);
  console.log(`[create-market] lifecycleModule=${lifecycleModule} riskModule=${riskModuleAddr}`);
  const lifecycleCode = await ethers.provider.getCode(lifecycleModule);
  const riskCode = await ethers.provider.getCode(riskModuleAddr);
  const lifecycleArtifact = await hre.artifacts.readArtifact("MarketLifecycleModule");
  const riskArtifact = await hre.artifacts.readArtifact("RiskModule");
  console.log(
    `[create-market] lifecycleCodeLen=${lifecycleCode.length} artifactLen=${lifecycleArtifact.deployedBytecode.length}`
  );
  console.log(
    `[create-market] riskCodeLen=${riskCode.length} artifactLen=${riskArtifact.deployedBytecode.length}`
  );

  const [navNow, sharesNow] = await Promise.all([core.getVaultNav(), core.getVaultShares()]);
  const [backstopNow, treasuryNow] = await core.getCapitalStack();
  console.log(
    `[create-market] nav=${navNow.toString()} shares=${sharesNow.toString()} backstop=${backstopNow.toString()} treasury=${treasuryNow.toString()}`
  );
  const nextMarketId = await core.nextMarketId();
  console.log(`[create-market] nextMarketId=${nextMarketId.toString()}`);
  const marketOne = await core.markets(1);
  if (marketOne.numBins !== 0n || marketOne.startTimestamp !== 0n) {
    console.log(
      `[create-market] market#1 numBins=${marketOne.numBins.toString()} start=${marketOne.startTimestamp.toString()}`
    );
  }

  const seedAmount6 = usd6(CONFIG.vault.seedAmountUsd);
  const lambdaWad = wad(CONFIG.risk.lambda);
  const kDrawdownWad = wad(CONFIG.risk.kDrawdown);
  const rhoBS = wad(CONFIG.feeWaterfall.rhoBS);
  const phiLP = wad(CONFIG.feeWaterfall.phiLP);
  const phiBS = wad(CONFIG.feeWaterfall.phiBS);
  const phiTR = wad(CONFIG.feeWaterfall.phiTR);
  const backstopAmount6 = usd6(CONFIG.capitalStack.backstopNavUsd);
  const treasuryAmount6 = usd6(CONFIG.capitalStack.treasuryNavUsd);

  console.log(`[create-market] core=${coreAddress} deployer=${deployer.address}`);

  await (await core.setWithdrawalLagBatches(CONFIG.vault.withdrawalLagBatches)).wait();
  await (await core.setRiskConfig(lambdaWad, kDrawdownWad, CONFIG.risk.enforceAlpha)).wait();
  await (await core.setFeeWaterfallConfig(rhoBS, phiLP, phiBS, phiTR)).wait();
  await (await core.setSettlementTimeline(
    CONFIG.settlement.submitWindowSec,
    CONFIG.settlement.pendingOpsWindowSec,
    CONFIG.settlement.claimDelaySec
  )).wait();
  await (await core.setRedstoneConfig(
    ethers.encodeBytes32String(CONFIG.redstone.feedId),
    CONFIG.redstone.feedDecimals,
    CONFIG.redstone.maxSampleDistanceSec,
    CONFIG.redstone.futureToleranceSec
  )).wait();

  updateConfig(env, {
    settlementSubmitWindow: CONFIG.settlement.submitWindowSec.toString(),
    pendingOpsWindow: CONFIG.settlement.pendingOpsWindowSec.toString(),
    settlementFinalizeDeadline: CONFIG.settlement.claimDelaySec.toString(),
    redstoneFeedId: CONFIG.redstone.feedId,
    redstoneFeedDecimals: CONFIG.redstone.feedDecimals,
    redstoneMaxSampleDistance: CONFIG.redstone.maxSampleDistanceSec.toString(),
    redstoneFutureTolerance: CONFIG.redstone.futureToleranceSec.toString(),
  });

  const seeded = await core.isVaultSeeded();
  const requiredAllowance = seedAmount6 + backstopAmount6 + treasuryAmount6;
  if (requiredAllowance > 0n) {
    const allowance = await payment.allowance(deployer.address, coreAddress);
    if (allowance < requiredAllowance) {
      await (await payment.approve(coreAddress, requiredAllowance)).wait();
    }
  }

  if (backstopAmount6 > 0n) {
    await (await core.fundBackstop(backstopAmount6)).wait();
  }

  if (treasuryAmount6 > 0n) {
    await (await core.fundTreasury(treasuryAmount6)).wait();
  }

  if (!seeded) {
    await (await core.seedVault(seedAmount6)).wait();
  } else {
    console.log("[create-market] vault already seeded (skip seed)");
  }

  const numBins = computeNumBins(CONFIG.market.minTick, CONFIG.market.maxTick, CONFIG.market.tickSpacing);
  const baseFactors =
    CONFIG.market.baseFactors.mode === "custom"
      ? CONFIG.market.baseFactors.customWad.map((value) => BigInt(value))
      : Array.from({ length: numBins }, () => WAD);

  if (baseFactors.length !== numBins) {
    throw new Error(`baseFactors length mismatch: expected ${numBins}, got ${baseFactors.length}`);
  }

  const navWad = await core.getVaultNav();
  const navForAlpha = navWad > 0n ? navWad : toWadFromUsd6(seedAmount6);
  const drawdownWad = await core.getVaultDrawdown();
  const [lambdaOnChain, kDrawdownOnChain, enforceAlpha] = await core.getRiskConfig();
  const riskModuleAddress = await core.riskModule();
  const alphaWad = await resolveAlphaWad({
    navWad: navForAlpha,
    drawdownWad,
    lambdaWad: lambdaOnChain,
    kDrawdownWad: kDrawdownOnChain,
    numBins,
    enforceAlpha,
    riskModuleAddress,
  });

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const blockGasLimit = latestBlock?.gasLimit ?? 0n;
  let startTimestamp = now + CONFIG.market.startDelaySec;
  let endTimestamp = startTimestamp + CONFIG.market.durationSec;
  let settlementTimestamp = endTimestamp + CONFIG.market.settlementDelaySec;
  const existingBatches = new Set<number>();
  if (nextMarketId > 0n) {
    for (let i = 1n; i <= nextMarketId; i++) {
      const market = await core.markets(i);
      if (market.numBins === 0n) continue;
      const batchId = toBatchId(Number(market.settlementTimestamp));
      existingBatches.add(batchId);
      console.log(
        `[create-market] existing marketId=${i.toString()} batchId=${batchId} settled=${market.settled}`
      );
    }
  }

  let targetBatchId = toBatchId(settlementTimestamp);
  if (existingBatches.has(targetBatchId)) {
    console.warn(
      `[create-market] batchId=${targetBatchId} already has market(s); continuing (one-to-many allowed)`
    );
  }

  console.log(
    `[create-market] numBins=${numBins} alphaWad=${alphaWad.toString()} batchId=${targetBatchId}`
  );

  const packedFactors = hre.ethers.solidityPacked(
    Array(baseFactors.length).fill("uint256"),
    baseFactors
  );
  const seedData = await (await hre.ethers.getContractFactory("SeedData")).deploy(
    packedFactors
  );
  await seedData.waitForDeployment();
  const seedDataAddress = seedData.target;

  const beforeMarketId = await core.nextMarketId();
  let marketId = beforeMarketId + 1n;
  if (!CONFIG.skipStaticCall) {
    try {
      marketId = await core.createMarket.staticCall(
        CONFIG.market.minTick,
        CONFIG.market.maxTick,
        CONFIG.market.tickSpacing,
        startTimestamp,
        endTimestamp,
        settlementTimestamp,
        numBins,
        alphaWad,
        feePolicyAddress,
        seedDataAddress
      );
    } catch (err) {
      await decodeRevert(err);
      throw err;
    }
  }

  const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
  const txRequest = await core.createMarket.populateTransaction(
    CONFIG.market.minTick,
    CONFIG.market.maxTick,
    CONFIG.market.tickSpacing,
    startTimestamp,
    endTimestamp,
    settlementTimestamp,
    numBins,
    alphaWad,
    feePolicyAddress,
    seedDataAddress,
    overrides
  );
  if (overrides.gasLimit) {
    txRequest.gasLimit = overrides.gasLimit;
  }
  console.log(`[create-market] txDataLen=${txRequest.data?.length ?? 0}`);
  const tx = await deployer.sendTransaction(txRequest);
  await tx.wait();

  console.log(`[create-market] marketId=${marketId.toString()}`);
  console.log(`[create-market] start=${startTimestamp} end=${endTimestamp} settlement=${settlementTimestamp}`);

  const seedChunkSize = Math.max(1, CONFIG.market.seedChunkSize);
  let remaining = numBins;
  while (remaining > 0) {
    const count = remaining > seedChunkSize ? seedChunkSize : remaining;
    console.log(`[create-market] seeding chunk count=${count} remaining=${remaining}`);
    const seedTx = await core.seedNextChunks(marketId, count);
    await seedTx.wait();
    remaining -= count;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
