import hre from "hardhat";
import { normalizeEnvironment } from "./utils/environment";
import type { Environment } from "./types/environment";

const MANIFEST_DIRS: Partial<Record<Environment, string>> = {
  "dev": ".openzeppelin/dev",
  "prod": ".openzeppelin/prod",
  "fuji": ".openzeppelin/fuji",
};

function usage() {
  console.error("Usage: COMMAND=<action:env> hardhat run scripts/dispatcher.ts --network <network>");
  console.error(
    "Actions: deploy, deploy-impls, upgrade, update-modules, deploy-fee-policies, predict-create2, seed-vault, fund-backstop, post-fund-check, safety-check, verify. Envs: local, dev, prod, fuji"
  );
  process.exit(1);
}

function enforceNetworkMatch(env: Environment) {
  const networkName = hre.network.name;
  if (env !== networkName) {
    throw new Error(`Network mismatch: COMMAND env=${env} --network=${networkName}`);
  }
}

function enforceManifestDir(env: Environment) {
  const expected = MANIFEST_DIRS[env];
  if (!expected) return;
  const current = process.env.MANIFEST_DEFAULT_DIR;
  if (!current) {
    process.env.MANIFEST_DEFAULT_DIR = expected;
    console.log(`[dispatcher] MANIFEST_DEFAULT_DIR=${expected}`);
    return;
  }
  if (current !== expected) {
    throw new Error(`MANIFEST_DEFAULT_DIR=${current} does not match expected ${expected} for ${env}`);
  }
}

async function main() {
  const command = process.env.COMMAND;
  if (!command) {
    usage();
    return;
  }
  const [action, ...envParts] = command.split(":");
  const env = normalizeEnvironment(envParts.join(":") || "local") as Environment;
  enforceNetworkMatch(env);
  enforceManifestDir(env);

  switch (action) {
    case "deploy": {
      const { deployAction } = await import("./actions/deploy-v1");
      await deployAction(env);
      break;
    }
    case "deploy-impls": {
      const { deployImplsAction } = await import("./actions/deploy-impls");
      await deployImplsAction(env);
      break;
    }
    case "upgrade": {
      const { upgradeAction } = await import("./actions/upgrade-v1");
      await upgradeAction(env);
      break;
    }
    case "update-modules": {
      const { updateModulesAction } = await import("./actions/update-modules-v1");
      await updateModulesAction(env);
      break;
    }
    case "deploy-fee-policies": {
      const { deployFeePoliciesAction } = await import("./actions/deploy-fee-policies");
      await deployFeePoliciesAction(env);
      break;
    }
    case "predict-create2": {
      const { predictCreate2Action } = await import("./actions/predict-create2");
      await predictCreate2Action(env);
      break;
    }
    case "seed-vault": {
      const { seedVaultAction } = await import("./actions/seed-vault");
      await seedVaultAction(env);
      break;
    }
    case "fund-backstop": {
      const { fundBackstopAction } = await import("./actions/fund-backstop");
      await fundBackstopAction(env);
      break;
    }
    case "post-fund-check": {
      const { postFundCheckAction } = await import("./actions/post-fund-check");
      await postFundCheckAction(env);
      break;
    }
    case "safety-check": {
      const { safetyCheckAction } = await import("./actions/safety-check");
      await safetyCheckAction(env);
      break;
    }
    case "verify": {
      const { verifyAction } = await import("./actions/verify-v1");
      await verifyAction(env);
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
