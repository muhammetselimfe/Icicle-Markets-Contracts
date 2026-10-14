// Manual UUPS upgrade of the Core proxy to v2 — bypasses the OZ plugin dedup that
// mis-fired via forceImport. Deploys the v2 impl, VERIFIES its bytecode contains the
// new selectors BEFORE pointing the proxy at it, then upgradeToAndCall as owner.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

const DYN_SIG = "createMarketDynamic(int256,int256,int256,uint64,uint64,uint64,uint32,uint256,address,address,(uint256,uint256,uint256,uint256,uint256,uint128,uint32))";
const REF_SIG = "refreshTradeOracle(uint256)";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreProxy = env.contracts.IcicleOptionsCoreProxy;
  const [deployer] = await ethers.getSigners();

  // 1) deploy v2 impl
  console.log("[manual-upgrade] deploying v2 IcicleOptionsCore impl...");
  const factory = await ethers.getContractFactory("IcicleOptionsCore");
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`[manual-upgrade] new impl deployed at ${implAddr}`);

  // 2) verify bytecode has v2 selectors BEFORE touching the proxy
  const code = await ethers.provider.getCode(implAddr);
  const dynSel = ethers.id(DYN_SIG).slice(2, 10);
  const refSel = ethers.id(REF_SIG).slice(2, 10);
  console.log(`[manual-upgrade] createMarketDynamic in bytecode: ${code.includes(dynSel)}`);
  console.log(`[manual-upgrade] refreshTradeOracle  in bytecode: ${code.includes(refSel)}`);
  if (!code.includes(dynSel) || !code.includes(refSel)) {
    throw new Error("ABORT: deployed impl is missing v2 selectors — not upgrading.");
  }

  // 3) upgrade the proxy (UUPS, onlyOwner)
  const core = await ethers.getContractAt("IcicleOptionsCore", coreProxy);
  console.log("[manual-upgrade] calling upgradeToAndCall...");
  const tx = await core.upgradeToAndCall(implAddr, "0x");
  const rcpt = await tx.wait();
  console.log(`[manual-upgrade] upgraded. tx=${rcpt?.hash}`);

  // 4) confirm the proxy now runs v2
  const impl2 = await ethers.provider.getStorageAt(
    coreProxy, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" // ERC1967 impl slot
  );
  console.log(`[manual-upgrade] proxy impl slot now -> 0x${impl2.slice(26)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
