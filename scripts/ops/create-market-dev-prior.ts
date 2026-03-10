import hre from "hardhat";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

type LiquidityMode = "auto" | "manual";
type PriorMode = "logReturn" | "priceDiff";

interface PriorConfig {
  mode: PriorMode;
  epsilon: number;
  nu: number;
  kappa: number;
  atr: number;
  minFactor: number;
  maxFactor: number;
}

interface CreateMarketConfig {
  skipStaticCall: boolean;
  feePolicyAddress: string;
  market: {
    anchorPrice: number;
    numBins: number;
    tickSpacing: number;
    startDelaySec: number;
    durationSec: number;
    settlementDelaySec: number;
    seedChunkSize: number;
    liquidity: {
      mode: LiquidityMode;
      safetyFactor: string;
      manualAlphaWad: string;
    };
  };
  prior: PriorConfig;
}

const CONFIG: CreateMarketConfig = {
  skipStaticCall: false,
  feePolicyAddress: "0x40fBd67EfD2DF8b64DE0646e4441699f38D88aA7", // dev FeePolicy10bps
  market: {
    anchorPrice: 94_000,
    numBins: 60,
    tickSpacing: 200,
    startDelaySec: -60,
    durationSec: 30 * 24 * 3600,
    settlementDelaySec: 0,
    seedChunkSize: 50,
    liquidity: {
      mode: "manual",
      safetyFactor: "0.8",
      manualAlphaWad: "300000000000000000000",
    },
  },
  prior: {
    mode: "logReturn",
    epsilon: 0.02,
    nu: 5,
    kappa: 400,
    atr: 2000,
    minFactor: 0.01,
    maxFactor: 100,
  },
};

const WAD_DECIMALS = 18;
const WAD = 10n ** 18n;
const LANCZOS_COEFFS = [
  676.5203681218851, -1259.1392167224028, 771.3234287776531,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
const LOG_SQRT_2PI = 0.9189385332046727;

function computeNumBins(minTick: number, maxTick: number, tickSpacing: number): number {
  const range = maxTick - minTick;
  if (tickSpacing <= 0 || range <= 0 || range % tickSpacing !== 0) {
    throw new Error("Invalid ticks: (maxTick - minTick) must be divisible by tickSpacing");
  }
  return range / tickSpacing;
}

function computeTickBounds(anchorPrice: number, tickSpacing: number, numBins: number): {
  minTick: number;
  maxTick: number;
  centerTick: number;
} {
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    throw new Error("Anchor price must be positive");
  }
  if (tickSpacing <= 0 || numBins <= 0) {
    throw new Error("tickSpacing and numBins must be positive");
  }

  const centerTick = Math.round(anchorPrice / tickSpacing) * tickSpacing;
  let binsBelow = Math.floor(numBins / 2);
  let binsAbove = numBins - binsBelow;
  const idealMinTick = centerTick - binsBelow * tickSpacing;

  if (idealMinTick < tickSpacing) {
    const minTick = tickSpacing;
    binsBelow = Math.floor((centerTick - minTick) / tickSpacing);
    binsAbove = numBins - binsBelow;
    const maxTick = centerTick + binsAbove * tickSpacing;
    const computedBins = (maxTick - minTick) / tickSpacing;
    if (computedBins !== numBins) {
      throw new Error(`Computed bin count mismatch: expected=${numBins} actual=${computedBins}`);
    }
    return { minTick, maxTick, centerTick };
  }

  const minTick = idealMinTick;
  const maxTick = centerTick + binsAbove * tickSpacing;
  const computedBins = (maxTick - minTick) / tickSpacing;
  if (computedBins !== numBins) {
    throw new Error(`Computed bin count mismatch: expected=${numBins} actual=${computedBins}`);
  }

  return { minTick, maxTick, centerTick };
}

function logGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }

  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS_COEFFS.length; i++) {
    x += LANCZOS_COEFFS[i] / (z + i + 1);
  }
  const t = z + LANCZOS_COEFFS.length - 0.5;
  return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function studentTPdf(x: number, nu: number): number {
  const halfNu = nu / 2;
  const logNumerator = logGamma((nu + 1) / 2);
  const logDenominator = Math.log(Math.sqrt(nu * Math.PI)) + logGamma(halfNu);
  const logTerm = -((nu + 1) / 2) * Math.log(1 + (x * x) / nu);
  return Math.exp(logNumerator - logDenominator + logTerm);
}

function assertFinite(value: number, context: string) {
  if (!Number.isFinite(value)) {
    throw new Error(`Non-finite value detected in ${context}`);
  }
}

