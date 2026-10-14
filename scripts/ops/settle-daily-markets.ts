/**
 * Settle markets #45 (AVAX), #48 (WTI), #49 (XAU) using live Redstone prices.
 * Also settle broken markets #46, #47 at any price to clean them up.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Check status of all markets
  for (const id of [45, 46, 47, 48, 49]) {
    const m = await core.markets(BigInt(id));
    const now = Math.floor(Date.now() / 1000);
    const end = Number(m.endTimestamp);
    const elapsed = now - end;
    console.log(`#${id}: settled=${m.settled}, ended ${elapsed}s ago (${elapsed > 600 ? "oracle window expired" : elapsed > 0 ? `${600-elapsed}s until window expires` : "not expired yet"})`);
  }

  // Fetch live prices
  console.log("\nFetching live prices...");
  const prices: Record<string, number> = {};
  for (const feed of ["AVAX", "WTI", "XAU"]) {
    try {
      const res = await fetch(`https://api.redstone.finance/prices?symbol=${feed}&provider=redstone&limit=1`);
      const data = await res.json() as any[];
      prices[feed] = data[0]?.value;
      console.log(`  ${feed}: $${prices[feed]?.toFixed(4)}`);
    } catch { console.log(`  ${feed}: failed`); }
  }

  // Settlement configs
  const settlements = [
    { id: 45, tick: Math.round(prices.AVAX * 100), label: `AVAX $${prices.AVAX?.toFixed(2)}` },  // cent ticks
    { id: 46, tick: 9800, label: "WTI (broken, cleanup)" },  // broken market, just settle
    { id: 47, tick: 501000, label: "XAU (broken, cleanup)" },  // broken market
    { id: 48, tick: Math.round(prices.WTI), label: `WTI $${prices.WTI?.toFixed(2)}` },  // dollar ticks
    { id: 49, tick: Math.round(prices.XAU / 5) * 5, label: `XAU $${prices.XAU?.toFixed(2)}` },  // dollar ticks, round to spacing=5
  ];

  const lifecycleArtifact = await hre.artifacts.readArtifact("MarketLifecycleModule");
  const lifecycleIface = new ethers.Interface(lifecycleArtifact.abi);

  for (const s of settlements) {
    const m = await core.markets(BigInt(s.id));
    if (m.settled) { console.log(`\n#${s.id}: Already settled, skip`); continue; }

    const now = Math.floor(Date.now() / 1000);
    const end = Number(m.endTimestamp);
    if (now < end) { console.log(`\n#${s.id}: Not expired yet (${end - now}s remaining), skip`); continue; }
    if (now < end + 600) { console.log(`\n#${s.id}: Oracle window still open (${end + 600 - now}s remaining), skip`); continue; }

    const settlementValue = BigInt(s.tick) * 1_000_000n;
    console.log(`\nSettling #${s.id} → tick ${s.tick} [${s.label}]`);

    try {
      await (await core.markSettlementFailed(BigInt(s.id))).wait();
      console.log("  markSettlementFailed OK");
    } catch (e: any) {
      console.log(`  markSettlementFailed: ${e.message?.slice(0, 80)}`);
    }

    try {
      await (await core.finalizeSecondarySettlement(BigInt(s.id), settlementValue)).wait();
      console.log("  finalizeSecondarySettlement OK");
    } catch (e: any) {
      console.log(`  finalizeSecondarySettlement: ${e.message?.slice(0, 80)}`);
    }

    try {
      await (await core.requestSettlementChunks(BigInt(s.id), 25)).wait();
      console.log("  requestSettlementChunks OK");
    } catch (e: any) {
      console.log(`  requestSettlementChunks: ${e.message?.slice(0, 80)}`);
    }

    const settled = await core.markets(BigInt(s.id));
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
          if (parsed?.name === "MarketPnlRecorded" && Number(parsed.args.marketId) === s.id) {
            const lt = Number(parsed.args.lt) / 1e18;
            const ftot = Number(parsed.args.ftot) / 1e18;
            console.log(`  CLMSR P&L: ${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}, Fees: $${ftot.toFixed(2)}, Net: ${(lt+ftot) >= 0 ? "+" : ""}$${(lt+ftot).toFixed(2)}`);
          }
        } catch {}
      }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("All done!");
}
main().catch((err) => { console.error(err); process.exit(1); });
