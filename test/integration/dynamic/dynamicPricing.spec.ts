import { ethers } from "hardhat";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFullSystem } from "../../helpers/fullSystem";
import { deploySeedData } from "../../helpers";
import { uniformFactors, toBatchId, batchStartTimestamp } from "../../helpers/constants";
import { authorisedWallets, buildRedstonePayload } from "../../helpers/redstone";

const WAD = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const MIN = 700, MAX = 1100, SP = 5, N = 80, ANCHOR = 40;
const ALPHA = ethers.parseEther("10");
const REFRESH = new ethers.Interface(["function refreshTradeOracle(uint256 marketId)"]);
const DP = { w: WAD, volBinsWad: 8n * WAD, sigmaMinWad: wad(0.75), sigmaMaxWad: 8n * WAD, floorWad: wad(0.05), perBinCap: 1_000_000_000_000n, anchorCenterBin: ANCHOR };

describe("v2 dynamic pricing", () => {
  async function setup() {
    const sys = await deployFullSystem({ submitWindow: 5, opsWindow: 5 });
    const coreAddr = await sys.core.getAddress();
    const fee = await (await ethers.getContractFactory("MockFeePolicy")).deploy(100);
    const seedTime = batchStartTimestamp(toBatchId(BigInt(await time.latest())) + 1n) + 1000n;
    await sys.payment.connect(sys.owner).approve(coreAddr, ethers.MaxUint256);
    await time.setNextBlockTimestamp(Number(seedTime));
    await sys.core.connect(sys.owner).seedVault(10_000_000_000n);
    for (const t of sys.users.slice(0, 3)) {
      await sys.payment.transfer(t.address, 100_000_000_000n);
      await sys.payment.connect(t).approve(coreAddr, ethers.MaxUint256);
    }
    return { ...sys, coreAddr, feeAddr: await fee.getAddress() };
  }

  async function createDynamic(core: any, feeAddr: string, dp = DP) {
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    const id = await core.createMarketDynamic.staticCall(...args, dp);
    await core.createMarketDynamic(...args, dp);
    while (!(await core.markets(id)).isSeeded) await core.seedNextChunks(id, 50);
    return { id, tSet, start, end };
  }
  async function createStatic(core: any, feeAddr: string) {
    const pointer = Number(await core.getCurrentBatchId());
    const base = batchStartTimestamp(BigInt(pointer) + 1n);
    const tSet = base + 2000n, start = base + 1100n, end = base + 1700n;
    const seedData = await deploySeedData(uniformFactors(N));
    const args = [MIN, MAX, SP, Number(start), Number(end), Number(tSet), N, ALPHA, feeAddr, await seedData.getAddress()] as const;
    const id = await core.createMarket.staticCall(...args);
    await core.createMarket(...args);
    while (!(await core.markets(id)).isSeeded) await core.seedNextChunks(id, 50);
    return { id, tSet, start, end };
  }
  async function refresh(core: any, signer: any, id: bigint, humanPrice: number) {
    const ts = await time.latest();
    const payload = buildRedstonePayload(humanPrice, ts - 1, authorisedWallets);
    const data = REFRESH.encodeFunctionData("refreshTradeOracle", [id]) + payload.replace(/^0x/, "");
    await signer.sendTransaction({ to: await core.getAddress(), data });
  }
  const ticks = (bin: number) => [MIN + bin * SP, MIN + (bin + 1) * SP] as const;

  it("createMarketDynamic stores config and flags the market dynamic", async () => {
    const { core, feeAddr } = await setup();
    const { id } = await createDynamic(core, feeAddr);
    const m = await core.markets(id);
    expect(m.dynamicEnabled).to.equal(true);
    expect(m.dynW).to.equal(WAD);
    expect(m.dynVolBinsWad).to.equal(8n * WAD);
    expect(m.anchorCenterBin).to.equal(ANCHOR);
  });

  it("refreshTradeOracle updates the cached oracle tick", async () => {
    const { core, owner, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, 960); // $9.60 -> tick 960
    const m = await core.markets(id);
    expect(m.cachedOracleTick).to.equal(960n);
    expect(m.cachedOracleTs).to.be.greaterThan(0n);
  });

  it("prices the bin at the oracle higher than a far bin (bell)", async () => {
    const { core, owner, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP); // oracle at center bin
    const q = 5_000_000n;
    const [loN, hiN] = ticks(ANCHOR);
    const [loF, hiF] = ticks(5);
    const costNear = await core.calculateOpenCost.staticCall(id, loN, hiN, q);
    const costFar = await core.calculateOpenCost.staticCall(id, loF, hiF, q);
    expect(costNear).to.be.greaterThan(costFar);
  });

  it("view quote matches executed cost for a dynamic buy", async () => {
    const { core, owner, payment, users, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    const trader = users[0];
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    const q = 8_000_000n;
    const [lo, hi] = ticks(ANCHOR);
    const quoted = await core.calculateOpenCost.staticCall(id, lo, hi, q);
    const balBefore = await payment.balanceOf(trader.address);
    await core.connect(trader).openPosition(id, lo, hi, q, quoted * 2n);
    const spent = balBefore - (await payment.balanceOf(trader.address));
    // spent = cost + 1% fee; cost ~ quoted (within tree chunk-rounding)
    const cost = (spent * 10000n) / 10100n;
    const diff = cost > quoted ? cost - quoted : quoted - cost;
    expect(diff).to.be.lessThan(quoted / 100n + 10n); // within ~1%
  });

  it("records NET sell proceeds in accumulatedProceeds (sell-fee routing fix)", async () => {
    const { core, owner, payment, users, position, feeAddr } = await setup();
    const { id, start } = await createDynamic(core, feeAddr);
    const trader = users[0];
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    const q = 8_000_000n;
    const [lo, hi] = ticks(ANCHOR);
    const cost = await core.calculateOpenCost.staticCall(id, lo, hi, q);
    await core.connect(trader).openPosition(id, lo, hi, q, cost * 2n + 2_000_000n);
    const ids = await position.getPositionsByOwner(trader.address);
    const pid = ids[ids.length - 1];

    // sell half; measure the NET proceeds the pool actually paid the seller
    const balBefore = await payment.balanceOf(trader.address);
    await core.connect(trader).decreasePosition(pid, q / 2n, 0n);
    const netReceived6 = (await payment.balanceOf(trader.address)) - balBefore;

    const m = await core.markets(id);
    // accumulatedProceeds (WAD) must equal NET proceeds paid out, NOT gross (incl. fee).
    // Gross-recording would over-state proceeds by the withheld sell fee and route it
    // 100% to the LP via loss-comp instead of the 70/20/10 waterfall.
    expect(m.accumulatedProceeds).to.equal(netReceived6 * 10n ** 12n);
    expect(m.accumulatedFees).to.be.gt(0n); // a sell fee was charged and tracked separately
  });

  it("enforces the per-bin exposure cap (boundary inclusive)", async () => {
    const { core, owner, users, feeAddr } = await setup();
    const dp = { ...DP, perBinCap: 10_000_000n }; // 10 units
    const { id, start } = await createDynamic(core, feeAddr, dp);
    const trader = users[0];
    await time.increaseTo(Number(start) + 5);
    await refresh(core, owner, id, MIN + ANCHOR * SP);
    const [lo, hi] = ticks(ANCHOR);
    const buy = async (units: number) => {
      const q = BigInt(units) * 1_000_000n;
      const c = await core.calculateOpenCost.staticCall(id, lo, hi, q);
      return core.connect(trader).openPosition(id, lo, hi, q, c * 2n + 2_000_000n);
    };
    await (await buy(6)).wait();
    await expect(buy(6)).to.be.revertedWithCustomError(core, "BinExposureCapExceeded");
    await (await buy(4)).wait(); // 6+4 = 10 = cap, boundary OK
  });

  it("dynamic prices the drifted winner far higher than static (the loss-reduction mechanism)", async () => {
    // The root cause of static LP loss: a bin far from the (stale) anchor is
    // underpriced, so an informed trader buys the eventual winner cheaply. Dynamic
    // pricing re-centers on the oracle, so that same bin is priced near its true
    // probability -> the trader's edge (and the LP's loss) collapses.
    const s = await setup();
    const winBin = 60; // price drifted +20 bins from anchor (bin 40)
    const [lo, hi] = ticks(winBin);
    const q = 10_000_000n;

    const stat = await createStatic(s.core, s.feeAddr);
    const dyn = await createDynamic(s.core, s.feeAddr);

    // late in the window so dynamic sigma has narrowed toward the true terminal dist
    await time.increaseTo(Number(dyn.end) - 30);
    await refresh(s.core, s.owner, dyn.id, MIN + winBin * SP); // oracle tracks the drifted price

    const costStatic = await s.core.calculateOpenCost.staticCall(stat.id, lo, hi, q);
    const costDynamic = await s.core.calculateOpenCost.staticCall(dyn.id, lo, hi, q);

    // static underprices the drifted winner; dynamic prices it much higher.
    // payout per unit = 1.0 (1e6); LP loss-if-wins = payout - cost, so higher cost = less loss.
    expect(costDynamic).to.be.greaterThan(costStatic * 3n);
    // per-unit static cost is a small fraction of payout (deep LP exposure)...
    expect(costStatic).to.be.lessThan(q / 10n); // < $0.10/unit
    // ...while dynamic prices it near its (narrowed) true probability.
    expect(costDynamic).to.be.greaterThan(q / 8n); // > $0.125/unit (vs static ~$0.0125)
  });
});
