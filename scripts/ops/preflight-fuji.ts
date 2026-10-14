// Pre-flight: confirm the deployer is the Core owner (required for setModules/upgrade)
// and print current module + vault state before a v2 rollout.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddr);

  const net = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(deployer.address);
  const owner = await core.owner();
  const nextMarketId = await core.nextMarketId();

  console.log(`network chainId   ${net.chainId}`);
  console.log(`core proxy        ${coreAddr}`);
  console.log(`deployer          ${deployer.address}`);
  console.log(`deployer balance  ${ethers.formatEther(bal)} AVAX`);
  console.log(`core owner        ${owner}`);
  console.log(`deployer == owner ${owner.toLowerCase() === deployer.address.toLowerCase()}`);
  console.log(`nextMarketId      ${nextMarketId}`);
  try { console.log(`vault NAV         ${ethers.formatUnits(await core.getVaultNav(), 18)}`); } catch {}
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`\nWARNING: deployer is NOT the core owner. upgrade/setModules will revert.`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
