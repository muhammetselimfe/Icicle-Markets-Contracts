import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const WAD = ethers.parseEther("1");
const DUMMY_POLICY = "0x0000000000000000000000000000000000000001";

type MarketStruct = {
  isSeeded: boolean;
  settled: boolean;
  snapshotChunksDone: boolean;
  failed: boolean;
  numBins: number;
  openPositionCount: number;
  snapshotChunkCursor: number;
  seedCursor: number;
  startTimestamp: bigint;
  endTimestamp: bigint;
  settlementTimestamp: bigint;
  settlementFinalizedAt: bigint | number;
  minTick: number;
  maxTick: number;
  tickSpacing: number;
  settlementTick: number;
  settlementValue: number;
  liquidityParameter: bigint;
  feePolicy: string;
  seedData: string;
  initialRootSum: bigint;
  accumulatedFees: bigint;
  minFactor: bigint;
  deltaEt: bigint;
};

function buildMarket(
  baseTime: bigint,
  overrides: Partial<MarketStruct> = {}
): MarketStruct {
  const numBins = overrides.numBins ?? 4;
  const market: MarketStruct = {
    isSeeded: true,
    settled: false,
    snapshotChunksDone: false,
    failed: false,
    numBins: numBins,
    openPositionCount: 0,
    snapshotChunkCursor: 0,
    seedCursor: numBins,
    startTimestamp: baseTime - 10n,
    endTimestamp: baseTime + 1_000n,
    settlementTimestamp: baseTime + 1_100n,
    settlementFinalizedAt: 0,
    minTick: 0,
    maxTick: 4,
    tickSpacing: 1,
    settlementTick: 0,
    settlementValue: 0,
    liquidityParameter: ethers.parseEther("1"),
    feePolicy: DUMMY_POLICY,
    seedData: ethers.ZeroAddress,
    initialRootSum: BigInt(numBins) * ethers.parseEther("1"),
    accumulatedFees: 0n,
    minFactor: WAD, // uniform prior
    deltaEt: 0n, // uniform prior → ΔEₜ = 0
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
  return { ...market, ...overrides };
}

describe("TradeModule validation helpers", () => {
  async function deployHarness() {
    const lazyLib = await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy();
    const Factory = await ethers.getContractFactory("TradeModuleHarness", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    });
    return Factory.deploy();
  }

  it("reverts when market does not exist", async () => {
    const harness = await deployHarness();
    await expect(
      harness.exposedLoadAndValidateMarket(1)
    ).to.be.revertedWithCustomError(harness, "MarketNotFound");
  });

  it("reverts when market is not seeded", async () => {
    const harness = await deployHarness();
    const now = BigInt(await time.latest());
    await harness.setMarket(1, buildMarket(now, { isSeeded: false }));

    await expect(
      harness.exposedLoadAndValidateMarket(1)
    ).to.be.revertedWithCustomError(harness, "MarketNotSeeded");
  });

  it("reverts when market has not started or already expired", async () => {
    const harness = await deployHarness();
    const now = BigInt(await time.latest());

    await harness.setMarket(
      1,
      buildMarket(now, {
        startTimestamp: now + 100n,
        endTimestamp: now + 1_000n,
      })
    );
    await expect(
      harness.exposedLoadAndValidateMarket(1)
    ).to.be.revertedWithCustomError(harness, "MarketNotStarted");

    await harness.setMarket(
      2,
      buildMarket(now, {
        startTimestamp: now - 1_000n,
        endTimestamp: now - 10n,
      })
    );
    await expect(
      harness.exposedLoadAndValidateMarket(2)
    ).to.be.revertedWithCustomError(harness, "MarketExpired");
  });

  it("reverts on invalid ticks (bounds, spacing, no point bet)", async () => {
    const harness = await deployHarness();
    const now = BigInt(await time.latest());
    await harness.setMarket(1, buildMarket(now));

    await expect(
      harness.exposedValidateTickRange(-1, 1, 1)
    ).to.be.revertedWithCustomError(harness, "InvalidTick");

    // upperTick=5 with maxTick=4, tickSpacing=1, numBins=4 → hiBin=4 >= numBins
    await expect(
      harness.exposedValidateTickRange(0, 5, 1)
    ).to.be.revertedWithCustomError(harness, "RangeBinsOutOfBounds");

    await expect(
      harness.exposedValidateTickRange(0, 0, 1)
    ).to.be.revertedWithCustomError(harness, "InvalidTickRange");

    // Misaligned tick spacing
    await harness.setMarket(
      2,
      buildMarket(now, { tickSpacing: 2, maxTick: 10, numBins: 5 })
    );
    await expect(
      harness.exposedValidateTickRange(1, 3, 2)
    ).to.be.revertedWithCustomError(harness, "InvalidTickSpacing");
  });

  it("passes validation for aligned, in-range ticks", async () => {
    const harness = await deployHarness();
    const now = BigInt(await time.latest());
    await harness.setMarket(1, buildMarket(now));

    await harness.exposedValidateTickRange(0, 2, 1);
    await harness.exposedValidateTickRange(1, 3, 1);
  });
});
