import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { IcicleOptionsCore } from '../../typechain-types';
import { USDC_DECIMALS, WAD, uniformFactors } from "../helpers/constants";
import { deploySeedData } from "../helpers";

describe("Operator Access Control", () => {
  async function deployOperatorFixture() {
    const [owner, operator, outsider] = await ethers.getSigners();

    const payment = await (await ethers.getContractFactory("IcicleOptionsUSDToken")).deploy();
    const fundAmount = ethers.parseUnits("1000000", USDC_DECIMALS);
    await payment.transfer(operator.address, fundAmount);
    await payment.transfer(outsider.address, fundAmount);

    const feePolicy = await (await ethers.getContractFactory("MockFeePolicy")).deploy(0);
    const lazyLib = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();

    const oracleModule = await (await ethers.getContractFactory("OracleModuleHarness")).deploy();
    const tradeModule = await (await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })).deploy();
    const lifecycleModule = await (await ethers.getContractFactory("MarketLifecycleModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })).deploy();
    const lpVaultModule = await (await ethers.getContractFactory("LPVaultModule")).deploy();
    const riskModule = await (await ethers.getContractFactory("RiskModule")).deploy();

    const coreImpl = await (await ethers.getContractFactory("IcicleOptionsCoreHarness", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })).deploy();
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
    await payment.connect(owner).approve(core.target, ethers.MaxUint256);
    await payment.connect(operator).approve(core.target, ethers.MaxUint256);
    await payment.connect(outsider).approve(core.target, ethers.MaxUint256);
    await core.connect(owner).seedVault(ethers.parseUnits("100000", USDC_DECIMALS));

    return { core, owner, operator, outsider, feePolicy, lifecycleModule };
  }

  function buildMarketParams(now: number, feePolicyAddress: string, seedData: string) {
    return {
      minTick: 0,
      maxTick: 4,
      tickSpacing: 1,
      start: now - 100,
      end: now + 10000,
      settlement: now + 10100,
      numBins: 4,
      liquidityParameter: WAD,
      feePolicyAddress,
      seedData,
    };
  }

  it("owner manages operator allowlist; zero address rejected", async () => {
    const { core, owner, operator, outsider } = await loadFixture(deployOperatorFixture);

    await expect(core.connect(outsider).setOperator(operator.address, true))
      .to.be.revertedWithCustomError(core, "OwnableUnauthorizedAccount");

    await expect(core.connect(owner).setOperator(ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(core, "ZeroAddress");

    await expect(core.connect(owner).setOperator(operator.address, true))
      .to.emit(core, "OperatorUpdated")
      .withArgs(operator.address, true);

    expect(await core.operators(operator.address)).to.equal(true);

    await expect(core.connect(owner).setOperator(operator.address, false))
      .to.emit(core, "OperatorUpdated")
      .withArgs(operator.address, false);

    expect(await core.operators(operator.address)).to.equal(false);
  });

  it("gates createMarket to owner/operator", async () => {
    const { core, owner, operator, outsider, feePolicy } = await loadFixture(
      deployOperatorFixture
    );

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const seedData = await deploySeedData(uniformFactors(4));
    const params = buildMarketParams(now, feePolicy.target.toString(), await seedData.getAddress());

    await expect(
      core.connect(outsider).createMarket(
        params.minTick,
        params.maxTick,
        params.tickSpacing,
        params.start,
        params.end,
        params.settlement,
        params.numBins,
        params.liquidityParameter,
        params.feePolicyAddress,
        params.seedData
      )
    ).to.be.revertedWithCustomError(core, "UnauthorizedCaller").withArgs(outsider.address);

    await expect(
      core.connect(owner).createMarket(
        params.minTick,
        params.maxTick,
        params.tickSpacing,
        params.start,
        params.end,
        params.settlement,
        params.numBins,
        params.liquidityParameter,
        params.feePolicyAddress,
        params.seedData
      )
    ).to.not.be.reverted;

    await core.connect(owner).setOperator(operator.address, true);
    const operatorSeed = await deploySeedData(uniformFactors(4));
    const operatorParams = buildMarketParams(
      now + 1,
      feePolicy.target.toString(),
      await operatorSeed.getAddress()
    );

    await expect(
      core.connect(operator).createMarket(
        operatorParams.minTick,
        operatorParams.maxTick,
        operatorParams.tickSpacing,
        operatorParams.start,
        operatorParams.end,
        operatorParams.settlement,
        operatorParams.numBins,
        operatorParams.liquidityParameter,
        operatorParams.feePolicyAddress,
        operatorParams.seedData
      )
    ).to.not.be.reverted;
  });

  it("gates seedNextChunks to owner/operator", async () => {
    const { core, owner, operator, outsider, feePolicy, lifecycleModule } = await loadFixture(
      deployOperatorFixture
    );

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const seedData = await deploySeedData(uniformFactors(4));
    const params = buildMarketParams(now, feePolicy.target.toString(), await seedData.getAddress());

    const marketId = await core.createMarket.staticCall(
      params.minTick,
      params.maxTick,
      params.tickSpacing,
      params.start,
      params.end,
      params.settlement,
      params.numBins,
      params.liquidityParameter,
      params.feePolicyAddress,
      params.seedData
    );
    await core.createMarket(
      params.minTick,
      params.maxTick,
      params.tickSpacing,
      params.start,
      params.end,
      params.settlement,
      params.numBins,
      params.liquidityParameter,
      params.feePolicyAddress,
      params.seedData
    );

    await expect(
      core.connect(outsider).seedNextChunks(marketId, 1)
    ).to.be.revertedWithCustomError(core, "UnauthorizedCaller").withArgs(outsider.address);

    await core.connect(owner).setOperator(operator.address, true);
    const lifecycleEvents = lifecycleModule.attach(await core.getAddress());

    await expect(core.connect(operator).seedNextChunks(marketId, 1))
      .to.emit(lifecycleEvents, "MarketSeedingProgress");

    await expect(core.connect(owner).seedNextChunks(marketId, 3))
      .to.emit(lifecycleEvents, "MarketSeeded");
  });

  it("gates settlement ops to owner/operator", async () => {
    const { core, owner, operator, outsider, lifecycleModule } = await loadFixture(
      deployOperatorFixture
    );

    await core.connect(owner).setOperator(operator.address, true);

    await expect(core.connect(outsider).finalizePrimarySettlement(999))
      .to.be.revertedWithCustomError(core, "UnauthorizedCaller")
      .withArgs(outsider.address);
    await expect(core.connect(operator).finalizePrimarySettlement(999))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);
    await expect(core.connect(owner).finalizePrimarySettlement(999))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);

    await expect(core.connect(outsider).markSettlementFailed(999))
      .to.be.revertedWithCustomError(core, "UnauthorizedCaller")
      .withArgs(outsider.address);
    await expect(core.connect(operator).markSettlementFailed(999))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);
    await expect(core.connect(owner).markSettlementFailed(999))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);

    await expect(core.connect(outsider).requestSettlementChunks(999, 1))
      .to.be.revertedWithCustomError(core, "UnauthorizedCaller")
      .withArgs(outsider.address);
    await expect(core.connect(operator).requestSettlementChunks(999, 1))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);
    await expect(core.connect(owner).requestSettlementChunks(999, 1))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);
  });

  it("finalizeSecondarySettlement is owner-only, rejects operator", async () => {
    const { core, owner, operator, lifecycleModule } = await loadFixture(
      deployOperatorFixture
    );

    await core.connect(owner).setOperator(operator.address, true);

    // operator is rejected with OwnableUnauthorizedAccount
    await expect(core.connect(operator).finalizeSecondarySettlement(999, 100n))
      .to.be.revertedWithCustomError(core, "OwnableUnauthorizedAccount")
      .withArgs(operator.address);

    // owner passes access control but fails on MarketNotFound
    await expect(core.connect(owner).finalizeSecondarySettlement(999, 100n))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);
  });

  it("pause: operator can pause; unpause is owner-only", async () => {
    const { core, owner, operator, outsider } = await loadFixture(
      deployOperatorFixture
    );

    await core.connect(owner).setOperator(operator.address, true);

    await expect(core.connect(outsider).pause())
      .to.be.revertedWithCustomError(core, "UnauthorizedCaller")
      .withArgs(outsider.address);

    await expect(core.connect(operator).pause())
      .to.emit(core, "Paused")
      .withArgs(operator.address);

    await expect(core.connect(operator).unpause())
      .to.be.revertedWithCustomError(core, "OwnableUnauthorizedAccount")
      .withArgs(operator.address);

    await expect(core.connect(owner).unpause())
      .to.emit(core, "Unpaused")
      .withArgs(owner.address);
  });

  it("pause blocks requestDeposit but allows claimWithdraw", async () => {
    const { core, owner, operator } = await loadFixture(deployOperatorFixture);

    await core.connect(owner).setOperator(operator.address, true);

    const currentBatchId = await core.getCurrentBatchId();
    const batch1 = currentBatchId + 1n;
    const batch2 = currentBatchId + 2n;

    // Create a withdrawal claim for batch2 (withdrawalLagBatches=1 in fixture).
    await core.connect(owner).requestWithdraw(ethers.parseEther("1000"));
    await core.connect(owner).harnessSetBatchMarketState(batch1, 1n, 1n);
    await core.connect(owner).harnessSetBatchMarketState(batch2, 1n, 1n);
    await core.connect(owner).processDailyBatch(batch1);
    await core.connect(owner).processDailyBatch(batch2);

    await core.connect(operator).pause();

    // requestDeposit is guarded by whenNotPaused, so should revert while paused.
    await expect(core.connect(operator).requestDeposit(ethers.parseUnits("10", USDC_DECIMALS)))
      .to.be.revertedWithCustomError(core, "EnforcedPause");

    // claimWithdraw must remain available during pause (user funds are claimable post-batch).
    await expect(core.connect(owner).claimWithdraw(0n)).to.not.be.reverted;

    await core.connect(owner).unpause();
  });

  it("pause: operator can pause; while paused only owner can processDailyBatch", async () => {
    const { core, owner, operator } = await loadFixture(deployOperatorFixture);

    await core.connect(owner).setOperator(operator.address, true);

    const currentBatchId = await core.getCurrentBatchId();
    const nextBatchId = currentBatchId + 1n;

    await core.connect(operator).pause();
    await expect(core.connect(operator).processDailyBatch(nextBatchId))
      .to.be.revertedWithCustomError(core, "UnauthorizedCaller")
      .withArgs(operator.address);

    await expect(core.connect(owner).processDailyBatch(nextBatchId)).to.not.be.reverted;
    expect(await core.getCurrentBatchId()).to.equal(nextBatchId);

    await core.connect(owner).unpause();
  });

  it("pause: operator can pause; while paused only owner can markSettlementFailed", async () => {
    const { core, owner, operator, feePolicy, lifecycleModule } = await loadFixture(
      deployOperatorFixture
    );

    await core.connect(owner).setOperator(operator.address, true);

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const seedData = await deploySeedData(uniformFactors(4));
    const params = buildMarketParams(
      now,
      feePolicy.target.toString(),
      await seedData.getAddress()
    );

    const marketId = await core.createMarket.staticCall(
      params.minTick,
      params.maxTick,
      params.tickSpacing,
      params.start,
      params.end,
      params.settlement,
      params.numBins,
      params.liquidityParameter,
      params.feePolicyAddress,
      params.seedData
    );
    await core.createMarket(
      params.minTick,
      params.maxTick,
      params.tickSpacing,
      params.start,
      params.end,
      params.settlement,
      params.numBins,
      params.liquidityParameter,
      params.feePolicyAddress,
      params.seedData
    );

    await core.connect(operator).pause();

    const lifecycleEvents = lifecycleModule.attach(await core.getAddress());
    const submitWindow = Number(await core.settlementSubmitWindow());
    const opsStart = params.settlement + submitWindow;
    const failedAt = opsStart + 1;

    await expect(core.connect(operator).markSettlementFailed(marketId))
      .to.be.revertedWithCustomError(core, "UnauthorizedCaller")
      .withArgs(operator.address);

    await time.setNextBlockTimestamp(failedAt);
    await expect(core.connect(owner).markSettlementFailed(marketId))
      .to.emit(lifecycleEvents, "MarketFailed")
      .withArgs(marketId, BigInt(failedAt));

    await core.connect(owner).unpause();
  });

  it("updateMarketTiming is owner-only, rejects operator", async () => {
    const { core, owner, operator, lifecycleModule } = await loadFixture(
      deployOperatorFixture
    );

    await core.connect(owner).setOperator(operator.address, true);

    // operator is rejected with OwnableUnauthorizedAccount
    await expect(core.connect(operator).updateMarketTiming(999, 100, 200, 300))
      .to.be.revertedWithCustomError(core, "OwnableUnauthorizedAccount")
      .withArgs(operator.address);

    // owner passes access control but fails on MarketNotFound
    await expect(core.connect(owner).updateMarketTiming(999, 100, 200, 300))
      .to.be.revertedWithCustomError(lifecycleModule, "MarketNotFound")
      .withArgs(999);
  });
});
