import hre from "hardhat";
import { loadEnvironment, normalizeEnvironment } from "../utils/environment";
import type { Environment } from "../types/environment";

const MARKET_ID_ENV = "MARKET_ID";
const POSITION_ID_ENV = "POSITION_ID";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function decodeRevert(err: unknown): Promise<{ name?: string; args?: unknown[] }> {
  const data =
    (err as { data?: string })?.data ??
    (err as { error?: { data?: string } })?.error?.data ??
    (err as { error?: { error?: { data?: string } } })?.error?.error?.data;
  if (!data) return {};

  try {
    const artifact = await hre.artifacts.readArtifact("IcicleOptionsErrors");
    const iface = new hre.ethers.Interface(artifact.abi);
    const parsed = iface.parseError(data);
    return { name: parsed?.name, args: parsed?.args ? Array.from(parsed.args) : [] };
  } catch {
    return {};
  }
}

async function main() {
  const { ethers, network } = hre;
  const env = normalizeEnvironment(network.name) as Environment;
  console.log(`[claim-payout] environment=${env} network=${network.name}`);

  const envData = loadEnvironment(env);
  const coreAddress = envData.contracts.IcicleOptionsCoreProxy;
  if (!coreAddress) throw new Error("Missing IcicleOptionsCoreProxy in environment file");

  const marketIdRaw = process.env[MARKET_ID_ENV];
  const positionIdRaw = process.env[POSITION_ID_ENV];
  if (!marketIdRaw || !positionIdRaw) {
    throw new Error(`Missing ${MARKET_ID_ENV} or ${POSITION_ID_ENV}`);
  }
  const marketId = BigInt(marketIdRaw);
  const positionId = BigInt(positionIdRaw);

  const [deployer] = await ethers.getSigners();
  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddress, deployer);

  const market = await core.markets(marketId);
  console.log(`[claim-payout] marketId=${marketId.toString()} settled=${market.settled}`);

  const windows = await core.getSettlementWindows.staticCall(marketId);
  const claimOpen = Number(windows[3]);
  const now = Math.floor(Date.now() / 1000);
  if (claimOpen > now) {
    const waitSec = claimOpen - now;
    console.log(`[claim-payout] waiting ${waitSec}s for claim window`);
    await sleep((waitSec + 1) * 1000);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tx = await core.claimPayout(positionId);
      await tx.wait();
      console.log(`[claim-payout] claimPayout tx=${tx.hash}`);
      return;
    } catch (err) {
      const decoded = await decodeRevert(err);
      if (decoded.name === "ClaimTooEarly" && decoded.args?.length) {
        const claimOpenTs = Number(decoded.args[0]);
        const nowRetry = Math.floor(Date.now() / 1000);
        const waitSec = Math.max(0, claimOpenTs - nowRetry);
        console.log(`[claim-payout] ClaimTooEarly; waiting ${waitSec}s`);
        await sleep((waitSec + 1) * 1000);
        continue;
      }
      console.error(`[claim-payout] failed reason=${decoded.name ?? "unknown"}`);
      throw err;
    }
  }

  throw new Error("claimPayout failed after retries");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
