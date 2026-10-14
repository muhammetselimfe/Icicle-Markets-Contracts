/**
 * Signals Protocol — Daily Status Check (Citrea Mainnet)
 *
 * Reads vault NAV, LP share price, recent markets, and SeedData analysis.
 * Usage: npx hardhat run scripts/ops/check-signals-today.ts --network prod
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

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
  "function getDailyPnl(uint64 batchId) view returns (int256 lt, uint256 ftot, uint256 ft, uint256 gt, uint256 npre, uint256 pe, bool processed)",
  "function paymentToken() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

const WAD = 10n ** 18n;
const BATCH_OFFSET = 28800;

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

function tsDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function tsShort(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Read SeedData factors from contract code.
 * SeedData runtime code is raw packed uint256 values (no STOP prefix).
 * Each factor = 32 bytes (64 hex chars).
 */
async function readSeedFactors(provider: any, seedAddr: string): Promise<number[]> {
  const code = await provider.getCode(seedAddr);
  if (code === "0x" || code.length < 4) return [];

  const data = code.slice(2); // remove 0x prefix
  const numFactors = Math.floor(data.length / 64); // 64 hex chars = 32 bytes
  const factors: number[] = [];

  for (let i = 0; i < numFactors; i++) {
    const hex = data.slice(i * 64, (i + 1) * 64);
    const factorWad = BigInt("0x" + hex);
    factors.push(Number(factorWad) / 1e18);
  }

  return factors;
}

/**
 * Estimate sigma (std dev in bins) from factor array.
 * Finds the peak bin, then finds how many bins away the factor drops to
 * ~60.65% of peak (exp(-0.5) for a Gaussian at 1 sigma).
 */
