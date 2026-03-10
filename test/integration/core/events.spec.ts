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
import { WAD, USDC_DECIMALS, SMALL_QUANTITY, MEDIUM_QUANTITY } from "../../helpers/constants";

/**
 * Events & Position Lifecycle Tests
 * 
 * Tests correct event emission and state changes for:
 * - Position lifecycle (open, increase, decrease, close)
 * 
 * Note: In v1 architecture, position events are emitted from IcicleOptionsPosition:
 * - PositionMinted (on open)
 * - PositionUpdated (on increase/decrease)
 * - PositionBurned (on close)
 * 
 * TradeModule emits trade lifecycle events (open/increase/decrease/close + claim/settle),
 * while IcicleOptionsPosition emits tokenization events (mint/update/burn).
 */

interface DeployedSystem {
  owner: HardhatEthersSigner;
  user: HardhatEthersSigner;
  user2: HardhatEthersSigner;
  payment: IcicleOptionsUSDToken;
  position: IcicleOptionsPosition;
  core: TradeModuleProxy;
  feePolicy: MockFeePolicy;
  marketId: number;
}

describe("Events & Position Lifecycle", () => {
  const NUM_BINS = 10;
  const MARKET_ID = 1;

  async function deployEventFixture(): Promise<DeployedSystem> {
    const [owner, user, user2] = await ethers.getSigners();

    const payment = await (
      await ethers.getContractFactory("IcicleOptionsUSDToken")
    ).deploy();

    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);

    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();
    const tradeModuleImpl = await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy();

    const core = await (
      await ethers.getContractFactory("TradeModuleProxy", {
        libraries: { LazyMulSegmentTree: lazyLib.target },
      })
    ).deploy(tradeModuleImpl.target);

    const positionImplFactory = await ethers.getContractFactory("IcicleOptionsPosition");
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
      tickSpacing: 1,
      settlementTick: 0,
      settlementValue: 0,
      liquidityParameter: WAD,
      feePolicy: feePolicy.target.toString(),
      seedData: ethers.ZeroAddress,
      initialRootSum: BigInt(NUM_BINS) * WAD,
      accumulatedFees: 0n,
      minFactor: WAD, // uniform prior
      deltaEt: 0n, // Uniform prior: ΔEₜ = 0
    };
    await core.setMarket(MARKET_ID, market);

    const factors = Array(NUM_BINS).fill(WAD);
    await core.seedTree(MARKET_ID, factors);

    const fundAmount = ethers.parseUnits("100000", USDC_DECIMALS);
    await payment.transfer(user.address, fundAmount);
    await payment.transfer(user2.address, fundAmount);
    await payment.connect(user).approve(core.target, fundAmount);
    await payment.connect(user2).approve(core.target, fundAmount);

    return { owner, user, user2, payment, position, core, feePolicy, marketId: MARKET_ID };
  }

  // ============================================================
  // Position Events from IcicleOptionsPosition
  // ============================================================
  describe("IcicleOptionsPosition Events", () => {
    it("emits PositionMinted on openPosition with correct args", async () => {
      const { core, position, user, marketId } = await loadFixture(deployEventFixture);

      const nextId = await position.nextId();
      const tx = await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      await expect(tx).to.emit(position, "PositionMinted")
        .withArgs(nextId, user.address, marketId, 2, 5, MEDIUM_QUANTITY);
    });

    it("emits PositionUpdated on increasePosition with correct args", async () => {
      const { core, position, user, marketId } = await loadFixture(deployEventFixture);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];
      const posBefore = await position.getPosition(positionId);

      const tx = await core.connect(user).increasePosition(
        positionId,
        SMALL_QUANTITY,
        ethers.parseUnits("50", USDC_DECIMALS)
      );

      await expect(tx).to.emit(position, "PositionUpdated")
        .withArgs(positionId, posBefore.quantity, posBefore.quantity + BigInt(SMALL_QUANTITY));
    });

    it("emits PositionUpdated on decreasePosition with correct args", async () => {
      const { core, position, user, marketId } = await loadFixture(deployEventFixture);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];
      const posBefore = await position.getPosition(positionId);

      const tx = await core.connect(user).decreasePosition(
        positionId,
        SMALL_QUANTITY,
        0
      );

      await expect(tx).to.emit(position, "PositionUpdated")
        .withArgs(positionId, posBefore.quantity, posBefore.quantity - BigInt(SMALL_QUANTITY));
    });

    it("emits PositionBurned on closePosition with correct args", async () => {
      const { core, position, user, marketId } = await loadFixture(deployEventFixture);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];

      const tx = await core.connect(user).closePosition(positionId, 0);

      await expect(tx).to.emit(position, "PositionBurned")
        .withArgs(positionId, user.address);
    });
  });

  // ============================================================
  // TradeModule Events
  // Note: TradeModule emits trade lifecycle events; IcicleOptionsPosition emits mint/update/burn
  // ============================================================
  describe("TradeModule Events", () => {
    it("emits PositionClosed with correct position and trader", async () => {
      const { core, position, user, marketId } = await loadFixture(deployEventFixture);

      const tradeModule = await ethers.getContractAt("TradeModule", core.target);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];

      const tx = await core.connect(user).closePosition(positionId, 0);
      const receipt = await tx.wait();

      // Find PositionClosed event
      const iface = tradeModule.interface;
      const positionClosedEvent = receipt?.logs
        .map((log) => {
          try { return iface.parseLog({ topics: log.topics as string[], data: log.data }); } 
          catch { return null; }
        })
        .find((parsed) => parsed?.name === "PositionClosed");

      expect(positionClosedEvent).to.not.be.null;
      expect(positionClosedEvent?.args.positionId).to.equal(positionId);
      expect(positionClosedEvent?.args.trader).to.equal(user.address);
      expect(positionClosedEvent?.args.proceeds).to.be.gte(0);
    });
  });

  // ============================================================
  // Position State Changes
  // ============================================================
  describe("Position State Changes", () => {
    it("openPosition creates new position", async () => {
      const { core, user, position, marketId } = await loadFixture(deployEventFixture);

      const posBefore = await position.getPositionsByOwner(user.address);
      expect(posBefore.length).to.equal(0);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const posAfter = await position.getPositionsByOwner(user.address);
      expect(posAfter.length).to.equal(1);
    });

    it("increasePosition increases quantity", async () => {
      const { core, user, position, marketId } = await loadFixture(deployEventFixture);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];
      
      const posBefore = await position.getPosition(positionId);
      const qtyBefore = posBefore.quantity;

      await core.connect(user).increasePosition(
        positionId,
        SMALL_QUANTITY,
        ethers.parseUnits("50", USDC_DECIMALS)
      );

      const posAfter = await position.getPosition(positionId);
      const qtyAfter = posAfter.quantity;
      expect(qtyAfter).to.be.gt(qtyBefore);
    });

    it("decreasePosition decreases quantity", async () => {
      const { core, user, position, marketId } = await loadFixture(deployEventFixture);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];
      
      const posBefore = await position.getPosition(positionId);
      const qtyBefore = posBefore.quantity;

      await core.connect(user).decreasePosition(
        positionId,
        SMALL_QUANTITY,
        0
      );

      const posAfter = await position.getPosition(positionId);
      const qtyAfter = posAfter.quantity;
      expect(qtyAfter).to.be.lt(qtyBefore);
    });

    it("closePosition removes position", async () => {
      const { core, user, position, marketId } = await loadFixture(deployEventFixture);

      await core.connect(user).openPosition(
        marketId,
        2,
        5,
        MEDIUM_QUANTITY,
        ethers.parseUnits("100", USDC_DECIMALS)
      );

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];
      expect(positions.length).to.equal(1);

      await core.connect(user).closePosition(positionId, 0);

      const positionsAfter = await position.getPositionsByOwner(user.address);
      expect(positionsAfter.length).to.equal(0);
    });
  });

  // ============================================================
  // Multiple Users
  // ============================================================
  describe("Multiple Users", () => {
    it("tracks positions per user correctly", async () => {
      const { core, user, user2, position, marketId } = await loadFixture(deployEventFixture);

      await core.connect(user).openPosition(
        marketId,
        2,
        4,
        SMALL_QUANTITY,
        ethers.parseUnits("50", USDC_DECIMALS)
      );

      await core.connect(user2).openPosition(
        marketId,
        5,
        8,
        SMALL_QUANTITY,
        ethers.parseUnits("50", USDC_DECIMALS)
      );

      const pos1 = await position.getPositionsByOwner(user.address);
      const pos2 = await position.getPositionsByOwner(user2.address);
      
      expect(pos1.length).to.equal(1);
      expect(pos2.length).to.equal(1);
      expect(await position.ownerOf(pos1[0])).to.equal(user.address);
      expect(await position.ownerOf(pos2[0])).to.equal(user2.address);
    });

    it("users can trade in same market independently", async () => {
      const { core, user, user2, position, marketId } = await loadFixture(deployEventFixture);

      // Both open
      await core.connect(user).openPosition(
        marketId,
        2,
        4,
        SMALL_QUANTITY,
        ethers.parseUnits("50", USDC_DECIMALS)
      );
      await core.connect(user2).openPosition(
        marketId,
        5,
        8,
        SMALL_QUANTITY,
        ethers.parseUnits("50", USDC_DECIMALS)
      );

      // User1 closes
      const pos1 = await position.getPositionsByOwner(user.address);
      await core.connect(user).closePosition(pos1[0], 0);

      // User2 still has position
      const pos2 = await position.getPositionsByOwner(user2.address);
      expect(pos2.length).to.equal(1);
      
      // User1 has no positions
      const pos1After = await position.getPositionsByOwner(user.address);
      expect(pos1After.length).to.equal(0);
    });
  });

  // ============================================================
  // Full Lifecycle
  // ============================================================
  describe("Full Lifecycle", () => {
    it("complete position lifecycle works correctly", async () => {
      const { core, position, user, marketId } = await loadFixture(deployEventFixture);

      // Open
      await expect(
        core.connect(user).openPosition(
          marketId,
          2,
          5,
          MEDIUM_QUANTITY,
          ethers.parseUnits("100", USDC_DECIMALS)
        )
      ).to.emit(position, "PositionMinted");

      const positions = await position.getPositionsByOwner(user.address);
      const positionId = positions[0];
      expect(positionId).to.be.gt(0);

      // Increase
      await expect(
        core.connect(user).increasePosition(
          positionId,
          SMALL_QUANTITY,
          ethers.parseUnits("50", USDC_DECIMALS)
        )
      ).to.emit(position, "PositionUpdated");

      // Decrease
      await expect(
        core.connect(user).decreasePosition(
          positionId,
          SMALL_QUANTITY,
          0
        )
      ).to.emit(position, "PositionUpdated");

      // Close
      await expect(
        core.connect(user).closePosition(positionId, 0)
      ).to.emit(position, "PositionBurned");

      // Position removed
      const positionsAfter = await position.getPositionsByOwner(user.address);
      expect(positionsAfter.length).to.equal(0);
    });
  });
});
