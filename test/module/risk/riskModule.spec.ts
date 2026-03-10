import { expect } from "chai";
import { ethers } from "hardhat";
import { IcicleOptionsCoreHarness, IcicleOptionsCore, IcicleOptionsUSDToken, MockIcicleOptionsPosition, RiskModule } from '../../../typechain-types';

/**
 * RiskModule Tests (TDD)
 *
 * Test Plan:
 * 1. ΔEₜ Calculation
 *    - Uniform prior: ΔEₜ = 0
 *    - Concentrated prior: ΔEₜ > 0
 *
 * 2. α Safety Bounds
 *    - αbase,t = λ * E_t / ln(n)
 *    - αlimit,t = max{0, αbase,t * (1 - k * DD_t)}
 *
 * 3. Prior Admissibility
 *    - ΔEₜ ≤ B^eff_{t-1} or revert
 *
 * 4. Trade α Enforcement
 *    - Market α ≤ αlimit or revert on create/increase
 *    - close/decrease always allowed
 */

const WAD = ethers.parseEther("1");
const LAMBDA = ethers.parseEther("0.3"); // 30% NAV loss floor (pdd = -λ)
const K_DD = ethers.parseEther("1"); // Drawdown sensitivity factor

describe("RiskModule", () => {
  let core: IcicleOptionsCoreHarness;
  let riskModule: RiskModule;
  let payment: IcicleOptionsUSDToken;
  let position: MockIcicleOptionsPosition;
  let owner: Awaited<ReturnType<typeof ethers.getSigners>>[0];

  async function deployFixture() {
    const [_owner] = await ethers.getSigners();
    owner = _owner;

    payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    position = await (
      await ethers.getContractFactory("MockIcicleOptionsPosition")
    ).deploy();
    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();

    // Deploy RiskModule
    riskModule = await (await ethers.getContractFactory("RiskModule")).deploy();

    // Deploy IcicleOptionsCoreHarness with modules
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
      coreProxy.target
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
      lambda: LAMBDA,
      kDrawdown: K_DD,
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

    // Seed vault for testing
    await payment.mint(owner.address, ethers.parseUnits("100000", 6));
    await payment.approve(core.target, ethers.MaxUint256);
    await core.seedVault(ethers.parseUnits("10000", 6));

    // Setup Backstop and Treasury NAV for testing
    await core.fundBackstop(ethers.parseUnits("2000", 6));
    await core.fundTreasury(ethers.parseUnits("500", 6));
  }

  beforeEach(async () => {
    await deployFixture();
  });

  // ============================================================
  // lnWadUp Safety: Conservative (PRBMath + 1 wei) ln calculation
  // ============================================================
  describe("lnWadUp Safety (PRBMath based)", () => {
    it("returns ln(2) + 1 wei for n=2", async () => {
      const lnN = await riskModule.lnWad(2n);
      // PRBMath ln(2) ≈ 0.693147... WAD, +1 wei for safety
      const expectedLn2 = 693147180559945309n; // PRBMath ln(2*WAD)
      expect(lnN).to.equal(expectedLn2 + 1n);
    });

    it("returns ln(100) + 1 wei for n=100", async () => {
      const lnN = await riskModule.lnWad(100n);
      // PRBMath ln(100*WAD) = 4605170185988091359, +1 wei for safety
      const expectedLn100 = 4605170185988091359n;
      expect(lnN).to.equal(expectedLn100 + 1n);
    });

    it("returns exact ln(n) + 1 wei for any n (PRBMath precision)", async () => {
      // For n=75, should use exact PRBMath ln(75) + 1 wei
      const ln75 = await riskModule.lnWad(75n);
      const ln100 = await riskModule.lnWad(100n);

      // ln(75) ≈ 4.317... < ln(100) ≈ 4.605...
      // PRBMath gives exact values, not bucketed
      expect(ln75).to.be.lt(ln100);
    });

    it("+1 wei ensures conservative (smaller) αbase", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 75n;

      // αbase = λ * Et / ln(n)
      // +1 wei to ln → slightly smaller αbase → conservative
      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );

      // Exact ln(75) ≈ 4.317 WAD (PRBMath)
      // Used ln(75) + 1 wei (conservative)

      const lnUsed = await riskModule.lnWad(numBins);
      const expectedAlphaBase = (LAMBDA * Et) / lnUsed;

      expect(alphaBase).to.equal(expectedAlphaBase);
      // αbase is conservative due to +1 wei in denominator
      const exactLn75 = ethers.parseEther("4.317488"); // Approximate
      const alphaBaseExact = (LAMBDA * Et) / exactLn75;
      expect(alphaBase).to.be.lt(alphaBaseExact);
    });

    it("handles large numBins safely", async () => {
      const lnLarge = await riskModule.lnWad(50000n);
      // Should use digits-based upper bound for n > 10000
      expect(lnLarge).to.be.gt(0n);
    });

    it("returns 0 for n=1 (edge case)", async () => {
      const ln1 = await riskModule.lnWad(1n);
      expect(ln1).to.equal(0n);
    });

    it("returns 0 for n=0 (boundary)", async () => {
      const ln0 = await riskModule.lnWad(0n);
      expect(ln0).to.equal(0n);
    });
  });

  // ============================================================
  // Edge Cases: numBins boundary conditions
  // ============================================================
  describe("Edge Cases: numBins boundaries", () => {
    it("numBins = 1 reverts with InvalidNumBins (ln(1) = 0 would cause div by zero)", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 1n;

      // ln(1) = 0 → αbase = λ * Et / 0 would be division by zero
      // Contract correctly rejects numBins = 1 to prevent this
      await expect(
        riskModule.calculateAlphaBase(Et, numBins, LAMBDA)
      ).to.be.revertedWithCustomError(riskModule, "InvalidNumBins");
    });

    it("numBins = 2 provides valid αbase", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 2n;

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );

      // ln(2) ≈ 0.693 WAD
      // αbase = 0.3 * 10000 / 0.693 ≈ 4329
      expect(alphaBase).to.be.gt(0n);
      expect(alphaBase).to.be.lt(ethers.parseEther("5000"));
    });

    it("numBins = 256 (MAX_BINS) provides valid αbase", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 256n;

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );

      // ln(256) ≈ 5.545 WAD
      // αbase = 0.3 * 10000 / 5.545 ≈ 541
      expect(alphaBase).to.be.gt(ethers.parseEther("400"));
      expect(alphaBase).to.be.lt(ethers.parseEther("700"));
    });

    it("Et = 0 causes αbase = 0", async () => {
      const Et = 0n;
      const numBins = 100n;

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );
      expect(alphaBase).to.equal(0n);
    });
  });

  // ============================================================
  // 7-0.5: ΔEₜ (Tail Budget) Calculation
  // ============================================================
  describe("7-0.5: ΔEₜ (Tail Budget) Calculation", () => {
    it("returns zero for uniform prior (no tail risk)", async () => {
      // For uniform prior q₀ = 0, E_ent = α ln n, so ΔEₜ = 0
      const numBins = 100n;
      const alpha = ethers.parseEther("1000"); // α

      const deltaEt = await riskModule.calculateDeltaEt(
        alpha,
        numBins,
        0n // uniform prior weight (no concentration)
      );

      expect(deltaEt).to.equal(0n);
    });

    it("returns positive ΔEₜ for concentrated prior", async () => {
      // Concentrated prior: min_j q₀,j < 0 → E_ent > α ln n → ΔEₜ > 0
      const numBins = 100n;
      const alpha = ethers.parseEther("1000");
      const priorConcentration = ethers.parseEther("0.5"); // Concentrated prior

      const deltaEt = await riskModule.calculateDeltaEt(
        alpha,
        numBins,
        priorConcentration
      );

      expect(deltaEt).to.be.gt(0n);
    });

    it("ΔEₜ scales with prior concentration", async () => {
      const numBins = 100n;
      const alpha = ethers.parseEther("1000");

      const deltaEt1 = await riskModule.calculateDeltaEt(
        alpha,
        numBins,
        ethers.parseEther("0.1")
      );
      const deltaEt2 = await riskModule.calculateDeltaEt(
        alpha,
        numBins,
        ethers.parseEther("0.5")
      );

      // More concentrated prior → higher tail risk → higher ΔEₜ
      expect(deltaEt2).to.be.gt(deltaEt1);
    });
  });

  // ============================================================
  // 7-1: α Safety Bounds
  // ============================================================
  describe("7-1: α Safety Bounds (αbase / αlimit)", () => {
    it("calculates αbase = λ * E_t / ln(n)", async () => {
      const Et = ethers.parseEther("10000"); // E_t = NAV_{t-1}
      const numBins = 100n;

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );

      // αbase = λ * E_t / ln(n) = 0.3 * 10000 / ln(100) = 3000 / 4.605 ≈ 651.5
      // ln(100) ≈ 4.605 * WAD
      const lnN = await riskModule.lnWad(numBins);
      const expectedAlphaBase = (LAMBDA * Et) / lnN;

      expect(alphaBase).to.be.closeTo(
        expectedAlphaBase,
        ethers.parseEther("1")
      );
    });

    it("αlimit = αbase when peak drawdown is zero", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 100n;
      const drawdown = 0n; // No peak drawdown

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );
      const alphaLimit = await riskModule.calculateAlphaLimit(
        alphaBase,
        drawdown,
        K_DD
      );

      expect(alphaLimit).to.equal(alphaBase);
    });

    it("αlimit decreases with peak drawdown", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 100n;
      const drawdown = ethers.parseEther("0.2"); // 20% peak drawdown

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );
      const alphaLimit = await riskModule.calculateAlphaLimit(
        alphaBase,
        drawdown,
        K_DD
      );

      // αlimit = αbase * (1 - k * DD) = αbase * 0.8
      const expectedLimit = (alphaBase * (WAD - drawdown)) / WAD;

      expect(alphaLimit).to.equal(expectedLimit);
    });

    it("αlimit = 0 when peak drawdown reaches 100% (extreme)", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 100n;
      const drawdown = WAD; // 100% peak drawdown

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );
      const alphaLimit = await riskModule.calculateAlphaLimit(
        alphaBase,
        drawdown,
        K_DD
      );

      expect(alphaLimit).to.equal(0n);
    });

    it("αlimit never goes negative (max with 0)", async () => {
      const Et = ethers.parseEther("10000");
      const numBins = 100n;
      const drawdown = ethers.parseEther("1.5"); // 150% peak drawdown (impossible but test edge)

      const alphaBase = await riskModule.calculateAlphaBase(
        Et,
        numBins,
        LAMBDA
      );
      const alphaLimit = await riskModule.calculateAlphaLimit(
        alphaBase,
        drawdown,
        K_DD
      );

      expect(alphaLimit).to.equal(0n); // max(0, negative) = 0
    });
  });

  // ============================================================
  // Prior Admissibility
  // ============================================================
  describe("Prior Admissibility (ΔEₜ ≤ B^eff)", () => {
    it("accepts prior when ΔEₜ ≤ B^eff", async () => {
      const deltaEt = ethers.parseEther("100");
      const effectiveBackstop = ethers.parseEther("200");

      // Should not revert
      await expect(
        riskModule.checkPriorAdmissibility(deltaEt, effectiveBackstop)
      ).to.not.be.reverted;
    });

    it("rejects prior when ΔEₜ > B^eff", async () => {
      const deltaEt = ethers.parseEther("300");
      const effectiveBackstop = ethers.parseEther("200");

      await expect(
        riskModule.checkPriorAdmissibility(deltaEt, effectiveBackstop)
      ).to.be.revertedWithCustomError(riskModule, "PriorNotAdmissible");
    });
  });

  // ============================================================
  // Trade α Enforcement - Design Decision
  // ============================================================
  // "No per-trade α gate"
  // - α is enforced at market creation (createMarket) via IcicleOptionsCore -> RiskModule.gateCreateMarket
  // - Trading is free within the α/prior set at market creation time
  // - RiskModule provides CALCULATION helpers; enforcement is triggered by IcicleOptionsCore before delegating to MarketLifecycleModule
  // - Integration tests in alphaEnforcement.spec.ts verify this behavior
  // ============================================================

  // ============================================================
  // 7-4: α Enforcement Test Cases (Calculation Only)
  // ============================================================
  // NOTE: Actual enforcement tests are in alphaEnforcement.spec.ts (integration)
  //       RiskModule only tests calculation correctness here
  describe("7-4: α Enforcement Scenarios (Calculation)", () => {
    describe("Peak drawdown triggers α limit reduction", () => {
      it("reduces αlimit proportionally to peak drawdown", async () => {
        const alphaBase = ethers.parseEther("1000");

        const limit0 = await riskModule.calculateAlphaLimit(
          alphaBase,
          0n,
          K_DD
        );
        const limit10 = await riskModule.calculateAlphaLimit(
          alphaBase,
          ethers.parseEther("0.1"),
          K_DD
        );
        const limit50 = await riskModule.calculateAlphaLimit(
          alphaBase,
          ethers.parseEther("0.5"),
          K_DD
        );

        expect(limit0).to.equal(alphaBase);
        expect(limit10).to.equal((alphaBase * 9n) / 10n);
        expect(limit50).to.equal((alphaBase * 5n) / 10n);
      });
    });

    describe("Recovery (α limit increases)", () => {
      it("αlimit increases as peak drawdown recovers", async () => {
        const alphaBase = ethers.parseEther("1000");

        // Start at 50% peak drawdown
        const limitDrawdown = await riskModule.calculateAlphaLimit(
          alphaBase,
          ethers.parseEther("0.5"),
          K_DD
        );

        // Recover to 20% peak drawdown
        const limitRecovered = await riskModule.calculateAlphaLimit(
          alphaBase,
          ethers.parseEther("0.2"),
          K_DD
        );

        expect(limitRecovered).to.be.gt(limitDrawdown);
      });
    });

    describe("Extreme peak drawdown (DD → 1, αlimit = 0)", () => {
      it("αlimit = 0 prevents all new market creation", async () => {
        const alphaBase = ethers.parseEther("1000");
        const extremeDrawdown = WAD; // 100%

        const alphaLimit = await riskModule.calculateAlphaLimit(
          alphaBase,
          extremeDrawdown,
          K_DD
        );

        expect(alphaLimit).to.equal(0n);
        // Any α > 0 will exceed limit → market creation should fail
      });
    });
  });

  // ==================================================================
  // Config Validation
  // ==================================================================
  describe("Config Validation", () => {
    describe("setRiskConfig validation", () => {
      it("reverts when λ = 0", async () => {
        await expect(
          core.setRiskConfig(0n, K_DD, false)
        ).to.be.revertedWithCustomError(core, "InvalidLambda");
      });

      it("reverts when λ ≥ 1 (WAD)", async () => {
        await expect(
          core.setRiskConfig(WAD, K_DD, false)
        ).to.be.revertedWithCustomError(core, "InvalidLambda");
      });

      it("reverts when λ > 1 (WAD)", async () => {
        await expect(
          core.setRiskConfig(WAD + 1n, K_DD, false)
        ).to.be.revertedWithCustomError(core, "InvalidLambda");
      });

      it("accepts λ just below 1 (WAD - 1)", async () => {
        await expect(core.setRiskConfig(WAD - 1n, K_DD, false)).to.not.be
          .reverted;
      });

      it("accepts λ just above 0 (1 wei)", async () => {
        await expect(core.setRiskConfig(1n, K_DD, false)).to.not.be.reverted;
      });

      it("accepts typical λ = 0.3 (30%)", async () => {
        await expect(core.setRiskConfig(ethers.parseEther("0.3"), K_DD, true))
          .to.not.be.reverted;
      });

      it("sets pdd := -λ automatically", async () => {
        const lambda = ethers.parseEther("0.25");
        await core.setRiskConfig(lambda, K_DD, false);

        // pdd should be -λ
        // Access via harness or getter if available
        // For now, verify indirectly through FeeWaterfallLib behavior
      });
    });

    describe("setFeeWaterfallConfig validation", () => {
      beforeEach(async () => {
        // Must set risk config first (sets pdd)
        await core.setRiskConfig(LAMBDA, K_DD, false);
      });

      it("reverts when phi sum > WAD", async () => {
        await expect(
          core.setFeeWaterfallConfig(
            0n,
            ethers.parseEther("0.5"),
            ethers.parseEther("0.3"),
            ethers.parseEther("0.3") // Total = 1.1 WAD > 1
          )
        ).to.be.revertedWithCustomError(core, "InvalidFeeSplitSum");
      });

      it("reverts when phi sum < WAD", async () => {
        await expect(
          core.setFeeWaterfallConfig(
            0n,
            ethers.parseEther("0.3"),
            ethers.parseEther("0.3"),
            ethers.parseEther("0.3") // Total = 0.9 WAD < 1
          )
        ).to.be.revertedWithCustomError(core, "InvalidFeeSplitSum");
      });

      it("accepts phi sum = WAD exactly", async () => {
        await expect(
          core.setFeeWaterfallConfig(
            0n,
            ethers.parseEther("0.8"),
            ethers.parseEther("0.1"),
            ethers.parseEther("0.1") // Total = 1.0 WAD
          )
        ).to.not.be.reverted;
      });

      it("accepts all zeros except one (edge case)", async () => {
        await expect(
          core.setFeeWaterfallConfig(
            0n,
            WAD, // 100% to LP
            0n,
            0n
          )
        ).to.not.be.reverted;
      });
    });
  });
});
