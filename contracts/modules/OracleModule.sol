// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCoreStorage.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";
import "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";

/// @title OracleModule
/// @notice Delegate-only oracle module with Redstone signed-pull oracle
/// @dev Implements:
///      - Redstone signed-pull oracle verification
///      - Closest-sample selection: |priceTimestamp - Tset| minimum, tie-break to past
///      - Δmax validation: reject samples too far from Tset
///      - δfuture validation: reject future-dated samples
contract OracleModule is IcicleOptionsCoreStorage, PrimaryProdDataServiceConsumerBase {
    address private immutable self;

    modifier onlyDelegated() {
        if (address(this) == self) revert SE.NotDelegated();
        _;
    }

    constructor() {
        self = address(this);
    }

    // ============================================================
    // Events
    // ============================================================

    event SettlementPriceSubmitted(
        uint256 indexed marketId,
        int256 settlementValue,
        uint64 priceTimestamp,
        address indexed submitter
    );

    event SettlementCandidateUpdated(
        uint256 indexed marketId,
        int256 settlementValue,
        int256 settlementTick,
        uint64 priceTimestamp,
        uint64 distance
    );

    event TradeOracleRefreshed(uint256 indexed marketId, int256 tick, uint64 priceTimestamp);

    /// @notice Refresh the cached oracle tick used to price dynamic-market trades.
    /// @dev Redstone signed-pull (payload appended to calldata). Permissionless/keeper.
    ///      Reuses the same staleness/future guards as settlement (maxSampleDistance,
    ///      futureTolerance). Only valid for dynamicEnabled markets.
    function refreshTradeOracle(uint256 marketId) external onlyDelegated {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(market.numBins != 0, SE.MarketNotFound(marketId));
        require(market.dynamicEnabled, SE.MarketNotDynamic(marketId));
        require(!market.settled, SE.MarketAlreadySettled(marketId));

        uint256 price = getOracleNumericValueFromTxMsg(redstoneFeedId);
        uint256 timestampMs = extractTimestampsAndAssertAllAreEqual();
        uint64 priceTimestamp = uint64(timestampMs / 1000);
        uint64 nowTs = uint64(block.timestamp);

        // not-in-future
        require(priceTimestamp <= nowTs + futureTolerance, SE.OracleSampleInFuture(priceTimestamp, nowTs));
        // freshness: maxSampleDistance is enforced > 0 at config, so this is unconditional
        // (no "0 = disabled" path that could leave the cache staleness-unbounded).
        uint64 age = nowTs > priceTimestamp ? nowTs - priceTimestamp : 0;
        require(age <= maxSampleDistance, SE.OracleSampleTooFarFromTset(age, maxSampleDistance));

        int256 settlementValue = _convertPriceToSettlementValue(price);
        int256 tick = _toSettlementTick(market, settlementValue);
        market.cachedOracleTick = tick;
        market.cachedOracleTs = priceTimestamp;
        emit TradeOracleRefreshed(marketId, tick, priceTimestamp);
    }

    event OracleConfigUpdated(
        bytes32 feedId,
        uint8 feedDecimals,
        uint64 maxSampleDistance,
        uint64 futureTolerance
    );

    // ============================================================
    // Configuration
    // ============================================================

    /// @notice Set Redstone oracle configuration
    /// @param feedId Redstone data feed ID (e.g., bytes32("BTC"))
    /// @param feedDecimals Decimals of the feed price (e.g., 8 for BTC/USD)
    /// @param _maxSampleDistance Δmax: maximum |priceTimestamp - Tset|
    /// @param _futureTolerance δfuture: maximum priceTimestamp - block.timestamp
    function setRedstoneConfig(
        bytes32 feedId,
        uint8 feedDecimals,
        uint64 _maxSampleDistance,
        uint64 _futureTolerance
    ) external onlyDelegated {
        // Never 0: that disables the trade-freshness gate and re-opens stale-oracle adverse selection.
        if (_maxSampleDistance == 0) revert SE.InvalidMaxSampleDistance(_maxSampleDistance);
        redstoneFeedId = feedId;
        redstoneFeedDecimals = feedDecimals;
        maxSampleDistance = _maxSampleDistance;
        futureTolerance = _futureTolerance;
        emit OracleConfigUpdated(feedId, feedDecimals, _maxSampleDistance, _futureTolerance);
    }

    // ============================================================
    // Settlement Submission (Redstone Signed-Pull)
    // ============================================================

    /// @notice Submit settlement sample with Redstone signed-pull oracle
    /// @dev Permissionless during SettlementOpen window. Price/timestamp extracted from
    ///      Redstone payload in calldata. Signatures verified on-chain.
    ///      Closest-sample selection: |priceTimestamp - Tset| minimum, tie-break to past
    /// @param marketId Market to submit settlement for
    function submitSettlementSample(
        uint256 marketId
    ) external onlyDelegated {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(market.numBins != 0, SE.MarketNotFound(marketId));
        require(!market.settled, SE.MarketAlreadySettled(marketId));
        require(!market.failed, SE.MarketAlreadyFailed(marketId));

        uint64 tSet = market.settlementTimestamp;
        uint64 nowTs = uint64(block.timestamp);

        // SettlementOpen = [Tset, Tset + Δsettle)
        require(nowTs >= tSet, SE.OracleSampleTooEarly(tSet, nowTs));
        require(nowTs < tSet + settlementSubmitWindow, SE.SettlementWindowClosed());

        // Extract price and timestamp from Redstone payload in calldata
        // PrimaryProdDataServiceConsumerBase validates signatures and unique signer threshold
        uint256 price = getOracleNumericValueFromTxMsg(redstoneFeedId);
        uint256 timestampMs = extractTimestampsAndAssertAllAreEqual();
        uint64 priceTimestamp = uint64(timestampMs / 1000);

        // δfuture check: reject future-dated samples
        require(priceTimestamp <= nowTs + futureTolerance, SE.OracleSampleInFuture(priceTimestamp, nowTs));

        // Δmax check: |priceTimestamp - Tset| ≤ maxSampleDistance
        uint64 distance = priceTimestamp >= tSet
            ? priceTimestamp - tSet
            : tSet - priceTimestamp;
        // maxSampleDistance is enforced > 0 at config -> unconditional (no disabled path).
        require(distance <= maxSampleDistance, SE.OracleSampleTooFarFromTset(distance, maxSampleDistance));

        // Convert price to settlementValue (scale from feedDecimals to 6 decimals)
        int256 settlementValue = _convertPriceToSettlementValue(price);

        // Closest-sample selection: prefer sample closest to Tset
        _updateCandidate(marketId, settlementValue, priceTimestamp, tSet);

        emit SettlementPriceSubmitted(marketId, settlementValue, priceTimestamp, msg.sender);
    }


    // ============================================================
    // Closest-Sample Selection
    // ============================================================

    /// @dev Update candidate using closest-sample rule
    ///      - Replace if |new - Tset| < |existing - Tset|
    ///      - On tie, keep the more past (smaller timestamp)
    function _updateCandidate(
        uint256 marketId,
        int256 settlementValue,
        uint64 priceTimestamp,
        uint64 tSet
    ) internal {
        SettlementOracleState storage state = settlementOracleState[marketId];
        
        uint64 newDistance = priceTimestamp >= tSet
            ? priceTimestamp - tSet
            : tSet - priceTimestamp;

        if (state.candidatePriceTimestamp == 0) {
            // No existing candidate, accept new one
            state.candidateValue = settlementValue;
            state.candidatePriceTimestamp = priceTimestamp;
            
            int256 tick = _toSettlementTick(markets[marketId], settlementValue);
            emit SettlementCandidateUpdated(marketId, settlementValue, tick, priceTimestamp, newDistance);
        } else {
            // Compare distances to Tset (absolute value)
            uint64 existingTs = state.candidatePriceTimestamp;
            uint64 existingDistance = existingTs >= tSet
                ? existingTs - tSet
                : tSet - existingTs;

            // WP v2: Replace only if strictly closer, or same distance and more past
            bool shouldReplace = newDistance < existingDistance ||
                (newDistance == existingDistance && priceTimestamp < existingTs);

            if (shouldReplace) {
                state.candidateValue = settlementValue;
                state.candidatePriceTimestamp = priceTimestamp;
                
                int256 tick = _toSettlementTick(markets[marketId], settlementValue);
                emit SettlementCandidateUpdated(marketId, settlementValue, tick, priceTimestamp, newDistance);
            }
            // If not closer, silently ignore (existing candidate preferred)
        }
    }

    // ============================================================
    // View Functions
    // ============================================================

    /// @notice Returns the settlement price candidate for a market
    function getSettlementPrice(uint256 marketId)
        external
        view
        onlyDelegated
        returns (int256 price, uint64 priceTimestamp)
    {
        SettlementOracleState storage state = settlementOracleState[marketId];
        require(state.candidatePriceTimestamp != 0, SE.SettlementOracleCandidateMissing());
        price = state.candidateValue;
        priceTimestamp = state.candidatePriceTimestamp;
    }

    /// @notice Get the current market state (derived from timestamps)
    /// @return state 0=Trading, 1=SettlementOpen, 2=PendingOps, 3=FinalizedPrimary, 4=FinalizedSecondary, 5=FailedPendingManual
    function getMarketState(uint256 marketId) external view returns (uint8 state) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(market.numBins != 0, SE.MarketNotFound(marketId));
        
        if (market.settled) {
            return market.failed ? 4 : 3; // FinalizedSecondary or FinalizedPrimary
        }
        if (market.failed) {
            return 5; // FailedPendingManual
        }
        
        uint64 tSet = market.settlementTimestamp;
        uint64 nowTs = uint64(block.timestamp);
        
        if (nowTs < tSet) return 0; // Trading
        if (nowTs < tSet + settlementSubmitWindow) return 1; // SettlementOpen
        if (nowTs < tSet + settlementSubmitWindow + pendingOpsWindow) return 2; // PendingOps
        return 3; // FinalizedPrimary (if not failed and time passed)
    }

    /// @notice Get settlement windows for a market
    function getSettlementWindows(uint256 marketId) external view returns (
        uint64 tSet,
        uint64 settleEnd,
        uint64 opsEnd,
        uint64 claimOpen
    ) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        require(market.numBins != 0, SE.MarketNotFound(marketId));
        
        tSet = market.settlementTimestamp;
        settleEnd = tSet + settlementSubmitWindow;
        opsEnd = settleEnd + pendingOpsWindow;
        claimOpen = tSet + claimDelaySeconds;
    }

    // ============================================================
    // Internal Helpers
    // ============================================================

    /// @dev Convert Redstone price (feedDecimals) to settlementValue (6 decimals)
    function _convertPriceToSettlementValue(uint256 price) internal view returns (int256) {
        if (redstoneFeedDecimals <= 6) {
            // Scale up if feed has fewer decimals
            uint256 scaleFactor = 10 ** uint256(6 - redstoneFeedDecimals);
            uint256 scaled = price * scaleFactor;
            if (scaled > uint256(type(int256).max)) revert SE.PriceOverflow(scaled);
            return int256(scaled);
        } else {
            // Scale down if feed has more decimals
            uint256 scaleDivisor = 10 ** uint256(redstoneFeedDecimals - 6);
            uint256 scaled = price / scaleDivisor;
            if (scaled > uint256(type(int256).max)) revert SE.PriceOverflow(scaled);
            return int256(scaled);
        }
    }

    /// @dev Convert settlement value to tick
    /// settlementTick = settlementValue / 1e6
    /// maxTick is exclusive upper bound, clamp to last valid tick
    function _toSettlementTick(IIcicleOptionsCore.Market storage market, int256 settlementValue) internal view returns (int256) {
        int256 spacing = market.tickSpacing;
        int256 tick = settlementValue / 1_000_000; // Convert 6-decimal value to tick
        
        // Clamp to valid range [minTick, maxTick - tickSpacing]
        // maxTick is exclusive (outcome space is [minTick, maxTick))
        // Last valid tick is maxTick - tickSpacing
        int256 lastValidTick = market.maxTick - spacing;
        if (tick < market.minTick) tick = market.minTick;
        if (tick > lastValidTick) tick = lastValidTick;
        
        // Align to tick spacing
        int256 offset = tick - market.minTick;
        tick = market.minTick + (offset / spacing) * spacing;
        return tick;
    }
}
