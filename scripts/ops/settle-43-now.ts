import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const m = await core.markets(43n);
  const now = Math.floor(Date.now() / 1000);
  const end = Number(m.endTimestamp);
  console.log(`#43: settled=${m.settled}, ended ${now - end}s ago`);

  if (m.settled) { console.log("Already settled!"); return; }
  if (now < end + 600) { console.log(`Oracle window still open — ${end + 600 - now}s remaining`); return; }

  // Settle at $10.35 (tick 1035) — live price when market was created
  const settleTick = 1035;
  console.log(`Settling at tick ${settleTick} ($${(settleTick/100).toFixed(2)})...`);

  await (await core.markSettlementFailed(43n)).wait();
  console.log("markSettlementFailed OK");

  await (await core.finalizeSecondarySettlement(43n, BigInt(settleTick) * 1_000_000n)).wait();
  console.log("finalizeSecondarySettlement OK");

  await (await core.requestSettlementChunks(43n, 25)).wait();
  console.log("requestSettlementChunks OK");

  const s = await core.markets(43n);
  console.log(`settled=${s.settled}, settleTick=${Number(s.settlementTick)}`);

  // Read P&L
  const latestBlock = await ethers.provider.getBlockNumber();
  const artifact = await hre.artifacts.readArtifact("MarketLifecycleModule");
  const iface = new ethers.Interface(artifact.abi);
  const logs = await ethers.provider.getLogs({
    address: env.contracts.IcicleOptionsCoreProxy,
    fromBlock: latestBlock - 100, toBlock: latestBlock,
  });
  for (const log of logs) {
    try {
      const p = iface.parseLog(log);
      if (p?.name === "MarketPnlRecorded" && Number(p.args.marketId) === 43) {
        const lt = Number(p.args.lt) / 1e18;
        const ftot = Number(p.args.ftot) / 1e18;
        console.log(`\n=== Market #43 (σ=8, positions on $9.55, settled $10.35) ===`);
        console.log(`CLMSR P&L: ${lt >= 0 ? "+" : ""}$${lt.toFixed(2)}`);
        console.log(`Fees: $${ftot.toFixed(2)}`);
        console.log(`Net vault: ${(lt+ftot) >= 0 ? "+" : ""}$${(lt+ftot).toFixed(2)}`);
      }
    } catch {}
  }
}
main();
