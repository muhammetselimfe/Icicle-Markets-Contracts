import { ethers, upgrades } from "hardhat";
import { expect } from "chai";

describe("Access / Upgrade guards", () => {
  it("prevents re-initialization of IcicleOptionsPosition proxy", async () => {
    const [owner] = await ethers.getSigners();
    const coreStub = await (await ethers.getContractFactory("IcicleOptionsUSDToken")).deploy();
    await coreStub.waitForDeployment();
    const positionFactory = await ethers.getContractFactory("IcicleOptionsPosition");
    const proxy = await upgrades.deployProxy(
      positionFactory,
      [await coreStub.getAddress(), owner.address],
      { kind: "uups" }
    );
    await proxy.waitForDeployment();

    await expect(
      proxy.initialize(owner.address, owner.address)
    ).to.be.revertedWithCustomError(proxy, "InvalidInitialization");
  });

  describe("blocks direct module calls (onlyDelegated)", () => {
    it("TradeModule.openPosition", async () => {
      const lazy = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();
      const tradeModule = await (
        await ethers.getContractFactory("TradeModule", { libraries: { LazyMulSegmentTree: lazy.target } })
      ).deploy();

      await expect(
        tradeModule.openPosition(1, 0, 1, 1_000, 1)
      ).to.be.revertedWithCustomError(tradeModule, "NotDelegated");
    });

    it("LPVaultModule.seedVault", async () => {
      const lpVaultModule = await (await ethers.getContractFactory("LPVaultModule")).deploy();

      await expect(
        lpVaultModule.seedVault(1_000_000)
      ).to.be.revertedWithCustomError(lpVaultModule, "NotDelegated");
    });

    it("MarketLifecycleModule.createMarket", async () => {
      const lazy = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();
      const lifecycleModule = await (await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazy.target }
      })).deploy();

      await expect(
        lifecycleModule.createMarket(
          0, // minTick
          100, // maxTick
          10, // tickSpacing
          Math.floor(Date.now() / 1000) + 100, // startTimestamp
          Math.floor(Date.now() / 1000) + 200, // endTimestamp
          Math.floor(Date.now() / 1000) + 300, // settlementTimestamp
          10, // numBins
          ethers.parseEther("1"), // liquidityParameter
          ethers.ZeroAddress, // feePolicy
          ethers.ZeroAddress // seedData
        )
      ).to.be.revertedWithCustomError(lifecycleModule, "NotDelegated");
    });

    it("OracleModule.setRedstoneConfig", async () => {
      const oracleModule = await (await ethers.getContractFactory("OracleModule")).deploy();

      await expect(
        oracleModule.setRedstoneConfig(
          ethers.encodeBytes32String("TEST"),
          8, 3600, 300
        )
      ).to.be.revertedWithCustomError(oracleModule, "NotDelegated");
    });

    it("RiskModule.getAlphaLimit", async () => {
      const riskModule = await (await ethers.getContractFactory("RiskModule")).deploy();

      await expect(
        riskModule.getAlphaLimit(32, ethers.parseEther("0.2"), ethers.parseEther("0.5"))
      ).to.be.revertedWithCustomError(riskModule, "NotDelegated");
    });
  });

  it("rejects upgrade from non-owner", async () => {
    const [owner, attacker] = await ethers.getSigners();
    const coreStub = await (await ethers.getContractFactory("IcicleOptionsUSDToken")).deploy();
    await coreStub.waitForDeployment();
    const posFactory = await ethers.getContractFactory("IcicleOptionsPosition");
    const proxy = await upgrades.deployProxy(
      posFactory,
      [await coreStub.getAddress(), owner.address],
      { kind: "uups" }
    );
    await proxy.waitForDeployment();

    const newImpl = await posFactory.deploy();
    await newImpl.waitForDeployment();
    const upgradeIface = ["function upgradeTo(address)"];
    const proxyAddr = await proxy.getAddress();
    const rogue = new ethers.Contract(proxyAddr, upgradeIface, attacker);
    await expect(rogue.upgradeTo(await newImpl.getAddress())).to.be.reverted;
  });
});
