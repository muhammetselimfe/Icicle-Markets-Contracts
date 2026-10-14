/**
 * Batch-settle all expired, unsettled markets via secondary settlement.
 *
 * Flow per market:
 *   1. markSettlementFailed(marketId)     — marks oracle as absent
 *   2. finalizeSecondarySettlement(id, v) — settles with manual price
 *   3. requestSettlementChunks(id, 25)    — snapshots positions (loop)
 *
 * Asset detection: uses tick range to determine asset, fetches correct price per asset.
 *
 * Usage:
 *   npx hardhat run scripts/ops/settle-all-expired.ts --network fuji
 *
 * Env:
 *   DEPLOYER_KEY  — owner private key (required)
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

// ─── Config ────────────────────────────────────────────────────────────────
/** Max requestSettlementChunks calls per market */
const MAX_CHUNK_CALLS = 20;

/** Bins per chunk call */
const CHUNK_SIZE = 25;
// ───────────────────────────────────────────────────────────────────────────

type AssetType = "AVAX" | "WTI" | "XAU" | "BTC" | "UNKNOWN";

// Tick divisor: how many tick units per dollar.
// Contract converts settlementValue to tick via: tick = settlementValue / 1e6
// So settlementValue must equal tick * 1e6, i.e. price * tickDivisor * 1e6.
//   AVAX ticks are cents (900 = $9.00) → divisor = 100
//   WTI/XAU/BTC ticks are dollars      → divisor = 1
const TICK_DIVISOR: Record<AssetType, number> = {
  AVAX: 100,
  WTI: 1,
  XAU: 1,
  BTC: 1,
  UNKNOWN: 1,
};

function detectAsset(minTick: bigint): AssetType {
  const min = Number(minTick);
  if (min < 30) return "AVAX";       // legacy dollar-tick AVAX markets
  if (min >= 30 && min < 200) return "WTI";
  if (min >= 200 && min < 2000) return "AVAX";
  if (min >= 2000 && min < 20000) return "XAU";
  if (min >= 20000) return "BTC";
  return "UNKNOWN";
}

