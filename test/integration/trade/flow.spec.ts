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
  payment: IcicleOptionsUSDToken;
  position: IcicleOptionsPosition;
  core: TradeModuleProxy;
  feePolicy: MockFeePolicy;
}

describe("TradeModule flow (minimal parity)", () => {
  async function deploySystem(
    marketOverrides: Partial<IIcicleOptionsCore.MarketStruct> = {},
    feeBps = 0
  ): Promise<DeployedSystem> {
    const [owner, user] = await ethers.getSigners();

    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(feeBps);

    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();
    const tradeModule = await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();

    const core = await (
      await ethers.getContractFactory("TradeModuleProxy", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy(tradeModule.target);

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

    await core.setAddresses(
      payment.target,
      await position.getAddress(),
      1,
      1
    );

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const numBins = marketOverrides.numBins ?? 4;
    const defaultSeedCursor =
      marketOverrides.seedCursor ??
      (marketOverrides.isSeeded === false ? 0 : numBins);
    const market: IIcicleOptionsCore.MarketStruct = {
      isSeeded: marketOverrides.isSeeded ?? true,
      settled: false,
      snapshotChunksDone: false,
      failed: false,
      numBins: numBins,
      openPositionCount: 0,
      snapshotChunkCursor: 0,
      seedCursor: defaultSeedCursor,
      startTimestamp: now - 10,
      endTimestamp: now + 1000,
      settlementTimestamp: now + 1100,
      settlementFinalizedAt: 0,
      minTick: 0,
      maxTick: 4,
      tickSpacing: 1,
      settlementTick: 0,
      settlementValue: 0,
      liquidityParameter: WAD,
      feePolicy: feePolicy.target.toString(),
      seedData: marketOverrides.seedData ?? ethers.ZeroAddress,
      initialRootSum: BigInt(numBins) * WAD,
      accumulatedFees: 0n,
      minFactor: WAD, // uniform prior
      deltaEt: 0n, // Uniform prior: ΔEₜ = 0
      ...marketOverrides,
    };
    await core.setMarket(1, market);
    await core.seedTree(1, [WAD, WAD, WAD, WAD]);

    // fund user
    await payment.transfer(user.address, 10_000_000n); // 10 USDC (6 decimals)
    await payment.connect(user).approve(core.target, ethers.MaxUint256);

    return {
      owner,
      user,
      payment: payment as IcicleOptionsUSDToken,
      position: position as IcicleOptionsPosition,
      core: core as TradeModuleProxy,
      feePolicy: feePolicy as MockFeePolicy,
    };
  }

  it("open -> increase -> decrease -> close updates balances and openPositionCount", async () => {
    const { user, payment, core, position } = await deploySystem();

    const startBal = await payment.balanceOf(user.address);

    const nextId = await position.nextId();
    const positionId = Number(nextId);
    await core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000); // 0.001 USDC

    let market = await core.markets(1);
    expect(market.openPositionCount).to.equal(1);

    await core.connect(user).increasePosition(positionId, 1_000, 5_000_000);
    await core.connect(user).decreasePosition(positionId, 1_000, 0);
    await core.connect(user).closePosition(positionId, 0);

    market = await core.markets(1);
    expect(market.openPositionCount).to.equal(0);
    expect(await position.exists(positionId)).to.equal(false);

    const endBal = await payment.balanceOf(user.address);
    expect(endBal).to.be.lessThan(startBal); // paid trading cost overall
  });

  it("rejects zero quantity and misaligned ticks", async () => {
    const { user, core } = await deploySystem();
    await expect(core.connect(user).openPosition(1, 0, 4, 0, 1_000_000)).to.be
      .reverted;

    const { user: u2, core: c2 } = await deploySystem({ tickSpacing: 2 });
    await expect(c2.connect(u2).openPosition(1, 1, 3, 1_000, 5_000_000)).to.be
      .reverted;
  });

  it("reverts on unseeded market and invalid ticks", async () => {
    const { user, core } = await deploySystem({ isSeeded: false });
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000)).to
      .be.reverted;

    const { user: user2, core: core2 } = await deploySystem();
    await expect(core2.connect(user2).openPosition(1, 0, 5, 1_000, 5_000_000))
      .to.be.reverted;
  });

  it("calculateOpenCost matches actual debit (fee=0)", async () => {
    const { user, core, payment } = await deploySystem();
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote);
    const balAfter = await payment.balanceOf(user.address);
    expect(balBefore - balAfter).to.equal(quote);
  });

  it("allows claim after settlement and burns position", async () => {
    const { user, core, payment, position } = await deploySystem();
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote);

    // Mark market settled in the past to satisfy claim gate.
    // settlementTimestamp must be in the past for claim to be allowed.
    const m = await core.markets(1);
    const past = m.endTimestamp - 1000n;
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
      settlementTick: 10n, // Outside position range [0,4) so payout is 0
      settlementValue: m.settlementValue,
      liquidityParameter: m.liquidityParameter,
      feePolicy: m.feePolicy,
      seedData: m.seedData,
      initialRootSum: m.initialRootSum,
      accumulatedFees: m.accumulatedFees,
      minFactor: m.minFactor,
      deltaEt: m.deltaEt,
    };
    await core.setMarket(1, settledMarket);

    // Note: This test uses TradeModuleProxy which doesn't have harness functions
    // settlementTick is set outside position range [0,4) so payout is 0
    // The key assertion is that claimPayout succeeds and burns the position
    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).claimPayout(1);
    const balAfter = await payment.balanceOf(user.address);
    // Balance stays the same since payout is 0 (losing position)
    expect(balAfter).to.equal(balBefore);
    expect(await position.exists(1)).to.equal(false);
  });

  it("reverts claim when market not settled or too early, and disallows double-claim", async () => {
    const { user, core } = await deploySystem();
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote);

    // not settled yet
    await expect(core.connect(user).claimPayout(1)).to.be.reverted;

    // Settle but too early for claim window.
    // Claim gating is time-based (settlementTimestamp + Δ_claim).
    const currentTime = BigInt(await ethers.provider.getBlock("latest").then(b => b!.timestamp));
    const m = await core.markets(1);
    const earlySettleMarket: IIcicleOptionsCore.MarketStruct = {
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
      settlementTimestamp: currentTime + 3600n, // Future: claim window not open yet
      settlementFinalizedAt: currentTime + 3600n,
      minTick: m.minTick,
      maxTick: m.maxTick,
      tickSpacing: m.tickSpacing,
      settlementTick: m.settlementTick,
      settlementValue: m.settlementValue,
      liquidityParameter: m.liquidityParameter,
      feePolicy: m.feePolicy,
      seedData: m.seedData,
      initialRootSum: m.initialRootSum,
      accumulatedFees: m.accumulatedFees,
      minFactor: m.minFactor,
      deltaEt: m.deltaEt,
    };
    await core.setMarket(1, earlySettleMarket);
    await expect(core.connect(user).claimPayout(1)).to.be.reverted;

    // Allow claim by moving settlementTimestamp to past.
    // Claim gating is time-based (settlementTimestamp + Δ_claim).
    const m2 = await core.markets(1);
    const pastTime = m2.endTimestamp - 1000n;
    const claimableMarket: IIcicleOptionsCore.MarketStruct = {
      isSeeded: m2.isSeeded,
      settled: m2.settled,
      snapshotChunksDone: m2.snapshotChunksDone,
      failed: m2.failed,
      numBins: m2.numBins,
      openPositionCount: m2.openPositionCount,
      snapshotChunkCursor: m2.snapshotChunkCursor,
      seedCursor: m2.seedCursor,
      startTimestamp: m2.startTimestamp,
      endTimestamp: m2.endTimestamp,
      settlementTimestamp: pastTime,
      settlementFinalizedAt: pastTime,
      minTick: m2.minTick,
      maxTick: m2.maxTick,
      tickSpacing: m2.tickSpacing,
      settlementTick: 10n, // Outside position range [0,4) so payout is 0
      settlementValue: m2.settlementValue,
      liquidityParameter: m2.liquidityParameter,
      feePolicy: m2.feePolicy,
      seedData: m2.seedData,
      initialRootSum: m2.initialRootSum,
      accumulatedFees: m2.accumulatedFees,
      minFactor: m2.minFactor, // Phase 7
      deltaEt: m2.deltaEt, // Phase 7
    };
    await core.setMarket(1, claimableMarket);
    await core.connect(user).claimPayout(1);
    await expect(core.connect(user).claimPayout(1)).to.be.reverted; // burned position
  });

  it("enforces maxCost and minProceeds, and applies fee policy", async () => {
    const system = await deploySystem({}, 100); // 1% fee
    const { user, core, payment, feePolicy } = system;
    const tradeModule = (await ethers.getContractAt(
      "TradeModule",
      await core.module()
    )) as unknown as TradeModule;
    const m = await core.markets(1);
    const feeMarket: IIcicleOptionsCore.MarketStruct = {
      isSeeded: m.isSeeded,
      settled: m.settled,
      snapshotChunksDone: m.snapshotChunksDone,
      failed: m.failed,
      numBins: m.numBins,
      openPositionCount: m.openPositionCount,
      snapshotChunkCursor: m.snapshotChunkCursor,
      seedCursor: m.seedCursor,
      startTimestamp: m.startTimestamp,
      endTimestamp: m.endTimestamp,
      settlementTimestamp: m.settlementTimestamp,
      settlementFinalizedAt: m.settlementFinalizedAt,
      minTick: m.minTick,
      maxTick: m.maxTick,
      tickSpacing: m.tickSpacing,
      settlementTick: m.settlementTick,
      settlementValue: m.settlementValue,
      liquidityParameter: m.liquidityParameter,
      feePolicy: await feePolicy.getAddress(),
      seedData: m.seedData,
      initialRootSum: m.initialRootSum,
      accumulatedFees: m.accumulatedFees,
      minFactor: m.minFactor,
      deltaEt: m.deltaEt,
    };
    await core.setMarket(1, feeMarket);
    await expect(
      core.connect(user).openPosition(1, 0, 4, 1_000, 1)
    ).to.be.revertedWithCustomError(tradeModule, "CostExceedsMaximum");

    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote + 10_000n);

    await expect(
      core.connect(user).decreasePosition(1, 500, quote)
    ).to.be.revertedWithCustomError(tradeModule, "ProceedsBelowMinimum");

    // Fees stay in core contract for Waterfall distribution after settlement
    const coreBalanceBefore = await payment.balanceOf(core.target);
    await core.connect(user).closePosition(1, 0);
    const coreBalanceAfter = await payment.balanceOf(core.target);
    // Core balance should retain accumulated fees (not transfer out)
    expect(coreBalanceAfter).to.be.lte(coreBalanceBefore);
  });

  it("reverts when allowance is insufficient", async () => {
    const { user, payment, core } = await deploySystem();
    await payment.connect(user).approve(core.target, 0);
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000)).to
      .be.reverted;
  });

  it("calculateDecreaseProceeds matches actual credit", async () => {
    const { user, core, payment, position } = await deploySystem();
    
    // Open position
    const nextId = await position.nextId();
    const positionId = Number(nextId);
    await core.connect(user).openPosition(1, 0, 4, 2_000, 10_000_000);
    
    // Quote decrease proceeds (positionId, quantity)
    const decreaseProceeds = await core.calculateDecreaseProceeds.staticCall(positionId, 500);
    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).decreasePosition(positionId, 500, 0);
    const balAfter = await payment.balanceOf(user.address);
    
    expect(balAfter - balBefore).to.equal(decreaseProceeds);
  });

  it("reverts trade after market end", async () => {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const { user, core } = await deploySystem({
      startTimestamp: now - 1000,
      endTimestamp: now - 100, // Ended in the past
    });
    
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000))
      .to.be.reverted;
  });

  it("reverts trade before market start", async () => {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const { user, core } = await deploySystem({
      startTimestamp: now + 1000, // Starts in the future
      endTimestamp: now + 2000,
    });
    
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000))
      .to.be.reverted;
  });

  it("reverts decrease more than owned quantity", async () => {
    const { user, core, position } = await deploySystem();
    const tradeModule = (await ethers.getContractAt(
      "TradeModule",
      await core.module()
    )) as unknown as TradeModule;
    
    const nextId = await position.nextId();
    const positionId = Number(nextId);
    await core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000);
    
    // Try to decrease more than owned
    await expect(
      core.connect(user).decreasePosition(positionId, 2_000, 0)
    ).to.be.revertedWithCustomError(tradeModule, "InsufficientPositionQuantity");
  });

  it("reverts operations on non-existent position", async () => {
    const { user, core } = await deploySystem();
    
    // Try to increase non-existent position
    await expect(core.connect(user).increasePosition(999, 500, 5_000_000))
      .to.be.reverted;
    
    // Try to decrease non-existent position
    await expect(core.connect(user).decreasePosition(999, 500, 0))
      .to.be.reverted;
    
    // Try to close non-existent position
    await expect(core.connect(user).closePosition(999, 0))
      .to.be.reverted;
  });
});
