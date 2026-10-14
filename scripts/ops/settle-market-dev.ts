/**
 * Settle a market using Redstone primary oracle (signed-pull).
 *
 * Handles per-asset oracle config:
 *   - AVAX ticks are in cents (tickDivisor=100) → feedDecimals=6
 *   - BTC/WTI/XAU ticks are in dollars (tickDivisor=1) → feedDecimals=8
 *
 * The Redstone feed returns prices with 8 decimals.
 * The contract converts: settlementValue = price / 10^(feedDecimals - 6)
 * Then: tick = settlementValue / 1e6
 *
 * For AVAX at $9.88:
 *   Redstone value = 988,000,000 (8 dec)
 *   feedDecimals=6 → no scaling → settlementValue = 988,000,000
 *   tick = 988 (cents) = $9.88 ✓
 *
 * For BTC at $85,000:
 *   Redstone value = 8,500,000,000,000 (8 dec)
 *   feedDecimals=8 → scale down by 100 → settlementValue = 85,000,000,000
 *   tick = 85,000 (dollars) ✓
 *
 * Usage:
 *   npx hardhat run scripts/ops/settle-market-dev.ts --network fuji
 */
import hre from "hardhat";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { getSignersForDataServiceId, type DataServiceIds } from "@redstone-finance/sdk";
import { Contract as V5Contract } from "@ethersproject/contracts";
import { JsonRpcProvider as V5JsonRpcProvider } from "@ethersproject/providers";
import { Wallet as V5Wallet } from "@ethersproject/wallet";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

interface SettleConfig {
  marketId: number;
  timeline: {
    enforce: boolean;
    submitWindowSec: number;
    pendingOpsWindowSec: number;
    claimDelaySec: number;
  };
  redstone: {
    dataServiceId: DataServiceIds;
    dataFeedId: string;
    uniqueSigners: number;
  };
  timing: {
    minWindowRemainingSec: number;
    lagBufferSec: number;
  };
  chunks: {
    run: boolean;
    maxPerTx: number;
    maxCalls: number;
  };
  batch: {
    run: boolean;
  };
}

// === Editable config (top-level) ============================================
const CONFIG: SettleConfig = {
  marketId: 0, // 0 = use latest (core.nextMarketId)
  timeline: {
    enforce: true,
    submitWindowSec: 600,
    pendingOpsWindowSec: 300,
    claimDelaySec: 900,
  },
  redstone: {
    dataServiceId: "redstone-primary-prod",
    dataFeedId: "AVAX",
    uniqueSigners: 3,
  },
  timing: {
    minWindowRemainingSec: 60,
    lagBufferSec: 5,
  },
  chunks: {
    run: true,
    maxPerTx: 25,
    maxCalls: 20,
  },
  batch: {
    run: false,
  },
};

const BATCH_SECONDS = 86400n;
const BATCH_TIMEZONE_OFFSET = 8n * 3600n;

/**
 * Per-asset oracle config.
 *
 * Redstone returns all prices with 8 decimals.
 * feedDecimals controls how the contract scales to settlementValue:
 *   settlementValue = redstonePrice / 10^(feedDecimals - 6)
 *   tick = settlementValue / 1e6
 *
 * For cent-based ticks (AVAX): feedDecimals=6 → no scaling → tick in cents ✓
 * For dollar-based ticks (BTC/WTI/XAU): feedDecimals=8 → /100 → tick in dollars ✓
 */
const ASSET_ORACLE_CONFIG: Record<string, { feedDecimals: number; tickDivisor: number }> = {
  AVAX: { feedDecimals: 6, tickDivisor: 100 },
  BTC:  { feedDecimals: 8, tickDivisor: 1 },
  WTI:  { feedDecimals: 8, tickDivisor: 1 },
  XAU:  { feedDecimals: 8, tickDivisor: 1 },
  ETH:  { feedDecimals: 8, tickDivisor: 1 },
};

