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
 * ERC721 Standard Tests for IcicleOptionsPosition
 *
 * Tests standard ERC721 behavior:
 * - Metadata (name, symbol, tokenURI)
 * - Balance and ownership
 * - Transfers
 * - Approvals
 * - ERC165 interface support
 */

describe("IcicleOptionsPosition ERC721", () => {
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

  async function positionWithTokensFixture() {
    const base = await deployPositionFixture();
    const { position, core, alice, bob } = base;

    // Mint some positions
    await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
    await position.connect(core).mintPosition(alice.address, 1, 10, 20, 2000);
    await position.connect(core).mintPosition(bob.address, 2, 0, 5, 500);

    return { ...base, aliceToken1: 1n, aliceToken2: 2n, bobToken: 3n };
  }

  describe("ERC721 Metadata", () => {
    it("returns correct name and symbol", async () => {
      const { position } = await loadFixture(deployPositionFixture);

      expect(await position.name()).to.equal("Icicle Options Position");
      expect(await position.symbol()).to.equal("ICOP");
    });

    it("returns tokenURI (may be empty or base URI)", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      await position.connect(core).mintPosition(alice.address, 1, 100, 200, 1000);
      const tokenURI = await position.tokenURI(1);

      // v1 may not have tokenURI implemented yet
      expect(typeof tokenURI).to.equal("string");
    });

    it("reverts tokenURI for non-existent token", async () => {
      const { position } = await loadFixture(deployPositionFixture);

      await expect(position.tokenURI(999)).to.be.reverted;
    });
  });

  describe("ERC721 Balance and Ownership", () => {
    it("tracks balances correctly", async () => {
      const { position, core, alice } = await loadFixture(deployPositionFixture);

      expect(await position.balanceOf(alice.address)).to.equal(0);

      await position.connect(core).mintPosition(alice.address, 1, 0, 10, 1000);
      expect(await position.balanceOf(alice.address)).to.equal(1);

      await position.connect(core).mintPosition(alice.address, 1, 10, 20, 2000);
      expect(await position.balanceOf(alice.address)).to.equal(2);
    });

    it("returns correct owner", async () => {
      const { position, aliceToken1, alice } = await loadFixture(
        positionWithTokensFixture
      );

      expect(await position.ownerOf(aliceToken1)).to.equal(alice.address);
    });

    it("reverts balanceOf for zero address", async () => {
      const { position } = await loadFixture(deployPositionFixture);

      await expect(
        position.balanceOf(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(position, "ERC721InvalidOwner");
    });

    it("reverts ownerOf for non-existent token", async () => {
      const { position } = await loadFixture(deployPositionFixture);

      await expect(position.ownerOf(999)).to.be.revertedWithCustomError(
        position,
        "ERC721NonexistentToken"
      );
    });
  });

  describe("ERC721 Transfers", () => {
    it("transfers position correctly", async () => {
      const { position, alice, bob, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      await position
        .connect(alice)
        .transferFrom(alice.address, bob.address, aliceToken1);

      expect(await position.ownerOf(aliceToken1)).to.equal(bob.address);
      expect(await position.balanceOf(alice.address)).to.equal(1); // still has token2
      expect(await position.balanceOf(bob.address)).to.equal(2); // bobToken + aliceToken1
    });

    it("updates owner token tracking on transfer", async () => {
      const { position, alice, bob, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      const aliceTokensBefore = await position.getPositionsByOwner(alice.address);
      expect(aliceTokensBefore).to.include(aliceToken1);

      await position
        .connect(alice)
        .transferFrom(alice.address, bob.address, aliceToken1);

      const aliceTokensAfter = await position.getPositionsByOwner(alice.address);
      const bobTokensAfter = await position.getPositionsByOwner(bob.address);

      expect(aliceTokensAfter).to.not.include(aliceToken1);
      expect(bobTokensAfter).to.include(aliceToken1);
    });

    it("handles safe transfers", async () => {
      const { position, alice, bob, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      await position
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](
          alice.address,
          bob.address,
          aliceToken1
        );

      expect(await position.ownerOf(aliceToken1)).to.equal(bob.address);
    });

    it("reverts transfer from non-owner without approval", async () => {
      const { position, alice, bob, charlie, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      await expect(
        position
          .connect(charlie)
          .transferFrom(alice.address, bob.address, aliceToken1)
      ).to.be.revertedWithCustomError(position, "ERC721InsufficientApproval");
    });

    it("reverts transfer to zero address", async () => {
      const { position, alice, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      await expect(
        position
          .connect(alice)
          .transferFrom(alice.address, ethers.ZeroAddress, aliceToken1)
      ).to.be.revertedWithCustomError(position, "ERC721InvalidReceiver");
    });
  });

  describe("ERC721 Approvals", () => {
    it("approves and allows transfer", async () => {
      const { position, alice, bob, charlie, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      await position.connect(alice).approve(charlie.address, aliceToken1);
      expect(await position.getApproved(aliceToken1)).to.equal(charlie.address);

      await position
        .connect(charlie)
        .transferFrom(alice.address, bob.address, aliceToken1);

      expect(await position.ownerOf(aliceToken1)).to.equal(bob.address);
    });

    it("sets approval for all", async () => {
      const { position, alice, bob, charlie, aliceToken1, aliceToken2 } =
        await loadFixture(positionWithTokensFixture);

      await position.connect(alice).setApprovalForAll(charlie.address, true);
      expect(await position.isApprovedForAll(alice.address, charlie.address)).to
        .be.true;

      // Charlie can transfer any of alice's tokens
      await position
        .connect(charlie)
        .transferFrom(alice.address, bob.address, aliceToken1);
      await position
        .connect(charlie)
        .transferFrom(alice.address, bob.address, aliceToken2);

      expect(await position.balanceOf(alice.address)).to.equal(0);
    });

    it("clears approval on transfer", async () => {
      const { position, alice, bob, charlie, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      await position.connect(alice).approve(charlie.address, aliceToken1);
      expect(await position.getApproved(aliceToken1)).to.equal(charlie.address);

      await position
        .connect(alice)
        .transferFrom(alice.address, bob.address, aliceToken1);

      expect(await position.getApproved(aliceToken1)).to.equal(ethers.ZeroAddress);
    });

    it("reverts approval from non-owner", async () => {
      const { position, charlie, aliceToken1 } = await loadFixture(
        positionWithTokensFixture
      );

      await expect(
        position.connect(charlie).approve(charlie.address, aliceToken1)
      ).to.be.revertedWithCustomError(position, "ERC721InvalidApprover");
    });
  });

  describe("ERC165 Interface Support", () => {
    it("supports ERC165 interface", async () => {
      const { position } = await loadFixture(deployPositionFixture);
      // ERC165 interface ID
      expect(await position.supportsInterface("0x01ffc9a7")).to.be.true;
    });

    it("supports ERC721 interface", async () => {
      const { position } = await loadFixture(deployPositionFixture);
      // ERC721 interface ID
      expect(await position.supportsInterface("0x80ac58cd")).to.be.true;
    });

    it("supports ERC721Metadata interface", async () => {
      const { position } = await loadFixture(deployPositionFixture);
      // ERC721Metadata interface ID
      expect(await position.supportsInterface("0x5b5e139f")).to.be.true;
    });

    it("does not support random interface", async () => {
      const { position } = await loadFixture(deployPositionFixture);
      expect(await position.supportsInterface("0xdeadbeef")).to.be.false;
    });
  });
});
