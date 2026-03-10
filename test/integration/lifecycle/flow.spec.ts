import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { MarketLifecycleModule, OracleModule, TradeModule, IcicleOptionsCoreHarness, IcicleOptionsCore, IcicleOptionsPosition, IcicleOptionsLPShare, TestERC1967Proxy, MockFeePolicy, LPVaultModule } from '../../../typechain-types';
import {
  DATA_FEED_ID,
  FEED_DECIMALS,
  authorisedWallets,
  buildRedstonePayload,
  submitWithPayload,
} from "../../helpers/redstone";

// Redstone feed config (for setRedstoneConfig)
const FEED_ID = ethers.encodeBytes32String(DATA_FEED_ID);
const MAX_SAMPLE_DISTANCE = 600n;
const FUTURE_TOLERANCE = 60n;

// Human price to tick mapping:
// NumericDataPoint value (human price) * 10^8 = on-chain price
// settlementValue = on-chain price / 100 = humanPrice * 10^6
// settlementTick = settlementValue / 10^6 = humanPrice
// So human price equals the desired tick!
function tickToHumanPrice(tick: bigint): number {
  return Number(tick);
}

describe("Lifecycle + Trade integration", () => {
  async function setup() {
    const [owner, user] = await ethers.getSigners();
    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    const positionImplFactory = await ethers.getContractFactory("IcicleOptionsPosition");
    const positionImpl = await positionImplFactory.deploy();
    await positionImpl.waitForDeployment();
    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();

    const tradeModule = (await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy()) as TradeModule;
    const lifecycleModule = (await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy()) as MarketLifecycleModule;
    // Use OracleModuleHarness to allow Hardhat local signers for Redstone verification
    const oracleModule = (await (
      await ethers.getContractFactory("OracleModuleHarness")
    ).deploy()) as OracleModule;
    const riskModule = await (
      await ethers.getContractFactory("RiskModule")
    ).deploy();
    const vaultModule = (await (
      await ethers.getContractFactory("LPVaultModule")
    ).deploy()) as LPVaultModule;

    const coreImpl = (await (
      await ethers.getContractFactory("IcicleOptionsCoreHarness", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy()) as IcicleOptionsCoreHarness;
    const submitWindow = 300;
    const opsWindow = 60;
    const claimDelay = submitWindow + opsWindow;
    const lpShareImpl = await (await ethers.getContractFactory("IcicleOptionsLPShare")).deploy();

    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const positionProxy = (await proxyFactory.deploy(positionImpl.target, "0x")) as TestERC1967Proxy;
    const lpShareProxy = (await proxyFactory.deploy(lpShareImpl.target, "0x")) as TestERC1967Proxy;
    const coreProxy = (await proxyFactory.deploy(coreImpl.target, "0x")) as TestERC1967Proxy;

    const position = (await ethers.getContractAt(
      "IcicleOptionsPosition",
      await positionProxy.getAddress()
    )) as IcicleOptionsPosition;
    const lpShare = (await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    )) as IcicleOptionsLPShare;
    const core = (await ethers.getContractAt(
      "IcicleOptionsCoreHarness",
      await coreProxy.getAddress()
    )) as IcicleOptionsCoreHarness;

    const feePolicy = (await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0)) as MockFeePolicy;

    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: payment.target.toString(),
      positionContract: await position.getAddress(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: tradeModule.target.toString(),
      lifecycleModule: lifecycleModule.target.toString(),
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
      lambda: ethers.parseEther("0.3"),
      kDrawdown: ethers.parseEther("1"),
      enforceAlpha: true,
      rhoBS: 0,
      phiLP: ethers.parseEther("1"),
      phiBS: 0,
      phiTR: 0,
      withdrawalLagBatches: 1,
      operatorAllowlist: [owner.address],
    };
    await core.initialize(coreParams);
    await position.initialize(await core.getAddress(), owner.address);
    await lpShare.initialize(
      await core.getAddress(),
      payment.target.toString(),
      "Icicle Options LP",
      "ICOLP",
      owner.address
    );

    return {
      owner,
      user,
      payment,
      position,
      tradeModule,
      lifecycleModule,
      oracleModule,
      core,
      feePolicy,
      submitWindow,
      opsWindow,
      claimDelay,
    };
  }

  it("runs create -> trade -> settlement -> snapshot -> claim flow", async () => {
    const {
      owner,
      user,
      payment,
      position,
      core,
      lifecycleModule,
      feePolicy,
    } = await setup();

    const lifecycleEvents = lifecycleModule.attach(await core.getAddress());

    const now = BigInt(await time.latest());
    const start = now - 50n;
    const end = now + 200n;
    const settlementTs = end + 10n;
    const marketId = await core.createMarketUniform.staticCall(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(settlementTs),
      4,
      ethers.parseEther("1"),
      feePolicy.target.toString()
    );
    await expect(
      core.createMarketUniform(
        0,
        4,
        1,
        Number(start),
        Number(end),
        Number(settlementTs),
        4,
        ethers.parseEther("1"),
        feePolicy.target.toString()
      )
    ).to.emit(lifecycleEvents, "MarketCreated");

    // fund and approve user
    await payment.transfer(user.address, 10_000_000n);
    await payment
      .connect(user)
      .approve(await core.getAddress(), ethers.MaxUint256);

    // open position
    const positionId = await position.nextId();
    await core.connect(user).openPosition(marketId, 0, 4, 1_000, 5_000_000);
    let market = await core.markets(marketId);
    expect(market.openPositionCount).to.equal(1);

    // submit oracle price after settlementTimestamp (Tset)
    const priceTimestamp = settlementTs + 5n;
    await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
    const payload = buildRedstonePayload(tickToHumanPrice(2n), Number(priceTimestamp), authorisedWallets);
    await submitWithPayload(core, owner, marketId, payload);

    // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
    const opsEnd = settlementTs + 300n + 60n;
    await time.setNextBlockTimestamp(Number(opsEnd + 1n));
    await core.finalizePrimarySettlement(marketId);
    market = await core.markets(marketId);
    expect(market.settled).to.equal(true);
    expect(market.snapshotChunksDone).to.equal(false);

    // request settlement chunks (openPositionCount = 1 => 1 chunk)
    await expect(core.requestSettlementChunks(marketId, 5))
      .to.emit(lifecycleEvents, "SettlementChunkRequested")
      .withArgs(marketId, 0);
    market = await core.markets(marketId);
    expect(market.snapshotChunksDone).to.equal(true);

    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).claimPayout(positionId);
    const balAfter = await payment.balanceOf(user.address);
    expect(balAfter - balBefore).to.equal(1_000);
    expect(await position.exists(positionId)).to.equal(false);
  });

  it("burns loser positions with zero payout and prevents double-claim", async () => {
    const {
      owner,
      user,
      payment,
      position,
      core,
      lifecycleModule,
      feePolicy,
    } = await setup();

    const lifecycleEvents = lifecycleModule.attach(await core.getAddress());

    const now = BigInt(await time.latest());
    const start = now - 50n;
    const end = now + 200n;
    const settlementTs = end + 10n;
    await core.createMarketUniform(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(settlementTs),
      4,
      ethers.parseEther("1"),
      feePolicy.target.toString()
    );

    await payment.transfer(user.address, 10_000_000n);
    await payment
      .connect(user)
      .approve(await core.getAddress(), ethers.MaxUint256);

    const pos1 = await position.nextId(); // winner
    await core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000);
    const pos2 = Number(pos1) + 1; // loser (upper range)
    await core.connect(user).openPosition(1, 3, 4, 1_000, 5_000_000);

    // priceTimestamp must be >= Tset (settlementTs)
    const priceTimestamp = settlementTs + 5n;
    await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
    const payload2 = buildRedstonePayload(tickToHumanPrice(1n), Number(priceTimestamp), authorisedWallets);
    await submitWithPayload(core, owner, 1, payload2);
    // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
    const opsEnd = settlementTs + 300n + 60n;
    await time.setNextBlockTimestamp(Number(opsEnd + 1n));
    await core.finalizePrimarySettlement(1);
    await expect(core.requestSettlementChunks(1, 5))
      .to.emit(lifecycleEvents, "SettlementChunkRequested")
      .withArgs(1, 0);

    const balBefore = await payment.balanceOf(user.address);
    await core.connect(user).claimPayout(pos1);
    await core.connect(user).claimPayout(pos2);
    const balAfter = await payment.balanceOf(user.address);
    expect(balAfter - balBefore).to.equal(1_000); // loser payout zero
    expect(await position.exists(pos1)).to.equal(false);
    expect(await position.exists(pos2)).to.equal(false);

    await expect(core.connect(user).claimPayout(pos1)).to.be.reverted;
  });

  it("enforces time gates for trading, settlement, and claim windows", async () => {
    const { owner, user, payment, core, feePolicy } = await setup();
    const now = BigInt(await time.latest());
    const start = now + 100n;
    const end = start + 100n;
    const settlementTs = end + 50n;
    await core.createMarketUniform(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(settlementTs),
      4,
      ethers.parseEther("1"),
      feePolicy.target.toString()
    );

    await payment.transfer(user.address, 10_000_000n);
    await payment
      .connect(user)
      .approve(await core.getAddress(), ethers.MaxUint256);

    // too early to trade
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000)).to
      .be.reverted;

    await time.setNextBlockTimestamp(Number(start + 1n));
    await core.connect(user).openPosition(1, 0, 4, 1_000, 5_000_000);

    // after endTimestamp trading should revert
    await time.setNextBlockTimestamp(Number(end + 1n));
    await expect(core.connect(user).increasePosition(1, 1_000, 5_000_000)).to.be
      .reverted;

    // settlement too early (before PendingOps starts)
    await expect(core.finalizePrimarySettlement(1)).to.be.reverted;

    // submit settlement within window (priceTimestamp >= Tset)
    const priceTimestamp = settlementTs + 10n;
    await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
    const payload3 = buildRedstonePayload(tickToHumanPrice(1n), Number(priceTimestamp), authorisedWallets);
    await submitWithPayload(core, owner, 1, payload3);
    
    // finalize during PendingOps (submitWindow=300)
    const opsStart = settlementTs + 300n;
    await time.setNextBlockTimestamp(Number(opsStart + 1n));
    await core.finalizePrimarySettlement(1);

    // claim too early (claim gate = Tset + Δclaim)
    await expect(core.connect(user).claimPayout(1)).to.be.reverted;

    const claimOpen = settlementTs + 300n + 60n;
    await time.setNextBlockTimestamp(Number(claimOpen + 1n));
    await core.connect(user).claimPayout(1);
  });
});
