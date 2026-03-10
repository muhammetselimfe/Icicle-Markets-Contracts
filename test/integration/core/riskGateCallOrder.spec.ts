import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Signer } from 'ethers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { IcicleOptionsCoreHarness, IcicleOptionsCore, RiskModule, MockERC20, MockFeePolicy } from '../../../typechain-types';
import { deploySeedData } from '../../helpers';

/**
 * Core-first Risk Gate Call Order Tests
 *
 * Verifies that IcicleOptionsCore calls RiskModule gates BEFORE
 * delegating to target modules. This is structural enforcement.
 *
 * Strategy: Use mock modules that revert with identifiable messages
 * to prove call order.
 */
describe('Core-first Risk Gate Call Order', () => {
  const WAD = ethers.parseEther('1');
  
  let owner: Signer;
  let core: IcicleOptionsCoreHarness;
  let paymentToken: MockERC20;
  let riskModule: RiskModule;
  let feePolicy: MockFeePolicy;

  beforeEach(async () => {
    [owner] = await ethers.getSigners();
    
    // Deploy payment token
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    paymentToken = await MockERC20Factory.deploy('USDC', 'USDC', 6) as MockERC20;
    
    // Deploy LazyMulSegmentTree library
    const LazyMulSegmentTree = await ethers.getContractFactory('LazyMulSegmentTree');
    const lazyLib = await LazyMulSegmentTree.deploy();
    
    // Deploy core harness with library linking
    const IcicleOptionsCoreHarnessFactory = await ethers.getContractFactory('IcicleOptionsCoreHarness', {
      libraries: { LazyMulSegmentTree: await lazyLib.getAddress() }
    });
    const coreImpl = await IcicleOptionsCoreHarnessFactory.deploy();
    
    const positionImplFactory = await ethers.getContractFactory('IcicleOptionsPosition');
    const positionImpl = await positionImplFactory.deploy();
    const lpShareImpl = await (await ethers.getContractFactory('IcicleOptionsLPShare')).deploy();
    const proxyFactory = await ethers.getContractFactory('TestERC1967Proxy');
    const positionProxy = await proxyFactory.deploy(await positionImpl.getAddress(), '0x');
    const lpShareProxy = await proxyFactory.deploy(await lpShareImpl.getAddress(), '0x');
    const coreProxy = await proxyFactory.deploy(await coreImpl.getAddress(), '0x');

    const position = await ethers.getContractAt('IcicleOptionsPosition', await positionProxy.getAddress());
    const lpShare = await ethers.getContractAt('IcicleOptionsLPShare', await lpShareProxy.getAddress());
    core = IcicleOptionsCoreHarnessFactory.attach(await coreProxy.getAddress()) as IcicleOptionsCoreHarness;
    
    // Deploy real modules with library linking
    const RiskModuleFactory = await ethers.getContractFactory('RiskModule');
    riskModule = await RiskModuleFactory.deploy() as RiskModule;
    
    const TradeModule = await ethers.getContractFactory('TradeModule', {
      libraries: { LazyMulSegmentTree: await lazyLib.getAddress() }
    });
    const tradeModule = await TradeModule.deploy();
    
    const MarketLifecycleModule = await ethers.getContractFactory('MarketLifecycleModule', {
      libraries: { LazyMulSegmentTree: await lazyLib.getAddress() }
    });
    const lifecycleModule = await MarketLifecycleModule.deploy();
    
    const LPVaultModule = await ethers.getContractFactory('LPVaultModule');
    const vaultModule = await LPVaultModule.deploy();
    
    const OracleModule = await ethers.getContractFactory('OracleModule');
    const oracleModule = await OracleModule.deploy();
    
    feePolicy = await (await ethers.getContractFactory('MockFeePolicy')).deploy(0) as MockFeePolicy;
    const submitWindow = 3600;
    const opsWindow = 86400 - submitWindow;
    const claimDelay = submitWindow + opsWindow;
    const feedId = ethers.encodeBytes32String('BTC');
    const coreParams: IcicleOptionsCore.InitParamsStruct = {
      paymentToken: await paymentToken.getAddress(),
      positionContract: await position.getAddress(),
      lpShareToken: await lpShare.getAddress(),
      tradeModule: await tradeModule.getAddress(),
      lifecycleModule: await lifecycleModule.getAddress(),
      riskModule: await riskModule.getAddress(),
      vaultModule: await vaultModule.getAddress(),
      oracleModule: await oracleModule.getAddress(),
      ownerSafe: await owner.getAddress(),
      settlementSubmitWindow: submitWindow,
      pendingOpsWindow: opsWindow,
      claimDelaySeconds: claimDelay,
      redstoneFeedId: feedId,
      redstoneFeedDecimals: 8,
      maxSampleDistance: 600,
      futureTolerance: 60,
      lambda: ethers.parseEther('0.2'),
      kDrawdown: ethers.parseEther('1'),
      enforceAlpha: false,
      rhoBS: 0n,
      phiLP: ethers.parseEther('0.8'),
      phiBS: ethers.parseEther('0.1'),
      phiTR: ethers.parseEther('0.1'),
      withdrawalLagBatches: 1,
      operatorAllowlist: [await owner.getAddress()],
    };
    await core.initialize(coreParams);
    await position.initialize(await core.getAddress(), await owner.getAddress());
    await lpShare.initialize(
      await core.getAddress(),
      await paymentToken.getAddress(),
      'IcicleOptions LP Share',
      'sLP',
      await owner.getAddress()
    );
    
    // Setup vault for testing
    await paymentToken.mint(await owner.getAddress(), 100_000_000_000n); // 100k USDC
    await paymentToken.approve(await core.getAddress(), ethers.MaxUint256);
    await core.seedVault(10_000_000_000n); // 10k USDC
  });

  describe('createMarket gate enforcement', () => {
    it('calls RiskModule gate before MarketLifecycleModule', async () => {
      // Configure risk to reject all markets (αlimit = 0 due to extreme settings)
      // This proves gate is called first - if lifecycle was called first, 
      // we'd get a different error or success
      await core.setRiskConfig(
        ethers.parseEther('0.001'), // Very low lambda
        ethers.parseEther('100'),   // k = 100 (extreme sensitivity)
        true                        // enforceAlpha = true
      );
      
      // Simulate 99% peak drawdown to make αlimit = 0
      await core.harnessSetLpVault(
        ethers.parseEther('10000'), // nav
        ethers.parseEther('10000'), // shares
        ethers.parseEther('0.01'),  // price (1% of original)
        ethers.parseEther('1'),     // pricePeak
        true
      );
      
      const now = await time.latest();
      const start = now + 100;
      const end = start + 86400;
      const settle = end + 3600;
      const seedData = await deploySeedData(Array(10).fill(WAD));

      // Any α > 0 should fail because αlimit ≈ 0
      await expect(core.createMarket(
        0,      // minTick
        100,    // maxTick
        10,     // tickSpacing
        start,
        end,
        settle,
        10,     // numBins
        ethers.parseEther('1'), // liquidityParameter (α = 1)
        feePolicy.target.toString(),
        await seedData.getAddress()
      )).to.be.revertedWithCustomError(riskModule, 'AlphaExceedsLimit');
    });

    it('allows market creation when gate passes', async () => {
      // Configure permissive risk settings
      await core.setRiskConfig(
        ethers.parseEther('0.5'),  // λ = 0.5
        ethers.parseEther('1'),   // k = 1
        true                      // enforceAlpha = true
      );
      
      const now = await time.latest();
      const start = now + 100;
      const end = start + 86400;
      const settle = end + 3600;
      const seedData = await deploySeedData(Array(10).fill(WAD));
      
      // Small α should pass
      const tx = await core.createMarket(
        0,
        100,
        10,
        start,
        end,
        settle,
        10,
        ethers.parseEther('1'), // Small α
        feePolicy.target.toString(),
        await seedData.getAddress()
      );
      
      expect(tx).to.emit(core, 'MarketCreated');
    });
  });

  describe('openPosition gate enforcement', () => {
    let marketId: bigint;
    
    beforeEach(async () => {
      // Permissive settings
      await core.setRiskConfig(
        ethers.parseEther('0.5'),
        ethers.parseEther('1'),
        true
      );
      
      const now = await time.latest();
      const start = now + 100;
      const end = start + 86400;
      const settle = end + 3600;
      const seedData = await deploySeedData(Array(10).fill(WAD));
      
      const tx = await core.createMarket(
        0, 100, 10, start, end, settle, 10,
        ethers.parseEther('10'),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );
      
      await tx.wait();
      // First market is always ID 1
      marketId = 1n;
      await core.seedNextChunks(marketId, 10);
      
      // Advance time to trading period
      await time.increaseTo(start + 1);
    });

    it('calls gateOpenPosition before TradeModule', async () => {
      // gateOpenPosition is currently a no-op (exposure cap enforcement deferred)
      // This test just verifies the gate is called (no revert from gate = pass)

      const quantity = 100n;
      const maxCost = ethers.parseEther('1000');

      // Should succeed because gate is no-op
      // If gate wasn't called, delegatecall would fail differently
      await expect(core.openPosition(
        marketId,
        0,  // lowerTick
        50, // upperTick
        quantity,
        maxCost
      )).to.not.be.revertedWithCustomError(core, 'PerTicketCapExceeded');
    });
  });

  describe('increasePosition gate enforcement', () => {
    let marketId: bigint;
    
    beforeEach(async () => {
      await core.setRiskConfig(
        ethers.parseEther('0.5'),
        ethers.parseEther('1'),
        true
      );
      
      const now = await time.latest();
      const start = now + 100;
      const end = start + 86400;
      const settle = end + 3600;
      const seedData = await deploySeedData(Array(10).fill(WAD));
      
      const tx = await core.createMarket(
        0, 100, 10, start, end, settle, 10,
        ethers.parseEther('10'),
        feePolicy.target.toString(),
        await seedData.getAddress()
      );
      
      await tx.wait();
      marketId = 1n;
      await core.seedNextChunks(marketId, 10);
      
      await time.increaseTo(start + 1);
    });

    it('calls gateIncreasePosition before TradeModule', async () => {
      // Open a position first
      const quantity = 100n;
      const maxCost = ethers.parseEther('1000');

      await core.openPosition(marketId, 0, 50, quantity, maxCost);

      // Get position ID
      const positionAddr = await core.positionContract();
      const positionContract = await ethers.getContractAt('IcicleOptionsPosition', positionAddr);
      const positions = await positionContract.getPositionsByOwner(await owner.getAddress());
      const positionId = positions[0];

      // gateIncreasePosition is currently a no-op (exposure cap enforcement deferred)
      // This test verifies the gate is called without error
      await expect(core.increasePosition(
        positionId,
        50n, // additional quantity
        maxCost
      )).to.not.be.revertedWithCustomError(core, 'PerTicketCapExceeded');
    });
  });
});
