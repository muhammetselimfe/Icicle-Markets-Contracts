import hre from "hardhat";
import type {
  ContractTransactionReceipt,
  ContractTransactionResponse,
} from "ethers";
import type { Environment } from "../types/environment";
import { predictCreate2 } from "./predict-create2";

type GasEntry = { label: string; gasUsed: bigint };

function sumGas(entries: GasEntry[]): bigint {
  return entries.reduce((acc, entry) => acc + entry.gasUsed, 0n);
}

async function recordGas(
  label: string,
  txPromise: Promise<ContractTransactionResponse>,
  entries: GasEntry[]
): Promise<ContractTransactionReceipt> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error(`[estimate-gas] missing receipt for ${label}`);
  }
  entries.push({ label, gasUsed: receipt.gasUsed });
  return receipt;
}

export async function estimateDeployGasAction(env: Environment = "local") {
  const { ethers, network } = hre;
  console.log(`[estimate-gas] environment=${env} network=${network.name}`);
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const entries: GasEntry[] = [];

  const factory = await ethers.getContractFactory("IcicleOptionsCreate2Factory");
  const factoryDeploy = await factory.deploy(deployer.address);
  await factoryDeploy.waitForDeployment();
  const factoryTx = factoryDeploy.deploymentTransaction();
  if (factoryTx) {
    const receipt = await factoryTx.wait();
    if (!receipt) {
      throw new Error("[estimate-gas] missing receipt for IcicleOptionsCreate2Factory");
    }
    entries.push({ label: "IcicleOptionsCreate2Factory", gasUsed: receipt.gasUsed });
  }
  const create2FactoryAddress = factoryDeploy.target.toString();

  const paymentToken = await (await ethers.getContractFactory("IcicleOptionsUSDToken")).deploy();
  const paymentReceipt = await paymentToken.deploymentTransaction()?.wait();
  if (paymentReceipt) {
    entries.push({ label: "PaymentTokenMock", gasUsed: paymentReceipt.gasUsed });
  }
  const paymentAddress = paymentToken.target.toString();

  const nullFeePolicy = await (await ethers.getContractFactory("NullFeePolicy")).deploy();
  const nullReceipt = await nullFeePolicy.deploymentTransaction()?.wait();
  if (nullReceipt) entries.push({ label: "NullFeePolicy", gasUsed: nullReceipt.gasUsed });

  const feePolicy10bps = await (await ethers.getContractFactory("PercentFeePolicy10bps")).deploy();
  const fee10Receipt = await feePolicy10bps.deploymentTransaction()?.wait();
  if (fee10Receipt) entries.push({ label: "PercentFeePolicy10bps", gasUsed: fee10Receipt.gasUsed });

  const feePolicy50bps = await (await ethers.getContractFactory("PercentFeePolicy50bps")).deploy();
  const fee50Receipt = await feePolicy50bps.deploymentTransaction()?.wait();
  if (fee50Receipt) entries.push({ label: "PercentFeePolicy50bps", gasUsed: fee50Receipt.gasUsed });

  const feePolicy100bps = await (await ethers.getContractFactory("PercentFeePolicy100bps")).deploy();
  const fee100Receipt = await feePolicy100bps.deploymentTransaction()?.wait();
  if (fee100Receipt) entries.push({ label: "PercentFeePolicy100bps", gasUsed: fee100Receipt.gasUsed });

  const feePolicy200bps = await (await ethers.getContractFactory("PercentFeePolicy200bps")).deploy();
  const fee200Receipt = await feePolicy200bps.deploymentTransaction()?.wait();
  if (fee200Receipt) entries.push({ label: "PercentFeePolicy200bps", gasUsed: fee200Receipt.gasUsed });

  const lazy = await (await ethers.getContractFactory("LazyMulSegmentTree")).deploy();
  const lazyReceipt = await lazy.deploymentTransaction()?.wait();
  if (lazyReceipt) entries.push({ label: "LazyMulSegmentTree", gasUsed: lazyReceipt.gasUsed });

  const tradeModule = await (
    await ethers.getContractFactory("TradeModule", {
      libraries: { LazyMulSegmentTree: lazy.target },
    })
  ).deploy();
  const tradeReceipt = await tradeModule.deploymentTransaction()?.wait();
  if (tradeReceipt) entries.push({ label: "TradeModule", gasUsed: tradeReceipt.gasUsed });

  const lifecycleModule = await (
    await ethers.getContractFactory("MarketLifecycleModule", {
      libraries: { LazyMulSegmentTree: lazy.target },
    })
  ).deploy();
  const lifecycleReceipt = await lifecycleModule.deploymentTransaction()?.wait();
  if (lifecycleReceipt) entries.push({ label: "MarketLifecycleModule", gasUsed: lifecycleReceipt.gasUsed });

  const oracleModule = await (await ethers.getContractFactory("OracleModule")).deploy();
  const oracleReceipt = await oracleModule.deploymentTransaction()?.wait();
  if (oracleReceipt) entries.push({ label: "OracleModule", gasUsed: oracleReceipt.gasUsed });

  const riskModule = await (await ethers.getContractFactory("RiskModule")).deploy();
  const riskReceipt = await riskModule.deploymentTransaction()?.wait();
  if (riskReceipt) entries.push({ label: "RiskModule", gasUsed: riskReceipt.gasUsed });

  const vaultModule = await (await ethers.getContractFactory("LPVaultModule")).deploy();
  const vaultReceipt = await vaultModule.deploymentTransaction()?.wait();
  if (vaultReceipt) entries.push({ label: "LPVaultModule", gasUsed: vaultReceipt.gasUsed });

  const coreImpl = await (await ethers.getContractFactory("IcicleOptionsCore")).deploy();
  const coreImplReceipt = await coreImpl.deploymentTransaction()?.wait();
  if (coreImplReceipt) entries.push({ label: "IcicleOptionsCoreImpl", gasUsed: coreImplReceipt.gasUsed });

  const positionImpl = await (await ethers.getContractFactory("IcicleOptionsPosition")).deploy();
  const positionImplReceipt = await positionImpl.deploymentTransaction()?.wait();
  if (positionImplReceipt) entries.push({ label: "IcicleOptionsPositionImpl", gasUsed: positionImplReceipt.gasUsed });

  const lpShareImpl = await (await ethers.getContractFactory("IcicleOptionsLPShare")).deploy();
  const lpShareImplReceipt = await lpShareImpl.deploymentTransaction()?.wait();
  if (lpShareImplReceipt) entries.push({ label: "IcicleOptionsLPShareImpl", gasUsed: lpShareImplReceipt.gasUsed });

  const { chainId } = await ethers.provider.getNetwork();
  const prediction = await predictCreate2({
    env,
    chainId: Number(chainId),
    deployerEOA: deployer.address,
    create2Factory: create2FactoryAddress,
    coreImpl: coreImpl.target.toString(),
    positionImpl: positionImpl.target.toString(),
    lpShareImpl: lpShareImpl.target.toString(),
    release: "v1",
    vanityPrefix: "0x516",
    maxNonce: 1_000_000,
  });

  const deployerFactory = await ethers.getContractFactory("IcicleOptionsDeployer");
  const deployerInitCode = ethers.concat([
    deployerFactory.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [deployer.address]),
  ]);

  const create2Factory = await ethers.getContractAt("IcicleOptionsCreate2Factory", create2FactoryAddress);
  await recordGas(
    "IcicleOptionsDeployer (CREATE2)",
    create2Factory.deploy(prediction.create2.salts.DEPLOYER.salt, deployerInitCode),
    entries
  );

  const coreParams = {
    paymentToken: paymentAddress,
    positionContract: prediction.contracts.IcicleOptionsPositionProxy,
    lpShareToken: prediction.contracts.IcicleOptionsLPShareProxy,
    tradeModule: tradeModule.target.toString(),
    lifecycleModule: lifecycleModule.target.toString(),
    riskModule: riskModule.target.toString(),
    vaultModule: vaultModule.target.toString(),
    oracleModule: oracleModule.target.toString(),
    ownerSafe: deployer.address,
    settlementSubmitWindow: 600n,
    pendingOpsWindow: 300n,
    claimDelaySeconds: 900n,
    redstoneFeedId: ethers.encodeBytes32String("BTC"),
    redstoneFeedDecimals: 8,
    maxSampleDistance: 600n,
    futureTolerance: 60n,
    lambda: ethers.parseEther("0.3"),
    kDrawdown: ethers.parseEther("1"),
    enforceAlpha: false,
    rhoBS: ethers.parseEther("0.2"),
    phiLP: ethers.parseEther("0.7"),
    phiBS: ethers.parseEther("0.2"),
    phiTR: ethers.parseEther("0.1"),
    withdrawalLagBatches: 0,
    operatorAllowlist: [deployer.address],
  };

  const deployerContract = await ethers.getContractAt(
    "IcicleOptionsDeployer",
    prediction.contracts.IcicleOptionsDeployer
  );
  await recordGas(
    "deployAllDeterministic (proxies + init)",
    deployerContract.deployAllDeterministic(
      coreImpl.target.toString(),
      positionImpl.target.toString(),
      lpShareImpl.target.toString(),
      prediction.create2.salts.CORE_PROXY.salt,
      prediction.create2.salts.POSITION_PROXY.salt,
      prediction.create2.salts.LPSHARE_PROXY.salt,
      prediction.contracts.IcicleOptionsCoreProxy,
      prediction.contracts.IcicleOptionsPositionProxy,
      prediction.contracts.IcicleOptionsLPShareProxy,
      coreParams,
      "Icicle Options LP",
      "ICOLP"
    ),
    entries
  );

  const core = await ethers.getContractAt("IcicleOptionsCore", prediction.contracts.IcicleOptionsCoreProxy);
  await recordGas(
    "approve paymentToken",
    paymentToken.approve(core.target, ethers.MaxUint256),
    entries
  );
  await recordGas("seedVault", core.seedVault(1_000_000_000n), entries);
  await recordGas("fundBackstop", core.fundBackstop(1_000_000_000n), entries);

  console.log("\nGas Summary");
  for (const entry of entries) {
    console.log(`- ${entry.label}: ${entry.gasUsed.toString()}`);
  }
  console.log(`Total gas: ${sumGas(entries).toString()}`);
}

if (require.main === module) {
  estimateDeployGasAction().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
