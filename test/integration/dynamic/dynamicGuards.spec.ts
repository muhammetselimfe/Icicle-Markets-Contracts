import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../helpers/fullSystem";
import { deploySeedData } from "../../helpers";
import { uniformFactors, toBatchId, batchStartTimestamp } from "../../helpers/constants";
import { authorisedWallets, buildRedstonePayload } from "../../helpers/redstone";

// Regression tests for the two v2 hardening patches:
//   Patch A (#4/#3): trading is blocked until a GENUINE oracle refresh — creation no
//     longer seeds a "fresh" anchor, so the first trades can't price off a stale price.
//   Patch B (#2): createMarketDynamic validates DynamicParams at creation instead of
//     bricking/mispricing at first trade.
const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const MIN = 700, MAX = 1100, SP = 5, N = 80, ANCHOR = 40;
const ALPHA = ethers.parseEther("10");
const MIN_FACTOR = wad(0.01); // LazyMulSegmentTree.MIN_FACTOR
const REFRESH = new ethers.Interface(["function refreshTradeOracle(uint256 marketId)"]);
const DP = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: 1_000_000_000_000n, anchorCenterBin: ANCHOR };

describe("v2 dynamic guards (hardening regression)", () => {
  async function setup() {
    const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
    const coreAddr = await sys.core.getAddress();
    const fee = await (await ethers.getContractFactory("MockFeePolicy")).deploy(100);
    const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
    await sys.payment.connect(sys.owner).approve(coreAddr, ethers.MaxUint256);
    await time.setNextBlockTimestamp(Number(seedTime));
    await sys.core.connect(sys.owner).seedVault(10_000_000_000n);
    for (const t of sys.users.slice(0, 3)) {
      await sys.payment.transfer(t.address, 100_000_000_000n);
      await sys.payment.connect(t).approve(coreAddr, ethers.MaxUint256);
    }
    return { ...sys, coreAddr, feeAddr: await fee.getAddress() };
  }

  async function createDynamic(core: any, feeAddr: string, dp = DP) {
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    const id = await core.createMarketDynamic.staticCall(...args, dp);
    await core.createMarketDynamic(...args, dp);
    while (!(await core.markets(id)).isSeeded) await core.seedNextChunks(id, 50);
    return { id, start, tSet, end };
  }

  async function tryCreate(core: any, feeAddr: string, dp: any) {
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    return core.createMarketDynamic(...args, dp);
  }
  async function refresh(core: any, signer: any, id: bigint, humanPrice: number) {
    const ts = await time.latest();
    const payload = buildRedstonePayload(humanPrice, ts - 1, authorisedWallets);
    const data = REFRESH.encodeFunctionData("refreshTradeOracle", [id]) + payload.replace(/^0x/, "");
    await signer.sendTransaction({ to: await core.getAddress(), data });
  }
  const ticks = (bin: number) => [MIN + bin * SP, MIN + (bin + 1) * SP] as const;

  // --- Patch B (#2): DynamicParams validation at creation ---
  it("rejects w > WAD (would underflow centerWad and brick the market)", async () => {
    const { core, feeAddr } = await setup();
    await expect(tryCreate(core, feeAddr, { ...DP, w: WAD + 1n }))
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
  });
  it("rejects inverted sigma range (sigmaMin > sigmaMax)", async () => {
    const { core, feeAddr } = await setup();
    await expect(tryCreate(core, feeAddr, { ...DP, sigmaMinWad: 9n * WAD, sigmaMaxWad: 8n * WAD }))
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
  });
  it("rejects zero sigmaMin and zero volBins (degenerate bell)", async () => {
    const { core, feeAddr } = await setup();
    await expect(tryCreate(core, feeAddr, { ...DP, sigmaMinWad: 0n }))
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
    await expect(tryCreate(core, feeAddr, { ...DP, volBinsWad: 0n }))
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
  });
  it("rejects floor below tree MIN_FACTOR or >= WAD (>= WAD = degenerate uniform bell)", async () => {
    const { core, feeAddr } = await setup();
    await expect(tryCreate(core, feeAddr, { ...DP, floorWad: MIN_FACTOR - 1n }))
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
    await expect(tryCreate(core, feeAddr, { ...DP, floorWad: WAD })) // == WAD collapses the bell to uniform
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
    await expect(tryCreate(core, feeAddr, { ...DP, floorWad: WAD + 1n }))
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
  });
  it("rejects an out-of-range anchorCenterBin (no silent clamp)", async () => {
    const { core, feeAddr } = await setup();
    await expect(tryCreate(core, feeAddr, { ...DP, anchorCenterBin: N }))      // == numBins
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
    await expect(tryCreate(core, feeAddr, { ...DP, anchorCenterBin: N + 50 }))  // way out of range
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
  });
  it("initialize rejects maxSampleDistance == 0", async () => {
    let reverted = false;
    try { await deployFullSystem({ submitWindow: 5, opsWindow: 5, maxSampleDistance: 0 }); } catch { reverted = true; }
    expect(reverted).to.equal(true);
  });
  it("setBatchSeconds rejects out-of-range periods (< 60s, > 7 days)", async () => {
    const { core, owner } = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
    await expect(core.connect(owner).setBatchSeconds(30))
      .to.be.revertedWithCustomError(core, "BatchSecondsOutOfRange");
    await expect(core.connect(owner).setBatchSeconds(8 * 86400))
      .to.be.revertedWithCustomError(core, "BatchSecondsOutOfRange");
    await expect(core.connect(owner).setBatchSeconds(60)).to.not.be.reverted; // boundary OK
  });
  it("rejects perBinCap == 0 (would remove the hard payout/loss ceiling)", async () => {
    const { core, feeAddr } = await setup();
    await expect(tryCreate(core, feeAddr, { ...DP, perBinCap: 0n }))
      .to.be.revertedWithCustomError(core, "InvalidDynamicParams");
  });
  it("accepts valid params (boundary: floor == MIN_FACTOR, w == WAD)", async () => {
    const { core, feeAddr } = await setup();
    await expect(tryCreate(core, feeAddr, { ...DP, w: WAD, floorWad: MIN_FACTOR })).to.not.be.reverted;
  });

  // --- Patch A (#4/#3): no trading until a genuine oracle refresh ---
  it("blocks buys before any real oracle refresh (OracleNotInitializedForTrade)", async () => {
    const { core, users, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    const [lo, hi] = ticks(ANCHOR);
    // cachedOracleTs is 0 at creation -> the synthetic anchor is NOT treated as fresh
    expect((await core.markets(id)).cachedOracleTs).to.equal(0n);
    await expect(core.connect(users[0]).openPosition(id, lo, hi, 5_000_000n, ethers.MaxUint256))
      .to.be.revertedWithCustomError(core, "OracleNotInitializedForTrade");
  });
  it("view quotes/valuation degrade gracefully before any refresh (no revert)", async () => {
    const { core, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    const [lo, hi] = ticks(ANCHOR);
    // Read-only views must NOT revert when the oracle is uninitialized/stale, so portfolio
    // valuation keeps working while the keeper is behind. They return a number off the seeded
    // anchor; only EXECUTION is gated (asserted by the "blocks buys" test above).
    const cost = await core.calculateOpenCost.staticCall(id, lo, hi, 5_000_000n);
    expect(cost).to.be.greaterThan(0n);
  });

  it("rejects maxSampleDistance == 0 (would disable the trade-freshness gate)", async () => {
    const { core } = await setup();
    const feedId = ethers.encodeBytes32String("AVAX");
    await expect(core.setRedstoneConfig(feedId, 8, 0, 60))
      .to.be.revertedWithCustomError(core, "InvalidMaxSampleDistance");
  });

  it("position valuation survives a stale oracle (portfolio doesn't break when keeper lags)", async () => {
    const { core, owner, users, position, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    const trader = users[0];
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    const [lo, hi] = ticks(ANCHOR);
    const q = 5_000_000n;
    const c = await core.calculateOpenCost.staticCall(id, lo, hi, q);
    await core.connect(trader).openPosition(id, lo, hi, q, c * 2n + 2_000_000n);
    const ids = await position.getPositionsByOwner(trader.address);
    const pid = ids[ids.length - 1];
    // let the oracle go stale (keeper behind, past maxSampleDistance=600) — past the window too
    await time.increaseTo(Number(start) + 705);
    // valuation must still return a number (NOT revert), so the portfolio view keeps working
    const val = await core.calculatePositionValue.staticCall(pid);
    expect(val).to.be.greaterThan(0n);
  });
  // --- #1: setBatchSeconds anti-brick lock ---
  it("setBatchSeconds is settable before seed and locked once the vault is live", async () => {
    const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
    const { core, owner, payment } = sys;
    const coreAddr = await core.getAddress();
    // before seed: period is configurable
    await expect(core.connect(owner).setBatchSeconds(900)).to.not.be.reverted;
    // seed the vault (establishes currentBatchId on the current period)
    await payment.connect(owner).approve(coreAddr, ethers.MaxUint256);
    const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
    await time.setNextBlockTimestamp(Number(seedTime));
    await core.connect(owner).seedVault(10_000_000_000n);
    // after seed: locked (prevents the irreversible batch-id rescale brick)
    await expect(core.connect(owner).setBatchSeconds(1800)).to.be.revertedWithCustomError(core, "BatchPeriodLocked");
  });

  it("opens trading once a genuine refresh posts a real price", async () => {
    const { core, owner, users, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP); // real oracle price
    const [lo, hi] = ticks(ANCHOR);
    const q = 5_000_000n;
    const cost = await core.calculateOpenCost.staticCall(id, lo, hi, q);
    await expect(core.connect(users[0]).openPosition(id, lo, hi, q, cost * 2n + 2_000_000n)).to.not.be.reverted;
  });
});
