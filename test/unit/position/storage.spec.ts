import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { Signer } from "ethers";
import { IcicleOptionsPosition, IcicleOptionsUSDToken } from "../../../typechain-types";

async function deployCoreSigner(): Promise<{ address: string; signer: Signer }> {
  const token = (await (
    await ethers.getContractFactory("IcicleOptionsUSDToken")
  ).deploy()) as IcicleOptionsUSDToken;
  await token.waitForDeployment();
  const address = await token.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    ethers.toBeHex(ethers.parseEther("10")),
  ]);
  const signer = await ethers.getSigner(address);
  return { address, signer };
}

/**
 * Position Storage Tests
 *
 * Tests position data storage and retrieval:
 * - Position data correctness
 * - Multiple positions handling
 * - Market and owner indexing
 * - Storage consistency after operations
 */

describe("IcicleOptionsPosition Storage", () => {
  async function deployPositionFixture() {
    const [owner, alice, bob, charlie] = await ethers.getSigners();
    const core = await deployCoreSigner();

    const implFactory = await ethers.getContractFactory("IcicleOptionsPosition");
    const impl = await implFactory.deploy();
    await impl.waitForDeployment();

    const initData = implFactory.interface.encodeFunctionData("initialize", [
      core.address,
      owner.address,
    ]);
    const proxy = await (
      await ethers.getContractFactory("TestERC1967Proxy")
    ).deploy(await impl.getAddress(), initData);

    const position = (await ethers.getContractAt(
      "IcicleOptionsPosition",
      await proxy.getAddress()
    )) as IcicleOptionsPosition;

    return { owner, core: core.signer, alice, bob, charlie, position };
  }

  describe("Position Data Storage", () => {
    it("stores position data correctly", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      const marketId = 1;
      const lowerTick = 100;
      const upperTick = 200;
      const quantity = 1000n;

      await position
        .connect(core)
        .mintPosition(alice.address, marketId, lowerTick, upperTick, quantity);

      const pos = await position.getPosition(1);

      expect(pos.marketId).to.equal(marketId);
      expect(pos.lowerTick).to.equal(lowerTick);
      expect(pos.upperTick).to.equal(upperTick);
      expect(pos.quantity).to.equal(quantity);
      expect(pos.createdAt).to.be.gt(0);
    });

    it("handles multiple positions with different data", async () => {
      const { position, core, alice, bob } = await loadFixture(
        deployPositionFixture
      );

      // Alice's position
      await position.connect(core).mintPosition(alice.address, 1, 100, 200, 1000);

      // Bob's position with different parameters
      await position.connect(core).mintPosition(bob.address, 1, 300, 400, 2000);

      const alicePos = await position.getPosition(1);
      const bobPos = await position.getPosition(2);

      expect(alicePos.lowerTick).to.equal(100);
      expect(alicePos.upperTick).to.equal(200);
      expect(alicePos.quantity).to.equal(1000);

      expect(bobPos.lowerTick).to.equal(300);
      expect(bobPos.upperTick).to.equal(400);
      expect(bobPos.quantity).to.equal(2000);
    });

    it("reverts getPosition for non-existent position", async () => {
      const { position } = await loadFixture(deployPositionFixture);

      await expect(position.getPosition(999)).to.be.revertedWithCustomError(
        position,
        "PositionNotFound"
      );
    });

    it("updates quantity correctly", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).updateQuantity(1, 2500);

      const pos = await position.getPosition(1);
      expect(pos.quantity).to.equal(2500);
    });

    it("preserves other fields on quantity update", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 5, 100, 200, 1000);
      const before = await position.getPosition(1);

      await position.connect(core).updateQuantity(1, 5000);
      const after = await position.getPosition(1);

      expect(after.marketId).to.equal(before.marketId);
      expect(after.lowerTick).to.equal(before.lowerTick);
      expect(after.upperTick).to.equal(before.upperTick);
      expect(after.createdAt).to.equal(before.createdAt);
      expect(after.quantity).to.equal(5000);
    });
  });

  describe("Owner Indexing", () => {
    it("tracks positions by owner", async () => {
      const { position, core, alice, bob } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 1000);
      await position.connect(core).mintPosition(bob.address, 1, 20, 30, 1000);

      const alicePositions = await position.getPositionsByOwner(alice.address);
      const bobPositions = await position.getPositionsByOwner(bob.address);

      expect(alicePositions).to.have.lengthOf(2);
      expect(alicePositions).to.deep.equal([1n, 2n]);
      expect(bobPositions).to.have.lengthOf(1);
      expect(bobPositions).to.deep.equal([3n]);
    });

    it("updates owner index on transfer", async () => {
      const { position, core, alice, bob } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);

      expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([
        1n,
      ]);
      expect(await position.getPositionsByOwner(bob.address)).to.deep.equal([]);

      await position
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](
          alice.address,
          bob.address,
          1
        );

      expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([]);
      expect(await position.getPositionsByOwner(bob.address)).to.deep.equal([1n]);
    });

    it("removes from owner index on burn", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 1000);

      expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([
        1n,
        2n,
      ]);

      await position.connect(core).burn(1);

      expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([
        2n,
      ]);
    });
  });

  describe("Market Indexing", () => {
    it("tracks positions by market", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 1000);
      await position.connect(core).mintPosition(alice.address, 2, 0, 5, 500);

      const market1Positions = await position.getMarketPositions(1);
      const market2Positions = await position.getMarketPositions(2);

      expect(market1Positions).to.deep.equal([1n, 2n]);
      expect(market2Positions).to.deep.equal([3n]);
    });

    it("leaves holes in market index on burn", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 20, 30, 1000);

      await position.connect(core).burn(2);

      const positions = await position.getMarketPositions(1);
      expect(positions).to.deep.equal([1n, 0n, 3n]); // hole at index 1
    });

    it("reports correct market token length", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 1000);

      expect(await position.getMarketTokenLength(1)).to.equal(2);
      expect(await position.getMarketTokenLength(2)).to.equal(0);
    });
  });

  describe("User-Market Indexing", () => {
    it("tracks user positions per market", async () => {
      const { position, core, alice, bob } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).mintPosition(bob.address, 1, 10, 20, 1000);
      await position.connect(core).mintPosition(alice.address, 2, 0, 5, 500);

      expect(await position.getUserPositionsInMarket(alice.address, 1)).to.deep.equal([
        1n,
      ]);
      expect(await position.getUserPositionsInMarket(bob.address, 1)).to.deep.equal([
        2n,
      ]);
      expect(await position.getUserPositionsInMarket(alice.address, 2)).to.deep.equal([
        3n,
      ]);
    });

    it("updates user-market index on transfer", async () => {
      const { position, core, alice, bob } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);

      await position
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](
          alice.address,
          bob.address,
          1
        );

      expect(await position.getUserPositionsInMarket(alice.address, 1)).to.deep.equal(
        []
      );
      expect(await position.getUserPositionsInMarket(bob.address, 1)).to.deep.equal([
        1n,
      ]);
    });
  });

  describe("Counter Management", () => {
    it("increments token IDs correctly", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 1000);
      await position.connect(core).mintPosition(alice.address, 1, 20, 30, 1000);

      expect(await position.ownerOf(1)).to.equal(alice.address);
      expect(await position.ownerOf(2)).to.equal(alice.address);
      expect(await position.ownerOf(3)).to.equal(alice.address);
    });

    it("does not reuse burned token IDs", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).burn(1);
      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 1000);

      // Token ID 1 is burned, new token is ID 2
      await expect(position.ownerOf(1)).to.be.reverted;
      expect(await position.ownerOf(2)).to.equal(alice.address);
    });
  });
});

