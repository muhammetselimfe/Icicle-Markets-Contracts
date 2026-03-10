import hre from "hardhat";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

type SettlementMode = "secondary" | "primary";
type TimingMode = "auto" | "manual" | "skip";
type FilterMode = "active" | "unsettled";

interface CloseOpenMarketsConfig {
  targetEnv: Environment;
  filter: {
    mode: FilterMode;
    includeFailed: boolean;
    requireSeeded: boolean;
  };
  mode: SettlementMode;
  settlement: {
    valueUsd: string;
    tick: string;
  };
  timing: {
    mode: TimingMode;
    auto: {
      daysBack: number;
      durationSec: number;
      endOffsetSec: number;
    };
    manual: {
      startTimestamp: number;
      endTimestamp: number;
      settlementTimestamp: number;
    };
  };
  chunks: {
    maxPerTx: number;
    maxCalls: number;
  };
  batch: {
    run: boolean;
  };
  safety: {
    maxMarkets: number;
  };
}

const EXECUTE = process.env.EXECUTE === "1";
interface TimingResult {
  startTimestamp: number;
  endTimestamp: number;
  settlementTimestamp: number;
  batchId?: bigint;
  daysBack?: number;
}

// === Editable config (top-level) ============================================
const CONFIG: CloseOpenMarketsConfig = {
  targetEnv: "dev",
  filter: {
    mode: "unsettled",
    includeFailed: true,
    requireSeeded: true,
  },
  mode: "secondary", // "secondary" | "primary"
  settlement: {
    valueUsd: "85000", // 6 decimals, used when settlement.tick is empty
    tick: "", // if set, overrides valueUsd (settlementValue = tick * 1e6)
  },
  timing: {
    mode: "auto", // "auto" | "manual" | "skip"
    auto: {
      daysBack: 2, // move settlement into a past batch so processDailyBatch can run
      durationSec: 3600,
      endOffsetSec: 60,
    },
    manual: {
      startTimestamp: 0,
      endTimestamp: 0,
      settlementTimestamp: 0,
    },
  },
  chunks: {
    maxPerTx: 25,
    maxCalls: 20,
  },
  batch: {
    run: false,
  },
  safety: {
    maxMarkets: 0, // 0 = no limit
  },
};

// === Helpers ================================================================
const USD_DECIMALS = 6;
const BATCH_SECONDS = 86400n;
const BATCH_TIMEZONE_OFFSET = 8n * 3600n;

function usd6(value: string): bigint {
  return hre.ethers.parseUnits(value, USD_DECIMALS);
}

function resolveSettlementValue(): bigint {
  if (CONFIG.settlement.tick) {
    return BigInt(CONFIG.settlement.tick) * 1_000_000n;
  }
  return usd6(CONFIG.settlement.valueUsd);
}

function toBatchId(timestamp: bigint): bigint {
  if (timestamp < BATCH_TIMEZONE_OFFSET) return 0n;
  return (timestamp - BATCH_TIMEZONE_OFFSET) / BATCH_SECONDS;
}

function computeAutoTiming(now: number, submitWindowSec: number, currentBatchId: bigint): TimingResult | null {
  const minLagSec = Math.max(submitWindowSec + 5, CONFIG.timing.auto.endOffsetSec + 1);
  for (let daysBack = CONFIG.timing.auto.daysBack; daysBack >= 0; daysBack -= 1) {
    const settlementTimestamp =
      now - daysBack * Number(BATCH_SECONDS) - minLagSec;
    const endTimestamp = settlementTimestamp - CONFIG.timing.auto.endOffsetSec;
    const startTimestamp = endTimestamp - CONFIG.timing.auto.durationSec;
    if (startTimestamp <= 0 || endTimestamp <= startTimestamp || endTimestamp > settlementTimestamp) {
      continue;
    }
    const batchId = toBatchId(BigInt(settlementTimestamp));
    if (batchId <= currentBatchId) {
      continue;
    }
    return { startTimestamp, endTimestamp, settlementTimestamp, batchId, daysBack };
  }
  const nextBatchId = currentBatchId + 1n;
  const batchStart = nextBatchId * BATCH_SECONDS + BATCH_TIMEZONE_OFFSET;
  const settlementTimestamp = Number(batchStart + BigInt(minLagSec));
  const endTimestamp = now - CONFIG.timing.auto.endOffsetSec;
  const startTimestamp = endTimestamp - CONFIG.timing.auto.durationSec;
  if (startTimestamp <= 0 || endTimestamp <= startTimestamp || endTimestamp > settlementTimestamp) {
    return null;
  }
  return {
    startTimestamp,
    endTimestamp,
    settlementTimestamp,
    batchId: nextBatchId,
    daysBack: -1,
  };
}

