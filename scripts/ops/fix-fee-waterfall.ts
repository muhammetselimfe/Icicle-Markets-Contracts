/**
 * Fix Fee Waterfall configuration.
 *
 * Sets: LP=70%, Backstop=20%, Treasury=10%
 * Keeps rhoBS at current value (0.2 WAD).
 *
 * Usage:
 *   npx hardhat run scripts/ops/fix-fee-waterfall.ts --network fuji
 */
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const WAD = 10n ** 18n;

async function main() {
  const { ethers } = hre;
  const envData = loadEnvironment("fuji");
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy");

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);

  // Read current config
  const current = await core.getFeeWaterfallConfig();
  console.log("\nCurrent Fee Waterfall:");
  console.log(`  rhoBS: ${current.rhoBS}`);
  console.log(`  pdd:   ${current.pdd}`);
  console.log(`  phiLP: ${current.phiLP}`);
  console.log(`  phiBS: ${current.phiBS}`);
  console.log(`  phiTR: ${current.phiTR}`);

  // New values: LP=70%, BS=20%, TR=10%
  const rhoBS = current.rhoBS; // keep current
  const phiLP = (WAD * 70n) / 100n; // 0.7e18
  const phiBS = (WAD * 20n) / 100n; // 0.2e18
  const phiTR = (WAD * 10n) / 100n; // 0.1e18

  console.log("\nSetting new config:");
  console.log(`  rhoBS: ${rhoBS}`);
  console.log(`  phiLP: ${phiLP} (70%)`);
  console.log(`  phiBS: ${phiBS} (20%)`);
  console.log(`  phiTR: ${phiTR} (10%)`);
  console.log(`  sum:   ${phiLP + phiBS + phiTR} (should be ${WAD})`);

  // Dry-run
  await core.setFeeWaterfallConfig.staticCall(rhoBS, phiLP, phiBS, phiTR);
  console.log("Static call OK");

  // Execute
  const tx = await core.setFeeWaterfallConfig(rhoBS, phiLP, phiBS, phiTR);
  await tx.wait();
  console.log(`tx: ${tx.hash}`);

  // Verify
  const updated = await core.getFeeWaterfallConfig();
  console.log("\nUpdated Fee Waterfall:");
  console.log(`  rhoBS: ${updated.rhoBS}`);
  console.log(`  pdd:   ${updated.pdd}`);
  console.log(`  phiLP: ${updated.phiLP} (${(Number(updated.phiLP) * 100 / 1e18).toFixed(0)}%)`);
  console.log(`  phiBS: ${updated.phiBS} (${(Number(updated.phiBS) * 100 / 1e18).toFixed(0)}%)`);
  console.log(`  phiTR: ${updated.phiTR} (${(Number(updated.phiTR) * 100 / 1e18).toFixed(0)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
