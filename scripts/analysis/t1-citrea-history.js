// T1: Reconstruct the live Signals (Citrea mainnet) LP history.
// Read-only. Pulls per-batch P&L (L_t, fees) and per-market settlement data
// directly from the deployed contract, then computes the LP NAV trajectory and
// the fee-coverage ratio psi = fees / losses.
//
// Run: node scripts/analysis/t1-citrea-history.js
// Writes: scripts/analysis/out/t1-citrea.json  (+ console summary)
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.PROD_RPC_URL || "https://rpc.mainnet.citrea.xyz";
const CORE = "0x516312275875932ec2B53A41df4De02743131729";
const OUT_DIR = path.join(__dirname, "out");

const ABI = [
  "function nextMarketId() view returns (uint256)",
  "function getVaultNav() view returns (uint256)",
  "function getVaultShares() view returns (uint256)",
  "function getVaultPrice() view returns (uint256)",
  "function getVaultPricePeak() view returns (uint256)",
  "function getVaultDrawdown() view returns (uint256)",
  "function getCurrentBatchId() view returns (uint64)",
  "function getCapitalStack() view returns (uint256 backstopNav, uint256 treasuryNav)",
  // getDailyPnl returns the per-batch snapshot
  "function getDailyPnl(uint64 batchId) view returns (int256 lt, uint256 ftot, uint256 ft, uint256 gt, uint256 npre, uint256 pe, bool processed)",
];

