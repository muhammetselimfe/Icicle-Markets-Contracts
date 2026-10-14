// Adversarial test: try to make the LP unprofitable on a live dynamic market.
// For each attack, compare premium paid vs fair value (qty * implied win-prob, measured
// as the marginal cost of 1 unit over the same range). LP is robust if premium >= fair
// value for every trade (you can't acquire payout liability cheaply).
//
// Run: MARKET_ID=58 npx hardhat run scripts/ops/adversarial-attack.ts --network fuji
import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const [att] = await ethers.getSigners();
  const id = BigInt(process.env.MARKET_ID ?? "58");

  const m = await core.markets(id);
  const minTick = Number(m.minTick), sp = Number(m.tickSpacing), oBin = Math.floor((Number(m.cachedOracleTick) - minTick) / sp);
  console.log(`market ${id}: alpha=${Number(m.liquidityParameter)/1e18} perBinCap=${Number(m.perBinCap)/1e6}u oracleBin=${oBin} ($${(Number(m.cachedOracleTick)/100).toFixed(2)})`);

  const dec = Number(await token.decimals());
  await (await token.mint(att.address, 10_000_000n * 10n ** BigInt(dec))).wait();
  await (await token.approve(await core.getAddress(), ethers.MaxUint256)).wait();

  const premBefore = Number(ethers.formatUnits((await core.markets(id)).accumulatedPremiums, 18));
  const tickAt = (b: number) => [minTick + b * sp, minTick + (b + 1) * sp] as const;

  // each attack: (label, loBin, hiBin, units)
  const attacks: [string, number, number, number][] = [
    ["saturate at-money (1 bin, huge qty)", oBin, oBin, 10000],
    ["wide cheap coverage (±12 bins)", oBin - 12, oBin + 12, 8000],
    ["deep tail snipe (far bin, huge qty)", oBin + 25, oBin + 25, 10000],
  ];

  let totalPrem = 0, totalLiability = 0, totalFair = 0;
  console.log("\nattack                                 premium    fairValue   payoutLiab   premium/fair  verdict");
  for (const [label, loB, hiB, units] of attacks) {
    const lo = minTick + Math.max(0, loB) * sp, hi = minTick + (Math.min(79, hiB) + 1) * sp;
    const q = BigInt(units) * 1_000_000n;
    // fair value = qty * implied win-prob over the range ~= marginal cost of 1 unit / 1
    let marginal: bigint;
    try { marginal = await core.calculateOpenCost.staticCall(id, lo, hi, 1_000_000n); } catch { console.log(`${label}: marginal quote failed`); continue; }
    const fairValue = Number(marginal) / 1e6 * units; // marginal($/unit) * units
    let cost: bigint;
    try { cost = await core.calculateOpenCost.staticCall(id, lo, hi, q); } catch (e: any) { console.log(`${label}: quote failed ${e.shortMessage||""}`); continue; }
    const premium = Number(cost) / 1e6;
    try { await (await core.connect(att).openPosition(id, lo, hi, q, cost * 2n + 5_000_000n, { gasLimit: 14_000_000 })).wait(); }
    catch (e: any) { console.log(`${label}: openPosition reverted ${e.shortMessage||e.message}`); continue; }
    const payoutLiab = units; // if range wins, LP pays `units`
    const ratio = fairValue > 0 ? premium / fairValue : Infinity;
    totalPrem += premium; totalLiability += payoutLiab; totalFair += fairValue;
    const verdict = ratio >= 0.99 ? "FAIR (LP ok)" : "CHEAP ⚠ (LP exposed)";
    console.log(`${label.padEnd(38)} ${premium.toFixed(4).padStart(9)} ${fairValue.toFixed(4).padStart(11)} ${String(payoutLiab).padStart(11)} ${ratio.toFixed(3).padStart(12)}  ${verdict}`);
  }

  const premAfter = Number(ethers.formatUnits((await core.markets(id)).accumulatedPremiums, 18));
  console.log(`\nLP premiums collected from my attacks: $${(premAfter - premBefore).toFixed(2)}`);
  console.log(`Total payout liability I acquired:     ${totalLiability} units ($${totalLiability} if those ranges win)`);
  console.log(`Total fair value of that liability:    $${totalFair.toFixed(2)}`);
  console.log(`\nVerdict: ${(premAfter - premBefore) >= totalFair * 0.98 ? "LP ROBUST — every position fairly priced; no free liability." : "LP EXPLOITED — acquired liability below fair value."}`);
  console.log("(Realized LP P&L is decided at settlement vs the live AVAX price; fair entries => LP ~breaks even + spread/fees.)");
}
main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
