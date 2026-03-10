import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { IcicleOptionsCoreHarness, IcicleOptionsCore, IcicleOptionsLPShare, MockERC20, LPVaultModule, MarketLifecycleModule, OracleModuleHarness, RiskModule, TradeModule } from '../../../typechain-types';

/**
 * IcicleOptionsLPShare ERC-4626 Token Tests
 *
 * Tests the async vault token implementation.
 */
describe("IcicleOptionsLPShare", () => {
  const WAD = ethers.parseEther("1");

  let owner: Signer;
  let user1: Signer;
  let core: IcicleOptionsCoreHarness;
  let paymentToken: MockERC20;
  let lpShare: IcicleOptionsLPShare;

  beforeEach(async () => {
    [owner, user1] = await ethers.getSigners();

    // Deploy mock payment token
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    paymentToken = (await MockERC20Factory.deploy(
      "USDC",
      "USDC",
      6
    )) as MockERC20;

    // Deploy LazyMulSegmentTree library
    const LazyMulSegmentTree = await ethers.getContractFactory(
      "LazyMulSegmentTree"
    );
    const lazyLib = await LazyMulSegmentTree.deploy();

    const tradeModule = (await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: await lazyLib.getAddress() },
      })
    ).deploy()) as TradeModule;

    const lifecycleModule = (await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: await lazyLib.getAddress() },
      })
    ).deploy()) as MarketLifecycleModule;

    const oracleModule = (await (
      await ethers.getContractFactory("OracleModuleHarness")
    ).deploy()) as OracleModuleHarness;

    const riskModule = (await (
      await ethers.getContractFactory("RiskModule")
    ).deploy()) as RiskModule;

    const vaultModule = (await (
      await ethers.getContractFactory("LPVaultModule")
    ).deploy()) as LPVaultModule;

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
    const lpShareImplFactory = await ethers.getContractFactory("IcicleOptionsLPShare");
    const lpShareImpl = await lpShareImplFactory.deploy();

    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const positionProxy = await proxyFactory.deploy(await positionImpl.getAddress(), "0x");
    const lpShareProxy = await proxyFactory.deploy(await lpShareImpl.getAddress(), "0x");
    const coreProxy = await proxyFactory.deploy(await coreImpl.getAddress(), "0x");

    core = IcicleOptionsCoreHarnessFactory.attach(
      await coreProxy.getAddress()
    ) as IcicleOptionsCoreHarness;
    lpShare = (await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    )) as IcicleOptionsLPShare;
    const position = await ethers.getContractAt(
      "IcicleOptionsPosition",
      await positionProxy.getAddress()
    );

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
      settlementSubmitWindow: 3600,
      pendingOpsWindow: 0,
      claimDelaySeconds: 3600,
      redstoneFeedId: feedId,
      redstoneFeedDecimals: 8,
      maxSampleDistance: 600,
      futureTolerance: 60,
      lambda: WAD / 10n,
      kDrawdown: WAD,
      enforceAlpha: true,
      rhoBS: 0,
      phiLP: WAD,
      phiBS: 0,
      phiTR: 0,
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
  });

  describe("Deployment", () => {
    it("sets correct name and symbol", async () => {
      expect(await lpShare.name()).to.equal("Icicle Options LP Share");
      expect(await lpShare.symbol()).to.equal("sLP");
    });

    it("sets correct core address", async () => {
      expect(await lpShare.core()).to.equal(await core.getAddress());
    });

    it("sets correct asset address", async () => {
      expect(await lpShare.getAsset()).to.equal(
        await paymentToken.getAddress()
      );
    });

    it("sets owner to ownerSafe", async () => {
      expect(await lpShare.owner()).to.equal(await owner.getAddress());
    });
  });

  describe("OnlyCore modifier", () => {
    // Note: Success cases for mint/burn require core impersonation,
    // which is tested in module/vault/lpVaultModule.spec.ts

    it("reverts when non-core tries to mint", async () => {
      await expect(
        lpShare.connect(user1).mint(await user1.getAddress(), WAD)
      ).to.be.revertedWithCustomError(lpShare, "OnlyCore");
    });

    it("reverts when non-core tries to burn", async () => {
      await expect(
        lpShare.connect(user1).burn(await user1.getAddress(), WAD)
      ).to.be.revertedWithCustomError(lpShare, "OnlyCore");
    });
  });

  describe("Async vault restrictions", () => {
    it("reverts on direct deposit", async () => {
      await expect(
        lpShare.deposit(WAD, await owner.getAddress())
      ).to.be.revertedWithCustomError(lpShare, "AsyncVaultUseRequestDeposit");
    });

    it("reverts on direct mintShares", async () => {
      await expect(
        lpShare.mintShares(WAD, await owner.getAddress())
      ).to.be.revertedWithCustomError(lpShare, "AsyncVaultUseRequestDeposit");
    });

    it("reverts on direct withdraw", async () => {
      await expect(
        lpShare.withdraw(
          WAD,
          await owner.getAddress(),
          await owner.getAddress()
        )
      ).to.be.revertedWithCustomError(lpShare, "AsyncVaultUseRequestWithdraw");
    });

    it("reverts on direct redeem", async () => {
      await expect(
        lpShare.redeem(WAD, await owner.getAddress(), await owner.getAddress())
      ).to.be.revertedWithCustomError(lpShare, "AsyncVaultUseRequestWithdraw");
    });
  });

  describe("View functions", () => {
    beforeEach(async () => {
      // Setup vault with some NAV and price
      await core.harnessSetLpVault(
        ethers.parseEther("1000"), // nav = 1000 WAD
        ethers.parseEther("500"), // shares = 500 WAD
        ethers.parseEther("2"), // price = 2 WAD (1000/500)
        ethers.parseEther("2"),
        true
      );
    });

    it("convertToShares returns correct value", async () => {
      // 100 assets at price 2 = 50 shares
      const shares = await lpShare.convertToShares(ethers.parseEther("100"));
      expect(shares).to.equal(ethers.parseEther("50"));
    });

    it("convertToAssets returns correct value", async () => {
      // 50 shares at price 2 = 100 assets
      const assets = await lpShare.convertToAssets(ethers.parseEther("50"));
      expect(assets).to.equal(ethers.parseEther("100"));
    });

    it("previewDeposit returns expected shares", async () => {
      const shares = await lpShare.previewDeposit(ethers.parseEther("100"));
      expect(shares).to.equal(ethers.parseEther("50"));
    });

    it("previewRedeem returns expected assets", async () => {
      const assets = await lpShare.previewRedeem(ethers.parseEther("50"));
      expect(assets).to.equal(ethers.parseEther("100"));
    });

    it("totalAssets returns vault NAV", async () => {
      const totalAssets = await lpShare.totalAssets();
      expect(totalAssets).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("ERC20 functionality", () => {
    it("starts with zero total supply", async () => {
      const totalSupply = await lpShare.totalSupply();
      expect(totalSupply).to.equal(0n);
    });

    it("returns 18 decimals", async () => {
      expect(await lpShare.decimals()).to.equal(18);
    });
  });

  describe("Edge cases", () => {
    describe("price = 0 fallback", () => {
      beforeEach(async () => {
        // Set vault with price = 0 (not seeded)
        await core.harnessSetLpVault(0n, 0n, 0n, 0n, false);
      });

      it("convertToShares returns 1:1 when price is 0", async () => {
        const assets = ethers.parseEther("100");
        const shares = await lpShare.convertToShares(assets);
        expect(shares).to.equal(assets);
      });

      it("convertToAssets returns 1:1 when price is 0", async () => {
        const shares = ethers.parseEther("100");
        const assets = await lpShare.convertToAssets(shares);
        expect(assets).to.equal(shares);
      });

      it("previewDeposit returns 1:1 when price is 0", async () => {
        const assets = ethers.parseEther("100");
        const shares = await lpShare.previewDeposit(assets);
        expect(shares).to.equal(assets);
      });

      it("previewRedeem returns 1:1 when price is 0", async () => {
        const shares = ethers.parseEther("100");
        const assets = await lpShare.previewRedeem(shares);
        expect(assets).to.equal(shares);
      });
    });

    describe("zero input", () => {
      beforeEach(async () => {
        await core.harnessSetLpVault(
          ethers.parseEther("1000"),
          ethers.parseEther("500"),
          ethers.parseEther("2"),
          ethers.parseEther("2"),
          true
        );
      });

      it("convertToShares(0) returns 0", async () => {
        expect(await lpShare.convertToShares(0n)).to.equal(0n);
      });

      it("convertToAssets(0) returns 0", async () => {
        expect(await lpShare.convertToAssets(0n)).to.equal(0n);
      });

      it("previewDeposit(0) returns 0", async () => {
        expect(await lpShare.previewDeposit(0n)).to.equal(0n);
      });

      it("previewRedeem(0) returns 0", async () => {
        expect(await lpShare.previewRedeem(0n)).to.equal(0n);
      });
    });

    describe("totalAssets fallback", () => {
      it("returns vault NAV when available", async () => {
        await core.harnessSetLpVault(
          ethers.parseEther("1000"),
          ethers.parseEther("500"),
          ethers.parseEther("2"),
          ethers.parseEther("2"),
          true
        );
        expect(await lpShare.totalAssets()).to.equal(ethers.parseEther("1000"));
      });
    });
  });
});
