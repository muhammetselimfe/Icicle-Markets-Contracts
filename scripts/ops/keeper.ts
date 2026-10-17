// Keeper: keeps the v2 Fuji deployment running automatically.
//   - refreshes the trade oracle for active markets (so trades price against a fresh price)
//   - submits + finalizes settlement when a market's window opens/closes (primary, real Redstone)
//   - processes daily batches as they end (advances the pointer; realizes LP P&L into NAV)
//
// Run (background): npx hardhat run scripts/ops/keeper.ts --network fuji
//   INTERVAL_SEC=10  (loop cadence)   MAX_LOOPS=0 (0 = forever)   SKIP_BATCHES=1 (do not process ended batches)
//   HEARTBEAT_SEC=40 (refresh a market even if its bin did not move once the cached price is this old)
//
// Trade-oracle refreshes are event-driven and parallel: each loop fetches the live Redstone
// price once, refreshes only the markets whose cached on-chain bin differs from the live bin
// (or whose cached price is older than HEARTBEAT_SEC), and sends those refreshes in one
// nonce-sequenced burst instead of one receipt-wait after another. With six open markets the
// old serial loop left the on-chain centre 60–90 s behind the price the UI shows.
import hre from "hardhat";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { getSignersForDataServiceId, requestDataPackages } from "@redstone-finance/sdk";
import { Contract as V5Contract } from "@ethersproject/contracts";
import { JsonRpcProvider as V5Provider } from "@ethersproject/providers";
import { Wallet as V5Wallet } from "@ethersproject/wallet";
import { loadEnvironment } from "../utils/environment";

