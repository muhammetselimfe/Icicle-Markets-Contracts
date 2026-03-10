import fs from "fs";
import path from "path";
import hre from "hardhat";
import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

const OUTPUT_PREFIX = "safe-fee-waterfall";
const WAD = 10n ** 18n;

function parseWad(value: string | undefined, label: string): bigint {
  if (!value) {
    throw new Error(`Missing ${label}`);
  }
  return hre.ethers.parseUnits(value, 18);
}

function outputPath(env: Environment) {
  const suffix = process.env.ENV_OUTPUT_SUFFIX?.trim();
  const filename = suffix ? `${env}.${OUTPUT_PREFIX}.${suffix}.json` : `${env}.${OUTPUT_PREFIX}.json`;
  return path.join("scripts", "environments", filename);
}

function buildTransactionBuilderJson(params: {
  chainId: string;
  safeAddress: string;
  coreAddress: string;
  data: string;
  inputs: Record<string, string>;
}) {
  return {
    version: "1.0",
    chainId: params.chainId,
    createdAt: Date.now(),
    meta: {
      name: "IcicleOptions.setFeeWaterfallConfig",
      description: "Set fee waterfall config on IcicleOptionsCore",
      txBuilderVersion: "1.16.1",
      createdFromSafeAddress: params.safeAddress,
    },
    transactions: [
      {
        to: params.coreAddress,
        value: "0",
        data: params.data,
        contractMethod: {
          name: "setFeeWaterfallConfig",
          payable: false,
          inputs: [
            { internalType: "uint256", name: "rhoBS", type: "uint256" },
            { internalType: "uint256", name: "phiLP", type: "uint256" },
            { internalType: "uint256", name: "phiBS", type: "uint256" },
            { internalType: "uint256", name: "phiTR", type: "uint256" },
          ],
        },
        contractInputsValues: params.inputs,
      },
    ],
  };
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[safe-propose] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = process.env.CORE_ADDRESS ?? envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) {
    throw new Error("Missing CORE_ADDRESS (or IcicleOptionsCoreProxy in environment file)");
  }

  const safeAddress = process.env.SAFE_ADDRESS ?? envData.config?.owners?.core;
  if (!safeAddress) {
    throw new Error("Missing SAFE_ADDRESS (or owners.core in environment file)");
  }

  const rhoBS = parseWad(process.env.FEE_RHO_BS, "FEE_RHO_BS");
  const phiLP = parseWad(process.env.FEE_PHI_LP, "FEE_PHI_LP");
  const phiBS = parseWad(process.env.FEE_PHI_BS, "FEE_PHI_BS");
  const phiTR = parseWad(process.env.FEE_PHI_TR, "FEE_PHI_TR");
  const phiSum = phiLP + phiBS + phiTR;
  if (phiSum !== WAD) {
    throw new Error(`phiLP+phiBS+phiTR must equal 1e18 (got ${phiSum.toString()})`);
  }

  const iface = new ethers.Interface([
    "function setFeeWaterfallConfig(uint256 rhoBS,uint256 phiLP,uint256 phiBS,uint256 phiTR)",
  ]);
  const data = iface.encodeFunctionData("setFeeWaterfallConfig", [rhoBS, phiLP, phiBS, phiTR]);

  const chain = await ethers.provider.getNetwork();
  const chainId = chain.chainId;

  const builderJson = buildTransactionBuilderJson({
    chainId: chainId.toString(),
    safeAddress,
    coreAddress,
    data,
    inputs: {
      rhoBS: rhoBS.toString(),
      phiLP: phiLP.toString(),
      phiBS: phiBS.toString(),
      phiTR: phiTR.toString(),
    },
  });

  const outPath = outputPath(env);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let safeTxHash: string | null = null;
  const txServiceUrl = process.env.SAFE_TX_SERVICE_URL?.trim();
  const apiKey = process.env.SAFE_API_KEY?.trim();
  const proposerKey =
    process.env.SAFE_PROPOSER_KEY?.trim() ||
    process.env.DEPLOYER_KEY?.trim() ||
    "";
  const rpcUrl = process.env.SAFE_RPC_URL?.trim() ?? (network.config as { url?: string }).url;
  const gatewayUrl = process.env.SAFE_GATEWAY_URL?.trim();
  const gatewayApiKey = process.env.SAFE_GATEWAY_API_KEY?.trim();

  let proposalError: string | null = null;
  let proposalTarget: "gateway" | "tx-service" | null = null;
  const shouldPropose = Boolean(apiKey || txServiceUrl || gatewayUrl);
  if (shouldPropose) {
    try {
      if (!proposerKey) {
        throw new Error("SAFE_PROPOSER_KEY or DEPLOYER_KEY is required to propose a Safe transaction");
      }
      if (!rpcUrl) {
        throw new Error("SAFE_RPC_URL (or network url) is required when proposing to the Safe service");
      }

      const proposer = new ethers.Wallet(proposerKey);
      const protocolKit = await Safe.init({
        provider: rpcUrl,
        signer: proposerKey,
        safeAddress,
      });
      const isOwner = await protocolKit.isOwner(proposer.address);
      if (!isOwner) {
        throw new Error(`SAFE_PROPOSER_KEY is not a Safe owner (${proposer.address})`);
      }

      const safeTx = await protocolKit.createTransaction({
        transactions: [{ to: coreAddress, data, value: "0" }],
      });
      safeTxHash = await protocolKit.getTransactionHash(safeTx);
      const signature = await protocolKit.signHash(safeTxHash);

      if (gatewayUrl) {
        proposalTarget = "gateway";
        const base = gatewayUrl.replace(/\/+$/, "");
        const url = `${base}/v1/chains/${chainId.toString()}/transactions/${safeAddress}/propose`;
        const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
        if (!fetchFn) {
          throw new Error("global fetch is not available; use SAFE_TX_SERVICE_URL instead");
        }
        const txData = safeTx.data;
        const body = {
          to: txData.to,
          value: txData.value?.toString() ?? "0",
          data: txData.data ?? "0x",
          operation: txData.operation ?? 0,
          safeTxGas: txData.safeTxGas?.toString() ?? "0",
          baseGas: txData.baseGas?.toString() ?? "0",
          gasPrice: txData.gasPrice?.toString() ?? "0",
          gasToken: txData.gasToken ?? ethers.ZeroAddress,
          refundReceiver: txData.refundReceiver ?? ethers.ZeroAddress,
          nonce: txData.nonce?.toString() ?? "0",
          safeTxHash,
          sender: proposer.address,
          signature: signature.data,
          origin: "icicle-options-v1",
        };
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": "icicle-options-safe-client/1.0",
        };
        if (gatewayApiKey) {
          headers.authorization = `Bearer ${gatewayApiKey}`;
        }
        const res = await fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`Gateway propose failed (${res.status}): ${text.slice(0, 200)}`);
        }
        console.log(`[safe-propose] proposed via gateway txHash=${safeTxHash}`);
      } else {
        proposalTarget = "tx-service";
        const apiKit = new SafeApiKit({
          chainId,
          txServiceUrl,
          apiKey,
        });
        await apiKit.proposeTransaction({
          safeAddress,
          safeTransactionData: safeTx.data,
          safeTxHash,
          senderAddress: proposer.address,
          senderSignature: signature.data,
          origin: "icicle-options-v1",
        });
        console.log(`[safe-propose] proposed via tx-service txHash=${safeTxHash}`);
      }
    } catch (err) {
      proposalError = (err as Error).message ?? String(err);
      console.warn(`[safe-propose] propose failed: ${proposalError}`);
    }
  } else {
    console.log("[safe-propose] SAFE_API_KEY/SAFE_TX_SERVICE_URL/SAFE_GATEWAY_URL not set; wrote Transaction Builder JSON only");
  }

  const output = {
    chainId: chainId.toString(),
    safeAddress,
    coreAddress,
    calldata: data,
    feeWaterfall: {
      rhoBS: rhoBS.toString(),
      phiLP: phiLP.toString(),
      phiBS: phiBS.toString(),
      phiTR: phiTR.toString(),
    },
    safeTxHash,
    proposalTarget,
    proposalError,
    txServiceUrl: txServiceUrl ?? null,
    apiKeyUsed: Boolean(apiKey),
    gatewayUrl: gatewayUrl ?? null,
    transactionBuilder: builderJson,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[safe-propose] output written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
