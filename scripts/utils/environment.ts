import fs from "fs";
import path from "path";
import {
  Environment,
  EnvironmentFile,
  EnvironmentConfig,
  ENV_PATHS,
  DeploymentRecord,
  EnvironmentContracts,
} from "../types/environment";

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getEnvironmentPath(env: Environment): string {
  return ENV_PATHS[env];
}

export function loadEnvironment(env: Environment): EnvironmentFile {
  const envPath = getEnvironmentPath(env);
  if (!fs.existsSync(envPath)) {
    const initial: EnvironmentFile = {
      network: env,
      version: 1,
      contracts: {},
      config: {},
      history: [],
    };
    ensureDir(envPath);
    fs.writeFileSync(envPath, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(envPath, "utf8");
  const parsed = JSON.parse(raw) as EnvironmentFile;
  if (!parsed.config) parsed.config = {};
  // Migrate legacy SignalsUSDToken → PaymentToken
  if (parsed.contracts?.IcicleOptionsUSDToken && !parsed.contracts.PaymentToken) {
    parsed.contracts.PaymentToken = parsed.contracts.IcicleOptionsUSDToken;
  }
  if (parsed.contracts?.IcicleOptionsUSDToken) {
    delete parsed.contracts.IcicleOptionsUSDToken;
  }
  // Migrate legacy Signals* → IcicleOptions* contract keys
  const signalsKeyMap: Record<string, string> = {
    SignalsCoreProxy: "IcicleOptionsCoreProxy",
    SignalsPositionProxy: "IcicleOptionsPositionProxy",
    SignalsLPShareProxy: "IcicleOptionsLPShareProxy",
    SignalsCoreImplementation: "IcicleOptionsCoreImplementation",
    SignalsPositionImplementation: "IcicleOptionsPositionImplementation",
    SignalsLPShareImplementation: "IcicleOptionsLPShareImplementation",
    SignalsCreate2Factory: "IcicleOptionsCreate2Factory",
    SignalsDeployer: "IcicleOptionsDeployer",
    SignalsLPShare: "IcicleOptionsLPShare",
  };
  for (const [oldKey, newKey] of Object.entries(signalsKeyMap)) {
    if (parsed.contracts?.[oldKey]) {
      if (!parsed.contracts[newKey]) {
        parsed.contracts[newKey] = parsed.contracts[oldKey];
      }
      delete parsed.contracts[oldKey];
    }
  }
  if (parsed.config?.lpShareTokenName === "Signals LP") {
    parsed.config.lpShareTokenName = "Icicle Options LP";
  }
  if (parsed.config?.lpShareTokenSymbol === "SIGLP") {
    parsed.config.lpShareTokenSymbol = "ICOLP";
  }
  return parsed;
}

export function saveEnvironment(env: Environment, data: EnvironmentFile) {
  const envPath = getEnvironmentPath(env);
  ensureDir(envPath);
  fs.writeFileSync(envPath, JSON.stringify(data, null, 2));
}

export function updateContracts(env: Environment, contracts: EnvironmentContracts) {
  const data = loadEnvironment(env);
  const nextContracts = { ...data.contracts, ...contracts };
  // Migrate legacy SignalsUSDToken → PaymentToken
  if (nextContracts.IcicleOptionsUSDToken && !nextContracts.PaymentToken) {
    nextContracts.PaymentToken = nextContracts.IcicleOptionsUSDToken;
  }
  if (nextContracts.IcicleOptionsUSDToken) {
    delete nextContracts.IcicleOptionsUSDToken;
  }
  // Migrate legacy Signals* → IcicleOptions* contract keys
  const signalsKeyMap: Record<string, string> = {
    SignalsCoreProxy: "IcicleOptionsCoreProxy",
    SignalsPositionProxy: "IcicleOptionsPositionProxy",
    SignalsLPShareProxy: "IcicleOptionsLPShareProxy",
    SignalsCoreImplementation: "IcicleOptionsCoreImplementation",
    SignalsPositionImplementation: "IcicleOptionsPositionImplementation",
    SignalsLPShareImplementation: "IcicleOptionsLPShareImplementation",
    SignalsCreate2Factory: "IcicleOptionsCreate2Factory",
    SignalsDeployer: "IcicleOptionsDeployer",
    SignalsLPShare: "IcicleOptionsLPShare",
  };
  for (const [oldKey, newKey] of Object.entries(signalsKeyMap)) {
    if (nextContracts[oldKey]) {
      if (!nextContracts[newKey]) {
        nextContracts[newKey] = nextContracts[oldKey];
      }
      delete nextContracts[oldKey];
    }
  }
  data.contracts = nextContracts;
  saveEnvironment(env, data);
}

export function updateConfig(env: Environment, config: Partial<EnvironmentConfig>) {
  const data = loadEnvironment(env);
  const existing = data.config ?? {};
  const owners = {
    ...(existing.owners ?? {}),
    ...(config.owners ?? {}),
  };
  data.config = {
    ...existing,
    ...config,
    owners: Object.keys(owners).length ? owners : existing.owners,
  };
  saveEnvironment(env, data);
}

export function recordDeployment(
  env: Environment,
  record: Omit<DeploymentRecord, "version" | "timestamp">
): { data: EnvironmentFile; record: DeploymentRecord } {
  const data = loadEnvironment(env);
  const nextVersion = data.version + 1;
  const entry: DeploymentRecord = {
    ...record,
    version: nextVersion,
    timestamp: Math.floor(Date.now() / 1000),
  };
  data.version = nextVersion;
  data.history.push(entry);
  saveEnvironment(env, data);
  return { data, record: entry };
}

export function normalizeEnvironment(env: string): Environment {
  const trimmed = env.trim();
  const raw = trimmed.includes(":") ? trimmed.split(":")[1] ?? "" : trimmed;
  const normalized = raw === "localhost" || raw === "hardhat" ? "local" : raw;
  const allowed: Environment[] = ["local", "dev", "prod", "fuji"];
  if (!allowed.includes(normalized as Environment)) {
    throw new Error(
      `Unknown environment '${normalized}'. Allowed: ${allowed.join(", ")}`
    );
  }
  return normalized as Environment;
}
