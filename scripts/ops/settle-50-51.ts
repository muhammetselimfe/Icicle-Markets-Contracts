/**
 * Settle markets #50 and #51.
 * #50: α=1000, created earlier, should be settleable now.
 * #51: α=1000, 15-min bell test, settlement pushed to batch 20531 (08:01 UTC).
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Fetch live AVAX price
  const res = await fetch("https://api.redstone.finance/prices?symbol=AVAX&provider=redstone&limit=1");
  const data = await res.json() as any[];
  const livePrice = data[0]?.value;
  console.log(`Live AVAX: $${livePrice?.toFixed(4)}\n`);

  const lifecycleArtifact = await hre.artifacts.readArtifact("MarketLifecycleModule");
  const lifecycleIface = new ethers.Interface(lifecycleArtifact.abi);

  for (const id of [50, 51]) {
    const m = await core.markets(BigInt(id));
    if (m.settled) { console.log(`#${id}: Already settled\n`); continue; }

    const now = Math.floor(Date.now() / 1000);
    const end = Number(m.endTimestamp);
    const settleTs = Number(m.settlementTimestamp);
    const oracleWindowEnd = settleTs + 600;

    console.log(`#${id}: end=${new Date(end*1000).toISOString()}, settlement=${new Date(settleTs*1000).toISOString()}`);
    console.log(`  Now: ${now}, oracle window ends: ${oracleWindowEnd}`);

    if (now < end) {
      console.log(`  Trading still active (${end - now}s remaining). Skip.\n`);
      continue;
    }

    if (now < oracleWindowEnd) {
      const wait = oracleWindowEnd - now;
      console.log(`  Oracle window still open. Waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000 + 2000));
    }

    // Settle at live price
    const tick = Math.round(livePrice * 100); // AVAX cents
    const settlementValue = BigInt(tick) * 1_000_000n;
    console.log(`  Settling at tick ${tick} ($${(tick/100).toFixed(2)})...`);

    try {
      await (await core.markSettlementFailed(BigInt(id))).wait();
      console.log("  markSettlementFailed OK");
    } catch (e: any) {
      console.log(`  markSettlementFailed: ${e.message?.slice(0, 80)}`);
    }

    try {
      await (await core.finalizeSecondarySettlement(BigInt(id), settlementValue)).wait();
      console.log("  finalizeSecondarySettlement OK");
    } catch (e: any) {
      console.log(`  finalizeSecondarySettlement: ${e.message?.slice(0, 80)}`);
    }

    try {
      await (await core.requestSettlementChunks(BigInt(id), 25)).wait();
      console.log("  requestSettlementChunks OK");
    } catch (e: any) {
      console.log(`  requestSettlementChunks: ${e.message?.slice(0, 80)}`);
    }

    const settled = await core.markets(BigInt(id));
    console.log(`  settled=${settled.settled}, settleTick=${Number(settled.settlementTick)}`);

    // Read per-market P&L
    if (settled.settled) {
      const latestBlock = await ethers.provider.getBlockNumber();
      const logs = await ethers.provider.getLogs({
        address: env.contracts.IcicleOptionsCoreProxy,
        fromBlock: latestBlock - 50, toBlock: latestBlock,
      });
      for (const log of logs) {
        try {
          const parsed = lifecycleIface.parseLog(log);
          if (parsed?.name === "MarketPnlRecorded" && Number(parsed.args.marketId) === id) {
            const lt = Number(parsed.args.lt) / 1e18;
            const ftot = Number(parsed.args.ftot) / 1e18;
            console.log(`  CLMSR P&L: ${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}, Fees: $${ftot.toFixed(2)}, Net: ${(lt+ftot) >= 0 ? "+" : ""}$${(lt+ftot).toFixed(2)}`);
          }
        } catch {}
      }
    }
    console.log();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
