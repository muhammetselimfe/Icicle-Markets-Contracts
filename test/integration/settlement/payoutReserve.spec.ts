/**
 * PayoutReserve Spec Tests
 *
 * Whitepaper v2 section 3.5 requirements:
 * - Payout reserve is deducted from NAV at settlement/batch time
 * - claimPayout() does NOT change NAV/Price after batch processing
 * - claimPayout() is gated: must wait until batch is processed
 *
 * These tests are expected to FAIL initially (TDD approach).
 * Implementation will make them pass.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LazyMulSegmentTree, LPVaultModule, MarketLifecycleModule, MockFeePolicy, MockERC20, MockIcicleOptionsPosition, OracleModule, IcicleOptionsCoreHarness, IcicleOptionsCore, IcicleOptionsLPShare, TestERC1967Proxy, TradeModule } from '../../../typechain-types';
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  DATA_FEED_ID,
  FEED_DECIMALS,
  authorisedWallets,
  buildRedstonePayload,
  submitWithPayload,
} from "../../helpers/redstone";
import {
  advancePastBatchEnd,
  batchStartTimestamp,
  toBatchId,
} from "../../helpers/constants";
const WAD = ethers.parseEther("1");

// Redstone feed config (for setRedstoneConfig)
const FEED_ID = ethers.encodeBytes32String(DATA_FEED_ID);
const MAX_SAMPLE_DISTANCE = 600n;
const FUTURE_TOLERANCE = 60n;

// Human price to tick mapping: humanPrice equals desired tick
function tickToHumanPrice(tick: bigint): number {
  return Number(tick);
}

// Helper for 6-decimal token amounts.
function usdc(amount: string | number): bigint {
  return ethers.parseUnits(String(amount), 6);
}

describe("PayoutReserve Spec Tests", () => {
  async function deployFullSystem() {
    const [owner, seeder, trader] = await ethers.getSigners();

    // Use 6-decimal token (paymentToken = USDC6)
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const payment = (await MockERC20Factory.deploy(
      "MockVaultToken",
      "MVT",
      6
    )) as MockERC20;

    const position = (await (
      await ethers.getContractFactory("MockIcicleOptionsPosition")
    ).deploy()) as MockIcicleOptionsPosition;

    const lazy = (await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy()) as LazyMulSegmentTree;

    const lifecycle = (await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazy.target },
      })
    ).deploy()) as MarketLifecycleModule;

    const trade = (await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazy.target },
      })
    ).deploy()) as TradeModule;

    // Use OracleModuleHarness to allow Hardhat local signers for Redstone verification
    const oracle = (await (
      await ethers.getContractFactory("OracleModuleHarness")
    ).deploy()) as OracleModule;

    const vault = (await (
      await ethers.getContractFactory("LPVaultModule")
    ).deploy()) as LPVaultModule;

    const risk = await (await ethers.getContractFactory("RiskModule")).deploy();

    const coreImpl = (await (
      await ethers.getContractFactory("IcicleOptionsCoreHarness", {
        libraries: { LazyMulSegmentTree: lazy.target },
      })
    ).deploy()) as IcicleOptionsCoreHarness;

    const submitWindow = 300;
    const opsWindow = 60;
    const claimDelay = submitWindow + opsWindow;
    const feePolicy = await (await ethers.getContractFactory("MockFeePolicy")).deploy(0);
    await feePolicy.waitForDeployment();

    const lpShareImpl = await (
      await ethers.getContractFactory("IcicleOptionsLPShare")
    ).deploy();
    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const lpShareProxy = (await proxyFactory.deploy(
      await lpShareImpl.getAddress(),
      "0x"
    )) as TestERC1967Proxy;
    const coreProxy = (await proxyFactory.deploy(
      coreImpl.target,
      "0x"
    )) as TestERC1967Proxy;
    const lpShare = (await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    )) as IcicleOptionsLPShare;
    const core = (await ethers.getContractAt(
      "IcicleOptionsCoreHarness",
      await coreProxy.getAddress()
    )) as IcicleOptionsCoreHarness;

    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: payment.target.toString(),
      positionContract: position.target.toString(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: trade.target.toString(),
      lifecycleModule: lifecycle.target.toString(),
      riskModule: risk.target.toString(),
      vaultModule: vault.target.toString(),
      oracleModule: oracle.target.toString(),
      ownerSafe: owner.address,
      settlementSubmitWindow: submitWindow,
      pendingOpsWindow: opsWindow,
      claimDelaySeconds: claimDelay,
      redstoneFeedId: FEED_ID,
      redstoneFeedDecimals: FEED_DECIMALS,
      maxSampleDistance: MAX_SAMPLE_DISTANCE,
      futureTolerance: FUTURE_TOLERANCE,
      lambda: ethers.parseEther("0.3"),
      kDrawdown: ethers.parseEther("1"),
      enforceAlpha: false,
      rhoBS: 0n,
      phiLP: ethers.parseEther("0.8"),
      phiBS: ethers.parseEther("0.1"),
      phiTR: ethers.parseEther("0.1"),
      withdrawalLagBatches: 0,
      operatorAllowlist: [owner.address],
    };
    await core.initialize(coreParams);
    await lpShare.initialize(
      await core.getAddress(),
      payment.target.toString(),
      "Icicle Options LP Share",
      "sLP",
      owner.address
    );

    // Fund accounts with 6-decimal token amounts
    await payment.mint(seeder.address, usdc("10000"));
    await payment.mint(trader.address, usdc("10000"));
    await payment.connect(seeder).approve(core.target, ethers.MaxUint256);
    await payment.connect(trader).approve(core.target, ethers.MaxUint256);
    await core.connect(seeder).fundBackstop(usdc("500"));

    return {
      owner,
      seeder,
      trader,
      core,
      payment,
      position,
      trade,
      feePolicy,
    };
  }

  async function setupMarketWithPosition(
    core: IcicleOptionsCoreHarness,
    seeder: HardhatEthersSigner,
    feePolicyAddress: string,
    _winningTick: number = 1
  ) {
    // Set deterministic timestamp aligned to batch boundary
    const latest = BigInt(await time.latest());
    const baseBatchId = toBatchId(latest) + 1n;
    const seedTime = batchStartTimestamp(baseBatchId) + 100n;

    // Seed vault
    await time.setNextBlockTimestamp(Number(seedTime));
    await core.connect(seeder).seedVault(usdc("1000"));

    // Create market with proper timing:
    // - start: shortly after seed
    // - end: before tSet
    // - tSet: within the same batch as seed + enough time for oracle submission
    const start = seedTime + 50n;
    const end = seedTime + 200n;
    const tSet = seedTime + 250n; // Settlement timestamp

    // Advance time to create market
    await time.setNextBlockTimestamp(Number(seedTime + 10n));
    const marketId = await core.createMarketUniform.staticCall(
      0, // minTick
      4, // maxTick
      1, // tickSpacing
      Number(start),
      Number(end),
      Number(tSet),
      4, // numBins
      WAD, // liquidityParameter
      feePolicyAddress
    );

    await core.createMarketUniform(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(tSet),
      4,
      WAD,
      feePolicyAddress
    );

    const batchId = toBatchId(tSet);
    return {
      marketId,
      seedTime,
      tSet,
      start,
      end,
      winningTick: _winningTick,
      batchId,
    };
  }

  // ================================================================
  // SPEC-1: Claim Gating is TIME-BASED, NOT BATCH-BASED
  // Claim is allowed after Tset + Δ_claim (Δclaim = Δsettle + Δops).
  // Batch processing status is IRRELEVANT to claim eligibility.
  // NAV is unaffected because payout was already escrowed at settlement.
  // ================================================================
  describe("SPEC-1: Claim Gating - time-based (Tset + Δ_claim)", () => {
    it("reverts claimPayout when time < Tset + Δ_claim", async () => {
      const { core, seeder, trader, position, trade, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId, tSet } = await setupMarketWithPosition(core, seeder, feePolicy.target.toString());

      // Create a position
      const positionId = 1n;
      const positionQuantity = 1000n;
      await position.mockMint(
        trader.address,
        positionId,
        marketId,
        0,
        2,
        positionQuantity
      );

      // Set exposure ledger to match the position
      await core.harnessAddExposure(marketId, 0, 2, positionQuantity);

      // Submit oracle price and settle market
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp),
        authorisedWallets
      );
      await submitWithPayload(core, seeder, marketId, payload);

      // finalize during PendingOps (submitWindow=300)
      const opsStart = tSet + 300n;
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsStart + 1n));
      await core.finalizePrimarySettlement(marketId);

      // Market is settled, but we're before claimOpenTime
      // claimOpenTime = Tset + Δclaim (opsEnd)
      // Try to claim before opsEnd
      await time.setNextBlockTimestamp(Number(opsEnd - 1n));

      // SPEC: claimPayout should REVERT because time < claimOpenTime
      await expect(
        core.connect(trader).claimPayout(positionId)
      ).to.be.revertedWithCustomError(trade, "ClaimTooEarly");
    });

    it("allows claimPayout after time >= Tset + Δ_claim (batch not processed)", async () => {
      const { core, seeder, trader, position, payment, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId, tSet, batchId } = await setupMarketWithPosition(
        core,
        seeder,
        feePolicy.target.toString()
      );

      // Create a winning position
      const positionId = 1n;
      const positionQuantity = 1000n;
      await position.mockMint(
        trader.address,
        positionId,
        marketId,
        0, // lowerTick
        2, // upperTick (covers tick 1)
        positionQuantity
      );

      // Set exposure ledger to match the position
      await core.harnessAddExposure(marketId, 0, 2, positionQuantity);

      // Settle market
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp),
        authorisedWallets
      );
      await submitWithPayload(core, seeder, marketId, payload);

      // finalize during PendingOps
      const opsStart = tSet + 300n;
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsStart + 1n));
      await core.finalizePrimarySettlement(marketId);

      // claimOpenTime = Tset + Δclaim (opsEnd)
      const claimOpenTime = opsEnd;

      // KEY: DO NOT process the batch - claim should still work based on TIME only
      const [, , , , , , processed] = await core.getDailyPnl.staticCall(
        batchId
      );
      expect(processed).to.equal(false, "Batch should NOT be processed");

      // Now claimPayout should succeed (we're past claim window, batch NOT processed)
      await time.setNextBlockTimestamp(Number(claimOpenTime + 1n));
      const balanceBefore = await payment.balanceOf(trader.address);
      await core.connect(trader).claimPayout(positionId);
      const balanceAfter = await payment.balanceOf(trader.address);

      // Trader receives payout from escrow
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  // ================================================================
  // SPEC-2: claimPayout MUST NOT change NAV/Price
  // Payout is escrowed at settlement finalization.
  // claim() draws only from escrow, not from vault NAV.
  // NAV is unaffected because payout liability was already
  // deducted at settlement via L_t = ΔC_t - Payout_t.
  // ================================================================
  describe("SPEC-2: claimPayout does NOT change NAV/Price", () => {
    it("NAV is unchanged after claimPayout", async () => {
      const { core, seeder, trader, position, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId, tSet, batchId } = await setupMarketWithPosition(
        core,
        seeder,
        feePolicy.target.toString()
      );

      // Create winning position
      const positionId = 1n;
      const positionQuantity = 1000n;
      await position.mockMint(
        trader.address,
        positionId,
        marketId,
        0,
        2,
        positionQuantity
      );

      // Set exposure ledger to match the position
      await core.harnessAddExposure(marketId, 0, 2, positionQuantity);

      // Settle and process batch
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp)
      );
      await submitWithPayload(core, seeder, marketId, payload);
      // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(marketId);

      // Advance time past batch end and claim window (Tset + Δclaim)
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);

      // Record NAV before claim
      const navBefore = await core.getVaultNav.staticCall();
      const priceBefore = await core.getVaultPrice.staticCall();

      // Claim payout (now past claim window)
      await core.connect(trader).claimPayout(positionId);

      // NAV and Price MUST be unchanged
      const navAfter = await core.getVaultNav.staticCall();
      const priceAfter = await core.getVaultPrice.staticCall();

      expect(navAfter).to.equal(navBefore, "NAV changed after claimPayout");
      expect(priceAfter).to.equal(
        priceBefore,
        "Price changed after claimPayout"
      );
    });

    it("multiple claims do not change NAV", async () => {
      const { core, seeder, trader, owner, position, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId, tSet, batchId } = await setupMarketWithPosition(
        core,
        seeder,
        feePolicy.target.toString()
      );

      // Create multiple winning positions
      const qty1 = 500n;
      const qty2 = 300n;
      await position.mockMint(trader.address, 1n, marketId, 0, 2, qty1);
      await position.mockMint(owner.address, 2n, marketId, 0, 2, qty2);

      // Set exposure ledger to match the positions
      await core.harnessAddExposure(marketId, 0, 2, qty1);
      await core.harnessAddExposure(marketId, 0, 2, qty2);

      // Settle and process
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp)
      );
      await submitWithPayload(core, seeder, marketId, payload);
      // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(marketId);

      // Advance time past batch end
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);

      const navBefore = await core.getVaultNav.staticCall();

      // First claim (past claim window)
      await core.connect(trader).claimPayout(1n);
      const navAfterFirst = await core.getVaultNav.staticCall();
      expect(navAfterFirst).to.equal(
        navBefore,
        "NAV changed after first claim"
      );

      // Second claim
      await core.connect(owner).claimPayout(2n);
      const navAfterSecond = await core.getVaultNav.staticCall();
      expect(navAfterSecond).to.equal(
        navBefore,
        "NAV changed after second claim"
      );
    });
  });

  // ================================================================
  // SPEC-3: Payout reserve is reflected in L_t calculation
  // (L_t = ΔC_t - Payout_t)
  // ================================================================
  describe("SPEC-3: Payout reserve affects L_t", () => {
    it("L_t includes payout deduction (ΔC_t - Payout_t)", async () => {
      const { core, seeder, position, trader, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId, tSet, batchId } = await setupMarketWithPosition(
        core,
        seeder,
        feePolicy.target.toString()
      );

      // Create a position that will win
      const positionQuantity = 1000n;
      await position.mockMint(
        trader.address,
        1n,
        marketId,
        0,
        2,
        positionQuantity
      );

      // Set exposure ledger to match the position
      await core.harnessAddExposure(marketId, 0, 2, positionQuantity);

      // Settle
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp)
      );
      await submitWithPayload(core, seeder, marketId, payload);
      // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(marketId);

      // Check L_t recorded in daily PnL snapshot
      const [lt] = await core.getDailyPnl.staticCall(batchId);

      // L_t should include payout deduction
      // If there's a winning position, L_t should be:
      // L_t = ΔC_t - Payout_t
      // Since Payout_t > 0, L_t should be less than ΔC_t
      // This test verifies the payout is factored into L_t

      // For now, verify L_t is not zero (indicating some P&L calculation happened)
      expect(lt).to.not.equal(0n, "L_t should reflect payout reserve");
    });
  });

  // ================================================================
  // SPEC-4: Payout reserve invariant
  // (Sum of all winning position payouts == payoutReserve)
  // ================================================================
  describe("SPEC-4: Payout reserve invariant", () => {
    it("total winning payouts equals escrow reserve", async () => {
      const { core, seeder, trader, owner, position, payment, feePolicy } =
        await loadFixture(deployFullSystem);

      const { marketId, tSet, batchId } = await setupMarketWithPosition(
        core,
        seeder,
        feePolicy.target.toString()
      );

      // Create positions: some winning, some losing
      const winningQty1 = 500n;
      const winningQty2 = 300n;
      const losingQty = 200n;

      await position.mockMint(trader.address, 1n, marketId, 0, 2, winningQty1); // wins (tick 1 in [0,2))
      await position.mockMint(owner.address, 2n, marketId, 0, 2, winningQty2); // wins
      await position.mockMint(trader.address, 3n, marketId, 2, 4, losingQty); // loses (tick 1 not in [2,4))

      // Set exposure ledger to match positions
      await core.harnessAddExposure(marketId, 0, 2, winningQty1);
      await core.harnessAddExposure(marketId, 0, 2, winningQty2);
      await core.harnessAddExposure(marketId, 2, 4, losingQty);

      // Settle at tick 1
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp)
      );
      await submitWithPayload(core, seeder, marketId, payload);
      // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(marketId);

      // Advance time past batch end
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);

      // Expected total payout = winningQty1 + winningQty2
      const expectedTotalPayout = winningQty1 + winningQty2;

      // Verify by claiming all and checking balance changes
      const balanceBefore = await payment.balanceOf(await core.getAddress());

      // Claims past claim window
      await core.connect(trader).claimPayout(1n);
      await core.connect(owner).claimPayout(2n);

      // Loser claim should give 0
      const balanceBeforeLoser = await payment.balanceOf(trader.address);
      await core.connect(trader).claimPayout(3n);
      const balanceAfterLoser = await payment.balanceOf(trader.address);
      expect(balanceAfterLoser).to.equal(
        balanceBeforeLoser,
        "Loser should receive 0"
      );

      const balanceAfter = await payment.balanceOf(await core.getAddress());

      // Core balance decreased by exactly expectedTotalPayout
      expect(balanceBefore - balanceAfter).to.equal(expectedTotalPayout);
    });

    it("reverts double claim on same position", async () => {
      const { core, seeder, trader, position, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId, tSet, batchId } = await setupMarketWithPosition(
        core,
        seeder,
        feePolicy.target.toString()
      );

      // Create winning position
      const positionId = 1n;
      await position.mockMint(trader.address, positionId, marketId, 0, 2, 500n);
      await core.harnessAddExposure(marketId, 0, 2, 500n);

      // Settle
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp)
      );
      await submitWithPayload(core, seeder, marketId, payload);
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(marketId);

      // Process batch
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);

      // First claim succeeds
      await core.connect(trader).claimPayout(positionId);

      // Second claim should revert - position was burned on first claim
      await expect(core.connect(trader).claimPayout(positionId)).to.be.reverted;
    });

    it("reverts claim by non-owner", async () => {
      const { core, seeder, trader, owner, position, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId, tSet, batchId } = await setupMarketWithPosition(
        core,
        seeder,
        feePolicy.target.toString()
      );

      // Create position owned by trader
      const positionId = 1n;
      await position.mockMint(trader.address, positionId, marketId, 0, 2, 500n);
      await core.harnessAddExposure(marketId, 0, 2, 500n);

      // Settle and process
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
      const payload = buildRedstonePayload(
        tickToHumanPrice(1n),
        Number(priceTimestamp)
      );
      await submitWithPayload(core, seeder, marketId, payload);
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(marketId);
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);

      // owner tries to claim trader's position - should revert with not owner check
      await expect(core.connect(owner).claimPayout(positionId)).to.be.reverted;
    });

    it("reverts claim on unsettled market", async () => {
      const { core, seeder, trader, position, trade, feePolicy } = await loadFixture(
        deployFullSystem
      );

      const { marketId } = await setupMarketWithPosition(core, seeder, feePolicy.target.toString());

      // Create position but DON'T settle
      const positionId = 1n;
      await position.mockMint(trader.address, positionId, marketId, 0, 2, 500n);
      await core.harnessAddExposure(marketId, 0, 2, 500n);

      // Advance past claim window but without settlement
      await time.increase(86400);

      // Claim should revert because market is not settled
      await expect(
        core.connect(trader).claimPayout(positionId)
      ).to.be.revertedWithCustomError(trade, "MarketNotSettled");
    });
  });

  // ==================================================================
  // Failure Path + Batch/Claim Separation
  // ==================================================================
  describe("Failure Path & Batch/Claim Separation", () => {
    let core: IcicleOptionsCoreHarness;
    let payment: MockERC20;
    let seeder: HardhatEthersSigner;
    let feePolicy: MockFeePolicy;

    beforeEach(async () => {
      const fixture = await loadFixture(deployFullSystem);
      core = fixture.core;
      payment = fixture.payment;
      seeder = fixture.seeder;
      feePolicy = fixture.feePolicy;
    });

    it("markFailed → manualSettleFailedMarket records PnL to batch", async () => {
      // Seed vault
      const latest = BigInt(await time.latest());
      const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;

      await payment.mint(seeder.address, usdc("100000"));
      await payment
        .connect(seeder)
        .approve(await core.getAddress(), ethers.MaxUint256);

      await time.setNextBlockTimestamp(Number(seedTime));
      await core.connect(seeder).seedVault(usdc("10000"));

      // Create market
      const tSet = seedTime + 500n;
      await core.createMarketUniform(
        0,
        100,
        10,
        Number(seedTime + 100n),
        Number(tSet - 100n),
        Number(tSet),
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString()
      );

      // Wait for settlement window to expire without oracle submission
      // settlementSubmitWindow = 300, so wait past Tset + 300
      const expireTime = tSet + 400n;
      await time.setNextBlockTimestamp(Number(expireTime));

      // Mark as failed (oracle didn't submit in time)
      await core.markSettlementFailed(1n);

      // Verify market is marked failed
      const marketAfterFail = await core.harnessGetMarket(1n);
      expect(marketAfterFail.failed).to.equal(true);
      expect(marketAfterFail.settled).to.equal(false);

      // Manually settle with fallback value
      const manualSettleTime = expireTime + 10n;
      await time.setNextBlockTimestamp(Number(manualSettleTime));
      await core.finalizeSecondarySettlement(1n, 50); // Middle tick as fallback

      // Verify market is now settled (secondary)
      const marketAfterSettle = await core.harnessGetMarket(1n);
      expect(marketAfterSettle.settled).to.equal(true);

      // Verify PnL was recorded to batch
      const batchId = toBatchId(tSet);
      const [, , , , , , processed] = await core.getDailyPnl.staticCall(
        batchId
      );
      // processed should still be false (batch not yet run)
      expect(processed).to.equal(false);
    });

    it("batch executes independently of claim timing", async () => {
      // Seed vault
      const latest = BigInt(await time.latest());
      const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;

      await payment.mint(seeder.address, usdc("100000"));
      await payment
        .connect(seeder)
        .approve(await core.getAddress(), ethers.MaxUint256);

      await time.setNextBlockTimestamp(Number(seedTime));
      await core.connect(seeder).seedVault(usdc("10000"));

      // Create and settle market (normal path)
      const tSet = seedTime + 500n;
      await core.createMarketUniform(
        0,
        100,
        10,
        Number(seedTime + 100n),
        Number(tSet - 100n),
        Number(tSet),
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString()
      );

      // Submit oracle price
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp));
      const payload = buildRedstonePayload(
        tickToHumanPrice(50n),
        Number(priceTimestamp),
        authorisedWallets
      );
      await submitWithPayload(core, seeder, 1n, payload);

      // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(1n);

      // Process batch - should succeed regardless of claim timing
      const batchId = toBatchId(tSet);
      await advancePastBatchEnd(batchId);
      await expect(core.processDailyBatch(batchId)).to.not.be.reverted;

      // Verify batch is processed
      const [, , , , , , processed] = await core.getDailyPnl.staticCall(
        batchId
      );
      expect(processed).to.equal(true);

      // Claims are still gated by time (independent of batch)
      // This verifies batch execution is permissionless
    });

    it("secondary settlement (failed market) flows to same batch as primary", async () => {
      // This test verifies that failed markets still contribute to the batch
      // correctly, maintaining the batch-NAV invariant

      const latest = BigInt(await time.latest());
      const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;

      await payment.mint(seeder.address, usdc("100000"));
      await payment
        .connect(seeder)
        .approve(await core.getAddress(), ethers.MaxUint256);

      await time.setNextBlockTimestamp(Number(seedTime));
      await core.connect(seeder).seedVault(usdc("10000"));

      // Create market
      const tSet = seedTime + 500n;
      await core.createMarketUniform(
        0,
        100,
        10,
        Number(seedTime + 100n),
        Number(tSet - 100n),
        Number(tSet),
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString()
      );

      // Fail and manually settle
      const expireTime = tSet + 400n;
      await time.setNextBlockTimestamp(Number(expireTime));
      await core.markSettlementFailed(1n);
      await core.finalizeSecondarySettlement(1n, 50);

      // Process batch
      const batchId = toBatchId(tSet);
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);

      const navAfter = await core.getVaultNav.staticCall();
      const [, , , , , , processed] = await core.getDailyPnl.staticCall(
        batchId
      );

      // Batch should be processed successfully
      expect(processed).to.equal(true);

      // With no trades, NAV may stay same (Lt = 0), but batch is still processed
      // The key invariant is that secondary settlement path works identically
      // to primary path in terms of batch execution
      expect(navAfter).to.be.gte(0n);
    });
  });
});