function toBatchId(timestamp: bigint): bigint {
  if (timestamp < BATCH_TIMEZONE_OFFSET) return 0n;
  return (timestamp - BATCH_TIMEZONE_OFFSET) / BATCH_SECONDS;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[settle-market-dev] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress, deployer);

  const rpcUrl = (network.config as { url?: string }).url;
  if (!rpcUrl) throw new Error("Missing RPC URL in network config");
  const operatorKey = process.env.DEPLOYER_KEY;
  if (!operatorKey) throw new Error("Missing DEPLOYER_KEY for Redstone submission");
  const v5Provider = new V5JsonRpcProvider(rpcUrl);
  const v5Signer = new V5Wallet(operatorKey, v5Provider);
  const coreV5 = new V5Contract(
    coreAddress,
    ["function submitSettlementSample(uint256)"],
    v5Signer
  );

  // --- Enforce settlement timeline ---
  if (CONFIG.timeline.enforce) {
    const submitWindow = await core.settlementSubmitWindow();
    const pendingOps = await core.pendingOpsWindow();
    const claimDelay = await core.claimDelaySeconds();
    if (
      submitWindow !== BigInt(CONFIG.timeline.submitWindowSec) ||
      pendingOps !== BigInt(CONFIG.timeline.pendingOpsWindowSec) ||
      claimDelay !== BigInt(CONFIG.timeline.claimDelaySec)
    ) {
      console.log(
        `[settle-market-dev] setSettlementTimeline submit=${CONFIG.timeline.submitWindowSec} ops=${CONFIG.timeline.pendingOpsWindowSec} claim=${CONFIG.timeline.claimDelaySec}`
      );
      await (await core.setSettlementTimeline(
        CONFIG.timeline.submitWindowSec,
        CONFIG.timeline.pendingOpsWindowSec,
        CONFIG.timeline.claimDelaySec
      )).wait();
    }
  }

  const submitWindowSec = Number(await core.settlementSubmitWindow());
  const pendingOpsSec = Number(await core.pendingOpsWindow());
  const maxSampleDistance = Number(await core.maxSampleDistance());

  // --- Resolve market ---
  const marketId =
    CONFIG.marketId > 0 ? BigInt(CONFIG.marketId) : await core.nextMarketId();
  const marketIdValue = marketId.toString();
  const market = await core.markets(marketId);
  if (market.numBins === 0n) {
    throw new Error(`Market not found: ${marketId.toString()}`);
  }
  if (market.settled) {
    throw new Error(`Market already settled: ${marketId.toString()}`);
  }

  // --- Set per-asset oracle config (feedId + feedDecimals) ---
  const feedId = CONFIG.redstone.dataFeedId;
  const assetConfig = ASSET_ORACLE_CONFIG[feedId];
  if (!assetConfig) {
    throw new Error(`Unknown asset feed: ${feedId}. Add it to ASSET_ORACLE_CONFIG.`);
  }

  const currentFeedDecimals = Number(await core.redstoneFeedDecimals());
  const currentFeedId = await core.redstoneFeedId();
  const expectedFeedIdBytes = ethers.encodeBytes32String(feedId);

  if (currentFeedDecimals !== assetConfig.feedDecimals || currentFeedId !== expectedFeedIdBytes) {
    console.log(
      `[settle-market-dev] setRedstoneConfig feedId=${feedId} feedDecimals=${assetConfig.feedDecimals} (was ${currentFeedDecimals})`
    );
    await (await core.setRedstoneConfig(
      expectedFeedIdBytes,
      assetConfig.feedDecimals,
      maxSampleDistance,
      Number(await core.futureTolerance()),
    )).wait();
  } else {
    console.log(`[settle-market-dev] oracle config OK: feedId=${feedId} feedDecimals=${assetConfig.feedDecimals}`);
  }

  // --- Adjust timing for immediate settlement ---
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);

  const windowLagMax = submitWindowSec - CONFIG.timing.minWindowRemainingSec;
  const distanceLimit = maxSampleDistance > 0 ? maxSampleDistance - CONFIG.timing.lagBufferSec : windowLagMax;
  const lagFromTset = Math.max(1, Math.min(windowLagMax, distanceLimit));
  if (lagFromTset >= submitWindowSec) {
    throw new Error("Settlement window too small for immediate submission");
  }
  const settlementTimestamp = now - lagFromTset;
  let endTimestamp = settlementTimestamp;
  let startTimestamp = Number(market.startTimestamp);
  if (startTimestamp >= endTimestamp) {
    startTimestamp = endTimestamp - 1;
  }
  if (startTimestamp <= 0 || endTimestamp <= startTimestamp) {
    throw new Error("Invalid timing computed for updateMarketTiming");
  }

  console.log(
    `[settle-market-dev] updateMarketTiming start=${startTimestamp} end=${endTimestamp} settle=${settlementTimestamp} lag=${lagFromTset}s`
  );
  await (await core.updateMarketTiming(
    marketId,
    startTimestamp,
    endTimestamp,
    settlementTimestamp
  )).wait();

  // --- Submit Redstone oracle price ---
  const authorizedSigners = getSignersForDataServiceId(CONFIG.redstone.dataServiceId);
  const wrapped = WrapperBuilder.wrap(coreV5).usingDataService({
    dataServiceId: CONFIG.redstone.dataServiceId,
    dataPackagesIds: [CONFIG.redstone.dataFeedId],
    uniqueSignersCount: CONFIG.redstone.uniqueSigners,
    authorizedSigners,
  });

  console.log(`[settle-market-dev] submitSettlementSample marketId=${marketIdValue} feed=${feedId}`);
  await (await wrapped.submitSettlementSample(marketIdValue)).wait();

  // --- Wait for PendingOps to end ---
  const opsEnd = settlementTimestamp + submitWindowSec + pendingOpsSec;
  const nowAfterSubmit = Math.floor(Date.now() / 1000);
  const waitSec = opsEnd - nowAfterSubmit;
  if (waitSec > 0) {
    console.log(`[settle-market-dev] waiting ${waitSec}s for PendingOps end`);
    await sleep((waitSec + 1) * 1000);
  }

  // --- Finalize ---
  console.log(`[settle-market-dev] finalizePrimarySettlement marketId=${marketId.toString()}`);
  await (await core.finalizePrimarySettlement(marketId)).wait();

  // --- Verify settlement ---
  const settled = await core.markets(marketId);
  const settlementTick = settled[15]; // settlementTick field
  const settlementValue = settled[16]; // settlementValue field
  const tickPrice = Number(settlementTick) / assetConfig.tickDivisor;
  console.log(
    `[settle-market-dev] settled! tick=${settlementTick} ($${tickPrice.toFixed(2)}) settlementValue=${settlementValue}`
  );

  // --- Settlement chunks ---
  if (CONFIG.chunks.run) {
    let updated = await core.markets(marketId);
    let calls = 0;
    while (!updated.snapshotChunksDone && calls < CONFIG.chunks.maxCalls) {
      console.log(`[settle-market-dev] requestSettlementChunks call=${calls + 1}`);
      await (await core.requestSettlementChunks(marketId, CONFIG.chunks.maxPerTx)).wait();
      updated = await core.markets(marketId);
      calls += 1;
    }
    if (!updated.snapshotChunksDone) {
      console.warn("[settle-market-dev] snapshotChunksDone is still false (increase maxCalls?)");
    }
  }

  // --- Optional batch processing ---
  if (CONFIG.batch.run) {
    const tSet = BigInt(settlementTimestamp);
    const batchId = toBatchId(tSet);
    const [total, resolved] = await core.getBatchMarketState(batchId);
    const currentBatchId = await core.currentBatchId();
    if (batchId != currentBatchId + 1n) {
      console.warn(
        `[settle-market-dev] skip batch ${batchId.toString()} (currentBatchId=${currentBatchId.toString()})`
      );
    } else if (total === 0n) {
      console.warn(`[settle-market-dev] skip batch ${batchId.toString()} (no markets assigned)`);
    } else if (resolved !== total) {
      console.warn(
        `[settle-market-dev] skip batch ${batchId.toString()} (resolved ${resolved.toString()}/${total.toString()})`
      );
    } else {
      console.log(`[settle-market-dev] processDailyBatch batchId=${batchId.toString()}`);
      await (await core.processDailyBatch(batchId)).wait();
    }
  }

  console.log(
    `[settle-market-dev] done submitWindow=${submitWindowSec}s pendingOps=${pendingOpsSec}s`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
