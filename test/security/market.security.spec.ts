import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { IcicleOptionsCore } from '../../typechain-types';
import { WAD, USDC_DECIMALS } from "../helpers/constants";
import { deploySeedData } from "../helpers";

/**
 * Market Security Tests
 *
 * Tests for:
 * - numBins hard cap enforcement (Diff array O(n) pointQuery protection)
 * - Market parameter validation
 */
describe("Market Security", () => {
  async function deploySeed(numBins: number, factors?: bigint[]) {
    const seedFactors = factors ?? Array(numBins).fill(WAD);
    return deploySeedData(seedFactors);
  }

  async function deployMarketFixture() {
    const [owner, user1] = await ethers.getSigners();

    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    const fundAmount = ethers.parseUnits("1000000", USDC_DECIMALS);
    await payment.transfer(user1.address, fundAmount);

    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);
    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();

    const oracleModule = await (
      await ethers.getContractFactory("OracleModuleHarness")
    ).deploy();
    const tradeModule = await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();
    const lifecycleModule = await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();
    const lpVaultModule = await (
      await ethers.getContractFactory("LPVaultModule")
    ).deploy();
    const riskModule = await (
      await ethers.getContractFactory("RiskModule")
    ).deploy();

    const coreImpl = await (
      await ethers.getContractFactory("IcicleOptionsCoreHarness", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();
    const positionImpl = await (
      await ethers.getContractFactory("IcicleOptionsPosition")
    ).deploy();
    const lpShareImpl = await (
      await ethers.getContractFactory("IcicleOptionsLPShare")
    ).deploy();
    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const positionProxy = await proxyFactory.deploy(positionImpl.target, "0x");
    const lpShareProxy = await proxyFactory.deploy(lpShareImpl.target, "0x");
    const coreProxy = await proxyFactory.deploy(coreImpl.target, "0x");

    const position = await ethers.getContractAt(
      "IcicleOptionsPosition",
      await positionProxy.getAddress()
    );
    const lpShare = await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    );
    const core = await ethers.getContractAt(
      "IcicleOptionsCoreHarness",
      await coreProxy.getAddress()
    );

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
      phiLP: ethers.parseEther("0.8"),
      phiBS: ethers.parseEther("0.1"),
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
    await payment.connect(owner).approve(core.target, ethers.MaxUint256);
    await core.connect(owner).seedVault(ethers.parseUnits("100000", USDC_DECIMALS));

    return { core, payment, owner, user1, feePolicy, lifecycleModule };
  }

  describe("numBins Hard Cap", () => {
    it("rejects market where maxTick + tickSpacing would overflow int256", async () => {
      const { core, owner, feePolicy, lifecycleModule } = await loadFixture(
        deployMarketFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const numBins = 4;
      const tickSpacing = 1n;
      const maxInt256 = (1n << 255n) - 1n;
      const maxTick = maxInt256;
      const minTick = maxTick - 4n;
      const seedData = await deploySeed(numBins);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.be.revertedWithCustomError(lifecycleModule, "InvalidMarketParameters");
    });

    it("rejects market where tick span exceeds uint32 bins (truncation guard)", async () => {
      const { core, owner, feePolicy, lifecycleModule } = await loadFixture(
        deployMarketFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const numBins = 4;
      const minTick = 0n;
      const maxTick = (1n << 32n) + 4n;
      const tickSpacing = 1n;
      const seedData = await deploySeed(numBins);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.be.revertedWithCustomError(lifecycleModule, "InvalidMarketParameters");
    });

    it("rejects market creation with numBins = 0", async () => {
      const { core, owner, feePolicy, lifecycleModule } = await loadFixture(
        deployMarketFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Try to create market with 0 bins
      const numBins = 0;
      const minTick = 0;
      const maxTick = 10;
      const tickSpacing = 1;

      const factors: bigint[] = []; // Empty for 0 bins
      const seedData = await deploySeed(numBins, factors);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.be.revertedWithCustomError(lifecycleModule, "BinCountExceedsLimit");
    });

    it("rejects market creation with numBins > 256", async () => {
      const { core, owner, feePolicy, lifecycleModule } = await loadFixture(
        deployMarketFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Try to create market with 257 bins (exceeds 256 cap)
      const numBins = 257;
      const minTick = 0;
      const maxTick = numBins; // maxTick = minTick + numBins * tickSpacing
      const tickSpacing = 1;

      const seedData = await deploySeed(numBins);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.be.revertedWithCustomError(lifecycleModule, "BinCountExceedsLimit");
    });

    it("allows market creation with numBins = 256", async () => {
      const { core, owner, feePolicy } = await loadFixture(deployMarketFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Create market with exactly 256 bins (at the limit)
      const numBins = 256;
      const minTick = 0;
      const maxTick = numBins;
      const tickSpacing = 1;

      const factors = Array(numBins).fill(WAD);
      const seedData = await deploySeed(numBins, factors);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("allows market creation with numBins = 100 (typical use case)", async () => {
      const { core, owner, feePolicy } = await loadFixture(deployMarketFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Create market with 100 bins (typical use case)
      const numBins = 100;
      const minTick = 0;
      const maxTick = numBins;
      const tickSpacing = 1;

      const factors = Array(numBins).fill(WAD);
      const seedData = await deploySeed(numBins, factors);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("allows market creation with numBins = 2 (minimum valid)", async () => {
      const { core, owner, feePolicy } = await loadFixture(deployMarketFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Create market with 2 bins (minimum valid per RiskMath: numBins > 1)
      const numBins = 2;
      const minTick = 0;
      const maxTick = numBins;
      const tickSpacing = 1;

      const factors = Array(numBins).fill(WAD);
      const seedData = await deploySeed(numBins, factors);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.not.be.reverted;
    });

    it("rejects market with large numBins that would DoS settlement", async () => {
      const { core, owner, feePolicy } = await loadFixture(
        deployMarketFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Try to create market with 1000 bins (would DoS pointQuery)
      const numBins = 1000;
      const minTick = 0;
      const maxTick = numBins;
      const tickSpacing = 1;

      const seedData = await deploySeed(256);

      await expect(
        core.connect(owner).createMarket(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString(),
          await seedData.getAddress()
        )
      ).to.be.revertedWithCustomError(core, "SeedDataLengthMismatch");
    });
  });

  describe("createMarketUniform also enforces cap", () => {
    it("rejects uniform market with numBins = 0", async () => {
      const { core, owner, feePolicy, lifecycleModule } = await loadFixture(
        deployMarketFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Try to create uniform market with 0 bins
      const numBins = 0;
      const minTick = 0;
      const maxTick = 10;
      const tickSpacing = 1;

      await expect(
        core.connect(owner).createMarketUniform(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString()
        )
      ).to.be.revertedWithCustomError(lifecycleModule, "BinCountExceedsLimit");
    });

    it("rejects uniform market with numBins > 256", async () => {
      const { core, owner, feePolicy, lifecycleModule } = await loadFixture(
        deployMarketFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;

      // Try to create uniform market with 300 bins
      const numBins = 300;
      const minTick = 0;
      const maxTick = numBins;
      const tickSpacing = 1;

      await expect(
        core.connect(owner).createMarketUniform(
          minTick,
          maxTick,
          tickSpacing,
          now - 100,
          now + 10000,
          now + 10100,
          numBins,
          WAD,
          feePolicy.target.toString()
        )
      ).to.be.revertedWithCustomError(lifecycleModule, "BinCountExceedsLimit");
    });
  });
});
