import { expect } from "chai";
import { ethers } from "hardhat";
import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { IcicleOptionsCore } from '../../typechain-types';
import { WAD, USDC_DECIMALS, SMALL_QUANTITY } from "../helpers/constants";
import {
  buildRedstonePayload,
  submitWithPayload,
} from "../helpers/redstone";

// Settlement tick = settlementValue / 10^6 = humanPrice
function tickToHumanPrice(tick: number): number {
  return tick;
}

/**
 * Escrow Security Tests
 *
 * Tests for:
 * - Free balance protection (pending deposits + payout reserves)
 * - Payout reserve integrity
 * - Settlement tick clamping
 */
describe("Escrow Security", () => {
  async function deploySecurityFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();
    const fundAmount = ethers.parseUnits("1000000", USDC_DECIMALS);
    await payment.transfer(user1.address, fundAmount);
    await payment.transfer(user2.address, fundAmount);

    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);
    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();

    // Deploy OracleModuleHarness for Redstone testing
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
      phiLP: ethers.parseEther("0.7"),
      phiBS: ethers.parseEther("0.2"),
      phiTR: ethers.parseEther("0.1"),
      withdrawalLagBatches: 0,
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

    // Approve
    await payment.connect(user1).approve(core.target, ethers.MaxUint256);
    await payment.connect(user2).approve(core.target, ethers.MaxUint256);
    await payment.connect(owner).approve(core.target, ethers.MaxUint256);

    // Seed vault
    await core
      .connect(owner)
      .seedVault(ethers.parseUnits("100000", USDC_DECIMALS));

    return { core, payment, position, lpShare, owner, user1, user2, feePolicy };
  }

  describe("Free Balance Protection", () => {
    it("trade proceeds cannot use pending deposits", async () => {
      const { core, payment, user1, user2, owner, feePolicy } =
        await loadFixture(deploySecurityFixture);

      // User1 requests deposit (creates pending deposit)
      const depositAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await core.connect(user1).requestDeposit(depositAmount);

      // Create a market for user2 to trade
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const marketId = await core.connect(owner).createMarketUniform.staticCall(
        0, // minTick
        100, // maxTick
        1, // tickSpacing
        now - 100,
        now + 10000,
        now + 10100,
        100, // numBins
        WAD, // liquidityParameter
        feePolicy.target.toString()
      );
      await core.connect(owner).createMarketUniform(
        0, // minTick
        100, // maxTick
        1, // tickSpacing
        now - 100,
        now + 10000,
        now + 10100,
        100, // numBins
        WAD, // liquidityParameter
        feePolicy.target.toString()
      );

      // User2 opens a position
      await core
        .connect(user2)
        .openPosition(
          marketId,
          10,
          20,
          SMALL_QUANTITY,
          ethers.parseUnits("1000", USDC_DECIMALS)
        );

      // Get position ID
      const positionId = 1n;

      // User2 closes position - should succeed but not drain pending deposits
      await core.connect(user2).closePosition(positionId, 0);

      // Core should still have at least the pending deposit amount
      const balanceAfter = await payment.balanceOf(core.target);
      expect(balanceAfter).to.be.gte(depositAmount);
    });
  });

  describe("Settlement Tick Clamp", () => {
    it("settlement at maxTick boundary clamps to last valid tick", async () => {
      const { core, user1, owner, feePolicy } = await loadFixture(
        deploySecurityFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const settlementTs = now + 1000;

      // Create market with clear boundaries
      const marketId = await core.connect(owner).createMarketUniform.staticCall(
        0, // minTick
        100, // maxTick
        1, // tickSpacing
        now - 100,
        now + 500,
        settlementTs,
        100, // numBins
        WAD, // liquidityParameter
        feePolicy.target.toString()
      );
      await core
        .connect(owner)
        .createMarketUniform(
          0,
          100,
          1,
          now - 100,
          now + 500,
          settlementTs,
          100,
          WAD,
          feePolicy.target.toString()
        );

      // User opens position at upper boundary
      await core.connect(user1).openPosition(
        marketId,
        95,
        100, // upperTick is exclusive
        SMALL_QUANTITY,
        ethers.parseUnits("1000", USDC_DECIMALS)
      );

      // Advance to settlement window
      await time.setNextBlockTimestamp(settlementTs + 1);

      // Submit settlement at exactly maxTick (100) - should clamp to 99
      const settlementPrice = tickToHumanPrice(100);
      const payload = buildRedstonePayload(settlementPrice, settlementTs);
      await submitWithPayload(core, owner, marketId, payload);

      // Advance past ops window
      const opsEnd = settlementTs + 3600 + 3600;
      await time.setNextBlockTimestamp(opsEnd + 1);

      // Finalize should succeed (tick clamped to 99, not 100)
      await expect(core.connect(owner).finalizePrimarySettlement(marketId)).to
        .not.be.reverted;

      // Verify settlement tick is clamped
      const market = await core.harnessGetMarket(marketId);
      expect(market.settlementTick).to.equal(99); // Last valid tick
    });

    it("settlement above maxTick clamps correctly", async () => {
      const { core, user1, owner, feePolicy } = await loadFixture(
        deploySecurityFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const settlementTs = now + 1000;

      const marketId = await core
        .connect(owner)
        .createMarketUniform.staticCall(
          0,
          100,
          1,
          now - 100,
          now + 500,
          settlementTs,
          100,
          WAD,
          feePolicy.target.toString()
        );
      await core
        .connect(owner)
        .createMarketUniform(
          0,
          100,
          1,
          now - 100,
          now + 500,
          settlementTs,
          100,
          WAD,
          feePolicy.target.toString()
        );

      await core
        .connect(user1)
        .openPosition(
          marketId,
          90,
          100,
          SMALL_QUANTITY,
          ethers.parseUnits("1000", USDC_DECIMALS)
        );

      await time.setNextBlockTimestamp(settlementTs + 1);

      // Submit settlement way above maxTick
      const settlementPrice = tickToHumanPrice(500);
      const payload = buildRedstonePayload(settlementPrice, settlementTs);
      await submitWithPayload(core, owner, marketId, payload);

      const opsEnd = settlementTs + 3600 + 3600;
      await time.setNextBlockTimestamp(opsEnd + 1);

      // Should succeed with clamped tick
      await expect(core.connect(owner).finalizePrimarySettlement(marketId)).to
        .not.be.reverted;

      const market2 = await core.harnessGetMarket(marketId);
      expect(market2.settlementTick).to.equal(99);
    });

    it("settlement below minTick clamps to minTick", async () => {
      const { core, user1, owner, feePolicy } = await loadFixture(
        deploySecurityFixture
      );

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const settlementTs = now + 1000;

      // Create market with minTick = 50
      const marketId = await core
        .connect(owner)
        .createMarketUniform.staticCall(
          50, // minTick
          100, // maxTick
          1,
          now - 100,
          now + 500,
          settlementTs,
          50, // numBins
          WAD,
          feePolicy.target.toString()
        );
      await core
        .connect(owner)
        .createMarketUniform(50, 100, 1, now - 100, now + 500, settlementTs, 50, WAD, feePolicy.target.toString());

      await core
        .connect(user1)
        .openPosition(
          marketId,
          50,
          60,
          SMALL_QUANTITY,
          ethers.parseUnits("1000", USDC_DECIMALS)
        );

      await time.setNextBlockTimestamp(settlementTs + 1);

      // Submit settlement below minTick (price = 10, but minTick = 50)
      const settlementPrice = tickToHumanPrice(10);
      const payload = buildRedstonePayload(settlementPrice, settlementTs);
      await submitWithPayload(core, owner, marketId, payload);

      const opsEnd = settlementTs + 3600 + 3600;
      await time.setNextBlockTimestamp(opsEnd + 1);

      // Should succeed with clamped tick to minTick
      await expect(core.connect(owner).finalizePrimarySettlement(marketId)).to
        .not.be.reverted;

      const market2 = await core.harnessGetMarket(marketId);
      expect(market2.settlementTick).to.equal(50); // Clamped to minTick
    });
  });
});
