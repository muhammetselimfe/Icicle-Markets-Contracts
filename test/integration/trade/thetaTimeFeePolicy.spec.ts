import { expect } from "chai";
import type { Interface } from "ethers";
import { artifacts, ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployTradeModuleSystem } from "../../helpers/deploy";
import { ONE_HOUR, WAD } from "../../helpers/constants";

const ZERO_CONTEXT = ethers.ZeroHash;

function findEvent(
  receipt: Awaited<ReturnType<typeof ethers.provider.getTransactionReceipt>>,
  iface: Interface,
  name: string
) {
  for (const log of receipt!.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === name) {
        return parsed;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

describe("TradeModule + ThetaTimeFeePolicy", () => {
  it("charges time-based fees across buy/sell flows", async () => {
    const [, user] = await ethers.getSigners();
    const { core } = await deployTradeModuleSystem({
      markets: [
        {
          numBins: 4,
          tickSpacing: 1,
          minTick: 0,
          maxTick: 4,
          endOffset: ONE_HOUR * 2,
          liquidityParameter: WAD,
        },
      ],
      userCount: 1,
    });

    const baseBps = 30n;
    const thetaMaxBps = 3000n;
    const window = BigInt(ONE_HOUR);
    const beta = 2;

    const feePolicy = await (
      await ethers.getContractFactory("ThetaTimeFeePolicy")
    ).deploy(await core.getAddress(), baseBps, thetaMaxBps, window, beta);

    const market = await core.harnessGetMarket(1);
    await core.setMarket(1, {
      isSeeded: market.isSeeded,
      settled: market.settled,
      snapshotChunksDone: market.snapshotChunksDone,
      failed: market.failed,
      numBins: market.numBins,
      openPositionCount: market.openPositionCount,
      snapshotChunkCursor: market.snapshotChunkCursor,
      seedCursor: market.seedCursor,
      startTimestamp: market.startTimestamp,
      endTimestamp: market.endTimestamp,
      settlementTimestamp: market.settlementTimestamp,
      settlementFinalizedAt: market.settlementFinalizedAt,
      minTick: market.minTick,
      maxTick: market.maxTick,
      tickSpacing: market.tickSpacing,
      settlementTick: market.settlementTick,
      settlementValue: market.settlementValue,
      liquidityParameter: market.liquidityParameter,
      feePolicy: feePolicy.target.toString(),
      seedData: market.seedData,
      initialRootSum: market.initialRootSum,
      accumulatedFees: market.accumulatedFees,
      minFactor: market.minFactor,
      deltaEt: market.deltaEt,
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
    });
    const endTimestamp = BigInt(market.endTimestamp);

    const tradeArtifact = await artifacts.readArtifact("TradeModule");
    const tradeIface = new ethers.Interface(tradeArtifact.abi);

    const lowerTick = 0;
    const upperTick = 4;
    const qty = 1_000_000n;

    // OPEN at tau = window (base fee only)
    const tOpen = endTimestamp - window;
    await time.setNextBlockTimestamp(Number(tOpen));
    const openTx = await core
      .connect(user)
      .openPosition(1, lowerTick, upperTick, qty, ethers.MaxUint256);
    const openReceipt = await openTx.wait();
    const openFeeEvent = findEvent(openReceipt, tradeIface, "TradeFeeCharged");
    expect(openFeeEvent).to.not.equal(null);
    const expectedOpenFee = await feePolicy.quoteFee.staticCall(
      {
        trader: user.address,
        marketId: 1,
        lowerTick,
        upperTick,
        quantity: qty,
        baseAmount: openFeeEvent!.args.baseAmount,
        isBuy: true,
        context: ZERO_CONTEXT,
      },
      { blockTag: openReceipt!.blockNumber }
    );
    expect(openFeeEvent!.args.feeAmount).to.equal(expectedOpenFee);
    expect(openFeeEvent!.args.policy).to.equal(feePolicy.target.toString());

    const positionId = Number(
      findEvent(openReceipt, tradeIface, "PositionOpened")!.args.positionId
    );

    // INCREASE at tau = window / 2
    const tInc = endTimestamp - window / 2n;
    await time.setNextBlockTimestamp(Number(tInc));
    const incTx = await core
      .connect(user)
      .increasePosition(positionId, qty, ethers.MaxUint256);
    const incReceipt = await incTx.wait();
    const incFeeEvent = findEvent(incReceipt, tradeIface, "TradeFeeCharged");
    expect(incFeeEvent).to.not.equal(null);
    const expectedIncFee = await feePolicy.quoteFee.staticCall(
      {
        trader: user.address,
        marketId: 1,
        lowerTick,
        upperTick,
        quantity: qty,
        baseAmount: incFeeEvent!.args.baseAmount,
        isBuy: true,
        context: ZERO_CONTEXT,
      },
      { blockTag: incReceipt!.blockNumber }
    );
    expect(incFeeEvent!.args.feeAmount).to.equal(expectedIncFee);

    // DECREASE at tau = window / 4
    const tDec = endTimestamp - window / 4n;
    await time.setNextBlockTimestamp(Number(tDec));
    const decTx = await core.connect(user).decreasePosition(positionId, qty, 0);
    const decReceipt = await decTx.wait();
    const decFeeEvent = findEvent(decReceipt, tradeIface, "TradeFeeCharged");
    expect(decFeeEvent).to.not.equal(null);
    const expectedDecFee = await feePolicy.quoteFee.staticCall(
      {
        trader: user.address,
        marketId: 1,
        lowerTick,
        upperTick,
        quantity: qty,
        baseAmount: decFeeEvent!.args.baseAmount,
        isBuy: false,
        context: ZERO_CONTEXT,
      },
      { blockTag: decReceipt!.blockNumber }
    );
    expect(decFeeEvent!.args.feeAmount).to.equal(expectedDecFee);

    // CLOSE at tau = 0 (max theta)
    await time.setNextBlockTimestamp(Number(endTimestamp));
    const closeTx = await core.connect(user).closePosition(positionId, 0);
    const closeReceipt = await closeTx.wait();
    const closeFeeEvent = findEvent(closeReceipt, tradeIface, "TradeFeeCharged");
    expect(closeFeeEvent).to.not.equal(null);
    const expectedCloseFee = await feePolicy.quoteFee.staticCall(
      {
        trader: user.address,
        marketId: 1,
        lowerTick,
        upperTick,
        quantity: qty,
        baseAmount: closeFeeEvent!.args.baseAmount,
        isBuy: false,
        context: ZERO_CONTEXT,
      },
      { blockTag: closeReceipt!.blockNumber }
    );
    expect(closeFeeEvent!.args.feeAmount).to.equal(expectedCloseFee);

    expect(expectedOpenFee).to.be.lte(expectedIncFee);
    expect(expectedIncFee).to.be.lte(expectedDecFee);
    expect(expectedDecFee).to.be.lte(expectedCloseFee);
  });
});
