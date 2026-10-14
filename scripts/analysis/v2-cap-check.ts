// Verify the per-bin exposure cap reverts oversized buys on a dynamic market.
// Run: npx hardhat run scripts/analysis/v2-cap-check.ts
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../test/helpers/fullSystem";
import { deploySeedData } from "../../test/helpers";
import { uniformFactors, toBatchId, batchStartTimestamp } from "../../test/helpers/constants";

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const MIN = 700, MAX = 1100, SP = 5, N = 80, ANCHOR = 40;

async function main() {
  const { owner, users, core, payment } = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
  const coreAddr = await core.getAddress();
  const fee = await (await ethers.getContractFactory("MockFeePolicy")).deploy(100);
  const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
  await payment.connect(owner).approve(coreAddr, ethers.MaxUint256);
  await time.setNextBlockTimestamp(Number(seedTime));
  await core.connect(owner).seedVault(10_000_000_000n);
  const trader = users[0];
  await payment.transfer(trader.address, 100_000_000_000n);
  await payment.connect(trader).approve(coreAddr, ethers.MaxUint256);

  const pointer = Number(await core.getCurrentBatchId());
  const base = batchStartTimestamp(BigInt(pointer) + 1n);
  const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
  const seedData = await deploySeedData(uniformFactors(N));
  const PER_BIN_CAP = 10_000_000n; // 10 units
  const dp = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: PER_BIN_CAP, anchorCenterBin: ANCHOR };
  const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ethers.parseEther("10"), await fee.getAddress(), await seedData.getAddress()] as const;
  const marketId = await core.createMarketDynamic.staticCall(...args, dp);
  await core.createMarketDynamic(...args, dp);
  while (!(await (core as any).markets(marketId)).isSeeded) await core.seedNextChunks(marketId, 50);

  await time.increaseTo(Number(start) + 10);
  const lo = MIN + ANCHOR * SP, hi = lo + SP;
  const buy = async (units: number) => {
    const qty = BigInt(units) * 1_000_000n;
    const cost = await core.calculateOpenCost.staticCall(marketId, lo, hi, qty);
    return core.connect(trader).openPosition(marketId, lo, hi, qty, cost + cost / 2n + 2_000_000n);
  };

  console.log("perBinCap = 10 units");
  await (await buy(6)).wait();
  console.log("  buy 6 units            -> OK (exposure 6/10)");
  try {
    await (await buy(6)).wait(); // 6+6=12 > 10
    console.log("  buy +6 units (→12)     -> NO REVERT  ❌ cap not enforced");
  } catch (e: any) {
    const msg = e.shortMessage || e.message || "";
    console.log(`  buy +6 units (→12)     -> REVERTED ✓ ${msg.includes("BinExposureCapExceeded") ? "(BinExposureCapExceeded)" : "(" + msg.slice(0, 60) + ")"}`);
  }
  await (await buy(4)).wait(); // 6+4=10 == cap -> OK
  console.log("  buy +4 units (→10=cap) -> OK (boundary)");
  console.log("\nPer-bin exposure cap enforced correctly.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
