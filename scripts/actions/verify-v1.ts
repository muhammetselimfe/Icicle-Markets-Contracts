import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

type VerifyTarget = {
  name: string;
  address?: string;
  contract: string;
  constructorArguments?: unknown[];
  libraries?: Record<string, string>;
};

function isStrict(env: Environment): boolean {
  return env === "prod" || process.env.STRICT_VERIFY === "1";
}

export async function verifyAction(env: Environment) {
  const { network } = hre;
  const strict = isStrict(env);
  console.log(`[verify] environment=${env} network=${network.name} strict=${strict ? "1" : "0"}`);
  const envData = loadEnvironment(env);

  const missing: string[] = [];
  const failures: string[] = [];

  const lazyAddress = envData.contracts.LazyMulSegmentTree;
  const moduleLibraries = lazyAddress ? { LazyMulSegmentTree: lazyAddress } : undefined;
  const canVerifyLinkedModules = Boolean(moduleLibraries);

  const paymentTokenAddress = envData.contracts.PaymentToken;
  const paymentTokenVerifyContract =
    envData.config?.paymentTokenVerifyContract ?? process.env.PAYMENT_TOKEN_VERIFY_CONTRACT;
  if (!paymentTokenAddress && (envData.contracts.IcicleOptionsCoreImplementation || envData.contracts.IcicleOptionsCoreProxy)) {
    missing.push("PaymentToken address");
  }
  const deployerEOA = envData.config?.deployerEOA ?? process.env.DEPLOYER_EOA;
  if (!deployerEOA && (envData.contracts.IcicleOptionsCreate2Factory || envData.contracts.IcicleOptionsDeployer)) {
    missing.push("deployerEOA (for IcicleOptionsCreate2Factory / IcicleOptionsDeployer)");
  }
  const coreImpl = envData.contracts.IcicleOptionsCoreImplementation;
  const positionImpl = envData.contracts.IcicleOptionsPositionImplementation;
  const lpShareImpl = envData.contracts.IcicleOptionsLPShareImplementation;
  const proxyContract = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";
  if (envData.contracts.IcicleOptionsCoreProxy && !coreImpl) {
    missing.push("IcicleOptionsCoreImplementation (for IcicleOptionsCoreProxy)");
  }
  if (envData.contracts.IcicleOptionsPositionProxy && !positionImpl) {
    missing.push("IcicleOptionsPositionImplementation (for IcicleOptionsPositionProxy)");
  }
  if (envData.contracts.IcicleOptionsLPShareProxy && !lpShareImpl) {
    missing.push("IcicleOptionsLPShareImplementation (for IcicleOptionsLPShareProxy)");
  }

  const targets: VerifyTarget[] = [
    {
      name: "IcicleOptionsCoreImplementation",
      address: coreImpl,
      contract: "contracts/core/IcicleOptionsCore.sol:IcicleOptionsCore",
    },
    {
      name: "IcicleOptionsPositionImplementation",
      address: positionImpl,
      contract: "contracts/position/IcicleOptionsPosition.sol:IcicleOptionsPosition",
    },
    {
      name: "IcicleOptionsLPShareImplementation",
      address: lpShareImpl,
      contract: "contracts/tokens/IcicleOptionsLPShare.sol:IcicleOptionsLPShare",
    },
    ...(envData.contracts.IcicleOptionsCoreProxy
      ? [
          {
            name: "IcicleOptionsCoreProxy",
            address: envData.contracts.IcicleOptionsCoreProxy,
            contract: proxyContract,
            constructorArguments: coreImpl ? [coreImpl, "0x"] : undefined,
          },
        ]
      : []),
    ...(envData.contracts.IcicleOptionsPositionProxy
      ? [
          {
            name: "IcicleOptionsPositionProxy",
            address: envData.contracts.IcicleOptionsPositionProxy,
            contract: proxyContract,
            constructorArguments: positionImpl ? [positionImpl, "0x"] : undefined,
          },
        ]
      : []),
    ...(envData.contracts.IcicleOptionsLPShareProxy
      ? [
          {
            name: "IcicleOptionsLPShareProxy",
            address: envData.contracts.IcicleOptionsLPShareProxy,
            contract: proxyContract,
            constructorArguments: lpShareImpl ? [lpShareImpl, "0x"] : undefined,
          },
        ]
      : []),
    {
      name: "LazyMulSegmentTree",
      address: envData.contracts.LazyMulSegmentTree,
      contract: "contracts/lib/LazyMulSegmentTree.sol:LazyMulSegmentTree",
    },
    ...(envData.contracts.IcicleOptionsCreate2Factory && deployerEOA
      ? [
          {
            name: "IcicleOptionsCreate2Factory",
            address: envData.contracts.IcicleOptionsCreate2Factory,
            contract: "contracts/deploy/IcicleOptionsCreate2Factory.sol:IcicleOptionsCreate2Factory",
            constructorArguments: [deployerEOA],
          },
        ]
      : []),
    ...(envData.contracts.IcicleOptionsDeployer && deployerEOA
      ? [
          {
            name: "IcicleOptionsDeployer",
            address: envData.contracts.IcicleOptionsDeployer,
            contract: "contracts/deploy/IcicleOptionsDeployer.sol:IcicleOptionsDeployer",
            constructorArguments: [deployerEOA],
          },
        ]
      : []),
    ...(canVerifyLinkedModules
      ? [
          {
            name: "TradeModule",
            address: envData.contracts.TradeModule,
            contract: "contracts/modules/TradeModule.sol:TradeModule",
            libraries: moduleLibraries,
          },
          {
            name: "MarketLifecycleModule",
            address: envData.contracts.MarketLifecycleModule,
            contract: "contracts/modules/MarketLifecycleModule.sol:MarketLifecycleModule",
            libraries: moduleLibraries,
          },
        ]
      : []),
    {
      name: "OracleModule",
      address: envData.contracts.OracleModule,
      contract: "contracts/modules/OracleModule.sol:OracleModule",
    },
    ...(envData.contracts.RiskModule
      ? [
          {
            name: "RiskModule",
            address: envData.contracts.RiskModule,
            contract: "contracts/modules/RiskModule.sol:RiskModule",
          },
        ]
      : []),
    ...(envData.contracts.LPVaultModule || envData.contracts.VaultModule
      ? [
          {
            name: "LPVaultModule",
            address: envData.contracts.LPVaultModule ?? envData.contracts.VaultModule,
            contract: "contracts/modules/LPVaultModule.sol:LPVaultModule",
          },
        ]
      : []),
    ...(envData.contracts.FeePolicyNull
      ? [
          {
            name: "NullFeePolicy",
            address: envData.contracts.FeePolicyNull,
            contract: "contracts/fees/NullFeePolicy.sol:NullFeePolicy",
          },
        ]
      : []),
    ...(envData.contracts.FeePolicy10bps
      ? [
          {
            name: "PercentFeePolicy10bps",
            address: envData.contracts.FeePolicy10bps,
            contract: "contracts/fees/PercentFeePolicies.sol:PercentFeePolicy10bps",
          },
        ]
      : []),
    ...(envData.contracts.FeePolicy50bps
      ? [
          {
            name: "PercentFeePolicy50bps",
            address: envData.contracts.FeePolicy50bps,
            contract: "contracts/fees/PercentFeePolicies.sol:PercentFeePolicy50bps",
          },
        ]
      : []),
    ...(envData.contracts.FeePolicy100bps
      ? [
          {
            name: "PercentFeePolicy100bps",
            address: envData.contracts.FeePolicy100bps,
            contract: "contracts/fees/PercentFeePolicies.sol:PercentFeePolicy100bps",
          },
        ]
      : []),
    ...(envData.contracts.FeePolicy200bps
      ? [
          {
            name: "PercentFeePolicy200bps",
            address: envData.contracts.FeePolicy200bps,
            contract: "contracts/fees/PercentFeePolicies.sol:PercentFeePolicy200bps",
          },
        ]
      : []),
    ...(paymentTokenAddress && paymentTokenVerifyContract
      ? [
          {
            name: "PaymentToken",
            address: paymentTokenAddress,
            contract: paymentTokenVerifyContract,
          },
        ]
      : []),
  ];

  for (const target of targets) {
    if (!target.address) {
      missing.push(`${target.name} address`);
      continue;
    }
    if (target.libraries && Object.values(target.libraries).some((value) => !value)) {
      missing.push(`${target.name} libraries`);
      continue;
    }

    try {
      console.log(`[verify] verifying ${target.name} (${target.address})`);
      const params: Record<string, unknown> = {
        address: target.address,
        contract: target.contract,
      };
      if (target.constructorArguments) {
        params.constructorArguments = target.constructorArguments;
      }
      if (target.libraries) {
        params.libraries = target.libraries;
      }
      await hre.run("verify:verify", params);
    } catch (err) {
      const message = (err as Error).message;
      const failure = `${target.name} (${target.address}): ${message}`;
      if (strict) {
        failures.push(failure);
      } else {
        console.warn(`[verify] skipping ${target.address}: ${message}`);
      }
    }
  }

  if (missing.length) {
    const msg = `[verify] missing inputs: ${missing.join(", ")}`;
    if (strict) {
      throw new Error(msg);
    }
    console.warn(msg);
  }

  if (failures.length) {
    throw new Error(`[verify] failed: ${failures.join(" | ")}`);
  }

  console.log("[verify] done");
}
