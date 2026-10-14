/**
 * Analyze trader P&L for all 3 market sets on Fuji testnet:
 *   Set 1: #16-18 (uniform prior, alpha 100/10000)
 *   Set 2: #20-22 (bell curve, alpha 100)
 *   Set 3: #23-25 (bell curve, alpha 1000)
 * + Vault / Backstop / Treasury state + Grand comparison
 * Usage: npx hardhat run scripts/ops/analyze-pnl.ts --network fuji
 */
import { ethers } from "hardhat";
import * as fs from "fs";

const CORE_ABI = [
  "function markets(uint256) view returns (bool isSeeded, bool settled, bool snapshotChunksDone, bool failed, uint32 numBins, uint32 openPositionCount, uint32 snapshotChunkCursor, uint32 seedCursor, uint64 startTimestamp, uint64 endTimestamp, uint64 settlementTimestamp, uint64 settlementFinalizedAt, int256 minTick, int256 maxTick, int256 tickSpacing, int256 settlementTick, int256 settlementValue, uint256 liquidityParameter, address feePolicy, address seedData, uint256 initialRootSum, uint256 accumulatedFees, uint256 minFactor, uint256 deltaEt)",
  "function getVaultNav() view returns (uint256)",
  "function getVaultShares() view returns (uint256)",
  "function getVaultPrice() view returns (uint256)",
  "function getVaultPricePeak() view returns (uint256)",
  "function isVaultSeeded() view returns (bool)",
  "function getCapitalStack() view returns (uint256 backstopNav, uint256 treasuryNav)",
  "function getCurrentBatchId() view returns (uint64)",
  "function getBatchMarketState(uint64 batchId) view returns (uint64 total, uint64 resolved)",
  "function paymentToken() view returns (address)",
  "function nextMarketId() view returns (uint256)",
  "event PositionOpened(uint256 indexed positionId, address indexed trader, uint256 indexed marketId, int256 lowerTick, int256 upperTick, uint128 quantity, uint256 cost)",
  "event PositionIncreased(uint256 indexed positionId, address indexed trader, uint128 deltaQuantity, uint128 newQuantity, uint256 cost)",
  "event PositionDecreased(uint256 indexed positionId, address indexed trader, uint128 deltaQuantity, uint128 newQuantity, uint256 proceeds)",
  "event PositionClosed(uint256 indexed positionId, address indexed trader, uint256 proceeds)",
  "event TradeFeeCharged(address indexed trader, uint256 indexed marketId, uint256 indexed positionId, bool isBuy, uint256 baseAmount, uint256 feeAmount, address policy)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

const POSITION_ABI = [
  "function getMarketPositions(uint256 marketId) view returns (uint256[])",
  "function getPosition(uint256 positionId) view returns (tuple(uint256 marketId, int256 lowerTick, int256 upperTick, uint128 quantity, uint64 createdAt))",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

function fmt(val: bigint, label?: string): string {
  const sign = val < 0n ? "-" : "";
  const abs = val < 0n ? -val : val;
  const dollars = abs / 1_000_000n;
  const cents = abs % 1_000_000n;
  const centsStr = cents.toString().padStart(6, "0").slice(0, 2);
  const result = `${sign}$${dollars.toString()}.${centsStr}`;
  return label ? `${label}: ${result}` : result;
}

async function paginatedQuery(contract: any, filter: any, fromBlock: number, toBlock: number, chunkSize = 2000): Promise<any[]> {
  const allEvents: any[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const events = await contract.queryFilter(filter, start, end);
      allEvents.push(...events);
    } catch (e: any) {
      // If still too large, halve the chunk
      if (chunkSize > 100) {
        const mid = Math.floor((start + end) / 2);
        const first = await paginatedQuery(contract, filter, start, mid, Math.floor(chunkSize / 2));
        const second = await paginatedQuery(contract, filter, mid + 1, end, Math.floor(chunkSize / 2));
        allEvents.push(...first, ...second);
      } else {
        console.error(`  Failed to query blocks ${start}-${end}: ${e.message}`);
      }
    }
    start = end + 1;
  }
  return allEvents;
}

async function main() {
  const env = JSON.parse(fs.readFileSync("scripts/environments/fuji.json", "utf-8"));
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const posAddr = env.contracts.IcicleOptionsPositionProxy;

  const [signer] = await ethers.getSigners();
  console.log("Deployer/signer:", signer.address);

  const core = new ethers.Contract(coreAddr, CORE_ABI, signer);
  const position = new ethers.Contract(posAddr, POSITION_ABI, signer);

  const currentBlock = await ethers.provider.getBlockNumber();
  // Search last 200000 blocks (~4.5 days on Fuji ~2s blocks) to cover all market sets
  const searchFromBlock = currentBlock - 200000;
  console.log(`Searching events from block ${searchFromBlock} to ${currentBlock}`);

  // All 4 market sets
  const marketSets = [
    {
      label: "Set 1: Uniform prior, alpha 100/10000",
      markets: [
        { id: 16, asset: "AVAX", tickDivisor: 100 },
        { id: 17, asset: "WTI",  tickDivisor: 1 },
        { id: 18, asset: "XAU",  tickDivisor: 1 },
      ],
    },
    {
      label: "Set 2: Bell curve, alpha 100",
      markets: [
        { id: 20, asset: "AVAX", tickDivisor: 100 },
        { id: 21, asset: "WTI",  tickDivisor: 1 },
        { id: 22, asset: "XAU",  tickDivisor: 1 },
      ],
    },
    {
      label: "Set 3: Bell curve, alpha 1000",
      markets: [
        { id: 23, asset: "AVAX", tickDivisor: 100 },
        { id: 24, asset: "WTI",  tickDivisor: 1 },
        { id: 25, asset: "XAU",  tickDivisor: 1 },
      ],
    },
    {
      label: "Set 4: Bell curve, alpha 1000 (round 4)",
      markets: [
        { id: 26, asset: "AVAX", tickDivisor: 100 },
        { id: 27, asset: "WTI",  tickDivisor: 1 },
        { id: 28, asset: "XAU",  tickDivisor: 1 },
      ],
    },
  ];

  // For this run, analyze Set 4 (markets #26-28)
  const marketConfigs = marketSets[3].markets;

  interface MarketResult {
    id: number;
    asset: string;
    totalPositions: number;
    winners: number;
    losers: number;
    totalBaseCost: bigint;
    totalFees: bigint;
    totalTraderSpend: bigint;
    totalPayouts: bigint;
    traderPnl: bigint;
    vaultPnl: bigint;
  }

  const results: MarketResult[] = [];

  for (const cfg of marketConfigs) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`MARKET #${cfg.id} — ${cfg.asset}`);
    console.log("=".repeat(70));

    // Read market details
    const m = await core.markets(cfg.id);
    const minTick = m.minTick;
    const maxTick = m.maxTick;
    const tickSpacing = m.tickSpacing;
    const numBins = Number(m.numBins);
    const settlementTick = m.settlementTick;
    const settled = m.settled;
    const accumulatedFees = m.accumulatedFees;
    const feePolicy = m.feePolicy;

    const settlementValue = m.settlementValue;
    const failed = m.failed;

    // Convert settlement tick to price
    const settlementPrice = Number(settlementTick) / cfg.tickDivisor;
    const minPrice = Number(minTick) / cfg.tickDivisor;
    const maxPrice = Number(maxTick) / cfg.tickDivisor;
    const spacingPrice = Number(tickSpacing) / cfg.tickDivisor;

    console.log(`  Settled: ${settled} | Failed: ${failed}`);
    console.log(`  Range: $${minPrice.toFixed(2)} to $${maxPrice.toFixed(2)} (spacing=$${spacingPrice.toFixed(2)}, bins=${numBins})`);
    console.log(`  Settlement tick: ${settlementTick} => $${settlementPrice.toFixed(2)}`);
    console.log(`  Settlement value (raw): ${settlementValue}`);
    console.log(`  Fee policy: ${feePolicy}`);
    // accumulatedFees is WAD (18 dec), convert to 6 dec for display
    const accFees6 = accumulatedFees / (10n ** 12n);
    console.log(`  Accumulated fees (on-chain): ${fmt(accFees6)}`);

    // Get all positions in market
    let positionIds: bigint[];
    try {
      positionIds = await position.getMarketPositions(cfg.id);
      console.log(`  Positions on-chain (not yet claimed/burned): ${positionIds.length}`);
    } catch (e) {
      positionIds = [];
      console.log("  getMarketPositions failed");
    }

    // Query PositionOpened events for cost basis (paginated)
    console.log("  Fetching PositionOpened events (paginated)...");
    const openFilter = core.filters.PositionOpened(null, null, cfg.id);
    const openEvents = await paginatedQuery(core, openFilter, searchFromBlock, currentBlock);
    console.log(`  PositionOpened events: ${openEvents.length}`);

    // Fee events
    console.log("  Fetching TradeFeeCharged events...");
    const feeFilter = core.filters.TradeFeeCharged(null, cfg.id);
    const feeEvents = await paginatedQuery(core, feeFilter, searchFromBlock, currentBlock);
    console.log(`  TradeFeeCharged events: ${feeEvents.length}`);

    // Build cost map from open events
    const costMap = new Map<string, bigint>();
    for (const ev of openEvents) {
      const posId = ev.args.positionId.toString();
      costMap.set(posId, (costMap.get(posId) || 0n) + ev.args.cost);
    }

    // Build fee map (buy fees only for cost basis)
    let totalBuyFees6 = 0n;
    for (const ev of feeEvents) {
      if (ev.args.isBuy) {
        totalBuyFees6 += ev.args.feeAmount;
      }
    }

    // For increase/decrease/close events, we need non-indexed filtering by positionId
    // These events don't have marketId indexed, so query all and filter
    const marketPositionSet = new Set<string>();
    for (const ev of openEvents) {
      marketPositionSet.add(ev.args.positionId.toString());
    }
    for (const id of positionIds) {
      marketPositionSet.add(id.toString());
    }

    // Get increase events (positionId is indexed, so we can filter per position)
    // But with ~100 positions, querying per position is expensive. Let's query all and filter.
    console.log("  Fetching PositionIncreased events (all, then filtering)...");
    const increaseFilter = core.filters.PositionIncreased();
    const allIncreaseEvents = await paginatedQuery(core, increaseFilter, searchFromBlock, currentBlock);
    const increaseEvents = allIncreaseEvents.filter(e => marketPositionSet.has(e.args.positionId.toString()));
    console.log(`  PositionIncreased for this market: ${increaseEvents.length}`);

    for (const ev of increaseEvents) {
      const posId = ev.args.positionId.toString();
      costMap.set(posId, (costMap.get(posId) || 0n) + ev.args.cost);
    }

    console.log("  Fetching PositionDecreased events...");
    const decreaseFilter = core.filters.PositionDecreased();
    const allDecreaseEvents = await paginatedQuery(core, decreaseFilter, searchFromBlock, currentBlock);
    const decreaseEvents = allDecreaseEvents.filter(e => marketPositionSet.has(e.args.positionId.toString()));
    console.log(`  PositionDecreased for this market: ${decreaseEvents.length}`);

    for (const ev of decreaseEvents) {
      const posId = ev.args.positionId.toString();
      costMap.set(posId, (costMap.get(posId) || 0n) - ev.args.proceeds);
    }

    console.log("  Fetching PositionClosed events...");
    const closeFilter = core.filters.PositionClosed();
    const allCloseEvents = await paginatedQuery(core, closeFilter, searchFromBlock, currentBlock);
    const closeEvents = allCloseEvents.filter(e => marketPositionSet.has(e.args.positionId.toString()));
    console.log(`  PositionClosed for this market: ${closeEvents.length}`);

    for (const ev of closeEvents) {
      const posId = ev.args.positionId.toString();
      costMap.set(posId, (costMap.get(posId) || 0n) - ev.args.proceeds);
    }

    // Build trader map from open events (positionId -> trader address)
    const traderMap = new Map<string, string>();
    for (const ev of openEvents) {
      traderMap.set(ev.args.positionId.toString(), ev.args.trader);
    }

    // Analyze positions
    let winners = 0;
    let losers = 0;
    let totalBaseCost = 0n;
    let totalPayouts = 0n;
    let positionsAnalyzed = 0;

    // Per-trader aggregation
    const traderStats = new Map<string, { positions: number; winners: number; cost: bigint; payouts: bigint }>();

    const allPositionIds = new Set<string>(marketPositionSet);

    for (const posIdStr of allPositionIds) {
      let lowerTick: bigint;
      let upperTick: bigint;
      let quantity: bigint;

      // Try contract first (positions not yet claimed)
      try {
        const pos = await position.getPosition(BigInt(posIdStr));
        lowerTick = pos.lowerTick;
        upperTick = pos.upperTick;
        quantity = pos.quantity;
      } catch {
        // Burned — use event data
        const openEv = openEvents.find((e: any) => e.args.positionId.toString() === posIdStr);
        if (!openEv) continue;
        lowerTick = openEv.args.lowerTick;
        upperTick = openEv.args.upperTick;
        quantity = openEv.args.quantity;
        // Apply increases
        for (const inc of increaseEvents) {
          if (inc.args.positionId.toString() === posIdStr) quantity = inc.args.newQuantity;
        }
        // Apply decreases
        for (const dec of decreaseEvents) {
          if (dec.args.positionId.toString() === posIdStr) quantity = dec.args.newQuantity;
        }
        // If closed, final qty is 0
        for (const cl of closeEvents) {
          if (cl.args.positionId.toString() === posIdStr) quantity = 0n;
        }
      }

      const isWinner = lowerTick <= settlementTick && upperTick > settlementTick;
      const payout = isWinner ? quantity : 0n;
      const costBasis = costMap.get(posIdStr) || 0n;

      if (isWinner) winners++;
      else losers++;

      totalBaseCost += costBasis;
      totalPayouts += payout;
      positionsAnalyzed++;

      // Per-trader tracking
      const trader = traderMap.get(posIdStr) || "unknown";
      const existing = traderStats.get(trader) || { positions: 0, winners: 0, cost: 0n, payouts: 0n };
      existing.positions++;
      if (isWinner) existing.winners++;
      existing.cost += costBasis;
      existing.payouts += payout;
      traderStats.set(trader, existing);
    }

    const totalTraderSpend = totalBaseCost + totalBuyFees6;
    const traderPnl = totalPayouts - totalTraderSpend;
    const vaultPnl = totalTraderSpend - totalPayouts;

    console.log(`\n  --- RESULTS ---`);
    console.log(`  Positions: ${positionsAnalyzed} (${winners} winners, ${losers} losers)`);
    console.log(`  ${fmt(totalBaseCost, "Total base cost (CLMSR cost)")}`);
    console.log(`  ${fmt(totalBuyFees6, "Total fees paid by traders")}`);
    console.log(`  ${fmt(totalTraderSpend, "Total trader spend (cost + fees)")}`);
    console.log(`  ${fmt(totalPayouts, "Total payouts (winning positions)")}`);
    console.log(`  ${fmt(traderPnl, "NET TRADER P&L")}`);
    console.log(`  ${fmt(vaultPnl, "NET VAULT P&L")}`);
    console.log(`  ${fmt(accFees6, "Fee revenue (on-chain accumulatedFees)")}`);

    // Per-trader breakdown
    if (traderStats.size > 0) {
      console.log(`\n  --- PER-TRADER BREAKDOWN ---`);
      const deployerAddr = signer.address.toLowerCase();
      for (const [addr, stats] of traderStats) {
        const label = addr.toLowerCase() === deployerAddr ? " (deployer)" : " (user)";
        const pnl = stats.payouts - stats.cost;
        console.log(`  ${addr.slice(0, 6)}...${addr.slice(-4)}${label}: ${stats.positions} pos (${stats.winners} wins), cost=${fmt(stats.cost)}, payout=${fmt(stats.payouts)}, P&L=${fmt(pnl)}`);
      }
    }

    results.push({
      id: cfg.id,
      asset: cfg.asset,
      totalPositions: positionsAnalyzed,
      winners,
      losers,
      totalBaseCost,
      totalFees: totalBuyFees6,
      totalTraderSpend,
      totalPayouts,
      traderPnl,
      vaultPnl,
    });
  }

  // Grand totals for Set 3
  console.log(`\n${"=".repeat(70)}`);
  console.log("GRAND TOTALS — SET 4 (Bell curve, alpha 1000, round 4)");
  console.log("=".repeat(70));

  let gPos = 0, gWin = 0, gLose = 0;
  let gBaseCost = 0n, gFees = 0n, gSpend = 0n, gPayouts = 0n, gTraderPnl = 0n, gVaultPnl = 0n;

  for (const r of results) {
    gPos += r.totalPositions;
    gWin += r.winners;
    gLose += r.losers;
    gBaseCost += r.totalBaseCost;
    gFees += r.totalFees;
    gSpend += r.totalTraderSpend;
    gPayouts += r.totalPayouts;
    gTraderPnl += r.traderPnl;
    gVaultPnl += r.vaultPnl;
  }

  console.log(`  Total positions: ${gPos} (${gWin} winners, ${gLose} losers)`);
  console.log(`  ${fmt(gBaseCost, "Total base cost")}`);
  console.log(`  ${fmt(gFees, "Total fees")}`);
  console.log(`  ${fmt(gSpend, "Total trader spend")}`);
  console.log(`  ${fmt(gPayouts, "Total payouts")}`);
  console.log(`  ${fmt(gTraderPnl, "NET TRADER P&L")}`);
  console.log(`  ${fmt(gVaultPnl, "NET VAULT P&L")}`);

  // ================================================================
  // PART 2: VAULT / BACKSTOP / TREASURY STATE
  // ================================================================
  console.log(`\n${"=".repeat(70)}`);
  console.log("VAULT / BACKSTOP / TREASURY STATE");
  console.log("=".repeat(70));

  const WAD = 10n ** 18n;

  function fmtWad(val: bigint, label?: string): string {
    const sign = val < 0n ? "-" : "";
    const abs = val < 0n ? -val : val;
    const dollars = abs / WAD;
    const frac = (abs % WAD) / (WAD / 100n);
    const result = `${sign}$${dollars.toString()}.${frac.toString().padStart(2, "0")}`;
    return label ? `${label}: ${result}` : result;
  }

  try {
    const vaultNav = await core.getVaultNav();
    const vaultShares = await core.getVaultShares();
    const vaultPrice = await core.getVaultPrice();
    const vaultPricePeak = await core.getVaultPricePeak();
    const vaultSeeded = await core.isVaultSeeded();
    const [backstopNav, treasuryNav] = await core.getCapitalStack();
    const currentBatchId = await core.getCurrentBatchId();

    const paymentAddr = await core.paymentToken();
    const payment = new ethers.Contract(paymentAddr, ERC20_ABI, signer);
    const contractBalance = await payment.balanceOf(coreAddr);

    console.log(`  Vault seeded: ${vaultSeeded}`);
    console.log(`  ${fmtWad(vaultNav, "Vault NAV")}`);
    console.log(`  ${fmtWad(vaultShares, "Vault shares")}`);
    console.log(`  Share price: ${(Number(vaultPrice) / 1e18).toFixed(6)} (WAD)`);
    console.log(`  Peak price:  ${(Number(vaultPricePeak) / 1e18).toFixed(6)} (WAD)`);
    const drawdown = vaultPricePeak > 0n && vaultPrice < vaultPricePeak
      ? Number(WAD - (vaultPrice * WAD) / vaultPricePeak) / 1e16
      : 0;
    console.log(`  Drawdown: ${drawdown.toFixed(2)}%`);
    console.log(`  ${fmtWad(backstopNav, "Backstop NAV")}`);
    console.log(`  ${fmtWad(treasuryNav, "Treasury NAV")}`);
    console.log(`  Current batch ID: ${currentBatchId}`);
    console.log(`  Contract USDC balance: ${fmt(contractBalance)}`);

    // Check batch states for markets' settlement timestamps
    console.log(`\n  --- BATCH STATUS ---`);
    const BATCH_SECONDS = 86400n;
    const BATCH_TIMEZONE_OFFSET = 28800n;

    for (const cfg of marketConfigs) {
      const m = await core.markets(cfg.id);
      const settlementTs = m.settlementTimestamp;
      const batchId = (BigInt(settlementTs) - BATCH_TIMEZONE_OFFSET) / BATCH_SECONDS;
      const [total, resolved] = await core.getBatchMarketState(batchId);
      console.log(`  Market #${cfg.id} (${cfg.asset}): batchId=${batchId}, total=${total}, resolved=${resolved}`);
    }

    const nextBatchId = currentBatchId + 1n;
    const [nextTotal, nextResolved] = await core.getBatchMarketState(nextBatchId);
    console.log(`\n  Next batch to process: ${nextBatchId}`);
    console.log(`    Markets: ${nextTotal} total, ${nextResolved} resolved`);
    if (nextTotal > 0n && nextTotal === nextResolved) {
      console.log(`    STATUS: Ready to process (all markets resolved)`);
    } else if (nextTotal > 0n) {
      console.log(`    STATUS: NOT ready (${Number(nextTotal) - Number(nextResolved)} markets still unresolved)`);
    } else {
      console.log(`    STATUS: No markets assigned to this batch`);
    }
  } catch (e: any) {
    console.log(`  Error reading vault state: ${e.message}`);
  }

  // ================================================================
  // PART 3: GRAND COMPARISON — ALL 3 MARKET SETS
  // ================================================================
  console.log(`\n${"=".repeat(70)}`);
  console.log("GRAND COMPARISON: ALL 3 MARKET SETS");
  console.log("=".repeat(70));

  // Analyze Sets 1 and 2 (compact — just read market data and events)
  interface SetSummary {
    label: string;
    totalVolume: bigint;
    totalFees: bigint;
    totalPayouts: bigint;
    vaultPnl: bigint;
    traderPnl: bigint;
    positions: number;
    winners: number;
  }

  const allSetResults: SetSummary[] = [];

  // Set 4 (already analyzed)
  allSetResults[3] = {
    label: "Set 4: Bell curve, alpha 1000 (round 4)",
    totalVolume: gSpend,
    totalFees: gFees,
    totalPayouts: gPayouts,
    vaultPnl: gVaultPnl,
    traderPnl: gTraderPnl,
    positions: gPos,
    winners: gWin,
  };

  // Analyze Sets 1-3
  for (let setIdx = 0; setIdx < 3; setIdx++) {
    const mset = marketSets[setIdx];
    let sVolume = 0n, sFees = 0n, sPayouts = 0n, sPos = 0, sWin = 0;

    for (const cfg of mset.markets) {
      const m = await core.markets(cfg.id);
      if (!m.settled) {
        console.log(`  Market #${cfg.id} not settled, skipping`);
        continue;
      }

      const settlementTick = m.settlementTick;
      const accumulatedFees = m.accumulatedFees;
      const accFees6 = accumulatedFees / (10n ** 12n);
      sFees += accFees6;

      // Get positions via events
      const openFilter = core.filters.PositionOpened(null, null, cfg.id);
      const openEvents = await paginatedQuery(core, openFilter, searchFromBlock, currentBlock);

      let marketCost = 0n;
      let marketPayouts = 0n;
      let marketWin = 0;

      for (const ev of openEvents) {
        const posIdStr = ev.args.positionId.toString();
        const cost = ev.args.cost;
        marketCost += cost;

        let lowerTick = ev.args.lowerTick;
        let upperTick = ev.args.upperTick;
        let quantity = ev.args.quantity;

        // Check if winner
        const isWinner = lowerTick <= settlementTick && upperTick > settlementTick;
        if (isWinner) {
          // Try to get final quantity from contract
          try {
            const pos = await position.getPosition(BigInt(posIdStr));
            quantity = pos.quantity;
          } catch { /* burned, use event qty */ }
          marketPayouts += quantity;
          marketWin++;
        }
        sPos++;
      }

      // Fee events for accurate total
      const feeFilter = core.filters.TradeFeeCharged(null, cfg.id);
      const feeEvents = await paginatedQuery(core, feeFilter, searchFromBlock, currentBlock);
      let mBuyFees = 0n;
      for (const ev of feeEvents) {
        if (ev.args.isBuy) mBuyFees += ev.args.feeAmount;
      }

      sVolume += marketCost + mBuyFees;
      sPayouts += marketPayouts;
      sWin += marketWin;
    }

    allSetResults[setIdx] = {
      label: mset.label,
      totalVolume: sVolume,
      totalFees: sFees,
      totalPayouts: sPayouts,
      vaultPnl: sVolume - sPayouts,
      traderPnl: sPayouts - sVolume,
      positions: sPos,
      winners: sWin,
    };
  }

  // Print comparison table
  console.log("");
  console.log("  " + "-".repeat(85));
  console.log(`  ${"Set".padEnd(38)} ${"Volume".padStart(10)} ${"Payouts".padStart(10)} ${"Vault P&L".padStart(10)} ${"Loss/$1 Vol".padStart(12)}`);
  console.log("  " + "-".repeat(85));

  for (const s of allSetResults) {
    const vol = fmt(s.totalVolume);
    const pay = fmt(s.totalPayouts);
    const vpnl = fmt(s.vaultPnl);
    const lossPerDollar = s.totalVolume > 0n
      ? (Number(s.vaultPnl) / Number(s.totalVolume)).toFixed(4)
      : "N/A";
    console.log(`  ${s.label.padEnd(38)} ${vol.padStart(10)} ${pay.padStart(10)} ${vpnl.padStart(10)} ${lossPerDollar.padStart(12)}`);
  }
  console.log("  " + "-".repeat(85));
  console.log(`\n  Note: Positive Vault P&L = vault earned. Loss/$1 Vol > 0 = vault earned per $1 traded.`);
}

main().catch(console.error);
