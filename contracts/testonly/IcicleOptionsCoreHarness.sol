// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCore.sol";
import "../lib/LazyMulSegmentTree.sol";
import "../lib/ExposureDiffLib.sol";
import "../lib/TickBinLib.sol";
import "../utils/SeedData.sol";

/// @notice Harness extending IcicleOptionsCore with helpers to seed markets/trees for tests.
contract IcicleOptionsCoreHarness is IcicleOptionsCore {
    using LazyMulSegmentTree for LazyMulSegmentTree.Tree;

    /// @dev Internal helper for raw prefix sum (test-only, not in production lib)
    function _rawPrefixSum(mapping(uint32 => int256) storage diff, uint32 bin) internal view returns (int256 sum) {
        for (uint32 i = 0; i <= bin; i++) {
            sum += diff[i];
        }
    }

    function harnessSetMarket(uint256 marketId, IIcicleOptionsCore.Market calldata market) external onlyOwner {
        markets[marketId] = market;
    }

    function harnessSeedTree(uint256 marketId, uint256[] calldata factors) external onlyOwner {
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        if (tree.size == 0) {
            tree.init(uint32(factors.length));
        }
        tree.seedWithFactors(factors);
    }

    function harnessSetPositionContract(address pos) external onlyOwner {
        positionContract = IIcicleOptionsPosition(pos);
    }

    function harnessSetPaymentToken(address token) external onlyOwner {
        paymentToken = IERC20(token);
    }

    function harnessGetTreeSize(uint256 marketId) external view returns (uint32) {
        return marketTrees[marketId].size;
    }

    function harnessGetTreeSum(uint256 marketId) external view returns (uint256) {
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        if (tree.size == 0) return 0;
        return tree.totalSum();
    }

    function harnessGetMarket(uint256 marketId) external view returns (IIcicleOptionsCore.Market memory) {
        return markets[marketId];
    }

    /// @notice Set batch market counts for testing (bypasses lifecycle)
    function harnessSetBatchMarketState(uint64 batchId, uint64 total, uint64 resolved) external onlyOwner {
        _batchMarketState[batchId] = BatchMarketState({ total: total, resolved: resolved });
    }

    // ============================================================
    // Exposure Ledger test helpers (Fenwick-based)
    // ============================================================

    /**
     * @notice Set exposure at a specific tick for testing (Fenwick-based)
     * @dev Computes delta from current exposure and applies it via Fenwick rangeAdd
     * @param marketId Market identifier
     * @param tick Settlement tick (must be aligned to tickSpacing)
     * @param exposure Target exposure at this tick (token units)
     */
    function harnessSetExposure(uint256 marketId, int256 tick, uint256 exposure) external onlyOwner {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        uint32 bin = TickBinLib.tickToBin(market.minTick, market.tickSpacing, market.numBins, tick);
        
        // Get current exposure via prefix sum
        int256 current = _rawPrefixSum(_exposureDiff[marketId], bin);
        int256 delta = int256(exposure) - current;
        
        // Apply delta to single bin [bin, bin]
        if (delta != 0) {
            ExposureDiffLib.rangeAdd(
                _exposureDiff[marketId],
                bin,
                bin,
                delta,
                market.numBins
            );
        }
    }

    /**
     * @notice Add exposure to a range of ticks (Fenwick-based, simulates openPosition)
     * @param marketId Market identifier
     * @param lowerTick Lower bound (inclusive)
     * @param upperTick Upper bound (exclusive)
     * @param quantity Position quantity (token units)
     */
    function harnessAddExposure(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint256 quantity
    ) external onlyOwner {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );
        
        ExposureDiffLib.rangeAdd(
            _exposureDiff[marketId],
            loBin,
            hiBin,
            int256(quantity),
            market.numBins
        );
    }

    /// @notice Set exposure at a specific tick (Diff-based)
    function harnessSetExposureAtTick(
        uint256 marketId,
        int256 tick,
        uint256 quantity
    ) external onlyOwner {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        uint32 bin = TickBinLib.tickToBin(market.minTick, market.tickSpacing, market.numBins, tick);
        
        int256 current = _rawPrefixSum(_exposureDiff[marketId], bin);
        int256 delta = int256(quantity) - current;
        
        if (delta != 0) {
            ExposureDiffLib.rangeAdd(
                _exposureDiff[marketId],
                bin,
                bin,
                delta,
                market.numBins
            );
        }
    }

    /// @notice Set payout reserve for a market (for testing)
    function harnessSetPayoutReserve(
        uint256 marketId,
        uint256 amount
    ) external onlyOwner {
        _payoutReserve[marketId] = amount;
        _payoutReserveRemaining[marketId] = amount;
    }

    /// @notice Set reserved balances for free-balance checks (test-only)
    function harnessSetReserves(
        uint256 pendingDeposits6,
        uint256 pendingWithdrawals6,
        uint256 payoutReserve6
    ) external onlyOwner {
        _totalPendingDeposits6 = pendingDeposits6;
        _totalPendingWithdrawals6 = pendingWithdrawals6;
        _totalPayoutReserve6 = payoutReserve6;
    }

    /**
     * @notice Get exposure at a specific tick (Fenwick-based)
     * @param marketId Market identifier
     * @param tick Settlement tick (must be aligned to tickSpacing)
     * @return exposure Total exposure at this tick
     */
    function harnessGetExposure(uint256 marketId, int256 tick) external view returns (uint256 exposure) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        uint32 bin = TickBinLib.tickToBin(market.minTick, market.tickSpacing, market.numBins, tick);
        return ExposureDiffLib.pointQuery(_exposureDiff[marketId], bin);
    }

    /**
     * @notice Get payout reserve for a market
     * @param marketId Market identifier
     * @return reserve Total payout reserve for the market
     */
    function harnessGetPayoutReserve(uint256 marketId) external view returns (uint256 reserve) {
        return _payoutReserve[marketId];
    }

    // ============================================================
    // LP Vault state helpers for testing
    // ============================================================

    /// @notice Set LP vault state directly for testing α safety with peak drawdown
    function harnessSetLpVault(
        uint256 nav,
        uint256 shares,
        uint256 price,
        uint256 pricePeak,
        bool isSeeded
    ) external onlyOwner {
        lpVault.nav = nav;
        lpVault.shares = shares;
        lpVault.price = price;
        lpVault.pricePeak = pricePeak;
        lpVault.isSeeded = isSeeded;
    }

    /// @notice Get current LP vault state
    function harnessGetLpVault() external view returns (
        uint256 nav,
        uint256 shares,
        uint256 price,
        uint256 pricePeak,
        bool isSeeded
    ) {
        return (lpVault.nav, lpVault.shares, lpVault.price, lpVault.pricePeak, lpVault.isSeeded);
    }

    // ============================================================
    // Backward-compatible createMarket for tests
    // ============================================================

    /// @notice Create market with uniform prior (backward compatible for tests)
    /// @dev Generates uniform factors (all 1 WAD) internally and wraps them in SeedData.
    function createMarketUniform(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp,
        uint32 numBins,
        uint256 liquidityParameter,
        address feePolicy
    ) external onlyOwner whenNotPaused returns (uint256 marketId) {
        // Generate uniform factors for backward compatibility
        uint256[] memory factors = new uint256[](numBins);
        for (uint256 i = 0; i < numBins; i++) {
            factors[i] = 1e18;
        }

        SeedData seedData = new SeedData(abi.encodePacked(factors));
        marketId = createMarket(
            minTick,
            maxTick,
            tickSpacing,
            startTimestamp,
            endTimestamp,
            settlementTimestamp,
            numBins,
            liquidityParameter,
            feePolicy,
            address(seedData)
        );
        seedNextChunks(marketId, numBins);
        return marketId;
    }

    /// @dev Set market failed state for testing settlement failure paths
    function harnessSetMarketFailed(uint256 marketId, bool failed) external onlyOwner {
        markets[marketId].failed = failed;
        if (failed) {
            markets[marketId].settled = false;
        }
    }

    /// @dev Set market settled state for testing
    function harnessSetMarketSettled(uint256 marketId, bool settled) external onlyOwner {
        markets[marketId].settled = settled;
    }
}
