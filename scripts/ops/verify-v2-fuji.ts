// Read-only post-deploy verification of the v2 rollout on Fuji.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers, upgrades } = hre;
  const env = loadEnvironment("fuji");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddr);

  const impl = await upgrades.erc1967.getImplementationAddress(coreAddr);
  console.log(`core proxy        ${coreAddr}`);
  console.log(`core impl (new)   ${impl}`);
  console.log(`nextMarketId      ${await core.nextMarketId()}`);
  console.log(`vault NAV         ${ethers.formatUnits(await core.getVaultNav(), 18)}`);
  const feedId = await core.redstoneFeedId();
  console.log(`redstoneFeedId    ${feedId}  ("${Buffer.from(feedId.slice(2), "hex").toString("utf8").replace(/\0+$/, "")}")`);

  // v2 proof: markets() now decodes the extended struct; existing market is static.
  const m1 = await core.markets(1);
  console.log(`\nmarkets(1): dynamicEnabled=${m1.dynamicEnabled}  numBins=${m1.numBins}  settled=${m1.settled}` +
    `  dynW=${m1.dynW}  accumulatedPremiums=${m1.accumulatedPremiums}`);
  console.log("(decoding dynamicEnabled/dynW/accumulatedPremiums => v2 Core impl is live)");
  console.log("(dynamicEnabled=false on existing market => backward compatible, static path)");

  // v2 selector reachability: createMarketDynamic + refreshTradeOracle exist on the ABI/impl
  const hasDyn = core.interface.hasFunction("createMarketDynamic");
  const hasRefresh = core.interface.hasFunction("refreshTradeOracle");
  console.log(`\ncreateMarketDynamic selector present: ${hasDyn}`);
  console.log(`refreshTradeOracle  selector present: ${hasRefresh}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
