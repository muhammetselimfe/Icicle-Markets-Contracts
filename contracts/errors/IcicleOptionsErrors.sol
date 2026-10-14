// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IcicleOptionsErrors
/// @notice Single error registry for the entire Icicle Options Protocol
/// @dev All custom errors are defined here. Import with alias: `import {IcicleOptionsErrors as SE} from "..."`
interface IcicleOptionsErrors {
    // ============================================================
    // Module / Wiring
    // ============================================================
    error NotDelegated();
    error ModuleNotSet();
    error InvalidFeeSplitSum(uint256 phiLP, uint256 phiBS, uint256 phiTR);
    error OnlyCore();

    // ============================================================
    // Market Lifecycle
    // ============================================================
    error MarketNotStarted();
    error MarketExpired();
    error MarketNotSeeded();
    error MarketNotSettled(uint256 marketId);
    error MarketNotFound(uint256 marketId);
    error MarketAlreadySettled(uint256 marketId);
    error MarketAlreadyExists(uint256 marketId);
    error MarketNotFailed(uint256 marketId);
    error MarketAlreadyFailed(uint256 marketId);
    error MarketAlreadyFinalized(uint256 marketId);
    error MarketNotDynamic(uint256 marketId);
    error BinExposureCapExceeded(uint256 marketId, uint32 bin, uint256 attempted, uint128 cap);
    error OracleStaleForTrade(uint256 ageSeconds, uint256 maxAgeSeconds);
    error OracleNotInitializedForTrade();
    error InvalidDynamicParams();
    error InvalidMaxSampleDistance(uint64 value);
    error BatchSecondsOutOfRange(uint64 value);
    error BatchPeriodLocked();
    // v2.1 dynamic-pricing hardening
    error TradingHalted(uint256 marketId);
    error PerBinCapTooLarge(uint128 cap, uint256 maxCap);
    error DynamicCutoffTooShort(uint64 cutoff, uint64 minCutoff);
    error InvalidTradeStaleness(uint64 value);
    error InvalidJumpConfig(uint64 bps, uint64 window);
    error InvalidCapBps(uint64 bps);
    error InvalidDynamicCutoff(uint64 value);
    error SeedDataLengthMismatch(uint256 providedBytes, uint256 expectedBytes);
    error SeedAlreadyComplete(uint256 marketId);

    // ============================================================
    // Oracle / Settlement
    // ============================================================
    error OracleSampleTooEarly(uint64 requiredTimestamp, uint64 currentTimestamp);
    error OracleSampleTooFarFromTset(uint64 distance, uint64 maxAllowed);
    error OracleSampleInFuture(uint64 priceTimestamp, uint64 blockTimestamp);
    error SettlementOracleCandidateMissing();
    error SettlementOracleSignatureInvalid(address signer);
    error SettlementWindowNotExpired(uint64 deadline, uint64 currentTime);
    error SettlementWindowClosed();
    error PendingOpsNotStarted();
    error NotInPendingOps();
    error InvalidSettlementTimeline(uint64 claimDelay, uint64 submitWindow, uint64 opsWindow);
    error ClaimTooEarly(uint64 claimOpenTimestamp, uint64 currentTimestamp);
    error PriceOverflow(uint256 scaled);

    // ============================================================
    // Batch Processing
    // ============================================================
    error BatchAlreadyProcessed(uint64 batchId);
    error BatchNotProcessed(uint64 batchId);
    error BatchAlreadyHasMarket(uint64 batchId, uint256 existingMarketId);
    error BatchMarketNotSettled(uint64 batchId, uint256 marketId);
    error BatchHasNoMarkets(uint64 batchId);
    error BatchMarketsNotResolved(uint64 batchId, uint64 resolvedMarkets, uint64 totalMarkets);
    error BatchNotReady(uint64 batchId);
    error BatchNotEnded(uint64 batchId, uint64 batchEndTime, uint64 currentTime);
    error DailyBatchAlreadyProcessed(uint64 batchId);
    error CancelTooLate(uint64 requestId, uint64 eligibleBatchId);
    error BatchDeltaEtExceedsBackstop(uint256 batchDeltaEt, uint256 backstopNav);

    // ============================================================
    // Trade Params
    // ============================================================
    error InvalidTick(int256 tick, int256 minTick, int256 maxTick);
    error InvalidTickRange(int256 lowerTick, int256 upperTick);
    error InvalidTickSpacing(int256 tick, int256 tickSpacing);
    error InvalidQuantity(uint128 qty);
    error CostExceedsMaximum(uint256 cost, uint256 maxAllowed);
    error FeeExceedsBase(uint256 fee, uint256 baseAmount);
    error InvalidFeePolicy(address policy);
    error InvalidMarketParameters(int256 minTick, int256 maxTick, int256 tickSpacing);
    error InvalidTimeRange(uint64 start, uint64 end, uint64 settlement);

    // ============================================================
    // Access Control
    // ============================================================
    error UnauthorizedCaller(address caller);

