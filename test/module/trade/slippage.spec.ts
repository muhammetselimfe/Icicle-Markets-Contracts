import { ethers } from "hardhat";
import { expect } from "chai";
import { deployMinimalTradeSystem } from "../../helpers/deploy";
import { IIcicleOptionsCore } from "../../../typechain-types/contracts/testonly/TradeModuleProxy";
import { WAD } from "../../helpers/constants";

describe("TradeModule slippage and bounds", () => {
  it("reverts open when cost exceeds maxCost near boundary", async () => {
    const { users, core, tradeModule } = await deployMinimalTradeSystem();
    const user = users[0];
    const quote = await core.calculateOpenCost.staticCall(1, 0, 4, 1_000);
    await expect(
      core.connect(user).openPosition(1, 0, 4, 1_000, quote - 1n)
    ).to.be.revertedWithCustomError(tradeModule, "CostExceedsMaximum");
    await core.connect(user).openPosition(1, 0, 4, 1_000, quote + 1_000n);
  });

  it("reverts decrease when proceeds fall below minProceeds", async () => {
    const { users, core, tradeModule } = await deployMinimalTradeSystem();
    const user = users[0];
    await core.connect(user).openPosition(1, 0, 4, 2_000, 10_000_000);
    const quote = await core.calculateDecreaseProceeds.staticCall(1, 1_000);
    await expect(
      core.connect(user).decreasePosition(1, 1_000, quote + 1n)
    ).to.be.revertedWithCustomError(tradeModule, "ProceedsBelowMinimum");
    await core.connect(user).decreasePosition(1, 1_000, quote);
  });

  it("reverts increase when cost exceeds maxCost", async () => {
    const { users, core, tradeModule } = await deployMinimalTradeSystem();
    const user = users[0];
    await core.connect(user).openPosition(1, 0, 4, 1_000, 10_000_000);
    // Use a maxCost of 0 to guarantee failure
    await expect(
      core.connect(user).increasePosition(1, 500, 0)
    ).to.be.revertedWithCustomError(tradeModule, "CostExceedsMaximum");
    // Use a large maxCost to succeed
    await core.connect(user).increasePosition(1, 500, 10_000_000);
  });

  it("reverts close when proceeds fall below minProceeds", async () => {
    const { users, core, tradeModule } = await deployMinimalTradeSystem();
    const user = users[0];
    await core.connect(user).openPosition(1, 0, 4, 1_000, 10_000_000);
    // Use an impossibly high minProceeds to guarantee failure
    await expect(
      core.connect(user).closePosition(1, ethers.MaxUint256)
    ).to.be.revertedWithCustomError(tradeModule, "ProceedsBelowMinimum");
    // Use 0 minProceeds to succeed
    await core.connect(user).closePosition(1, 0);
  });

  it("rejects trades on settled market", async () => {
    const { users, core, feePolicy } = await deployMinimalTradeSystem();
    const user = users[0];
    
    // Get current market and update to settled state
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const settledMarket: IIcicleOptionsCore.MarketStruct = {
      isSeeded: true,
      settled: true,
      snapshotChunksDone: false,
      failed: false,
      numBins: 4,
      openPositionCount: 0,
      snapshotChunkCursor: 0,
      seedCursor: 4,
      startTimestamp: now - 10,
      endTimestamp: now + 1_000,
      settlementTimestamp: now + 1_100,
      settlementFinalizedAt: 0,
      minTick: 0,
      maxTick: 4,
      tickSpacing: 1,
      settlementTick: 0,
      settlementValue: 0,
      liquidityParameter: WAD,
      feePolicy: feePolicy.target.toString(),
      seedData: ethers.ZeroAddress,
      initialRootSum: 4n * WAD,
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
      dynFloorWad: 0n, dynVersion: 0, tradingHalted: false, haltedAt: 0n,
    };
    await core.setMarket(1, settledMarket);
    
    await expect(core.connect(user).openPosition(1, 0, 4, 1_000, 1_000_000)).to
      .be.reverted;
  });
});
