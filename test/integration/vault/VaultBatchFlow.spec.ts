import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LPVaultModuleProxy, MockERC20 } from "../../../typechain-types";
import { WAD, advancePastBatchEnd } from "../../helpers/constants";

// Helper for 6-decimal token amounts.
// paymentToken is USDC6 (6 decimals), internal accounting uses WAD (18 decimals).
function usdc(amount: string | number): bigint {
  return ethers.parseUnits(String(amount), 6);
}

/**
 * VaultBatchFlow Integration Tests
 *
 * Tests LPVaultModule + VaultAccountingLib integration using Request ID model.
 * Reference: whitepaper section 3
 */

describe("VaultBatchFlow Integration", () => {
  async function deployVaultFixture() {
    const [owner, userA, userB, userC] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    // Use 6-decimal token (paymentToken = USDC6)
    const payment = (await MockERC20.deploy(
      "MockVaultToken",
      "MVT",
      6
    )) as MockERC20;

    const moduleFactory = await ethers.getContractFactory("LPVaultModule");
    const module = await moduleFactory.deploy();

    const proxyFactory = await ethers.getContractFactory("LPVaultModuleProxy");
    const proxy = (await proxyFactory.deploy(
      module.target
    )) as LPVaultModuleProxy;

    await proxy.setPaymentToken(payment.target);
    await proxy.setWithdrawalLagBatches(0); // Immediate withdrawals for testing

    // Configure Risk (sets pdd := -λ)
    // λ = 0.2 → pdd = -0.2 (20% NAV loss floor)
    await proxy.setRiskConfig(
      ethers.parseEther("0.2"), // lambda = 0.2
      ethers.parseEther("1"), // kDrawdown
      false // enforceAlpha
    );

    // Configure FeeWaterfall for batch processing (pdd is already set via setRiskConfig)
    await proxy.setFeeWaterfallConfig(
      0n, // rhoBS
      ethers.parseEther("0.8"), // phiLP = 80%
      ethers.parseEther("0.1"), // phiBS = 10%
      ethers.parseEther("0.1") // phiTR = 10%
    );

    // Fund with 6-decimal token amounts
    const fundAmount = usdc("100000");
    await payment.mint(userA.address, fundAmount);
    await payment.mint(userB.address, fundAmount);
    await payment.mint(userC.address, fundAmount);
    await payment.connect(userA).approve(proxy.target, ethers.MaxUint256);
    await payment.connect(userB).approve(proxy.target, ethers.MaxUint256);
    await payment.connect(userC).approve(proxy.target, ethers.MaxUint256);

    return { owner, userA, userB, userC, payment, proxy, module };
  }

  // Default deltaEt for grant testing (equal to backstopNav)
  const DEFAULT_DELTA_ET = ethers.parseEther("500");

  async function deploySeededVaultFixture() {
    const fixture = await deployVaultFixture();
    const { proxy, userA } = fixture;
    // Seed with 6-decimal token amount (converts to 1000 WAD internally)
    await proxy.connect(userA).seedVault(usdc("1000"));
    // Initialize backstopNav for deltaEt calculation.
    // This ensures FeeWaterfall doesn't revert on grantNeed > deltaEt.
    await proxy.connect(userA).fundBackstop(usdc("500"));
    // deltaEt is now set per-batch via harnessRecordPnl, not globally
    const currentBatchId = await proxy.getCurrentBatchId();
    const firstBatchId = currentBatchId + 1n;
    return { ...fixture, currentBatchId, firstBatchId };
  }

  // Helper to process batch with P&L
  // deltaEt defaults to backstopNav to allow grant mechanics testing
  async function processBatchWithPnl(
    proxy: LPVaultModuleProxy,
    batchId: bigint,
    pnl: bigint,
    fees: bigint = 0n,
    deltaEt: bigint = DEFAULT_DELTA_ET
  ) {
    await proxy.harnessRecordPnl(batchId, pnl, fees, deltaEt);
    await advancePastBatchEnd(batchId);
    await proxy.processDailyBatch(batchId);
  }

  // ============================================================
  // Vault Seeding
  // ============================================================
  describe("Vault seeding", () => {
    it("seeds vault with initial capital", async () => {
      const { proxy, userA } = await loadFixture(deployVaultFixture);

      // Seed with 6-decimal amount, internal state stored as WAD
      const seedAmount6 = usdc("1000");
      const seedAmountWad = ethers.parseEther("1000"); // Expected internal WAD value
      await proxy.connect(userA).seedVault(seedAmount6);

      expect(await proxy.isVaultSeeded()).to.be.true;
      expect(await proxy.getVaultNav()).to.equal(seedAmountWad);
      expect(await proxy.getVaultShares()).to.equal(seedAmountWad);
      expect(await proxy.getVaultPrice()).to.equal(WAD);
      expect(await proxy.getVaultPricePeak()).to.equal(WAD);
    });

    it("rejects zero seed amount", async () => {
      const { proxy, userA, module } = await loadFixture(deployVaultFixture);

      await expect(
        proxy.connect(userA).seedVault(0n)
      ).to.be.revertedWithCustomError(module, "ZeroAmount");
    });

    it("rejects double seeding", async () => {
      const { proxy, userA, module } = await loadFixture(
        deploySeededVaultFixture
      );

      await expect(
        proxy.connect(userA).seedVault(usdc("1000"))
      ).to.be.revertedWithCustomError(module, "VaultAlreadySeeded");
    });
  });

  // ============================================================
  // Daily batch lifecycle
  // ============================================================
  describe("processDailyBatch", () => {
    it("computes preBatchNav from P&L inputs", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // Initial: N=1000, S=1000
      // P&L: L=-50, F=30 → Π varies by waterfall
      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("-50"),
        ethers.parseEther("30")
      );

      // NAV updated according to waterfall
      const nav = await proxy.getVaultNav();
      expect(nav).to.be.lt(ethers.parseEther("1000")); // Loss reduced NAV
    });

    it("calculates batch price from preBatchNav and shares", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // N_pre ≈ 990, S = 1000 → P_e ≈ 0.99
      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("-10"),
        0n
      );

      const price = await proxy.getVaultPrice();
      expect(price).to.be.lt(WAD);
    });

    it("updates NAV and shares correctly after deposit", async () => {
      const { proxy, userB, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userB).requestDeposit(usdc("100"));
      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);

      // Claim deposit
      await proxy.connect(userB).claimDeposit(0n);

      // N = 1000 + 100 = 1100
      expect(await proxy.getVaultNav()).to.equal(ethers.parseEther("1100"));
    });

    it("updates price and peak after batch", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // Positive P&L increases price
      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("100"),
        0n
      );

      const price = await proxy.getVaultPrice();
      const peak = await proxy.getVaultPricePeak();
      expect(price).to.be.gt(WAD);
      expect(peak).to.be.gte(price);
    });

    it("emits DailyBatchProcessed event", async () => {
      const { proxy, module, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      const moduleAtProxy = module.attach(proxy.target);

      await proxy.harnessRecordPnl(firstBatchId, 0n, 0n, DEFAULT_DELTA_ET);
      await advancePastBatchEnd(firstBatchId);
      await expect(proxy.processDailyBatch(firstBatchId)).to.emit(
        moduleAtProxy,
        "DailyBatchProcessed"
      );
    });
  });

  // ============================================================
  // P&L flow scenarios
  // ============================================================
  describe("P&L scenarios", () => {
    it("handles positive P&L (L_t > 0, maker profit)", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // Positive P&L = maker profit (traders lost)
      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("100"),
        0n
      );

      expect(await proxy.getVaultNav()).to.be.gt(ethers.parseEther("1000"));
    });

    it("handles negative P&L (L_t < 0, maker loss)", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("-200"),
        0n
      );

      expect(await proxy.getVaultNav()).to.be.lt(ethers.parseEther("1000"));
    });

    it("handles fee income (F_t > 0)", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // Fees get split per waterfall, LP portion increases NAV
      await processBatchWithPnl(
        proxy,
        firstBatchId,
        0n,
        ethers.parseEther("50")
      );

      // LP gets 80% of fees
      expect(await proxy.getVaultNav()).to.be.gte(ethers.parseEther("1000"));
    });

    it("handles combined P&L components", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // L=-50, F=30 → waterfall applies
      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("-50"),
        ethers.parseEther("30")
      );

      const nav = await proxy.getVaultNav();
      expect(nav).to.be.gt(0n);
    });
  });

  // ============================================================
  // Deposit/Withdraw flow
  // ============================================================
  describe("Deposit flow", () => {
    it("mints shares at batch price", async () => {
      const { proxy, userB, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userB).requestDeposit(usdc("100"));

      // Process batch with P&L that changes price
      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("100"),
        0n
      );

      // Claim and verify shares
      await proxy.connect(userB).claimDeposit(0n);

      // Price increased, so fewer shares minted
      const shares = await proxy.getVaultShares();
      expect(shares).to.be.lt(ethers.parseEther("1200")); // Less than 1000 + 100 + 100
    });

    it("preserves price within tolerance after deposit", async () => {
      const { proxy, userB, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userB).requestDeposit(usdc("500"));
      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);
      await proxy.connect(userB).claimDeposit(0n);

      const price = await proxy.getVaultPrice();
      const diff = price > WAD ? price - WAD : WAD - price;
      expect(diff).to.be.lte(10n); // Within small tolerance
    });
  });

  describe("Withdraw flow", () => {
    it("burns shares at batch price", async () => {
      const { proxy, userA, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userA).requestWithdraw(ethers.parseEther("100"));
      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);
      await proxy.connect(userA).claimWithdraw(0n);

      // S = 1000 - 100 = 900
      expect(await proxy.getVaultShares()).to.equal(ethers.parseEther("900"));
    });

    it("preserves price within tolerance after withdraw", async () => {
      const { proxy, userA, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userA).requestWithdraw(ethers.parseEther("200"));
      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);
      await proxy.connect(userA).claimWithdraw(0n);

      const price = await proxy.getVaultPrice();
      const diff = price > WAD ? price - WAD : WAD - price;
      expect(diff).to.be.lte(10n);
    });
  });

  // ============================================================
  // Multi-day sequences
  // ============================================================
  describe("Multi-day sequences", () => {
    it("processes consecutive batches correctly", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );
      const day1 = firstBatchId;
      const day2 = day1 + 1n;
      const day3 = day1 + 2n;

      // Day 1: +10%
      await processBatchWithPnl(proxy, day1, ethers.parseEther("100"), 0n);
      expect(await proxy.getVaultNav()).to.be.gte(ethers.parseEther("1090"));

      // Day 2: -5%
      await processBatchWithPnl(proxy, day2, ethers.parseEther("-55"), 0n);

      // Day 3: +8%
      await processBatchWithPnl(proxy, day3, ethers.parseEther("80"), 0n);

      const nav = await proxy.getVaultNav();
      expect(nav).to.be.gt(ethers.parseEther("1000"));
    });

    it("peak tracks highest price across days", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );
      const day1 = firstBatchId;
      const day2 = day1 + 1n;
      const day3 = day1 + 2n;

      // Day 1: +20% → peak = 1.2
      await processBatchWithPnl(proxy, day1, ethers.parseEther("200"), 0n);
      const peak1 = await proxy.getVaultPricePeak();

      // Day 2: -10% → peak stays
      await processBatchWithPnl(proxy, day2, ethers.parseEther("-120"), 0n);
      const peak2 = await proxy.getVaultPricePeak();
      expect(peak2).to.equal(peak1);

      // Day 3: +30% → peak increases
      await processBatchWithPnl(proxy, day3, ethers.parseEther("300"), 0n);
      const peak3 = await proxy.getVaultPricePeak();
      expect(peak3).to.be.gt(peak1);
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================
  describe("Edge cases", () => {
    it("handles batch with no P&L and no queue", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      const navBefore = await proxy.getVaultNav();
      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);
      const navAfter = await proxy.getVaultNav();

      expect(navAfter).to.equal(navBefore);
    });

    it("handles empty batch (no deposits, no withdrawals)", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("50"),
        0n
      );

      // Should process without error
      expect(await proxy.getVaultNav()).to.be.gt(ethers.parseEther("1000"));
    });
  });

  // ============================================================
  // Multi-user concurrent operations
  // ============================================================
  describe("Multi-user concurrent operations", () => {
    it("handles multiple users depositing in same batch", async () => {
      const { proxy, userA, userB, userC, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userA).requestDeposit(usdc("100"));
      await proxy.connect(userB).requestDeposit(usdc("200"));
      await proxy.connect(userC).requestDeposit(usdc("300"));

      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);

      // All users claim
      await proxy.connect(userA).claimDeposit(0n);
      await proxy.connect(userB).claimDeposit(1n);
      await proxy.connect(userC).claimDeposit(2n);

      // Total deposits: 600
      expect(await proxy.getVaultNav()).to.equal(ethers.parseEther("1600"));
    });

    it("handles mixed deposit/withdraw from multiple users", async () => {
      const { proxy, userA, userB, userC, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // userA withdraws (has shares from seed)
      await proxy.connect(userA).requestWithdraw(ethers.parseEther("200"));
      // userB and userC deposit
      await proxy.connect(userB).requestDeposit(usdc("150"));
      await proxy.connect(userC).requestDeposit(usdc("100"));

      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);

      // Claims
      await proxy.connect(userA).claimWithdraw(0n);
      await proxy.connect(userB).claimDeposit(0n);
      await proxy.connect(userC).claimDeposit(1n);

      // Net: -200 + 150 + 100 = +50
      expect(await proxy.getVaultNav()).to.equal(ethers.parseEther("1050"));
    });
  });

  // ============================================================
  // Request cancellation
  // ============================================================
  describe("Request cancellation", () => {
    it("allows cancel before batch processed", async () => {
      const { proxy, userB, payment } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userB).requestDeposit(usdc("100"));

      const balanceBefore = await payment.balanceOf(userB.address);
      await proxy.connect(userB).cancelDeposit(0n);
      const balanceAfter = await payment.balanceOf(userB.address);

      // Token transfer is in 6 decimals
      expect(balanceAfter - balanceBefore).to.equal(usdc("100"));
    });

    it("blocks deposit cancel once the eligible batch starts settling (free-option fix)", async () => {
      const { proxy, userB, module, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userB).requestDeposit(usdc("100")); // eligible for firstBatchId
      // A market settles into firstBatchId: P&L is now recorded & observable on-chain
      // (resolved > 0), but the batch is NOT yet processed. A late cancel here would be
      // a risk-free option (back out of a now-known adverse batch).
      await proxy.harnessRecordPnl(
        firstBatchId,
        ethers.parseEther("-50"),
        0n,
        DEFAULT_DELTA_ET
      );

      await expect(
        proxy.connect(userB).cancelDeposit(0n)
      ).to.be.revertedWithCustomError(module, "CancelTooLate");
    });

    it("blocks withdraw cancel once the eligible batch starts settling (free-option fix)", async () => {
      const { proxy, userA, module, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userA).requestWithdraw(ethers.parseEther("100")); // lag 0 -> firstBatchId
      await proxy.harnessRecordPnl(
        firstBatchId,
        ethers.parseEther("100"),
        0n,
        DEFAULT_DELTA_ET
      );

      await expect(
        proxy.connect(userA).cancelWithdraw(0n)
      ).to.be.revertedWithCustomError(module, "CancelTooLate");
    });

    it("prevents cancel after claim", async () => {
      const { proxy, userB, module, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userB).requestDeposit(usdc("100"));
      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);
      await proxy.connect(userB).claimDeposit(0n);

      // Cancel should fail
      await expect(
        proxy.connect(userB).cancelDeposit(0n)
      ).to.be.revertedWithCustomError(module, "RequestNotPending");
    });
  });

  // ============================================================
  // Batch sequence enforcement
  // ============================================================
  describe("Batch sequence enforcement", () => {
    it("rejects out-of-sequence batch", async () => {
      const { proxy, module, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      // Try to process far-future batch when expecting firstBatchId
      const badBatchId = firstBatchId + 4n;
      await proxy.harnessRecordPnl(badBatchId, 0n, 0n, DEFAULT_DELTA_ET);
      await expect(
        proxy.processDailyBatch(badBatchId)
      ).to.be.revertedWithCustomError(module, "BatchNotReady");
    });

    it("prevents duplicate batch processing", async () => {
      const { proxy, module, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await processBatchWithPnl(proxy, firstBatchId, 0n, 0n);

      // Try to process same batch again
      // This fails with BatchNotReady because currentBatchId is now firstBatchId,
      // and we're trying to process firstBatchId again (expects firstBatchId + 1)
      await expect(
        proxy.processDailyBatch(firstBatchId)
      ).to.be.revertedWithCustomError(module, "BatchNotReady");
    });

    it("allows sequential batches", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );
      const day1 = firstBatchId;
      const day2 = day1 + 1n;
      const day3 = day1 + 2n;

      await processBatchWithPnl(proxy, day1, 0n, 0n);
      await processBatchWithPnl(proxy, day2, 0n, 0n);
      await processBatchWithPnl(proxy, day3, 0n, 0n);

      expect(await proxy.getCurrentBatchId()).to.equal(day3);
    });
  });

  // ============================================================
  // Invariant assertions
  // ============================================================
  describe("Invariant assertions", () => {
    it("NAV >= 0 after any batch", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("-500"),
        0n
      );

      expect(await proxy.getVaultNav()).to.be.gte(0n);
    });

    it("shares >= 0 after any batch", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await processBatchWithPnl(
        proxy,
        firstBatchId,
        ethers.parseEther("100"),
        0n
      );

      expect(await proxy.getVaultShares()).to.be.gte(0n);
    });

    it("price > 0 when shares > 0", async () => {
      const { proxy } = await loadFixture(deploySeededVaultFixture);

      const shares = await proxy.getVaultShares();
      if (shares > 0n) {
        expect(await proxy.getVaultPrice()).to.be.gt(0n);
      }
    });

    it("peak >= price always", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );
      const day1 = firstBatchId;
      const day2 = day1 + 1n;

      await processBatchWithPnl(proxy, day1, ethers.parseEther("100"), 0n);
      await processBatchWithPnl(proxy, day2, ethers.parseEther("-50"), 0n);

      const price = await proxy.getVaultPrice();
      const peak = await proxy.getVaultPricePeak();
      expect(peak).to.be.gte(price);
    });

    it("0 <= peak drawdown <= 100%", async () => {
      const { proxy, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );
      const day1 = firstBatchId;
      const day2 = day1 + 1n;

      await processBatchWithPnl(proxy, day1, ethers.parseEther("200"), 0n);
      await processBatchWithPnl(proxy, day2, ethers.parseEther("-300"), 0n);

      const price = await proxy.getVaultPrice();
      const peak = await proxy.getVaultPricePeak();
      const drawdown = WAD - (price * WAD) / peak;

      expect(drawdown).to.be.gte(0n);
      expect(drawdown).to.be.lte(WAD);
    });
  });

  // ============================================================
  // Pre-aggregation invariant
  // ============================================================
  describe("Pre-aggregation invariant", () => {
    it("pending totals reflect sum of requests", async () => {
      const { proxy, userA, userB, userC, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userA).requestDeposit(usdc("100"));
      await proxy.connect(userB).requestDeposit(usdc("200"));
      await proxy.connect(userC).requestDeposit(usdc("300"));

      const [deposits, withdraws] = await proxy.getPendingBatchTotals(
        firstBatchId
      );
      expect(deposits).to.equal(ethers.parseEther("600"));
      expect(withdraws).to.equal(0n);
    });

    it("cancel updates pending totals correctly", async () => {
      const { proxy, userA, userB, firstBatchId } = await loadFixture(
        deploySeededVaultFixture
      );

      await proxy.connect(userA).requestDeposit(usdc("100"));
      await proxy.connect(userB).requestDeposit(usdc("200"));

      // Cancel userA
      await proxy.connect(userA).cancelDeposit(0n);

      const [deposits] = await proxy.getPendingBatchTotals(firstBatchId);
      expect(deposits).to.equal(ethers.parseEther("200"));
    });
  });
});
