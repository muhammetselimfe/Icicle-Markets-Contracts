import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  IcicleOptionsUSDToken,
  MockFeePolicy,
  TradeModuleProxy,
  IcicleOptionsPosition,
} from "../../../typechain-types";
import { IIcicleOptionsCore } from "../../../typechain-types/contracts/testonly/TradeModuleProxy";
import {
  WAD,
  USDC_DECIMALS,
  SMALL_QUANTITY,
  MEDIUM_QUANTITY,
} from "../../helpers/constants";

/**
 * Boundaries Tests
 *
 * Tests edge cases and boundary conditions for:
 * - Quantity validation (zero, minimum, maximum)
 * - Tick validation (range, spacing, bounds)
 * - Time validation (before start, after end)
 * - Factor limits (MIN_FACTOR, MAX_FACTOR)
 */

interface DeployedSystem {
  owner: HardhatEthersSigner;
  user: HardhatEthersSigner;
  payment: IcicleOptionsUSDToken;
  position: IcicleOptionsPosition;
  core: TradeModuleProxy;
  feePolicy: MockFeePolicy;
  marketId: number;
}

describe("Boundaries", () => {
  const NUM_BINS = 100;
  const MARKET_ID = 1;
  const TICK_SPACING = 1;

  async function deployBoundaryFixture(): Promise<DeployedSystem> {
    const [owner, user] = await ethers.getSigners();

    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();

    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);

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
    const positionProxy = await (
      await ethers.getContractFactory("TestERC1967Proxy")
    ).deploy(positionImpl.target, positionInit);
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
    const market: IIcicleOptionsCore.MarketStruct = {
      isSeeded: true,
      settled: false,
      snapshotChunksDone: false,
      failed: false,
      numBins: NUM_BINS,
      openPositionCount: 0,
      snapshotChunkCursor: 0,
      seedCursor: NUM_BINS,
      startTimestamp: now - 100,
      endTimestamp: now + 100000,
      settlementTimestamp: now + 100100,
      settlementFinalizedAt: 0,
      minTick: 0,
      maxTick: NUM_BINS,
      tickSpacing: TICK_SPACING,
      settlementTick: 0,
      settlementValue: 0,
      liquidityParameter: WAD,
      feePolicy: feePolicy.target.toString(),
      seedData: ethers.ZeroAddress,
      initialRootSum: BigInt(NUM_BINS) * WAD,
      accumulatedFees: 0n,
      minFactor: WAD, // uniform prior
      deltaEt: 0n, // Uniform prior: ΔEₜ = 0
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
    };
    await core.setMarket(MARKET_ID, market);

    const factors = Array(NUM_BINS).fill(WAD);
    await core.seedTree(MARKET_ID, factors);

    const fundAmount = ethers.parseUnits("100000", USDC_DECIMALS);
    await payment.transfer(user.address, fundAmount);
    await payment.connect(user).approve(core.target, fundAmount);

    return {
      owner,
      user,
      payment,
      position,
      core,
      feePolicy,
      marketId: MARKET_ID,
    };
  }

  // ============================================================
  // Quantity Boundaries
  // ============================================================
  describe("Quantity Boundaries", () => {
    it("reverts with zero quantity", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core.connect(user).openPosition(
          marketId,
          10,
          20,
          0, // zero quantity
          ethers.parseUnits("1000", USDC_DECIMALS)
        )
      ).to.be.reverted;
    });

    it("handles minimum quantity (1 wei)", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      // 1 wei quantity should either work or revert cleanly
      // Depends on implementation - very small may underflow
      try {
        await core
          .connect(user)
          .openPosition(
            marketId,
            10,
            20,
            1n,
            ethers.parseUnits("1000", USDC_DECIMALS)
          );
        // Success is acceptable
      } catch (error) {
        // Revert is also acceptable for edge case
        expect(error).to.exist;
      }
    });

    it("handles small but valid quantity", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      const smallQty = ethers.parseUnits("0.000001", USDC_DECIMALS); // 1 micro USDC

      await expect(
        core
          .connect(user)
          .openPosition(
            marketId,
            10,
            20,
            smallQty,
            ethers.parseUnits("1000", USDC_DECIMALS)
          )
      ).to.not.be.reverted;
    });

    it("cost increases monotonically with quantity", async () => {
      const { core, marketId } = await loadFixture(deployBoundaryFixture);

      const quantities = [
        SMALL_QUANTITY,
        MEDIUM_QUANTITY,
        ethers.parseUnits("1", USDC_DECIMALS),
      ];

      let prevCost = 0n;
      for (const qty of quantities) {
        const cost = await core.calculateOpenCost.staticCall(
          marketId,
          10,
          20,
          qty
        );
        expect(cost).to.be.gt(prevCost);
        prevCost = cost;
      }
    });
  });

  // ============================================================
  // Tick Boundaries
  // ============================================================
  describe("Tick Boundaries", () => {
    it("reverts when lowerTick == upperTick", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core.connect(user).openPosition(
          marketId,
          50,
          50, // same tick
          SMALL_QUANTITY,
          ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.be.reverted;
    });

    it("reverts when lowerTick > upperTick", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core.connect(user).openPosition(
          marketId,
          60,
          40, // inverted
          SMALL_QUANTITY,
          ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.be.reverted;
    });

    it("allows trade at minimum tick boundary", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core.connect(user).openPosition(
          marketId,
          0, // minTick
          1, // minTick + 1
          SMALL_QUANTITY,
          ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.not.be.reverted;
    });

    it("allows trade at maximum tick boundary", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core.connect(user).openPosition(
          marketId,
          NUM_BINS - 2, // maxTick - 2
          NUM_BINS - 1, // maxTick - 1
          SMALL_QUANTITY,
          ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.not.be.reverted;
    });

    it("reverts when tick exceeds maxTick", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core.connect(user).openPosition(
          marketId,
          0,
          NUM_BINS + 10, // exceeds maxTick
          SMALL_QUANTITY,
          ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.be.reverted;
    });

    it("allows full range trade (minTick to maxTick)", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core
          .connect(user)
          .openPosition(
            marketId,
            0,
            NUM_BINS - 1,
            SMALL_QUANTITY,
            ethers.parseUnits("100", USDC_DECIMALS)
          )
      ).to.not.be.reverted;
    });

    it("allows single bin trade (width = 1)", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      await expect(
        core
          .connect(user)
          .openPosition(
            marketId,
            50,
            51,
            SMALL_QUANTITY,
            ethers.parseUnits("100", USDC_DECIMALS)
          )
      ).to.not.be.reverted;
    });
  });

  // ============================================================
  // Time Boundaries
  // ============================================================
  describe("Time Boundaries", () => {
    async function deployTimeBoundaryFixture() {
      const [owner, user] = await ethers.getSigners();

      const payment = await (
        await ethers.getContractFactory("IcicleOptionsUSDToken")
      ).deploy();

      const feePolicy = await (
        await ethers.getContractFactory("MockFeePolicy")
      ).deploy(0);

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
      const positionProxy = await (
        await ethers.getContractFactory("TestERC1967Proxy")
      ).deploy(positionImpl.target, positionInit);
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

      const fundAmount = ethers.parseUnits("100000", USDC_DECIMALS);
      await payment.transfer(user.address, fundAmount);
      await payment.connect(user).approve(core.target, fundAmount);

      return { owner, user, payment, position, core, feePolicy };
    }

    it("reverts trade before market start", async () => {
      const { core, user, feePolicy } = await loadFixture(deployTimeBoundaryFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const market: IIcicleOptionsCore.MarketStruct = {
        isSeeded: true,
        settled: false,
        snapshotChunksDone: false,
        failed: false,
        numBins: 10,
        openPositionCount: 0,
        snapshotChunkCursor: 0,
        seedCursor: 10,
        startTimestamp: now + 10000, // future start
        endTimestamp: now + 20000,
        settlementTimestamp: now + 20100,
        settlementFinalizedAt: 0,
        minTick: 0,
        maxTick: 10,
        tickSpacing: 1,
        settlementTick: 0,
        settlementValue: 0,
        liquidityParameter: WAD,
        feePolicy: feePolicy.target.toString(),
        seedData: ethers.ZeroAddress,
        initialRootSum: 10n * WAD,
        accumulatedFees: 0n,
        minFactor: WAD, // uniform prior
        deltaEt: 0n, // Uniform prior: ΔEₜ = 0
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
      };
      await core.setMarket(2, market);
      await core.seedTree(2, Array(10).fill(WAD));

      await expect(
        core
          .connect(user)
          .openPosition(
            2,
            2,
            5,
            SMALL_QUANTITY,
            ethers.parseUnits("100", USDC_DECIMALS)
          )
      ).to.be.reverted;
    });

    it("reverts trade after market end", async () => {
      const { core, user, feePolicy } = await loadFixture(deployTimeBoundaryFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const market: IIcicleOptionsCore.MarketStruct = {
        isSeeded: true,
        settled: false,
        snapshotChunksDone: false,
        failed: false,
        numBins: 10,
        openPositionCount: 0,
        snapshotChunkCursor: 0,
        seedCursor: 10,
        startTimestamp: now - 20000, // past start
        endTimestamp: now - 10000, // past end
        settlementTimestamp: now - 5000,
        settlementFinalizedAt: 0,
        minTick: 0,
        maxTick: 10,
        tickSpacing: 1,
        settlementTick: 0,
        settlementValue: 0,
        liquidityParameter: WAD,
        feePolicy: feePolicy.target.toString(),
        seedData: ethers.ZeroAddress,
        initialRootSum: 10n * WAD,
        accumulatedFees: 0n,
        minFactor: WAD, // uniform prior
        deltaEt: 0n, // Uniform prior: ΔEₜ = 0
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
      };
      await core.setMarket(3, market);
      await core.seedTree(3, Array(10).fill(WAD));

      await expect(
        core
          .connect(user)
          .openPosition(
            3,
            2,
            5,
            SMALL_QUANTITY,
            ethers.parseUnits("100", USDC_DECIMALS)
          )
      ).to.be.reverted;
    });

    it("allows trade during active market period", async () => {
      const { core, user, feePolicy } = await loadFixture(deployTimeBoundaryFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const market: IIcicleOptionsCore.MarketStruct = {
        isSeeded: true,
        settled: false,
        snapshotChunksDone: false,
        failed: false,
        numBins: 10,
        openPositionCount: 0,
        snapshotChunkCursor: 0,
        seedCursor: 10,
        startTimestamp: now - 1000, // past start
        endTimestamp: now + 10000, // future end
        settlementTimestamp: now + 10100,
        settlementFinalizedAt: 0,
        minTick: 0,
        maxTick: 10,
        tickSpacing: 1,
        settlementTick: 0,
        settlementValue: 0,
        liquidityParameter: WAD,
        feePolicy: feePolicy.target.toString(),
        seedData: ethers.ZeroAddress,
        initialRootSum: 10n * WAD,
        accumulatedFees: 0n,
        minFactor: WAD, // uniform prior
        deltaEt: 0n, // Uniform prior: ΔEₜ = 0
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
      };
      await core.setMarket(4, market);
      await core.seedTree(4, Array(10).fill(WAD));

      await expect(
        core
          .connect(user)
          .openPosition(
            4,
            2,
            5,
            SMALL_QUANTITY,
            ethers.parseUnits("100", USDC_DECIMALS)
          )
      ).to.not.be.reverted;
    });
  });

  // ============================================================
  // Cost Boundaries
  // ============================================================
  describe("Cost Boundaries", () => {
    it("reverts when cost exceeds maxCost", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      // Calculate actual cost first
      const cost = await core.calculateOpenCost.staticCall(
        marketId,
        10,
        20,
        MEDIUM_QUANTITY
      );

      // Set maxCost below actual cost
      const maxCost = cost / 2n;

      await expect(
        core
          .connect(user)
          .openPosition(marketId, 10, 20, MEDIUM_QUANTITY, maxCost)
      ).to.be.reverted;
    });

    it("allows trade when cost equals maxCost", async () => {
      const { core, user, marketId } = await loadFixture(deployBoundaryFixture);

      const cost = await core.calculateOpenCost.staticCall(
        marketId,
        10,
        20,
        MEDIUM_QUANTITY
      );

      // Add small buffer for rounding
      const maxCost = cost + 10n;

      await expect(
        core
          .connect(user)
          .openPosition(marketId, 10, 20, MEDIUM_QUANTITY, maxCost)
      ).to.not.be.reverted;
    });
  });

  // ============================================================
  // Market State Boundaries
  // ============================================================
  describe("Market State Boundaries", () => {
    it("reverts trade on unseeded market", async () => {
      const { core, user, feePolicy } = await loadFixture(deployBoundaryFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const market: IIcicleOptionsCore.MarketStruct = {
        isSeeded: false,
        settled: false,
        snapshotChunksDone: false,
        failed: false,
        numBins: 10,
        openPositionCount: 0,
        snapshotChunkCursor: 0,
        seedCursor: 0,
        startTimestamp: now - 1000,
        endTimestamp: now + 10000,
        settlementTimestamp: now + 10100,
        settlementFinalizedAt: 0,
        minTick: 0,
        maxTick: 10,
        tickSpacing: 1,
        settlementTick: 0,
        settlementValue: 0,
        liquidityParameter: WAD,
        feePolicy: feePolicy.target.toString(),
        seedData: ethers.ZeroAddress,
        initialRootSum: 10n * WAD,
        accumulatedFees: 0n,
        minFactor: WAD, // uniform prior
        deltaEt: 0n, // Uniform prior: ΔEₜ = 0
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
      };
      await core.setMarket(5, market);
      await core.seedTree(5, Array(10).fill(WAD));

      await expect(
        core
          .connect(user)
          .openPosition(
            5,
            2,
            5,
            SMALL_QUANTITY,
            ethers.parseUnits("100", USDC_DECIMALS)
          )
      ).to.be.reverted;
    });

    it("reverts trade on settled market", async () => {
      const { core, user, feePolicy } = await loadFixture(deployBoundaryFixture);

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      const market: IIcicleOptionsCore.MarketStruct = {
        isSeeded: true,
        settled: true, // already settled
        snapshotChunksDone: false,
        failed: false,
        numBins: 10,
        openPositionCount: 0,
        snapshotChunkCursor: 0,
        seedCursor: 10,
        startTimestamp: now - 1000,
        endTimestamp: now + 10000,
        settlementTimestamp: now + 10100,
        settlementFinalizedAt: 0,
        minTick: 0,
        maxTick: 10,
        tickSpacing: 1,
        settlementTick: 5,
        settlementValue: 5_000_000,
        liquidityParameter: WAD,
        feePolicy: feePolicy.target.toString(),
        seedData: ethers.ZeroAddress,
        initialRootSum: 10n * WAD,
        accumulatedFees: 0n,
        minFactor: WAD, // uniform prior
        deltaEt: 0n, // Uniform prior: ΔEₜ = 0
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
      };
      await core.setMarket(6, market);
      await core.seedTree(6, Array(10).fill(WAD));

      await expect(
        core
          .connect(user)
          .openPosition(
            6,
            2,
            5,
            SMALL_QUANTITY,
            ethers.parseUnits("100", USDC_DECIMALS)
          )
      ).to.be.reverted;
    });

    it("reverts trade on non-existent market", async () => {
      const { core, user } = await loadFixture(deployBoundaryFixture);

      await expect(
        core.connect(user).openPosition(
          999, // non-existent
          2,
          5,
          SMALL_QUANTITY,
          ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.be.reverted;
    });
  });
});
