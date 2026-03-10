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
 * Position Access Control Tests
 *
 * Tests authorization and access control:
 * - Core address management
 * - onlyCore modifier enforcement
 * - Owner-only functions
 */

describe("IcicleOptionsPosition Access Control", () => {
  async function deployPositionFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
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

    return { owner, core: core.signer, alice, bob, position };
  }

  describe("Core Authorization", () => {
    it("exposes current core address", async () => {
      const { position, core } = await loadFixture(deployPositionFixture);
      expect(await position.core()).to.equal(await core.getAddress());
    });

  });

  describe("onlyCore Modifier", () => {
    it("allows core to mint positions", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await expect(
        position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000)
      ).to.not.be.reverted;
    });

    it("reverts mintPosition from non-core", async () => {
      const { position, alice } = await loadFixture(deployPositionFixture);

      await expect(
        position.connect(alice).mintPosition(alice.address, 1, 0, 10, 1000)
      )
        .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
        .withArgs(alice.address);
    });

    it("allows core to update quantity", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await expect(position.connect(core).updateQuantity(1, 2000)).to.not.be
        .reverted;

      const pos = await position.getPosition(1);
      expect(pos.quantity).to.equal(2000);
    });

    it("reverts updateQuantity from non-core", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);

      await expect(position.connect(alice).updateQuantity(1, 2000))
        .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
        .withArgs(alice.address);
    });

    it("allows core to burn positions", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await expect(position.connect(core).burn(1)).to.not.be.reverted;
    });

    it("reverts burn from non-core", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);

      await expect(position.connect(alice).burn(1))
        .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
        .withArgs(alice.address);
    });
  });

  describe("Owner-only Functions", () => {
    it("owner can transfer ownership", async () => {
      const { position, owner, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(owner).transferOwnership(alice.address);
      expect(await position.owner()).to.equal(alice.address);
    });

    it("non-owner cannot transfer ownership", async () => {
      const { position, alice } = await loadFixture(deployPositionFixture);

      await expect(
        position.connect(alice).transferOwnership(alice.address)
      ).to.be.revertedWithCustomError(position, "OwnableUnauthorizedAccount");
    });
  });

  describe("Edge Cases", () => {
    it("prevents operations after position is burned", async () => {
      const { position, core, alice } = await loadFixture(
        deployPositionFixture
      );

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      await position.connect(core).burn(1);

      await expect(
        position.connect(core).updateQuantity(1, 2000)
      ).to.be.revertedWithCustomError(position, "PositionNotFound");
    });
  });
});
