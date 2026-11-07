import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const position = await ethers.getContractAt("IcicleOptionsPosition", env.contracts.IcicleOptionsPositionProxy!);

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // Check positions by owner
  const ids = await position.getPositionsByOwner(deployer.address);
  console.log("Positions owned by deployer:", ids.map((id: bigint) => id.toString()));

  // Check each position
  for (const pid of ids) {
    const pos = await position.getPosition(pid);
    console.log(`  Position #${pid}: market=${pos[1]}, lower=${pos[2]}, upper=${pos[3]}, qty=${pos[4]}, claimed=${pos[6]}`);
  }
}
main().catch(console.error);