    // ============================================================
    // Vault / LP
    // ============================================================
    error VaultNotSeeded();
    error VaultAlreadySeeded();
    error InsufficientSeedAmount(uint256 provided, uint256 required);
    error ZeroAmount();
    error ZeroSharesNotAllowed();
    error ZeroPriceNotAllowed();
    error InsufficientShares(uint256 requested, uint256 available);
    error InsufficientNAV(uint256 requested, uint256 available);
    error NAVUnderflow(uint256 navPrev, uint256 loss);
    error PreBatchNavMismatch(uint256 expected, uint256 actual);
    error WithdrawalWouldBrickVault(uint256 totalSharesAfter, uint256 minRequired);
    error AsyncVaultUseRequestDeposit();
    error AsyncVaultUseRequestWithdraw();

    // ============================================================
    // Vault Request Queue
    // ============================================================
    error RequestNotFound(uint64 requestId);
    error RequestNotOwned(uint64 requestId, address owner, address caller);
    error RequestNotPending(uint64 requestId);

    // ============================================================
    // Fee Waterfall
    // ============================================================
    error InsufficientBackstopForGrant(uint256 required, uint256 available);
    error GrantExceedsTailBudget(uint256 grantNeed, uint256 deltaEt);
    error InvalidPhiSum(uint256 sum);
    error InvalidDrawdownFloor(int256 pdd);
    error CatastrophicLoss(uint256 loss, uint256 navPlusFloss);

    // ============================================================
    // Risk / α Safety
    // ============================================================
    error InvalidLambda(uint256 lambda);
    error InvalidNumBins(uint256 numBins);
    error AlphaExceedsLimit(uint256 alpha, uint256 limit);
    error PriorNotAdmissible(uint256 deltaEt, uint256 effectiveBackstop);
    error PerTicketCapExceeded(uint128 quantity, uint128 cap);
    error PerAccountCapExceeded(uint256 totalExposure, uint256 cap);

    // ============================================================
    // Fixed Point Math
    // ============================================================
    error FP_DivisionByZero();
    error FP_InvalidInput();
    error FP_Overflow();

    // ============================================================
    // Config / Misc
    // ============================================================
    error ZeroAddress();
    error InvalidTokenDecimals(uint8 provided, uint8 expected);
    error BinCountExceedsLimit(uint32 requested, uint32 maxAllowed);
    error InvalidLiquidityParameter();
    error ZeroLimit();
    error InvalidRangeCount(int256 ranges, uint256 maxAllowed);
    error RangeBinOutOfBounds(int256 bin, uint32 numBins);
    error BinOutOfBounds(uint32 bin, uint32 numBins);
    error RangeBinsOutOfBounds(uint32 lowerBin, uint32 upperBin, uint32 numBins);
    error InvalidRangeBins(uint32 lowerBin, uint32 upperBin);
    error ManagerNotSet();
    error SnapshotAlreadyCompleted();
    error DeploymentAlreadyExecuted();
    error Create2AddressMismatch(address expected, address actual);

    // ============================================================
    // Position
    // ============================================================
    error PositionNotFound(uint256 positionId);
    error InsufficientBalance(address account, uint256 required, uint256 available);
    error InsufficientPositionQuantity(uint128 want, uint128 have);
    error CloseInconsistent(uint128 expectedZero, uint128 actual);

    // ============================================================
    // Free Balance / Escrow Safety
    // ============================================================
    error InsufficientFreeBalance(uint256 requested, uint256 available);
    error InsufficientPayoutReserve(uint256 payout, uint256 remaining);
    error InsufficientBackstopBalance(uint256 requested, uint256 available);
    error InsufficientTreasuryBalance(uint256 requested, uint256 available);

    // ============================================================
    // Trade / Math
    // ============================================================
    error MathMulOverflow();
    error NonIncreasingSum(uint256 beforeSum, uint256 afterSum);
    error SumAfterZero();
    error NoChunkProgress();
    error ResidualQuantity(uint256 remaining);
    error AffectedSumZero();
    error ChunkLimitExceeded(uint256 required, uint256 maxAllowed);
    error QuantityOverflow();
    error ProceedsBelowMinimum(uint256 proceeds, uint256 minProceeds);
    error BatchClaimTooLarge(uint256 provided, uint256 maxAllowed);

    // ============================================================
    // Tree
    // ============================================================
    error TreeNotInitialized();
    error TreeSizeZero();
    error TreeSizeTooLarge();
    error TreeAlreadyInitialized();
    error LazyFactorOverflow();
    error ArrayLengthMismatch();
    error InvalidFactor(uint256 factor);
    error IndexOutOfBounds(uint32 index, uint32 size);
    error InvalidRange(uint32 lo, uint32 hi);

    // ============================================================
    // Exposure Ledger
    // ============================================================
    error ExposureDiffInvalidRange(int256 start, int256 end);
    error ExposureDiffBinOutOfBounds(int256 bin, uint32 numBins);
    error ExposureDiffNegativeExposure(int256 bin, int256 exposure);
}
