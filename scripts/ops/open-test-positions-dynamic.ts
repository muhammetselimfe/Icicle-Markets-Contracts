// Open test positions on a live DYNAMIC market (default 57) to exercise v2 pricing.
// Mints test USD to the deployer, then opens a spread of single-bin positions and
// reports per-bin cost (showing the bell: at-money > tails).
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const position = await ethers.getContractAt("IcicleOptionsPosition", env.contracts.IcicleOptionsPositionProxy);
  const [deployer] = await ethers.getSigners();
  const marketId = BigInt(process.env.MARKET_ID ?? "57");

  const m = await core.markets(marketId);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing);
  const oBin = Math.floor((Number(m.cachedOracleTick) - minTick) / sp);
  console.log(`market ${marketId}: dynamic=${m.dynamicEnabled} seeded=${m.isSeeded} oracleTick=${m.cachedOracleTick} ($${(Number(m.cachedOracleTick)/100).toFixed(2)}) oracleBin=${oBin}`);

  const dec = Number(await token.decimals());
  const fund = 100000n * 10n ** BigInt(dec);
  await (await token.mint(deployer.address, fund)).wait();
  await (await token.approve(await core.getAddress(), ethers.MaxUint256)).wait();
  console.log(`funded ${ethers.formatUnits(fund, dec)} test USD, approved core\n`);

  const bins = [oBin, oBin + 3, oBin - 3, oBin + 8, oBin - 8].map((b) => Math.max(0, Math.min(Number(m.numBins) - 1, b)));
  const q = 10_000_000n; // 10 units (6-dec)
  console.log("bin   priceRange         cost(10u)   $/unit    positionId");
  for (const bin of bins) {
    const lo = minTick + bin * sp, hi = lo + sp;
    let cost: bigint;
    try { cost = await core.calculateOpenCost.staticCall(marketId, lo, hi, q); }
    catch (e: any) { console.log(`${String(bin).padStart(3)}  quote failed: ${e.shortMessage || e.message}`); continue; }
    const maxCost = cost + cost / 2n + 2_000_000n;
    // explicit gasLimit: dynamic _executeBuy does ~160 getRangeSum reads (2x computeZeff),
    // so RPC gas estimation is flaky on this heavy tx (mainnet needs computeZeff optimization).
    await (await core.connect(deployer).openPosition(marketId, lo, hi, q, maxCost, { gasLimit: 12_000_000 })).wait();
    const ids = await position.getPositionsByOwner(deployer.address);
    const pid = ids[ids.length - 1];
    console.log(`${String(bin).padStart(3)}  $${(lo/100).toFixed(2)}-$${(hi/100).toFixed(2)}    ${ethers.formatUnits(cost,6).padStart(9)}   ${(Number(cost)/1e6/10).toFixed(4)}    #${pid}`);
  }

  const m2 = await core.markets(marketId);
  console.log(`\nmarket ${marketId} after: openPositions=${m2.openPositionCount}  accumulatedPremiums=${ethers.formatUnits(m2.accumulatedPremiums,18)}  accumulatedFees=${ethers.formatUnits(m2.accumulatedFees,18)}`);
  console.log("(at-money cost >> tail cost => dynamic bell live; premiums accruing to LP)");
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