const W = 10n ** 18n;
const num = (x, d = 18) => Number(ethers.formatUnits(x, d));
const sgn = (x) => (x < 0n ? "-" : "");

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 250 * (i + 1))); }
  }
  throw last;
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const c = new ethers.Contract(CORE, ABI, provider);

  const nextMarketId = Number(await c.nextMarketId());
  const currentBatch = Number(await c.getCurrentBatchId());
  const navNow = await c.getVaultNav();
  const sharesNow = await c.getVaultShares();
  const priceNow = await c.getVaultPrice();
  const peak = await c.getVaultPricePeak();
  const dd = await c.getVaultDrawdown();
  const cap = await c.getCapitalStack();

  console.log("=== LIVE SIGNALS CONTRACT (Citrea mainnet 4114) ===");
  console.log(`address        ${CORE}`);
  console.log(`markets created ${nextMarketId}`);
  console.log(`current batch   ${currentBatch}`);
  console.log(`NAV now         ${num(navNow).toFixed(4)}`);
  console.log(`shares now      ${num(sharesNow).toFixed(4)}`);
  console.log(`price now       ${num(priceNow).toFixed(6)}  (peak ${num(peak).toFixed(6)})`);
  console.log(`drawdown        ${(num(dd) * 100).toFixed(2)}%`);
  console.log(`backstop        ${num(cap[0]).toFixed(4)}    treasury ${num(cap[1]).toFixed(4)}`);

  // --- Scan batches for processed daily P&L snapshots ---
  // 141 markets over daily batches => scan a generous window back from current.
  const SCAN = 600;
  const startBatch = Math.max(0, currentBatch - SCAN);
  console.log(`\nScanning batches ${startBatch}..${currentBatch} for processed snapshots...`);

  const batches = [];
  const ids = [];
  for (let b = startBatch; b <= currentBatch; b++) ids.push(b);

  // concurrency-limited fetch
  const CONC = 12;
  for (let i = 0; i < ids.length; i += CONC) {
    const chunk = ids.slice(i, i + CONC);
    const res = await Promise.all(chunk.map((b) => withRetry(() => c.getDailyPnl(b)).then((r) => ({ b, r })).catch(() => null)));
    for (const item of res) {
      if (!item) continue;
      const { b, r } = item;
      const processed = r[6];
      const lt = r[0]; // int256
      const ftot = r[1];
      if (!processed) continue;
      // skip empty batches (no P&L and no fees)
      if (lt === 0n && ftot === 0n && r[4] === 0n) continue;
      batches.push({
        batchId: b,
        lt: lt.toString(),
        ftot: ftot.toString(),
        ft: r[2].toString(),
        gt: r[3].toString(),
        npre: r[4].toString(),
        pe: r[5].toString(),
        lt_n: num(lt),
        ftot_n: num(ftot),
        ft_n: num(r[2]),
        gt_n: num(r[3]),
        npre_n: num(r[4]),
        pe_n: num(r[5]),
      });
    }
    process.stdout.write(`\r  scanned ${Math.min(i + CONC, ids.length)}/${ids.length}  found ${batches.length}`);
  }
  console.log("");

  batches.sort((a, b) => a.batchId - b.batchId);

  // --- Aggregate economics ---
  let sumLt = 0, sumLoss = 0, sumProfit = 0, sumFees = 0, sumGrant = 0;
  let lossBatches = 0, profitBatches = 0;
  for (const x of batches) {
    sumLt += x.lt_n;
    sumFees += x.ftot_n;
    sumGrant += x.gt_n;
    if (x.lt_n < 0) { sumLoss += -x.lt_n; lossBatches++; }
    else if (x.lt_n > 0) { sumProfit += x.lt_n; profitBatches++; }
  }
  const psiFees = sumLoss > 0 ? sumFees / sumLoss : Infinity; // fee coverage of gross losses
  const psiFeesNet = sumLoss > 0 ? sumFees / Math.max(sumLoss - sumProfit, 1e-9) : Infinity;

  console.log("\n=== AGGREGATE LP ECONOMICS (processed batches) ===");
  console.log(`processed batches   ${batches.length}  (loss ${lossBatches} / profit ${profitBatches})`);
  console.log(`sum L_t (CLMSR PnL) ${sumLt.toFixed(4)}`);
  console.log(`  gross losses      ${sumLoss.toFixed(4)}  (batches where L_t<0)`);
  console.log(`  gross profits     ${sumProfit.toFixed(4)}  (batches where L_t>0)`);
  console.log(`total fees (Ftot)   ${sumFees.toFixed(4)}`);
  console.log(`backstop grants     ${sumGrant.toFixed(4)}`);
  console.log(`psi_fee = fees/gross_loss      ${psiFees.toFixed(3)}   (need >= 1 for fees to cover losses)`);
  console.log(`psi_fee = fees/net_loss        ${psiFeesNet.toFixed(3)}`);

  // NAV trajectory (using npre as recorded pre-batch NAV, and pe batch price)
  if (batches.length) {
    const first = batches[0], last = batches[batches.length - 1];
    console.log("\n=== NAV / PRICE TRAJECTORY ===");
    console.log(`first batch ${first.batchId}: NAV~${first.npre_n.toFixed(2)}  price~${first.pe_n.toFixed(6)}`);
    console.log(`last  batch ${last.batchId}: NAV~${last.npre_n.toFixed(2)}  price~${last.pe_n.toFixed(6)}`);
  }

  // --- sample of worst/representative batches ---
  const worst = [...batches].sort((a, b) => a.lt_n - b.lt_n).slice(0, 10);
  console.log("\n=== 10 WORST BATCHES (by L_t) ===");
  console.log("batch    L_t        fees      grant     price(pe)");
  for (const x of worst) {
    console.log(`${String(x.batchId).padEnd(8)} ${x.lt_n.toFixed(3).padStart(9)} ${x.ftot_n.toFixed(3).padStart(9)} ${x.gt_n.toFixed(3).padStart(9)} ${x.pe_n.toFixed(6).padStart(10)}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    meta: { address: CORE, chain: 4114, nextMarketId, currentBatch, fetchedAt: new Date().toISOString?.() || null },
    snapshot: {
      navNow: num(navNow), sharesNow: num(sharesNow), priceNow: num(priceNow),
      pricePeak: num(peak), drawdownPct: num(dd) * 100,
      backstop: num(cap[0]), treasury: num(cap[1]),
    },
    aggregate: { sumLt, sumLoss, sumProfit, sumFees, sumGrant, lossBatches, profitBatches, psiFees, psiFeesNet, processedBatches: batches.length },
    batches,
  };
  // strip the Date.now usage that throws in some sandboxes
  try { out.meta.fetchedAt = new Date().toISOString(); } catch { out.meta.fetchedAt = null; }
  fs.writeFileSync(path.join(OUT_DIR, "t1-citrea.json"), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path.join(OUT_DIR, "t1-citrea.json")}`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
