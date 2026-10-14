import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Use a settled market with α=100 to check — market #45 (AVAX, 80 bins, α=100)
  // Actually let's just calculate theoretically and also probe the contract

  // Find an active or recent α=100 market
  // Market #49 was α=100, 80 bins, settled — let's check its final state
  // But we can't open positions on settled markets.

  // Let's just do the math:
  // MAX_FACTOR = 100 WAD. Initial factor = 1 WAD (uniform) or Gaussian.
  // Buy q units in a single bin → factor scales by exp(q/α)
  // Max: exp(q/α) = 100 → q = α × ln(100) = 100 × 4.605 = 460.5 WAD
  // Cost of buying 460.5 WAD in 1 bin: α × ln(Z_after/Z_before)
  // For 1 bin out of 80: Z_before ≈ 80 (uniform), Z_after = 79 + 100 = 179
  // Cost = 100 × ln(179/80) = 100 × 0.806 = $80.6

  // But what about spreading across ALL bins?
  // If we fill every bin to MAX_FACTOR:
  // Z_before = 80 (all factors = 1)
  // Z_after = 80 × 100 = 8000
  // Total cost = α × ln(8000/80) = 100 × ln(100) = 100 × 4.605 = $460.5

  // But that's the theoretical max if you could buy all bins to max.
  // In practice, each trade pushes specific bins.

  // Let's test empirically — create a fresh α=100 market and keep buying until it breaks
  // Actually, let's just calculate the max cost for progressively larger quantities on different ranges

  console.log("=== Theoretical Max Volume (α=100, 80 bins) ===\n");
  console.log("MAX_FACTOR = 100 WAD, initial factor = 1 WAD (uniform)\n");

  const alpha = 100;
  const numBins = 80;

  // Single bin max
  const singleBinMaxQty = alpha * Math.log(100); // WAD units
  const singleBinZ0 = numBins;
  const singleBinZ1 = (numBins - 1) + 100;
  const singleBinCost = alpha * Math.log(singleBinZ1 / singleBinZ0);
  console.log(`Single bin to MAX_FACTOR:`);
  console.log(`  Max qty: ${singleBinMaxQty.toFixed(1)} WAD`);
  console.log(`  Cost: $${singleBinCost.toFixed(2)}\n`);

  // Fill N bins to max
  for (const n of [1, 2, 5, 10, 20, 40, 80]) {
    const z0 = numBins; // all factors = 1
    const z1 = (numBins - n) + n * 100; // n bins at 100, rest at 1
    const cost = alpha * Math.log(z1 / z0);
    console.log(`Fill ${n} bins to MAX: Z ${z0}→${z1}, cost = $${cost.toFixed(2)}`);
  }

  // Now let's also check with Gaussian prior (σ=8)
  console.log("\n=== With Gaussian Prior (σ=8, center bin) ===\n");
  const centerBin = 40;
  let z0_gauss = 0;
  const factors: number[] = [];
  for (let i = 0; i < numBins; i++) {
    const d = i - centerBin;
    let f = Math.exp(-(d * d) / (2 * 8 * 8));
    if (f < 0.01) f = 0.01;
    if (f > 100) f = 100;
    factors.push(f);
    z0_gauss += f;
  }
  console.log(`Initial Z (Gaussian): ${z0_gauss.toFixed(2)}`);
  console.log(`Center bin factor: ${factors[centerBin].toFixed(4)}`);
  console.log(`Edge bin factor: ${factors[0].toFixed(4)}`);

  // Max capacity: fill center bin to 100
  const centerFactor = factors[centerBin]; // = 1.0
  const maxScale = 100 / centerFactor;
  const centerMaxQty = alpha * Math.log(maxScale);
  const z1_center = z0_gauss - centerFactor + 100;
  const centerCost = alpha * Math.log(z1_center / z0_gauss);
  console.log(`\nCenter bin to MAX: scale ${centerFactor.toFixed(2)}→100, qty=${centerMaxQty.toFixed(1)} WAD`);
  console.log(`Cost: $${centerCost.toFixed(2)}`);

  // Total if we fill ALL bins to max
  let z1_all = 0;
  for (const f of factors) {
    z1_all += Math.min(100, 100); // all at max
  }
  const allMaxCost = alpha * Math.log(z1_all / z0_gauss);
  console.log(`\nAll bins to MAX: cost = $${allMaxCost.toFixed(2)}`);

  // Now empirically test on a real market if possible
  // Check market #45 — how much volume did it accept?
  console.log("\n=== Empirical Data from Our Markets ===\n");
  for (const id of [45, 48, 49, 51]) {
    try {
      const m = await core.markets(BigInt(id));
      const a = Number(m.liquidityParameter) / 1e18;
      const fees = Number(m.accumulatedFees) / 1e18;
      const bins = Number(m.numBins);
      const maxLoss = a * Math.log(bins);
      console.log(`Market #${id}: α=${a.toFixed(0)}, bins=${bins}, fees=$${fees.toFixed(2)}, maxLoss=$${maxLoss.toFixed(0)}, positions=${m.openPositionCount}`);
    } catch {}
  }
}
main().catch(console.error);
