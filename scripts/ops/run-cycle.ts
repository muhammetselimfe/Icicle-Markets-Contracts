import hre from "hardhat";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { getSignersForDataServiceId, type DataServiceIds } from "@redstone-finance/sdk";
import { Contract as V5Contract } from "@ethersproject/contracts";
import { JsonRpcProvider as V5JsonRpcProvider } from "@ethersproject/providers";
import { Wallet as V5Wallet } from "@ethersproject/wallet";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

interface CycleConfig {
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
  feePolicyAddress: string;
  settlement: {
    submitWindowSec: number;
    pendingOpsWindowSec: number;
    claimDelaySec: number;
  };
  redstone: {
    dataServiceId: DataServiceIds;
    dataFeedId: string;
    uniqueSigners: number;
    feedDecimals: number;
    maxSampleDistanceSec: number;
    futureToleranceSec: number;
  };
  market: {
    minTick: number;
    maxTick: number;
    tickSpacing: number;
    startOffsetSec: number;
    durationSec: number;
    settlementDelaySec: number;
    seedChunkSize: number;
    liquidityParameterWad: string;
  };
  trade: {
    lowerTickOffset: number;
    quantityUsd6: string;
    maxCostBpsBuffer: number;
  };
  settlementTiming: {
    minWindowRemainingSec: number;
    lagBufferSec: number;
    maxChunkCalls: number;
    maxChunksPerTx: number;
  };
}

const CONFIG: CycleConfig = {
  risk: {
    lambda: "0.3",
    kDrawdown: "1.0",
    enforceAlpha: false,
  },
  feeWaterfall: {
    rhoBS: "0.2",
    phiLP: "0.7",
    phiBS: "0.2",
    phiTR: "0.1",
  },
  feePolicyAddress: "", // required
  settlement: {
    submitWindowSec: 60,
    pendingOpsWindowSec: 30,
    claimDelaySec: 90,
  },
  redstone: {
    dataServiceId: "redstone-primary-prod",
    dataFeedId: "BTC",
    uniqueSigners: 3,
    feedDecimals: 8,
    maxSampleDistanceSec: 600,
    futureToleranceSec: 60,
  },
  market: {
    minTick: 50_000,
    maxTick: 60_000,
    tickSpacing: 1_000,
    startOffsetSec: -30,
    durationSec: 90,
    settlementDelaySec: 0,
    seedChunkSize: 20,
    liquidityParameterWad: "1000000000000000000",
  },
  trade: {
    lowerTickOffset: 0,
    quantityUsd6: "1",
    maxCostBpsBuffer: 200,
  },
  settlementTiming: {
    minWindowRemainingSec: 10,
    lagBufferSec: 5,
    maxChunkCalls: 20,
    maxChunksPerTx: 25,
  },
};

const USD_DECIMALS = 6;
const WAD_DECIMALS = 18;
const WAD = 10n ** 18n;
const BATCH_SECONDS = 86400n;
const BATCH_TIMEZONE_OFFSET = 8n * 3600n;

function usd6(value: string): bigint {
  return hre.ethers.parseUnits(value, USD_DECIMALS);
}

function wad(value: string): bigint {
  return hre.ethers.parseUnits(value, WAD_DECIMALS);
}

function computeNumBins(minTick: number, maxTick: number, tickSpacing: number): number {
  const range = maxTick - minTick;
  if (tickSpacing <= 0 || range <= 0 || range % tickSpacing !== 0) {
    throw new Error("Invalid ticks: (maxTick - minTick) must be divisible by tickSpacing");
  }
  return range / tickSpacing;
}

