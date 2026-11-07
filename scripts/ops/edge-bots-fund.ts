// Pre-fund the edge-bot wallets (gas + test USD + Core allowance) from the deployer, one tx at a
// time, so bots never race the deployer nonce when they start. Also tops up the keeper wallet.
//
//   WALLET_SETS=0,1,2 npx hardhat run scripts/ops/edge-bots-fund.ts --network fuji
//   BOT_MNEMONIC=... or BOT_WALLETS_FILE=<json with {"mnemonic"}>  (testnet throwaways only)
//   KEEPER_INDEX=99  (derivation index of the keeper wallet; set KEEPER_INDEX=-1 to skip)
import hre from "hardhat";
import * as fs from "fs";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const [deployer] = await ethers.getSigners();
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const mnemonic = process.env.BOT_MNEMONIC ?? JSON.parse(fs.readFileSync(process.env.BOT_WALLETS_FILE ?? "", "utf8")).mnemonic;
  const sets = (process.env.WALLET_SETS ?? "0").split(",").map(Number);
  const keeperIdx = Number(process.env.KEEPER_INDEX ?? 99);
  const names = ["noise", "atm", "lag", "sniper", "stacker", "tail"];
  const GAS_MIN = ethers.parseEther("0.5"), GAS_TOP = ethers.parseEther("1");
  const USD_MIN = 200_000_000_000n, USD_TOP = 2_000_000_000_000n; // 200k / 2M test USD (6 dec)
  console.log(`deployer ${deployer.address} AVAX ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);
  const targets: { label: string; idx: number; usd: boolean }[] = [];
  for (const set of sets) names.forEach((n, i) => targets.push({ label: `set${set}/${n}`, idx: set * 10 + i, usd: true }));
  if (keeperIdx >= 0) targets.push({ label: "keeper", idx: keeperIdx, usd: false });
  for (const t of targets) {
    const w = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${t.idx}`).connect(ethers.provider);
    let gas = await ethers.provider.getBalance(w.address);
    if (gas < GAS_MIN) { await (await deployer.sendTransaction({ to: w.address, value: GAS_TOP })).wait(); gas = await ethers.provider.getBalance(w.address); }
    let usd = 0n;
    if (t.usd) {
      usd = await token.balanceOf(w.address);
      if (usd < USD_MIN) { await (await token.mint(w.address, USD_TOP)).wait(); usd = await token.balanceOf(w.address); }
      if ((await token.allowance(w.address, coreAddr)) < USD_MIN) await (await token.connect(w).approve(coreAddr, ethers.MaxUint256)).wait();
    }
    console.log(`${t.label.padEnd(14)} ${w.address} AVAX ${Number(ethers.formatEther(gas)).toFixed(2)}${t.usd ? ` USD ${(Number(usd) / 1e6).toFixed(0)}` : ""}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
