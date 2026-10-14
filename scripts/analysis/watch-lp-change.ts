// Watch the LP NAV change across short market cycles (local EVM, real v2 contracts,
// time fast-forwarded). Each market: open positions -> settle -> process batch ->
// print LP NAV before/after. This is the full cycle the live daily-batch can't show
// same-day.
//
// Run: npx hardhat run scripts/analysis/watch-lp-change.ts
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../test/helpers/fullSystem";
import { deploySeedData } from "../../test/helpers";
import { uniformFactors, toBatchId, batchStartTimestamp, advancePastBatchEnd } from "../../test/helpers/constants";
import { authorisedWallets, buildRedstonePayload, submitWithPayload } from "../../test/helpers/redstone";

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const MIN = 700, MAX = 1100, SP = 5, N = 80, ANCHOR = 40; // $7.00–$11.00, anchor $9.00
const ALPHA = ethers.parseEther("2000");
const REFRESH = new ethers.Interface(["function refreshTradeOracle(uint256 marketId)"]);
const DP = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: 20000n * 1_000_000n, anchorCenterBin: ANCHOR };
const f = (x: bigint) => Number(ethers.formatUnits(x, 18));

async function main() {
  const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
  const { owner, users, core, payment } = sys;
  const coreAddr = await core.getAddress();
  const fee = await (await ethers.getContractFactory("MockFeePolicy")).deploy(100);
  const feeAddr = await fee.getAddress();

  const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
  await payment.connect(owner).approve(coreAddr, ethers.MaxUint256);
  await time.setNextBlockTimestamp(Number(seedTime));
  await core.connect(owner).seedVault(100_000_000_000n); // 100,000 vault (so alpha=2000 < alphaLimit)
  for (const t of users.slice(0, 3)) { await payment.transfer(t.address, 200_000_000_000n); await payment.connect(t).approve(coreAddr, ethers.MaxUint256); }

  const refresh = async (id: bigint, hp: number) => {
    const ts = await time.latest();
    const payload = buildRedstonePayload(hp, ts - 1, authorisedWallets);
    await owner.sendTransaction({ to: coreAddr, data: REFRESH.encodeFunctionData("refreshTradeOracle", [id]) + payload.replace(/^0x/, "") });
  };
  const buy = async (who: any, id: bigint, bin: number, units: number) => {
    const lo = MIN + bin * SP, hi = lo + SP, q = BigInt(units) * 1_000_000n;
    const c = await core.calculateOpenCost.staticCall(id, lo, hi, q);
    await core.connect(who).openPosition(id, lo, hi, q, c * 3n + 5_000_000n, { gasLimit: 12_000_000 });
    return Number(c) / 1e6;
  };

  console.log(`Starting LP vault NAV: $${f(await core.getVaultNav.staticCall()).toFixed(2)}  (price $${f(await core.getVaultPrice.staticCall()).toFixed(4)})\n`);
  console.log("mkt  flow                       settleBin   premiums   payout    L_t      NAV before -> after");

  // a few short markets; vary where settlement lands relative to the crowd's bets
  // crowd always bets at-money (~bin 40); settlement is where price actually lands.
  // realistic: price usually drifts off the exact bin (LP wins), occasionally hits (LP loses).
  const scenarios = [
    { winBin: 55, label: "price drifts up   (crowd misses)" },
    { winBin: 30, label: "price drifts down (crowd misses)" },
    { winBin: 40, label: "price stays       (crowd HITS)  " },
    { winBin: 60, label: "price drifts up   (crowd misses)" },
    { winBin: 33, label: "price drifts down (crowd misses)" },
  ];

  for (let i = 0; i < scenarios.length; i++) {
    const { winBin, label } = scenarios[i];
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    const id: bigint = await core.createMarketDynamic.staticCall(...args, DP);
    await core.createMarketDynamic(...args, DP);
    while (!(await core.markets(id)).isSeeded) await core.seedNextChunks(id, 50);

    await time.increaseTo(Number(start) + 50);
    await refresh(id, MIN + ANCHOR * SP); // oracle at the money
    // the "crowd" bets at-money (where the oracle is)
    await buy(users[0], id, ANCHOR, 200);
    await buy(users[1], id, ANCHOR + 1, 150);
    await buy(users[2], id, ANCHOR - 1, 150);

    const navBefore = f(await core.getVaultNav.staticCall());
    // settle
    await time.setNextBlockTimestamp(Number(tSet + 2n));
    await submitWithPayload(core, owner, id, buildRedstonePayload(MIN + winBin * SP, Number(tSet + 1n), authorisedWallets));
    await time.setNextBlockTimestamp(Number(tSet + 12n));
    await core.connect(owner).finalizePrimarySettlement(id);
    const batchId = toBatchId(tSet);
    await advancePastBatchEnd(batchId);
    await core.processDailyBatch(batchId);
    const navAfter = f(await core.getVaultNav.staticCall());

    const dp = await core.getDailyPnl.staticCall(batchId);
    const lt = f(dp[0]), ftot = f(dp[1]);
    const m = await core.markets(id);
    console.log(
      `${String(i).padStart(3)}  ${label.padEnd(28)} ${String(winBin).padStart(6)}    ${f(m.accumulatedPremiums).toFixed(2).padStart(8)}  ` +
      `${(f(m.accumulatedPremiums) - lt - 0).toFixed(0).padStart(6)}  ${lt.toFixed(2).padStart(7)}  $${navBefore.toFixed(2)} -> $${navAfter.toFixed(2)}  (${(navAfter-navBefore>=0?"+":"")}${(navAfter-navBefore).toFixed(2)})`
    );
  }
  console.log(`\nFinal LP vault NAV: $${f(await core.getVaultNav.staticCall()).toFixed(2)}  (price $${f(await core.getVaultPrice.staticCall()).toFixed(4)})`);
  console.log("Each row = one short market cycle: trades open, market settles, LP NAV updates.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
