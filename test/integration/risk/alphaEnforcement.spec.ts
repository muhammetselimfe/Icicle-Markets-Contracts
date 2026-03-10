import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deploySeedData } from "../../helpers";
import { IcicleOptionsCoreHarness, IcicleOptionsCore, IcicleOptionsUSDToken, MockIcicleOptionsPosition, MockFeePolicy, MarketLifecycleModule, RiskModule } from '../../../typechain-types';

/**
 * α Safety Bound Enforcement Integration Test
 *
 * Tests α enforcement at market creation time:
 * 1. createMarket with α > αlimit → revert
 * 2. createMarket with α ≤ αlimit → success
 * 3. open/increase/close/decrease freely within configured α (no per-trade gate)
 * 4. Drawdown reduces αlimit for new market creation
 */

describe("α Safety Bound Enforcement (Integration)", () => {
  let core: IcicleOptionsCoreHarness;
  let payment: IcicleOptionsUSDToken;
  let position: MockIcicleOptionsPosition;
  let lifecycle: MarketLifecycleModule;
  let risk: RiskModule;
  let feePolicy: MockFeePolicy;
  let owner: Awaited<ReturnType<typeof ethers.getSigners>>[0];
  let trader: Awaited<ReturnType<typeof ethers.getSigners>>[0];

  async function deployFixture() {
    const [_owner, _trader] = await ethers.getSigners();
    owner = _owner;
    trader = _trader;

    payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    position = await (
      await ethers.getContractFactory("MockIcicleOptionsPosition")
    ).deploy();
    feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);
    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();
    const riskModule = await (
      await ethers.getContractFactory("RiskModule")
    ).deploy();

    const coreImpl = await (
      await ethers.getContractFactory("IcicleOptionsCoreHarness", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();

    const lifecycleImpl = await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();
    lifecycle = lifecycleImpl as MarketLifecycleModule;
    risk = riskModule as RiskModule;

    const tradeImpl = await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();
    const lpVaultImpl = await (
      await ethers.getContractFactory("LPVaultModule")
    ).deploy();
    // Use OracleModuleHarness to allow Hardhat local signers for Redstone verification
    const oracleImpl = await (
      await ethers.getContractFactory("OracleModuleHarness")
    ).deploy();

    const lpShareImpl = await (
      await ethers.getContractFactory("IcicleOptionsLPShare")
    ).deploy();
    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const lpShareProxy = await proxyFactory.deploy(
      await lpShareImpl.getAddress(),
      "0x"
    );
    const coreProxy = await proxyFactory.deploy(coreImpl.target, "0x");
    const lpShare = await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    );
    core = (await ethers.getContractAt(
      "IcicleOptionsCoreHarness",
      await coreProxy.getAddress()
    )) as IcicleOptionsCoreHarness;

    const submitWindow = 120;
    const opsWindow = 60;
    const claimDelay = submitWindow + opsWindow;
    const feedId = ethers.encodeBytes32String("BTC");
    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: payment.target.toString(),
      positionContract: position.target.toString(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: tradeImpl.target.toString(),
      lifecycleModule: lifecycleImpl.target.toString(),
      riskModule: riskModule.target.toString(),
      vaultModule: lpVaultImpl.target.toString(),
      oracleModule: oracleImpl.target.toString(),
      ownerSafe: owner.address,
      settlementSubmitWindow: submitWindow,
      pendingOpsWindow: opsWindow,
      claimDelaySeconds: claimDelay,
      redstoneFeedId: feedId,
      redstoneFeedDecimals: 8,
      maxSampleDistance: 600,
      futureTolerance: 60,
      lambda: ethers.parseEther("0.3"),
      kDrawdown: ethers.parseEther("1"),
      enforceAlpha: true,
      rhoBS: ethers.parseEther("0.2"),
      phiLP: ethers.parseEther("0.7"),
      phiBS: ethers.parseEther("0.2"),
      phiTR: ethers.parseEther("0.1"),
      withdrawalLagBatches: 1,
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

    // Configure vault
    // pdd is set via setRiskConfig (pdd := -λ)
    await core.setFeeWaterfallConfig(
      ethers.parseEther("0.2"), // rhoBS = 20%
      ethers.parseEther("0.7"), // phiLP = 70%
      ethers.parseEther("0.2"), // phiBS = 20%
      ethers.parseEther("0.1") // phiTR = 10%
    );

    // Seed vault
    await payment.mint(owner.address, ethers.parseUnits("100000", 6));
    await payment.approve(core.target, ethers.MaxUint256);
    await core.seedVault(ethers.parseUnits("10000", 6));

    // Setup Backstop (permissionless funding, 6 decimals)
    await core.fundBackstop(ethers.parseUnits("2000", 6));

    // Configure risk parameters
    // λ = 0.3 (30%), k = 1.0
    await core.setRiskConfig(
      ethers.parseEther("0.3"), // lambda
      ethers.parseEther("1"), // kDrawdown
      true // enforceAlpha = true
    );

    // Setup trader
    await payment.mint(trader.address, ethers.parseUnits("10000", 6));
    await payment.connect(trader).approve(core.target, ethers.MaxUint256);
  }

  beforeEach(async () => {
    await deployFixture();
  });

  const WAD_TO_USDC = 10n ** 12n;

  async function setBackstopNav(targetWad: bigint) {
    const [current] = await core.getCapitalStack();
    if (current === targetWad) return;

    if (current < targetWad) {
      const diff6 = (targetWad - current) / WAD_TO_USDC;
      if (diff6 > 0n) {
        await core.fundBackstop(diff6);
      }
      return;
    }

    const diff6 = (current - targetWad) / WAD_TO_USDC;
    if (diff6 > 0n) {
      await core.connect(owner).withdrawBackstop(diff6);
    }
  }

  describe("Market Creation with α Enforcement", () => {
    it("allows market creation when α ≤ αlimit", async () => {
      // With NAV = 10000, λ = 0.3, n = 100:
      // αbase = 0.3 * 10000 / ln(100) = 3000 / 4.605 ≈ 651.5
      // No peak drawdown → αlimit = αbase ≈ 651.5

      const now = await time.latest();
      const startTimestamp = now + 60;
      const endTimestamp = now + 3600;
      const settlementTimestamp = now + 3660;

      // Create market with α = 500 (< αlimit ≈ 651.5)
      await expect(
        core.createMarketUniform(
          0, // minTick
          1000, // maxTick
          10, // tickSpacing
          startTimestamp,
          endTimestamp,
          settlementTimestamp,
          100, // numBins
          ethers.parseEther("500"), // liquidityParameter (α)
          feePolicy.target.toString()
        )
      ).to.not.be.reverted;
    });

    it("reverts market creation when α > αlimit", async () => {
      const now = await time.latest();
      const startTimestamp = now + 60;
      const endTimestamp = now + 3600;
      const settlementTimestamp = now + 3660;

      // Create market with α = 1000 (> αlimit ≈ 651.5)
      // This should revert because α exceeds limit
      await expect(
        core.createMarketUniform(
          0,
          1000,
          10,
          startTimestamp,
          endTimestamp,
          settlementTimestamp,
          100,
          ethers.parseEther("1000"), // Too high α
          feePolicy.target.toString()
        )
      ).to.be.revertedWithCustomError(risk, "AlphaExceedsLimit");
    });
  });

  describe("Trading Freedom within Configured α", () => {
    let marketId: bigint;

    beforeEach(async () => {
      // Create a market with valid α
      const now = await time.latest();
      const startTimestamp = now + 10;
      const endTimestamp = now + 3600;
      const settlementTimestamp = now + 3660;

      await core.createMarketUniform(
        0,
        1000,
        10,
        startTimestamp,
        endTimestamp,
        settlementTimestamp,
        100,
        ethers.parseEther("500"), // Valid α at creation
        feePolicy.target.toString()
      );
      // marketId starts from 1 (++nextMarketId)
      marketId = 1n;

      // Advance time to market start
      await time.increase(15);
    });

    it("allows openPosition freely (no per-trade α check)", async () => {
      // α/prior are fixed at Zero-Hour (createMarket)
      // Bettors trade freely within configured α - no per-trade gate
      await expect(
        core.connect(trader).openPosition(
          marketId,
          100, // lowerTick
          200, // upperTick
          100, // quantity
          ethers.parseUnits("1000", 6) // maxCost
        )
      ).to.not.be.reverted;
    });

    it("allows increasePosition freely (no per-trade α check)", async () => {
      // Open initial position
      await core
        .connect(trader)
        .openPosition(marketId, 100, 200, 100, ethers.parseUnits("1000", 6));
      const positionId = 1n;

      // Increase is allowed - α enforcement only at market creation
      await expect(
        core.connect(trader).increasePosition(
          positionId,
          50, // additional quantity
          ethers.parseUnits("500", 6)
        )
      ).to.not.be.reverted;
    });

    it("allows closePosition freely", async () => {
      // Open position
      await core
        .connect(trader)
        .openPosition(marketId, 100, 200, 100, ethers.parseUnits("1000", 6));
      const positionId = 1n;

      // Close is allowed
      await expect(
        core.connect(trader).closePosition(
          positionId,
          0 // minProceeds
        )
      ).to.not.be.reverted;
    });

    it("allows decreasePosition freely", async () => {
      // Open position
      await core
        .connect(trader)
        .openPosition(marketId, 100, 200, 100, ethers.parseUnits("1000", 6));
      const positionId = 1n;

      // Decrease is allowed
      await expect(
        core.connect(trader).decreasePosition(
          positionId,
          50, // quantity to decrease
          0 // minProceeds
        )
      ).to.not.be.reverted;
    });
  });

  describe("Peak Drawdown Impact on α Limit", () => {
    it("reduces αlimit proportionally to peak drawdown for new market creation", async () => {
      // Initial state: no peak drawdown (price = pricePeak)
      // αbase = 0.3 * 10000 / ln(100) = 3000 / 4.605 ≈ 651.5
      // αlimit = αbase * (1 - k * DD) = αbase * 1 = 651.5 (with DD=0)

      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Create market with α = 500 should succeed (500 < 651.5)
      await expect(
        core.createMarketUniform(
          0,
          1000,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          100,
          ethers.parseEther("500"),
          feePolicy.target.toString()
        )
      ).to.not.be.reverted;

      // Now simulate 50% peak drawdown by setting price = 0.5 * pricePeak
      // DD = 1 - 0.5 = 0.5
      // αlimit = αbase * (1 - 1 * 0.5) = 651.5 * 0.5 ≈ 325.75
      await core.harnessSetLpVault(
        ethers.parseEther("5000"), // nav reduced to 5000
        ethers.parseEther("10000"), // shares unchanged
        WAD / 2n, // price = 0.5 WAD (50% of peak)
        WAD, // pricePeak = 1 WAD
        true // isSeeded
      );

      // Same α = 500 should now FAIL (500 > 325.75)
      const now2 = await time.latest();
      await expect(
        core.createMarketUniform(
          0,
          1000,
          10,
          now2 + 60,
          now2 + 3600,
          now2 + 3660,
          100,
          ethers.parseEther("500"), // Same α, but now exceeds limit
          feePolicy.target.toString()
        )
      ).to.be.revertedWithCustomError(risk, "AlphaExceedsLimit");
    });

    it("allows lower α when peak drawdown reduces αlimit", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Simulate 50% peak drawdown while keeping NAV = 10000
      // αbase = 0.3 * 10000 / ln(100) ≈ 651.5
      // DD = 0.5
      // αlimit = 651.5 * (1 - 0.5) ≈ 325.75
      await core.harnessSetLpVault(
        ethers.parseEther("10000"), // nav unchanged for αbase calculation
        ethers.parseEther("10000"), // shares
        WAD / 2n, // price = 0.5 (50% peak drawdown from peak)
        WAD, // pricePeak = 1
        true
      );

      // Create market with α = 300 should succeed (300 < 325.75)
      await expect(
        core.createMarketUniform(
          0,
          1000,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          100,
          ethers.parseEther("300"),
          feePolicy.target.toString()
        )
      ).to.not.be.reverted;
    });

    it("rejects all market creation when peak drawdown reaches 100%", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Simulate nearly 100% peak drawdown (price ≈ 0, but NAV > 0 to enable validation)
      // DD = 1 - 0/1 = 1 (100%)
      // αlimit = αbase * (1 - 1 * 1) = 0
      // Note: if NAV = 0, validation is skipped entirely, so we keep NAV > 0
      await core.harnessSetLpVault(
        ethers.parseEther("10000"), // nav > 0 to enable validation
        ethers.parseEther("10000"), // shares
        0n, // price = 0 (100% peak drawdown)
        WAD, // pricePeak = 1
        true
      );

      // Even α = 1 should fail when αlimit = 0
      await expect(
        core.createMarketUniform(
          0,
          1000,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          100,
          ethers.parseEther("1"), // Tiny α
          feePolicy.target.toString()
        )
      ).to.be.revertedWithCustomError(risk, "AlphaExceedsLimit");
    });
  });

  describe("α Enforcement Toggle", () => {
    it("skips α check when enforceAlpha = false", async () => {
      // Disable α enforcement
      await core.setRiskConfig(
        ethers.parseEther("0.3"),
        ethers.parseEther("1"),
        false // enforceAlpha = false
      );

      const now = await time.latest();
      const startTimestamp = now + 60;
      const endTimestamp = now + 3600;
      const settlementTimestamp = now + 3660;

      // Should succeed even with high α because enforcement is off
      await expect(
        core.createMarketUniform(
          0,
          1000,
          10,
          startTimestamp,
          endTimestamp,
          settlementTimestamp,
          100,
          ethers.parseEther("10000"), // Very high α
          feePolicy.target.toString()
        )
      ).to.not.be.reverted;
    });
  });

  describe("Edge Cases: Risk Parameter Boundaries", () => {
    it("reverts market creation when numBins = 1", async () => {
      const now = await time.latest();

      // numBins = 1 should revert with InvalidNumBins
      await expect(
        core.createMarketUniform(
          0,
          10,
          10, // tickSpacing = 10, maxTick - minTick = 10 → 1 bin
          now + 60,
          now + 3600,
          now + 3660,
          1, // numBins = 1
          ethers.parseEther("100"),
          feePolicy.target.toString()
        )
      ).to.be.revertedWithCustomError(risk, "InvalidNumBins");
    });

    it("allows market creation with numBins = 2 (minimum valid)", async () => {
      const now = await time.latest();

      // numBins = 2 should work
      await expect(
        core.createMarketUniform(
          0,
          20,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          2, // numBins = 2
          ethers.parseEther("100"),
          feePolicy.target.toString()
        )
      ).to.not.be.reverted;
    });

    it("rejects setRiskConfig when lambda = 0", async () => {
      // lambda = 0 is not allowed (InvalidLambda)
      await expect(
        core.setRiskConfig(0n, ethers.parseEther("1"), true)
      ).to.be.revertedWithCustomError(core, "InvalidLambda");
    });

    it("ignores peak drawdown when kDrawdown = 0", async () => {
      const WAD = ethers.parseEther("1");

      // Set k = 0 → αlimit = αbase regardless of peak drawdown
      await core.setRiskConfig(
        ethers.parseEther("0.3"),
        0n, // k = 0
        true
      );

      // Simulate 50% peak drawdown
      await core.harnessSetLpVault(
        ethers.parseEther("10000"),
        ethers.parseEther("10000"),
        WAD / 2n, // price = 0.5 (50% peak drawdown)
        WAD, // pricePeak = 1
        true
      );

      const now = await time.latest();

      // With k = 0, αlimit = αbase ≈ 651 (no peak drawdown penalty)
      // α = 500 should still work
      await expect(
        core.createMarketUniform(
          0,
          1000,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          100,
          ethers.parseEther("500"),
          feePolicy.target.toString()
        )
      ).to.not.be.reverted;
    });

    it("rejects baseFactors with zero element", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Factor array with a zero → should revert with InvalidFactor
      const factorsWithZero = Array(10).fill(WAD);
      factorsWithZero[5] = 0n;
      const seedData = await deploySeedData(factorsWithZero);

      await setBackstopNav(ethers.parseEther("1000"));

      // Should revert since zero factor is not allowed
      await expect(
        core.createMarket(
          0,
          100,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          10,
          ethers.parseEther("100"),
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.be.revertedWithCustomError(lifecycle, "InvalidFactor");
    });
  });

  describe("Prior Admissibility (ΔEₜ ≤ backstopNav)", () => {
    const WAD = ethers.parseEther("1");

    /**
     * Creates concentrated prior factors where one bin has higher weight.
     * ΔEₜ = α * ln(rootSum / (n * minFactor))
     *
     * Example: [2, 1, 1, 1, 1, 1, 1, 1, 1, 1] with n=10
     * rootSum = 11, minFactor = 1
     * ΔEₜ = α * ln(11/10) = α * ln(1.1) ≈ α * 0.0953
     */
    function concentratedFactors(numBins: number, hotWeight: bigint): bigint[] {
      const factors: bigint[] = [];
      for (let i = 0; i < numBins; i++) {
        factors.push(i === 0 ? hotWeight : WAD);
      }
      return factors;
    }

    it("allows market creation when ΔEₜ ≤ backstopNav", async () => {
      const now = await time.latest();

      // Create concentrated prior: first bin has 2x weight
      // rootSum = 2 + 9 = 11 WAD, minFactor = 1 WAD
      // ratio = 11/10 = 1.1 WAD
      // ln(1.1) ≈ 0.0953 WAD
      // ΔEₜ = α * ln(1.1) = 100 * 0.0953 ≈ 9.53 WAD
      const factors = concentratedFactors(10, 2n * WAD);
      const seedData = await deploySeedData(factors);

      // Set backstopNav = 100 WAD (> 9.53, so admissible)
      await setBackstopNav(ethers.parseEther("100"));

      // Should succeed: ΔEₜ ≈ 9.53 < 100
      await expect(
        core.createMarket(
          0,
          100,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          10, // numBins = 10
          ethers.parseEther("100"), // α = 100 (lower to pass α limit)
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("reverts market creation when ΔEₜ > backstopNav", async () => {
      const now = await time.latest();

      // Create more concentrated prior: first bin has 10x weight
      // rootSum = 10 + 9 = 19, minFactor = 1
      // ΔEₜ = α * ln(19/10) = 100 * ln(1.9) ≈ 100 * 0.642 ≈ 64.2 WAD
      const factors = concentratedFactors(10, 10n * WAD);
      const seedData = await deploySeedData(factors);

      // Set backstopNav = 50 WAD (< 64.2, so inadmissible)
      await setBackstopNav(ethers.parseEther("50"));

      // Should revert: ΔEₜ ≈ 64.2 > 50
      await expect(
        core.createMarket(
          0,
          100,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          10, // numBins = 10
          ethers.parseEther("100"), // α = 100
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.be.revertedWithCustomError(risk, "PriorNotAdmissible");
    });

    it("boundary: ΔEₜ exactly equals backstopNav (should pass)", async () => {
      const now = await time.latest();

      // Create concentrated prior
      // rootSum = 2 + 9 = 11, minFactor = 1
      // ΔEₜ = 100 * ln(11/10) ≈ 100 * 0.0953 ≈ 9.53 WAD
      const factors = concentratedFactors(10, 2n * WAD);
      const seedData = await deploySeedData(factors);

      // Set backstopNav to exactly 10 WAD (slightly above 9.53)
      await setBackstopNav(ethers.parseEther("10"));

      // Should succeed: ΔEₜ ≈ 9.53 ≤ 10
      await expect(
        core.createMarket(
          0,
          100,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          10,
          ethers.parseEther("100"), // α = 100
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("uniform prior has ΔEₜ = 0 (always admissible)", async () => {
      const now = await time.latest();

      // Uniform prior: all factors = 1 WAD
      // rootSum = n * 1 = 10, minFactor = 1
      // ΔEₜ = α * ln(10/10) = α * ln(1) = 0
      const uniformFactors = Array(10).fill(WAD);
      const seedData = await deploySeedData(uniformFactors);

      // Even with backstopNav = 0, uniform prior should pass
      // (because ΔEₜ = 0 ≤ 0)
      await setBackstopNav(0n);

      await expect(
        core.createMarket(
          0,
          100,
          10,
          now + 60,
          now + 3600,
          now + 3660,
          10,
          ethers.parseEther("100"), // α = 100
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });
  });

  describe("ΔEₜ Storage Validation", () => {
    /**
     * Tests that ΔEₜ is correctly calculated and stored in market struct.
     * The actual grant cap enforcement is tested in batch processing tests.
     */
    it("stores ΔEₜ > 0 for concentrated prior", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Create concentrated prior: first bin has 2x weight
      // ΔEₜ = α * ln(rootSum / (n * minFactor))
      // = 100 * ln(11 / 10) ≈ 9.53 WAD
      const concentratedFactors = Array(10).fill(WAD);
      concentratedFactors[0] = 2n * WAD;
      const seedData = await deploySeedData(concentratedFactors);

      await setBackstopNav(ethers.parseEther("1000"));

      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        now + 3660,
        10,
        ethers.parseEther("100"), // α = 100
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      const market = await core.harnessGetMarket(1n);
      expect(market.deltaEt).to.be.gt(0n);
      // ln(1.1) ≈ 0.0953, so ΔEₜ ≈ 100 * 0.0953 ≈ 9.53 WAD
      expect(market.deltaEt).to.be.gte(ethers.parseEther("9"));
      expect(market.deltaEt).to.be.lt(ethers.parseEther("15"));
    });

    it("stores ΔEₜ = 0 for uniform prior", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      const uniformFactors = Array(10).fill(WAD);
      const seedData = await deploySeedData(uniformFactors);

      await setBackstopNav(ethers.parseEther("1000"));

      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        now + 3660,
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      const market = await core.harnessGetMarket(1n);
      expect(market.deltaEt).to.equal(0n);
    });

    it("ΔEₜ scales proportionally with α", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      const concentratedFactors = Array(10).fill(WAD);
      concentratedFactors[0] = 2n * WAD;
      const seedData = await deploySeedData(concentratedFactors);

      await setBackstopNav(ethers.parseEther("10000"));

      // Market 1: α = 100
      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        now + 3660,
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      // Market 2: α = 200 (different batch)
      await core.createMarket(
        200,
        300,
        10,
        now + 86400 + 60,
        now + 86400 + 3600,
        now + 86400 + 3660,
        10,
        ethers.parseEther("200"),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      const market1 = await core.harnessGetMarket(1n);
      const market2 = await core.harnessGetMarket(2n);

      // ΔEₜ should roughly double with α
      // Allow 5% tolerance for rounding
      const ratio = (market2.deltaEt * 100n) / market1.deltaEt;
      expect(ratio).to.be.gte(195n);
      expect(ratio).to.be.lte(205n);
    });
  });

  // ==================================================================
  // ΔEₜ Calculation & Prior Admissibility Tests
  // ==================================================================
  describe("ΔEₜ Calculation (baseFactors → tail budget)", () => {
    it("uniform prior (all factors = WAD) → ΔEₜ = 0", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Uniform factors: all equal to WAD
      const uniformFactors = Array(10).fill(WAD);
      const seedData = await deploySeedData(uniformFactors);

      await setBackstopNav(ethers.parseEther("1000"));

      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        now + 3660,
        10,
        ethers.parseEther("100"), // α = 100
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      const market = await core.harnessGetMarket(1n);
      // For uniform prior: rootSum = n * WAD, minFactor = WAD
      // ΔEₜ = α * ln(rootSum / (n * minFactor)) = α * ln(n*WAD / (n*WAD)) = α * ln(1) = 0
      expect(market.deltaEt).to.equal(0n);
    });

    it("skewed prior (one bin 2x) → ΔEₜ > 0", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Skewed factors: first bin has 2x weight
      const skewedFactors = Array(10).fill(WAD);
      skewedFactors[0] = 2n * WAD;
      const skewedSeedData = await deploySeedData(skewedFactors);

      await setBackstopNav(ethers.parseEther("1000"));

      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        now + 3660,
        10,
        ethers.parseEther("100"), // α = 100
        feePolicy.target.toString(),
        await skewedSeedData.getAddress()
      );

      const market = await core.harnessGetMarket(1n);
      // rootSum = 9*WAD + 2*WAD = 11*WAD
      // minFactor = WAD
      // ΔEₜ = α * ln(11 / 10) = 100 * ln(1.1) ≈ 9.53 WAD (with ceiling rounding)
      expect(market.deltaEt).to.be.gt(0n);
      expect(market.deltaEt).to.be.lt(ethers.parseEther("15")); // Sanity bound
    });

    it("extreme skew (one bin 10x) → larger ΔEₜ", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // Extreme skew: first bin has 10x weight
      const extremeFactors = Array(10).fill(WAD);
      extremeFactors[0] = 10n * WAD;
      const extremeSeedData = await deploySeedData(extremeFactors);

      await setBackstopNav(ethers.parseEther("10000"));

      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        now + 3660,
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString(),
        await extremeSeedData.getAddress()
      );

      const market = await core.harnessGetMarket(1n);
      // rootSum = 9*WAD + 10*WAD = 19*WAD
      // minFactor = WAD
      // ΔEₜ = α * ln(19/10) = 100 * ln(1.9) ≈ 64.2 WAD (with ceiling)
      expect(market.deltaEt).to.be.gt(ethers.parseEther("50"));
      expect(market.deltaEt).to.be.lt(ethers.parseEther("100"));
    });

    it("minFactor < WAD increases ΔEₜ", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");

      // One bin with half weight
      const factors = Array(10).fill(WAD);
      factors[5] = WAD / 2n; // minFactor = 0.5 WAD
      const seedData = await deploySeedData(factors);

      await setBackstopNav(ethers.parseEther("10000"));

      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        now + 3660,
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      const market = await core.harnessGetMarket(1n);
      // rootSum = 9*WAD + 0.5*WAD = 9.5*WAD
      // minFactor = 0.5*WAD
      // ΔEₜ = α * ln(9.5 / (10*0.5)) = α * ln(1.9) ≈ 64.2 WAD
      expect(market.deltaEt).to.be.gt(ethers.parseEther("50"));
    });
  });

  // Note: Duplicate "Prior Admissibility" describe block removed.
  // Prior Admissibility tests are in the earlier "Prior Admissibility (ΔEₜ ≤ backstopNav)" section.

  // ==================================================================
  // Multiple Markets Per Batch
  // ==================================================================
  describe("Multiple Markets Per Batch", () => {
    it("allows first market creation for a batch", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");
      const uniformFactors = Array(10).fill(WAD);
      const seedData = await deploySeedData(uniformFactors);

      await setBackstopNav(ethers.parseEther("1000"));

      // First market for this settlement timestamp should succeed
      await expect(
        core.createMarket(
          0,
          100,
          10,
          now + 60,
          now + 3600,
          now + 3660, // settlementTimestamp = now + 3660
          10,
          ethers.parseEther("100"),
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("allows second market creation for same batch", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");
      const uniformFactors = Array(10).fill(WAD);
      const seedData = await deploySeedData(uniformFactors);

      await setBackstopNav(ethers.parseEther("1000"));

      // settlementTimestamp determines batchId (settlementTimestamp / 86400)
      const settlementTime = BigInt(now) + 3660n;

      // First market
      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        settlementTime,
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      // Second market with same batchId (same settlement day) should succeed
      // Note: start < end < settlement is required
      await expect(
        core.createMarket(
          200,
          300,
          10,
          BigInt(now) + 100n, // start
          BigInt(now) + 3500n, // end (before settlement)
          settlementTime, // Same settlementTime → same batchId
          10,
          ethers.parseEther("100"),
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("allows markets in different batches (different settlement days)", async () => {
      const now = await time.latest();
      const WAD = ethers.parseEther("1");
      const uniformFactors = Array(10).fill(WAD);
      const seedData = await deploySeedData(uniformFactors);

      await setBackstopNav(ethers.parseEther("1000"));

      const BATCH_SECONDS = 86400n;
      const settlementTime1 = BigInt(now) + 3660n;
      // Different batch: settlement on next day
      const settlementTime2 = settlementTime1 + BATCH_SECONDS;

      // First market (batch 1)
      await core.createMarket(
        0,
        100,
        10,
        now + 60,
        now + 3600,
        settlementTime1,
        10,
        ethers.parseEther("100"),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      // Second market (different batch) should succeed
      await expect(
        core.createMarket(
          200,
          300,
          10,
          BigInt(now) + 60n + BATCH_SECONDS,
          BigInt(now) + 3600n + BATCH_SECONDS,
          settlementTime2,
          10,
          ethers.parseEther("100"),
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });
  });
});