async function fetchRedstonePrice(feedId: string, tickDivisor: number): Promise<bigint> {
  const url = `https://api.redstone.finance/prices?symbol=${feedId}&provider=redstone&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Array<{ value: number }>;
  const price = data[0]?.value;
  if (!price || price <= 0) throw new Error(`Invalid price for ${feedId}`);
  // settlementValue = price * tickDivisor * 1e6
  // so that _toSettlementTick gives: settlementValue / 1e6 = price * tickDivisor = correct tick
  const value = BigInt(Math.round(price * tickDivisor * 1_000_000));
  const expectedTick = Number(value / 1_000_000n);
  console.log(`[fetch] ${feedId} price: $${price}, tickDivisor: ${tickDivisor}, settlementValue: ${value}, expectedTick: ${expectedTick}`);
  return value;
}

// Cache fetched prices so we don't re-fetch per market
const priceCache = new Map<string, bigint>();

async function getSettlementValue(asset: AssetType): Promise<bigint> {
  const feedId = asset === "UNKNOWN" ? "AVAX" : asset;
  const tickDivisor = TICK_DIVISOR[asset];
  if (priceCache.has(feedId)) return priceCache.get(feedId)!;

  try {
    const value = await fetchRedstonePrice(feedId, tickDivisor);
    priceCache.set(feedId, value);
    return value;
  } catch (err: any) {
    console.warn(`[fetch] Could not fetch ${feedId} price: ${err.message}`);
    // Fallback values (already in correct settlementValue format: tick * 1e6)
    // AVAX: tick 888 ($8.88) → 888_000_000
    // WTI: tick 106 ($106) → 106_000_000
    // XAU: tick 2900 ($2,900) → 2_900_000_000
    // BTC: tick 85000 ($85,000) → 85_000_000_000
    const fallbacks: Record<string, bigint> = {
      AVAX: 888_000_000n,
      WTI: 106_000_000n,
      XAU: 2_900_000_000n,
      BTC: 85_000_000_000n,
    };
    const fallback = fallbacks[feedId] ?? 888_000_000n;
    console.warn(`[fetch] Using fallback: expectedTick=${Number(fallback / 1_000_000n)}`);
    priceCache.set(feedId, fallback);
    return fallback;
  }
}

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");

  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in fuji.json");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const nextId = await core.nextMarketId();
  console.log(`Total markets: ${nextId}`);

  // Scan all markets
  const toSettle: { id: bigint; asset: AssetType }[] = [];
  for (let i = 1n; i <= nextId; i++) {
    const market = await core.markets(i);
    if (market.numBins === 0n) continue;
    if (market.settled) {
      console.log(`  Market #${i}: already settled ✓`);
      continue;
    }
    const state = Number(await core.getMarketState.staticCall(i));
    const asset = detectAsset(market.minTick);
    console.log(`  Market #${i}: state=${state}, settled=${market.settled}, failed=${market.failed}, asset=${asset}, ticks=${market.minTick}-${market.maxTick}`);
    // States 2 (PendingOps) and 3 (past PendingOps) are eligible
    if (state >= 2) {
      toSettle.push({ id: i, asset });
    } else {
      console.log(`    → skipping (still trading or in settlement window)`);
    }
  }

  if (toSettle.length === 0) {
    console.log("\nNo markets need settlement.");
    return;
  }

  // Pre-fetch all needed prices
  const uniqueAssets = [...new Set(toSettle.map(m => m.asset))];
  console.log(`\nFetching prices for: ${uniqueAssets.join(", ")}`);
  for (const asset of uniqueAssets) {
    await getSettlementValue(asset);
  }

  console.log(`\n=== Settling ${toSettle.length} market(s): [${toSettle.map(m => `#${m.id}(${m.asset})`).join(", ")}] ===\n`);

  let settled = 0;
  let failed = 0;

  for (const { id: marketId, asset } of toSettle) {
    const settlementValue = await getSettlementValue(asset);
    console.log(`--- Market #${marketId} (${asset}, settlement=$${Number(settlementValue) / 1_000_000}) ---`);

    const market = await core.markets(marketId);

    // Step 1: Mark as failed (if not already)
    if (!market.failed) {
      console.log(`  [1/3] markSettlementFailed...`);
      try {
        const tx = await core.markSettlementFailed(marketId);
        await tx.wait();
        console.log(`    ✓ tx: ${tx.hash}`);
      } catch (err: any) {
        const reason = err.reason || err.message || String(err);
        console.error(`    ✗ markSettlementFailed failed: ${reason}`);
        failed++;
        continue;
      }
    } else {
      console.log(`  [1/3] already marked failed`);
    }

    // Step 2: Finalize secondary settlement
    console.log(`  [2/3] finalizeSecondarySettlement (value=${settlementValue})...`);
    try {
      // Dry-run first
      await core.finalizeSecondarySettlement.staticCall(marketId, settlementValue);
      const tx = await core.finalizeSecondarySettlement(marketId, settlementValue);
      await tx.wait();
      console.log(`    ✓ tx: ${tx.hash}`);
    } catch (err: any) {
      const reason = err.reason || err.message || String(err);
      console.error(`    ✗ finalizeSecondarySettlement failed: ${reason}`);
      failed++;
      continue;
    }

    // Step 3: Process settlement chunks
    const updated = await core.markets(marketId);
    if (updated.settled && !updated.snapshotChunksDone) {
      console.log(`  [3/3] requestSettlementChunks...`);
      let calls = 0;
      let m = updated;
      while (!m.snapshotChunksDone && calls < MAX_CHUNK_CALLS) {
        const tx = await core.requestSettlementChunks(marketId, CHUNK_SIZE);
        await tx.wait();
        m = await core.markets(marketId);
        calls++;
      }
      if (m.snapshotChunksDone) {
        console.log(`    ✓ done (${calls} chunk call(s))`);
      } else {
        console.warn(`    ⚠ snapshotChunksDone still false after ${calls} calls`);
      }
    } else if (updated.snapshotChunksDone) {
      console.log(`  [3/3] chunks already done`);
    }

    // Verify final state
    const final = await core.markets(marketId);
    console.log(`  Result: settled=${final.settled}, tick=${final.settlementTick}, value=${final.settlementValue}`);
    settled++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Settled: ${settled}/${toSettle.length}`);
  if (failed > 0) console.log(`  Failed:  ${failed}/${toSettle.length}`);
  for (const [feedId, value] of priceCache) {
    console.log(`  ${feedId} settlement: $${Number(value) / 1_000_000}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
