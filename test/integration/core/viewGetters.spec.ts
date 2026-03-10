import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { MockERC20, IcicleOptionsCoreHarness, IcicleOptionsCore } from '../../../typechain-types';

/**
 * Core View Getters Tests
 *
 * Tests for FE-facing view functions.
 */
describe("Core View Getters", () => {
  let owner: Signer;
  let core: IcicleOptionsCoreHarness;
  let paymentToken: MockERC20;
  let modules: {
    trade: string;
    lifecycle: string;
    risk: string;
    vault: string;
    oracle: string;
  };

  const usdc = (value: string) => ethers.parseUnits(value, 6);

  beforeEach(async () => {
    [owner] = await ethers.getSigners();

    // Deploy mock payment token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    paymentToken = await MockERC20.deploy("USDC", "USDC", 6);

    // Deploy LazyMulSegmentTree library
    const LazyMulSegmentTree = await ethers.getContractFactory(
      "LazyMulSegmentTree"
    );
    const lazyLib = await LazyMulSegmentTree.deploy();

    // Deploy and set modules with library linking
    const RiskModule = await ethers.getContractFactory("RiskModule");
    const riskModule = await RiskModule.deploy();

    const TradeModule = await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: await lazyLib.getAddress() },
    });
    const tradeModule = await TradeModule.deploy();

    const MarketLifecycleModule = await ethers.getContractFactory(
      "MarketLifecycleModule",
      {
        libraries: { LazyMulSegmentTree: await lazyLib.getAddress() },
      }
    );
    const lifecycleModule = await MarketLifecycleModule.deploy();

    const LPVaultModule = await ethers.getContractFactory("LPVaultModule");
    const vaultModule = await LPVaultModule.deploy();

    // Use OracleModuleHarness to allow Hardhat local signers for Redstone verification
    const OracleModule = await ethers.getContractFactory("OracleModuleHarness");
    const oracleModule = await OracleModule.deploy();
    modules = {
      trade: await tradeModule.getAddress(),
      lifecycle: await lifecycleModule.getAddress(),
      risk: await riskModule.getAddress(),
      vault: await vaultModule.getAddress(),
      oracle: await oracleModule.getAddress(),
    };

    // Deploy core harness with library linking
    const IcicleOptionsCoreHarnessFactory = await ethers.getContractFactory(
      "IcicleOptionsCoreHarness",
      {
        libraries: { LazyMulSegmentTree: await lazyLib.getAddress() },
      }
    );
    const coreImpl = await IcicleOptionsCoreHarnessFactory.deploy();

    const positionImplFactory = await ethers.getContractFactory(
      "IcicleOptionsPosition"
    );
    const positionImpl = await positionImplFactory.deploy();
    const lpShareImpl = await (
      await ethers.getContractFactory("IcicleOptionsLPShare")
    ).deploy();
    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const positionProxy = await proxyFactory.deploy(
      await positionImpl.getAddress(),
      "0x"
    );
    const lpShareProxy = await proxyFactory.deploy(
      await lpShareImpl.getAddress(),
      "0x"
    );
    const coreProxy = await proxyFactory.deploy(
      await coreImpl.getAddress(),
      "0x"
    );

    const position = await ethers.getContractAt(
      "IcicleOptionsPosition",
      await positionProxy.getAddress()
    );
    const lpShare = await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    );
    core = IcicleOptionsCoreHarnessFactory.attach(
      await coreProxy.getAddress()
    ) as IcicleOptionsCoreHarness;

    const submitWindow = 3600;
    const opsWindow = 86400 - submitWindow;
    const claimDelay = submitWindow + opsWindow;
    const feedId = ethers.encodeBytes32String("BTC");
    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: await paymentToken.getAddress(),
      positionContract: await position.getAddress(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: await tradeModule.getAddress(),
      lifecycleModule: await lifecycleModule.getAddress(),
      riskModule: await riskModule.getAddress(),
      vaultModule: await vaultModule.getAddress(),
      oracleModule: await oracleModule.getAddress(),
      ownerSafe: await owner.getAddress(),
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
      phiLP: ethers.parseEther("0.8"),
      phiBS: ethers.parseEther("0.1"),
      phiTR: ethers.parseEther("0.1"),
      withdrawalLagBatches: 1,
      operatorAllowlist: [await owner.getAddress()],
    };
    await core.initialize(coreParams);
    await position.initialize(await core.getAddress(), await owner.getAddress());
    await lpShare.initialize(
      await core.getAddress(),
      await paymentToken.getAddress(),
      "Icicle Options LP Share",
      "sLP",
      await owner.getAddress()
    );

    // Fund owner for capital stack operations
    await paymentToken.mint(await owner.getAddress(), usdc("100000"));
    await paymentToken
      .connect(owner)
      .approve(await core.getAddress(), ethers.MaxUint256);
  });

  describe("Vault view getters", () => {
    beforeEach(async () => {
      await core.harnessSetLpVault(
        ethers.parseEther("1000"), // nav
        ethers.parseEther("500"), // shares
        ethers.parseEther("2"), // price
        ethers.parseEther("2.5"), // pricePeak
        true
      );
    });

    it("getVaultNav returns correct NAV", async () => {
      expect(await core.getVaultNav()).to.equal(ethers.parseEther("1000"));
    });

    it("getVaultShares returns correct total shares", async () => {
      expect(await core.getVaultShares()).to.equal(ethers.parseEther("500"));
    });

    it("getVaultPrice returns correct price", async () => {
      expect(await core.getVaultPrice()).to.equal(ethers.parseEther("2"));
    });

    it("getVaultPricePeak returns correct peak", async () => {
      expect(await core.getVaultPricePeak()).to.equal(ethers.parseEther("2.5"));
    });

    it("isVaultSeeded returns correct status", async () => {
      expect(await core.isVaultSeeded()).to.equal(true);
    });

    it("getVaultDrawdown calculates correctly", async () => {
      // DD = 1 - price/peak = 1 - 2/2.5 = 0.2 (20%)
      const drawdown = await core.getVaultDrawdown();
      expect(drawdown).to.equal(ethers.parseEther("0.2"));
    });

    it("getVaultDrawdown returns 0 when price >= pricePeak", async () => {
      await core.harnessSetLpVault(
        ethers.parseEther("1000"),
        ethers.parseEther("500"),
        ethers.parseEther("3"), // price > pricePeak
        ethers.parseEther("2.5"),
        true
      );
      const drawdown = await core.getVaultDrawdown();
      expect(drawdown).to.equal(0);
    });

    it("isVaultSeeded returns false when not seeded", async () => {
      await core.harnessSetLpVault(0, 0, 0, 0, false);
      expect(await core.isVaultSeeded()).to.equal(false);
    });
  });

  describe("Risk config getter", () => {
    beforeEach(async () => {
      await core.setRiskConfig(
        ethers.parseEther("0.3"), // lambda
        ethers.parseEther("1.5"), // kDrawdown
        true // enforceAlpha
      );
    });

    it("getRiskConfig returns all parameters", async () => {
      const [lambda, kDrawdown, enforceAlpha] = await core.getRiskConfig();

      expect(lambda).to.equal(ethers.parseEther("0.3"));
      expect(kDrawdown).to.equal(ethers.parseEther("1.5"));
      expect(enforceAlpha).to.equal(true);
    });
  });

  describe("Fee waterfall config getter", () => {
    beforeEach(async () => {
      await core.setRiskConfig(
        ethers.parseEther("0.3"),
        ethers.parseEther("1"),
        true
      );

      await core.setFeeWaterfallConfig(
        ethers.parseEther("0.1"), // rhoBS
        ethers.parseEther("0.7"), // phiLP
        ethers.parseEther("0.2"), // phiBS
        ethers.parseEther("0.1") // phiTR
      );
    });

    it("getFeeWaterfallConfig returns all parameters", async () => {
      const [rhoBS, pdd, phiLP, phiBS, phiTR] =
        await core.getFeeWaterfallConfig();

      expect(rhoBS).to.equal(ethers.parseEther("0.1"));
      // pdd = -lambda = -0.3
      expect(pdd).to.equal(-ethers.parseEther("0.3"));
      expect(phiLP).to.equal(ethers.parseEther("0.7"));
      expect(phiBS).to.equal(ethers.parseEther("0.2"));
      expect(phiTR).to.equal(ethers.parseEther("0.1"));
    });
  });

  describe("Capital stack getter", () => {
    beforeEach(async () => {
      await core.fundBackstop(usdc("5000"));
      await core.fundTreasury(usdc("2000"));
    });

    it("getCapitalStack returns both values", async () => {
      const [backstopNav, treasuryNav] = await core.getCapitalStack();

      expect(backstopNav).to.equal(ethers.parseEther("5000"));
      expect(treasuryNav).to.equal(ethers.parseEther("2000"));
    });
  });

  describe("Withdrawal lag getter", () => {
    it("getWithdrawalLagBatches returns correct value", async () => {
      await core.setWithdrawalLagBatches(5);
      expect(await core.getWithdrawalLagBatches()).to.equal(5);
    });
  });

  describe("Config change events", () => {
    it("emits RiskConfigUpdated on setRiskConfig", async () => {
      await expect(
        core.setRiskConfig(
          ethers.parseEther("0.3"),
          ethers.parseEther("1"),
          true
        )
      )
        .to.emit(core, "RiskConfigUpdated")
        .withArgs(ethers.parseEther("0.3"), ethers.parseEther("1"), true);
    });

    it("emits BackstopFunded on fundBackstop", async () => {
      await expect(core.fundBackstop(usdc("1000")))
        .to.emit(core, "BackstopFunded")
        .withArgs(await owner.getAddress(), usdc("1000"), ethers.parseEther("1000"));
    });

    it("emits TreasuryFunded on fundTreasury", async () => {
      await expect(core.fundTreasury(usdc("500")))
        .to.emit(core, "TreasuryFunded")
        .withArgs(await owner.getAddress(), usdc("500"), ethers.parseEther("500"));
    });

    it("emits WithdrawalLagUpdated on setWithdrawalLagBatches", async () => {
      await expect(core.setWithdrawalLagBatches(3))
        .to.emit(core, "WithdrawalLagUpdated")
        .withArgs(3);
    });

    it("emits ModulesUpdated on setModules", async () => {
      await expect(
        core.setModules(
          modules.trade,
          modules.lifecycle,
          modules.risk,
          modules.vault,
          modules.oracle
        )
      )
        .to.emit(core, "ModulesUpdated")
        .withArgs(
          modules.trade,
          modules.lifecycle,
          modules.risk,
          modules.vault,
          modules.oracle
        );
    });
  });
});
