import { expect } from "chai";
import { ethers } from "hardhat";
import {
  LPVaultModule,
  MarketLifecycleModule,
  MockFeePolicy,
  OracleModuleHarness,
  RiskModule,
  IcicleOptionsCore,
  IcicleOptionsDeployer,
  IcicleOptionsLPShare,
  IcicleOptionsPosition,
  IcicleOptionsUSDToken,
  TradeModule,
} from "../../../typechain-types";
import { WAD } from "../../helpers/constants";

type DeployFixture = {
  owner: string;
  payment: IcicleOptionsUSDToken;
  feePolicy: MockFeePolicy;
  tradeModule: TradeModule;
  lifecycleModule: MarketLifecycleModule;
  riskModule: RiskModule;
  vaultModule: LPVaultModule;
  oracleModule: OracleModuleHarness;
  coreImpl: IcicleOptionsCore;
  positionImpl: IcicleOptionsPosition;
  lpShareImpl: IcicleOptionsLPShare;
  deployer: IcicleOptionsDeployer;
};

function proxyInitCodeHash(proxyBytecode: string, impl: string): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [impl, "0x"]
  );
  const initCode = ethers.concat([proxyBytecode, encoded]);
  return ethers.keccak256(initCode);
}

async function deployFixture(): Promise<DeployFixture> {
  const [owner] = await ethers.getSigners();

  const payment = (await (
    await ethers.getContractFactory("IcicleOptionsUSDToken")
  ).deploy()) as IcicleOptionsUSDToken;

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

  const feePolicy = (await (
    await ethers.getContractFactory("MockFeePolicy")
  ).deploy(0)) as MockFeePolicy;

  const coreImplFactory = await ethers.getContractFactory("IcicleOptionsCore");
  const coreImpl = (await coreImplFactory.deploy()) as IcicleOptionsCore;

  const positionImpl = (await (
    await ethers.getContractFactory("IcicleOptionsPosition")
  ).deploy()) as IcicleOptionsPosition;

  const lpShareImpl = (await (
    await ethers.getContractFactory("IcicleOptionsLPShare")
  ).deploy()) as IcicleOptionsLPShare;

  const deployer = (await (
    await ethers.getContractFactory("IcicleOptionsDeployer")
  ).deploy(owner.address)) as IcicleOptionsDeployer;

  return {
    owner: owner.address,
    payment,
    feePolicy,
    tradeModule,
    lifecycleModule,
    riskModule,
    vaultModule,
    oracleModule,
    coreImpl,
    positionImpl,
    lpShareImpl,
    deployer,
  };
}

