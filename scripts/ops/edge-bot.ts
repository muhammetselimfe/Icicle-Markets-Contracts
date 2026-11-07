// Edge bot: one wallet per trader "edge" strategy on a Fuji dynamic market, so trader P&L is
// attributable per strategy. Runs until trading closes. Every order carries a signed Redstone
// payload (v2.1 F3a) unless ATTACH_PAYLOAD=0, so trades price against the live price.
//
//   MARKET_ID=22 npx hardhat run scripts/ops/edge-bot.ts --network fuji
//
// Env (defaults in brackets):
//   STRATS=noise,atm,lag,sniper,stacker,tail   LOOP_SEC=10
//   NOISE_SEC=300 ATM_SEC=900 TAIL_SEC=1800 SNIPE_SEC=120   (cadences; use ~90/150/240 on 15-min markets)
//   WALLET_SET=0        derivation offset: wallets m/44'/60'/0'/0/(WALLET_SET*10 + i); give each
//                       concurrently-traded market its own set so bots never share a nonce
//   BOT_MNEMONIC=...    or BOT_WALLETS_FILE=<json with {"mnemonic"}>  (testnet throwaways only)
//   ATTACH_PAYLOAD=1    REDSTONE_GATEWAY_URL + REDSTONE_API_KEY -> authenticatedGateways (SDK >= 1.0)
//   LOG_DIR=scripts/analysis/out/edge-bots   (JSONL trade log per market: trades-<id>.jsonl)
//
// Strategies (all sizes in payout units; 1 unit = $1 if the bin wins):
//   noise    every NOISE_SEC: random bin within ±3 of the live bin, 2–20u, 50 % two-bin ranges
//   atm      every ATM_SEC: the live bin, 20u
//   tail     every TAIL_SEC: a bin 12–26 away, 50u
//   sniper   once, SNIPE_SEC before close: the live bin, 100u
//   stacker  at open: five cap-aware orders on the ATM band (the "whale pins ATM" flow)
//   lag      whenever the live bin != the contract's cached bin: buy the live bin WITHOUT a payload
//            (prices against the stale centre), refresh the oracle, then sell back — the lag arb
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getSignersForDataServiceId, requestDataPackages, requestRedstonePayload } from "@redstone-finance/sdk";
import { loadEnvironment } from "../utils/environment";

const DS = "redstone-primary-prod";
const E = (k: string, d: number) => Number(process.env[k] ?? d);
const STRATS = (process.env.STRATS ?? "noise,atm,lag,sniper,stacker,tail").split(",").map((s) => s.trim());
const ATTACH = process.env.ATTACH_PAYLOAD !== "0";
const WALLET_SET = E("WALLET_SET", 0);
const GATEWAY = process.env.REDSTONE_GATEWAY_URL && process.env.REDSTONE_API_KEY
  ? [{ url: process.env.REDSTONE_GATEWAY_URL, apiKey: process.env.REDSTONE_API_KEY }]
  : undefined;