function generatePriorFactors(args: {
  minTick: number;
  maxTick: number;
  tickSpacing: number;
  anchorPrice: number;
  atr: number;
  prior: PriorConfig;
}): bigint[] {
  const { minTick, maxTick, tickSpacing, anchorPrice, atr, prior } = args;
  const numBins = (maxTick - minTick) / tickSpacing;
  if (!Number.isInteger(numBins) || numBins <= 0) {
    throw new Error("Invalid bin configuration");
  }

  const sigma = prior.mode === "logReturn" ? atr / anchorPrice : atr;
  assertFinite(sigma, "sigma");
  if (sigma <= 0) {
    throw new Error("Sigma must be positive");
  }

  const basePrior: number[] = [];
  let pdfSum = 0;

  for (let i = 0; i < numBins; i++) {
    const tickValue = minTick + i * tickSpacing;
    let density: number;

    if (prior.mode === "logReturn") {
      const ratio = tickValue / anchorPrice;
      assertFinite(ratio, "ratio");
      if (ratio <= 0) {
        throw new Error("bin coord/anchor ratio must be positive");
      }
      const r = Math.log(ratio);
      assertFinite(r, "logReturn");
      const scaled = r / sigma;
      assertFinite(scaled, "scaled log return");
      density = studentTPdf(scaled, prior.nu) / tickValue;
    } else {
      const diff = (tickValue - anchorPrice) / sigma;
      assertFinite(diff, "priceDiff scaled");
      density = studentTPdf(diff, prior.nu);
    }

    assertFinite(density, "density");
    if (density < 0) {
      throw new Error("Density cannot be negative");
    }
    basePrior.push(density);
    pdfSum += density;
  }

  if (pdfSum <= 0) {
    throw new Error("Prior density sum must be positive");
  }

  for (let i = 0; i < basePrior.length; i++) {
    basePrior[i] = basePrior[i] / pdfSum;
  }

  const uniformWeight = 1 / numBins;
  const blendedPrior: number[] = [];
  for (let i = 0; i < numBins; i++) {
    const blended = (1 - prior.epsilon) * basePrior[i] + prior.epsilon * uniformWeight;
    assertFinite(blended, "blended prior");
    blendedPrior.push(blended);
  }

  const blendedSum = blendedPrior.reduce((acc, v) => acc + v, 0);
  for (let i = 0; i < blendedPrior.length; i++) {
    blendedPrior[i] = blendedPrior[i] / blendedSum;
  }

  const minFactorWad = hre.ethers.parseUnits(prior.minFactor.toFixed(18), 18);
  const maxFactorWad = hre.ethers.parseUnits(prior.maxFactor.toFixed(18), 18);
  const factorWad: bigint[] = [];

  for (let i = 0; i < numBins; i++) {
    const weight = blendedPrior[i] * prior.kappa;
    assertFinite(weight, "weight");
    const wadString = weight.toFixed(18);
    const wad = hre.ethers.parseUnits(wadString, 18);

    if (wad < minFactorWad || wad > maxFactorWad) {
      throw new Error(`Factor out of allowed range at index ${i}: ${weight.toFixed(6)}`);
    }
    factorWad.push(wad);
  }

  return factorWad;
}

async function decodeRevert(err: unknown) {
  const data =
    (err as { data?: string })?.data ??
    (err as { error?: { data?: string } })?.error?.data ??
    (err as { error?: { error?: { data?: string } } })?.error?.error?.data;
  if (!data) {
    console.error(err);
    return;
  }

  try {
    const artifact = await hre.artifacts.readArtifact("IcicleOptionsErrors");
    const iface = new hre.ethers.Interface(artifact.abi);
    const parsed = iface.parseError(data);
    console.error(`[create-market-dev-prior] reverted with ${parsed?.name}`);
    if (parsed?.args?.length) {
      console.error(parsed.args);
    }
  } catch (parseErr) {
    console.error("[create-market-dev-prior] revert data (unparsed)", data);
    console.error(parseErr);
  }
}

