import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("prod");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  // Check fee policy on recent markets
  for (const id of [50, 51, 52]) {
    try {
      const m = await core.markets(BigInt(id));
      const feePolicy = m.feePolicy;
      console.log(`Market #${id}: feePolicy=${feePolicy}`);

      // Match against known policies
      const known: Record<string, string> = {
        [env.contracts.FeePolicyNull?.toLowerCase()]: "0bps",
        [env.contracts.FeePolicy10bps?.toLowerCase()]: "10bps",
        [env.contracts.FeePolicy50bps?.toLowerCase()]: "50bps",
        [env.contracts.FeePolicy100bps?.toLowerCase()]: "100bps",
        [env.contracts.FeePolicy200bps?.toLowerCase()]: "200bps",
      };
      const match = known[feePolicy.toLowerCase()];
      console.log(`  → ${match || "UNKNOWN"}`);
    } catch {}
  }

  // List all deployed fee policies
  console.log("\nDeployed fee policies:");
  for (const [name, addr] of Object.entries(env.contracts)) {
    if (name.includes("FeePolicy")) {
      console.log(`  ${name}: ${addr}`);
    }
  }
}
main().catch(console.error);
