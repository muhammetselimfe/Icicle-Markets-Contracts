export type Environment =
  | "local"
  | "dev"
  | "prod"
  | "fuji";

export interface DeploymentRecord {
  version: number;
  action: string;
  deployer: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface EnvironmentContracts {
  [name: string]: string;
}

export interface EnvironmentConfig {
  settlementSubmitWindow?: string;
  settlementFinalizeDeadline?: string;
  pendingOpsWindow?: string;
  redstoneFeedId?: string;
  redstoneFeedDecimals?: number;
  redstoneMaxSampleDistance?: string;
  redstoneFutureTolerance?: string;
  lpShareTokenName?: string;
  lpShareTokenSymbol?: string;
  paymentTokenVerifyContract?: string;
  operatorAllowlist?: string[];
  deployerEOA?: string;
  owners?: {
    core?: string;
    position?: string;
    lpShare?: string;
  };
}

export interface EnvironmentFile {
  network: Environment;
  version: number;
  contracts: EnvironmentContracts;
  config?: EnvironmentConfig;
  history: DeploymentRecord[];
}

export const ENV_PATHS: Record<Environment, string> = {
  "local": "scripts/environments/local.json",
  "dev": "scripts/environments/dev.json",
  "prod": "scripts/environments/prod.json",
  "fuji": "scripts/environments/fuji.json",
};