const DS = "redstone-primary-prod" as const;
const SIGNERS = 3;
const OFFSET = 28_800;
// Bound every on-chain/Redstone call so one stalled RPC or data-service fetch cannot
// eat the 120s settlement submit window (this happened on Fuji market 6).
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS ?? "45000");
const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), CALL_TIMEOUT_MS))]);

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const feed: string = (env.config as any).redstoneFeedId ?? "AVAX";
  const interval = Number(process.env.INTERVAL_SEC ?? "10");
  const heartbeat = Number(process.env.HEARTBEAT_SEC ?? "40");
  const maxLoops = Number(process.env.MAX_LOOPS ?? "0");
  const skipBatches = process.env.SKIP_BATCHES === "1";
  const rpc = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
  const key = process.env.DEPLOYER_KEY!;

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddr);
  const v5signer = new V5Wallet(key, new V5Provider(rpc));
  const auth = (getSignersForDataServiceId as any)(DS);
  const REFRESH = new V5Contract(coreAddr, ["function refreshTradeOracle(uint256)"], v5signer);
  const SUBMIT = new V5Contract(coreAddr, ["function submitSettlementSample(uint256)"], v5signer);
  const wrap = (c: any) => WrapperBuilder.wrap(c).usingDataService({ dataServiceId: DS, dataPackagesIds: [feed], uniqueSignersCount: SIGNERS, authorizedSigners: auth });

  // live price -> on-chain tick, mirroring OracleModule._toSettlementTick (feed value / 1e6, clamped, aligned)
  const livePrice = async (): Promise<number> => {
    const r: any = await withTimeout(requestDataPackages({ dataServiceId: DS, dataPackagesIds: [feed], uniqueSignersCount: 1, authorizedSigners: auth }) as any, "live price");
    return Number(r[feed][0].dataPackage.dataPoints[0].toObj().value);
  };
  const liveTick = (price: number, m: any): bigint => {
    const spacing = BigInt(m.tickSpacing); const minTick = BigInt(m.minTick); const last = BigInt(m.maxTick) - spacing;
    let t = BigInt(Math.floor(price * 100)); // 8-dec feed read as 6-dec => cents
    if (t < minTick) t = minTick; if (t > last) t = last;
    return minTick + ((t - minTick) / spacing) * spacing;
  };
  // the set of markets worth reading each loop is rescanned when a market is created or every ~60 s
  let watched: number[] = []; let lastScanN = -1; let lastScanAt = 0;

  const period = Number(await core.batchSeconds()) || 86400;
  const submitW = Number(await core.settlementSubmitWindow());
  const opsW = Number(await core.pendingOpsWindow());
  console.log(`keeper: core=${coreAddr} feed=${feed} period=${period}s submit=${submitW} ops=${opsW}`);

  for (let loop = 0; maxLoops === 0 || loop < maxLoops; loop++) {
    try {
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const n = Number(await core.nextMarketId());
      if (n !== lastScanN || now - lastScanAt > 60) {
        watched = [];
        for (let id = 1; id <= n; id++) { const m = await core.markets(id); if (m.dynamicEnabled && !m.settled && !m.failed) watched.push(id); }
        lastScanN = n; lastScanAt = now;
      }
      const states = new Map<number, any>();
      for (const id of watched) states.set(id, await core.markets(id));
      // --- trade-oracle refresh: only where the live bin moved or the cached price is stale, all in one burst
      const trading = watched.filter((id) => { const m = states.get(id); return now >= Number(m.startTimestamp) && now < Number(m.settlementTimestamp) && !m.tradingHalted; });
      if (trading.length) {
        let price = 0; try { price = await livePrice(); } catch (e: any) { console.log(`[${loop}] live price skip: ${(e.message||"").slice(0,50)}`); }
        const due = price ? trading.filter((id) => { const m = states.get(id); const age = now - Number(m.cachedOracleTs); return Number(m.cachedOracleTs) === 0 || age >= heartbeat || liveTick(price, m) !== BigInt(m.cachedOracleTick); }) : [];
        if (due.length) {
          let nonce = await v5signer.getTransactionCount("pending");
          const sent: { id: number; p: Promise<any> }[] = [];
          for (const id of due) {
            try { const tx: any = await withTimeout(wrap(REFRESH).refreshTradeOracle(id, { gasLimit: 3_000_000, nonce: nonce++ }) as Promise<any>, "refresh send"); sent.push({ id, p: tx.wait() }); }
            catch (e: any) { console.log(`[${loop}] refresh mkt ${id} send skip: ${(e.message||"").slice(0,50)}`); nonce--; }
          }
          const rs = await Promise.allSettled(sent.map((x) => withTimeout(x.p, "refresh receipt")));
          const ok = sent.filter((_, i) => rs[i].status === "fulfilled").map((x) => x.id);
          const bad = sent.filter((_, i) => rs[i].status !== "fulfilled").map((x) => x.id);
          console.log(`[${loop}] price ${price.toFixed(4)}: refreshed ${ok.join(",") || "-"}${bad.length ? ` failed ${bad.join(",")}` : ""} (${trading.length - due.length} in sync)`);
        }
      }
      for (const id of watched) {
        const m = states.get(id);
        const tSet = Number(m.settlementTimestamp);
        // submit settlement during the open window
        if (now >= tSet && now < tSet + submitW) {
          try { await withTimeout((async () => (await wrap(SUBMIT).submitSettlementSample(id, { gasLimit: 3_000_000 })).wait())(), "submit"); console.log(`[${loop}] submitted settlement mkt ${id}`); } catch (e: any) { console.log(`[${loop}] submit mkt ${id} skip: ${(e.message||"").slice(0,50)}`); }
        }
        // submit window missed (no candidate) -> primary settlement is impossible; say so loudly once per loop
        if (now >= tSet + submitW && !m.settled && Number(m.settlementValue ?? 0) === 0) {
          console.log(`[${loop}] WARN mkt ${id}: submit window missed (closed ${now - tSet - submitW}s ago) -> needs markSettlementFailed + finalizeSecondarySettlement`);
        }
        // finalize after submit+ops window
        if (now >= tSet + submitW + opsW && !m.settled) {
          try { await (await core.finalizePrimarySettlement(id, { gasLimit: 3_000_000 })).wait(); console.log(`[${loop}] finalized mkt ${id}`); } catch (e: any) { console.log(`[${loop}] finalize mkt ${id} skip: ${(e.message||"").slice(0,50)}`); }
        }
      }
      // process ended batches (advance pointer; realizes settled P&L into NAV)
      for (let k = 0; !skipBatches && k < 50; k++) {
        const cur = Number(await core.getCurrentBatchId());
        const next = cur + 1;
        const nextEnd = (next + 1) * period + OFFSET; // batch `next` ends at start of next+1
        if (nextEnd > now) break; // batch `next` not ended yet
        try {
          const navBefore = ethers.formatUnits(await core.getVaultNav(), 18);
          await (await core.processDailyBatch(next, { gasLimit: 8_000_000 })).wait();
          const navAfter = ethers.formatUnits(await core.getVaultNav(), 18);
          if (navBefore !== navAfter) console.log(`[${loop}] processed batch ${next}: NAV ${navBefore} -> ${navAfter}`);
        } catch (e: any) { console.log(`[${loop}] processBatch ${next} skip: ${(e.message||"").slice(0,60)}`); break; }
      }
    } catch (e: any) { console.error(`[${loop}] loop error: ${(e.message||"").slice(0,80)}`); }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
