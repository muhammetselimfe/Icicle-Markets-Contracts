import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  IcicleOptionsUSDToken,
  MockFeePolicy,
  TradeModuleProxy,
  TradeModule,
  IcicleOptionsPosition,
} from "../../typechain-types";
import { IIcicleOptionsCore } from "../../typechain-types/contracts/testonly/TradeModuleProxy";
import { WAD, USDC_DECIMALS } from "./constants";

// ============================================================
// Type Definitions
// ============================================================

export interface TradeModuleSystem {
  owner: HardhatEthersSigner;
  users: HardhatEthersSigner[];
  payment: IcicleOptionsUSDToken;
  position: IcicleOptionsPosition;
  feePolicy: MockFeePolicy;
  tradeModule: TradeModule;
  core: TradeModuleProxy;
}

export interface MarketConfig {
  numBins: number;
  tickSpacing: number;
  minTick: number;
  maxTick: number;
  endOffset?: number;
  liquidityParameter?: bigint;
  feeRate?: number;
}

export interface DeployOptions {
  markets?: MarketConfig[];
  userCount?: number;
  fundAmount?: bigint;
  submitWindow?: number;
  settlementWindow?: number;
}

const DEFAULT_MARKET_CONFIG: MarketConfig = {
  numBins: 4,
  tickSpacing: 1,
  minTick: 0,
  maxTick: 4,
  endOffset: 10_000,
  liquidityParameter: WAD,
};

const DEFAULT_DEPLOY_OPTIONS: DeployOptions = {
  markets: [DEFAULT_MARKET_CONFIG],
  userCount: 5,
  fundAmount: ethers.parseUnits("100000", USDC_DECIMALS),
  submitWindow: 300,
  settlementWindow: 60,
};

// ============================================================
// Core Deployment Functions
// ============================================================

/**
 * Deploy a complete TradeModule system with configurable options.
 * This is the primary fixture for trade-related tests.
 */
export async function deployTradeModuleSystem(
  options: DeployOptions = {}
): Promise<TradeModuleSystem> {
  const opts = { ...DEFAULT_DEPLOY_OPTIONS, ...options };
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const users = signers.slice(1, 1 + (opts.userCount ?? 5));

  // Deploy IcicleOptionsUSDToken
  const payment = (await (
    await ethers.getContractFactory("IcicleOptionsUSDToken")
  ).deploy()) as IcicleOptionsUSDToken;

  // Deploy MockFeePolicy
  const feePolicy = (await (
    await ethers.getContractFactory("MockFeePolicy")
  ).deploy(0)) as MockFeePolicy;

  // Deploy LazyMulSegmentTree library
  const lazyLib = await (
    await ethers.getContractFactory("LazyMulSegmentTree")
  ).deploy();

  // Deploy TradeModule
  const tradeModule = (await (
    await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })
  ).deploy()) as TradeModule;

  // Deploy TradeModuleProxy (test harness)
  const core = (await (
    await ethers.getContractFactory("TradeModuleProxy", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })
  ).deploy(tradeModule.target)) as TradeModuleProxy;

  // Deploy IcicleOptionsPosition with UUPS proxy (core address known now)
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

  // Configure addresses
  await core.setAddresses(
    payment.target,
    await position.getAddress(),
    opts.submitWindow ?? 300,
    opts.settlementWindow ?? 60
  );

  // Set up markets
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const markets = opts.markets ?? [DEFAULT_MARKET_CONFIG];

  for (let i = 0; i < markets.length; i++) {
    const marketId = i + 1;
    const config = markets[i];
    const market: IIcicleOptionsCore.MarketStruct = {
      isSeeded: true,
      settled: false,
      snapshotChunksDone: false,
      failed: false,
      numBins: config.numBins,
      openPositionCount: 0,
      snapshotChunkCursor: 0,
      seedCursor: config.numBins,
      startTimestamp: now - 10,
      endTimestamp: now + (config.endOffset ?? 10_000),
      settlementTimestamp: now + (config.endOffset ?? 10_000) + 100, // Tset > endTimestamp
      settlementFinalizedAt: 0,
      minTick: config.minTick,
      maxTick: config.maxTick,
      tickSpacing: config.tickSpacing,
      settlementTick: 0,
      settlementValue: 0,
      liquidityParameter: config.liquidityParameter ?? WAD,
      feePolicy: feePolicy.target.toString(),
      seedData: ethers.ZeroAddress,
      // P&L tracking fields
      initialRootSum: BigInt(config.numBins) * WAD, // n * WAD for uniform prior
      accumulatedFees: 0n,
      // Prior-based ΔEₜ calculation
      minFactor: WAD, // Uniform prior: minFactor = 1 WAD
      deltaEt: 0n, // Uniform prior: ΔEₜ = 0
      // v2 dynamic pricing (default: static legacy market)
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
    await core.setMarket(marketId, market);

    // Seed tree with uniform distribution
    const factors = Array.from({ length: config.numBins }, () => WAD);
    await core.seedTree(marketId, factors);
  }

  // Fund users
  const fundAmount = opts.fundAmount ?? ethers.parseUnits("100000", USDC_DECIMALS);
  for (const user of users) {
    await payment.transfer(user.address, fundAmount);
    await payment.connect(user).approve(core.target, ethers.MaxUint256);
  }

  return {
    owner,
    users,
    payment,
    position,
    feePolicy,
    tradeModule,
    core,
  };
}

