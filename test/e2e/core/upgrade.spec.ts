import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFullSystem } from "../../helpers/fullSystem";
import { uniformFactors } from "../../helpers/constants";
import { deploySeedData } from "../../helpers";

describe("E2E: UUPS upgrades", () => {
  it("upgrades core and position without losing state", async () => {
    const { owner, users, core, payment, position, feePolicy } = await deployFullSystem({
      submitWindow: 5,
      opsWindow: 5,
    });
    const [trader] = users;
    const coreAddress = await core.getAddress();
    const positionAddress = await position.getAddress();

    await payment.transfer(trader.address, 50_000_000n);
    await payment.connect(trader).approve(coreAddress, ethers.MaxUint256);

    const now = await time.latest();
    const start = now - 5;
    const end = now + 50;
    const settlement = now + 60;
    const baseFactors = uniformFactors(4);
    const seedData = await deploySeedData(baseFactors);

    const marketId = await core.createMarket.staticCall(
      0,
      4,
      1,
      start,
      end,
      settlement,
      4,
      ethers.parseEther("1"),
      feePolicy.target.toString(),
      await seedData.getAddress()
    );
    await core.createMarket(
      0,
      4,
      1,
      start,
      end,
      settlement,
      4,
      ethers.parseEther("1"),
      feePolicy.target.toString(),
      await seedData.getAddress()
    );
    await core.seedNextChunks(marketId, 4);

    const quantity = 1_000n;
    const cost = await core.calculateOpenCost.staticCall(marketId, 1, 3, quantity);
    await core.connect(trader).openPosition(marketId, 1, 3, quantity, cost + 1_000_000n);

    const [positionId] = await position.getPositionsByOwner(trader.address);

    const coreV2Impl = await (await ethers.getContractFactory("IcicleOptionsCoreV2")).deploy();
    const coreUpgrader = await ethers.getContractAt(
      ["function upgradeToAndCall(address newImplementation, bytes data) external payable"],
      coreAddress
    );
    await (coreUpgrader as any).connect(owner).upgradeToAndCall(coreV2Impl.target, "0x");
    const coreV2 = await ethers.getContractAt("IcicleOptionsCoreV2", coreAddress);
    expect(await coreV2.version()).to.equal("v2");

    const positionV2Impl = await (await ethers.getContractFactory("IcicleOptionsPositionV2")).deploy();
    const positionUpgrader = await ethers.getContractAt(
      ["function upgradeToAndCall(address newImplementation, bytes data) external payable"],
      positionAddress
    );
    await (positionUpgrader as any).connect(owner).upgradeToAndCall(positionV2Impl.target, "0x");
    const positionV2 = await ethers.getContractAt("IcicleOptionsPositionV2", positionAddress);
    expect(await positionV2.version()).to.equal("v2");

    expect(await position.exists(positionId)).to.equal(true);
  });
});
