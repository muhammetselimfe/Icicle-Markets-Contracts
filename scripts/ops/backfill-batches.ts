import hre from "hardhat";
import { Wallet, Interface } from "ethers";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

type CliOptions = {
  dryRun: boolean;
  execute: boolean;
  processOnly: boolean;
  targetBatchId: number;
  startOffsetSec: number;
  numBins: number;
  minTick: number;
  maxTick?: number;
  tickSpacing: number;
  alphaWad: string;
  feePolicy?: string;
  settlementValue: string;
};

const BATCH_SECONDS = 86_400;
const BATCH_TIMEZONE_OFFSET = 28_800; // PST (UTC-8)
const ONE_WAD = 10n ** 18n;

const parseArgs = (argv: string[]): CliOptions => {
  const has = (flag: string) => argv.includes(flag);
  const get = (flag: string) => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const env = (key: string) => process.env[key];

  return {
    dryRun: has("--dry-run") || env("DRY_RUN") === "1",
    execute: has("--execute") || env("EXECUTE") === "1",
    processOnly: has("--process-only") || env("PROCESS_ONLY") === "1",
    targetBatchId: Number(
      get("--target") ?? get("--target-batch") ?? env("TARGET_BATCH_ID") ?? "20482",
    ),
    startOffsetSec: Number(
      get("--start-offset-sec") ?? env("START_OFFSET_SEC") ?? "3600",
    ),
    numBins: Number(get("--num-bins") ?? env("NUM_BINS") ?? "1"),
    minTick: Number(get("--min-tick") ?? env("MIN_TICK") ?? "0"),
    maxTick: get("--max-tick") || env("MAX_TICK")
      ? Number(get("--max-tick") ?? env("MAX_TICK"))
      : undefined,
    tickSpacing: Number(
      get("--tick-spacing") ?? env("TICK_SPACING") ?? "1",
    ),
    alphaWad: get("--alpha-wad") ?? env("ALPHA_WAD") ?? ONE_WAD.toString(),
    feePolicy: get("--fee-policy") ?? env("FEE_POLICY"),
    settlementValue:
      get("--settlement-value") ?? env("SETTLEMENT_VALUE") ?? "0",
  };
};

const usage = () => {
  console.log(`Usage:
  hardhat run scripts/ops/backfill-batches.ts --network hardhat -- --dry-run --target 20482
  hardhat run scripts/ops/backfill-batches.ts --network prod -- --execute --target 20482

Options:
  --dry-run               Run on hardhat fork only (no mainnet writes)
  --execute               Send transactions on selected network
  --process-only          Skip create/settle and only process batches
  --target <batchId>      Target batchId to reach (default: 20482)
  --start-offset-sec <s>  startTimestamp = settlementTimestamp - s (default: 3600)
  --num-bins <n>          numBins (default: 1)
  --min-tick <n>          minTick (default: 0)
  --max-tick <n>          maxTick (default: minTick + tickSpacing * numBins)
  --tick-spacing <n>      tickSpacing (default: 1)
  --alpha-wad <n>         liquidityParameter in WAD (default: 1e18)
  --fee-policy <addr>     feePolicy address (default: FeePolicyNull/FeePolicy100bps from env)
  --settlement-value <n>  finalizeSecondary settlementValue (default: 0)

Env overrides:
  DRY_RUN=1 EXECUTE=1 TARGET_BATCH_ID=20482 START_OFFSET_SEC=3600
  NUM_BINS=1 MIN_TICK=0 MAX_TICK=1 TICK_SPACING=1 ALPHA_WAD=1e18 PROCESS_ONLY=1
  FEE_POLICY=0x... SETTLEMENT_VALUE=0
`);
};

const toBatchTimestamp = (batchId: number) =>
  batchId * BATCH_SECONDS + BATCH_TIMEZONE_OFFSET;

const extractErrorData = (err: unknown): string | null => {
  const candidate =
    (err as { data?: string })?.data ??
    (err as { error?: { data?: string } })?.error?.data ??
    (err as { error?: { error?: { data?: string } } })?.error?.error?.data ??
    (err as { info?: { error?: { data?: string } } })?.info?.error?.data ??
    (err as { info?: { error?: { error?: { data?: string } } } })?.info?.error
      ?.error?.data;
  return typeof candidate === "string" && candidate.startsWith("0x")
    ? candidate
    : null;
};

