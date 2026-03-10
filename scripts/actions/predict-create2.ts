import fs from "fs";
import path from "path";
import hre from "hardhat";
import type { Environment } from "../types/environment";
import { loadEnvironment } from "../utils/environment";

const MANUAL_CONFIG = {
  vanityPrefix: "0x516",
  maxNonce: 1_000_000,
  release: "v1",
};

type Create2Component = "DEPLOYER" | "CORE_PROXY" | "POSITION_PROXY" | "LPSHARE_PROXY";

export interface Create2PredictionInput {
  env: Environment;
  chainId: number;
  deployerEOA: string;
  create2Factory: string;
  coreImpl: string;
  positionImpl: string;
  lpShareImpl: string;
  release?: string;
  vanityPrefix?: string;
  maxNonce?: number;
}

export interface Create2Prediction {
  network: Environment;
  chainId: number;
  release: string;
  deployerEOA: string;
  create2Factory: string;
  contracts: Record<string, string>;
  create2: {
    vanityPrefix: string;
    maxNonce: number;
    salts: Record<Create2Component, { nonce: number; salt: string }>;
    initCodeHash: Record<Create2Component, string>;
  };
}

function getPredictedPath(env: Environment): string {
  return path.join("scripts", "environments", `${env}.predicted.json`);
}

function buildBase(chainId: number, env: Environment, release: string, component: Create2Component): string {
  return `icicle-options-v1|${chainId}|${env}|${release}|${component}`;
}

function buildSalt(base: string, nonce: number): string {
  return hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`${base}|${nonce}`));
}

function isVanityMatch(address: string, prefix: string): boolean {
  return address.toLowerCase().startsWith(prefix.toLowerCase());
}

function proxyInitCodeHash(proxyBytecode: string, impl: string): string {
  const encoded = hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes"],
    [impl, "0x"]
  );
  const initCode = hre.ethers.concat([proxyBytecode, encoded]);
  return hre.ethers.keccak256(initCode);
}

function deployerInitCodeHash(deployerBytecode: string, deployerEOA: string): string {
  const encoded = hre.ethers.AbiCoder.defaultAbiCoder().encode(["address"], [deployerEOA]);
  const initCode = hre.ethers.concat([deployerBytecode, encoded]);
  return hre.ethers.keccak256(initCode);
}

async function loadProxyBytecode(): Promise<string> {
  const proxyFactory = await hre.ethers.getContractFactory("ERC1967Proxy");
  return proxyFactory.bytecode;
}

export async function predictCreate2(input: Create2PredictionInput): Promise<Create2Prediction> {
  const vanityPrefix = input.vanityPrefix ?? MANUAL_CONFIG.vanityPrefix;
  const maxNonce = input.maxNonce ?? MANUAL_CONFIG.maxNonce;
  const release = input.release ?? MANUAL_CONFIG.release;

  const proxyBytecode = await loadProxyBytecode();
  const deployerFactory = await hre.ethers.getContractFactory("IcicleOptionsDeployer");
  const deployerInitHash = deployerInitCodeHash(deployerFactory.bytecode, input.deployerEOA);

  const deployerBase = buildBase(input.chainId, input.env, release, "DEPLOYER");
  const deployerSalt = buildSalt(deployerBase, 0);
  const deployerAddress = hre.ethers.getCreate2Address(
    input.create2Factory,
    deployerSalt,
    deployerInitHash
  );

  const coreInitHash = proxyInitCodeHash(proxyBytecode, input.coreImpl);
  const positionInitHash = proxyInitCodeHash(proxyBytecode, input.positionImpl);
  const lpShareInitHash = proxyInitCodeHash(proxyBytecode, input.lpShareImpl);

  const coreBase = buildBase(input.chainId, input.env, release, "CORE_PROXY");
  const positionBase = buildBase(input.chainId, input.env, release, "POSITION_PROXY");
  const lpShareBase = buildBase(input.chainId, input.env, release, "LPSHARE_PROXY");

  let coreSalt = "";
  let coreNonce = 0;
  let coreAddress = "";
  for (let nonce = 0; nonce <= maxNonce; nonce++) {
    const salt = buildSalt(coreBase, nonce);
    const address = hre.ethers.getCreate2Address(deployerAddress, salt, coreInitHash);
    if (isVanityMatch(address, vanityPrefix)) {
      coreSalt = salt;
      coreNonce = nonce;
      coreAddress = address;
      break;
    }
  }
  if (!coreSalt) {
    throw new Error(`Core vanity not found within MAX_NONCE=${maxNonce} for prefix ${vanityPrefix}`);
  }

  const positionSalt = buildSalt(positionBase, 0);
  const lpShareSalt = buildSalt(lpShareBase, 0);
  const positionAddress = hre.ethers.getCreate2Address(deployerAddress, positionSalt, positionInitHash);
  const lpShareAddress = hre.ethers.getCreate2Address(deployerAddress, lpShareSalt, lpShareInitHash);

  return {
    network: input.env,
    chainId: input.chainId,
    release,
    deployerEOA: input.deployerEOA,
    create2Factory: input.create2Factory,
    contracts: {
      IcicleOptionsCreate2Factory: input.create2Factory,
      IcicleOptionsDeployer: deployerAddress,
      IcicleOptionsCoreProxy: coreAddress,
      IcicleOptionsPositionProxy: positionAddress,
      IcicleOptionsLPShareProxy: lpShareAddress,
      IcicleOptionsLPShare: lpShareAddress,
      IcicleOptionsCoreImplementation: input.coreImpl,
      IcicleOptionsPositionImplementation: input.positionImpl,
      IcicleOptionsLPShareImplementation: input.lpShareImpl,
    },
    create2: {
      vanityPrefix,
      maxNonce,
      salts: {
        DEPLOYER: { nonce: 0, salt: deployerSalt },
        CORE_PROXY: { nonce: coreNonce, salt: coreSalt },
        POSITION_PROXY: { nonce: 0, salt: positionSalt },
        LPSHARE_PROXY: { nonce: 0, salt: lpShareSalt },
      },
      initCodeHash: {
        DEPLOYER: deployerInitHash,
        CORE_PROXY: coreInitHash,
        POSITION_PROXY: positionInitHash,
        LPSHARE_PROXY: lpShareInitHash,
      },
    },
  };
}

export async function predictCreate2Action(env: Environment) {
  const { ethers, network } = hre;
  console.log(`[predict-create2] environment=${env} network=${network.name}`);
  const [deployer] = await ethers.getSigners();

  const envData = loadEnvironment(env);
  const create2Factory = envData.contracts.IcicleOptionsCreate2Factory;
  if (!create2Factory) {
    throw new Error("Missing IcicleOptionsCreate2Factory in environment file");
  }
  const coreImpl = envData.contracts.IcicleOptionsCoreImplementation;
  const positionImpl = envData.contracts.IcicleOptionsPositionImplementation;
  const lpShareImpl = envData.contracts.IcicleOptionsLPShareImplementation;
  if (!coreImpl || !positionImpl || !lpShareImpl) {
    throw new Error(
      "Missing core/position/lpshare implementation addresses in environment file"
    );
  }

  const { chainId } = await ethers.provider.getNetwork();
  const prediction = await predictCreate2({
    env,
    chainId: Number(chainId),
    deployerEOA: deployer.address,
    create2Factory,
    coreImpl,
    positionImpl,
    lpShareImpl,
  });

  const outputPath = getPredictedPath(env);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(prediction, null, 2));
  console.log(`[predict-create2] wrote ${outputPath}`);
  console.log(`[predict-create2] coreProxy=${prediction.contracts.IcicleOptionsCoreProxy}`);
}