/**
 * Deploy a minimal TradeModule system for simple tests.
 * Single market, single user, minimal configuration.
 */
export async function deployMinimalTradeSystem(): Promise<TradeModuleSystem> {
  return deployTradeModuleSystem({
    markets: [{ numBins: 4, tickSpacing: 1, minTick: 0, maxTick: 4 }],
    userCount: 1,
  });
}

/**
 * Deploy a multi-market TradeModule system for complex tests.
 */
export async function deployMultiMarketSystem(): Promise<TradeModuleSystem> {
  return deployTradeModuleSystem({
    markets: [
      { numBins: 4, tickSpacing: 1, minTick: 0, maxTick: 4 },
      { numBins: 4, tickSpacing: 1, minTick: -2, maxTick: 2 },
    ],
    userCount: 5,
  });
}

/**
 * Deploy a large-bin TradeModule system for stress tests.
 */
export async function deployLargeBinSystem(
  numBins: number = 128
): Promise<TradeModuleSystem> {
  return deployTradeModuleSystem({
    markets: [{ numBins, tickSpacing: 1, minTick: 0, maxTick: numBins }],
    userCount: 5,
    fundAmount: ethers.parseUnits("1000000", USDC_DECIMALS),
  });
}

// ============================================================
// Harness Deployment Functions
// ============================================================

/**
 * Deploy FixedPointMathHarness harness
 */
export async function deployFixedPointMathHarness() {
  const Factory = await ethers.getContractFactory("FixedPointMathHarness");
  const test = await Factory.deploy();
  await test.waitForDeployment();
  return test;
}

/**
 * Deploy LazyMulSegmentTreeHarness harness with library linking
 */
export async function deployLazyMulSegmentTreeHarness() {
  // LazyMulSegmentTreeHarness uses LazyMulSegmentTree library
  const lazyLib = await (
    await ethers.getContractFactory("LazyMulSegmentTree")
  ).deploy();

  const Factory = await ethers.getContractFactory("LazyMulSegmentTreeHarness", {
    libraries: {
      LazyMulSegmentTree: lazyLib.target,
    },
  });
  const test = await Factory.deploy();
  await test.waitForDeployment();
  return test;
}

/**
 * Deploy ClmsrMathHarness with LazyMulSegmentTree library
 */
export async function deployClmsrMathHarness() {
  const lazyLib = await (
    await ethers.getContractFactory("LazyMulSegmentTree")
  ).deploy();

  const Factory = await ethers.getContractFactory("ClmsrMathHarness", {
    libraries: {
      LazyMulSegmentTree: lazyLib.target,
    },
  });
  const harness = await Factory.deploy();
  await harness.waitForDeployment();
  return harness;
}

/**
 * Deploy full trade module test environment
 */
export async function deployTradeModuleTestEnv() {
  const [owner, user] = await ethers.getSigners();

  const payment = await (
    await ethers.getContractFactory("IcicleOptionsUSDToken")
  ).deploy();

  const positionImplFactory = await ethers.getContractFactory("IcicleOptionsPosition");
  const positionImpl = await positionImplFactory.deploy();
  await positionImpl.waitForDeployment();
  const positionInit = positionImplFactory.interface.encodeFunctionData(
    "initialize",
    [owner.address]
  );
  const positionProxy = await (
    await ethers.getContractFactory("TestERC1967Proxy")
  ).deploy(positionImpl.target, positionInit);
  const position = await ethers.getContractAt(
    "IcicleOptionsPosition",
    await positionProxy.getAddress()
  );

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

  return { owner, user, payment, position, feePolicy, core, lazyLib };
}