const decodeRevert = async (err: unknown) => {
  const data = extractErrorData(err);
  if (!data) return;
  try {
    const artifact = await hre.artifacts.readArtifact("IcicleOptionsErrors");
    const iface = new Interface(artifact.abi);
    const parsed = iface.parseError(data);
    if (parsed?.name) {
      console.error(`[revert] ${parsed.name}`);
      if (parsed.args?.length) {
        console.error(parsed.args.map((arg) => arg?.toString?.() ?? String(arg)));
      }
    }
  } catch {
    // noop
  }
};

async function main() {
  const { ethers, network } = hre;
  const options = parseArgs(process.argv.slice(2));

  if (!options.dryRun && !options.execute) {
    usage();
    throw new Error("Choose --dry-run or --execute");
  }

  if (
    options.dryRun &&
    network.name !== "hardhat" &&
    network.name !== "local"
  ) {
    throw new Error(
      "--dry-run requires --network hardhat or --network local (forked)",
    );
  }

  if (!Number.isFinite(options.targetBatchId)) {
    throw new Error("Invalid --target batchId");
  }

  const envOverride = process.env.BACKFILL_ENV ?? process.env.ENVIRONMENT;
  const resolvedEnv =
    (envOverride as Environment | undefined) ??
    (network.name === "hardhat"
      ? "prod"
      : (normalizeEnvironment(network.name) as Environment));
  const env = resolvedEnv;
  const envData = loadEnvironment(env);
  const coreAddress =
    process.env.CORE_ADDRESS ?? envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) {
    throw new Error("Missing IcicleOptionsCoreProxy address");
  }

  const feePolicy =
    options.feePolicy ??
    envData.contracts.FeePolicyNull ??
    envData.contracts.FeePolicy100bps;
  if (!feePolicy) {
    throw new Error("Missing feePolicy (use --fee-policy)");
  }

  const pk = process.env.OPERATOR_PRIVATE_KEY ?? process.env.DEPLOYER_KEY;
  const signer = pk
    ? new Wallet(pk, ethers.provider)
    : (await ethers.getSigners())[0];

  if (options.dryRun) {
    const addr = await signer.getAddress();
    const method =
      network.name === "hardhat" ? "hardhat_setBalance" : "anvil_setBalance";
    await hre.network.provider.send(method, [
      addr,
      "0x3635C9ADC5DEA00000", // 1000 ETH
    ]);
  }

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress, signer);
  const signerAddress = await signer.getAddress();

  const [
    paused,
    isVaultSeeded,
    currentBatchId,
    capitalStack,
    riskConfig,
    vaultNav,
    drawdown,
    settlementSubmitWindow,
    pendingOpsWindow,
    claimDelaySeconds,
    owner,
    isOperator,
  ] = await Promise.all([
    core.paused(),
    core.isVaultSeeded(),
    core.currentBatchId(),
    core.getCapitalStack(),
    core.getRiskConfig(),
    core.getVaultNav(),
    core.getVaultDrawdown(),
    core.settlementSubmitWindow(),
    core.pendingOpsWindow(),
    core.claimDelaySeconds(),
    core.owner(),
    core.operators(signerAddress),
  ]);

  console.log(
    JSON.stringify(
      {
        network: network.name,
        coreAddress,
        signer: signerAddress,
        owner,
        isOperator,
        paused,
        isVaultSeeded,
        currentBatchId: currentBatchId.toString(),
        capitalStack: {
          backstopNav: capitalStack[0].toString(),
          treasuryNav: capitalStack[1].toString(),
        },
        risk: {
          lambda: riskConfig[0].toString(),
          kDrawdown: riskConfig[1].toString(),
          enforceAlpha: riskConfig[2],
        },
        vault: {
          nav: vaultNav.toString(),
          drawdown: drawdown.toString(),
        },
        settlementWindows: {
          settlementSubmitWindow: settlementSubmitWindow.toString(),
          pendingOpsWindow: pendingOpsWindow.toString(),
          claimDelaySeconds: claimDelaySeconds.toString(),
        },
        feePolicy,
      },
      null,
      2,
    ),
  );

  if (paused) throw new Error("Core is paused");
  if (!isVaultSeeded) throw new Error("Vault is not seeded");
  const isOwner = signerAddress.toLowerCase() === owner.toLowerCase();
  if (!isOperator && !isOwner) {
    throw new Error("Signer is not owner/operator");
  }

  const startBatchId = Number(currentBatchId) + 1;
  const targetBatchId = options.targetBatchId;
  if (targetBatchId < startBatchId) {
    throw new Error(
      `Target batchId ${targetBatchId} is not ahead of current ${currentBatchId.toString()}`,
    );
  }

  const minTick = options.minTick;
  const tickSpacing = options.tickSpacing;
  const maxTick =
    options.maxTick ?? minTick + tickSpacing * options.numBins;
  const numBins = Math.floor((maxTick - minTick) / tickSpacing);

  if (tickSpacing <= 0) throw new Error("tickSpacing must be > 0");
  if (minTick >= maxTick) throw new Error("minTick must be < maxTick");
  if ((maxTick - minTick) % tickSpacing !== 0) {
    throw new Error("(maxTick - minTick) must be divisible by tickSpacing");
  }
  if (numBins !== options.numBins) {
    throw new Error(
      `numBins mismatch: expected=${options.numBins} computed=${numBins}`,
    );
  }
  if (options.startOffsetSec <= 0) {
    throw new Error("startOffsetSec must be > 0");
  }

  const alphaWad = BigInt(options.alphaWad);
  if (alphaWad <= 0n) throw new Error("alphaWad must be > 0");

  let seedDataAddress: string | null = null;
  if (!options.processOnly) {
    const factors = Array(numBins).fill(ONE_WAD);
    const packedFactors = ethers.solidityPacked(
      Array(numBins).fill("uint256"),
      factors,
    );

    const seedFactory = await ethers.getContractFactory("SeedData", signer);
    const seedData = await seedFactory.deploy(packedFactors);
    await seedData.waitForDeployment();
    seedDataAddress = await seedData.getAddress();

    const seedCode = await ethers.provider.getCode(seedDataAddress);
    const expectedCodeBytes = numBins * 32;
    const actualCodeBytes = (seedCode.length - 2) / 2;
    if (actualCodeBytes !== expectedCodeBytes) {
      throw new Error(
        `SeedData length mismatch: expected=${expectedCodeBytes} got=${actualCodeBytes}`,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        targetBatchId,
        startBatchId,
        numBins,
        minTick,
        maxTick,
        tickSpacing,
        alphaWad: alphaWad.toString(),
        seedData: seedDataAddress,
        settlementValue: options.settlementValue,
      },
      null,
      2,
    ),
  );

  let pendingOwnerActions = false;

  for (let batchId = startBatchId; batchId <= targetBatchId; batchId += 1) {
    const batchBig = BigInt(batchId);
    const [total, resolved] = await core.getBatchMarketState(batchBig);
    if (options.processOnly) {
      if (total === 0n) {
        throw new Error(`Batch ${batchId} has no markets to process`);
      }
      if (resolved !== total) {
        throw new Error(
          `Batch ${batchId} unresolved: ${resolved.toString()}/${total.toString()}`,
        );
      }

      try {
        await core.processDailyBatch.staticCall(batchBig);
      } catch (err) {
        await decodeRevert(err);
        throw err;
      }

      const batchTx = await core.processDailyBatch(batchBig);
      const batchReceipt = await batchTx.wait();
      console.log(
        `[batch ${batchId}] processDailyBatch tx=${batchTx.hash} gasUsed=${batchReceipt?.gasUsed?.toString() ?? "?"}`,
      );

      const updatedBatchId = await core.currentBatchId();
      console.log(
        `[batch ${batchId}] currentBatchId=${updatedBatchId.toString()}`,
      );
      continue;
    }

    if (total !== 0n) {
      throw new Error(
        `Batch ${batchId} already has markets: total=${total.toString()} resolved=${resolved.toString()}`,
      );
    }

    const settlementTimestamp = toBatchTimestamp(batchId);
    const endTimestamp = settlementTimestamp;
    const startTimestamp = settlementTimestamp - options.startOffsetSec;
    if (startTimestamp <= 0) {
      throw new Error(`startTimestamp underflow for batch ${batchId}`);
    }

    const latestBlock = await ethers.provider.getBlock("latest");
    const now = Number(latestBlock?.timestamp ?? 0);
    const opsStart = settlementTimestamp + Number(settlementSubmitWindow);
    if (now < opsStart) {
      throw new Error(
        `Too early to mark failed for batch ${batchId}: now=${now} opsStart=${opsStart}`,
      );
    }

    console.log(
      `[batch ${batchId}] createMarket start=${startTimestamp} end=${endTimestamp} settlement=${settlementTimestamp}`,
    );

    let predictedMarketId: bigint;
    try {
      predictedMarketId = await core.createMarket.staticCall(
        minTick,
        maxTick,
        tickSpacing,
        startTimestamp,
        endTimestamp,
        settlementTimestamp,
        numBins,
        alphaWad,
        feePolicy,
        seedDataAddress as string,
      );
    } catch (err) {
      await decodeRevert(err);
      throw err;
    }

    if (!options.execute && !options.dryRun) {
      throw new Error("Execution disabled");
    }

    const createTx = await core.createMarket(
      minTick,
      maxTick,
      tickSpacing,
      startTimestamp,
      endTimestamp,
      settlementTimestamp,
      numBins,
      alphaWad,
      feePolicy,
      seedDataAddress as string,
    );
    const createReceipt = await createTx.wait();
    console.log(
      `[batch ${batchId}] createMarket tx=${createTx.hash} gasUsed=${createReceipt?.gasUsed?.toString() ?? "?"}`,
    );

    const marketId = predictedMarketId;

    try {
      await core.markSettlementFailed.staticCall(marketId);
    } catch (err) {
      await decodeRevert(err);
      throw err;
    }

    const failTx = await core.markSettlementFailed(marketId);
    const failReceipt = await failTx.wait();
    console.log(
      `[batch ${batchId}] markFailed tx=${failTx.hash} gasUsed=${failReceipt?.gasUsed?.toString() ?? "?"}`,
    );

    const finalizeValue = BigInt(options.settlementValue);
    if (!isOwner && !options.dryRun) {
      const data = core.interface.encodeFunctionData(
        "finalizeSecondarySettlement",
        [marketId, finalizeValue],
      );
      console.log(
        `[batch ${batchId}] owner-required finalizeSecondary marketId=${marketId.toString()} data=${data}`,
      );
      console.log(
        `[batch ${batchId}] owner-required: execute finalizeSecondary via Safe, then re-run with PROCESS_ONLY=1`,
      );
      pendingOwnerActions = true;
      continue;
    }

    let finalizeCore = core;
    if (!isOwner && options.dryRun) {
      const method =
        network.name === "hardhat"
          ? "hardhat_impersonateAccount"
          : "anvil_impersonateAccount";
      await hre.network.provider.send(method, [owner]);
      const setBalanceMethod =
        network.name === "hardhat" ? "hardhat_setBalance" : "anvil_setBalance";
      await hre.network.provider.send(setBalanceMethod, [
        owner,
        "0x3635C9ADC5DEA00000",
      ]);
      const ownerSigner = await ethers.getSigner(owner);
      finalizeCore = core.connect(ownerSigner);
    }

    try {
      await finalizeCore.finalizeSecondarySettlement.staticCall(
        marketId,
        finalizeValue,
      );
    } catch (err) {
      await decodeRevert(err);
      throw err;
    }

    const finalizeTx = await finalizeCore.finalizeSecondarySettlement(
      marketId,
      finalizeValue,
    );
    const finalizeReceipt = await finalizeTx.wait();
    console.log(
      `[batch ${batchId}] finalizeSecondary tx=${finalizeTx.hash} gasUsed=${finalizeReceipt?.gasUsed?.toString() ?? "?"}`,
    );

    if (!isOwner && options.dryRun) {
      const stopMethod =
        network.name === "hardhat"
          ? "hardhat_stopImpersonatingAccount"
          : "anvil_stopImpersonatingAccount";
      await hre.network.provider.send(stopMethod, [owner]);
    }

    const [totalAfter, resolvedAfter] = await core.getBatchMarketState(batchBig);
    if (resolvedAfter !== totalAfter || totalAfter === 0n) {
      throw new Error(
        `Batch ${batchId} unresolved: ${resolvedAfter.toString()}/${totalAfter.toString()}`,
      );
    }

    try {
      await core.processDailyBatch.staticCall(batchBig);
    } catch (err) {
      await decodeRevert(err);
      throw err;
    }

    const batchTx = await core.processDailyBatch(batchBig);
    const batchReceipt = await batchTx.wait();
    console.log(
      `[batch ${batchId}] processDailyBatch tx=${batchTx.hash} gasUsed=${batchReceipt?.gasUsed?.toString() ?? "?"}`,
    );

    const updatedBatchId = await core.currentBatchId();
    console.log(
      `[batch ${batchId}] currentBatchId=${updatedBatchId.toString()}`,
    );
  }

  const finalBatchId = await core.currentBatchId();
  console.log(`[done] currentBatchId=${finalBatchId.toString()}`);
  if (pendingOwnerActions) {
    console.log(
      `[done] pending owner actions detected; skipping final batchId assertion`,
    );
    return;
  }
  if (finalBatchId !== BigInt(targetBatchId)) {
    throw new Error(
      `Mismatch: expected ${targetBatchId} got ${finalBatchId.toString()}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
