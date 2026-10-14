/**
 * Keeper: refresh the cached trade oracle for a v2 DYNAMIC market on a cadence,
 * so trades price against a fresh oracle (re-center + volatility-adaptive sigma).
 *
 * Usage:
 *   MARKET_ID=57 ONCE=1 npx hardhat run scripts/ops/refresh-trade-oracle.ts --network fuji
 *   MARKET_ID=57 INTERVAL_SEC=60 ONCE=0 npx hardhat run scripts/ops/refresh-trade-oracle.ts --network fuji
 *
 * Uses real Redstone (redstone-primary-prod) signed data via ethers v5 + WrapperBuilder
 * (the evm-connector wrapper targets ethers v5), mirroring settle-market-dev.ts.
 */
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { getSignersForDataServiceId } from "@redstone-finance/sdk";
import { Contract as V5Contract } from "@ethersproject/contracts";
import { JsonRpcProvider as V5JsonRpcProvider } from "@ethersproject/providers";
import { Wallet as V5Wallet } from "@ethersproject/wallet";
import { loadEnvironment } from "../utils/environment";

const DATA_SERVICE_ID = "redstone-primary-prod" as const;
const UNIQUE_SIGNERS = 3;

async function main() {
  const env = loadEnvironment("fuji");
  const coreAddress = env.contracts.IcicleOptionsCoreProxy;
  const feedId: string = (env.config as any).redstoneFeedId ?? "AVAX";
  const marketId = process.env.MARKET_ID;
  if (!marketId) throw new Error("set MARKET_ID");
  const interval = Number(process.env.INTERVAL_SEC ?? "60");
  const once = process.env.ONCE !== "0";

  const rpcUrl = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
  const key = process.env.DEPLOYER_KEY;
  if (!key) throw new Error("Missing DEPLOYER_KEY");

  const provider = new V5JsonRpcProvider(rpcUrl);
  const signer = new V5Wallet(key, provider);
  const coreV5 = new V5Contract(coreAddress, ["function refreshTradeOracle(uint256)"], signer);
  const authorizedSigners = (getSignersForDataServiceId as any)(DATA_SERVICE_ID);

  async function refreshOnce() {
    const wrapped = WrapperBuilder.wrap(coreV5).usingDataService({
      dataServiceId: DATA_SERVICE_ID,
      dataPackagesIds: [feedId],
      uniqueSignersCount: UNIQUE_SIGNERS,
      authorizedSigners,
    });
    const tx = await (wrapped as any).refreshTradeOracle(marketId);
    const rcpt = await tx.wait();
    console.log(`[refresh] marketId=${marketId} feed=${feedId} tx=${rcpt?.transactionHash}`);
  }

  if (once) { await refreshOnce(); return; }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await refreshOnce(); } catch (e) { console.error("[refresh] error:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
