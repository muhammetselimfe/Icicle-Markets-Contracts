import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-gas-reporter";

dotenv.config();

const hardhatForkUrl = process.env.HARDHAT_FORK_URL;
const hardhatForkBlock = process.env.HARDHAT_FORK_BLOCK
  ? Number.parseInt(process.env.HARDHAT_FORK_BLOCK, 10)
  : undefined;
const hardhatForkHardfork = process.env.HARDHAT_FORK_HARDFORK || "shanghai";
const hardhatForkChainId = process.env.HARDHAT_FORK_CHAIN_ID
  ? Number.parseInt(process.env.HARDHAT_FORK_CHAIN_ID, 10)
  : 4114;
const hardhatForkChains = hardhatForkUrl
  ? {
      [hardhatForkChainId]: {
        hardforkHistory: {
          [hardhatForkHardfork]: 0,
        },
      },
    }
  : undefined;

const defaultAccounts = process.env.DEPLOYER_KEY
  ? [process.env.DEPLOYER_KEY]
  : [];
const hardhatAccountCount = Number.parseInt(
  process.env.HARDHAT_ACCOUNTS || "30",
  10
);
const defaultDevRpc = "https://rpc.testnet.citrea.xyz";
const devRpc = process.env.DEV_RPC_URL || defaultDevRpc;
const prodRpc = process.env.PROD_RPC_URL || "https://rpc.mainnet.citrea.xyz";
const fujiRpc = process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "1" || process.env.REPORT_GAS === "true",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
  },
  networks: {
    hardhat: {
      // test-only: IcicleOptionsCoreHarness (Core + test hooks) is ~24.9 KB after v2.1; production Core is ~17.9 KB
      allowUnlimitedContractSize: true,
      chainId: 31337,
      accounts: {
        count: Number.isFinite(hardhatAccountCount)
          ? hardhatAccountCount
          : 30,
      },
      forking: hardhatForkUrl
        ? {
            url: hardhatForkUrl,
            blockNumber: Number.isFinite(hardhatForkBlock)
              ? hardhatForkBlock
              : undefined,
          }
        : undefined,
      hardfork: hardhatForkHardfork,
      chains: hardhatForkChains,
    },
    local: {
      chainId: 31337,
      url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
    },
    dev: {
      url: devRpc,
      chainId: 5115,
      accounts: defaultAccounts,
    },
    prod: {
      url: prodRpc,
      chainId: 4114,
      accounts: defaultAccounts,
    },
    fuji: {
      url: fujiRpc,
      chainId: 43113,
      accounts: defaultAccounts,
      // FUJI_GAS=<units> switches off automatic gas estimation (which queries the
      // "pending" block and is rejected by several public Fuji RPCs); unset = auto.
      gas: process.env.FUJI_GAS ? Number(process.env.FUJI_GAS) : "auto",
    },
  },
  etherscan: {
    apiKey: {
      "dev": process.env.BLOCKSCOUT_API_KEY || "placeholder",
      "prod": process.env.BLOCKSCOUT_API_KEY || "placeholder",
      "fuji": process.env.SNOWSCAN_API_KEY || "placeholder",
    },
    customChains: [
      {
        network: "dev",
        chainId: 5115,
        urls: {
          apiURL: "https://explorer.testnet.citrea.xyz/api",
          browserURL: "https://explorer.testnet.citrea.xyz",
        },
      },
      {
        network: "prod",
        chainId: 4114,
        urls: {
          apiURL: "https://explorer.mainnet.citrea.xyz/api",
          browserURL: "https://explorer.mainnet.citrea.xyz",
        },
      },
      {
        network: "fuji",
        chainId: 43113,
        urls: {
          apiURL: "https://api-testnet.snowscan.xyz/api",
          browserURL: "https://testnet.snowscan.xyz",
        },
      },
    ],
  },
  mocha: {
    timeout: process.env.COVERAGE ? 0 : 20000,
  },
};

export default config;