function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(rng: () => number) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const coreAddr = env.contracts.IcicleOptionsCoreProxy;
  const feed: string = (env.config as any).redstoneFeedId ?? "AVAX";
  const marketId = BigInt(process.env.MARKET_ID ?? "0");
  if (marketId === 0n) throw new Error("set MARKET_ID");
  const LOOP = E("LOOP_SEC", 10), NOISE_SEC = E("NOISE_SEC", 300), ATM_SEC = E("ATM_SEC", 900), TAIL_SEC = E("TAIL_SEC", 1800), SNIPE_SEC = E("SNIPE_SEC", 120);
  const logDir = process.env.LOG_DIR ?? path.join(__dirname, "../analysis/out/edge-bots");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `trades-${marketId}.jsonl`);
  const log = (o: Record<string, unknown>) => fs.appendFileSync(logFile, JSON.stringify({ t: Math.floor(Date.now() / 1000), marketId: Number(marketId), ...o }) + "\n");

  const core = await ethers.getContractAt("IcicleOptionsCore", coreAddr);
  const token = await ethers.getContractAt("IcicleOptionsUSDToken", env.contracts.PaymentToken);
  const position = await ethers.getContractAt("IcicleOptionsPosition", env.contracts.IcicleOptionsPositionProxy);
  const mnemonic = process.env.BOT_MNEMONIC ?? JSON.parse(fs.readFileSync(process.env.BOT_WALLETS_FILE ?? "", "utf8")).mnemonic;
  const ALL = ["noise", "atm", "lag", "sniper", "stacker", "tail"];
  const wallets: Record<string, any> = {};
  ALL.forEach((s, i) => { wallets[s] = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${WALLET_SET * 10 + i}`).connect(ethers.provider); });

  const m = await core.markets(marketId);
  const minTick = BigInt(m.minTick), spacing = BigInt(m.tickSpacing), nb = Number(m.numBins), cap = BigInt(m.perBinCap);
  const start = Number(m.startTimestamp), end = Number(m.endTimestamp);
  const binOf = (tick: bigint) => Number((tick - minTick) / spacing);
  const ticks = (lo: number, hi: number) => [minTick + BigInt(lo) * spacing, minTick + BigInt(hi + 1) * spacing] as const;
  const auth = (getSignersForDataServiceId as any)(DS);
  const livePrice = async (): Promise<number> => {
    const r: any = await withTimeout(requestDataPackages({ dataServiceId: DS, dataPackagesIds: [feed], uniqueSignersCount: 1, authorizedSigners: auth, ...(GATEWAY ? { authenticatedGateways: GATEWAY } : {}) } as any) as any, 20_000, "live price");
    return Number(r[feed][0].dataPackage.dataPoints[0].toObj().value);
  };
  const liveBin = (price: number) => { let t = BigInt(Math.floor(price * 100)); const last = BigInt(m.maxTick) - spacing; if (t < minTick) t = minTick; if (t > last) t = last; return binOf(minTick + ((t - minTick) / spacing) * spacing); };
  const payloadHex = async (): Promise<string> => {
    const p: string = await withTimeout(requestRedstonePayload({ dataServiceId: DS, dataPackagesIds: [feed], uniqueSignersCount: 3, authorizedSigners: auth, ...(GATEWAY ? { authenticatedGateways: GATEWAY } : {}) } as any) as any, 20_000, "payload");
    return p.replace(/^0x/, "");
  };
  // send a Core call from a bot wallet, optionally with the signed price appended (Core refreshes the oracle first)
  const send = async (w: any, fn: string, args: any[], attach: boolean) => {
    const data = core.interface.encodeFunctionData(fn as any, args as any) + (attach ? await payloadHex() : "");
    const tx = await w.sendTransaction({ to: coreAddr, data, gasLimit: 12_000_000 });
    return withTimeout(tx.wait(), 90_000, `${fn} receipt`);
  };
  const usedUnits = async (lo: number, hi: number): Promise<bigint> => {
    // open payout units already in the heaviest bin of [lo, hi] (the per-bin cap counts units)
    const ids: bigint[] = await position.getMarketPositions(marketId); const used = new Map<number, bigint>();
    for (const pid of ids) { try { const p = await position.getPosition(pid); if (p.quantity === 0n) continue; for (let t = BigInt(p.lowerTick); t < BigInt(p.upperTick); t += spacing) { const b = binOf(t); used.set(b, (used.get(b) ?? 0n) + BigInt(p.quantity)); } } catch { /* burned */ } }
    let max = 0n; for (let b = lo; b <= hi; b++) { const u = used.get(b) ?? 0n; if (u > max) max = u; } return max;
  };
  const buy = async (strat: string, lo: number, hi: number, units: number, attach = ATTACH): Promise<bigint | null> => {
    const w = wallets[strat]; const [tl, th] = ticks(lo, hi); let qty = BigInt(units) * 1_000_000n;
    if (cap > 0n) { const room = cap - (await usedUnits(lo, hi)); if (room <= 0n) { log({ strat, action: "buy-skip", lo, hi, units, err: "bin full" }); return null; } if (qty > room) qty = room; }
    try {
      const quote: bigint = await core.calculateOpenCost.staticCall(marketId, tl, th, qty);
      const maxCost = quote + quote / 10n + 1_000_000n; // 10 % + $1 slippage room: the attached price may move the centre
      const b0 = await token.balanceOf(w.address);
      const rc: any = await send(w, "openPosition", [marketId, tl, th, qty, maxCost], attach);
      const cost = Number(b0 - (await token.balanceOf(w.address))) / 1e6;
      const ev = rc.logs.map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } }).find((p: any) => p?.name === "PositionOpened");
      const pid = ev ? BigInt(ev.args[0]) : null;
      log({ strat, action: "buy", lo, hi, units: Number(qty) / 1e6, cost, perUnit: cost / (Number(qty) / 1e6), pid: pid === null ? null : Number(pid), attached: attach });
      return pid;
    } catch (e: any) { log({ strat, action: "buy-fail", lo, hi, units, err: String(e.shortMessage || e.message).slice(0, 120) }); return null; }
  };
  const close = async (strat: string, pid: bigint) => {
    const w = wallets[strat];
    try { const b0 = await token.balanceOf(w.address); await send(w, "closePosition", [pid, 0n], false); const got = Number((await token.balanceOf(w.address)) - b0) / 1e6; log({ strat, action: "close", pid: Number(pid), proceeds: got }); }
    catch (e: any) { log({ strat, action: "close-fail", pid: Number(pid), err: String(e.shortMessage || e.message).slice(0, 120) }); }
  };
  const refresh = async (strat: string) => {
    try { await send(wallets[strat], "refreshTradeOracle", [marketId], true); log({ strat, action: "refreshed" }); }
    catch (e: any) { log({ strat, action: "refresh-fail", err: String(e.shortMessage || e.message).slice(0, 120) }); }
  };

  log({ action: "start", strats: STRATS, walletSet: WALLET_SET, minTick: Number(minTick), nb, start, end, cap: Number(cap) / 1e6, attach: ATTACH, bots: Object.fromEntries(ALL.map((s) => [s, wallets[s].address])) });
  const rng = mulberry32(Number(marketId) * 7919 + WALLET_SET);
  let lastNoise = 0, lastAtm = 0, lastTail = 0, didSnipe = false, didStack = false;
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= end) break;
    if (now < start) { await new Promise((r) => setTimeout(r, Math.min(LOOP, start - now) * 1000)); continue; }
    try {
      const price = await livePrice(); const lBin = liveBin(price);
      const mm = await core.markets(marketId); const oBin = binOf(BigInt(mm.cachedOracleTick));
      if (mm.tradingHalted) { log({ action: "halted" }); await new Promise((r) => setTimeout(r, LOOP * 1000)); continue; }
      if (STRATS.includes("stacker") && !didStack) {
        didStack = true;
        const unit = cap > 0n ? Math.floor(Number(cap) / 1e6 * 0.18) : 8000; // five orders ≈ 90 % of the cap on the centre bin
        for (const [lo, hi] of [[lBin, lBin], [lBin - 1, lBin + 1], [lBin - 2, lBin + 2], [lBin, lBin], [lBin - 1, lBin + 1]]) await buy("stacker", Math.max(0, lo), Math.min(nb - 1, hi), unit);
      }
      if (STRATS.includes("lag") && lBin !== oBin) {
        log({ strat: "lag", action: "opportunity", liveBin: lBin, oracleBin: oBin, price });
        const pid = await buy("lag", lBin, lBin, 50, false); // deliberately stale-priced
        await refresh("lag");
        if (pid !== null) await close("lag", pid);
      }
      if (STRATS.includes("noise") && now - lastNoise >= NOISE_SEC) { lastNoise = now; const c = Math.max(0, Math.min(nb - 1, lBin + Math.round(gauss(rng) * 3))); const span = rng() < 0.5 ? 0 : 1; await buy("noise", c, Math.min(nb - 1, c + span), 2 + Math.floor(rng() * 19)); }
      if (STRATS.includes("atm") && now - lastAtm >= ATM_SEC) { lastAtm = now; await buy("atm", lBin, lBin, 20); }
      if (STRATS.includes("tail") && now - lastTail >= TAIL_SEC) { lastTail = now; const d = (rng() < 0.5 ? -1 : 1) * (12 + Math.floor(rng() * 15)); const b = Math.max(0, Math.min(nb - 1, lBin + d)); await buy("tail", b, b, 50); }
      if (STRATS.includes("sniper") && !didSnipe && end - now <= SNIPE_SEC) { didSnipe = true; await buy("sniper", lBin, lBin, 100); }
    } catch (e: any) { log({ action: "loop-error", err: String(e.shortMessage || e.message).slice(0, 120) }); }
    await new Promise((r) => setTimeout(r, LOOP * 1000));
  }
  log({ action: "trading-closed" });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
