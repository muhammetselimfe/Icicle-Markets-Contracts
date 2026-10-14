import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MockFeePolicy,
  IcicleOptionsUSDToken,
  LPVaultModule,
  MarketLifecycleModule,
  OracleModuleHarness,
  RiskModule,
  IcicleOptionsCore,
  IcicleOptionsLPShare,
  IcicleOptionsPosition,
  TradeModule,
} from "../../typechain-types";
import { DATA_FEED_ID, FEED_DECIMALS } from "./redstone";
import { WAD } from "./constants";

export interface FullSystem {
  owner: HardhatEthersSigner;
  users: HardhatEthersSigner[];
  payment: IcicleOptionsUSDToken;
  feePolicy: MockFeePolicy;
  core: IcicleOptionsCore;
  position: IcicleOptionsPosition;
  tradeModule: TradeModule;
  lifecycleModule: MarketLifecycleModule;
  oracleModule: OracleModuleHarness;
  riskModule: RiskModule;
  vaultModule: LPVaultModule;
  lpShare: IcicleOptionsLPShare;
  lazyLibrary: string;
}

export interface DeployFullSystemOptions {
  submitWindow?: number;
  opsWindow?: number;
  claimDelay?: number;
  // fee waterfall overrides (WAD); defaults preserve existing behavior (all fees to LP)
  phiLP?: bigint;
  phiBS?: bigint;
  phiTR?: bigint;
  rhoBS?: bigint;
  lambda?: bigint;
  maxSampleDistance?: number;
}

export async function deployFullSystem(
  options: DeployFullSystemOptions = {}
): Promise<FullSystem> {
  const submitWindow = options.submitWindow ?? 5;
  const opsWindow = options.opsWindow ?? 5;
  const expectedClaimDelay = submitWindow + opsWindow;
  const claimDelay = options.claimDelay ?? expectedClaimDelay;
  if (claimDelay !== expectedClaimDelay) {
    throw new Error(
      `claimDelay must equal submitWindow + opsWindow (expected ${expectedClaimDelay}, got ${claimDelay})`
    );
  }

  const signers = await ethers.getSigners();
  const owner = signers[0];
  const users = signers.slice(1, 6);

  const payment = (await (
    await ethers.getContractFactory("IcicleOptionsUSDToken")
  ).deploy()) as IcicleOptionsUSDToken;

  const feePolicy = (await (
    await ethers.getContractFactory("MockFeePolicy")
  ).deploy(0)) as MockFeePolicy;

  const lazyLib = await (
    await ethers.getContractFactory("LazyMulSegmentTree")
  ).deploy();

  const tradeModule = (await (
    await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })
  ).deploy()) as TradeModule;

  const lifecycleModule = (await (
    await ethers.getContractFactory("MarketLifecycleModule", {
      libraries: { LazyMulSegmentTree: lazyLib.target },
    })
  ).deploy()) as MarketLifecycleModule;

  const oracleModule = (await (
    await ethers.getContractFactory("OracleModuleHarness")
  ).deploy()) as OracleModuleHarness;

  const riskModule = (await (
    await ethers.getContractFactory("RiskModule")
  ).deploy()) as RiskModule;

  const vaultModule = (await (
    await ethers.getContractFactory("LPVaultModule")
  ).deploy()) as LPVaultModule;

  const positionImplFactory = await ethers.getContractFactory("IcicleOptionsPosition");
  const positionImpl = await positionImplFactory.deploy();
  await positionImpl.waitForDeployment();

  const lpShareImplFactory = await ethers.getContractFactory("IcicleOptionsLPShare");
  const lpShareImpl = await lpShareImplFactory.deploy();
  await lpShareImpl.waitForDeployment();

  const coreImplFactory = await ethers.getContractFactory("IcicleOptionsCore");
  const coreImpl = await coreImplFactory.deploy();
  await coreImpl.waitForDeployment();

  const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
  const positionProxy = await proxyFactory.deploy(positionImpl.target, "0x");
  const lpShareProxy = await proxyFactory.deploy(lpShareImpl.target, "0x");
  const coreProxy = await proxyFactory.deploy(coreImpl.target, "0x");

  const position = (await ethers.getContractAt(
    "IcicleOptionsPosition",
    await positionProxy.getAddress()
  )) as IcicleOptionsPosition;
  const lpShare = (await ethers.getContractAt(
    "IcicleOptionsLPShare",
    await lpShareProxy.getAddress()
  )) as IcicleOptionsLPShare;
  const core = (await ethers.getContractAt(
    "IcicleOptionsCore",
    await coreProxy.getAddress()
  )) as IcicleOptionsCore;

  const feedId = ethers.encodeBytes32String(DATA_FEED_ID);
  const coreParams: IcicleOptionsCore.InitParamsStruct = {
    paymentToken: payment.target.toString(),
    positionContract: await position.getAddress(),
    lpShareToken: await lpShare.getAddress(),
    tradeModule: tradeModule.target.toString(),
    lifecycleModule: lifecycleModule.target.toString(),
    riskModule: riskModule.target.toString(),
    vaultModule: vaultModule.target.toString(),
    oracleModule: oracleModule.target.toString(),
    ownerSafe: owner.address,
    settlementSubmitWindow: submitWindow,
    pendingOpsWindow: opsWindow,
    claimDelaySeconds: claimDelay,
    redstoneFeedId: feedId,
    redstoneFeedDecimals: FEED_DECIMALS,
    maxSampleDistance: options.maxSampleDistance ?? 600,
    futureTolerance: 60,
    lambda: options.lambda ?? WAD / 10n,
    kDrawdown: WAD,
    enforceAlpha: true,
    rhoBS: options.rhoBS ?? 0,
    phiLP: options.phiLP ?? WAD,
    phiBS: options.phiBS ?? 0,
    phiTR: options.phiTR ?? 0,
    withdrawalLagBatches: 1,
    operatorAllowlist: [owner.address],
  };
  await core.initialize(coreParams);
  await position.initialize(await core.getAddress(), owner.address);
  await lpShare.initialize(
    await core.getAddress(),
    payment.target.toString(),
    "Icicle Options LP",
    "ICOLP",
    owner.address
  );

  return {
    owner,
    users,
    payment,
    feePolicy,
    core,
    position,
    tradeModule,
    lifecycleModule,
    oracleModule,
    riskModule,
    vaultModule,
    lpShare,
    lazyLibrary: lazyLib.target.toString(),
  };
}
