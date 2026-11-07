import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";


async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const paymentAddr = await core.paymentToken();
  const usdc = await ethers.getContractAt("IERC20", paymentAddr);

  // ============================================================
  // 1. Check batch status
  // ============================================================
  const currentBatchId = Number(await core.getCurrentBatchId());
  const BATCH_OFFSET = 28800;
  const now = Math.floor(Date.now() / 1000);
  const currentTimeBatch = Math.floor((now - BATCH_OFFSET) / 86400);
  console.log(`Current processed batch: ${currentBatchId}`);
  console.log(`Current time batch: ${currentTimeBatch}`);

  // Pre-batch vault state
  const lpShareAddr = env.contracts.IcicleOptionsLPShareProxy;
  const lpShare = await ethers.getContractAt("IcicleOptionsLPShare", lpShareAddr);
  const navBefore = await core.getVaultNav();
  const totalShares = await lpShare.totalSupply();
  const usdcBal = await usdc.balanceOf(core.target);
  console.log(`\n=== Pre-Batch Vault ===`);
  console.log(`  NAV: $${(Number(navBefore) / 1e18).toFixed(2)}`);
  console.log(`  Total Shares: ${(Number(totalShares) / 1e6).toFixed(4)}`);
  console.log(`  Core USDC balance: $${(Number(usdcBal) / 1e6).toFixed(2)}`);

  // ============================================================
  // 2. Process pending batches
  // ============================================================
  let batchesProcessed = 0;
  for (let batchId = currentBatchId + 1; batchId <= currentTimeBatch; batchId++) {
    console.log(`\n--- Processing batch ${batchId} ---`);

    try {
      const [total, resolved] = await core.getBatchMarketState(batchId);
      const marketCount = Number(total);
      const resolvedCount = Number(resolved);
      console.log(`  Markets: ${resolvedCount}/${marketCount} resolved`);

      if (marketCount === 0) {
        console.log(`  Empty batch - skipping to avoid pointer advance`);
        continue;
      }

      if (resolvedCount < marketCount) {
        console.log(`  Not all markets resolved - skipping`);
        continue;
      }

      const tx = await core.processDailyBatch(batchId, { gasLimit: 5_000_000 });
      const receipt = await tx.wait();
      console.log(`  Processed! Gas: ${receipt?.gasUsed}`);
      batchesProcessed++;
    } catch (e: any) {
      console.log(`  Failed: ${e.message?.slice(0, 200)}`);
    }
  }

  if (batchesProcessed === 0) {
    console.log("\nNo batches to process.");
  }

  // Post-batch vault state
  const navAfter = await core.getVaultNav();
  const navChange = Number(navAfter) - Number(navBefore);
  console.log(`\n=== Post-Batch Vault ===`);
  console.log(`  NAV: $${(Number(navAfter) / 1e18).toFixed(2)}`);
  console.log(`  NAV Change: ${navChange >= 0 ? '+' : ''}$${(navChange / 1e18).toFixed(2)}`);
  if (Number(navBefore) > 0) {
    console.log(`  NAV Change %: ${((navChange / Number(navBefore)) * 100).toFixed(4)}%`);
  }

  // ============================================================
  // 3. Analyze trader P&L for markets 52 and 53
  // ============================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TRADER P&L ANALYSIS`);
  console.log(`${'='.repeat(60)}`);

  let totalTraderCost = 0;
  let totalTraderPayout = 0;
  let totalPositions = 0;
  let winningPositions = 0;
  let losingPositions = 0;

  for (const marketId of [52, 53]) {
    const m = await core.markets(BigInt(marketId));
    const settlementTick = Number(m.settlementTick);
    const minTick = Number(m.minTick);
    const maxTick = Number(m.maxTick);
    const spacing = Number(m.tickSpacing);
    const alpha = Number(m.liquidityParameter) / 1e18;
    const fees = Number(m.accumulatedFees) / 1e18;

    console.log(`\n--- Market #${marketId} ---`);
    console.log(`  Range: ${minTick}-${maxTick}, spacing=${spacing}, bins=${m.numBins}`);
    console.log(`  Settlement tick: ${settlementTick} ($${(settlementTick / 100).toFixed(2)})`);
    console.log(`  Alpha: ${alpha} WAD`);
    console.log(`  Accumulated fees: $${fees.toFixed(4)}`);

    // Get positions via PositionOpened event topic from raw logs
    // event PositionOpened(uint256 indexed positionId, address indexed trader, uint256 indexed marketId, int256 lowerTick, int256 upperTick, uint128 quantity, uint256 cost)
    const eventSig = ethers.id("PositionOpened(uint256,address,uint256,int256,int256,uint128,uint256)");
    const marketTopic = ethers.zeroPadValue(ethers.toBeHex(marketId), 32);
    const latestBlock = await ethers.provider.getBlockNumber();
    // Query in 2000-block chunks to stay within Fuji RPC limit
    let logs: any[] = [];
    for (let from = latestBlock - 50000; from < latestBlock; from += 2000) {
      const to = Math.min(from + 1999, latestBlock);
      const chunk = await ethers.provider.getLogs({
        address: core.target,
        topics: [eventSig, null, null, marketTopic],
        fromBlock: from,
        toBlock: to,
      });
      logs = logs.concat(chunk);
    }
    console.log(`  Positions opened: ${logs.length}`);

    let marketTraderCost = 0;
    let marketTraderPayout = 0;

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    for (const log of logs) {
      const posId = Number(BigInt(log.topics[1]));
      const trader = ethers.getAddress("0x" + log.topics[2].slice(26));
      const decoded = abiCoder.decode(["int256", "int256", "uint128", "uint256"], log.data);
      const lowerTick = Number(decoded[0]);
      const upperTick = Number(decoded[1]);
      const quantity = Number(decoded[2]) / 1e6;
      const cost = Number(decoded[3]) / 1e6;

      const wins = settlementTick >= lowerTick && settlementTick < upperTick;
      const payout = wins ? quantity : 0;
      const pnl = payout - cost;

      totalPositions++;
      marketTraderCost += cost;
      if (wins) {
        winningPositions++;
        marketTraderPayout += payout;
      } else {
        losingPositions++;
      }

      const rangeStr = `$${(lowerTick/100).toFixed(2)}-$${(upperTick/100).toFixed(2)}`;
      console.log(`    #${posId} ${trader.slice(0,8)}.. [${rangeStr}] qty=${quantity.toFixed(2)} cost=$${cost.toFixed(4)} ${wins ? `WIN payout=$${payout.toFixed(2)}` : 'LOSS'} P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`);
    }

    const marketPnl = marketTraderPayout - marketTraderCost;
    console.log(`  Market trader totals: cost=$${marketTraderCost.toFixed(2)}, payout=$${marketTraderPayout.toFixed(2)}, P&L=${marketPnl >= 0 ? '+' : ''}$${marketPnl.toFixed(2)}`);
    totalTraderCost += marketTraderCost;
    totalTraderPayout += marketTraderPayout;
  }

  // ============================================================
  // 4. Summary
  // ============================================================
  const totalTraderPnl = totalTraderPayout - totalTraderCost;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\nTraders:`);
  console.log(`  Total positions: ${totalPositions} (${winningPositions} wins, ${losingPositions} losses)`);
  console.log(`  Total cost paid: $${totalTraderCost.toFixed(2)}`);
  console.log(`  Total payouts: $${totalTraderPayout.toFixed(2)}`);
  console.log(`  Net trader P&L: ${totalTraderPnl >= 0 ? '+' : ''}$${totalTraderPnl.toFixed(2)}`);
  console.log(`\nVault (LP):`);
  console.log(`  NAV before batch: $${(Number(navBefore) / 1e18).toFixed(2)}`);
  console.log(`  NAV after batch:  $${(Number(navAfter) / 1e18).toFixed(2)}`);
  console.log(`  NAV change: ${navChange >= 0 ? '+' : ''}$${(navChange / 1e18).toFixed(2)} (${((navChange / Number(navBefore)) * 100).toFixed(4)}%)`);
  console.log(`\nNote: Vault P&L = trader costs - trader payouts + fees`);
  console.log(`  Expected LP revenue: $${(totalTraderCost - totalTraderPayout).toFixed(2)} (from trading)`);
}

main().catch(console.error);