async function resolveAlphaWad(params: {
  navWad: bigint;
  drawdownWad: bigint;
  lambdaWad: bigint;
  kDrawdownWad: bigint;
  numBins: number;
  enforceAlpha: boolean;
  riskModuleAddress: string;
}): Promise<bigint> {
  if (CONFIG.market.liquidity.mode === "manual") {
    if (!CONFIG.market.liquidity.manualAlphaWad) {
      throw new Error("manualAlphaWad is required when liquidity.mode is manual");
    }
    return BigInt(CONFIG.market.liquidity.manualAlphaWad);
  }

  const riskModule = await hre.ethers.getContractAt("RiskModule", params.riskModuleAddress);
  const lnN = await riskModule.lnWad(params.numBins);
  if (lnN === 0n) {
    throw new Error("lnN returned zero; numBins too small?");
  }

  const alphaBase = (params.lambdaWad * params.navWad) / WAD;
  const alphaBaseDiv = (alphaBase * WAD) / lnN;
  let alphaLimit = alphaBaseDiv;
  if (params.enforceAlpha) {
    const kDD = (params.kDrawdownWad * params.drawdownWad) / WAD;
    const factor = kDD >= WAD ? 0n : WAD - kDD;
    alphaLimit = (alphaBaseDiv * factor) / WAD;
  }

  const safetyFactorWad = hre.ethers.parseUnits(CONFIG.market.liquidity.safetyFactor, WAD_DECIMALS);
  const alphaSafe = (alphaLimit * safetyFactorWad) / WAD;
  if (alphaSafe === 0n) {
    throw new Error("alphaWad computed as zero; adjust safetyFactor or risk config");
  }
  return alphaSafe;
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[create-market-dev-prior] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const feePolicyAddress = CONFIG.feePolicyAddress;
  if (!feePolicyAddress) {
    throw new Error("feePolicyAddress is required in CONFIG");
  }

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress);
  const owner = await core.owner();
  const paused = await core.paused();
  console.log(`[create-market-dev-prior] coreOwner=${owner} caller=${deployer.address} paused=${paused}`);

  const { minTick, maxTick, centerTick } = computeTickBounds(
    CONFIG.market.anchorPrice,
    CONFIG.market.tickSpacing,
    CONFIG.market.numBins
  );
  const numBins = computeNumBins(minTick, maxTick, CONFIG.market.tickSpacing);
  if (numBins !== CONFIG.market.numBins) {
    throw new Error(`numBins mismatch: expected=${CONFIG.market.numBins} actual=${numBins}`);
  }

  const baseFactors = generatePriorFactors({
    minTick,
    maxTick,
    tickSpacing: CONFIG.market.tickSpacing,
    anchorPrice: CONFIG.market.anchorPrice,
    atr: CONFIG.prior.atr,
    prior: CONFIG.prior,
  });
  if (baseFactors.length !== numBins) {
    throw new Error(`baseFactors length mismatch: expected ${numBins}, got ${baseFactors.length}`);
  }

  const minFactor = baseFactors.reduce((min, value) => (value < min ? value : min), baseFactors[0]);
  const maxFactor = baseFactors.reduce((max, value) => (value > max ? value : max), baseFactors[0]);
  console.log(
    `[create-market-dev-prior] ticks=[${minTick},${maxTick}) spacing=${CONFIG.market.tickSpacing} numBins=${numBins} anchor=${CONFIG.market.anchorPrice} center=${centerTick}`
  );
  console.log(
    `[create-market-dev-prior] priorFactors min=${minFactor.toString()} max=${maxFactor.toString()}`
  );

  const navWad = await core.getVaultNav();
  if (CONFIG.market.liquidity.mode === "auto" && navWad === 0n) {
    throw new Error("Vault NAV is zero; seed vault or use manual alpha");
  }
  const drawdownWad = await core.getVaultDrawdown();
  const [lambdaOnChain, kDrawdownOnChain, enforceAlpha] = await core.getRiskConfig();
  const riskModuleAddress = await core.riskModule();
  const alphaWad = await resolveAlphaWad({
    navWad,
    drawdownWad,
    lambdaWad: lambdaOnChain,
    kDrawdownWad: kDrawdownOnChain,
    numBins,
    enforceAlpha,
    riskModuleAddress,
  });

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
  const blockGasLimit = latestBlock?.gasLimit ?? 0n;
  const startTimestamp = now + CONFIG.market.startDelaySec;
  const endTimestamp = startTimestamp + CONFIG.market.durationSec;
  const settlementTimestamp = endTimestamp + CONFIG.market.settlementDelaySec;

  const packedFactors = hre.ethers.solidityPacked(
    Array(baseFactors.length).fill("uint256"),
    baseFactors
  );
  const seedData = await (await hre.ethers.getContractFactory("SeedData")).deploy(packedFactors);
  await seedData.waitForDeployment();
  const seedDataAddress = seedData.target;

  const beforeMarketId = await core.nextMarketId();
  let marketId = beforeMarketId + 1n;
  if (!CONFIG.skipStaticCall) {
    try {
      marketId = await core.createMarket.staticCall(
        minTick,
        maxTick,
        CONFIG.market.tickSpacing,
        startTimestamp,
        endTimestamp,
        settlementTimestamp,
        numBins,
        alphaWad,
        feePolicyAddress,
        seedDataAddress
      );
    } catch (err) {
      await decodeRevert(err);
      throw err;
    }
  }

  const txData = core.interface.encodeFunctionData("createMarket", [
    minTick,
    maxTick,
    CONFIG.market.tickSpacing,
    startTimestamp,
    endTimestamp,
    settlementTimestamp,
    numBins,
    alphaWad,
    feePolicyAddress,
    seedDataAddress,
  ]);
  console.log(`[create-market-dev-prior] txDataLen=${txData.length}`);
  const overrides = blockGasLimit > 0n ? { gasLimit: blockGasLimit - 100000n } : {};
  const tx = await deployer.sendTransaction({
    to: coreAddress,
    data: txData,
    ...overrides,
  });
  await tx.wait();

  console.log(`[create-market-dev-prior] marketId=${marketId.toString()}`);
  console.log(`[create-market-dev-prior] start=${startTimestamp} end=${endTimestamp} settlement=${settlementTimestamp}`);

  const seedChunkSize = Math.max(1, CONFIG.market.seedChunkSize);
  let remaining = numBins;
  while (remaining > 0) {
    const count = remaining > seedChunkSize ? seedChunkSize : remaining;
    console.log(`[create-market-dev-prior] seeding chunk count=${count} remaining=${remaining}`);
    const seedTx = await core.seedNextChunks(marketId, count);
    await seedTx.wait();
    remaining -= count;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
