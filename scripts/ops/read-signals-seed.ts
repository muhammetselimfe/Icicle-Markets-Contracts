import hre from "hardhat";

async function main() {
  const { ethers } = hre;

  // Read SeedData contracts — packed uint256[] stored as contract code
  // Each uint256 = 32 bytes = one bin factor in WAD

  const seedAddresses: Record<string, string[]> = {
    "0xe10E8e170c61b0F598b86B8CDAC5d75f2f02b9d4": ["Market 4 (first bell)"],
    "0xA95abF54782Ff6D469CE7ECa8D8b994353E44A7c": ["Market 10"],
    "0x5512A8b7EC65185C3E77c5F906f130a7A0f7Ac91": ["Market 49"],
    "0xA4D4B4595851e9E426a83f80bc8Db7EF0eC2726E": ["Market 51 (latest)"],
  };

  for (const [addr, labels] of Object.entries(seedAddresses)) {
    console.log(`\n=== ${labels[0]} — SeedData ${addr} ===`);

    const code = await ethers.provider.getCode(addr);
    if (code === "0x") {
      console.log("  No code at address");
      continue;
    }

    // Each factor is 32 bytes (uint256)
    const data = code.slice(2); // remove 0x
    const numFactors = data.length / 64; // 64 hex chars = 32 bytes
    console.log(`  Bins: ${numFactors}`);

    const factors: number[] = [];
    let minFactor = Infinity;
    let maxFactor = 0;
    let minBin = 0;
    let maxBin = 0;

    for (let i = 0; i < numFactors; i++) {
      const hex = data.slice(i * 64, (i + 1) * 64);
      const factorWad = BigInt("0x" + hex);
      const factor = Number(factorWad) / 1e18;
      factors.push(factor);
      if (factor < minFactor) { minFactor = factor; minBin = i; }
      if (factor > maxFactor) { maxFactor = factor; maxBin = i; }
    }

    console.log(`  Min factor: ${minFactor.toFixed(6)} WAD (bin ${minBin})`);
    console.log(`  Max factor: ${maxFactor.toFixed(6)} WAD (bin ${maxBin})`);
    console.log(`  Ratio max/min: ${(maxFactor / minFactor).toFixed(1)}x`);
    console.log(`  Center bin: ${Math.floor(numFactors / 2)}`);

    // Show all factors
    console.log(`\n  Bin factors:`);
    for (let i = 0; i < numFactors; i++) {
      const bar = "█".repeat(Math.round(factors[i] / maxFactor * 30));
      console.log(`    [${String(i).padStart(2)}] ${factors[i].toFixed(6)} ${bar}`);
    }
  }
}
main().catch(console.error);
