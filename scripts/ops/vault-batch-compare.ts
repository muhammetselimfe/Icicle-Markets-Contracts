/**
 * Read vault state before/after batch processing.
 * Usage: npx hardhat run scripts/ops/vault-batch-compare.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

const WAD = 10n ** 18n;

function fmt6(val: bigint, label?: string): string {
  const sign = val < 0n ? "-" : "";
  const abs = val < 0n ? -val : val;
  const dollars = abs / 1_000_000n;
  const cents = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  const result = `${sign}$${dollars.toString()}.${cents}`;
  return label ? `${label}: ${result}` : result;
}

function fmtWad(val: bigint, label?: string): string {
  const sign = val < 0n ? "-" : "";
  const abs = val < 0n ? -val : val;
  const dollars = abs / WAD;
  const frac = (abs % WAD) / (WAD / 100n);
  const result = `${sign}$${dollars.toString()}.${frac.toString().padStart(2, "0")}`;
  return label ? `${label}: ${result}` : result;
}

interface VaultState {
  nav: bigint;
  shares: bigint;
  price: bigint;
  pricePeak: bigint;
  backstop: bigint;
  treasury: bigint;
  balance: bigint;
  batchId: bigint;
}

async function readVaultState(core: any, paymentToken: any, coreAddr: string): Promise<VaultState> {
  const nav = await core.getVaultNav();
  const shares = await core.getVaultShares();
  const price = await core.getVaultPrice();
  const pricePeak = await core.getVaultPricePeak();
  const [backstop, treasury] = await core.getCapitalStack();
  const balance = await paymentToken.balanceOf(coreAddr);
  const batchId = await core.currentBatchId();
  return { nav, shares, price, pricePeak, backstop, treasury, balance, batchId };
}

function printVaultState(label: string, s: VaultState) {
  console.log(`\n  --- ${label} ---`);
  console.log(`  ${fmtWad(s.nav, "Vault NAV")}`);
  console.log(`  ${fmtWad(s.shares, "Vault shares")}`);
  console.log(`  Share price: ${(Number(s.price) / 1e18).toFixed(6)} WAD`);
  console.log(`  Peak price:  ${(Number(s.pricePeak) / 1e18).toFixed(6)} WAD`);
  const drawdown = s.pricePeak > 0n && s.price < s.pricePeak
    ? Number(WAD - (s.price * WAD) / s.pricePeak) / 1e16
    : 0;
  console.log(`  Drawdown: ${drawdown.toFixed(2)}%`);
  console.log(`  ${fmtWad(s.backstop, "Backstop NAV")}`);
  console.log(`  ${fmtWad(s.treasury, "Treasury NAV")}`);
  console.log(`  ${fmt6(s.balance, "Contract USDC balance")}`);
  console.log(`  Current batch ID: ${s.batchId}`);
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy!;

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress, deployer);

  const paymentAddr = await core.paymentToken();
  const paymentToken = await ethers.getContractAt("IERC20", paymentAddr, deployer);

  console.log("=".repeat(60));
  console.log("VAULT STATE & BATCH PROCESSING");
  console.log("=".repeat(60));

  // Read before
  const before = await readVaultState(core, paymentToken, coreAddress);
  printVaultState("BEFORE BATCH", before);

  // Process batches
  let batchesProcessed = 0;
  let currentBatchId = before.batchId;

  while (true) {
    const nextBatchId = currentBatchId + 1n;
    const [total, resolved] = await core.getBatchMarketState(nextBatchId);

    if (total === 0n) {
      console.log(`\n  Batch ${nextBatchId}: no markets assigned, stopping.`);
      break;
    }

    if (resolved !== total) {
      console.log(`\n  Batch ${nextBatchId}: ${resolved}/${total} resolved, not ready.`);
      break;
    }

    console.log(`\n  Processing batch ${nextBatchId} (${total} markets, all resolved)...`);
    const tx = await core.processDailyBatch(nextBatchId);
    await tx.wait();
    console.log(`    tx: ${tx.hash}`);
    currentBatchId = nextBatchId;
    batchesProcessed++;
  }

  if (batchesProcessed === 0) {
    console.log("\n  No batches processed.");
    return;
  }

  // Read after
  const after = await readVaultState(core, paymentToken, coreAddress);
  printVaultState("AFTER BATCH", after);

  // Comparison
  console.log(`\n  --- BEFORE/AFTER COMPARISON ---`);
  const navDelta = after.nav - before.nav;
  const shareDelta = after.shares - before.shares;
  const backstopDelta = after.backstop - before.backstop;
  const treasuryDelta = after.treasury - before.treasury;
  const balanceDelta = after.balance - before.balance;

  console.log(`  ${fmtWad(navDelta, "NAV change")}`);
  console.log(`  ${fmtWad(shareDelta, "Shares change")}`);
  console.log(`  Price change: ${((Number(after.price) - Number(before.price)) / 1e18).toFixed(6)} WAD`);
  console.log(`  ${fmtWad(backstopDelta, "Backstop change")}`);
  console.log(`  ${fmtWad(treasuryDelta, "Treasury change")}`);
  console.log(`  ${fmt6(balanceDelta, "USDC balance change")}`);
  console.log(`  Batches processed: ${batchesProcessed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
