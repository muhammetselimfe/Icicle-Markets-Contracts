import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../helpers/fullSystem";
import { deploySeedData } from "../../helpers";
import { uniformFactors, toBatchId, batchStartTimestamp, advancePastBatchEnd } from "../../helpers/constants";
import { authorisedWallets, buildRedstonePayload, submitWithPayload } from "../../helpers/redstone";

// L1 blocking-gate tests for v2 dynamic pricing (LP test plan Part B).
const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const MIN = 700, MAX = 1100, SP = 5, N = 80, ANCHOR = 40;
const ALPHA = ethers.parseEther("100");
const PER_BIN_CAP_UNITS = 5000n;             // 5000 units max payout / bin
const REFRESH = new ethers.Interface(["function refreshTradeOracle(uint256 marketId)"]);
const DP = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: PER_BIN_CAP_UNITS * 1_000_000n, anchorCenterBin: ANCHOR };
const tk = (bin: number) => [MIN + bin * SP, MIN + (bin + 1) * SP] as const;

describe("v2 dynamic worst-case (L1 gates)", () => {
  async function setup() {
    const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
    const coreAddr = await sys.core.getAddress();
    const fee = await (await ethers.getContractFactory("MockFeePolicy")).deploy(100);
    const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
    await sys.payment.connect(sys.owner).approve(coreAddr, ethers.MaxUint256);
    await time.setNextBlockTimestamp(Number(seedTime));
    await sys.core.connect(sys.owner).seedVault(50_000_000_000n); // 50k
    for (const t of sys.users.slice(0, 3)) {
      await sys.payment.transfer(t.address, 200_000_000_000n);
      await sys.payment.connect(t).approve(coreAddr, ethers.MaxUint256);
    }
    return { ...sys, coreAddr, feeAddr: await fee.getAddress() };
  }
  // long trading window so staleness can be triggered inside it
  async function createDyn(core: any, feeAddr: string) {
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const tSet = base + 6000n, start = base + 1100n, end = base + 5000n;
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    const id = await core.createMarketDynamic.staticCall(...args, DP);
    await core.createMarketDynamic(...args, DP);
    while (!(await core.markets(id)).isSeeded) await core.seedNextChunks(id, 50);
    return { id, tSet, start, end };
  }
  async function refresh(core: any, signer: any, id: bigint, humanPrice: number) {
    const ts = await time.latest();
    const payload = buildRedstonePayload(humanPrice, ts - 1, authorisedWallets);
    await signer.sendTransaction({ to: await core.getAddress(), data: REFRESH.encodeFunctionData("refreshTradeOracle", [id]) + payload.replace(/^0x/, "") });
  }
  async function buy(core: any, who: any, id: bigint, bin: number, units: number) {
    const [lo, hi] = tk(bin);
    const q = BigInt(units) * 1_000_000n;
    const c = await core.calculateOpenCost.staticCall(id, lo, hi, q);
    await core.connect(who).openPosition(id, lo, hi, q, c * 3n + 5_000_000n, { gasLimit: 12_000_000 });
    return c;
  }
  async function settleAndBatch(core: any, owner: any, id: bigint, tSet: bigint, winBin: number) {
    await time.setNextBlockTimestamp(Number(tSet + 2n));
    const payload = buildRedstonePayload(MIN + winBin * SP, Number(tSet + 1n), authorisedWallets);
    await submitWithPayload(core, owner, id, payload);
    await time.setNextBlockTimestamp(Number(tSet + 12n));
    await core.connect(owner).finalizePrimarySettlement(id);
    const batchId = toBatchId(tSet);
    await advancePastBatchEnd(batchId);
    await core.processDailyBatch(batchId);
    return batchId;
  }

  // B3 — trade-path oracle staleness guard (S1, gap closed)
  it("B3: reverts dynamic trades when the cached oracle is stale", async () => {
    const { core, owner, users, feeAddr } = await setup();
    const { id, start } = await createDyn(core, feeAddr);
    const trader = users[0];
    // refresh, then let the oracle go stale (> maxSampleDistance=600s) within the window
    await time.increaseTo(Number(start) + 50);
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    await time.increaseTo(Number(start) + 50 + 700); // age 700 > 600
    const [lo, hi] = tk(ANCHOR);
    await expect(
      core.connect(trader).openPosition(id, lo, hi, 10_000_000n, ethers.MaxUint256, { gasLimit: 12_000_000 })
    ).to.be.revertedWithCustomError(core, "OracleStaleForTrade");
    // a fresh refresh re-enables trading
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    await expect(
      core.connect(trader).openPosition(id, lo, hi, 10_000_000n, ethers.MaxUint256, { gasLimit: 12_000_000 })
    ).to.not.be.reverted;
  });

  // B13 — realized-cash P&L reconciliation (S1, the critical v2 accounting change)
  it("B13: settlement L_t == premiums - proceeds - payout, and NAV change == L_t + LP fees", async () => {
    const { core, owner, users, feeAddr } = await setup();
    const { id, tSet, start } = await createDyn(core, feeAddr);
    const trader = users[0];
    await time.increaseTo(Number(start) + 50);
    await refresh(core, owner, id, MIN + ANCHOR * SP);

    // open 3 single-bin positions; only the one at winBin will pay out
    const winBin = ANCHOR;
    await buy(core, trader, id, winBin, 40);   // winner: 40 units
    await buy(core, trader, id, ANCHOR + 6, 30);
    await buy(core, trader, id, ANCHOR - 6, 20);

    const m = await core.markets(id);
    const premiums = m.accumulatedPremiums as bigint;
    const proceeds = m.accumulatedProceeds as bigint;
    expect(premiums).to.be.gt(0n);

    const navBefore = await core.getVaultNav.staticCall();
    const batchId = await settleAndBatch(core, owner, id, tSet, winBin);
    const navAfter = await core.getVaultNav.staticCall();

    const dp = await core.getDailyPnl.staticCall(batchId);
    const lt = dp[0] as bigint, ftot = dp[1] as bigint, ft = dp[2] as bigint, gt = dp[3] as bigint;

    // payout = winning position quantity (40 units) in WAD
    const payoutWad = 40n * 1_000_000n * 1_000_000_000_000n;
    const expectedLt = premiums - proceeds - payoutWad;
    // L_t reconciles to realized cash (allow tiny 6-dec rounding)
    expect(lt).to.be.closeTo(expectedLt, 10n ** 13n);
    // vault identity: ΔNAV == L_t + LP fees + grant (phiLP=100% so ft==ftot, gt==0)
    expect(navAfter - navBefore).to.be.closeTo(lt + ft + gt, 10n ** 13n);
  });

  // B9 — worst-case LP loss is bounded by the per-bin exposure cap (G2)
  it("B9: LP loss per market is bounded by perBinCap even when the loaded bin wins", async () => {
    const { core, owner, users, feeAddr } = await setup();
    const { id, tSet, start } = await createDyn(core, feeAddr);
    const trader = users[0];
    await time.increaseTo(Number(start) + 50);
    await refresh(core, owner, id, MIN + ANCHOR * SP);

    // load the at-money bin up toward the cap, then settle there (worst case for LP)
    const winBin = ANCHOR;
    await buy(core, trader, id, winBin, Number(PER_BIN_CAP_UNITS) - 100); // just under cap
    const batchId = await settleAndBatch(core, owner, id, tSet, winBin);
    const lt = (await core.getDailyPnl.staticCall(batchId))[0] as bigint;

    const capWad = PER_BIN_CAP_UNITS * 1_000_000n * 1_000_000_000_000n;
    expect(lt).to.be.lt(0n);                 // LP lost on this market
    expect(lt).to.be.gte(-capWad);           // ...but bounded by the cap (G2)
  });

  // B10 — mass claim: every winner can claim; payouts come from the reserve, no insolvency
  it("B10: all winning positions claim successfully after settlement", async () => {
    const { core, owner, users, position, payment, feeAddr } = await setup();
    const { id, tSet, start } = await createDyn(core, feeAddr);
    const traders = users.slice(0, 3);
    await time.increaseTo(Number(start) + 50);
    await refresh(core, owner, id, MIN + ANCHOR * SP);

    const winBin = ANCHOR;
    for (const t of traders) await buy(core, t, id, winBin, 15); // all winners
    await buy(core, traders[0], id, ANCHOR + 10, 15);            // a loser

    await settleAndBatch(core, owner, id, tSet, winBin);
    // claim delay (submit+ops = 10s) already passed via batch advance
    let totalPaid = 0n;
    for (const t of traders) {
      const ids = await position.getPositionsByOwner(t.address);
      for (const pid of ids) {
        const before = await payment.balanceOf(t.address);
        await expect(core.connect(t).claimPayout(pid)).to.not.be.reverted;
        totalPaid += (await payment.balanceOf(t.address)) - before;
      }
    }
    // three winners of 15 units each pay 15 USD each = 45; losers pay 0
    expect(totalPaid).to.equal(45_000_000n);
  });
});
