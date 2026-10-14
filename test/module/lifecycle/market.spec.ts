import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { LPVaultModule, MarketLifecycleModule, OracleModule, IcicleOptionsCoreHarness, IcicleOptionsCore, IcicleOptionsLPShare, TradeModule } from '../../../typechain-types';
import { IIcicleOptionsCore } from "../../../typechain-types/contracts/testonly/TradeModuleHarness";
import {
  DATA_FEED_ID,
  FEED_DECIMALS,
  authorisedWallets,
  buildRedstonePayload,
  submitWithPayload,
  toSettlementValue,
} from "../../helpers/redstone";

const WAD = ethers.parseEther("1");

function cloneMarket(
  market: IIcicleOptionsCore.MarketStruct,
  overrides: Partial<IIcicleOptionsCore.MarketStruct> = {}
): IIcicleOptionsCore.MarketStruct {
  return {
    isSeeded: market.isSeeded,
    settled: market.settled,
    snapshotChunksDone: market.snapshotChunksDone,
    failed: market.failed,
    numBins: market.numBins,
    openPositionCount: market.openPositionCount,
    snapshotChunkCursor: market.snapshotChunkCursor,
    seedCursor: market.seedCursor,
    startTimestamp: market.startTimestamp,
    endTimestamp: market.endTimestamp,
    settlementTimestamp: market.settlementTimestamp,
    settlementFinalizedAt: market.settlementFinalizedAt,
    minTick: market.minTick,
    maxTick: market.maxTick,
    tickSpacing: market.tickSpacing,
    settlementTick: market.settlementTick,
    settlementValue: market.settlementValue,
    liquidityParameter: market.liquidityParameter,
    feePolicy: market.feePolicy,
    seedData: market.seedData,
    initialRootSum: market.initialRootSum,
    accumulatedFees: market.accumulatedFees,
    minFactor: market.minFactor ?? WAD,
    deltaEt: market.deltaEt ?? 0n,
    dynamicEnabled: false,
    anchorCenterBin: 0,
    cachedOracleTs: 0,
    cachedOracleTick: 0,
    perBinCap: 0,
    accumulatedPremiums: 0n,
    accumulatedProceeds: 0n,
    dynW: 0n,
    dynVolBinsWad: 0n,
    dynSigmaMinWad: 0n,
    dynSigmaMaxWad: 0n,
    dynFloorWad: 0n,
    ...overrides,
  };
}

// Redstone feed config (for setRedstoneConfig)
const FEED_ID = ethers.encodeBytes32String(DATA_FEED_ID);
const MAX_SAMPLE_DISTANCE = 600n; // 10 min
const FUTURE_TOLERANCE = 60n; // 1 min

// Human price value (maps to tick 2 with proper market config)
// Redstone encodes as 2 * 10^8 = 200_000_000
// On-chain extraction: 200_000_000
// SettlementValue = 200_000_000 / 100 = 2_000_000 (6 decimals)
const HUMAN_PRICE = 2;

