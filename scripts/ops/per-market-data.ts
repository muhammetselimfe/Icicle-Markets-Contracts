import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const lifecycleArtifact = await hre.artifacts.readArtifact("MarketLifecycleModule");
  const lifecycleIface = new ethers.Interface(lifecycleArtifact.abi);
  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  const latestBlock = await ethers.provider.getBlockNumber();
  // Scan last ~50K blocks (~2 days on Fuji at ~2s/block)
  const fromBlock = Math.max(0, latestBlock - 50000);

  console.log(`Scanning blocks ${fromBlock}–${latestBlock}...\n`);

  const pnlByMarket: Record<number, { lt: number; ftot: number }> = {};
  const volumeByMarket: Record<number, { count: number; totalCost: bigint }> = {};
  const feesByMarket: Record<number, bigint> = {};

  // Fetch in chunks of 2000
  for (let start = fromBlock; start <= latestBlock; start += 2000) {
    const end = Math.min(start + 1999, latestBlock);
    const logs = await ethers.provider.getLogs({
      address: env.contracts.IcicleOptionsCoreProxy,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      try {
        const parsed = lifecycleIface.parseLog(log);
        if (parsed?.name === "MarketPnlRecorded") {
          const mktId = Number(parsed.args.marketId);
          const lt = Number(parsed.args.lt) / 1e18;
          const ftot = Number(parsed.args.ftot) / 1e18;
          pnlByMarket[mktId] = { lt, ftot };
        }
        continue;
      } catch {}

      try {
        const parsed = tradeIface.parseLog(log);
        if (parsed?.name === "PositionOpened") {
          const mktId = Number(parsed.args.marketId);
          const cost = parsed.args.cost as bigint;
          if (!volumeByMarket[mktId]) volumeByMarket[mktId] = { count: 0, totalCost: 0n };
          volumeByMarket[mktId].count++;
          volumeByMarket[mktId].totalCost += cost;
        }
        if (parsed?.name === "TradeFeeCharged") {
          const mktId = Number(parsed.args.marketId);
          const fee = parsed.args.feeAmount as bigint;
          feesByMarket[mktId] = (feesByMarket[mktId] ?? 0n) + fee;
        }
      } catch {}
    }
  }

  for (const id of [38, 39, 40, 41]) {
    const m = await core.markets(BigInt(id));
    const alpha = Number(m.liquidityParameter) / 1e18;
    const settleTick = Number(m.settlementTick);
    const spacing = Number(m.tickSpacing);
    const centerTick = Number(m.minTick) + Math.floor(Number(m.numBins) / 2) * spacing;
    const distBins = Math.abs(settleTick - centerTick) / spacing;
    const accFees = Number(m.accumulatedFees) / 1e18;
    const deltaEt = Number(m.deltaEt) / 1e18;
    const initialRoot = Number(m.initialRootSum) / 1e18;
    const maxLoss = alpha * Math.log(Number(m.numBins));

    const vol = volumeByMarket[id];
    const pnl = pnlByMarket[id];

    console.log(`${"=".repeat(60)}`);
    console.log(`Market #${id} — α=${alpha}, settled $${(settleTick/100).toFixed(2)} (${distBins} bins from center)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Positions opened: ${vol ? vol.count : "?"}`);
    console.log(`  Volume (premiums paid): ${vol ? "$" + (Number(vol.totalCost) / 1e6).toFixed(2) : "?"}`);
    console.log(`  Fees from events: ${feesByMarket[id] ? "$" + (Number(feesByMarket[id]) / 1e6).toFixed(2) : "none found"}`);
    console.log(`  Accumulated fees (struct): $${accFees.toFixed(2)}`);
    console.log(`  Max vault loss: $${maxLoss.toFixed(0)}`);
    console.log(`  deltaEt: ${deltaEt.toFixed(6)}`);
    console.log(`  initialRootSum: ${initialRoot.toFixed(2)}`);
    if (pnl) {
      console.log(`  --- Per-Market P&L (from MarketPnlRecorded event) ---`);
      console.log(`  CLMSR P&L (Lt): ${pnl.lt >= 0 ? "+" : ""}$${pnl.lt.toFixed(2)}`);
      console.log(`  Gross fees (Ftot): $${pnl.ftot.toFixed(2)}`);
      const net = pnl.lt + pnl.ftot;
      console.log(`  Net vault: ${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
      if (pnl.lt < 0) {
        const psiFee = pnl.ftot / Math.abs(pnl.lt);
        console.log(`  ψ_fee: ${psiFee.toFixed(4)}`);
      } else {
        console.log(`  ψ_fee: ∞ (vault profited from CLMSR)`);
      }
    } else {
      console.log(`  MarketPnlRecorded: NOT FOUND in scanned range`);
    }
    console.log("");
  }
}
main();
