// Fund the backstop up to its target (rhoBS * NAV) on live Fuji.
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const [d] = await ethers.getSigners();
  const WAD = 10n ** 18n;
  const fmt = (x: bigint, dd = 18) => Number(ethers.formatUnits(x, dd));

  const nav = await core.getVaultNav();              // 18-dec
  const cap = await core.getCapitalStack();
  const backstop = cap[0];                            // 18-dec
  let rho: bigint;
  try { rho = await (core as any).rhoBS(); } catch { rho = WAD / 5n; } // fallback 20%
  const target = (nav * rho) / WAD;                  // 18-dec
  const gap = target > backstop ? target - backstop : 0n;

  console.log(`NAV            : $${fmt(nav).toFixed(2)}`);
  console.log(`rhoBS          : ${fmt(rho) * 100}%`);
  console.log(`backstop target: $${fmt(target).toFixed(2)}`);
  console.log(`backstop now   : $${fmt(backstop).toFixed(2)}`);
  console.log(`gap to fund    : $${fmt(gap).toFixed(2)}`);
  if (gap === 0n) { console.log("already at/above target — nothing to do"); return; }

  // fundBackstop takes the payment-token amount (6-dec). Convert gap (18-dec) -> 6-dec, round up.
  const dec = Number(await token.decimals());
  const amt6 = (gap + 10n ** 12n - 1n) / 10n ** BigInt(18 - dec);
  await (await token.mint(d.address, amt6)).wait();
  await (await token.approve(await core.getAddress(), ethers.MaxUint256)).wait();
  await (await core.fundBackstop(amt6)).wait();
  console.log(`\nfunded $${fmt(amt6, dec).toFixed(2)} into backstop`);

  const cap2 = await core.getCapitalStack();
  console.log(`\n================ CAPITAL STACK ================`);
  console.log(`LP NAV   : $${fmt(await core.getVaultNav()).toFixed(2)}`);
  console.log(`Backstop : $${fmt(cap2[0]).toFixed(2)}  (target $${fmt(target).toFixed(2)})`);
  console.log(`Treasury : $${fmt(cap2[1]).toFixed(2)}`);
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
