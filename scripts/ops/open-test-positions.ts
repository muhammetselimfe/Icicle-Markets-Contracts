/**
 * Open test positions across 3 markets.
 *
 * Usage:
 *   npx hardhat run scripts/ops/open-test-positions.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

interface MarketJob {
  marketId: number;
  name: string;
  count: number;
  qtyBase: bigint; // base quantity in 6-dec
}

const JOBS: MarketJob[] = [
  // AVAX: 100 done already
  { marketId: 17, name: "WTI", count: 60, qtyBase: 50_000_000n },   // ~$50 base qty
  { marketId: 18, name: "XAU", count: 100, qtyBase: 50_000_000n },  // ~$50 base qty
];

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const usdc = await ethers.getContractAt("IERC20", envData.contracts.PaymentToken);

  // Approve
  const allowance = await usdc.allowance(deployer.address, coreAddress);
  if (allowance < 50_000_000_000n) {
    console.log("Approving 50,000 USDC...");
    const tx = await usdc.approve(coreAddress, 50_000_000_000n);
    await tx.wait();
  }

  for (const job of JOBS) {
    console.log(`\n=== ${job.name} Market #${job.marketId} (${job.count} positions) ===`);

    const market = await core.markets(job.marketId);
    const minTick = Number(market.minTick);
    const maxTick = Number(market.maxTick);
    const spacing = Number(market.tickSpacing);
    const numBins = Number(market.numBins);
    const center = minTick + Math.floor(numBins / 2) * spacing;

    console.log(`  Range: ${minTick}–${maxTick}, spacing=${spacing}, center=${center}`);

    let opened = 0;
    let failed = 0;

    for (let i = 0; i < job.count; i++) {
      // Generate tick range: mix of narrow, medium, and wide
      let lower: number, upper: number, qty: bigint;

      const mod = i % 5;
      if (mod === 0) {
        // Single bin near center
        const offset = ((i / 5 | 0) - job.count / 10) * spacing;
        lower = center + offset;
        upper = lower + spacing;
        qty = job.qtyBase / 3n; // smaller for single bin
      } else if (mod === 1) {
        // 2-3 bins near center
        const width = (2 + (i % 2)) * spacing;
        const offset = ((i / 5 | 0) - job.count / 10) * spacing * 2;
        lower = center + offset;
        upper = lower + width;
        qty = job.qtyBase / 2n;
      } else if (mod === 2) {
        // 5-8 bins spread across range
        const width = (5 + (i % 4)) * spacing;
        const frac = i / job.count;
        lower = minTick + Math.floor(frac * (numBins - 10) * spacing / spacing) * spacing;
        upper = lower + width;
        qty = job.qtyBase;
      } else if (mod === 3) {
        // Wide 10-15 bins
        const width = (10 + (i % 6)) * spacing;
        const frac = i / job.count;
        lower = minTick + Math.floor(frac * (numBins - 20) * spacing / spacing) * spacing;
        upper = lower + width;
        qty = job.qtyBase * 3n / 2n;
      } else {
        // Full-width tail bets
        const width = (15 + (i % 10)) * spacing;
        const frac = (i % 20) / 20;
        lower = minTick + Math.floor(frac * (numBins - 25) * spacing / spacing) * spacing;
        upper = lower + width;
        qty = job.qtyBase * 2n;
      }

      // Clamp
      lower = Math.max(minTick, lower);
      upper = Math.min(maxTick, upper);
      if (upper <= lower) upper = lower + spacing;
      if (upper > maxTick) { lower = maxTick - spacing; upper = maxTick; }

      // Align
      lower = Math.floor(lower / spacing) * spacing;
      upper = Math.ceil(upper / spacing) * spacing;
      if (lower < minTick) lower = minTick;
      if (upper > maxTick) upper = maxTick;
      if (upper <= lower) continue;

      try {
        const maxCost = qty * 3n + 5_000_000n; // generous buffer
        const tx = await core.openPosition(job.marketId, lower, upper, qty, maxCost);
        await tx.wait();
        opened++;

        if (opened % 10 === 0) {
          console.log(`  ${opened}/${job.count} opened`);
        }
      } catch (err: any) {
        failed++;
        if (failed <= 3) {
          const reason = err.reason || err.message || "";
          console.error(`  Failed [${lower}–${upper}, qty=${qty}]: ${reason.slice(0, 80)}`);
        }
      }
    }

    console.log(`  Done: ${opened} opened, ${failed} failed`);
  }

  // Summary
  for (const id of [16, 17, 18]) {
    const m = await core.markets(id);
    console.log(`Market #${id}: ${m.openPositionCount} positions`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