function isActiveMarket(market: any, now: number): boolean {
  const start = Number(market.startTimestamp);
  const end = Number(market.endTimestamp);
  return now >= start && now <= end;
}

function shouldCloseMarket(market: any, now: number): boolean {
  if (market.numBins === 0n) return false;
  if (market.settled) return false;
  if (!CONFIG.filter.includeFailed && market.failed) return false;
  if (CONFIG.filter.requireSeeded && !market.isSeeded) return false;
  if (CONFIG.filter.mode === "unsettled") return true;
  return isActiveMarket(market, now);
}

async function maybeUpdateTiming(
  core: any,
  marketId: bigint,
  now: number,
  submitWindowSec: number,
  currentBatchId: bigint
) {
  if (CONFIG.timing.mode === "skip") return false;

  const timing: TimingResult | null =
    CONFIG.timing.mode === "manual"
      ? {
          startTimestamp: CONFIG.timing.manual.startTimestamp,
          endTimestamp: CONFIG.timing.manual.endTimestamp,
          settlementTimestamp: CONFIG.timing.manual.settlementTimestamp,
        }
      : computeAutoTiming(now, submitWindowSec, currentBatchId);

  if (!timing) {
    throw new Error("[close-open-markets] no unprocessed batch available for auto timing");
  }

  console.log(
    `[close-open-markets] updateMarketTiming marketId=${marketId.toString()} start=${timing.startTimestamp} end=${timing.endTimestamp} settle=${timing.settlementTimestamp} daysBack=${timing.daysBack ?? "manual"}`
  );
  if (!EXECUTE) return true;
  await (await core.updateMarketTiming(
    marketId,
    timing.startTimestamp,
    timing.endTimestamp,
    timing.settlementTimestamp
  )).wait();
  return true;
}

async function settleMarket(core: any, marketId: bigint, market: any, settlementValue: bigint) {
  if (market.settled) {
    console.log(`[close-open-markets] marketId=${marketId.toString()} already settled`);
    return market;
  }

  if (CONFIG.mode === "primary") {
    console.log(`[close-open-markets] finalizePrimarySettlement marketId=${marketId.toString()}`);
    if (!EXECUTE) return market;
    await (await core.finalizePrimarySettlement(marketId)).wait();
  } else {
    if (!market.failed) {
      console.log(`[close-open-markets] markSettlementFailed marketId=${marketId.toString()}`);
      if (EXECUTE) {
        await (await core.markSettlementFailed(marketId)).wait();
      }
    }
    console.log(
      `[close-open-markets] finalizeSecondarySettlement marketId=${marketId.toString()} value=${settlementValue.toString()}`
    );
    if (!EXECUTE) return market;
    await (await core.finalizeSecondarySettlement(marketId, settlementValue)).wait();
  }

  if (!EXECUTE) return market;
  return await core.markets(marketId);
}