function toBatchId(timestamp: bigint): bigint {
  if (timestamp < BATCH_TIMEZONE_OFFSET) return 0n;
  return (timestamp - BATCH_TIMEZONE_OFFSET) / BATCH_SECONDS;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function decodeRevert(err: unknown): Promise<{ name?: string; args?: unknown[] }> {
  const data =
    (err as { data?: string })?.data ??
    (err as { error?: { data?: string } })?.error?.data ??
    (err as { error?: { error?: { data?: string } } })?.error?.error?.data;
  if (!data) return {};

  try {
    const artifact = await hre.artifacts.readArtifact("IcicleOptionsErrors");
    const iface = new hre.ethers.Interface(artifact.abi);
    const parsed = iface.parseError(data);
    return { name: parsed?.name, args: parsed?.args ? Array.from(parsed.args) : [] };
  } catch {
    return {};
  }
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[run-cycle] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  const paymentTokenAddress = envData.contracts.PaymentToken;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");
  if (!paymentTokenAddress) throw new Error("Missing payment token in environment file");

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress, deployer);

  const payment = new ethers.Contract(
    paymentTokenAddress,
    [
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    deployer
  );

  const decimals = Number(await payment.decimals());
  if (decimals !== 6) {
    throw new Error(`paymentToken.decimals must be 6 (got ${decimals})`);
  }

  const owner = await core.owner();
  const isOwner = owner.toLowerCase() === deployer.address.toLowerCase();
  const allowOperatorMode =
    process.env.RUN_CYCLE_ALLOW_OPERATOR === "1" ||
    process.env.RUN_CYCLE_ALLOW_OPERATOR === "true" ||
    process.env.RUN_CYCLE_SKIP_OWNER_CONFIG === "1" ||
    process.env.RUN_CYCLE_SKIP_OWNER_CONFIG === "true";
  if (!isOwner) {
    const isOperator = await core.operators(deployer.address);
    if (!isOperator) {
      throw new Error(`deployer is not owner or operator (owner=${owner})`);
    }
    if (!allowOperatorMode) {
      throw new Error(
        `deployer is not owner (owner=${owner}); set RUN_CYCLE_ALLOW_OPERATOR=1 to skip owner-only config updates`
      );
    }
    console.log("[run-cycle] deployer is operator; skipping owner-only config updates");
  }

  if (isOwner) {
    await (await core.setRiskConfig(wad(CONFIG.risk.lambda), wad(CONFIG.risk.kDrawdown), CONFIG.risk.enforceAlpha)).wait();
    await (await core.setFeeWaterfallConfig(
      wad(CONFIG.feeWaterfall.rhoBS),
      wad(CONFIG.feeWaterfall.phiLP),
      wad(CONFIG.feeWaterfall.phiBS),
      wad(CONFIG.feeWaterfall.phiTR)
    )).wait();
    await (await core.setSettlementTimeline(
      CONFIG.settlement.submitWindowSec,
      CONFIG.settlement.pendingOpsWindowSec,
      CONFIG.settlement.claimDelaySec
    )).wait();
    await (await core.setRedstoneConfig(
      ethers.encodeBytes32String(CONFIG.redstone.dataFeedId),
      CONFIG.redstone.feedDecimals,
      CONFIG.redstone.maxSampleDistanceSec,
      CONFIG.redstone.futureToleranceSec
    )).wait();
  }

  const latest = await ethers.provider.getBlock("latest");
  const now = latest?.timestamp ?? Math.floor(Date.now() / 1000);
  const startTimestamp = Math.max(1, now + CONFIG.market.startOffsetSec);
  const endTimestamp = startTimestamp + CONFIG.market.durationSec;
  const settlementTimestamp = endTimestamp + CONFIG.market.settlementDelaySec;
  const feePolicyAddress = CONFIG.feePolicyAddress;
  if (!feePolicyAddress) {
    throw new Error("feePolicyAddress is required in CONFIG");
  }

  const numBins = computeNumBins(CONFIG.market.minTick, CONFIG.market.maxTick, CONFIG.market.tickSpacing);
  const baseFactors = Array.from({ length: numBins }, () => WAD);
  const packedFactors = ethers.solidityPacked(
    Array(baseFactors.length).fill("uint256"),
    baseFactors
  );
  const seedData = await (await ethers.getContractFactory("SeedData")).deploy(packedFactors);
  await seedData.waitForDeployment();

  const nextMarketId = await core.nextMarketId();
  const expectedMarketId = await core.createMarket.staticCall(
    CONFIG.market.minTick,
    CONFIG.market.maxTick,
    CONFIG.market.tickSpacing,
    startTimestamp,
    endTimestamp,
    settlementTimestamp,
    numBins,
    BigInt(CONFIG.market.liquidityParameterWad),
    feePolicyAddress,
    seedData.target.toString()
  );
  const createTx = await core.createMarket(
    CONFIG.market.minTick,
    CONFIG.market.maxTick,
    CONFIG.market.tickSpacing,
    startTimestamp,
    endTimestamp,
    settlementTimestamp,
    numBins,
    BigInt(CONFIG.market.liquidityParameterWad),
    feePolicyAddress,
    seedData.target.toString()
  );
  await createTx.wait();
  const marketId = expectedMarketId ?? (nextMarketId + 1n);
  console.log(`[run-cycle] marketId=${marketId.toString()} created tx=${createTx.hash}`);

  let remaining = numBins;
  while (remaining > 0) {
    const count = remaining > CONFIG.market.seedChunkSize ? CONFIG.market.seedChunkSize : remaining;
    const seedTx = await core.seedNextChunks(marketId, count);
    await seedTx.wait();
    remaining -= count;
  }
  console.log(`[run-cycle] seeded market chunks`);

  const lowerTick = CONFIG.market.minTick + CONFIG.trade.lowerTickOffset;
  const upperTick = lowerTick + CONFIG.market.tickSpacing;
  const quantity = usd6(CONFIG.trade.quantityUsd6);
  const cost = await core.calculateOpenCost.staticCall(marketId, lowerTick, upperTick, quantity);
  const maxCost =
    cost + (cost * BigInt(CONFIG.trade.maxCostBpsBuffer)) / 10000n + 1n;
  const allowance = await payment.allowance(deployer.address, coreAddress);
  if (allowance < maxCost) {
    await (await payment.approve(coreAddress, maxCost)).wait();
  }
  const openTx = await core.openPosition(marketId, lowerTick, upperTick, quantity, maxCost);
  const openReceipt = await openTx.wait();

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);
  let positionId: bigint | null = null;
  for (const log of openReceipt?.logs ?? []) {
    try {
      const parsed = tradeIface.parseLog(log);
      if (parsed?.name === "PositionOpened") {
        positionId = BigInt(parsed.args.positionId.toString());
        break;
      }
    } catch {
      // ignore non-matching logs
    }
  }
  if (positionId === null) {
    throw new Error("PositionOpened event not found");
  }
  console.log(`[run-cycle] positionId=${positionId.toString()} openTx=${openTx.hash}`);

  const rpcUrl = (network.config as { url?: string }).url;
  if (!rpcUrl) throw new Error("Missing RPC URL in network config");
  const operatorKey = process.env.DEPLOYER_KEY;
  if (!operatorKey) throw new Error("Missing DEPLOYER_KEY for Redstone submission");

  const submitWindowSec = Number(await core.settlementSubmitWindow());
  const maxSampleDistance = Number(await core.maxSampleDistance());
  const currentBatchId = await core.currentBatchId();
  let settlementTimestampSec: number;
  let targetBatchId: bigint;

  if (isOwner) {
    const windowLagMax = submitWindowSec - CONFIG.settlementTiming.minWindowRemainingSec;
    const distanceLimit = maxSampleDistance > 0 ? maxSampleDistance - CONFIG.settlementTiming.lagBufferSec : windowLagMax;
    const lagFromTset = Math.max(1, Math.min(windowLagMax, distanceLimit));
    const nowForSettle = Math.floor(Date.now() / 1000);
    const forcedSettlementTimestamp = nowForSettle - lagFromTset;
    targetBatchId = toBatchId(BigInt(forcedSettlementTimestamp));
    if (targetBatchId <= currentBatchId) {
      throw new Error(
        `Settlement batch already processed (batchId=${targetBatchId.toString()} current=${currentBatchId.toString()}).`
      );
    }
    const forcedEndTimestamp = forcedSettlementTimestamp;
    const forcedStartTimestamp = Math.max(1, forcedEndTimestamp - 60);
    await (await core.updateMarketTiming(
      marketId,
      forcedStartTimestamp,
      forcedEndTimestamp,
      forcedSettlementTimestamp
    )).wait();
    settlementTimestampSec = forcedSettlementTimestamp;
    console.log(
      `[run-cycle] updateMarketTiming start=${forcedStartTimestamp} end=${forcedEndTimestamp} settle=${forcedSettlementTimestamp}`
    );
  } else {
    const marketTiming = await core.markets(marketId);
    settlementTimestampSec = Number(marketTiming.settlementTimestamp);
    if (!settlementTimestampSec) {
      throw new Error("Missing settlement timestamp on market");
    }
    targetBatchId = toBatchId(BigInt(settlementTimestampSec));
    if (targetBatchId <= currentBatchId) {
      throw new Error(
        `Settlement batch already processed (batchId=${targetBatchId.toString()} current=${currentBatchId.toString()}).`
      );
    }
    const nowForSettle = Math.floor(Date.now() / 1000);
    if (nowForSettle < settlementTimestampSec) {
      const waitSec = settlementTimestampSec - nowForSettle;
      console.log(`[run-cycle] waiting ${waitSec}s for settlement window`);
      await sleep((waitSec + 1) * 1000);
    }
    const nowForSample = Math.floor(Date.now() / 1000);
    const sampleDistance = Math.abs(nowForSample - settlementTimestampSec);
    if (maxSampleDistance > 0 && sampleDistance > maxSampleDistance) {
      throw new Error(
        `Sample distance too large (distance=${sampleDistance}s max=${maxSampleDistance}s); rerun with shorter timings`
      );
    }
  }

  const v5Provider = new V5JsonRpcProvider(rpcUrl);
  const v5Signer = new V5Wallet(operatorKey, v5Provider);
  const coreV5 = new V5Contract(coreAddress, ["function submitSettlementSample(uint256)"], v5Signer);
  const authorizedSigners = getSignersForDataServiceId(CONFIG.redstone.dataServiceId);
  const wrapped = WrapperBuilder.wrap(coreV5).usingDataService({
    dataServiceId: CONFIG.redstone.dataServiceId,
    dataPackagesIds: [CONFIG.redstone.dataFeedId],
    uniqueSignersCount: CONFIG.redstone.uniqueSigners,
    authorizedSigners,
  });

  const submitTx = await wrapped.submitSettlementSample(marketId.toString());
  await submitTx.wait();
  console.log(`[run-cycle] submitSettlementSample tx=${submitTx.hash}`);

  const settleEnd = settlementTimestampSec + submitWindowSec;
  while (true) {
    const latestBlock = await ethers.provider.getBlock("latest");
    const nowOnChain = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
    const waitSec = settleEnd - nowOnChain;
    if (waitSec <= 0) break;
    console.log(`[run-cycle] waiting ${waitSec}s for PendingOps`);
    await sleep((waitSec + 1) * 1000);
  }

  let finalized = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const state = await core.getMarketState(marketId);
      console.log(`[run-cycle] marketState=${state.toString()} attempt=${attempt + 1}`);
      const finalizeTx = await core.finalizePrimarySettlement(marketId);
      await finalizeTx.wait();
      console.log(`[run-cycle] finalizePrimarySettlement tx=${finalizeTx.hash}`);
      finalized = true;
      break;
    } catch (err) {
      const decoded = await decodeRevert(err);
      console.log(`[run-cycle] finalize failed reason=${decoded.name ?? "unknown"}`);
      if (
        decoded.name === "PendingOpsNotStarted" ||
        decoded.name === "SettlementWindowNotExpired" ||
        decoded.name === "NotInPendingOps"
      ) {
        console.log("[run-cycle] finalize retry after wait");
        await sleep(5000);
        continue;
      }
      if (decoded.name === "SettlementOracleCandidateMissing") {
        console.log("[run-cycle] resubmitting settlement sample");
        const retrySubmit = await wrapped.submitSettlementSample(marketId.toString());
        await retrySubmit.wait();
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
  if (!finalized) {
    throw new Error("finalizePrimarySettlement failed after retries");
  }

  let market = await core.markets(marketId);
  let calls = 0;
  while (!market.snapshotChunksDone && calls < CONFIG.settlementTiming.maxChunkCalls) {
    const chunkTx = await core.requestSettlementChunks(marketId, CONFIG.settlementTiming.maxChunksPerTx);
    await chunkTx.wait();
    calls += 1;
    market = await core.markets(marketId);
  }
  console.log(`[run-cycle] settlement chunks done=${market.snapshotChunksDone}`);

  const batchId = targetBatchId;
  const [total, resolved] = await core.getBatchMarketState(batchId);
  if (batchId === currentBatchId + 1n && total > 0n && resolved === total) {
    const batchTx = await core.processDailyBatch(batchId);
    await batchTx.wait();
    console.log(`[run-cycle] processDailyBatch batchId=${batchId.toString()} tx=${batchTx.hash}`);
  } else {
    console.warn(
      `[run-cycle] skip batch process: batchId=${batchId} current=${currentBatchId} total=${total} resolved=${resolved}`
    );
  }

  const windows = await core.getSettlementWindows.staticCall(marketId);
  const claimOpen = Number(windows[3]);
  const nowClaim = Math.floor(Date.now() / 1000);
  if (claimOpen > nowClaim) {
    const waitClaim = claimOpen - nowClaim;
    console.log(`[run-cycle] waiting ${waitClaim}s for claim window`);
    await sleep((waitClaim + 1) * 1000);
  }

  try {
    const claimTx = await core.claimPayout(positionId);
    await claimTx.wait();
    console.log(`[run-cycle] claimPayout positionId=${positionId.toString()} tx=${claimTx.hash}`);
  } catch (err) {
    const decoded = await decodeRevert(err);
    if (decoded.name === "ClaimTooEarly" && decoded.args?.length) {
      const claimOpenTs = Number(decoded.args[0]);
      const nowRetry = Math.floor(Date.now() / 1000);
      const waitMore = Math.max(0, claimOpenTs - nowRetry);
      console.log(`[run-cycle] ClaimTooEarly; waiting ${waitMore}s and retrying`);
      await sleep((waitMore + 1) * 1000);
      const retryTx = await core.claimPayout(positionId);
      await retryTx.wait();
      console.log(`[run-cycle] claimPayout retry tx=${retryTx.hash}`);
    } else {
      console.error("[run-cycle] claimPayout failed", decoded.name ?? err);
      throw err;
    }
  }

  const balance = await payment.balanceOf(deployer.address);
  console.log(`[run-cycle] finished. deployer balance=${balance.toString()} (6 decimals)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