function estimateSigma(factors: number[]): {
  centerBin: number;
  peakFactor: number;
  minFactor: number;
  maxFactor: number;
  sigmaEstimate: number;
  isUniform: boolean;
} {
  if (factors.length === 0) {
    return { centerBin: 0, peakFactor: 0, minFactor: 0, maxFactor: 0, sigmaEstimate: 0, isUniform: true };
  }

  let peakFactor = 0;
  let minFactor = Infinity;
  let centerBin = 0;

  for (let i = 0; i < factors.length; i++) {
    if (factors[i] > peakFactor) {
      peakFactor = factors[i];
      centerBin = i;
    }
    if (factors[i] < minFactor) {
      minFactor = factors[i];
    }
  }

  // Check if uniform (all factors within 0.1% of each other)
  const ratio = peakFactor / minFactor;
  if (ratio < 1.001) {
    return { centerBin, peakFactor, minFactor, maxFactor: peakFactor, sigmaEstimate: 0, isUniform: true };
  }

  // Find 1-sigma point: where factor drops to ~60.65% of peak
  const threshold = peakFactor * Math.exp(-0.5); // ~60.65% of peak

  // Search right from center
  let sigmaRight = factors.length;
  for (let i = centerBin + 1; i < factors.length; i++) {
    if (factors[i] <= threshold) {
      // Interpolate between bins
      const prev = factors[i - 1];
      const curr = factors[i];
      const frac = (prev - threshold) / (prev - curr);
      sigmaRight = (i - 1 - centerBin) + frac;
      break;
    }
  }

  // Search left from center
  let sigmaLeft = factors.length;
  for (let i = centerBin - 1; i >= 0; i--) {
    if (factors[i] <= threshold) {
      const prev = factors[i + 1];
      const curr = factors[i];
      const frac = (prev - threshold) / (prev - curr);
      sigmaLeft = (centerBin - i - 1) + frac;
      break;
    }
  }

  // Average left and right sigma estimates
  const sigmaEstimate = (sigmaLeft + sigmaRight) / 2;

  return { centerBin, peakFactor, minFactor, maxFactor: peakFactor, sigmaEstimate, isUniform: false };
}

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("prod");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const provider = ethers.provider;
  const core = new ethers.Contract(coreAddr, CORE_ABI, provider);

  console.log("============================================================");
  console.log("  Signals Protocol — Citrea Mainnet Status");
  console.log("  " + new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
  console.log("  Core: " + coreAddr);
  console.log("============================================================\n");

  // ---- Vault State ----
  const [nav, price, pricePeak, drawdown, shares, seeded, capitalStack] = await Promise.all([
    core.getVaultNav(),
    core.getVaultPrice(),
    core.getVaultPricePeak(),
    core.getVaultDrawdown(),
    core.getVaultShares(),
    core.isVaultSeeded(),
    core.getCapitalStack(),
  ]);

  const [backstopNav, treasuryNav] = capitalStack;

  console.log("--- LP Vault ---");
  console.log(`  NAV:            ${fmtWad(nav)}`);
  console.log(`  Share Price:    ${fmtWadPrecise(price)}`);
  console.log(`  Peak Price:     ${fmtWadPrecise(pricePeak)}`);
  console.log(`  Drawdown:       ${(Number(drawdown) / 1e16).toFixed(2)}%`);
  console.log(`  Total Shares:   ${fmtWadPrecise(shares)}`);
  console.log(`  Vault Seeded:   ${seeded}`);
  console.log(`  Backstop NAV:   ${fmtWad(backstopNav)}`);
  console.log(`  Treasury NAV:   ${fmtWad(treasuryNav)}`);

  // Contract token balance
  const paymentAddr = await core.paymentToken();
  const payment = new ethers.Contract(paymentAddr, ERC20_ABI, provider);
  const bal = await payment.balanceOf(coreAddr);
  console.log(`  Contract Bal:   $${(Number(bal) / 1e6).toFixed(2)} (ctUSD 6-dec)`);

  // ---- Batch Info ----
  const currentBatch = Number(await core.getCurrentBatchId());
  const now = Math.floor(Date.now() / 1000);
  const todayBatch = Math.floor((now - BATCH_OFFSET) / 86400);

  console.log(`\n--- Batches ---`);
  console.log(`  Current processed: ${currentBatch}`);
  console.log(`  Today's batch:     ${todayBatch}`);
  console.log(`  Batches behind:    ${todayBatch - currentBatch}`);

  // Show last 5 batches with data
  console.log(`\n  Recent batch P&L:`);
  for (let bid = currentBatch; bid >= Math.max(0, currentBatch - 10); bid--) {
    try {
      const r = await core.getDailyPnl(BigInt(bid));
      const lt = r[0] as bigint;
      const ftot = r[1] as bigint;
      const processed = r[6] as boolean;
      if (lt !== 0n || ftot !== 0n || processed) {
        const net = lt + ftot;
        const batchStart = bid * 86400 + BATCH_OFFSET;
        const date = tsDate(batchStart);
        const ltStr = `Lt=${Number(lt) >= 0 ? "+" : ""}$${(Number(lt) / 1e18).toFixed(2)}`;
        const ftotStr = `Fees=$${(Number(ftot) / 1e18).toFixed(2)}`;
        const netStr = `Net=${Number(net) >= 0 ? "+" : ""}$${(Number(net) / 1e18).toFixed(2)}`;
        console.log(`    ${date} (${bid}): ${ltStr}, ${ftotStr}, ${netStr} ${processed ? "[processed]" : "[pending]"}`);
      }
    } catch {}
  }

  // ---- Markets ----
  const nextId = Number(await core.nextMarketId());
  const totalMarkets = nextId - 1;
  const NUM_RECENT = 10;
  const startId = Math.max(1, nextId - NUM_RECENT);

  console.log(`\n--- Markets (${startId}-${nextId - 1} of ${totalMarkets} total) ---`);

  // Track unique seedData addresses for analysis
  const seedDataMap = new Map<string, { marketIds: number[]; numBins: number }>();

  for (let id = startId; id < nextId; id++) {
    try {
      const m = await core.markets(BigInt(id));
      if (Number(m.numBins) === 0) continue;

      const end = Number(m.endTimestamp);
      const alpha = Number(m.liquidityParameter) / 1e18;
      const minTick = Number(m.minTick);
      const maxTick = Number(m.maxTick);
      const spacing = Number(m.tickSpacing);
      const numBins = Number(m.numBins);
      const fees = Number(m.accumulatedFees) / 1e18;
      const deltaEt = Number(m.deltaEt) / 1e18;
      const remaining = end - now;

      let status: string;
      if (m.settled) status = "SETTLED";
      else if (m.failed) status = "FAILED";
      else if (now < Number(m.startTimestamp)) status = "PENDING";
      else if (now < end) status = "ACTIVE";
      else status = "EXPIRED";

      console.log(`\n  Market #${id} [${status}]`);
      console.log(`    Alpha:       ${alpha.toFixed(2)} WAD`);
      console.log(`    Ticks:       ${minTick} - ${maxTick} (spacing ${spacing})`);
      console.log(`    Bins:        ${numBins}`);
      console.log(`    Price Range: $${minTick.toLocaleString()} - $${maxTick.toLocaleString()}`);
      console.log(`    Fees:        $${fees.toFixed(2)}`);
      console.log(`    DeltaEt:     $${deltaEt.toFixed(6)} ${deltaEt > 0 ? "(bell curve)" : "(uniform)"}`);
      console.log(`    Start:       ${tsShort(Number(m.startTimestamp))}`);
      console.log(`    End:         ${tsShort(end)}`);

      if (status === "ACTIVE") {
        console.log(`    Remaining:   ${(remaining / 3600).toFixed(1)}h`);
      }
      if (m.settled) {
        console.log(`    Settle Tick: ${Number(m.settlementTick)}`);
        console.log(`    Settle Val:  ${Number(m.settlementValue)}`);
      }
      console.log(`    SeedData:    ${m.seedData}`);
      console.log(`    FeePolicy:   ${m.feePolicy}`);

      // Track seedData for analysis
      const seedAddr = m.seedData as string;
      if (!seedDataMap.has(seedAddr)) {
        seedDataMap.set(seedAddr, { marketIds: [], numBins });
      }
      seedDataMap.get(seedAddr)!.marketIds.push(id);

    } catch (e: any) {
      console.log(`\n  Market #${id}: ERROR - ${e.message?.slice(0, 80)}`);
    }
  }

  // ---- SeedData Analysis ----
  console.log(`\n\n--- SeedData Analysis ---`);
  console.log(`  Unique seed contracts: ${seedDataMap.size}`);

  for (const [addr, info] of seedDataMap) {
    console.log(`\n  SeedData ${addr}`);
    console.log(`    Used by markets: ${info.marketIds.join(", ")}`);

    const factors = await readSeedFactors(provider, addr);
    if (factors.length === 0) {
      console.log(`    No code at address`);
      continue;
    }

    console.log(`    Factors count: ${factors.length} (expected ${info.numBins} bins)`);

    const stats = estimateSigma(factors);

    if (stats.isUniform) {
      console.log(`    Type:         UNIFORM (all factors = ${stats.peakFactor.toFixed(6)} WAD)`);
    } else {
      console.log(`    Type:         BELL CURVE`);
      console.log(`    Center bin:   ${stats.centerBin} (of ${factors.length})`);
      console.log(`    Peak factor:  ${stats.peakFactor.toFixed(6)} WAD`);
      console.log(`    Min factor:   ${stats.minFactor.toFixed(6)} WAD`);
      console.log(`    Peak/Min:     ${(stats.peakFactor / stats.minFactor).toFixed(1)}x`);
      console.log(`    Sigma est:    ${stats.sigmaEstimate.toFixed(2)} bins`);

      // Show ASCII bell curve
      const maxBar = 40;
      console.log(`\n    Factor distribution:`);
      for (let i = 0; i < factors.length; i++) {
        const barLen = Math.round((factors[i] / stats.peakFactor) * maxBar);
        const bar = "#".repeat(barLen);
        const marker = i === stats.centerBin ? " <-- center" : "";
        console.log(`      [${String(i).padStart(3)}] ${factors[i].toFixed(4).padStart(8)} ${bar}${marker}`);
      }
    }
  }

  console.log(`\n============================================================`);
  console.log(`  Done. ${totalMarkets} total markets, nextMarketId = ${nextId}`);
  console.log(`============================================================`);
}

main().catch(console.error);