describe("MarketLifecycleModule", () => {
  async function setup() {
    const [owner] = await ethers.getSigners();
    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    const position = await (
      await ethers.getContractFactory("MockIcicleOptionsPosition")
    ).deploy();
    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();

    const lifecycleImpl = (await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy()) as MarketLifecycleModule;
    // Use OracleModuleHarness to allow Hardhat local signers for Redstone verification
    const oracleModule = (await (
      await ethers.getContractFactory("OracleModuleHarness")
    ).deploy()) as OracleModule;
    const vaultModule = (await (
      await ethers.getContractFactory("LPVaultModule")
    ).deploy()) as LPVaultModule;
    const riskModule = await (
      await ethers.getContractFactory("RiskModule")
    ).deploy();

    const coreImpl = (await (
      await ethers.getContractFactory("IcicleOptionsCoreHarness", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy()) as IcicleOptionsCoreHarness;
    const tradeModule = (await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy()) as TradeModule;

    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);

    const lpShareImpl = await (
      await ethers.getContractFactory("IcicleOptionsLPShare")
    ).deploy();
    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const lpShareProxy = await proxyFactory.deploy(
      await lpShareImpl.getAddress(),
      "0x"
    );
    const coreProxy = await proxyFactory.deploy(coreImpl.target, "0x");
    const lpShare = (await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    )) as IcicleOptionsLPShare;
    const core = (await ethers.getContractAt(
      "IcicleOptionsCoreHarness",
      await coreProxy.getAddress()
    )) as IcicleOptionsCoreHarness;

    const submitWindow = 120;
    const opsWindow = 60;
    const claimDelay = submitWindow + opsWindow;
    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: payment.target.toString(),
      positionContract: position.target.toString(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: tradeModule.target.toString(),
      lifecycleModule: lifecycleImpl.target.toString(),
      riskModule: riskModule.target.toString(),
      vaultModule: vaultModule.target.toString(),
      oracleModule: oracleModule.target.toString(),
      ownerSafe: owner.address,
      settlementSubmitWindow: submitWindow,
      pendingOpsWindow: opsWindow,
      claimDelaySeconds: claimDelay,
      redstoneFeedId: FEED_ID,
      redstoneFeedDecimals: FEED_DECIMALS,
      maxSampleDistance: MAX_SAMPLE_DISTANCE,
      futureTolerance: FUTURE_TOLERANCE,
      lambda: ethers.parseEther("0.2"),
      kDrawdown: ethers.parseEther("1"),
      enforceAlpha: false,
      rhoBS: 0n,
      phiLP: WAD,
      phiBS: 0n,
      phiTR: 0n,
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

    await payment.approve(await core.getAddress(), ethers.MaxUint256);

    return {
      owner,
      core,
      lifecycle: lifecycleImpl,
      oracleModule,
      vaultModule,
      lazyLib,
      feePolicy,
    };
  }

  async function createDefaultMarket(
    core: IcicleOptionsCoreHarness,
    feePolicyAddress: string
  ) {
    const now = BigInt(await time.latest());
    const start = now - 100n;
    const end = now + 200n;
    const marketId = await core.createMarketUniform.staticCall(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(end),
      4,
      ethers.parseEther("1"),
      feePolicyAddress
    );
    await core.createMarketUniform(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(end),
      4,
      ethers.parseEther("1"),
      feePolicyAddress
    );
    return { start, end, marketId };
  }

  it("creates market and seeds tree via chunks", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    const now = BigInt(await time.latest());
    const start = now + 10n;
    const end = start + 100n;
    const settlementTs = end + 50n;

    const lifecycleEvents = lifecycle.attach(await core.getAddress());

    const expectedFactors = [WAD, WAD, WAD, WAD];
    const packedFactors = ethers.solidityPacked(
      Array(expectedFactors.length).fill("uint256"),
      expectedFactors
    );
    const seedData = await (
      await ethers.getContractFactory("SeedData")
    ).deploy(packedFactors);
    await seedData.waitForDeployment();

    const marketId = await core.createMarket.staticCall(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(settlementTs),
      4,
      ethers.parseEther("1"),
      feePolicy.target.toString(),
      seedData.target
    );
    const tx = await core.createMarket(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(settlementTs),
      4,
      ethers.parseEther("1"),
      feePolicy.target.toString(),
      seedData.target
    );
    await expect(tx).to.emit(lifecycleEvents, "MarketCreated");
    const seedTx = await core.seedNextChunks(marketId, 4);
    await expect(seedTx)
      .to.emit(lifecycleEvents, "MarketSeedingProgress")
      .withArgs(marketId, 0, 4, expectedFactors);
    await expect(seedTx).to.emit(lifecycleEvents, "MarketSeeded").withArgs(marketId);

    let market = await core.markets(marketId);
    expect(market.isSeeded).to.equal(true);
    expect(market.numBins).to.equal(4);
    expect(market.liquidityParameter).to.equal(ethers.parseEther("1"));
    expect(await core.harnessGetTreeSize(marketId)).to.equal(4);
    expect(await core.harnessGetTreeSum(marketId)).to.equal(4n * 10n ** 18n);
  });

  it("reverts seeding for unknown market", async () => {
    const { core, lifecycle } = await setup();
    await expect(core.seedNextChunks(1, 1)).to.be.revertedWithCustomError(
      lifecycle,
      "MarketNotFound"
    );
  });

  it("seeds in multiple chunks and completes only on final chunk", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    const now = BigInt(await time.latest());
    const start = now + 10n;
    const end = start + 100n;
    const settlementTs = end + 50n;

    await core.fundBackstop(ethers.parseUnits("1000000", 6));

    const lifecycleEvents = lifecycle.attach(await core.getAddress());

    const factors = [WAD, WAD * 2n, WAD * 3n, WAD * 4n, WAD * 5n];
    const packedFactors = ethers.solidityPacked(
      Array(factors.length).fill("uint256"),
      factors
    );
    const seedData = await (
      await ethers.getContractFactory("SeedData")
    ).deploy(packedFactors);
    await seedData.waitForDeployment();

    const marketId = await core.createMarket.staticCall(
      0,
      5,
      1,
      Number(start),
      Number(end),
      Number(settlementTs),
      5,
      ethers.parseEther("1"),
      feePolicy.target.toString(),
      seedData.target
    );
    await core.createMarket(
      0,
      5,
      1,
      Number(start),
      Number(end),
      Number(settlementTs),
      5,
      ethers.parseEther("1"),
      feePolicy.target.toString(),
      seedData.target
    );

    await expect(core.seedNextChunks(marketId, 0)).to.be.revertedWithCustomError(
      lifecycle,
      "ZeroLimit"
    );

    const seedTx1 = await core.seedNextChunks(marketId, 2);
    await expect(seedTx1)
      .to.emit(lifecycleEvents, "MarketSeedingProgress")
      .withArgs(marketId, 0, 2, factors.slice(0, 2));
    await expect(seedTx1).to.not.emit(lifecycleEvents, "MarketSeeded");

    let market = await core.markets(marketId);
    expect(market.seedCursor).to.equal(2);
    expect(market.isSeeded).to.equal(false);

    const seedTx2 = await core.seedNextChunks(marketId, 2);
    await expect(seedTx2)
      .to.emit(lifecycleEvents, "MarketSeedingProgress")
      .withArgs(marketId, 2, 2, factors.slice(2, 4));
    await expect(seedTx2).to.not.emit(lifecycleEvents, "MarketSeeded");

    market = await core.markets(marketId);
    expect(market.seedCursor).to.equal(4);
    expect(market.isSeeded).to.equal(false);

    const seedTx3 = await core.seedNextChunks(marketId, 10);
    await expect(seedTx3)
      .to.emit(lifecycleEvents, "MarketSeedingProgress")
      .withArgs(marketId, 4, 1, factors.slice(4, 5));
    await expect(seedTx3).to.emit(lifecycleEvents, "MarketSeeded").withArgs(marketId);

    market = await core.markets(marketId);
    expect(market.seedCursor).to.equal(5);
    expect(market.isSeeded).to.equal(true);

    await expect(core.seedNextChunks(marketId, 1)).to.be.revertedWithCustomError(
      lifecycle,
      "SeedAlreadyComplete"
    );
  });

  it("rejects invalid market parameters and time ranges", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    await expect(
      core.createMarketUniform(
        0,
        0,
        1,
        0,
        1,
        1,
        1,
        ethers.parseEther("1"),
        feePolicy.target.toString()
      )
    ).to.be.revertedWithCustomError(lifecycle, "InvalidMarketParameters");

    await expect(
      core.createMarketUniform(
        0,
        4,
        0,
        0,
        1,
        1,
        1,
        ethers.parseEther("1"),
        feePolicy.target.toString()
      )
    ).to.be.revertedWithCustomError(lifecycle, "InvalidMarketParameters");

    await expect(
      core.createMarketUniform(
        0,
        4,
        1,
        10,
        5,
        5,
        4,
        ethers.parseEther("1"),
        feePolicy.target.toString()
      )
    ).to.be.revertedWithCustomError(lifecycle, "InvalidTimeRange");

    await expect(
      core.createMarketUniform(
        0,
        4,
        1,
        0,
        10,
        5,
        4,
        ethers.parseEther("1"),
        feePolicy.target.toString()
      )
    ).to.be.revertedWithCustomError(lifecycle, "InvalidTimeRange");

    await expect(
      core.createMarketUniform(0, 4, 1, 0, 10, 10, 4, 0, feePolicy.target.toString())
    ).to.be.revertedWithCustomError(lifecycle, "InvalidLiquidityParameter");
  });

  it("reverts when fee policy is zero", async () => {
    const { core, lifecycle } = await setup();
    const now = await time.latest();
    await expect(
      core.createMarketUniform(
        0,
        4,
        1,
        now + 10,
        now + 100,
        now + 150,
        4,
        ethers.parseEther("1"),
        ethers.ZeroAddress
      )
    ).to.be.revertedWithCustomError(lifecycle, "ZeroAddress");
  });

  it("settles market when candidate exists and marks snapshot state", async () => {
    const { core, lifecycle, oracleModule, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const lifecycleEvents = lifecycle.attach(await core.getAddress());

    // Submit oracle candidate during settlement window
    const candidateTs = end + 10n;
    await time.setNextBlockTimestamp(Number(candidateTs + 1n));
    const payload = buildRedstonePayload(HUMAN_PRICE, Number(candidateTs), authorisedWallets);
    await submitWithPayload(core, (await ethers.getSigners())[0], 1, payload);

    // Set open positions to keep snapshotChunksDone false
    const marketBefore = await core.markets(1);
    await core.harnessSetMarket(
      1,
      cloneMarket(marketBefore, { openPositionCount: 10 })
    );

    // Finalize after PendingOps ends (submitWindow=120, pendingOpsWindow=60)
    // tSet = end for this market
    const tSet = end;
    const opsEnd = tSet + 120n + 60n;
    await time.setNextBlockTimestamp(Number(opsEnd + 1n));
    await expect(core.finalizePrimarySettlement(1)).to.emit(
      lifecycleEvents,
      "MarketSettled"
    );

    const market = await core.markets(1);
    expect(market.settled).to.equal(true);
    expect(market.settlementValue).to.equal(toSettlementValue(HUMAN_PRICE));
    expect(market.snapshotChunkCursor).to.equal(0);
    expect(market.snapshotChunksDone).to.equal(false);

    // Candidate should be cleared after settlement
    await expect(core.getSettlementPrice(1)).to.be.revertedWithCustomError(
      oracleModule,
      "SettlementOracleCandidateMissing"
    );
  });

  it("finalizePrimary enforces candidate and window checks", async () => {
    const { core, lifecycle, oracleModule, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const tSet = end; // settlementTimestamp = endTimestamp
    const opsEnd = tSet + 120n + 60n; // submitWindow + pendingOpsWindow

    const owner = (await ethers.getSigners())[0];
    
    // Test 1: Submit before Tset: should revert
    const earlyBlockTs = tSet - 1n;
    await time.setNextBlockTimestamp(Number(earlyBlockTs));
    const earlyPayload = buildRedstonePayload(HUMAN_PRICE, Number(earlyBlockTs), authorisedWallets);
    await expect(
      submitWithPayload(core, owner, 1, earlyPayload)
    ).to.be.revertedWithCustomError(oracleModule, "OracleSampleTooEarly");

    // Test 2: Valid candidate submission within window
    const goodTs = tSet + 10n;
    await time.setNextBlockTimestamp(Number(goodTs + 1n));
    const goodPayload = buildRedstonePayload(HUMAN_PRICE, Number(goodTs), authorisedWallets);
    await submitWithPayload(core, owner, 1, goodPayload);
    
    // Test 3: Finalize before opsStart: should revert with PendingOpsNotStarted
    await time.setNextBlockTimestamp(Number(goodTs + 10n));
    await expect(core.finalizePrimarySettlement(1)).to.be.revertedWithCustomError(
      lifecycle,
      "PendingOpsNotStarted"
    );

    // Test 4: Submit after window: should revert
    const lateBlockTs = tSet + 121n; // submitWindow = 120
    await time.setNextBlockTimestamp(Number(lateBlockTs));
    const latePayload = buildRedstonePayload(HUMAN_PRICE, Number(lateBlockTs), authorisedWallets);
    await expect(
      submitWithPayload(core, owner, 1, latePayload)
    ).to.be.revertedWithCustomError(oracleModule, "SettlementWindowClosed");
    
    // Test 5: Finalize after opsEnd: should succeed
    await time.setNextBlockTimestamp(Number(opsEnd + 2n));
    await expect(core.finalizePrimarySettlement(1)).to.emit(lifecycle.attach(await core.getAddress()), "MarketSettled");
  });

  it("finalizePrimary allows during PendingOps window", async () => {
    const { core, lifecycle, owner, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const lifecycleEvents = lifecycle.attach(await core.getAddress());

    const tSet = end;
    const candidateTs = tSet + 10n;
    await time.setNextBlockTimestamp(Number(candidateTs + 1n));
    const payload = buildRedstonePayload(
      HUMAN_PRICE,
      Number(candidateTs),
      authorisedWallets
    );
    await submitWithPayload(core, owner, 1, payload);

    const opsStart = tSet + 120n; // settlementSubmitWindow
    await time.setNextBlockTimestamp(Number(opsStart + 1n));
    await expect(core.finalizePrimarySettlement(1)).to.emit(
      lifecycleEvents,
      "MarketSettled"
    );

    const market = await core.markets(1);
    expect(market.settled).to.equal(true);
  });

  it("marks settlement failed during PendingOps window when no candidate", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const lifecycleEvents = lifecycle.attach(await core.getAddress());
    const tSet = end;
    const opsStart = tSet + 120n; // settlementSubmitWindow

    // Move to PendingOps window (no candidate submitted)
    await time.setNextBlockTimestamp(Number(opsStart + 1n));
    
    await expect(core.markSettlementFailed(1))
      .to.emit(lifecycleEvents, "MarketFailed")
      .withArgs(1, opsStart + 1n);

    const market = await core.markets(1);
    expect(market.failed).to.equal(true);
    expect(market.settled).to.equal(false);
  });

  it("rejects markSettlementFailed before PendingOps starts", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const tSet = end;

    // Before PendingOps
    await time.setNextBlockTimestamp(Number(tSet + 10n));
    await expect(core.markSettlementFailed(1))
      .to.be.revertedWithCustomError(lifecycle, "PendingOpsNotStarted");
  });

  it("rejects markSettlementFailed after PendingOps if candidate exists", async () => {
    const { core, oracleModule, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const tSet = end;
    const opsEnd = tSet + 120n + 60n;

    // Submit candidate
    const candidateTs = tSet + 10n;
    await time.setNextBlockTimestamp(Number(candidateTs + 1n));
    const payload = buildRedstonePayload(HUMAN_PRICE, Number(candidateTs), authorisedWallets);
    await submitWithPayload(core, (await ethers.getSigners())[0], 1, payload);

    // After PendingOps with candidate - should use finalize instead
    await time.setNextBlockTimestamp(Number(opsEnd + 1n));
    await expect(core.markSettlementFailed(1))
      .to.be.revertedWithCustomError(oracleModule, "SettlementOracleCandidateMissing");
  });

  it("finalizes secondary settlement for failed market", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const lifecycleEvents = lifecycle.attach(await core.getAddress());
    const tSet = end;
    const opsStart = tSet + 120n;

    // Mark as failed first
    await time.setNextBlockTimestamp(Number(opsStart + 1n));
    await core.markSettlementFailed(1);

    // Finalize secondary settlement with ops-provided value
    const settlementValue = 2_000_000n; // 2.0 in 6 decimals
    await expect(core.finalizeSecondarySettlement(1, settlementValue))
      .to.emit(lifecycleEvents, "MarketSettledSecondary");

    const market = await core.markets(1);
    expect(market.settled).to.equal(true);
    expect(market.failed).to.equal(false);
    expect(market.settlementValue).to.equal(settlementValue);
  });

  it("rejects finalizeSecondarySettlement for non-failed market", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    await createDefaultMarket(core, feePolicy.target.toString());

    await expect(core.finalizeSecondarySettlement(1, 1_000_000n))
      .to.be.revertedWithCustomError(lifecycle, "MarketNotFailed");
  });

  it("rejects finalizeSecondarySettlement for already settled market", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    const { end } = await createDefaultMarket(core, feePolicy.target.toString());
    const tSet = end;
    const opsStart = tSet + 120n;

    // Mark as failed
    await time.setNextBlockTimestamp(Number(opsStart + 1n));
    await core.markSettlementFailed(1);

    // First secondary settlement
    await core.finalizeSecondarySettlement(1, 2_000_000n);

    // Second attempt should fail
    await expect(core.finalizeSecondarySettlement(1, 1_000_000n))
      .to.be.revertedWithCustomError(lifecycle, "MarketAlreadySettled");
  });

  it("updates market timing", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    await createDefaultMarket(core, feePolicy.target.toString());

    await expect(
      core.updateMarketTiming(1, 10, 5, 5)
    ).to.be.revertedWithCustomError(lifecycle, "InvalidTimeRange");

    const now = BigInt(await time.latest());
    const start = now + 5n;
    const end = start + 10n;
    const settlement = end + 5n;

    await core.updateMarketTiming(1, Number(start), Number(end), Number(settlement));
    const market = await core.markets(1);
    expect(BigInt(market.startTimestamp)).to.equal(start);
    expect(BigInt(market.endTimestamp)).to.equal(end);
    expect(BigInt(market.settlementTimestamp)).to.equal(settlement);
  });

  it("emits settlement chunk requests and marks completion", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    await createDefaultMarket(core, feePolicy.target.toString());
    const lifecycleEvents = lifecycle.attach(await core.getAddress());

    const market = await core.markets(1);
    await core.harnessSetMarket(
      1,
      cloneMarket(market, { settled: true, openPositionCount: 1000 })
    );

    const tx1 = await core.requestSettlementChunks(1, 1);
    await expect(tx1)
      .to.emit(lifecycleEvents, "SettlementChunkRequested")
      .withArgs(1, 0);
    let updated = await core.markets(1);
    expect(updated.snapshotChunkCursor).to.equal(1);
    expect(updated.snapshotChunksDone).to.equal(false);

    const tx2 = await core.requestSettlementChunks(1, 5);
    await expect(tx2)
      .to.emit(lifecycleEvents, "SettlementChunkRequested")
      .withArgs(1, 1);
    updated = await core.markets(1);
    expect(updated.snapshotChunkCursor).to.equal(2); // ceil(1000/512)
    expect(updated.snapshotChunksDone).to.equal(true);

    await expect(
      core.requestSettlementChunks(1, 1)
    ).to.be.revertedWithCustomError(lifecycle, "SnapshotAlreadyCompleted");
  });

  it("rejects re-settlement and supports multi-chunk ordering", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    await createDefaultMarket(core, feePolicy.target.toString());
    const lifecycleEvents = lifecycle.attach(await core.getAddress());

    // Mark as settled with large openPositionCount to force multiple chunks
    const market = await core.markets(1);
    await core.harnessSetMarket(
      1,
      cloneMarket(market, {
        settled: true,
        openPositionCount: 1025, // ceil(1025/512) = 3 chunks
        snapshotChunkCursor: 0,
        snapshotChunksDone: false,
      })
    );

    await expect(core.finalizePrimarySettlement(1)).to.be.revertedWithCustomError(
      lifecycle,
      "MarketAlreadySettled"
    );

    const tx1 = await core.requestSettlementChunks(1, 2);
    await expect(tx1)
      .to.emit(lifecycleEvents, "SettlementChunkRequested")
      .withArgs(1, 0);
    await expect(tx1)
      .to.emit(lifecycleEvents, "SettlementChunkRequested")
      .withArgs(1, 1);
    let updated = await core.markets(1);
    expect(updated.snapshotChunkCursor).to.equal(2);
    expect(updated.snapshotChunksDone).to.equal(false);

    const tx2 = await core.requestSettlementChunks(1, 2);
    await expect(tx2)
      .to.emit(lifecycleEvents, "SettlementChunkRequested")
      .withArgs(1, 2);
    updated = await core.markets(1);
    expect(updated.snapshotChunkCursor).to.equal(3);
    expect(updated.snapshotChunksDone).to.equal(true);
  });

  it("handles zero open positions and chunk input validation", async () => {
    const { core, lifecycle, feePolicy } = await setup();
    await createDefaultMarket(core, feePolicy.target.toString());
    const lifecycleEvents = lifecycle.attach(await core.getAddress());
    const market = await core.markets(1);
    await core.harnessSetMarket(
      1,
      cloneMarket(market, { settled: true, openPositionCount: 0 })
    );

    await expect(
      core.requestSettlementChunks(1, 0)
    ).to.be.revertedWithCustomError(lifecycle, "ZeroLimit");

    const emitted = await core.requestSettlementChunks(1, 5);
    await expect(emitted).to.not.emit(
      lifecycleEvents,
      "SettlementChunkRequested"
    );
    const updated = await core.markets(1);
    expect(updated.snapshotChunksDone).to.equal(true);

    await core.harnessSetMarket(1, cloneMarket(market, { settled: false }));
    await expect(
      core.requestSettlementChunks(1, 1)
    ).to.be.revertedWithCustomError(lifecycle, "MarketNotSettled");
  });
});
