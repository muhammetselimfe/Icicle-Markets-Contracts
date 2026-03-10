import hre from "hardhat";
import fs from "fs";
import path from "path";

function resolveEnvName(): string {
  const raw = (process.env.ENV || process.env.TARGET_ENV || hre.network.name || "dev").trim();
  return raw === "hardhat" ? "local" : raw;
}

const envName = resolveEnvName();
const envPath = path.resolve(__dirname, `../environments/${envName}.json`);
const env = JSON.parse(fs.readFileSync(envPath, "utf8"));

const MARKET_ID = 7n;
const SETTLEMENT_VALUE = 90432661822n; // 6 decimals

async function main() {
  const core = await hre.ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const before = await core.markets(MARKET_ID);
  console.log("[settle-secondary] before", {
    settled: before.settled,
    failed: before.failed,
    settlementValue: before.settlementValue.toString(),
    settlementTick: before.settlementTick.toString(),
  });

  const currentBatchId = await core.getCurrentBatchId();
  console.log("[settle-secondary] currentBatchId", currentBatchId.toString());

  await core.finalizeSecondarySettlement.staticCall(MARKET_ID, SETTLEMENT_VALUE);
  const tx = await core.finalizeSecondarySettlement(MARKET_ID, SETTLEMENT_VALUE);
  console.log("[settle-secondary] tx", tx.hash);
  await tx.wait();

  const after = await core.markets(MARKET_ID);
  console.log("[settle-secondary] after", {
    settled: after.settled,
    failed: after.failed,
    settlementValue: after.settlementValue.toString(),
    settlementTick: after.settlementTick.toString(),
    settlementFinalizedAt: after.settlementFinalizedAt.toString(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
