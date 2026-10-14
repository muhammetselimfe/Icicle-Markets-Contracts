import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const id = 50;
  const m = await core.markets(BigInt(id));
  const now = Math.floor(Date.now() / 1000);
  const settleTs = Number(m.settlementTimestamp);
  console.log(`#${id}: settled=${m.settled}, settlementTs=${new Date(settleTs*1000).toISOString()}`);
  console.log(`Oracle window ends: ${new Date((settleTs+600)*1000).toISOString()}, now: ${new Date(now*1000).toISOString()}`);

  if (now < settleTs + 600) {
    const wait = settleTs + 600 - now;
    console.log(`Waiting ${wait}s for oracle window to expire...`);
    await new Promise(r => setTimeout(r, wait * 1000 + 2000));
  }

  // Fetch live AVAX price
  const res = await fetch("https://api.redstone.finance/prices?symbol=AVAX&provider=redstone&limit=1");
  const data = await res.json() as any[];
  const livePrice = data[0]?.value;
  const tick = Math.round(livePrice * 100);
  const settlementValue = BigInt(tick) * 1_000_000n;
  console.log(`\nLive AVAX: $${livePrice.toFixed(4)} → tick ${tick}`);

  await (await core.markSettlementFailed(BigInt(id))).wait();
  console.log("markSettlementFailed OK");

  await (await core.finalizeSecondarySettlement(BigInt(id), settlementValue)).wait();
  console.log("finalizeSecondarySettlement OK");

  await (await core.requestSettlementChunks(BigInt(id), 25)).wait();
  console.log("requestSettlementChunks OK");

  const settled = await core.markets(BigInt(id));
  console.log(`\nsettled=${settled.settled}, settleTick=${Number(settled.settlementTick)}`);

  // Per-market P&L
  const lifecycleArtifact = await hre.artifacts.readArtifact("MarketLifecycleModule");
  const lifecycleIface = new ethers.Interface(lifecycleArtifact.abi);
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
        console.log(`\nCLMSR P&L: ${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}`);
        console.log(`Fees: $${ftot.toFixed(2)}`);
        console.log(`Net vault: ${(lt+ftot) >= 0 ? "+" : ""}$${(lt+ftot).toFixed(2)}`);
      }
    } catch {}
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
