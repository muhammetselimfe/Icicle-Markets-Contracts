// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCoreStorage.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";
import "../lib/LazyMulSegmentTree.sol";
import "../lib/FixedPointMathU.sol";
import "../lib/ExposureDiffLib.sol";
import "../lib/TickBinLib.sol";
import "../lib/SeedDataLib.sol";

/// @notice Delegate-only lifecycle module (skeleton)
contract MarketLifecycleModule is IcicleOptionsCoreStorage {
    using LazyMulSegmentTree for LazyMulSegmentTree.Tree;
    using FixedPointMathU for uint256;

    address private immutable self;

    uint256 internal constant WAD = 1e18;

    event SettlementChunkRequested(uint256 indexed marketId, uint32 indexed chunkIndex);
    event MarketCreated(
        uint256 indexed marketId,
        uint64 startTimestamp,
        uint64 endTimestamp,
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint32 numBins,
        uint256 liquidityParameter
    );
    event MarketSeedingProgress(uint256 indexed marketId, uint32 startBin, uint32 count, uint256[] factors);
    event MarketSeeded(uint256 indexed marketId);
    event MarketSettled(
        uint256 indexed marketId,
        int256 settlementValue,
        int256 settlementTick,
        uint64 settlementTimestamp
    );
    /// @dev P&L recorded to daily batch for vault accounting
    event MarketPnlRecorded(
        uint256 indexed marketId,
        uint64 indexed batchId,
        int256 lt,
        uint256 ftot
    );
    event MarketFailed(uint256 indexed marketId, uint64 timestamp);
    event MarketSettledSecondary(
        uint256 indexed marketId,
        int256 settlementValue,
        int256 settlementTick,
        uint64 settlementFinalizedAt
    );
    event MarketTimingUpdated(
        uint256 indexed marketId,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp
    );
    event SettlementTimestampUpdated(uint256 indexed marketId, uint64 settlementTimestamp);
    event MarketFeePolicySet(uint256 indexed marketId, address indexed oldPolicy, address indexed newPolicy);
    event DynamicMarketConfigured(uint256 indexed marketId, uint256 w, uint256 volBinsWad, uint128 perBinCap);

    // Diff array pointQuery is O(n), so limit bins to prevent settlement DoS
    uint32 private constant MAX_BIN_COUNT = 256;
    uint32 public constant CHUNK_SIZE = 512;

    modifier onlyDelegated() {
        if (address(this) == self) revert SE.NotDelegated();
        _;
    }

    constructor() {
        self = address(this);
    }

    // --- External ---

    /// @notice Create a new market with prior-based factors stored in SeedData
    /// @dev Lifecycle validates seedData length, derives rootSum/minFactor/ΔEₜ,
    ///      initializes the tree to uniform, and defers factor application to seedNextChunks.
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
    ) external onlyDelegated returns (uint256 marketId) {
        marketId = _createMarketCore(
            minTick, maxTick, tickSpacing, startTimestamp, endTimestamp,
            settlementTimestamp, numBins, liquidityParameter, feePolicy, seedData
        );
    }

    /// @notice Create a market with v2 oracle-anchored, volatility-adaptive pricing.
    /// @dev Same lifecycle as createMarket plus the dynamic prior config. The oracle
    ///      tick must be refreshed (refreshTradeOracle) before trading is priced.
    function createMarketDynamic(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp,
        uint32 numBins,
        uint256 liquidityParameter,
        address feePolicy,
        address seedData,
        IIcicleOptionsCore.DynamicParams calldata dp
    ) external onlyDelegated returns (uint256 marketId) {
        marketId = _createMarketCore(
            minTick, maxTick, tickSpacing, startTimestamp, endTimestamp,
            settlementTimestamp, numBins, liquidityParameter, feePolicy, seedData
        );
        // Validate dynamic params at creation, not at first trade. An unbounded w
        // underflows centerWad ((WAD - w)) and permanently bricks the market; an inverted
        // sigma range or a sub-MIN_FACTOR floor silently misprices every trade.
        if (dp.w > WAD) revert SE.InvalidDynamicParams();
        if (dp.volBinsWad == 0) revert SE.InvalidDynamicParams();
        if (dp.sigmaMinWad == 0 || dp.sigmaMinWad > dp.sigmaMaxWad) revert SE.InvalidDynamicParams();
        // floorWad must be in [MIN_FACTOR, WAD). == WAD floors every bin to the peak,
        // collapsing the bell to uniform (static-like) pricing and silently defeating the
        // oracle-anchored prior.
        if (dp.floorWad < LazyMulSegmentTree.MIN_FACTOR || dp.floorWad >= WAD) revert SE.InvalidDynamicParams();
        // perBinCap is the ONLY hard ceiling on a dynamic market's settlement payout; 0
        // disables it (_requireExposureWithinCap no-ops), leaving the whole vault exposed.
        // Require a real cap so per-market loss is bounded by construction.
        if (dp.perBinCap == 0) revert SE.InvalidDynamicParams();
        // Reject (don't silently clamp) an out-of-range anchor bin, consistent with the
        // other params — a typo'd center would otherwise create a mis-centered market.
        if (dp.anchorCenterBin >= numBins) revert SE.InvalidDynamicParams();

        IIcicleOptionsCore.Market storage m = markets[marketId];
        m.dynamicEnabled = true;
        m.anchorCenterBin = dp.anchorCenterBin; // validated < numBins above
        m.dynW = dp.w;
        m.dynVolBinsWad = dp.volBinsWad;
        m.dynSigmaMinWad = dp.sigmaMinWad;
        m.dynSigmaMaxWad = dp.sigmaMaxWad;
        m.dynFloorWad = dp.floorWad;
        m.perBinCap = dp.perBinCap;
        // Seed the anchor tick only as a display/fallback value. cachedOracleTs is left at
        // 0 (NOT startTimestamp): the freshness gate treats ts==0 as "no genuine oracle yet"
        // and blocks trading until the keeper posts a real price via refreshTradeOracle.
        // Seeding a future ts here would read as age==0 ("fresh") and let the first trades
        // price against the stale creation-time anchor — an adverse-selection drain at open.
        m.cachedOracleTick = minTick + int256(uint256(m.anchorCenterBin)) * tickSpacing;
        emit DynamicMarketConfigured(marketId, dp.w, dp.volBinsWad, dp.perBinCap);
    }

    function _createMarketCore(
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
    ) internal returns (uint256 marketId) {
        _validateMarketParams(minTick, maxTick, tickSpacing, startTimestamp, endTimestamp, settlementTimestamp);
        require(numBins != 0, SE.BinCountExceedsLimit(0, MAX_BIN_COUNT));
        require(numBins <= MAX_BIN_COUNT, SE.BinCountExceedsLimit(numBins, MAX_BIN_COUNT));
        uint256 binsRange = uint256((maxTick - minTick) / tickSpacing);
        if (binsRange > type(uint32).max) {
            revert SE.InvalidMarketParameters(minTick, maxTick, tickSpacing);
        }
        uint32 expectedBins = uint32(binsRange);
        require(expectedBins == numBins, SE.InvalidMarketParameters(minTick, maxTick, tickSpacing));
        require(liquidityParameter != 0, SE.InvalidLiquidityParameter());
        require(feePolicy != address(0), SE.ZeroAddress());

        (uint256 rootSum, uint256 minFactor, uint256 deltaEt) = SeedDataLib.computeSeedStats(
            seedData,
            numBins,
            liquidityParameter
        );

        uint64 batchId = _getBatchIdForTimestamp(settlementTimestamp);
        if (batchId <= currentBatchId) revert SE.BatchAlreadyProcessed(batchId);

        marketId = ++nextMarketId;
        
        _registerMarketForBatch(batchId);
        IIcicleOptionsCore.Market storage market = markets[marketId];
        market.isSeeded = false;
        market.settled = false;
        market.snapshotChunksDone = false;
        market.numBins = numBins;
        market.openPositionCount = 0;
        market.snapshotChunkCursor = 0;
        market.seedCursor = 0;
        market.startTimestamp = startTimestamp;
        market.endTimestamp = endTimestamp;
        market.settlementTimestamp = settlementTimestamp;
        market.minTick = minTick;
        market.maxTick = maxTick;
        market.tickSpacing = tickSpacing;
        market.settlementTick = 0;
        market.settlementValue = 0;
        market.liquidityParameter = liquidityParameter;
        market.feePolicy = feePolicy;
        market.seedData = seedData;
        market.minFactor = minFactor;
        market.deltaEt = deltaEt; // Store ΔEₜ for batch processing

        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        tree.init(numBins);

        // Store initial root sum for P&L calculation
        market.initialRootSum = rootSum;

        emit MarketCreated(
            marketId,
            startTimestamp,
            endTimestamp,
            minTick,
            maxTick,
            tickSpacing,
            numBins,
            liquidityParameter
        );
        if (feePolicy != address(0)) {
            emit MarketFeePolicySet(marketId, address(0), feePolicy);
        }
        emit SettlementTimestampUpdated(marketId, settlementTimestamp);
    }

    /// @notice Apply the next seeding chunk from SeedData
    /// @param marketId Market identifier
    /// @param count Number of bins to seed this call
    function seedNextChunks(uint256 marketId, uint32 count) external onlyDelegated {
        require(count != 0, SE.ZeroLimit());

        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(_marketExists(marketId), SE.MarketNotFound(marketId));
        require(!market.isSeeded, SE.SeedAlreadyComplete(marketId));
        require(market.seedData != address(0), SE.ZeroAddress());

        uint32 cursor = market.seedCursor;
        uint32 numBins = market.numBins;
        if (cursor >= numBins) revert SE.SeedAlreadyComplete(marketId);

        uint32 remaining = numBins - cursor;
        if (count > remaining) {
            count = remaining;
        }

        uint256[] memory factors = SeedDataLib.readFactors(market.seedData, cursor, count);
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];

        for (uint32 i = 0; i < count; i++) {
            uint256 factor = factors[i];
            if (factor == 0) revert SE.InvalidFactor(factor);
            uint32 bin = cursor + i;
            tree.applyRangeFactor(bin, bin, factor);
        }

        market.seedCursor = cursor + count;
        emit MarketSeedingProgress(marketId, cursor, count, factors);

        if (market.seedCursor >= numBins) {
            market.isSeeded = true;
            emit MarketSeeded(marketId);
        }
    }

    // ============================================================
    // Settlement State Machine
    // ============================================================
    // Timeline:
    //   Trading:        t < Tset
    //   SettlementOpen: Tset ≤ t < Tset + Δsettle (sample submission)
    //   PendingOps:     Tset + Δsettle ≤ t < Tset + Δsettle + Δops (ops can mark failed or finalize)
    //   After PendingOps: finalizePrimary still allowed; markFailed only if no candidate
    // ============================================================

    /**
     * @notice Finalize primary settlement after PendingOps window ends
     * @dev Called after Tset + Δsettle + Δops. Uses the closest-sample candidate 
     *      from SettlementOpen window.
     * @param marketId Market to finalize
     */
    function finalizePrimarySettlement(uint256 marketId) external onlyDelegated {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(_marketExists(marketId), SE.MarketNotFound(marketId));
        require(!market.settled, SE.MarketAlreadySettled(marketId));
        require(!market.failed, SE.MarketAlreadyFailed(marketId));

        SettlementOracleState storage state = settlementOracleState[marketId];
        require(state.candidatePriceTimestamp != 0, SE.SettlementOracleCandidateMissing());

        uint64 tSet = market.settlementTimestamp;
        uint64 nowTs = uint64(block.timestamp);
        
        // Can only finalize once PendingOps starts (Tset + Δsettle)
        uint64 opsStart = tSet + settlementSubmitWindow;
        require(nowTs >= opsStart, SE.PendingOpsNotStarted());

        int256 settlementTick = _toSettlementTick(market.minTick, market.maxTick, market.tickSpacing, state.candidateValue);

        market.settled = true;
        market.settlementValue = state.candidateValue;
        market.settlementTick = settlementTick;
        // settlementTimestamp stays as-is (market day key set at creation)
        // settlementFinalizedAt records when settlement tx was mined
        market.settlementFinalizedAt = nowTs;
        market.snapshotChunkCursor = 0;
        market.snapshotChunksDone = (market.openPositionCount == 0);

        // clear oracle candidate after use
        state.candidateValue = 0;
        state.candidatePriceTimestamp = 0;

        // Calculate P&L with payout reserve
        uint64 batchId = _getBatchIdForMarket(marketId);
        (int256 lt, uint256 ftot, uint256 payoutReserve) = _calculateMarketPnlWithPayout(marketId, settlementTick);
        
        // Store payout reserve in escrow
        _payoutReserve[marketId] = payoutReserve;
        _payoutReserveRemaining[marketId] = payoutReserve;
        
        // Track total payout reserve for free balance calculation
        _totalPayoutReserve6 += payoutReserve;
        
        _recordPnlToBatch(batchId, lt, ftot, market.deltaEt);
        _markMarketResolved(marketId, batchId);
        
        emit MarketPnlRecorded(marketId, batchId, lt, ftot);
        emit MarketSettled(marketId, market.settlementValue, settlementTick, market.settlementFinalizedAt);
    }

    /**
     * @notice Mark a market's settlement as failed (operations only during PendingOps)
     * @dev Operations can mark failed during PendingOps:
     *      - Can be called even if candidate exists (divergence scenario)
     *      - Callable during: [Tset + Δsettle, Tset + Δsettle + Δops)
     *      - After PendingOps, if no markSettlementFailed → finalize via finalizePrimarySettlement
     * @param marketId Market to mark as failed
     */
    function markSettlementFailed(uint256 marketId) external onlyDelegated {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(_marketExists(marketId), SE.MarketNotFound(marketId));
        require(!market.settled, SE.MarketAlreadySettled(marketId));
        require(!market.failed, SE.MarketAlreadyFailed(marketId));

        uint64 tSet = market.settlementTimestamp;
        uint64 nowTs = uint64(block.timestamp);
        
        // markFailed during PendingOps [Tset + Δsettle, Tset + Δsettle + Δops)
        uint64 opsStart = tSet + settlementSubmitWindow;
        uint64 opsEnd = opsStart + pendingOpsWindow;
        
        // Also allow after opsEnd if no candidate (oracle sample absence case)
        SettlementOracleState storage state = settlementOracleState[marketId];
        bool hasCandidate = state.candidatePriceTimestamp != 0;
        
        // Before PendingOps - not allowed
        require(nowTs >= opsStart, SE.PendingOpsNotStarted());
        
        // After PendingOps with candidate: should use settleMarket instead
        require(nowTs < opsEnd || !hasCandidate, SE.SettlementOracleCandidateMissing());
        
        // Clear any candidate (WP v2: divergence case discards candidate)
        state.candidateValue = 0;
        state.candidatePriceTimestamp = 0;

        market.failed = true;

        emit MarketFailed(marketId, nowTs);
    }

    /**
     * @notice Finalize secondary settlement for a failed market
     * @dev Operations provides settlement value for failed markets.
     *      Can only be called on a market marked as failed.
     *      Settlement value comes from pre-announced secondary rule (off-chain).
     * @param marketId Market to settle
     * @param settlementValue The settlement value (ops-determined)
     */
    function finalizeSecondarySettlement(
        uint256 marketId,
        int256 settlementValue
    ) external onlyDelegated {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(_marketExists(marketId), SE.MarketNotFound(marketId));
        require(!market.settled, SE.MarketAlreadySettled(marketId));
        require(market.failed, SE.MarketNotFailed(marketId));

        int256 settlementTick = _toSettlementTick(market.minTick, market.maxTick, market.tickSpacing, settlementValue);

        market.settled = true;
        market.settlementValue = settlementValue;
        market.settlementTick = settlementTick;
        // WP v2: Keep original settlementTimestamp as market day key
        // (DO NOT change to endTimestamp - that breaks batch association)
        market.settlementFinalizedAt = uint64(block.timestamp);
        market.snapshotChunkCursor = 0;
        market.snapshotChunksDone = (market.openPositionCount == 0);

        // Calculate P&L with payout reserve
        uint64 batchId = _getBatchIdForMarket(marketId);
        (int256 lt, uint256 ftot, uint256 payoutReserve) = _calculateMarketPnlWithPayout(marketId, settlementTick);
        
        // Store payout reserve in escrow
        _payoutReserve[marketId] = payoutReserve;
        _payoutReserveRemaining[marketId] = payoutReserve;
        
        // Track total payout reserve for free balance calculation
        _totalPayoutReserve6 += payoutReserve;
        
        _recordPnlToBatch(batchId, lt, ftot, market.deltaEt);
        emit MarketPnlRecorded(marketId, batchId, lt, ftot);

        _markMarketResolved(marketId, batchId);
        market.failed = false;
        emit MarketSettledSecondary(marketId, settlementValue, settlementTick, market.settlementFinalizedAt);
    }

    function updateMarketTiming(
        uint256 marketId,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp
    ) external onlyDelegated {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(_marketExists(marketId), SE.MarketNotFound(marketId));
        require(!market.settled, SE.MarketAlreadySettled(marketId));
        _validateTimeRange(startTimestamp, endTimestamp, settlementTimestamp);

        uint64 oldSettlementTimestamp = market.settlementTimestamp;
        uint64 newBatchId = _getBatchIdForTimestamp(settlementTimestamp);
        if (newBatchId <= currentBatchId) revert SE.BatchAlreadyProcessed(newBatchId);

        if (oldSettlementTimestamp == 0) {
            _registerMarketForBatch(newBatchId);
            if (_marketBatchResolved[marketId]) {
                _batchMarketState[newBatchId].resolved += 1;
            }
        } else {
            uint64 oldBatchId = _getBatchIdForTimestamp(oldSettlementTimestamp);
            if (oldBatchId != newBatchId) {
                _deregisterMarketForBatch(oldBatchId);
                _registerMarketForBatch(newBatchId);
                if (_marketBatchResolved[marketId]) {
                    _batchMarketState[oldBatchId].resolved -= 1;
                    _batchMarketState[newBatchId].resolved += 1;
                }
            }
        }

        market.startTimestamp = startTimestamp;
        market.endTimestamp = endTimestamp;
        market.settlementTimestamp = settlementTimestamp;

        emit MarketTimingUpdated(marketId, startTimestamp, endTimestamp, settlementTimestamp);
        emit SettlementTimestampUpdated(marketId, settlementTimestamp);
    }

    function requestSettlementChunks(uint256 marketId, uint32 maxChunksPerTx) external onlyDelegated returns (uint32 emitted) {
        require(maxChunksPerTx != 0, SE.ZeroLimit());
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(_marketExists(marketId), SE.MarketNotFound(marketId));
        require(market.settled, SE.MarketNotSettled(marketId));
        require(!market.snapshotChunksDone, SE.SnapshotAlreadyCompleted());

        uint32 totalChunks = _calculateTotalChunks(market.openPositionCount);
        uint32 cursor = market.snapshotChunkCursor;
        if (totalChunks == 0) {
            market.snapshotChunksDone = true;
            return 0;
        }

        while (cursor < totalChunks && emitted < maxChunksPerTx) {
            emit SettlementChunkRequested(marketId, cursor);
            cursor++;
            emitted++;
        }

        market.snapshotChunkCursor = cursor;
        if (cursor >= totalChunks) {
            market.snapshotChunksDone = true;
        }
    }

    // --- Internal helpers ---

    function _validateMarketParams(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp
    ) internal pure {
        require(tickSpacing > 0, SE.InvalidMarketParameters(minTick, maxTick, tickSpacing));
        require(minTick < maxTick, SE.InvalidMarketParameters(minTick, maxTick, tickSpacing));
        require(maxTick <= type(int256).max - tickSpacing, SE.InvalidMarketParameters(minTick, maxTick, tickSpacing));
        require((maxTick - minTick) % tickSpacing == 0, SE.InvalidMarketParameters(minTick, maxTick, tickSpacing));
        _validateTimeRange(startTimestamp, endTimestamp, settlementTimestamp);
    }

    function _validateTimeRange(uint64 startTimestamp, uint64 endTimestamp, uint64 settlementTimestamp) internal pure {
        require(startTimestamp < endTimestamp && endTimestamp <= settlementTimestamp, SE.InvalidTimeRange(startTimestamp, endTimestamp, settlementTimestamp));
    }

    function _marketExists(uint256 marketId) internal view returns (bool) {
        return markets[marketId].numBins > 0;
    }

    /// @dev Convert settlement value to tick
    /// settlementTick = settlementValue / 1e6
    /// maxTick is exclusive upper bound, clamp to last valid tick
    function _toSettlementTick(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        int256 settlementValue
    ) internal pure returns (int256) {
        int256 spacing = tickSpacing;
        int256 tick = settlementValue / 1_000_000; // Convert 6-decimal value to tick
        
        // Clamp to valid range [minTick, maxTick - tickSpacing]
        // maxTick is exclusive (outcome space is [minTick, maxTick))
        // Last valid tick is maxTick - tickSpacing
        int256 lastValidTick = maxTick - spacing;
        if (tick < minTick) tick = minTick;
        if (tick > lastValidTick) tick = lastValidTick;
        
        // Align to tick spacing
        int256 offset = tick - minTick;
        tick = minTick + (offset / spacing) * spacing;
        return tick;
    }

    /// @dev Get payout exposure at a specific tick using diff-array point query
    /// @param marketId Market identifier
    /// @param minTick Market minimum tick
    /// @param tickSpacing Market tick spacing
    /// @param numBins Market bin count
    /// @param tick Settlement tick (must be aligned to tickSpacing)
    /// @return exposure Total payout owed if settlement tick is `tick`
    function _getExposureAtTick(
        uint256 marketId,
        int256 minTick,
        int256 tickSpacing,
        uint32 numBins,
        int256 tick
    ) internal view returns (uint256 exposure) {
        uint32 bin = TickBinLib.tickToBin(minTick, tickSpacing, numBins, tick);
        return ExposureDiffLib.pointQuery(_exposureDiff[marketId], bin);
    }

    function _calculateTotalChunks(uint32 openPositionCount) internal pure returns (uint32) {
        if (openPositionCount == 0) return 0;
        return (openPositionCount + CHUNK_SIZE - 1) / CHUNK_SIZE;
    }

    // ============================================================
    // P&L Recording
    // ============================================================

    /**
     * @notice Get batch ID for a market (based on settlement date)
     * @dev Uses market's settlement timestamp truncated to PST day
     * @param marketId Market identifier
     * @return batchId Batch identifier (day-based)
     */
    function _getBatchIdForMarket(uint256 marketId) internal view returns (uint64) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        // Use settlement timestamp divided by day (PST day boundary)
        // This groups all markets settling on the same PST day into one batch (day-key)
        return _toBatchId(market.settlementTimestamp);
    }

    function _getBatchIdForTimestamp(uint64 settlementTimestamp) internal view returns (uint64) {
        return _toBatchId(settlementTimestamp);
    }

    /**
     * @notice Calculate market P&L from CLMSR tree state
     * @dev L_t = C(q_end) - C(q_start) = α * (ln(Z_end) - ln(Z_start))
     *      Where:
     *      - Z_start = initialRootSum (stored at market creation)
     *      - Z_end = current tree root sum
     *      - α = liquidityParameter
     *
     *      P&L interpretation:
     *      - Positive: maker loss (Z_end > Z_start, traders net profitable)
     *      - Negative: maker profit (Z_end < Z_start, traders net losing)
     *
     * @param marketId Market identifier
     * @return lt Maker P&L (signed: positive = loss, negative = profit)
     * @return ftot Gross fees collected during trading
     */
    function _calculateMarketPnl(uint256 marketId) internal view returns (int256 lt, uint256 ftot) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        
        uint256 alpha = market.liquidityParameter;
        uint256 zStart = market.initialRootSum;
        
        // Get current root sum (Z_end) via totalSum() for O(1) access
        uint256 zEnd = tree.totalSum();
        
        // P&L = α * (ln(Z_end) - ln(Z_start))
        // L_t = C(q_end) - C(q_start), where C(q) = α * ln(Z(q))
        // L_t > 0: cost increased → maker profit (traders net bought)
        // L_t < 0: cost decreased → maker loss (traders net sold)
        uint256 lnZEnd = zEnd.wLn();
        uint256 lnZStart = zStart.wLn();
        
        if (lnZEnd >= lnZStart) {
            // Maker profit: Z increased (cost increased, traders net bought)
            lt = int256(alpha.wMul(lnZEnd - lnZStart));
        } else {
            // Maker loss: Z decreased (cost decreased, traders net sold)
            lt = -int256(alpha.wMul(lnZStart - lnZEnd));
        }
        
        ftot = market.accumulatedFees;
    }

    /**
     * @notice Calculate market P&L with payout reserve deduction
     * @dev Payout_t := Q_{t,τ_t} (settlement tick exposure)
     *      L_t := ΔC_t - Payout_t (maker P&L net of payout)
     *
     * @param marketId Market identifier
     * @param settlementTick The settlement tick τ_t
     * @return lt Maker P&L after payout deduction
     * @return ftot Gross fees collected during trading
     * @return payoutReserve Payout reserve Q_{τ_t} to be escrowed
     */
    function _calculateMarketPnlWithPayout(
        uint256 marketId,
        int256 settlementTick
    ) internal view returns (int256 lt, uint256 ftot, uint256 payoutReserve) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        
        int256 deltaC;
        if (market.dynamicEnabled) {
            // CRITICAL: under a dynamic base, per-trade costs use the effective Zeff
            // (base bell x trade factors) and do NOT telescope to α*ln(Z_end/Z_start).
            // Use realized cash flows instead (premiums collected - proceeds paid).
            deltaC = int256(market.accumulatedPremiums) - int256(market.accumulatedProceeds);
        } else {
            // Legacy STATIC markets: telescoping holds, derive from the tree root.
            uint256 alpha = market.liquidityParameter;
            uint256 zStart = market.initialRootSum;
            uint256 zEnd = tree.totalSum();
            uint256 lnZEnd = zEnd.wLn();
            uint256 lnZStart = zStart.wLn();
            if (lnZEnd >= lnZStart) {
                deltaC = int256(alpha.wMul(lnZEnd - lnZStart));
            } else {
                deltaC = -int256(alpha.wMul(lnZStart - lnZEnd));
            }
        }

        // Payout_t := Q_{t,τ_t} (WP v2 Eq. 3.11)
        // Get payout exposure at settlement tick using diff-array point query
        payoutReserve = _getExposureAtTick(marketId, market.minTick, market.tickSpacing, market.numBins, settlementTick);
        
        // L_t := ΔC_t - Payout_t (WP v2 Eq. 3.12)
        // Note: payoutReserve is in token units (6 decimals), need to convert to WAD for consistency
        // However, positions use quantity in token units, so payout is also in token units
        // For internal accounting consistency, we keep payoutReserve in token units
        // but L_t must be in WAD, so convert payoutReserve to WAD for subtraction
        uint256 payoutReserveWad = payoutReserve * 1e12; // 6-decimal payment token to WAD (1e6 → 1e18)
        
        lt = deltaC - int256(payoutReserveWad);
        
        ftot = market.accumulatedFees;
    }

    /**
     * @notice Record P&L and ΔEₜ to daily batch
     * @dev When multiple markets settle in the same batch, their ΔEₜ values are summed.
     *      The batch's total ΔEₜ acts as the grant cap in FeeWaterfallLib.
     *      Performs early check: if batchDeltaEt > backstopNav, batch will fail.
     *      Note: backstopNav may change between settle and batch processing.
     * @param batchId Batch identifier
     * @param lt P&L to add
     * @param ftot Fees to add
     * @param deltaEt Market's tail budget to add to batch sum
     */
    function _recordPnlToBatch(uint64 batchId, int256 lt, uint256 ftot, uint256 deltaEt) internal {
        DailyPnlSnapshot storage snap = _dailyPnl[batchId];
        require(!snap.processed, SE.BatchAlreadyProcessed(batchId));
        snap.Lt += lt;
        snap.Ftot += ftot;
        snap.DeltaEtSum += deltaEt;
        
        // Early check: if total ΔEₜ exceeds backstopNav, batch will fail
        require(snap.DeltaEtSum <= capitalStack.backstopNav, SE.BatchDeltaEtExceedsBackstop(snap.DeltaEtSum, capitalStack.backstopNav));
    }

    function _registerMarketForBatch(uint64 batchId) internal {
        _batchMarketState[batchId].total += 1;
    }

    function _deregisterMarketForBatch(uint64 batchId) internal {
        _batchMarketState[batchId].total -= 1;
    }

    function _markMarketResolved(uint256 marketId, uint64 batchId) internal {
        if (_marketBatchResolved[marketId]) return;
        _marketBatchResolved[marketId] = true;
        _batchMarketState[batchId].resolved += 1;
    }

    function _unmarkMarketResolved(uint256 marketId, uint64 batchId) internal {
        if (!_marketBatchResolved[marketId]) return;
        _marketBatchResolved[marketId] = false;
        _batchMarketState[batchId].resolved -= 1;
    }

}
