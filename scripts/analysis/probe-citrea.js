// T1 probe: confirm the live Signals contract on Citrea mainnet responds.
// Read-only. No signer. Run: node scripts/analysis/probe-citrea.js
const { ethers } = require("ethers");

const RPC = process.env.PROD_RPC_URL || "https://rpc.mainnet.citrea.xyz";
const CORE = "0x516312275875932ec2B53A41df4De02743131729"; // IcicleOptionsCoreProxy == live Signals

// Minimal, brand-neutral ABI (selectors are name-based; these names are generic).
const ABI = [
  "function nextMarketId() view returns (uint256)",
  "function getVaultNav() view returns (uint256)",
  "function getVaultShares() view returns (uint256)",
  "function getVaultPrice() view returns (uint256)",
  "function getVaultPricePeak() view returns (uint256)",
  "function getVaultDrawdown() view returns (uint256)",
  "function getCurrentBatchId() view returns (uint64)",
  "function getCapitalStack() view returns (uint256 backstopNav, uint256 treasuryNav)",
];

const wad = (x) => Number(ethers.formatUnits(x, 18));

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const net = await provider.getNetwork();
  const block = await provider.getBlockNumber();
  console.log(`chain ${net.chainId}  block ${block}  rpc ${RPC}`);

  const c = new ethers.Contract(CORE, ABI, provider);
  const tryCall = async (label, fn, fmt = (v) => v) => {
    try {
      const v = await fn();
      console.log(`  ${label.padEnd(18)} ${fmt(v)}`);
      return v;
    } catch (e) {
      console.log(`  ${label.padEnd(18)} ERR ${String(e.shortMessage || e.message).slice(0, 80)}`);
      return undefined;
    }
  };

  console.log("--- contract state ---");
  await tryCall("nextMarketId", () => c.nextMarketId(), (v) => v.toString());
  await tryCall("vault NAV", () => c.getVaultNav(), (v) => `${wad(v).toFixed(4)} (wad)`);
  await tryCall("vault shares", () => c.getVaultShares(), (v) => `${wad(v).toFixed(4)}`);
  await tryCall("vault price", () => c.getVaultPrice(), (v) => `${wad(v).toFixed(6)}`);
  await tryCall("vault pricePeak", () => c.getVaultPricePeak(), (v) => `${wad(v).toFixed(6)}`);
  await tryCall("vault drawdown", () => c.getVaultDrawdown(), (v) => `${(wad(v) * 100).toFixed(2)}%`);
  await tryCall("currentBatchId", () => c.getCurrentBatchId(), (v) => v.toString());
  await tryCall("capitalStack", () => c.getCapitalStack(), (v) => `backstop=${wad(v[0]).toFixed(4)} treasury=${wad(v[1]).toFixed(4)}`);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
