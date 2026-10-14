import { ethers } from "hardhat";
import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  IcicleOptionsUSDToken,
  MockFeePolicy,
  TradeModuleProxy,
  TradeModule,
  IcicleOptionsPosition,
  TestERC1967Proxy,
} from "../../../typechain-types";
import { IIcicleOptionsCore } from "../../../typechain-types/contracts/testonly/TradeModuleProxy";
import { WAD } from "../../helpers/constants";

interface DeployedSystem {
  owner: HardhatEthersSigner;
  user: HardhatEthersSigner;
  otherUser: HardhatEthersSigner;
  payment: IcicleOptionsUSDToken;
  position: IcicleOptionsPosition;
  core: TradeModuleProxy;
  tradeModule: TradeModule;
  feePolicy: MockFeePolicy;
}

describe("TradeModule batchClaimPayout", () => {
  async function deploySystem(): Promise<DeployedSystem> {
    const [owner, user, otherUser] = await ethers.getSigners();

    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);

    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();
    const tradeModuleContract = await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();

    const core = await (
      await ethers.getContractFactory("TradeModuleProxy", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy(tradeModuleContract.target);

    const positionImplFactory = await ethers.getContractFactory(
      "IcicleOptionsPosition"
    );
    const positionImpl = await positionImplFactory.deploy();
    await positionImpl.waitForDeployment();
    const positionInit = positionImplFactory.interface.encodeFunctionData(
      "initialize",
      [core.target, owner.address]
    );
    const positionProxy = (await (
      await ethers.getContractFactory("TestERC1967Proxy")
    ).deploy(positionImpl.target, positionInit)) as TestERC1967Proxy;
    const position = (await ethers.getContractAt(
      "IcicleOptionsPosition",
      await positionProxy.getAddress()
    )) as IcicleOptionsPosition;

    // claimDelaySeconds = 1 for easy testing
    await core.setAddresses(payment.target, await position.getAddress(), 1, 1);

    // Fund users
    await payment.transfer(user.address, 100_000_000n); // 100 USDC
    await payment.connect(user).approve(core.target, ethers.MaxUint256);
    await payment.transfer(otherUser.address, 100_000_000n);
    await payment.connect(otherUser).approve(core.target, ethers.MaxUint256);

    const tradeModule = (await ethers.getContractAt(
      "TradeModule",
      await core.module()
    )) as unknown as TradeModule;

    return {
      owner,
      user,
      otherUser,
      payment,
      position,
      core,
      tradeModule,
      feePolicy,
    };
  }

  // Helper: create a market and return its ID
  async function createMarket(
    core: TradeModuleProxy,
    feePolicy: MockFeePolicy,
    marketId: number,
    numBins = 4
  ) {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const market: IIcicleOptionsCore.MarketStruct = {
      isSeeded: true,
      settled: false,
      snapshotChunksDone: false,
      failed: false,
      numBins,
      openPositionCount: 0,
      snapshotChunkCursor: 0,
      seedCursor: numBins,
      startTimestamp: now - 10,
      endTimestamp: now + 1000,
      settlementTimestamp: now + 1100,
      settlementFinalizedAt: 0,
      minTick: 0,
      maxTick: numBins,
      tickSpacing: 1,
      settlementTick: 0,
      settlementValue: 0,
      liquidityParameter: WAD,
      feePolicy: feePolicy.target.toString(),
      seedData: ethers.ZeroAddress,
      initialRootSum: BigInt(numBins) * WAD,
      accumulatedFees: 0n,
      minFactor: WAD,
      deltaEt: 0n,
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
      dynFloorWad: 0n, dynVersion: 0, tradingHalted: false, haltedAt: 0n,
    };
    await core.setMarket(marketId, market);
    const factors = Array(numBins).fill(WAD);
    await core.seedTree(marketId, factors);
  }

  // Helper: settle a market with a given tick, set payout reserve, and fund core
  async function settleMarket(
    core: TradeModuleProxy,
    marketId: number,
    settlementTick: number,
    payoutReserve: bigint,
    payment: IcicleOptionsUSDToken
  ) {
    // Fund core contract to cover payout reserve
    const [owner] = await ethers.getSigners();
    await payment.connect(owner).transfer(core.target, payoutReserve);
    const m = await core.markets(marketId);
    const past = BigInt(
      (await ethers.provider.getBlock("latest"))!.timestamp
    ) - 100n;
    const settledMarket: IIcicleOptionsCore.MarketStruct = {
      isSeeded: m.isSeeded,
      settled: true,
      snapshotChunksDone: m.snapshotChunksDone,
      failed: m.failed,
      numBins: m.numBins,
      openPositionCount: m.openPositionCount,
      snapshotChunkCursor: m.snapshotChunkCursor,
      seedCursor: m.seedCursor,
      startTimestamp: m.startTimestamp,
      endTimestamp: past,
      settlementTimestamp: past,
      settlementFinalizedAt: past,
      minTick: m.minTick,
      maxTick: m.maxTick,
      tickSpacing: m.tickSpacing,
      settlementTick,
      settlementValue: m.settlementValue,
      liquidityParameter: m.liquidityParameter,
      feePolicy: m.feePolicy,
      seedData: m.seedData,
      initialRootSum: m.initialRootSum,
      accumulatedFees: m.accumulatedFees,
      minFactor: m.minFactor,
      deltaEt: m.deltaEt,
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
      dynFloorWad: 0n, dynVersion: 0, tradingHalted: false, haltedAt: 0n,
    };
    await core.setMarket(marketId, settledMarket);
    await core.setPayoutReserve(marketId, payoutReserve);
  }

  // Helper: open a position and return the ID
  async function openPos(
    core: TradeModuleProxy,
    user: HardhatEthersSigner,
    position: IcicleOptionsPosition,
    marketId: number,
    lo: number,
    hi: number,
    qty: number
  ): Promise<number> {
    const nextId = Number(await position.nextId());
    await core.connect(user).openPosition(marketId, lo, hi, qty, 50_000_000);
    return nextId;
  }

  // -------------------------------------------------------
  // Happy path tests
  // -------------------------------------------------------

  it("batch claims multiple positions from the same market", async () => {
    const { user, payment, core, position, feePolicy } = await deploySystem();

    await createMarket(core, feePolicy, 1);
    // Open 3 positions in winning range [0,2) — settlementTick=1 is in [0,2)
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);
    const p2 = await openPos(core, user, position, 1, 0, 2, 2_000);
    const p3 = await openPos(core, user, position, 1, 0, 2, 3_000);

    // Settle at tick=1 (winning range [lo, hi) where lo <= 1 < hi)
    await settleMarket(core, 1, 1, 6_000n, payment); // 1000+2000+3000

    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).batchClaimPayout([p1, p2, p3]);
    const balAfter = await payment.balanceOf(user.address);

    // Total payout = 1000 + 2000 + 3000 = 6000
    expect(balAfter - balBefore).to.equal(6_000n);

    // All positions should be burned
    expect(await position.exists(p1)).to.equal(false);
    expect(await position.exists(p2)).to.equal(false);
    expect(await position.exists(p3)).to.equal(false);
  });

  it("batch claims positions from different markets", async () => {
    const { user, payment, core, position, feePolicy } = await deploySystem();

    await createMarket(core, feePolicy, 1);
    await createMarket(core, feePolicy, 2);

    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);
    const p2 = await openPos(core, user, position, 2, 0, 2, 2_000);

    // Settle both markets
    await settleMarket(core, 1, 1, 1_000n, payment);
    await settleMarket(core, 2, 1, 2_000n, payment);

    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).batchClaimPayout([p1, p2]);
    const balAfter = await payment.balanceOf(user.address);

    expect(balAfter - balBefore).to.equal(3_000n);
  });

  it("handles mix of winning and losing positions (payout=0 still burns)", async () => {
    const { user, payment, core, position, feePolicy } = await deploySystem();

    await createMarket(core, feePolicy, 1);
    // p1: range [0,2) — wins at tick=1
    // p2: range [2,4) — loses at tick=1
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);
    const p2 = await openPos(core, user, position, 1, 2, 4, 2_000);

    await settleMarket(core, 1, 1, 1_000n, payment); // Only p1 wins

    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).batchClaimPayout([p1, p2]);
    const balAfter = await payment.balanceOf(user.address);

    // Only p1 pays out
    expect(balAfter - balBefore).to.equal(1_000n);

    // Both positions burned
    expect(await position.exists(p1)).to.equal(false);
    expect(await position.exists(p2)).to.equal(false);
  });

  it("emits PositionClaimed and PositionSettled events for each position", async () => {
    const { user, payment, core, position, feePolicy, tradeModule } = await deploySystem();

    // Use TradeModule ABI at core address to check events (delegatecall emits from proxy)
    const coreAsTradeModule = tradeModule.attach(core.target) as TradeModule;

    await createMarket(core, feePolicy, 1);
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);
    const p2 = await openPos(core, user, position, 1, 0, 2, 2_000);

    await settleMarket(core, 1, 1, 3_000n, payment);

    await expect(core.connect(user).batchClaimPayout([p1, p2]))
      .to.emit(coreAsTradeModule, "PositionClaimed")
      .withArgs(p1, user.address, 1_000n)
      .to.emit(coreAsTradeModule, "PositionClaimed")
      .withArgs(p2, user.address, 2_000n)
      .to.emit(coreAsTradeModule, "PositionSettled")
      .withArgs(p1, user.address, 1_000n, true)
      .to.emit(coreAsTradeModule, "PositionSettled")
      .withArgs(p2, user.address, 2_000n, true);
  });

  // -------------------------------------------------------
  // Validation / revert tests
  // -------------------------------------------------------

  it("reverts on empty array", async () => {
    const { user, core, tradeModule } = await deploySystem();

    await expect(
      core.connect(user).batchClaimPayout([])
    ).to.be.revertedWithCustomError(tradeModule, "BatchClaimTooLarge");
  });

  it("reverts when exceeding MAX_BATCH_CLAIM (100)", async () => {
    const { user, core, tradeModule } = await deploySystem();

    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await expect(
      core.connect(user).batchClaimPayout(ids)
    ).to.be.revertedWithCustomError(tradeModule, "BatchClaimTooLarge");
  });

  it("reverts when position not owned by caller", async () => {
    const { user, otherUser, payment, core, position, feePolicy, tradeModule } =
      await deploySystem();

    await createMarket(core, feePolicy, 1);
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);
    await settleMarket(core, 1, 1, 1_000n, payment);

    await expect(
      core.connect(otherUser).batchClaimPayout([p1])
    ).to.be.revertedWithCustomError(tradeModule, "UnauthorizedCaller");
  });

  it("reverts when market not yet settled", async () => {
    const { user, core, position, feePolicy, tradeModule } =
      await deploySystem();

    await createMarket(core, feePolicy, 1);
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);

    // Market is not settled
    await expect(
      core.connect(user).batchClaimPayout([p1])
    ).to.be.revertedWithCustomError(tradeModule, "MarketNotSettled");
  });

  it("reverts when claim delay not met", async () => {
    const { user, core, position, feePolicy, tradeModule } =
      await deploySystem();

    await createMarket(core, feePolicy, 1);
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);

    // Settle with future timestamp so claim delay is not met
    const m = await core.markets(1);
    const futureTime = BigInt(
      (await ethers.provider.getBlock("latest"))!.timestamp
    ) + 3600n;
    const settledMarket: IIcicleOptionsCore.MarketStruct = {
      isSeeded: m.isSeeded,
      settled: true,
      snapshotChunksDone: m.snapshotChunksDone,
      failed: m.failed,
      numBins: m.numBins,
      openPositionCount: m.openPositionCount,
      snapshotChunkCursor: m.snapshotChunkCursor,
      seedCursor: m.seedCursor,
      startTimestamp: m.startTimestamp,
      endTimestamp: m.endTimestamp,
      settlementTimestamp: futureTime, // Future - claim window not open
      settlementFinalizedAt: futureTime,
      minTick: m.minTick,
      maxTick: m.maxTick,
      tickSpacing: m.tickSpacing,
      settlementTick: 1,
      settlementValue: m.settlementValue,
      liquidityParameter: m.liquidityParameter,
      feePolicy: m.feePolicy,
      seedData: m.seedData,
      initialRootSum: m.initialRootSum,
      accumulatedFees: m.accumulatedFees,
      minFactor: m.minFactor,
      deltaEt: m.deltaEt,
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
      dynFloorWad: 0n, dynVersion: 0, tradingHalted: false, haltedAt: 0n,
    };
    await core.setMarket(1, settledMarket);

    await expect(
      core.connect(user).batchClaimPayout([p1])
    ).to.be.revertedWithCustomError(tradeModule, "ClaimTooEarly");
  });

  // -------------------------------------------------------
  // Single transfer verification
  // -------------------------------------------------------

  it("performs a single ERC20 transfer for N positions", async () => {
    const { user, payment, core, position, feePolicy } = await deploySystem();

    await createMarket(core, feePolicy, 1);
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);
    const p2 = await openPos(core, user, position, 1, 0, 2, 2_000);
    const p3 = await openPos(core, user, position, 1, 0, 2, 3_000);

    await settleMarket(core, 1, 1, 6_000n, payment);

    // Count Transfer events — should be exactly 1
    const tx = await core.connect(user).batchClaimPayout([p1, p2, p3]);
    const receipt = await tx.wait();
    const transferEvents = receipt!.logs.filter((log) => {
      try {
        return payment.interface.parseLog(log as any)?.name === "Transfer";
      } catch {
        return false;
      }
    });
    expect(transferEvents.length).to.equal(1);
  });

  // -------------------------------------------------------
  // Regression: existing claimPayout unchanged
  // -------------------------------------------------------

  it("existing single claimPayout still works correctly", async () => {
    const { user, payment, core, position, feePolicy } = await deploySystem();

    await createMarket(core, feePolicy, 1);
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);

    await settleMarket(core, 1, 1, 1_000n, payment);

    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).claimPayout(p1);
    const balAfter = await payment.balanceOf(user.address);

    expect(balAfter - balBefore).to.equal(1_000n);
    expect(await position.exists(p1)).to.equal(false);
  });

  it("existing claimPayout reverts on unsettled market (regression)", async () => {
    const { user, core, position, feePolicy, tradeModule } =
      await deploySystem();

    await createMarket(core, feePolicy, 1);
    const p1 = await openPos(core, user, position, 1, 0, 2, 1_000);

    await expect(
      core.connect(user).claimPayout(p1)
    ).to.be.revertedWithCustomError(tradeModule, "MarketNotSettled");
  });
});
