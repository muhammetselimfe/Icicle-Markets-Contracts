import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../helpers/fullSystem";
import { deploySeedData } from "../../helpers";
import { uniformFactors, toBatchId, batchStartTimestamp } from "../../helpers/constants";
import { authorisedWallets, buildRedstonePayload } from "../../helpers/redstone";

// v2.1 hardening (see v2-fixes-spec.md):
//   F1 tail-mass floor      F2 σ to settlement + trading cutoff      F3 trade staleness,
//   payload-attached refresh, price-jump breaker      F4 on-chain perBinCap sizing
const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const MIN = 700, MAX = 1100, SP = 5, N = 80, ANCHOR = 40;
const ALPHA = ethers.parseEther("10");
const REFRESH = new ethers.Interface(["function refreshTradeOracle(uint256 marketId)"]);
const DP = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.03), perBinCap: 1_000_000_000_000n, anchorCenterBin: ANCHOR };
const ticks = (bin: number) => [MIN + bin * SP, MIN + (bin + 1) * SP] as const;

// solidity-coverage instrumentation inflates gas use far past the fixed limits below
const gas = (n: number) => (process.env.COVERAGE ? n * 20 : n);

describe("v2.1 dynamic-pricing fixes", () => {
  async function setup() {
    const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
    const coreAddr = await sys.core.getAddress();
    const fee = await (await ethers.getContractFactory("MockFeePolicy")).deploy(100);
    const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
    await sys.payment.connect(sys.owner).approve(coreAddr, ethers.MaxUint256);
    await time.setNextBlockTimestamp(Number(seedTime));
    await sys.core.connect(sys.owner).seedVault(10_000_000_000n); // 10,000 USDC
    for (const t of sys.users.slice(0, 3)) {
      await sys.payment.transfer(t.address, 100_000_000_000n);
      await sys.payment.connect(t).approve(coreAddr, ethers.MaxUint256);
    }
    return { ...sys, coreAddr, feeAddr: await fee.getAddress() };
  }
  // dynamic market: [start, end] trading, settlement = end + cutoff
  async function createDynamic(core: any, feeAddr: string, opts: { dp?: any; cutoff?: number; duration?: number } = {}) {
    const dp = opts.dp ?? DP, cutoff = opts.cutoff ?? 0, duration = opts.duration ?? 600;
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const start = base + 1100n, tSet = start + BigInt(duration) + BigInt(cutoff), end = tSet - BigInt(cutoff);
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    const id = await core.createMarketDynamic.staticCall(...args, dp);
    await core.createMarketDynamic(...args, dp);
    while (!(await core.markets(id)).isSeeded) await core.seedNextChunks(id, 50);
    return { id, start, end, tSet };
  }
  async function refresh(core: any, signer: any, id: bigint, humanPrice: number, ts?: number) {
    const at = ts ?? (await time.latest());
    const payload = buildRedstonePayload(humanPrice, at - 1, authorisedWallets);
    await signer.sendTransaction({ to: await core.getAddress(), data: REFRESH.encodeFunctionData("refreshTradeOracle", [id]) + payload.replace(/^0x/, "") });
  }
  async function openWithPayload(core: any, trader: any, id: bigint, bin: number, q: bigint, humanPrice: number) {
    const [lo, hi] = ticks(bin);
    const payload = buildRedstonePayload(humanPrice, (await time.latest()) - 1, authorisedWallets);
    const data = core.interface.encodeFunctionData("openPosition", [id, lo, hi, q, ethers.MaxUint256]) + payload.replace(/^0x/, "");
    return trader.sendTransaction({ to: await core.getAddress(), data, gasLimit: gas(15_000_000) });
  }

  // ---------------- F1 ----------------
  it("F1: tail-mass floor keeps the tails at ~τ of prior mass and the modal bin near the Gaussian at every σ", async () => {
    const h = await (await ethers.getContractFactory("PricingLayerHarness")).deploy();
    const tau = wad(0.03);
    const tradeFactors = Array(N).fill(WAD);
    for (const s of [8, 4, 1.6, 1.0]) {
      const sigma = wad(s);
      const floor = await h.floorFromTau(tau, sigma, N);
      const centerW = BigInt(ANCHOR) * WAD;
      // sum of base factors and of floored bins
      let z = 0n, tail = 0n;
      for (let b = 0; b < N; b++) { const f: bigint = await h.bellFactor(b, centerW, sigma, floor); z += f; if (f === floor) tail += f; }
      const tailShare = Number(tail) / Number(z);
      expect(tailShare).to.be.lessThan(0.03 * 1.3 + 0.002); // ≈ τ (discretisation slack)
      const implied = Number(await h.impliedBinPrice(tradeFactors, ANCHOR, centerW, sigma, floor)) / 1e18;
      const gaussian = 1 / (s * Math.sqrt(2 * Math.PI)); // continuous modal mass per 1-bin width
      expect(Math.abs(implied / gaussian - 1)).to.be.lessThan(0.08);
    }
  });

  it("F1: with the legacy fixed floor the modal bin is ~3x too cheap at σ_min (the defect v2.1 removes)", async () => {
    const h = await (await ethers.getContractFactory("PricingLayerHarness")).deploy();
    const tradeFactors = Array(N).fill(WAD); const centerW = BigInt(ANCHOR) * WAD; const sigma = wad(0.75);
    const legacy = Number(await h.impliedBinPrice(tradeFactors, ANCHOR, centerW, sigma, wad(0.05))) / 1e18;
    const fixed = Number(await h.impliedBinPrice(tradeFactors, ANCHOR, centerW, sigma, await h.floorFromTau(wad(0.03), sigma, N))) / 1e18;
    expect(legacy).to.be.lessThan(0.2);
    expect(fixed).to.be.greaterThan(0.45);
  });

  // ---------------- F2 ----------------
  it("F2: σ is measured to settlement — an early cutoff does not collapse the bell (same quote as a no-cutoff market at the same instant)", async () => {
    const { core, owner, feeAddr } = await setup();
    // both markets settle at the same time; A trades until settlement, B closes 300s earlier
    const a = await createDynamic(core, feeAddr, { duration: 900, cutoff: 0 });
    const b = await createDynamic(core, feeAddr, { duration: 600, cutoff: 300 });
    expect(a.tSet).to.equal(b.tSet);
    await time.increaseTo(Number(b.end) - 5);
    await refresh(core, owner, a.id, MIN + ANCHOR * SP); await refresh(core, owner, b.id, MIN + ANCHOR * SP);
    const [lo, hi] = ticks(ANCHOR); const q = 5_000_000n;
    const qa = await core.calculateOpenCost.staticCall(a.id, lo, hi, q);
    const qb = await core.calculateOpenCost.staticCall(b.id, lo, hi, q);
    const diff = qa > qb ? qa - qb : qb - qa;
    expect(diff * 1000n / qa).to.be.lessThan(5n); // < 0.5 %
  });

  it("F2: minDynamicCutoff is enforced at creation", async () => {
    const { core, feeAddr } = await setup();
    await core.setDynamicGuards(0, 0, 0, 0, 600);
    await expect(createDynamic(core, feeAddr, { cutoff: 599 })).to.be.revertedWithCustomError(core, "DynamicCutoffTooShort");
    await expect(createDynamic(core, feeAddr, { cutoff: 600 })).to.not.be.reverted;
  });

  // ---------------- F3 ----------------
  it("F3b: tradeMaxStaleness gates trades independently of the settlement tolerance", async () => {
    const { core, owner, users, feeAddr } = await setup();
    await core.setDynamicGuards(30, 0, 0, 0, 0);
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    const [lo, hi] = ticks(ANCHOR);
    await core.connect(users[0]).openPosition(id, lo, hi, 1_000_000n, ethers.MaxUint256); // fresh: ok
    await time.increase(60); // 60s > 30s (but < maxSampleDistance 600s)
    await expect(core.connect(users[0]).openPosition(id, lo, hi, 1_000_000n, ethers.MaxUint256))
      .to.be.revertedWithCustomError(core, "OracleStaleForTrade");
  });

  it("F3a: a RedStone payload appended to openPosition refreshes the oracle atomically (trade prices against the attached price)", async () => {
    const { core, owner, users, feeAddr } = await setup();
    await core.setDynamicGuards(30, 0, 0, 0, 0);
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    await time.increase(120); // cache now stale for trades
    const before = await core.markets(id);
    const newTick = MIN + (ANCHOR + 3) * SP;
    await openWithPayload(core, users[0], id, ANCHOR + 3, 1_000_000n, newTick); // succeeds: payload refreshed first
    const after = await core.markets(id);
    expect(after.cachedOracleTick).to.equal(BigInt(newTick));
    expect(after.cachedOracleTs).to.be.greaterThan(before.cachedOracleTs);
    expect(after.openPositionCount).to.equal(1n);
  });

  it("F3c: price-jump breaker halts trading, operator resume and confirming-sample auto-resume both work", async () => {
    const { core, owner, users, feeAddr } = await setup();
    await core.setDynamicGuards(0, 300, 120, 0, 0); // 3 % within 120 s
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, 900);
    await time.increase(10);
    await refresh(core, owner, id, 950); // +5.5 % in 10 s -> halt
    expect((await core.markets(id)).tradingHalted).to.equal(true);
    const [lo, hi] = ticks(ANCHOR);
    await expect(core.connect(users[0]).openPosition(id, lo, hi, 1_000_000n, ethers.MaxUint256))
      .to.be.revertedWithCustomError(core, "TradingHalted");
    // operator resume
    await core.connect(owner).resumeTrading(id);
    expect((await core.markets(id)).tradingHalted).to.equal(false);
    await core.connect(users[0]).openPosition(id, lo, hi, 1_000_000n, ethers.MaxUint256);
    // halt again, then a confirming sample after the window auto-resumes
    await time.increase(10);
    await refresh(core, owner, id, 1010); // +6.3 %
    expect((await core.markets(id)).tradingHalted).to.equal(true);
    await time.increase(130);
    await refresh(core, owner, id, 1015); // within 3 % of the new level, after jumpWindow
    expect((await core.markets(id)).tradingHalted).to.equal(false);
  });

  // ---------------- F4 ----------------
  it("F4: perBinCap is sized against vault NAV on-chain", async () => {
    const { core, feeAddr } = await setup();
    await core.setDynamicGuards(0, 0, 0, 300, 0); // 3 % of 10,000 USDC = 300 units
    await expect(createDynamic(core, feeAddr, { dp: { ...DP, perBinCap: 301_000_000n } })).to.be.revertedWithCustomError(core, "PerBinCapTooLarge");
    await expect(createDynamic(core, feeAddr, { dp: { ...DP, perBinCap: 300_000_000n } })).to.not.be.reverted;
  });

  it("F4b: perBinCap is bounded by k·α when maxCapPerAlpha is set", async () => {
    const { core, feeAddr, users } = await setup();
    // disabled by default: a cap of 1,000,000 units on α = 10 is accepted (legacy behaviour)
    await expect(createDynamic(core, feeAddr)).to.not.be.reverted;
    await expect(core.connect(users[0]).setMaxCapPerAlpha(4)).to.be.reverted; // onlyOwner
    await expect(core.setMaxCapPerAlpha(101)).to.be.revertedWithCustomError(core, "InvalidCapPerAlpha");
    await expect(core.setMaxCapPerAlpha(4)).to.emit(core, "MaxCapPerAlphaUpdated").withArgs(4);
    // α = 10 → at most 40 payout units per bin
    await expect(createDynamic(core, feeAddr, { dp: { ...DP, perBinCap: 41_000_000n } }))
      .to.be.revertedWithCustomError(core, "PerBinCapTooLarge").withArgs(41_000_000n, 40_000_000n);
    await expect(createDynamic(core, feeAddr, { dp: { ...DP, perBinCap: 40_000_000n } })).to.not.be.reverted;
    // both guards set: the tighter one decides (NAV allows 300 units, α allows 40)
    await core.setDynamicGuards(0, 0, 0, 300, 0);
    await expect(createDynamic(core, feeAddr, { dp: { ...DP, perBinCap: 100_000_000n } })).to.be.revertedWithCustomError(core, "PerBinCapTooLarge");
    await core.setMaxCapPerAlpha(0); // off again → only the NAV cap applies
    await expect(createDynamic(core, feeAddr, { dp: { ...DP, perBinCap: 100_000_000n } })).to.not.be.reverted;
  });

  it("guards: setDynamicGuards validates its inputs", async () => {
    const { core } = await setup();
    await expect(core.setDynamicGuards(3, 0, 0, 0, 0)).to.be.revertedWithCustomError(core, "InvalidTradeStaleness");
    await expect(core.setDynamicGuards(0, 300, 0, 0, 0)).to.be.revertedWithCustomError(core, "InvalidJumpConfig");
    await expect(core.setDynamicGuards(0, 0, 0, 10_001, 0)).to.be.revertedWithCustomError(core, "InvalidCapBps");
    await expect(core.setDynamicGuards(0, 0, 0, 0, 86_401)).to.be.revertedWithCustomError(core, "InvalidDynamicCutoff");
    await expect(core.setDynamicGuards(90, 300, 120, 300, 900)).to.emit(core, "DynamicGuardsUpdated");
  });
});
