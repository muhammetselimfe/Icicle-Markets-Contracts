/**
 * Analyze winners vs losers per market by checking PositionOpened events
 * against settlement tick.
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const tradeArtifact = await hre.artifacts.readArtifact("TradeModule");
  const tradeIface = new ethers.Interface(tradeArtifact.abi);

  const MARKETS = [
    { id: 45n, name: "AVAX", tickDiv: 100 },
    { id: 48n, name: "WTI", tickDiv: 1 },
    { id: 49n, name: "XAU", tickDiv: 1 },
  ];

  const latestBlock = await ethers.provider.getBlockNumber();
  // Markets may have been created days ago, scan wider range
  const fromBlock = Math.max(0, latestBlock - 500000);
  const CHUNK = 2000;

  // Collect all PositionOpened logs
  const positionOpenedTopic = tradeIface.getEvent("PositionOpened")!.topicHash;
  const allLogs: any[] = [];

  for (let start = fromBlock; start <= latestBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latestBlock);
    try {
      const logs = await ethers.provider.getLogs({
        address: env.contracts.IcicleOptionsCoreProxy,
        topics: [positionOpenedTopic],
        fromBlock: start,
        toBlock: end,
      });
      allLogs.push(...logs);
    } catch {}
  }

  console.log(`Found ${allLogs.length} PositionOpened events\n`);

  for (const mkt of MARKETS) {
    const m = await core.markets(mkt.id);
    if (!m.settled) { console.log(`${mkt.name} #${mkt.id}: Not settled yet\n`); continue; }

    const settleTick = Number(m.settlementTick);
    const minTick = Number(m.minTick);
    const maxTick = Number(m.maxTick);
    const spacing = Number(m.tickSpacing);

    // Filter logs for this market
    const marketIdTopic = ethers.zeroPadValue(ethers.toBeHex(mkt.id), 32);
    const marketLogs = allLogs.filter(l => l.topics[3] === marketIdTopic);

    let winners = 0, losers = 0;
    let winnerCost = 0n, loserCost = 0n;
    let winnerQty = 0n, loserQty = 0n;
    const winDetails: string[] = [];
    const loseDetails: string[] = [];

    for (const log of marketLogs) {
      const parsed = tradeIface.parseLog(log);
      if (!parsed) continue;

      const lower = Number(parsed.args.lowerTick);
      const upper = Number(parsed.args.upperTick);
      const qty = parsed.args.quantity as bigint;
      const cost = parsed.args.cost as bigint;

      // Position wins if settleTick >= lower AND settleTick < upper
      const isWin = settleTick >= lower && settleTick < upper;
      const costUsd = (Number(cost) / 1e6).toFixed(2);
      const numBins = (upper - lower) / spacing;

      if (isWin) {
        winners++;
        winnerCost += cost;
        winnerQty += qty;
        winDetails.push(`  [${lower}–${upper}] ${numBins} bins, cost $${costUsd}`);
      } else {
        losers++;
        loserCost += cost;
        loserQty += qty;
        loseDetails.push(`  [${lower}–${upper}] ${numBins} bins, cost $${costUsd}`);
      }
    }

    // Price display
    const priceStr = mkt.tickDiv === 100
      ? `$${(settleTick / 100).toFixed(2)}`
      : `$${settleTick}`;

    console.log("=".repeat(60));
    console.log(`${mkt.name} — Market #${mkt.id}`);
    console.log(`Settlement: tick ${settleTick} (${priceStr})`);
    console.log(`Range: ${minTick}–${maxTick}, spacing=${spacing}`);
    console.log("=".repeat(60));
    console.log(`  Total positions: ${winners + losers}`);
    console.log(`  Winners: ${winners} ($${(Number(winnerCost)/1e6).toFixed(2)} spent)`);
    console.log(`  Losers:  ${losers} ($${(Number(loserCost)/1e6).toFixed(2)} spent)`);
    console.log(`  Win rate: ${((winners / (winners + losers)) * 100).toFixed(1)}%`);
    console.log();

    if (winDetails.length > 0) {
      console.log(`  Winning positions:`);
      winDetails.forEach(d => console.log(d));
    }
    console.log();
    if (loseDetails.length > 0 && loseDetails.length <= 20) {
      console.log(`  Losing positions:`);
      loseDetails.forEach(d => console.log(d));
    } else if (loseDetails.length > 20) {
      console.log(`  Losing positions: (showing first 10 of ${loseDetails.length})`);
      loseDetails.slice(0, 10).forEach(d => console.log(d));
      console.log(`  ... and ${loseDetails.length - 10} more`);
    }
    console.log();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
