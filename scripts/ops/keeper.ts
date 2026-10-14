// Keeper: keeps the v2 Fuji deployment running automatically.
//   - refreshes the trade oracle for active markets (so trades price against a fresh price)
//   - submits + finalizes settlement when a market's window opens/closes (primary, real Redstone)
//   - processes daily batches as they end (advances the pointer; realizes LP P&L into NAV)
//
// Run (background): npx hardhat run scripts/ops/keeper.ts --network fuji
//   INTERVAL_SEC=30  (loop cadence)   MAX_LOOPS=0 (0 = forever)   SKIP_BATCHES=1 (do not process ended batches)
import hre from "hardhat";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { getSignersForDataServiceId } from "@redstone-finance/sdk";
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
  const interval = Number(process.env.INTERVAL_SEC ?? "30");
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

  const period = Number(await core.batchSeconds()) || 86400;
  const submitW = Number(await core.settlementSubmitWindow());
  const opsW = Number(await core.pendingOpsWindow());
  console.log(`keeper: core=${coreAddr} feed=${feed} period=${period}s submit=${submitW} ops=${opsW}`);

  for (let loop = 0; maxLoops === 0 || loop < maxLoops; loop++) {
    try {
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const n = Number(await core.nextMarketId());
      for (let id = 1; id <= n; id++) {
        const m = await core.markets(id);
        if (!m.dynamicEnabled || m.settled || m.failed) continue;
        const tSet = Number(m.settlementTimestamp), start = Number(m.startTimestamp);
        if (now >= start && now < tSet) {
          try { await withTimeout((async () => (await wrap(REFRESH).refreshTradeOracle(id)).wait())(), "refresh"); console.log(`[${loop}] refreshed oracle mkt ${id}`); } catch (e: any) { console.log(`[${loop}] refresh mkt ${id} skip: ${(e.message||"").slice(0,50)}`); }
        }
        // submit settlement during the open window
        if (now >= tSet && now < tSet + submitW) {
          try { await withTimeout((async () => (await wrap(SUBMIT).submitSettlementSample(id)).wait())(), "submit"); console.log(`[${loop}] submitted settlement mkt ${id}`); } catch (e: any) { console.log(`[${loop}] submit mkt ${id} skip: ${(e.message||"").slice(0,50)}`); }
        }
        // submit window missed (no candidate) -> primary settlement is impossible; say so loudly once per loop
        if (now >= tSet + submitW && !m.settled && Number(m.settlementValue ?? 0) === 0) {
          console.log(`[${loop}] WARN mkt ${id}: submit window missed (closed ${now - tSet - submitW}s ago) -> needs markSettlementFailed + finalizeSecondarySettlement`);
        }
        // finalize after submit+ops window
        if (now >= tSet + submitW + opsW && !m.settled) {
          try { await (await core.finalizePrimarySettlement(id)).wait(); console.log(`[${loop}] finalized mkt ${id}`); } catch (e: any) { console.log(`[${loop}] finalize mkt ${id} skip: ${(e.message||"").slice(0,50)}`); }
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
          await (await core.processDailyBatch(next)).wait();
          const navAfter = ethers.formatUnits(await core.getVaultNav(), 18);
          if (navBefore !== navAfter) console.log(`[${loop}] processed batch ${next}: NAV ${navBefore} -> ${navAfter}`);
        } catch (e: any) { console.log(`[${loop}] processBatch ${next} skip: ${(e.message||"").slice(0,60)}`); break; }
      }
    } catch (e: any) { console.error(`[${loop}] loop error: ${(e.message||"").slice(0,80)}`); }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
