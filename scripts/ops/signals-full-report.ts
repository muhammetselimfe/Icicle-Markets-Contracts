/**
 * Signals Protocol — Full Performance Report (Citrea Mainnet)
 *
 * Collects ALL market data, position events, batch P&L, vault state,
 * and outputs a comprehensive markdown report.
 *
 * Usage: npx hardhat run scripts/ops/signals-full-report.ts --network prod
 */
import hre from "hardhat";
import * as fs from "fs";
import { loadEnvironment } from "../utils/environment";

/* ------------------------------------------------------------------ */
/*  ABI fragments                                                      */
/* ------------------------------------------------------------------ */
const CORE_ABI = [
  "function markets(uint256) view returns (bool isSeeded, bool settled, bool snapshotChunksDone, bool failed, uint32 numBins, uint32 openPositionCount, uint32 snapshotChunkCursor, uint32 seedCursor, uint64 startTimestamp, uint64 endTimestamp, uint64 settlementTimestamp, uint64 settlementFinalizedAt, int256 minTick, int256 maxTick, int256 tickSpacing, int256 settlementTick, int256 settlementValue, uint256 liquidityParameter, address feePolicy, address seedData, uint256 initialRootSum, uint256 accumulatedFees, uint256 minFactor, uint256 deltaEt)",
  "function nextMarketId() view returns (uint256)",
  "function getVaultNav() view returns (uint256)",
  "function getVaultPrice() view returns (uint256)",
  "function getVaultPricePeak() view returns (uint256)",
  "function getVaultDrawdown() view returns (uint256)",
  "function getVaultShares() view returns (uint256)",
  "function isVaultSeeded() view returns (bool)",
  "function getCapitalStack() view returns (uint256 backstopNav, uint256 treasuryNav)",
  "function getCurrentBatchId() view returns (uint64)",
  "function getBatchMarketState(uint64 batchId) view returns (uint64 total, uint64 resolved)",
  "function getDailyPnl(uint64 batchId) view returns (int256 lt, uint256 ftot, uint256 ft, uint256 gt, uint256 npre, uint256 pe, bool processed)",
  "function paymentToken() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

const POSITION_ABI = [
  "function getMarketPositions(uint256 marketId) view returns (uint256[])",
  "function getPosition(uint256 positionId) view returns (tuple(uint256 marketId, int256 lowerTick, int256 upperTick, uint128 quantity, uint64 createdAt))",
];

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const WAD = 10n ** 18n;
const BATCH_TIMEZONE_OFFSET = 28800;
const BATCH_SECONDS = 86400;
const DEPLOY_BLOCK = 2699000; // Contract deployed at block ~2699604

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function fmt6(val: bigint): string {
  const sign = val < 0n ? "-" : "";
  const abs = val < 0n ? -val : val;
  const dollars = abs / 1_000_000n;
  const cents = (abs % 1_000_000n) / 10_000n;
  return `${sign}$${dollars.toString()}.${cents.toString().padStart(2, "0")}`;
}

function fmtWad(val: bigint): string {
  const sign = val < 0n ? "-" : "";
  const abs = val < 0n ? -val : val;
  const dollars = abs / WAD;
  const cents = ((abs % WAD) * 100n) / WAD;
  return `${sign}$${dollars.toString()}.${cents.toString().padStart(2, "0")}`;
}

function fmtWadPrecise(val: bigint): string {
  const sign = val < 0n ? "-" : "";
  const abs = val < 0n ? -val : val;
  const whole = abs / WAD;
  const frac = ((abs % WAD) * 1_000_000n) / WAD;
  return `${sign}${whole.toString()}.${frac.toString().padStart(6, "0")}`;
}

function batchIdFromTimestamp(ts: number): number {
  return Math.floor((ts - BATCH_TIMEZONE_OFFSET) / BATCH_SECONDS);
}

function batchStartTimestamp(batchId: number): number {
  return batchId * BATCH_SECONDS + BATCH_TIMEZONE_OFFSET;
}

function tsISO(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function tsDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/*  Bulk log fetching: get ALL logs from the core address              */
/* ------------------------------------------------------------------ */
async function fetchAllLogs(
  provider: any,
  address: string,
  fromBlock: number,
  toBlock: number,
  chunkSize = 2000,
): Promise<any[]> {
  const allLogs: any[] = [];
  let start = fromBlock;
  let chunks = 0;
  const totalChunks = Math.ceil((toBlock - fromBlock + 1) / chunkSize);
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    chunks++;
    if (chunks % 100 === 0) {
      process.stdout.write(`  [${chunks}/${totalChunks} chunks, ${allLogs.length} logs]`);
    }
    try {
      const logs = await provider.getLogs({
        address,
        fromBlock: start,
        toBlock: end,
      });
      allLogs.push(...logs);
    } catch (e: any) {
      // If chunk too large, halve it
      if (chunkSize > 200) {
        const mid = Math.floor((start + end) / 2);
        const first = await fetchAllLogs(provider, address, start, mid, Math.floor(chunkSize / 2));
        const second = await fetchAllLogs(provider, address, mid + 1, end, Math.floor(chunkSize / 2));
        allLogs.push(...first, ...second);
      } else {
        console.error(`\n  Failed to fetch logs ${start}-${end}: ${e.message?.slice(0, 80)}`);
      }
    }
    start = end + 1;
  }
  return allLogs;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
interface MarketData {
  id: number;
  isSeeded: boolean;
  settled: boolean;
  failed: boolean;
  numBins: number;
  openPositionCount: number;
  startTimestamp: number;
  endTimestamp: number;
  settlementTimestamp: number;
  settlementFinalizedAt: number;
  minTick: bigint;
  maxTick: bigint;
  tickSpacing: bigint;
  settlementTick: bigint;
  settlementValue: bigint;
  liquidityParameter: bigint;
  feePolicy: string;
  seedData: string;
  initialRootSum: bigint;
  accumulatedFees: bigint;
  minFactor: bigint;
  deltaEt: bigint;
  feePolicyName: string;
  batchId: number;
  positionsOpened: number;
  totalVolume: bigint;
  totalFees: bigint;
  winners: number;
  losers: number;
  totalPayouts: bigint;
  pnlLt: bigint | null;
  pnlFtot: bigint | null;
}

interface BatchData {
  batchId: number;
  lt: bigint;
  ftot: bigint;
  ft: bigint;
  gt: bigint;
  npre: bigint;
  pe: bigint;
  processed: boolean;
  marketIds: number[];
}

// Per-position data extracted from events
interface PositionInfo {
  positionId: bigint;
  marketId: number;
  trader: string;
  lowerTick: bigint;
  upperTick: bigint;
  quantity: bigint;
  cost: bigint;
}

/* ================================================================== */
/*  MAIN                                                               */
/* ================================================================== */
async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("prod");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const posAddr = env.contracts.IcicleOptionsPositionProxy;
  const lpShareAddr = env.contracts.IcicleOptionsLPShareProxy;

  const provider = ethers.provider;
  const position = new ethers.Contract(posAddr, POSITION_ABI, provider);
  const lpShare = new ethers.Contract(lpShareAddr, ERC20_ABI, provider);

  // Build interfaces for event parsing
  const tradeIface = new ethers.Interface([
    "event PositionOpened(uint256 indexed positionId, address indexed trader, uint256 indexed marketId, int256 lowerTick, int256 upperTick, uint128 quantity, uint256 cost)",
    "event TradeFeeCharged(address indexed trader, uint256 indexed marketId, uint256 indexed positionId, bool isBuy, uint256 baseAmount, uint256 feeAmount, address policy)",
  ]);
  const lifecycleIface = new ethers.Interface([
    "event MarketPnlRecorded(uint256 indexed marketId, uint64 indexed batchId, int256 lt, uint256 ftot)",
  ]);

  // Use typed contract for view calls
  const core = new ethers.Contract(coreAddr, CORE_ABI, provider);

  // Fee policy address -> name mapping
  const feePolicyMap: Record<string, string> = {};
  for (const key of ["FeePolicyNull", "FeePolicy10bps", "FeePolicy50bps", "FeePolicy100bps", "FeePolicy200bps"]) {
    if (env.contracts[key]) {
      feePolicyMap[env.contracts[key].toLowerCase()] = key;
    }
  }

  console.log("=== Signals Protocol Full Report — Citrea Mainnet ===");
  console.log(`Core: ${coreAddr}`);
  console.log(`Chain: 4114 (Citrea Mainnet)\n`);

  // ----------------------------------------------------------------
  // 1. Basic protocol state
  // ----------------------------------------------------------------
  const nextMarketId = Number(await core.nextMarketId());
  const totalMarkets = nextMarketId - 1;
  const currentBatchId = Number(await core.getCurrentBatchId());
  const currentBlock = await provider.getBlockNumber();

  console.log(`Total markets: ${totalMarkets} (nextMarketId = ${nextMarketId})`);
  console.log(`Current batch: ${currentBatchId}`);
  console.log(`Current block: ${currentBlock}`);

  // ----------------------------------------------------------------
  // 2. Vault state
  // ----------------------------------------------------------------
  console.log("\nFetching vault state...");
  const vaultNav = await core.getVaultNav();
  const vaultPrice = await core.getVaultPrice();
  const vaultPricePeak = await core.getVaultPricePeak();
  const vaultDrawdown = await core.getVaultDrawdown();
  const vaultShares = await core.getVaultShares();
  const vaultSeeded = await core.isVaultSeeded();
  const [backstopNav, treasuryNav] = await core.getCapitalStack();
  const totalShareSupply = await lpShare.totalSupply();

  const paymentAddr = await core.paymentToken();
  const paymentToken = new ethers.Contract(paymentAddr, ERC20_ABI, provider);
  const contractBalance = await paymentToken.balanceOf(coreAddr);

  console.log(`  NAV: ${fmtWad(vaultNav)}, Price: ${fmtWadPrecise(vaultPrice)}, Drawdown: ${(Number(vaultDrawdown) / 1e16).toFixed(2)}%`);

  // ----------------------------------------------------------------
  // 3. Fetch ALL market struct data
  // ----------------------------------------------------------------
  console.log("\nFetching all market data...");
  const markets: MarketData[] = [];

  for (let id = 1; id < nextMarketId; id++) {
    process.stdout.write(`  Market #${id}...`);
    const m = await core.markets(BigInt(id));
    const feeAddr = m.feePolicy.toLowerCase();

    const data: MarketData = {
      id,
      isSeeded: m.isSeeded,
      settled: m.settled,
      failed: m.failed,
      numBins: Number(m.numBins),
      openPositionCount: Number(m.openPositionCount),
      startTimestamp: Number(m.startTimestamp),
      endTimestamp: Number(m.endTimestamp),
      settlementTimestamp: Number(m.settlementTimestamp),
      settlementFinalizedAt: Number(m.settlementFinalizedAt),
      minTick: m.minTick,
      maxTick: m.maxTick,
      tickSpacing: m.tickSpacing,
      settlementTick: m.settlementTick,
      settlementValue: m.settlementValue,
      liquidityParameter: m.liquidityParameter,
      feePolicy: m.feePolicy,
      seedData: m.seedData,
      initialRootSum: m.initialRootSum,
      accumulatedFees: m.accumulatedFees,
      minFactor: m.minFactor,
      deltaEt: m.deltaEt,
      feePolicyName: feePolicyMap[feeAddr] || `Unknown(${m.feePolicy})`,
      batchId: batchIdFromTimestamp(Number(m.settlementTimestamp)),
      positionsOpened: 0,
      totalVolume: 0n,
      totalFees: 0n,
      winners: 0,
      losers: 0,
      totalPayouts: 0n,
      pnlLt: null,
      pnlFtot: null,
    };

    markets.push(data);
    const status = data.settled ? "settled" : data.failed ? "FAILED" : "active/pending";
    console.log(` ${status}, bins=${data.numBins}, alpha=${Number(data.liquidityParameter) / 1e18}`);
  }

  // ----------------------------------------------------------------
  // 4. BULK fetch ALL logs from core contract, parse events
  // ----------------------------------------------------------------
  console.log(`\nFetching ALL logs from core contract (blocks ${DEPLOY_BLOCK}-${currentBlock})...`);
  const allLogs = await fetchAllLogs(provider, coreAddr, DEPLOY_BLOCK, currentBlock);
  console.log(`\n  Total logs fetched: ${allLogs.length}`);

  // Parse all logs
  const positionsByMarket: Record<number, PositionInfo[]> = {};
  const feesByMarket: Record<number, bigint> = {};

  let parsedPositions = 0;
  let parsedFees = 0;
  let parsedPnl = 0;

  for (const log of allLogs) {
    // Try MarketPnlRecorded
    try {
      const parsed = lifecycleIface.parseLog(log);
      if (parsed?.name === "MarketPnlRecorded") {
        const mktId = Number(parsed.args.marketId);
        const mkt = markets.find(m => m.id === mktId);
        if (mkt) {
          mkt.pnlLt = parsed.args.lt;
          mkt.pnlFtot = parsed.args.ftot;
          parsedPnl++;
        }
        continue;
      }
    } catch {}

    // Try Trade events
    try {
      const parsed = tradeIface.parseLog(log);
      if (parsed?.name === "PositionOpened") {
        const mktId = Number(parsed.args.marketId);
        if (!positionsByMarket[mktId]) positionsByMarket[mktId] = [];
        positionsByMarket[mktId].push({
          positionId: parsed.args.positionId,
          marketId: mktId,
          trader: parsed.args.trader,
          lowerTick: parsed.args.lowerTick,
          upperTick: parsed.args.upperTick,
          quantity: parsed.args.quantity,
          cost: parsed.args.cost,
        });
        parsedPositions++;
        continue;
      }
      if (parsed?.name === "TradeFeeCharged") {
        if (parsed.args.isBuy) {
          const mktId = Number(parsed.args.marketId);
          feesByMarket[mktId] = (feesByMarket[mktId] ?? 0n) + parsed.args.feeAmount;
          parsedFees++;
        }
        continue;
      }
    } catch {}
  }

  console.log(`  Parsed: ${parsedPositions} PositionOpened, ${parsedFees} TradeFeeCharged (buy), ${parsedPnl} MarketPnlRecorded`);

  // Assign event data to markets
  for (const mkt of markets) {
    const positions = positionsByMarket[mkt.id] || [];
    mkt.positionsOpened = positions.length;
    mkt.totalVolume = positions.reduce((s, p) => s + p.cost, 0n);
    mkt.totalFees = feesByMarket[mkt.id] || 0n;

    // Winner/loser classification
    if (mkt.settled && positions.length > 0) {
      for (const pos of positions) {
        const isWinner = pos.lowerTick <= mkt.settlementTick && pos.upperTick > mkt.settlementTick;
        if (isWinner) {
          mkt.winners++;
          // Try to get final quantity (may include increases)
          try {
            const posData = await position.getPosition(pos.positionId);
            mkt.totalPayouts += BigInt(posData.quantity);
          } catch {
            // Position burned (claimed) — use event quantity
            mkt.totalPayouts += BigInt(pos.quantity);
          }
        } else {
          mkt.losers++;
        }
      }
    }
  }

  // ----------------------------------------------------------------
  // 5. Batch P&L data
  // ----------------------------------------------------------------
  console.log("\nFetching batch P&L data...");
  const batches: BatchData[] = [];

  const batchIdSet = new Set<number>();
  for (const mkt of markets) {
    batchIdSet.add(mkt.batchId);
  }
  const sortedBatchIds = Array.from(batchIdSet).sort((a, b) => a - b);
  const minBatch = sortedBatchIds.length > 0 ? sortedBatchIds[0] : currentBatchId;
  const maxBatch = currentBatchId;

  for (let bid = minBatch; bid <= maxBatch; bid++) {
    try {
      const r = await core.getDailyPnl(BigInt(bid));
      const lt = r[0] as bigint;
      const ftot = r[1] as bigint;
      const ft = r[2] as bigint;
      const gt = r[3] as bigint;
      const npre = r[4] as bigint;
      const pe = r[5] as bigint;
      const processed = r[6] as boolean;

      if (lt !== 0n || ftot !== 0n || processed) {
        const marketIds = markets.filter(m => m.batchId === bid).map(m => m.id);
        batches.push({ batchId: bid, lt, ftot, ft, gt, npre, pe, processed, marketIds });
      }
    } catch {}
  }

  console.log(`  Found ${batches.length} batches with data`);

  // ----------------------------------------------------------------
  // 6. Generate markdown report
  // ----------------------------------------------------------------
  console.log("\nGenerating report...");

  const now = new Date();
  const reportDate = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";

  let md = "";
  md += `# Signals Protocol — Full Performance Report\n\n`;
  md += `**Chain:** Citrea Mainnet (4114)\n`;
  md += `**Core Contract:** \`${coreAddr}\`\n`;
  md += `**Report Generated:** ${reportDate}\n`;
  md += `**Block:** ${currentBlock}\n\n`;

  // ---- Executive Summary ----
  md += `## Executive Summary\n\n`;

  const settledMarkets = markets.filter(m => m.settled);
  const failedMarkets = markets.filter(m => m.failed);
  const activeMarkets = markets.filter(m => !m.settled && !m.failed && m.endTimestamp > Math.floor(Date.now() / 1000));
  const expiredUnsettled = markets.filter(m => !m.settled && !m.failed && m.endTimestamp <= Math.floor(Date.now() / 1000));

  const totalVolume = markets.reduce((s, m) => s + m.totalVolume, 0n);
  const totalFees = markets.reduce((s, m) => s + m.totalFees, 0n);
  const totalPositions = markets.reduce((s, m) => s + m.positionsOpened, 0);
  const totalWinners = settledMarkets.reduce((s, m) => s + m.winners, 0);
  const totalLosers = settledMarkets.reduce((s, m) => s + m.losers, 0);
  const totalPayouts = settledMarkets.reduce((s, m) => s + m.totalPayouts, 0n);

  let totalPnlLt = 0n;
  let totalPnlFtot = 0n;
  for (const mkt of markets) {
    if (mkt.pnlLt !== null) totalPnlLt += mkt.pnlLt;
    if (mkt.pnlFtot !== null) totalPnlFtot += mkt.pnlFtot;
  }

  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Total Markets Created | ${totalMarkets} |\n`;
  md += `| Settled Markets | ${settledMarkets.length} |\n`;
  md += `| Failed Markets | ${failedMarkets.length} |\n`;
  md += `| Active Markets | ${activeMarkets.length} |\n`;
  md += `| Expired (Unsettled) | ${expiredUnsettled.length} |\n`;
  md += `| Total Positions Opened | ${totalPositions} |\n`;
  md += `| Winners / Losers | ${totalWinners} / ${totalLosers} |\n`;
  md += `| Win Rate | ${(totalWinners + totalLosers) > 0 ? ((totalWinners / (totalWinners + totalLosers)) * 100).toFixed(1) : "N/A"}% |\n`;
  md += `| Total Volume (premiums) | ${fmt6(totalVolume)} |\n`;
  md += `| Total Fees Collected | ${fmt6(totalFees)} |\n`;
  md += `| Total Payouts | ${fmt6(totalPayouts)} |\n`;
  md += `| Aggregate CLMSR P&L (Lt) | ${fmtWad(totalPnlLt)} |\n`;
  md += `| Aggregate Fee Revenue (Ftot) | ${fmtWad(totalPnlFtot)} |\n`;
  md += `| Net Vault P&L (Lt + Ftot) | ${fmtWad(totalPnlLt + totalPnlFtot)} |\n`;
  md += `\n`;

  // ---- Vault State ----
  md += `## LP Vault State\n\n`;
  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Vault Seeded | ${vaultSeeded} |\n`;
  md += `| Vault NAV | ${fmtWad(vaultNav)} |\n`;
  md += `| Share Price | ${fmtWadPrecise(vaultPrice)} |\n`;
  md += `| Peak Share Price | ${fmtWadPrecise(vaultPricePeak)} |\n`;
  md += `| Drawdown | ${(Number(vaultDrawdown) / 1e16).toFixed(2)}% |\n`;
  md += `| Total LP Shares | ${fmtWadPrecise(totalShareSupply)} |\n`;
  md += `| Vault Shares (internal) | ${fmtWadPrecise(vaultShares)} |\n`;
  md += `| Backstop NAV | ${fmtWad(backstopNav)} |\n`;
  md += `| Treasury NAV | ${fmtWad(treasuryNav)} |\n`;
  md += `| Contract USDC Balance | ${fmt6(contractBalance)} |\n`;
  md += `| Payment Token | \`${paymentAddr}\` |\n`;
  md += `| Current Batch ID | ${currentBatchId} |\n`;
  md += `\n`;

  // ---- Deployed Contracts ----
  md += `## Deployed Contracts\n\n`;
  md += `| Contract | Address |\n`;
  md += `|----------|----------|\n`;
  for (const [name, addr] of Object.entries(env.contracts)) {
    md += `| ${name} | \`${addr}\` |\n`;
  }
  md += `\n`;

  // ---- Fee Policies ----
  md += `## Fee Policies\n\n`;
  md += `| Name | Address | Rate |\n`;
  md += `|------|---------|------|\n`;
  const feeRates: Record<string, string> = {
    FeePolicyNull: "0 bps",
    FeePolicy10bps: "10 bps (0.1%)",
    FeePolicy50bps: "50 bps (0.5%)",
    FeePolicy100bps: "100 bps (1.0%)",
    FeePolicy200bps: "200 bps (2.0%)",
  };
  for (const [name, rate] of Object.entries(feeRates)) {
    const addr = env.contracts[name] || "N/A";
    md += `| ${name} | \`${addr}\` | ${rate} |\n`;
  }
  md += `\n`;

  // ---- Per-Market Detail ----
  md += `## Per-Market Detail\n\n`;

  for (const mkt of markets) {
    const alpha = Number(mkt.liquidityParameter) / 1e18;
    const spacing = Number(mkt.tickSpacing);
    const settleTick = Number(mkt.settlementTick);
    const centerTick = Number(mkt.minTick) + Math.floor(mkt.numBins / 2) * spacing;
    const distFromCenter = spacing > 0 ? Math.abs(settleTick - centerTick) / spacing : 0;
    const maxVaultLoss = mkt.numBins > 1 ? alpha * Math.log(mkt.numBins) : 0;

    const status = mkt.settled ? "Settled" : mkt.failed ? "Failed" : "Active/Pending";

    md += `### Market #${mkt.id}\n\n`;
    md += `| Parameter | Value |\n`;
    md += `|-----------|-------|\n`;
    md += `| Status | **${status}** |\n`;
    md += `| Min Tick | ${mkt.minTick.toString()} ($${Number(mkt.minTick).toLocaleString()}) |\n`;
    md += `| Max Tick | ${mkt.maxTick.toString()} ($${Number(mkt.maxTick).toLocaleString()}) |\n`;
    md += `| Tick Spacing | ${mkt.tickSpacing.toString()} |\n`;
    md += `| Num Bins | ${mkt.numBins} |\n`;
    md += `| Alpha (liquidity param) | ${alpha.toFixed(4)} WAD |\n`;
    md += `| Fee Policy | ${mkt.feePolicyName} (\`${mkt.feePolicy}\`) |\n`;
    md += `| Seed Data | \`${mkt.seedData}\` |\n`;
    md += `| Start | ${tsISO(mkt.startTimestamp)} |\n`;
    md += `| End | ${tsISO(mkt.endTimestamp)} |\n`;
    md += `| Settlement Timestamp | ${tsISO(mkt.settlementTimestamp)} |\n`;
    if (mkt.settled) {
      md += `| Settlement Finalized | ${tsISO(mkt.settlementFinalizedAt)} |\n`;
      md += `| Settlement Tick | ${settleTick} ($${settleTick.toLocaleString()}) |\n`;
      md += `| Settlement Value (raw) | ${mkt.settlementValue.toString()} |\n`;
      md += `| Distance from Center | ${distFromCenter.toFixed(1)} bins |\n`;
    }
    md += `| Batch ID | ${mkt.batchId} |\n`;
    md += `| Accumulated Fees (WAD) | ${fmtWad(mkt.accumulatedFees)} |\n`;
    md += `| Delta Et (WAD) | ${fmtWadPrecise(mkt.deltaEt)} |\n`;
    md += `| Initial Root Sum | ${fmtWadPrecise(mkt.initialRootSum)} |\n`;
    md += `| Min Factor | ${fmtWadPrecise(mkt.minFactor)} |\n`;
    md += `| Max Vault Loss (theoretical) | $${maxVaultLoss.toFixed(2)} |\n`;
    md += `\n`;

    // Gaussian sigma inference from deltaEt
    if (mkt.deltaEt > 0n) {
      const deltaEtNum = Number(mkt.deltaEt) / 1e18;
      md += `**Seed Data Analysis:** Non-uniform prior detected (deltaEt = ${deltaEtNum.toFixed(6)} WAD). `;
      md += `This indicates a Gaussian/bell-curve seed with maker risk premium.\n\n`;
    } else {
      md += `**Seed Data Analysis:** Uniform prior (deltaEt = 0). Equal probability across all bins.\n\n`;
    }

    // Position & volume data
    md += `**Trading Activity:**\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Positions Opened | ${mkt.positionsOpened} |\n`;
    md += `| Open Positions (unclaimed) | ${mkt.openPositionCount} |\n`;
    md += `| Total Volume (premiums) | ${fmt6(mkt.totalVolume)} |\n`;
    md += `| Total Fees (buy-side) | ${fmt6(mkt.totalFees)} |\n`;
    if (mkt.settled) {
      md += `| Winners | ${mkt.winners} |\n`;
      md += `| Losers | ${mkt.losers} |\n`;
      md += `| Win Rate | ${mkt.positionsOpened > 0 ? ((mkt.winners / mkt.positionsOpened) * 100).toFixed(1) : "N/A"}% |\n`;
      md += `| Total Payouts | ${fmt6(mkt.totalPayouts)} |\n`;
      const netTrader = mkt.totalPayouts - mkt.totalVolume - mkt.totalFees;
      md += `| Net Trader P&L | ${fmt6(netTrader)} |\n`;
    }
    md += `\n`;

    // MarketPnlRecorded
    if (mkt.pnlLt !== null && mkt.pnlFtot !== null) {
      const lt = Number(mkt.pnlLt) / 1e18;
      const ftot = Number(mkt.pnlFtot) / 1e18;
      const net = lt + ftot;
      const psiFee = lt < 0 ? ftot / Math.abs(lt) : Infinity;

      md += `**Vault P&L (MarketPnlRecorded):**\n\n`;
      md += `| Metric | Value |\n`;
      md += `|--------|-------|\n`;
      md += `| CLMSR P&L (Lt) | ${lt >= 0 ? "+" : ""}$${lt.toFixed(2)} |\n`;
      md += `| Fee Revenue (Ftot) | $${ftot.toFixed(2)} |\n`;
      md += `| Net Vault P&L | ${net >= 0 ? "+" : ""}$${net.toFixed(2)} |\n`;
      md += `| Psi Fee (Ftot/|Lt|) | ${psiFee === Infinity ? "inf (vault profited from CLMSR)" : psiFee.toFixed(4)} |\n`;
      md += `\n`;
    } else {
      md += `**Vault P&L:** No MarketPnlRecorded event found for this market.\n\n`;
    }

    md += `---\n\n`;
  }

  // ---- Batch P&L Summary ----
  md += `## Batch P&L History\n\n`;
  md += `Batches run from 08:00 UTC to 08:00 UTC (BATCH_TIMEZONE_OFFSET = 28800).\n\n`;

  if (batches.length > 0) {
    md += `| Batch ID | Date | Lt (WAD) | Ftot (WAD) | Ft (WAD) | Gt (WAD) | Pre-NAV | PE | Processed | Markets |\n`;
    md += `|----------|------|----------|------------|----------|----------|---------|----|-----------|---------|\n`;

    for (const b of batches) {
      const date = tsDate(batchStartTimestamp(b.batchId));
      const lt = fmtWad(b.lt);
      const ftot = fmtWad(b.ftot);
      const ft = fmtWad(b.ft);
      const gt = fmtWad(b.gt);
      const npre = fmtWad(b.npre);
      const pe = fmtWadPrecise(b.pe);
      const mkts = b.marketIds.join(", ");
      md += `| ${b.batchId} | ${date} | ${lt} | ${ftot} | ${ft} | ${gt} | ${npre} | ${pe} | ${b.processed} | ${mkts || "-"} |\n`;
    }
    md += `\n`;

    // Cumulative batch stats
    let cumLt = 0n;
    let cumFtot = 0n;
    for (const b of batches) {
      cumLt += b.lt;
      cumFtot += b.ftot;
    }
    md += `**Cumulative Batch Totals:**\n`;
    md += `- Total Lt: ${fmtWad(cumLt)}\n`;
    md += `- Total Ftot: ${fmtWad(cumFtot)}\n`;
    md += `- Net: ${fmtWad(cumLt + cumFtot)}\n`;
    md += `- Batches processed: ${batches.filter(b => b.processed).length} / ${batches.length}\n\n`;
  } else {
    md += `No batch P&L data found.\n\n`;
  }

  // ---- Market Timeline ----
  md += `## Market Timeline\n\n`;
  md += `| ID | Start Date | End Date | Settlement | Settled | Alpha | Bins | Range | Fee Policy | Positions | Volume |\n`;
  md += `|----|-----------|----------|-----------|---------|-------|------|-------|------------|-----------|--------|\n`;

  for (const mkt of markets) {
    const alpha = (Number(mkt.liquidityParameter) / 1e18).toFixed(2);
    const range = `$${Number(mkt.minTick).toLocaleString()}-$${Number(mkt.maxTick).toLocaleString()}`;
    const vol = fmt6(mkt.totalVolume);
    md += `| ${mkt.id} | ${tsDate(mkt.startTimestamp)} | ${tsDate(mkt.endTimestamp)} | ${tsDate(mkt.settlementTimestamp)} | ${mkt.settled ? "Yes" : mkt.failed ? "FAIL" : "No"} | ${alpha} | ${mkt.numBins} | ${range} | ${mkt.feePolicyName} | ${mkt.positionsOpened} | ${vol} |\n`;
  }
  md += `\n`;

  // ---- Aggregate Statistics ----
  md += `## Aggregate Statistics\n\n`;

  // By fee policy
  md += `### By Fee Policy\n\n`;
  const byFee: Record<string, { count: number; volume: bigint; fees: bigint; lt: bigint; ftot: bigint }> = {};
  for (const mkt of markets) {
    const key = mkt.feePolicyName;
    if (!byFee[key]) byFee[key] = { count: 0, volume: 0n, fees: 0n, lt: 0n, ftot: 0n };
    byFee[key].count++;
    byFee[key].volume += mkt.totalVolume;
    byFee[key].fees += mkt.totalFees;
    if (mkt.pnlLt !== null) byFee[key].lt += mkt.pnlLt;
    if (mkt.pnlFtot !== null) byFee[key].ftot += mkt.pnlFtot;
  }

  md += `| Fee Policy | Markets | Volume | Fees | Lt (WAD) | Ftot (WAD) | Net |\n`;
  md += `|------------|---------|--------|------|----------|------------|-----|\n`;
  for (const [name, data] of Object.entries(byFee)) {
    md += `| ${name} | ${data.count} | ${fmt6(data.volume)} | ${fmt6(data.fees)} | ${fmtWad(data.lt)} | ${fmtWad(data.ftot)} | ${fmtWad(data.lt + data.ftot)} |\n`;
  }
  md += `\n`;

  // By alpha (bucketed)
  md += `### By Alpha Range\n\n`;
  const alphaRanges = [
    { label: "< 5 WAD", min: 0, max: 5 },
    { label: "5-10 WAD", min: 5, max: 10 },
    { label: "10-15 WAD", min: 10, max: 15 },
    { label: "15-20 WAD", min: 15, max: 20 },
    { label: "20-30 WAD", min: 20, max: 30 },
    { label: "> 30 WAD", min: 30, max: Infinity },
  ];

  md += `| Alpha Range | Markets | Positions | Volume | Lt (WAD) | Ftot (WAD) | Net |\n`;
  md += `|-------------|---------|-----------|--------|----------|------------|-----|\n`;
  for (const range of alphaRanges) {
    const group = markets.filter(m => {
      const a = Number(m.liquidityParameter) / 1e18;
      return a >= range.min && a < range.max;
    });
    if (group.length === 0) continue;
    const vol = group.reduce((s, m) => s + m.totalVolume, 0n);
    const pos = group.reduce((s, m) => s + m.positionsOpened, 0);
    let lt = 0n, ftot = 0n;
    for (const m of group) {
      if (m.pnlLt !== null) lt += m.pnlLt;
      if (m.pnlFtot !== null) ftot += m.pnlFtot;
    }
    md += `| ${range.label} | ${group.length} | ${pos} | ${fmt6(vol)} | ${fmtWad(lt)} | ${fmtWad(ftot)} | ${fmtWad(lt + ftot)} |\n`;
  }
  md += `\n`;

  // By seed type
  md += `### By Seed Type\n\n`;
  const uniform = markets.filter(m => m.deltaEt === 0n);
  const gaussian = markets.filter(m => m.deltaEt > 0n);

  md += `| Seed Type | Markets | Positions | Volume | Lt (WAD) | Ftot (WAD) | Net |\n`;
  md += `|-----------|---------|-----------|--------|----------|------------|-----|\n`;

  for (const [label, group] of [["Uniform", uniform], ["Gaussian/Bell", gaussian]] as [string, MarketData[]][]) {
    const vol = group.reduce((s, m) => s + m.totalVolume, 0n);
    const pos = group.reduce((s, m) => s + m.positionsOpened, 0);
    let lt = 0n, ftot = 0n;
    for (const m of group) {
      if (m.pnlLt !== null) lt += m.pnlLt;
      if (m.pnlFtot !== null) ftot += m.pnlFtot;
    }
    md += `| ${label} | ${group.length} | ${pos} | ${fmt6(vol)} | ${fmtWad(lt)} | ${fmtWad(ftot)} | ${fmtWad(lt + ftot)} |\n`;
  }
  md += `\n`;

  // ---- Seed Data Contracts ----
  md += `### Seed Data Contracts\n\n`;
  const seedContracts = new Map<string, number[]>();
  for (const mkt of markets) {
    const addr = mkt.seedData;
    if (!seedContracts.has(addr)) seedContracts.set(addr, []);
    seedContracts.get(addr)!.push(mkt.id);
  }
  md += `| Seed Data Address | Markets | deltaEt (first market) |\n`;
  md += `|-------------------|---------|------------------------|\n`;
  for (const [addr, ids] of seedContracts) {
    const firstMkt = markets.find(m => m.id === ids[0])!;
    const deltaEt = Number(firstMkt.deltaEt) / 1e18;
    md += `| \`${addr}\` | ${ids.join(", ")} | ${deltaEt.toFixed(6)} |\n`;
  }
  md += `\n`;

  // ---- Vault History ----
  md += `## Vault NAV & Share Price History (from batches)\n\n`;
  md += `NAV snapshots are taken at each batch processing.\n\n`;

  if (batches.length > 0) {
    md += `| Batch | Date | Pre-NAV (WAD) | PE (Share Price) | Lt | Ftot | Net P&L |\n`;
    md += `|-------|------|---------------|------------------|-----|------|----------|\n`;
    for (const b of batches) {
      const date = tsDate(batchStartTimestamp(b.batchId));
      md += `| ${b.batchId} | ${date} | ${fmtWad(b.npre)} | ${fmtWadPrecise(b.pe)} | ${fmtWad(b.lt)} | ${fmtWad(b.ftot)} | ${fmtWad(b.lt + b.ftot)} |\n`;
    }
    md += `\n`;
  }

  // ---- Risk Metrics ----
  md += `## Risk Metrics\n\n`;

  let worstMarket: MarketData | null = null;
  let worstNet = 0n;
  let bestMarket: MarketData | null = null;
  let bestNet = 0n;
  for (const mkt of markets) {
    if (mkt.pnlLt !== null && mkt.pnlFtot !== null) {
      const net = mkt.pnlLt + mkt.pnlFtot;
      if (worstMarket === null || net < worstNet) {
        worstNet = net;
        worstMarket = mkt;
      }
      if (bestMarket === null || net > bestNet) {
        bestNet = net;
        bestMarket = mkt;
      }
    }
  }

  md += `| Metric | Value |\n`;
  md += `|--------|-------|\n`;
  md += `| Worst Market (Net P&L) | #${worstMarket?.id || "N/A"} (${fmtWad(worstNet)}) |\n`;
  md += `| Best Market (Net P&L) | #${bestMarket?.id || "N/A"} (${fmtWad(bestNet)}) |\n`;
  md += `| Current Drawdown | ${(Number(vaultDrawdown) / 1e16).toFixed(2)}% |\n`;
  md += `| Backstop Coverage | ${fmtWad(backstopNav)} |\n`;

  const marketsWithPnl = markets.filter(m => m.pnlLt !== null);
  if (marketsWithPnl.length > 0) {
    const avgNet = (totalPnlLt + totalPnlFtot) / BigInt(marketsWithPnl.length);
    md += `| Avg Net P&L per Market | ${fmtWad(avgNet)} |\n`;
  }
  if (settledMarkets.length > 0) {
    const avgVol = totalVolume / BigInt(settledMarkets.length);
    md += `| Avg Volume per Settled Market | ${fmt6(avgVol)} |\n`;
  }
  md += `\n`;

  // ---- Psi Fee Analysis ----
  md += `## Psi Fee Analysis (Fee Coverage Ratio)\n\n`;
  md += `Psi fee = Ftot / |Lt|. Values > 1.0 mean fees fully covered CLMSR losses.\n\n`;
  md += `| Market | Lt | Ftot | Psi Fee | Covered? |\n`;
  md += `|--------|-----|------|---------|----------|\n`;
  for (const mkt of markets) {
    if (mkt.pnlLt !== null && mkt.pnlFtot !== null && mkt.pnlLt < 0n) {
      const lt = Number(mkt.pnlLt) / 1e18;
      const ftot = Number(mkt.pnlFtot) / 1e18;
      const psi = ftot / Math.abs(lt);
      const covered = psi >= 1.0 ? "YES" : "NO";
      md += `| #${mkt.id} | $${lt.toFixed(2)} | $${ftot.toFixed(2)} | ${psi.toFixed(4)} | ${covered} |\n`;
    }
  }
  md += `\n`;

  // ---- Raw Data Appendix ----
  md += `## Appendix: Raw Market Data\n\n`;
  md += `<details>\n<summary>Click to expand raw market struct data</summary>\n\n`;
  md += `\`\`\`\n`;
  for (const mkt of markets) {
    md += `Market #${mkt.id}:\n`;
    md += `  isSeeded=${mkt.isSeeded}, settled=${mkt.settled}, failed=${mkt.failed}\n`;
    md += `  numBins=${mkt.numBins}, openPositionCount=${mkt.openPositionCount}\n`;
    md += `  startTimestamp=${mkt.startTimestamp}, endTimestamp=${mkt.endTimestamp}\n`;
    md += `  settlementTimestamp=${mkt.settlementTimestamp}, settlementFinalizedAt=${mkt.settlementFinalizedAt}\n`;
    md += `  minTick=${mkt.minTick}, maxTick=${mkt.maxTick}, tickSpacing=${mkt.tickSpacing}\n`;
    md += `  settlementTick=${mkt.settlementTick}, settlementValue=${mkt.settlementValue}\n`;
    md += `  liquidityParameter=${mkt.liquidityParameter}\n`;
    md += `  feePolicy=${mkt.feePolicy}\n`;
    md += `  seedData=${mkt.seedData}\n`;
    md += `  initialRootSum=${mkt.initialRootSum}\n`;
    md += `  accumulatedFees=${mkt.accumulatedFees}\n`;
    md += `  minFactor=${mkt.minFactor}\n`;
    md += `  deltaEt=${mkt.deltaEt}\n`;
    md += `  batchId=${mkt.batchId}\n`;
    md += `\n`;
  }
  md += `\`\`\`\n`;
  md += `</details>\n\n`;

  md += `---\n\n`;
  md += `*Report generated by \`scripts/ops/signals-full-report.ts\`*\n`;

  // ----------------------------------------------------------------
  // 7. Write report
  // ----------------------------------------------------------------
  const outDir = "/Users/selim/Desktop/L1Beat/Icicle App/signals-analysis";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/signals-performance-report.md`;
  fs.writeFileSync(outPath, md, "utf-8");
  console.log(`\nReport written to: ${outPath}`);
  console.log(`Report size: ${(md.length / 1024).toFixed(1)} KB`);
  console.log(`Markets: ${totalMarkets}, Positions: ${totalPositions}, Volume: ${fmt6(totalVolume)}`);
}

main().catch(console.error);
