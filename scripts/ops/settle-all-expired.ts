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

function detectAsset(minTick: bigint): AssetType {
  const min = Number(minTick);
  if (min < 30) return "AVAX";       // legacy dollar-tick AVAX markets
  if (min >= 30 && min < 200) return "WTI";
  if (min >= 200 && min < 2000) return "AVAX";
  if (min >= 2000 && min < 20000) return "XAU";
  if (min >= 20000) return "BTC";
  return "UNKNOWN";
}

async function fetchRedstonePrice(feedId: string): Promise<bigint> {
  const url = `https://api.redstone.finance/prices?symbol=${feedId}&provider=redstone&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Array<{ value: number }>;
  const price = data[0]?.value;
  if (!price || price <= 0) throw new Error(`Invalid price for ${feedId}`);
  const value = BigInt(Math.round(price * 1_000_000));
  console.log(`[fetch] ${feedId} price: $${price} → ${value} (6 dec)`);
  return value;
}

// Cache fetched prices so we don't re-fetch per market
const priceCache = new Map<string, bigint>();

async function getSettlementValue(asset: AssetType): Promise<bigint> {
  const feedId = asset === "UNKNOWN" ? "AVAX" : asset;
  if (priceCache.has(feedId)) return priceCache.get(feedId)!;

  try {
    const value = await fetchRedstonePrice(feedId);
    priceCache.set(feedId, value);
    return value;
  } catch (err: any) {
    console.warn(`[fetch] Could not fetch ${feedId} price: ${err.message}`);
    // Fallback values
    const fallbacks: Record<string, bigint> = {
      AVAX: 8_880_000n,   // $8.88
      WTI: 106_000_000n,  // $106
      XAU: 2_900_000_000n, // $2,900
      BTC: 85_000_000_000n, // $85,000
    };
    const fallback = fallbacks[feedId] ?? 8_880_000n;
    console.warn(`[fetch] Using fallback: $${Number(fallback) / 1_000_000}`);
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
