import hre from "hardhat";
import fs from "fs";
import path from "path";

function resolveEnvName(): string {
  const raw = (process.env.ENV || process.env.TARGET_ENV || hre.network.name || "dev").trim();
  return raw === "hardhat" ? "local" : raw;
}

const envName = resolveEnvName();
const envPath = path.resolve(__dirname, `../environments/${envName}.json`);
const env = JSON.parse(fs.readFileSync(envPath, "utf8"));

async function main() {
  const core = await hre.ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const out = {
    network: hre.network.name,
    core: await core.getAddress(),
    tradeModule: await core.tradeModule(),
    lifecycleModule: await core.lifecycleModule(),
    riskModule: await core.riskModule(),
    vaultModule: await core.vaultModule(),
    oracleModule: await core.oracleModule(),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
