import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { IcicleOptionsCore } from '../../typechain-types';
import {
  WAD,
  USDC_DECIMALS,
  batchEndTimestamp,
  batchStartTimestamp,
} from "../helpers/constants";
import { deploySeedData } from "../helpers";
import {
  buildRedstonePayload,
  submitWithPayload,
} from "../helpers/redstone";

/**
 * Vault & Batch Security Tests (CRITICAL-02, CRITICAL-03, HIGH-01)
 * 
 * CRITICAL-02: processDailyBatch must verify market is settled
 * CRITICAL-03: cancel* must revert if batch already processed
 * HIGH-01: Free balance must reserve processed withdrawals
 */
describe("Vault Escrow Security", () => {
  async function deploySecurityFixture() {
    const [owner, user1, user2, attacker] = await ethers.getSigners();

    const payment = await (await ethers.getContractFactory("IcicleOptionsUSDToken")).deploy();
    const fundAmount = ethers.parseUnits("1000000", USDC_DECIMALS);
    await payment.transfer(user1.address, fundAmount);
    await payment.transfer(user2.address, fundAmount);
    await payment.transfer(attacker.address, fundAmount);

    const lazyLib = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();

    const oracleModule = await (await ethers.getContractFactory("OracleModuleHarness")).deploy();
    const tradeModule = await (await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target }
    })).deploy();
    const lifecycleModule = await (await ethers.getContractFactory("MarketLifecycleModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target }
    })).deploy();
    const lpVaultModule = await (await ethers.getContractFactory("LPVaultModule")).deploy();
    const riskModule = await (await ethers.getContractFactory("RiskModule")).deploy();

    const coreImpl = await (await ethers.getContractFactory("IcicleOptionsCoreHarness", {
      libraries: { LazyMulSegmentTree: lazyLib.target }
    })).deploy();
    const feePolicy = await (await ethers.getContractFactory("MockFeePolicy")).deploy(0);

    const positionImpl = await (await ethers.getContractFactory("IcicleOptionsPosition")).deploy();
    const lpShareImpl = await (await ethers.getContractFactory("IcicleOptionsLPShare")).deploy();
    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const positionProxy = await proxyFactory.deploy(positionImpl.target, "0x");
    const lpShareProxy = await proxyFactory.deploy(lpShareImpl.target, "0x");
    const coreProxy = await proxyFactory.deploy(coreImpl.target, "0x");

    const position = await ethers.getContractAt("IcicleOptionsPosition", await positionProxy.getAddress());
    const lpShare = await ethers.getContractAt("IcicleOptionsLPShare", await lpShareProxy.getAddress());
    const core = await ethers.getContractAt("IcicleOptionsCoreHarness", await coreProxy.getAddress());

    const feedId = ethers.encodeBytes32String("BTC");
    const submitWindow = 3600;
    const opsWindow = 3600;
    const claimDelay = submitWindow + opsWindow;
    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: payment.target.toString(),
      positionContract: await position.getAddress(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: tradeModule.target.toString(),
      lifecycleModule: lifecycleModule.target.toString(),
      riskModule: riskModule.target.toString(),
      vaultModule: lpVaultModule.target.toString(),
      oracleModule: oracleModule.target.toString(),
      ownerSafe: owner.address,
      settlementSubmitWindow: submitWindow,
      pendingOpsWindow: opsWindow,
      claimDelaySeconds: claimDelay,
      redstoneFeedId: feedId,
      redstoneFeedDecimals: 8,
      maxSampleDistance: 600,
      futureTolerance: 60,
      lambda: ethers.parseEther("0.2"),
      kDrawdown: ethers.parseEther("1"),
      enforceAlpha: false,
      rhoBS: 0n,
      phiLP: ethers.parseEther("0.7"),
      phiBS: ethers.parseEther("0.2"),
      phiTR: ethers.parseEther("0.1"),
      withdrawalLagBatches: 1,
      operatorAllowlist: [owner.address],
    };
    await core.initialize(coreParams);
    await position.initialize(await core.getAddress(), owner.address);
    await lpShare.initialize(
      await core.getAddress(),
      payment.target.toString(),
      "Icicle Options LP Share",
      "sLP",
      owner.address
    );

    await payment.connect(user1).approve(core.target, ethers.MaxUint256);
    await payment.connect(user2).approve(core.target, ethers.MaxUint256);
    await payment.connect(attacker).approve(core.target, ethers.MaxUint256);
    await payment.connect(owner).approve(core.target, ethers.MaxUint256);
    await lpShare.connect(user1).approve(core.target, ethers.MaxUint256);
    await lpShare.connect(user2).approve(core.target, ethers.MaxUint256);

    // Seed vault
    await core.connect(owner).seedVault(ethers.parseUnits("100000", USDC_DECIMALS));

    return { core, payment, lpShare, owner, user1, user2, attacker, lpVaultModule, lifecycleModule, tradeModule, feePolicy };
  }

  async function seedBatchForProcessing(core: any, batchId: bigint) {
    await core.harnessSetBatchMarketState(batchId, 1n, 1n);
  }

  /**
   * Create a market that settles in a specific batch
   */
  async function createMarketInBatch(
    core: any,
    batchId: bigint,
    feePolicyAddress: string,
    numBins: number = 10
  ) {
    const batchStart = batchStartTimestamp(batchId);
    const batchEnd = batchEndTimestamp(batchId);
    const now = BigInt(await time.latest());

    let settlementTimestamp = batchStart + 43200n; // Middle of batch day
    const minSettlement = now + 120n;
    if (settlementTimestamp <= minSettlement) {
      settlementTimestamp = minSettlement;
    }
    if (settlementTimestamp >= batchEnd) {
      settlementTimestamp = batchEnd - 1n;
    }

    const endTime = settlementTimestamp - 1n;
    const startTime = endTime - 3600n;

    const tickSpacing = 100n;
    const minTick = 0n;
    const maxTick = tickSpacing * BigInt(numBins);
    const factors = Array(numBins).fill(WAD);
    const seedData = await deploySeedData(factors);

    const marketId = await core.createMarket.staticCall(
      minTick,
      maxTick,
      tickSpacing,
      startTime,
      endTime,
      settlementTimestamp,
      numBins,
      WAD,
      feePolicyAddress,
      await seedData.getAddress()
    );
    await core.createMarket(
      minTick,
      maxTick,
      tickSpacing,
      startTime,
      endTime,
      settlementTimestamp,
      numBins,
      WAD,
      feePolicyAddress,
      await seedData.getAddress()
    );
    await core.seedNextChunks(marketId, numBins);
    return marketId;
  }

  // ============================================================
  // CRITICAL-02: processDailyBatch finalized check
  // ============================================================
  describe("CRITICAL-02: Batch Processing Before Market Finalized", () => {
    it("reverts processDailyBatch when batch market is not settled", async () => {
      const { core, owner, lpVaultModule, feePolicy } = await loadFixture(deploySecurityFixture);
      
      const currentBatchId = await core.currentBatchId();
      const targetBatchId = currentBatchId + 1n;
      
      // Create market that settles in targetBatchId
      const marketId = await createMarketInBatch(core, targetBatchId, feePolicy.target.toString());
      expect(marketId).to.be.gt(0);
      
      // Fast forward to after batch end time (but DON'T finalize market)
      const batchEndTime = batchEndTimestamp(targetBatchId);
      await time.setNextBlockTimestamp(Number(batchEndTime) + 1);
      
      // Market is NOT settled yet
      const market = await core.markets(marketId);
      expect(market.settled).to.be.false;
      
      // Attacker tries to process batch without market being settled
      // This should revert to prevent settlement DoS
      await expect(
        core.connect(owner).processDailyBatch(targetBatchId)
      ).to.be.revertedWithCustomError(lpVaultModule, "BatchMarketsNotResolved")
        .withArgs(targetBatchId, 0n, 1n);
    });

    it("allows processDailyBatch after market is finalized", async () => {
      const { core, owner, feePolicy } = await loadFixture(deploySecurityFixture);
      
      const currentBatchId = await core.currentBatchId();
      const targetBatchId = currentBatchId + 1n;
      
      // Create market that settles in targetBatchId
      const marketId = await createMarketInBatch(core, targetBatchId, feePolicy.target.toString());
      
      // Fast forward to settlement time
      const market = await core.markets(marketId);
      await time.setNextBlockTimestamp(Number(market.settlementTimestamp) + 1);
      
      // Submit oracle sample (price = 500 which is in range [0, 1000])
      const settlementValue = 500; // Human readable price
      const priceTimestamp = Number(market.settlementTimestamp);
      const payload = buildRedstonePayload(settlementValue * 1e8, priceTimestamp);
      await submitWithPayload(core, owner, marketId, payload);
      
      // Fast forward past pending ops window
      const submitWindow = await core.settlementSubmitWindow();
      const opsWindow = await core.pendingOpsWindow();
      const finalizeTime = Number(market.settlementTimestamp) + Number(submitWindow) + Number(opsWindow) + 1;
      await time.setNextBlockTimestamp(finalizeTime);
      
      // Finalize settlement
      await core.finalizePrimarySettlement(marketId);
      
      // Fast forward to after batch end
      const batchEndTime = batchEndTimestamp(targetBatchId);
      await time.setNextBlockTimestamp(Number(batchEndTime) + 1);
      
      // Now batch processing should succeed
      await expect(
        core.connect(owner).processDailyBatch(targetBatchId)
      ).to.not.be.reverted;
    });

    it("requires all markets in batch to be settled (secondary for failed markets)", async () => {
      const { core, owner, lpVaultModule, feePolicy } = await loadFixture(deploySecurityFixture);

      const currentBatchId = await core.currentBatchId();
      const targetBatchId = currentBatchId + 1n;

      const marketId1 = await createMarketInBatch(core, targetBatchId, feePolicy.target.toString());
      const marketId2 = await createMarketInBatch(core, targetBatchId, feePolicy.target.toString());

      const market1 = await core.markets(marketId1);
      const market2 = await core.markets(marketId2);
      const submitWindow = await core.settlementSubmitWindow();
      const opsStart1 = market1.settlementTimestamp + submitWindow + 1n;
      const opsStart2 = market2.settlementTimestamp + submitWindow + 1n;
      const opsStart = opsStart1 > opsStart2 ? opsStart1 : opsStart2;
      await time.setNextBlockTimestamp(Number(opsStart));

      await core.markSettlementFailed(marketId1);

      const batchEndTime = batchEndTimestamp(targetBatchId);
      await time.setNextBlockTimestamp(Number(batchEndTime) + 1);

      await expect(
        core.connect(owner).processDailyBatch(targetBatchId)
      ).to.be.revertedWithCustomError(lpVaultModule, "BatchMarketsNotResolved")
        .withArgs(targetBatchId, 0n, 2n);

      await core.markSettlementFailed(marketId2);

      await expect(
        core.connect(owner).processDailyBatch(targetBatchId)
      ).to.be.revertedWithCustomError(lpVaultModule, "BatchMarketsNotResolved")
        .withArgs(targetBatchId, 0n, 2n);

      await core.finalizeSecondarySettlement(marketId1, 100_000_000n);
      await core.finalizeSecondarySettlement(marketId2, 100_000_000n);

      await expect(
        core.connect(owner).processDailyBatch(targetBatchId)
      ).to.not.be.reverted;
    });

    it("prevents finalize after batch is processed (DoS attack)", async () => {
      const { core, owner, feePolicy } = await loadFixture(deploySecurityFixture);
      
      // Process a batch with a resolved market first
      const currentBatchId = await core.currentBatchId();
      const emptyBatchId = currentBatchId + 1n;
      const batchEndTime = batchEndTimestamp(emptyBatchId);
      await time.setNextBlockTimestamp(Number(batchEndTime) + 1);
      await seedBatchForProcessing(core, emptyBatchId);
      await core.connect(owner).processDailyBatch(emptyBatchId);
      
      // Now create market for next batch
      const targetBatchId = emptyBatchId + 1n;
      const marketId = await createMarketInBatch(core, targetBatchId, feePolicy.target.toString());
      
      // Complete settlement
      const market = await core.markets(marketId);
      await time.setNextBlockTimestamp(Number(market.settlementTimestamp) + 1);
      
      const settlementValue = 500;
      const priceTimestamp = Number(market.settlementTimestamp);
      const payload = buildRedstonePayload(settlementValue * 1e8, priceTimestamp);
      await submitWithPayload(core, owner, marketId, payload);
      
      const submitWindow = await core.settlementSubmitWindow();
      const opsWindow = await core.pendingOpsWindow();
      const finalizeTime = Number(market.settlementTimestamp) + Number(submitWindow) + Number(opsWindow) + 1;
      await time.setNextBlockTimestamp(finalizeTime);
      
      await core.finalizePrimarySettlement(marketId);
      
      // Process the batch after finalization - should work
      const targetBatchEndTime = batchEndTimestamp(targetBatchId);
      await time.setNextBlockTimestamp(Number(targetBatchEndTime) + 1);
      await expect(
        core.connect(owner).processDailyBatch(targetBatchId)
      ).to.not.be.reverted;
    });
  });

  // ============================================================
  // CRITICAL-03: Cancel after batch processed (too-late check)
  // ============================================================
  describe("CRITICAL-03: Cancel After Batch Processed", () => {
    it("reverts cancelDeposit after batch is processed", async () => {
      const { core, user1, lpVaultModule } = await loadFixture(deploySecurityFixture);
      
      // Create deposit request
      const depositAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);
      
      // Eligible batch = currentBatchId + 1
      const currentBatchId = await core.currentBatchId();
      const eligibleBatchId = currentBatchId + 1n;
      const batchEndTime = batchEndTimestamp(eligibleBatchId);
      await time.setNextBlockTimestamp(Number(batchEndTime) + 1);
      await seedBatchForProcessing(core, eligibleBatchId);
      await core.processDailyBatch(eligibleBatchId);
      
      // Try to cancel after batch processed - should revert with CancelTooLate
      // Request ID 0 for first deposit request
      await expect(
        core.connect(user1).cancelDeposit(0)
      ).to.be.revertedWithCustomError(lpVaultModule, "CancelTooLate")
        .withArgs(0n, eligibleBatchId);
    });

    it("reverts cancelWithdraw after batch is processed", async () => {
      const { core, user1, lpShare, lpVaultModule } = await loadFixture(deploySecurityFixture);
      
      // First deposit and claim to get shares
      const depositAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);
      
      const currentBatchId = await core.currentBatchId();
      const depositBatchId = currentBatchId + 1n;
      const depositBatchEnd = batchEndTimestamp(depositBatchId);
      await time.setNextBlockTimestamp(Number(depositBatchEnd) + 1);
      await seedBatchForProcessing(core, depositBatchId);
      await core.processDailyBatch(depositBatchId);
      
      // Claim deposit with request ID 0 (first request)
      await core.connect(user1).claimDeposit(0);
      
      // Now create withdraw request
      const shares = await lpShare.balanceOf(user1.address);
      expect(shares).to.be.gt(0);
      
      await core.connect(user1).requestWithdraw(shares);
      
      // Withdrawal lag = 1, so eligible batch = depositBatchId + 1 + 1
      const eligibleBatchId = depositBatchId + 2n;
      
      // Process all intermediate batches
      let nextBatch = depositBatchId + 1n;
      while (nextBatch <= eligibleBatchId) {
        const endTime = batchEndTimestamp(nextBatch);
        await time.setNextBlockTimestamp(Number(endTime) + 1);
        await seedBatchForProcessing(core, nextBatch);
        await core.processDailyBatch(nextBatch);
        nextBatch++;
      }
      
      // Try to cancel after batch processed - should revert with CancelTooLate
      // Request ID 0 for first withdraw request
      await expect(
        core.connect(user1).cancelWithdraw(0)
      ).to.be.revertedWithCustomError(lpVaultModule, "CancelTooLate")
        .withArgs(0n, eligibleBatchId);
    });

    it("allows cancel before batch is processed", async () => {
      const { core, user1, payment } = await loadFixture(deploySecurityFixture);
      
      const balanceBefore = await payment.balanceOf(user1.address);
      
      // Create deposit request
      const depositAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);
      
      // Cancel before batch processing (request ID 0)
      await expect(
        core.connect(user1).cancelDeposit(0)
      ).to.not.be.reverted;
      
      // Funds should be returned
      const balanceAfter = await payment.balanceOf(user1.address);
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it("reverts cancel by non-owner (RequestNotOwned)", async () => {
      const { core, user1, user2, lpVaultModule } = await loadFixture(deploySecurityFixture);
      
      // user1 creates deposit request
      const depositAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);
      
      // user2 tries to cancel user1's request
      await expect(
        core.connect(user2).cancelDeposit(0)
      ).to.be.revertedWithCustomError(lpVaultModule, "RequestNotOwned")
        .withArgs(0n, user1.address, user2.address);
    });

    it("reverts claim by non-owner (RequestNotOwned)", async () => {
      const { core, user1, user2, lpVaultModule } = await loadFixture(deploySecurityFixture);
      
      // user1 creates deposit request
      const depositAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);
      
      // Process batch
      const currentBatchId = await core.currentBatchId();
      const eligibleBatchId = currentBatchId + 1n;
      const batchEndTime = batchEndTimestamp(eligibleBatchId);
      await time.setNextBlockTimestamp(Number(batchEndTime) + 1);
      await seedBatchForProcessing(core, eligibleBatchId);
      await core.processDailyBatch(eligibleBatchId);
      
      // user2 tries to claim user1's deposit
      await expect(
        core.connect(user2).claimDeposit(0)
      ).to.be.revertedWithCustomError(lpVaultModule, "RequestNotOwned")
        .withArgs(0n, user1.address, user2.address);
    });

    it("reverts claim for non-existent request (RequestNotFound)", async () => {
      const { core, user1, lpVaultModule } = await loadFixture(deploySecurityFixture);
      
      // Try to claim request that doesn't exist
      await expect(
        core.connect(user1).claimDeposit(999)
      ).to.be.revertedWithCustomError(lpVaultModule, "RequestNotFound")
        .withArgs(999n);
    });
  });

  // ============================================================
  // HIGH-01: Withdrawal reserve in free balance
  // ============================================================
  describe("HIGH-01: Withdrawal Reserve Protection", () => {
    it("reserves processed withdrawal funds in free balance", async () => {
      const { core, user1, payment, lpShare } = await loadFixture(deploySecurityFixture);
      
      // User1 deposits
      const depositAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);
      
      // Process deposit batch
      const currentBatchId = await core.currentBatchId();
      const depositBatchId = currentBatchId + 1n;
      const depositBatchEnd = batchEndTimestamp(depositBatchId);
      await time.setNextBlockTimestamp(Number(depositBatchEnd) + 1);
      await seedBatchForProcessing(core, depositBatchId);
      await core.processDailyBatch(depositBatchId);
      
      // Claim deposit to get shares (request ID 0)
      await core.connect(user1).claimDeposit(0);
      
      const user1Shares = await lpShare.balanceOf(user1.address);
      expect(user1Shares).to.be.gt(0);
      
      // User1 requests withdrawal of all shares
      await core.connect(user1).requestWithdraw(user1Shares);
      
      // Process withdrawal batch
      const eligibleBatchId = depositBatchId + 2n; // D_lag = 1
      
      let nextBatch = depositBatchId + 1n;
      while (nextBatch <= eligibleBatchId) {
        const endTime = batchEndTimestamp(nextBatch);
        await time.setNextBlockTimestamp(Number(endTime) + 1);
        await seedBatchForProcessing(core, nextBatch);
        await core.processDailyBatch(nextBatch);
        nextBatch++;
      }
      
      // User1 claims their withdrawal - should work (withdraw request ID 0)
      const balanceBefore = await payment.balanceOf(user1.address);
      await core.connect(user1).claimWithdraw(0);
      const balanceAfter = await payment.balanceOf(user1.address);
      
      // Should receive approximately the deposited amount back
      expect(balanceAfter - balanceBefore).to.be.gte(ethers.parseUnits("49000", USDC_DECIMALS));
    });

    it("prevents double-claim of withdrawal funds via free balance manipulation", async () => {
      const { core, user1, lpShare } = await loadFixture(deploySecurityFixture);
      
      // Deposit
      const depositAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);
      
      // Process and claim deposit (request ID 0)
      const currentBatchId = await core.currentBatchId();
      const depositBatchId = currentBatchId + 1n;
      const depositBatchEnd = batchEndTimestamp(depositBatchId);
      await time.setNextBlockTimestamp(Number(depositBatchEnd) + 1);
      await seedBatchForProcessing(core, depositBatchId);
      await core.processDailyBatch(depositBatchId);
      await core.connect(user1).claimDeposit(0);
      
      // Request withdrawal
      const shares = await lpShare.balanceOf(user1.address);
      await core.connect(user1).requestWithdraw(shares);
      
      // Process withdrawal batch
      const eligibleBatchId = depositBatchId + 2n;
      
      let nextBatch = depositBatchId + 1n;
      while (nextBatch <= eligibleBatchId) {
        const endTime = batchEndTimestamp(nextBatch);
        await time.setNextBlockTimestamp(Number(endTime) + 1);
        await seedBatchForProcessing(core, nextBatch);
        await core.processDailyBatch(nextBatch);
        nextBatch++;
      }
      
      // Claim withdrawal (request ID 0)
      await core.connect(user1).claimWithdraw(0);
      
      // Try to claim again - should revert (not Pending)
      await expect(
        core.connect(user1).claimWithdraw(0)
      ).to.be.reverted;
    });
  });
});
