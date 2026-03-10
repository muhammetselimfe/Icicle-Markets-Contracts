// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCoreStorage.sol";
import "../modules/LPVaultModule.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title LPVaultModuleProxy
 * @notice Test harness to delegate calls to LPVaultModule
 * @dev Provides storage context for delegate calls
 */
contract LPVaultModuleProxy is IcicleOptionsCoreStorage {
    address public module;

    constructor(address _module) {
        module = _module;
    }

    // ============================================================
    // Setup
    // ============================================================

    function setPaymentToken(address token) external {
        paymentToken = IERC20(token);
    }

    function setWithdrawalLagBatches(uint64 lag) external {
        withdrawalLagBatches = lag;
    }

    /// @notice Set risk config with NAV floor invariant (pdd := -λ)
    function setRiskConfig(
        uint256 lambda,
        uint256 kDrawdown,
        bool enforceAlpha
    ) external {
        riskConfig.lambda = lambda;
        riskConfig.kDrawdown = kDrawdown;
        riskConfig.enforceAlpha = enforceAlpha;
        // WP v2: NAV floor invariant (pdd := -λ)
        feeWaterfallConfig.pdd = -int256(lambda);
    }

    /// @dev Per WP v2: NAV floor invariant (pdd := -λ) is enforced via setRiskConfig.
    ///      This function does NOT accept pdd.
    function setFeeWaterfallConfig(
        uint256 rhoBS,
        uint256 phiLP,
        uint256 phiBS,
        uint256 phiTR
    ) external {
        // pdd is NOT set here - it's controlled by setRiskConfig (pdd := -λ)
        feeWaterfallConfig.rhoBS = rhoBS;
        feeWaterfallConfig.phiLP = phiLP;
        feeWaterfallConfig.phiBS = phiBS;
        feeWaterfallConfig.phiTR = phiTR;
    }

    function fundBackstop(uint256 amount6) external {
        _delegate(abi.encodeWithSelector(LPVaultModule.fundBackstop.selector, amount6));
    }

    function withdrawBackstop(uint256 amount6, address to) external {
        _delegate(abi.encodeWithSelector(
            LPVaultModule.withdrawBackstop.selector,
            amount6,
            to
        ));
    }

    function fundTreasury(uint256 amount6) external {
        _delegate(abi.encodeWithSelector(LPVaultModule.fundTreasury.selector, amount6));
    }

    function withdrawTreasury(uint256 amount6, address to) external {
        _delegate(abi.encodeWithSelector(
            LPVaultModule.withdrawTreasury.selector,
            amount6,
            to
        ));
    }

    // ============================================================
    // Seeding
    // ============================================================

    function seedVault(uint256 seedAmount) external {
        _delegate(abi.encodeWithSelector(LPVaultModule.seedVault.selector, seedAmount));
    }

    // ============================================================
    // Request Queue (Request ID Model)
    // ============================================================

    function requestDeposit(uint256 amount) external returns (uint64) {
        bytes memory ret = _delegate(abi.encodeWithSelector(
            LPVaultModule.requestDeposit.selector,
            amount
        ));
        return abi.decode(ret, (uint64));
    }

    function requestWithdraw(uint256 shares) external returns (uint64) {
        bytes memory ret = _delegate(abi.encodeWithSelector(
            LPVaultModule.requestWithdraw.selector,
            shares
        ));
        return abi.decode(ret, (uint64));
    }

    function cancelDeposit(uint64 requestId) external {
        _delegate(abi.encodeWithSelector(
            LPVaultModule.cancelDeposit.selector,
            requestId
        ));
    }

    function cancelWithdraw(uint64 requestId) external {
        _delegate(abi.encodeWithSelector(
            LPVaultModule.cancelWithdraw.selector,
            requestId
        ));
    }

    // ============================================================
    // Batch Processing
    // ============================================================

    /// @notice Harness-only: directly set daily P&L snapshot for testing
    /// @dev This bypasses the settlement flow for unit testing batch processing
    function harnessRecordPnl(uint64 batchId, int256 lt, uint256 ftot, uint256 deltaEt) external {
        DailyPnlSnapshot storage snap = _dailyPnl[batchId];
        snap.Lt += lt;
        snap.Ftot += ftot;
        snap.DeltaEtSum += deltaEt;

        // Default test harness: assume one resolved market per batch unless overridden
        if (_batchMarketState[batchId].total == 0) {
            _batchMarketState[batchId].total = 1;
        }
        if (_batchMarketState[batchId].resolved < _batchMarketState[batchId].total) {
            _batchMarketState[batchId].resolved = _batchMarketState[batchId].total;
        }
    }

    /// @notice Harness-only: set batch market counts explicitly for tests
    function harnessSetBatchMarketState(uint64 batchId, uint64 total, uint64 resolved) external {
        _batchMarketState[batchId] = BatchMarketState({ total: total, resolved: resolved });
    }

    function processDailyBatch(uint64 batchId) external {
        _delegate(abi.encodeWithSelector(
            LPVaultModule.processDailyBatch.selector,
            batchId
        ));
    }

    // ============================================================
    // Claims
    // ============================================================

    function claimDeposit(uint64 requestId) external returns (uint256) {
        bytes memory ret = _delegate(abi.encodeWithSelector(
            LPVaultModule.claimDeposit.selector,
            requestId
        ));
        return abi.decode(ret, (uint256));
    }

    function claimWithdraw(uint64 requestId) external returns (uint256) {
        bytes memory ret = _delegate(abi.encodeWithSelector(
            LPVaultModule.claimWithdraw.selector,
            requestId
        ));
        return abi.decode(ret, (uint256));
    }

    // ============================================================
    // View Functions
    // ============================================================

    function getVaultNav() external view returns (uint256) {
        return lpVault.nav;
    }

    function getVaultShares() external view returns (uint256) {
        return lpVault.shares;
    }

    function getVaultPrice() external view returns (uint256) {
        return lpVault.price;
    }

    function getVaultPricePeak() external view returns (uint256) {
        return lpVault.pricePeak;
    }

    function isVaultSeeded() external view returns (bool) {
        return lpVault.isSeeded;
    }

    function getCapitalStack() external view returns (uint256 backstopNav, uint256 treasuryNav) {
        return (capitalStack.backstopNav, capitalStack.treasuryNav);
    }

    function getPendingBatchTotals(uint64 batchId) external view returns (
        uint256 deposits,
        uint256 withdraws
    ) {
        PendingBatchTotal storage totals = _pendingBatchTotals[batchId];
        return (totals.deposits, totals.withdraws);
    }

    function getBatchAggregation(uint64 batchId) external view returns (
        uint256 totalDepositAssets,
        uint256 totalWithdrawShares,
        uint256 batchPrice,
        bool processed
    ) {
        BatchAggregation storage agg = _batchAggregations[batchId];
        return (agg.totalDepositAssets, agg.totalWithdrawShares, agg.batchPrice, agg.processed);
    }

    function getDailyPnl(uint64 batchId) external view returns (
        int256 Lt,
        uint256 Ftot,
        uint256 Ft,
        uint256 Gt,
        uint256 Npre,
        uint256 Pe,
        bool processed
    ) {
        DailyPnlSnapshot storage snap = _dailyPnl[batchId];
        return (
            snap.Lt,
            snap.Ftot,
            snap.Ft,
            snap.Gt,
            snap.Npre,
            snap.Pe,
            snap.processed
        );
    }

    function getCurrentBatchId() external view returns (uint64) {
        return currentBatchId;
    }

    /// @notice Mirror of LPVaultModule.MIN_DEAD_SHARES for testing
    function MIN_DEAD_SHARES() external pure returns (uint256) {
        return 1000;  // Must match LPVaultModule.MIN_DEAD_SHARES
    }

    /// @notice Mirror of LPVaultModule.DEAD_ADDRESS for testing
    function DEAD_ADDRESS() external pure returns (address) {
        return address(1);  // Must match LPVaultModule.DEAD_ADDRESS
    }

    // ============================================================
    // Internal
    // ============================================================

    function _delegate(bytes memory data) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = module.delegatecall(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}
