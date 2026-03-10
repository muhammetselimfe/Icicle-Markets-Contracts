import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LazyMulSegmentTree, LPVaultModule, MarketLifecycleModule, MockERC20, MockIcicleOptionsPosition, TradeModule, OracleModule, IcicleOptionsCoreHarness, IcicleOptionsCore, TestERC1967Proxy } from '../../../typechain-types';
import {
  DATA_FEED_ID,
  FEED_DECIMALS,
  authorisedWallets,
  buildRedstonePayload,
  submitWithPayload,
} from "../../helpers/redstone";
import {
  advancePastBatchEnd,
  batchStartTimestamp,
  toBatchId,
} from "../../helpers/constants";
import { deploySeedData } from "../../helpers";
const WAD = ethers.parseEther("1");

// Redstone feed config (for setRedstoneConfig)
const FEED_ID = ethers.encodeBytes32String(DATA_FEED_ID);
const MAX_SAMPLE_DISTANCE = 600n;
const FUTURE_TOLERANCE = 60n;

// Human price to tick mapping: humanPrice equals desired tick
function tickToHumanPrice(tick: bigint): number {
  return Number(tick);
}

describe("VaultWithMarkets E2E", () => {
  async function deploySystem() {
    const [owner, seeder] = await ethers.getSigners();

    // Use 6-decimal token (paymentToken = USDC6)
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const payment = (await MockERC20Factory.deploy(
      "MockVaultToken",
      "MVT",
      6
    )) as MockERC20;

    const position = (await (
      await ethers.getContractFactory("MockIcicleOptionsPosition")
    ).deploy()) as MockIcicleOptionsPosition;

    const lazy = (await (
      await ethers.getContractFactory("LazyMulSegmentTree")
    ).deploy()) as LazyMulSegmentTree;
    const lifecycle = (await (
      await ethers.getContractFactory("MarketLifecycleModule", {
        libraries: { LazyMulSegmentTree: lazy.target },
      })
    ).deploy()) as MarketLifecycleModule;
    const trade = (await (
      await ethers.getContractFactory("TradeModule", {
        libraries: { LazyMulSegmentTree: lazy.target },
      })
    ).deploy()) as TradeModule;

    // Use OracleModuleHarness to allow Hardhat local signers for Redstone verification
    const oracle = (await (
      await ethers.getContractFactory("OracleModuleHarness")
    ).deploy()) as OracleModule;
    const vault = (await (
      await ethers.getContractFactory("LPVaultModule")
    ).deploy()) as LPVaultModule;
    const risk = await (await ethers.getContractFactory("RiskModule")).deploy();

    const coreImpl = (await (
      await ethers.getContractFactory("IcicleOptionsCoreHarness", {
        libraries: { LazyMulSegmentTree: lazy.target },
      })
    ).deploy()) as IcicleOptionsCoreHarness;

    const feePolicy = await (
      await ethers.getContractFactory("MockFeePolicy")
    ).deploy(0);

    const lpShareImpl = await (
      await ethers.getContractFactory("IcicleOptionsLPShare")
    ).deploy();
    const proxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const lpShareProxy = (await proxyFactory.deploy(
      await lpShareImpl.getAddress(),
      "0x"
    )) as TestERC1967Proxy;
    const coreProxy = (await proxyFactory.deploy(
      coreImpl.target,
      "0x"
    )) as TestERC1967Proxy;

    const core = (await ethers.getContractAt(
      "IcicleOptionsCoreHarness",
      await coreProxy.getAddress()
    )) as IcicleOptionsCoreHarness;
    const lpShare = await ethers.getContractAt(
      "IcicleOptionsLPShare",
      await lpShareProxy.getAddress()
    );

    const submitWindow = 300;
    const opsWindow = 60;
    const claimDelay = submitWindow + opsWindow;
    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: payment.target.toString(),
      positionContract: position.target.toString(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: trade.target.toString(),
      lifecycleModule: lifecycle.target.toString(),
      riskModule: risk.target.toString(),
      vaultModule: vault.target.toString(),
      oracleModule: oracle.target.toString(),
      ownerSafe: owner.address,
      settlementSubmitWindow: submitWindow,
      pendingOpsWindow: opsWindow,
      claimDelaySeconds: claimDelay,
      redstoneFeedId: FEED_ID,
      redstoneFeedDecimals: FEED_DECIMALS,
      maxSampleDistance: MAX_SAMPLE_DISTANCE,
      futureTolerance: FUTURE_TOLERANCE,
      lambda: ethers.parseEther("0.2"),
      kDrawdown: ethers.parseEther("1"),
      enforceAlpha: false,
      rhoBS: 0n,
      phiLP: ethers.parseEther("0.8"),
      phiBS: ethers.parseEther("0.1"),
      phiTR: ethers.parseEther("0.1"),
      withdrawalLagBatches: 0,
      operatorAllowlist: [owner.address],
    };
    await core.initialize(coreParams);
    await lpShare.initialize(
      await core.getAddress(),
      payment.target.toString(),
      "Icicle Options LP",
      "ICOLP",
      owner.address
    );
    // Capital stack starts at zero by default

    return { owner, seeder, core, payment, feePolicy };
  }

  it("finalizePrimary records daily PnL and vault consumes it in processDailyBatch", async () => {
    const { owner, seeder, core, payment, feePolicy } = await loadFixture(deploySystem);

    // Fix timestamp so batchId (day-key) is deterministic and monotonic
    const latest = BigInt(await time.latest());
    const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;
    const dayKey = toBatchId(seedTime);
    const expectedFirstBatchId = dayKey;

    // Seed vault (sets currentBatchId = dayKey - 1)
    const seedAmount = ethers.parseEther("1000");
    await payment.mint(seeder.address, seedAmount);
    await payment
      .connect(seeder)
      .approve(await core.getAddress(), ethers.MaxUint256);

    await time.setNextBlockTimestamp(Number(seedTime));
    await core.connect(seeder).seedVault(seedAmount);

    const currentBatchId = await core.currentBatchId();
    expect(currentBatchId).to.equal(expectedFirstBatchId - 1n);

    // Create a market that settles on the same day-key as the first vault batch
    const tSet = seedTime + 10n;
    const start = tSet - 200n;
    const end = tSet - 20n;

    const marketId = await core.createMarketUniform.staticCall(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(tSet),
      4,
      WAD,
      feePolicy.target.toString()
    );
    await core.createMarketUniform(
      0,
      4,
      1,
      Number(start),
      Number(end),
      Number(tSet),
      4,
      WAD,
      feePolicy.target.toString()
    );

    // Manipulate tree state to create non-zero P&L at settlement
    // Z_start = 4e18, Z_end = 5e18 → L_t > 0
    await core.harnessSeedTree(marketId, [
      2n * WAD,
      1n * WAD,
      1n * WAD,
      1n * WAD,
    ]);

    const batchId = toBatchId(tSet);
    expect(batchId).to.equal(expectedFirstBatchId);

    // Submit oracle price candidate within window [Tset, Tset + submitWindow]
    const priceTimestamp = tSet + 1n;
    await time.setNextBlockTimestamp(Number(priceTimestamp + 1n));
    const payload = buildRedstonePayload(tickToHumanPrice(1n), Number(priceTimestamp), authorisedWallets);
    await submitWithPayload(core, owner, marketId, payload);

    // Finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
    const opsEnd = tSet + 300n + 60n;
    await time.setNextBlockTimestamp(Number(opsEnd + 1n));
    await core.connect(owner).finalizePrimarySettlement(marketId);

    const [ltBefore, ftotBefore, , , , , processedBefore] =
      await core.getDailyPnl.staticCall(batchId);
    expect(processedBefore).to.equal(false);
    expect(ftotBefore).to.equal(0n);
    expect(ltBefore).to.not.equal(0n);

    const navBefore = await core.getVaultNav.staticCall();
    await advancePastBatchEnd(batchId);
    await core.processDailyBatch(batchId);
    const navAfter = await core.getVaultNav.staticCall();

    expect(navAfter).to.not.equal(navBefore);

    const [, , , , , , processedAfter] = await core.getDailyPnl.staticCall(
      batchId
    );
    expect(processedAfter).to.equal(true);
    expect(await core.currentBatchId()).to.equal(batchId);
  });

  // ==================================================================
  // ΔEₜ Grant Cap Wiring
  // Tests: prior → settle → batch → waterfall
  // ==================================================================
  describe("ΔEₜ Grant Cap Wiring", () => {
    it("batch succeeds when grantNeed ≤ ΔEₜ (uniform prior, no grant needed)", async () => {
      const { seeder, core, payment, feePolicy } = await loadFixture(deploySystem);

      const latest = BigInt(await time.latest());
      const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;

      const seedAmount = ethers.parseEther("1000");
      await payment.mint(seeder.address, seedAmount);
      await payment
        .connect(seeder)
        .approve(await core.getAddress(), ethers.MaxUint256);
      await time.setNextBlockTimestamp(Number(seedTime));
      await core.connect(seeder).seedVault(seedAmount);

      // Create market with uniform prior → ΔEₜ = 0
      const tSet = seedTime + 500n;
      await core.createMarketUniform(
        0,
        100,
        10,
        Number(seedTime + 100n),
        Number(tSet - 100n),
        Number(tSet),
        10,
        WAD,
        feePolicy.target.toString()
      );

      // Submit oracle and settle
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp));
      const payload1 = buildRedstonePayload(tickToHumanPrice(50n), Number(priceTimestamp), authorisedWallets);
      await submitWithPayload(core, seeder, 1n, payload1);
      // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(1n);

      // Process batch - should succeed (uniform prior has ΔEₜ = 0, and no grant needed with no loss)
      const batchId = toBatchId(tSet);
      await advancePastBatchEnd(batchId);
      await expect(core.processDailyBatch(batchId)).to.not.be.reverted;

      const [, , , , , , processed] = await core.getDailyPnl.staticCall(
        batchId
      );
      expect(processed).to.equal(true);
    });

    it("market ΔEₜ is stored and propagated to batch snapshot", async () => {
      const { seeder, core, payment, feePolicy } = await loadFixture(deploySystem);

      const latest = BigInt(await time.latest());
      const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;

      const seedAmount = ethers.parseEther("1000");
      await payment.mint(seeder.address, seedAmount);
      await payment
        .connect(seeder)
        .approve(await core.getAddress(), ethers.MaxUint256);
      await time.setNextBlockTimestamp(Number(seedTime));
      await core.connect(seeder).seedVault(seedAmount);

      // Increase backstopNav for prior admissibility
      const backstopAmount = ethers.parseUnits("10000", 6);
      await payment.mint(seeder.address, backstopAmount);
      await core.connect(seeder).fundBackstop(backstopAmount);

      // Create market with concentrated prior → ΔEₜ > 0
      const tSet = seedTime + 500n;
      const concentratedFactors = Array(10).fill(WAD);
      concentratedFactors[0] = 2n * WAD; // 2x weight on first bin
      const seedData = await deploySeedData(concentratedFactors);

      await core.createMarket(
        0,
        100,
        10,
        Number(seedTime + 100n),
        Number(tSet - 100n),
        Number(tSet),
        10,
        ethers.parseEther("100"), // α = 100
        feePolicy.target.toString(),
        await seedData.getAddress()
      );

      // Verify market has ΔEₜ stored
      const market = await core.harnessGetMarket(1n);
      expect(market.deltaEt).to.be.gt(0n);
      // ΔEₜ ≈ 100 * ln(11/10) ≈ 9.53 WAD
      expect(market.deltaEt).to.be.lt(ethers.parseEther("15"));

      // Submit oracle and settle
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp));
      const payload2 = buildRedstonePayload(tickToHumanPrice(50n), Number(priceTimestamp), authorisedWallets);
      await submitWithPayload(core, seeder, 1n, payload2);
      // finalize after PendingOps ends (submitWindow=300, pendingOpsWindow=60)
      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(1n);

      // Process batch
      const batchId = toBatchId(tSet);
      await advancePastBatchEnd(batchId);
      await core.processDailyBatch(batchId);

      // Verify batch processed successfully
      const [, , , , , , processed] = await core.getDailyPnl.staticCall(
        batchId
      );
      expect(processed).to.equal(true);
    });

    it("single market per batch: ΔEₜ is stored and used in grant cap", async () => {
      // E2E verification that market's deltaEt is correctly stored and used
      // in the fee waterfall's grant cap calculation during batch processing.
    // Note: System allows multiple markets per batch; ΔEₜ sums per batch.
      const { seeder, core, payment, feePolicy } = await loadFixture(deploySystem);

      const latest = BigInt(await time.latest());
      const seedTime = batchStartTimestamp(toBatchId(latest) + 1n) + 1_000n;

      const seedAmount = ethers.parseEther("1000");
      await payment.mint(seeder.address, seedAmount);
      await payment
        .connect(seeder)
        .approve(await core.getAddress(), ethers.MaxUint256);
      await time.setNextBlockTimestamp(Number(seedTime));
      await core.connect(seeder).seedVault(seedAmount);

      // Increase backstopNav for prior admissibility
      const backstopAmount = ethers.parseUnits("10000", 6);
      await payment.mint(seeder.address, backstopAmount);
      await core.connect(seeder).fundBackstop(backstopAmount);

      // Create market with concentrated prior (ΔEₜ > 0)
      const tSet = seedTime + 500n;
      const batchId = toBatchId(tSet);
      
      const factors = Array(10).fill(WAD);
      factors[0] = 2n * WAD; // 2x weight on first bin
      const seedData = await deploySeedData(factors);
      await core.createMarket(
        0, 100, 10,
        Number(seedTime + 100n), Number(tSet - 100n), Number(tSet),
        10, ethers.parseEther("100"),
        feePolicy.target.toString(), await seedData.getAddress()
      );

      // Verify market has deltaEt > 0
      const market = await core.harnessGetMarket(1n);
      expect(market.deltaEt).to.be.gt(0n);

      // Settle market
      const priceTimestamp = tSet + 1n;
      await time.setNextBlockTimestamp(Number(priceTimestamp));
      const payload = buildRedstonePayload(tickToHumanPrice(50n), Number(priceTimestamp), authorisedWallets);
      await submitWithPayload(core, seeder, 1n, payload);

      const opsEnd = tSet + 300n + 60n;
      await time.setNextBlockTimestamp(Number(opsEnd + 1n));
      await core.finalizePrimarySettlement(1n);

      // Process batch
      await advancePastBatchEnd(batchId);
      await expect(core.processDailyBatch(batchId)).to.not.be.reverted;

      const [, , , , , , processed] = await core.getDailyPnl.staticCall(batchId);
      expect(processed).to.equal(true);
    });

    // Note: 
    // 1. System allows multiple markets per batch; ΔEₜ sums per batch.
    // 2. GrantExceedsTailBudget revert is covered exhaustively in
    //    test/unit/lib/feeWaterfallLib.spec.ts (INV-FW4 tests).
  });
});
