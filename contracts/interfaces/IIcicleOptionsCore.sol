// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IIcicleOptionsCore {
    event OperatorUpdated(address indexed operator, bool allowed);
    struct Market {
        // status flags (packable)
        bool isSeeded;
        bool settled;
        bool snapshotChunksDone;
        bool failed; // Oracle failure marked
        uint32 numBins;
        uint32 openPositionCount;
        uint32 snapshotChunkCursor;
        uint32 seedCursor;

        // timing
        uint64 startTimestamp;
        uint64 endTimestamp;
        uint64 settlementTimestamp; // Market day key (PST day boundary)
        uint64 settlementFinalizedAt; // Actual finalization timestamp

        // ticks / math
        int256 minTick;
        int256 maxTick;
        int256 tickSpacing;
        int256 settlementTick;
        int256 settlementValue;
        uint256 liquidityParameter;

        // policy
        address feePolicy;
        address seedData;

        // Fee tracking and P&L calculation
        // Initial root sum for P&L calculation: C_start = α * ln(Z_start)
        uint256 initialRootSum;
        // Gross fees collected from trades, stored in WAD units
        uint256 accumulatedFees;

        // Prior-based ΔEₜ calculation
        // minFactor = min(baseFactors) at market creation (WAD)
        // Used to compute ΔEₜ = α * ln(rootSum / (n * minFactor))
        // Uniform prior: minFactor = 1 WAD → ΔEₜ = 0
        uint256 minFactor;

        // Tail budget (ΔEₜ) calculated at market creation (WAD)
        // ΔEₜ := E_ent(q₀,t) - αₜ ln n
        // Used in batch processing: grantNeed > ΔEₜ → revert
        uint256 deltaEt;

        // ---- v2 dynamic pricing (appended; default 0/false = legacy static) ----
        bool dynamicEnabled;        // true → oracle-anchored, volatility-adaptive prior
        uint32 anchorCenterBin;     // creation-time center bin (used when w < 1)
        uint64 cachedOracleTs;      // timestamp of cachedOracleTick (staleness)
        int256 cachedOracleTick;    // last refreshed oracle tick for trade pricing
        uint128 perBinCap;          // max payout (6-dec qty) per bin; 0 = no cap
        uint256 accumulatedPremiums;// realized cash collected on opens/increases (WAD)
        uint256 accumulatedProceeds;// realized cash paid on decreases/closes (WAD)
        // dynamic prior config (PricingLayer.Config, flattened to avoid lib import here)
        uint256 dynW;               // anchoring weight, WAD [0,1e18]
        uint256 dynVolBinsWad;      // terminal-price std in bins, WAD
        uint256 dynSigmaMinWad;     // min bell width, WAD
        uint256 dynSigmaMaxWad;     // max bell width, WAD
        uint256 dynFloorWad;        // v2: fixed min base factor (WAD). v2.1 (dynVersion>=2): tail-mass budget τ (WAD)

        // ---- v2.1 (appended) ----
        uint8 dynVersion;           // 0 = v2 fixed-floor semantics; 2 = v2.1 tail-mass floor + settlement-horizon σ
        bool tradingHalted;         // price-jump circuit breaker tripped; trades revert until resumed
        uint64 haltedAt;            // timestamp the breaker tripped (auto-resume window reference)
    }

    // v2 dynamic-market creation params (grouped to keep the signature flat)
    struct DynamicParams {
        uint256 w;            // anchoring weight, WAD [0,1e18]
        uint256 volBinsWad;   // terminal-price std in bins, WAD
        uint256 sigmaMinWad;  // min bell width, WAD
        uint256 sigmaMaxWad;  // max bell width, WAD
        uint256 floorWad;     // v2.1: tail-mass budget τ (WAD, [0.1%, 20%]); the per-bin floor is derived from σ_t each trade
        uint128 perBinCap;    // max payout (6-dec qty) per bin; 0 = no cap
        uint32 anchorCenterBin; // creation-time center bin (used when w < 1)
    }

    // Trade / lifecycle entrypoints
    function openPosition(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity,
        uint256 maxCost
    ) external returns (uint256 positionId);

    function increasePosition(
        uint256 positionId,
        uint128 quantity,
        uint256 maxCost
    ) external;

    function decreasePosition(
        uint256 positionId,
        uint128 quantity,
        uint256 minProceeds
    ) external;

    function closePosition(
        uint256 positionId,
        uint256 minProceeds
    ) external;

    function claimPayout(uint256 positionId) external;

    function batchClaimPayout(uint256[] calldata positionIds) external;

    // View helpers for cost/proceeds calculation
    function calculateOpenCost(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) external returns (uint256 cost);

    function calculateIncreaseCost(
        uint256 positionId,
        uint128 quantity
    ) external returns (uint256 cost);

    function calculateDecreaseProceeds(
        uint256 positionId,
        uint128 quantity
    ) external returns (uint256 proceeds);

    function calculateCloseProceeds(uint256 positionId) external returns (uint256 proceeds);

    function calculatePositionValue(uint256 positionId) external returns (uint256 value);

    // Operator allowlist
    function setOperator(address operator, bool allowed) external;
    function operators(address operator) external view returns (bool);

    // Emergency pause
    function pause() external;
    function unpause() external;

    // Lifecycle: settlement snapshot trigger
    function requestSettlementChunks(uint256 marketId, uint32 maxChunksPerTx) external returns (uint32 emitted);

    // Lifecycle / oracle admin
    /// @notice Create a new market with prior-based factors
    /// @param minTick Lower tick bound (inclusive)
    /// @param maxTick Upper tick bound (exclusive)
    /// @param tickSpacing Spacing between ticks
    /// @param startTimestamp When trading starts
    /// @param endTimestamp When trading ends
    /// @param settlementTimestamp When settlement occurs
    /// @param numBins Number of outcome bins
    /// @param liquidityParameter α (alpha) for CLMSR
    /// @param feePolicy Address of fee policy contract
    /// @param seedData Address of SeedData contract holding packed factors (numBins * 32 bytes)
    function createMarket(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp,
        uint32 numBins,
        uint256 liquidityParameter,
        address feePolicy,
        address seedData
    ) external returns (uint256 marketId);

    function finalizePrimarySettlement(uint256 marketId) external;

    function seedNextChunks(uint256 marketId, uint32 count) external;

    function updateMarketTiming(
        uint256 marketId,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp
    ) external;

    /// @notice Submit settlement sample with Redstone signed-pull oracle (permissionless during SettlementOpen)
    function submitSettlementSample(uint256 marketId) external;

    /// @notice Configure Redstone oracle parameters
    function setRedstoneConfig(
        bytes32 feedId,
        uint8 feedDecimals,
        uint64 maxSampleDistance,
        uint64 futureTolerance
    ) external;

    /// @notice Set settlement timeline parameters
    function setSettlementTimeline(
        uint64 sampleWindow,
        uint64 opsWindow,
        uint64 claimDelay
    ) external;

    // Capital stack funding
    function fundBackstop(uint256 amount6) external;
    function withdrawBackstop(uint256 amount6) external;
    function fundTreasury(uint256 amount6) external;
    function withdrawTreasury(uint256 amount6) external;

    /// @notice Get market state (derived from timestamps)
    function getMarketState(uint256 marketId) external returns (uint8 state);

    /// @notice Get settlement windows for a market
    function getSettlementWindows(uint256 marketId) external returns (
        uint64 tSet,
        uint64 settleEnd,
        uint64 opsEnd,
        uint64 claimOpen
    );

    /// @notice Get current batch ID
    function getCurrentBatchId() external view returns (uint64);

    /// @notice Get market counts for a batch (one-to-many)
    function getBatchMarketState(uint64 batchId) external view returns (uint64 total, uint64 resolved);

    /// @notice Mark a market's settlement as failed due to oracle issue
    /// @dev Owner or operator can call during PendingOps window
    function markSettlementFailed(uint256 marketId) external;

    /// @notice Finalize secondary settlement for a failed market
    /// @dev Owner-only on a market marked as failed
    function finalizeSecondarySettlement(
        uint256 marketId,
        int256 settlementValue
    ) external;

    /// @notice Returns the settlement price candidate for a market
    /// @dev This is a simple getter for the most recent candidate, not a historical lookup
    ///      Note: Not view because it uses delegatecall internally
    /// @param marketId The market ID to query
    /// @return price The settlement value
    /// @return priceTimestamp The timestamp when the price was submitted
    function getSettlementPrice(uint256 marketId)
        external
        returns (int256 price, uint64 priceTimestamp);
}