describe("IcicleOptionsDeployer", () => {
  it("deploys deterministic proxies and initializes wiring", async () => {
    const fixture = await deployFixture();

    const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxyBytecode = proxyFactory.bytecode;
    const deployerAddress = await fixture.deployer.getAddress();
    const coreImplAddress = await fixture.coreImpl.getAddress();
    const positionImplAddress = await fixture.positionImpl.getAddress();
    const lpShareImplAddress = await fixture.lpShareImpl.getAddress();
    const paymentAddress = await fixture.payment.getAddress();

    const coreSalt = ethers.keccak256(ethers.toUtf8Bytes("CORE_PROXY"));
    const positionSalt = ethers.keccak256(ethers.toUtf8Bytes("POSITION_PROXY"));
    const lpShareSalt = ethers.keccak256(ethers.toUtf8Bytes("LPSHARE_PROXY"));

    const coreInitHash = proxyInitCodeHash(proxyBytecode, coreImplAddress);
    const positionInitHash = proxyInitCodeHash(proxyBytecode, positionImplAddress);
    const lpShareInitHash = proxyInitCodeHash(proxyBytecode, lpShareImplAddress);

    const predictedCore = ethers.getCreate2Address(
      deployerAddress,
      coreSalt,
      coreInitHash
    );
    const predictedPosition = ethers.getCreate2Address(
      deployerAddress,
      positionSalt,
      positionInitHash
    );
    const predictedLPShare = ethers.getCreate2Address(
      deployerAddress,
      lpShareSalt,
      lpShareInitHash
    );

    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: paymentAddress,
      positionContract: predictedPosition,
      lpShareToken: predictedLPShare,
      tradeModule: await fixture.tradeModule.getAddress(),
      lifecycleModule: await fixture.lifecycleModule.getAddress(),
      riskModule: await fixture.riskModule.getAddress(),
      vaultModule: await fixture.vaultModule.getAddress(),
      oracleModule: await fixture.oracleModule.getAddress(),
      ownerSafe: fixture.owner,
      settlementSubmitWindow: 60,
      pendingOpsWindow: 30,
      claimDelaySeconds: 90,
      redstoneFeedId: ethers.encodeBytes32String("BTC"),
      redstoneFeedDecimals: 8,
      maxSampleDistance: 600,
      futureTolerance: 60,
      lambda: WAD / 10n,
      kDrawdown: WAD,
      enforceAlpha: true,
      rhoBS: WAD / 5n,
      phiLP: (WAD * 7n) / 10n,
      phiBS: WAD / 5n,
      phiTR: WAD / 10n,
      withdrawalLagBatches: 1,
      operatorAllowlist: [fixture.owner],
    };

    await fixture.deployer.deployAllDeterministic(
      coreImplAddress,
      positionImplAddress,
      lpShareImplAddress,
      coreSalt,
      positionSalt,
      lpShareSalt,
      predictedCore,
      predictedPosition,
      predictedLPShare,
      coreParams,
      "Icicle Options LP",
      "ICOLP"
    );

    const core = await ethers.getContractAt("IcicleOptionsCore", predictedCore);
    const position = await ethers.getContractAt("IcicleOptionsPosition", predictedPosition);
    const lpShare = await ethers.getContractAt("IcicleOptionsLPShare", predictedLPShare);

    expect(await core.owner()).to.equal(fixture.owner);
    expect(await position.owner()).to.equal(fixture.owner);
    expect(await lpShare.owner()).to.equal(fixture.owner);

    expect(await core.positionContract()).to.equal(predictedPosition);
    expect(await core.lpShareToken()).to.equal(predictedLPShare);
    expect(await position.core()).to.equal(predictedCore);
    expect(await lpShare.core()).to.equal(predictedCore);
    expect(await core.tradeModule()).to.equal(fixture.tradeModule.target);
    expect(await core.lifecycleModule()).to.equal(fixture.lifecycleModule.target);
    expect(await core.riskModule()).to.equal(fixture.riskModule.target);
    expect(await core.vaultModule()).to.equal(fixture.vaultModule.target);
    expect(await core.oracleModule()).to.equal(fixture.oracleModule.target);
    expect(await core.operators(fixture.owner)).to.equal(true);
    expect(await fixture.deployer.executed()).to.equal(true);
  });

  it("reverts when expected addresses mismatch", async () => {
    const fixture = await deployFixture();

    const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxyBytecode = proxyFactory.bytecode;
    const deployerAddress = await fixture.deployer.getAddress();
    const coreImplAddress = await fixture.coreImpl.getAddress();
    const positionImplAddress = await fixture.positionImpl.getAddress();
    const lpShareImplAddress = await fixture.lpShareImpl.getAddress();
    const paymentAddress = await fixture.payment.getAddress();

    const coreSalt = ethers.keccak256(ethers.toUtf8Bytes("CORE_PROXY"));
    const positionSalt = ethers.keccak256(ethers.toUtf8Bytes("POSITION_PROXY"));
    const lpShareSalt = ethers.keccak256(ethers.toUtf8Bytes("LPSHARE_PROXY"));

    const positionInitHash = proxyInitCodeHash(proxyBytecode, positionImplAddress);
    const lpShareInitHash = proxyInitCodeHash(proxyBytecode, lpShareImplAddress);

    const predictedPosition = ethers.getCreate2Address(
      deployerAddress,
      positionSalt,
      positionInitHash
    );
    const predictedLPShare = ethers.getCreate2Address(
      deployerAddress,
      lpShareSalt,
      lpShareInitHash
    );

    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: paymentAddress,
      positionContract: predictedPosition,
      lpShareToken: predictedLPShare,
      tradeModule: await fixture.tradeModule.getAddress(),
      lifecycleModule: await fixture.lifecycleModule.getAddress(),
      riskModule: await fixture.riskModule.getAddress(),
      vaultModule: await fixture.vaultModule.getAddress(),
      oracleModule: await fixture.oracleModule.getAddress(),
      ownerSafe: fixture.owner,
      settlementSubmitWindow: 60,
      pendingOpsWindow: 30,
      claimDelaySeconds: 90,
      redstoneFeedId: ethers.encodeBytes32String("BTC"),
      redstoneFeedDecimals: 8,
      maxSampleDistance: 600,
      futureTolerance: 60,
      lambda: WAD / 10n,
      kDrawdown: WAD,
      enforceAlpha: true,
      rhoBS: WAD / 5n,
      phiLP: (WAD * 7n) / 10n,
      phiBS: WAD / 5n,
      phiTR: WAD / 10n,
      withdrawalLagBatches: 1,
      operatorAllowlist: [fixture.owner],
    };

    const badExpected = ethers.getAddress("0x000000000000000000000000000000000000dEaD");
    await expect(
      fixture.deployer.deployAllDeterministic(
        coreImplAddress,
        positionImplAddress,
        lpShareImplAddress,
        coreSalt,
        positionSalt,
        lpShareSalt,
        badExpected,
        predictedPosition,
        predictedLPShare,
        coreParams,
        "Icicle Options LP",
        "ICOLP"
      )
    ).to.be.revertedWithCustomError(fixture.deployer, "Create2AddressMismatch");
  });

  it("reverts on repeated deployment", async () => {
    const fixture = await deployFixture();

    const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxyBytecode = proxyFactory.bytecode;
    const deployerAddress = await fixture.deployer.getAddress();
    const coreImplAddress = await fixture.coreImpl.getAddress();
    const positionImplAddress = await fixture.positionImpl.getAddress();
    const lpShareImplAddress = await fixture.lpShareImpl.getAddress();
    const paymentAddress = await fixture.payment.getAddress();

    const coreSalt = ethers.keccak256(ethers.toUtf8Bytes("CORE_PROXY"));
    const positionSalt = ethers.keccak256(ethers.toUtf8Bytes("POSITION_PROXY"));
    const lpShareSalt = ethers.keccak256(ethers.toUtf8Bytes("LPSHARE_PROXY"));

    const coreInitHash = proxyInitCodeHash(proxyBytecode, coreImplAddress);
    const positionInitHash = proxyInitCodeHash(proxyBytecode, positionImplAddress);
    const lpShareInitHash = proxyInitCodeHash(proxyBytecode, lpShareImplAddress);

    const predictedCore = ethers.getCreate2Address(
      deployerAddress,
      coreSalt,
      coreInitHash
    );
    const predictedPosition = ethers.getCreate2Address(
      deployerAddress,
      positionSalt,
      positionInitHash
    );
    const predictedLPShare = ethers.getCreate2Address(
      deployerAddress,
      lpShareSalt,
      lpShareInitHash
    );

    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: paymentAddress,
      positionContract: predictedPosition,
      lpShareToken: predictedLPShare,
      tradeModule: await fixture.tradeModule.getAddress(),
      lifecycleModule: await fixture.lifecycleModule.getAddress(),
      riskModule: await fixture.riskModule.getAddress(),
      vaultModule: await fixture.vaultModule.getAddress(),
      oracleModule: await fixture.oracleModule.getAddress(),
      ownerSafe: fixture.owner,
      settlementSubmitWindow: 60,
      pendingOpsWindow: 30,
      claimDelaySeconds: 90,
      redstoneFeedId: ethers.encodeBytes32String("BTC"),
      redstoneFeedDecimals: 8,
      maxSampleDistance: 600,
      futureTolerance: 60,
      lambda: WAD / 10n,
      kDrawdown: WAD,
      enforceAlpha: true,
      rhoBS: WAD / 5n,
      phiLP: (WAD * 7n) / 10n,
      phiBS: WAD / 5n,
      phiTR: WAD / 10n,
      withdrawalLagBatches: 1,
      operatorAllowlist: [fixture.owner],
    };

    await fixture.deployer.deployAllDeterministic(
      coreImplAddress,
      positionImplAddress,
      lpShareImplAddress,
      coreSalt,
      positionSalt,
      lpShareSalt,
      predictedCore,
      predictedPosition,
      predictedLPShare,
      coreParams,
      "Icicle Options LP",
      "ICOLP"
    );

    await expect(
      fixture.deployer.deployAllDeterministic(
        coreImplAddress,
        positionImplAddress,
        lpShareImplAddress,
        coreSalt,
        positionSalt,
        lpShareSalt,
        predictedCore,
        predictedPosition,
        predictedLPShare,
        coreParams,
        "Icicle Options LP",
        "ICOLP"
      )
    ).to.be.revertedWithCustomError(fixture.deployer, "DeploymentAlreadyExecuted");
  });
});