async function requestSnapshotChunks(core: any, marketId: bigint, market: any) {
  if (market.snapshotChunksDone) {
    console.log(`[close-open-markets] snapshot chunks already done marketId=${marketId.toString()}`);
    return market;
  }
  let calls = 0;
  let updated = market;
  while (!updated.snapshotChunksDone && calls < CONFIG.chunks.maxCalls) {
    console.log(`[close-open-markets] requestSettlementChunks marketId=${marketId.toString()} call=${calls + 1}`);
    if (!EXECUTE) break;
    await (await core.requestSettlementChunks(marketId, CONFIG.chunks.maxPerTx)).wait();
    updated = await core.markets(marketId);
    calls += 1;
  }
  if (!updated.snapshotChunksDone) {
    console.warn(`[close-open-markets] snapshotChunksDone=false marketId=${marketId.toString()}`);
  }
  return updated;
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[close-open-markets] environment=${env} network=${network.name} execute=${EXECUTE}`);
  if (CONFIG.targetEnv && env !== CONFIG.targetEnv) {
    throw new Error(`Refusing to run on ${env} (expected ${CONFIG.targetEnv})`);
  }

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const [deployer] = await ethers.getSigners();
  if (EXECUTE && !deployer) {
    throw new Error("Missing signer (set DEPLOYER_KEY for transactions)");
  }
  const runner: any = EXECUTE ? deployer : ethers.provider;
  const core = await ethers.getContractAt(
    "IcicleOptionsCore",
    coreAddress,
    runner
  );
  const owner = await core.owner();
  const signerAddress = deployer?.address ?? "unknown";
  console.log(`[close-open-markets] coreOwner=${owner} signer=${signerAddress}`);
  if (EXECUTE && signerAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Signer is not core owner (updateMarketTiming/finalizeSecondarySettlement require owner)");
  }

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const submitWindowSec = Number(await core.settlementSubmitWindow());
  const currentBatchId = await core.currentBatchId();
  const todayBatchId = toBatchId(BigInt(now));
  console.log(
    `[close-open-markets] currentBatchId=${currentBatchId.toString()} todayBatchId=${todayBatchId.toString()}`
  );

  const nextMarketId = await core.nextMarketId();
  console.log(`[close-open-markets] nextMarketId=${nextMarketId.toString()}`);

  const candidates: bigint[] = [];
  for (let marketId = 1n; marketId <= nextMarketId; marketId += 1n) {
    const market = await core.markets(marketId);
    const active = isActiveMarket(market, now);
    console.log(
      `[close-open-markets] marketId=${marketId.toString()} active=${active} settled=${market.settled} failed=${market.failed} seeded=${market.isSeeded} start=${market.startTimestamp.toString()} end=${market.endTimestamp.toString()} tSet=${market.settlementTimestamp.toString()} openPositions=${market.openPositionCount.toString()}`
    );
    if (shouldCloseMarket(market, now)) {
      candidates.push(marketId);
    }
  }

  if (candidates.length === 0) {
    console.log("[close-open-markets] no markets matched filter");
    return;
  }

  if (CONFIG.safety.maxMarkets > 0 && candidates.length > CONFIG.safety.maxMarkets) {
    throw new Error(
      `[close-open-markets] refusing to close ${candidates.length} markets (max=${CONFIG.safety.maxMarkets})`
    );
  }

  const settlementValue = resolveSettlementValue();
  const batchIds = new Set<bigint>();

  for (const marketId of candidates) {
    let market = await core.markets(marketId);
    await maybeUpdateTiming(core, marketId, now, submitWindowSec, currentBatchId);
    if (EXECUTE) {
      market = await core.markets(marketId);
    }
    market = await settleMarket(core, marketId, market, settlementValue);
    if (EXECUTE) {
      market = await requestSnapshotChunks(core, marketId, market);
      const batchId = toBatchId(BigInt(market.settlementTimestamp));
      batchIds.add(batchId);
    }
  }

  if (EXECUTE && CONFIG.batch.run && batchIds.size > 0) {
    for (const batchId of batchIds) {
      const [total, resolved] = await core.getBatchMarketState(batchId);
      if (total === 0n) {
        console.warn(`[close-open-markets] skip batch ${batchId.toString()} (no markets assigned)`);
        continue;
      }
      if (resolved !== total) {
        console.warn(
          `[close-open-markets] skip batch ${batchId.toString()} (resolved ${resolved.toString()}/${total.toString()})`
        );
        continue;
      }
      try {
        console.log(`[close-open-markets] processDailyBatch batchId=${batchId.toString()}`);
        await (await core.processDailyBatch(batchId)).wait();
      } catch (err) {
        console.warn("[close-open-markets] processDailyBatch failed (batch not ready or not ended yet)");
        console.warn(err);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
