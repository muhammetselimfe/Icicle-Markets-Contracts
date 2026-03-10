// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCoreStorage.sol";
import "../interfaces/IIcicleOptionsCore.sol";
import "../interfaces/IFeePolicy.sol";
import "../interfaces/IIcicleOptionsPosition.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";
import "../lib/ClmsrMath.sol";
import "../lib/LazyMulSegmentTree.sol";
import "../lib/FixedPointMathU.sol";
import "../lib/ExposureDiffLib.sol";
import "../lib/TickBinLib.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Delegate-only trade module
contract TradeModule is IcicleOptionsCoreStorage {
    address private immutable self;
    
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_CHUNKS_PER_TX = 100;
    uint256 internal constant MAX_BATCH_CLAIM = 100;

    event PositionOpened(
        uint256 indexed positionId,
        address indexed trader,
        uint256 indexed marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity,
        uint256 cost
    );

    event PositionIncreased(
        uint256 indexed positionId,
        address indexed trader,
        uint128 deltaQuantity,
        uint128 newQuantity,
        uint256 cost
    );

    event PositionDecreased(
        uint256 indexed positionId,
        address indexed trader,
        uint128 deltaQuantity,
        uint128 newQuantity,
        uint256 proceeds
    );

    event PositionClosed(uint256 indexed positionId, address indexed trader, uint256 proceeds);
    event PositionClaimed(uint256 indexed positionId, address indexed trader, uint256 payout);
    event PositionSettled(uint256 indexed positionId, address indexed trader, uint256 payout, bool isWin);

    event TradeFeeCharged(
        address indexed trader,
        uint256 indexed marketId,
        uint256 indexed positionId,
        bool isBuy,
        uint256 baseAmount,
        uint256 feeAmount,
        address policy
    );

    event RangeFactorApplied(
        uint256 indexed marketId,
        int256 indexed lo,
        int256 indexed hi,
        uint256 factor
    );

    using ClmsrMath for LazyMulSegmentTree.Tree;
    using LazyMulSegmentTree for LazyMulSegmentTree.Tree;
    using FixedPointMathU for uint256;
    using SafeERC20 for IERC20;

    modifier onlyDelegated() {
        if (address(this) == self) revert SE.NotDelegated();
        _;
    }

    constructor() {
        self = address(this);
    }

    // --- External stubs ---
    /// @notice Open a new position (execute-first model for exact cost calculation)
    /// @dev Applies factor first, then computes exact cost from actual sum change
    function openPosition(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity,
        uint256 maxCost
    ) external onlyDelegated returns (uint256 positionId) {
        require(quantity != 0, SE.InvalidQuantity(quantity));
        IIcicleOptionsCore.Market storage market = _loadAndValidateMarket(marketId);
        address feePolicy = market.feePolicy;
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );

        uint256 qtyWad = uint256(quantity).toWad();
        
        // Execute-first: apply factor and get actual sum change
        (uint256 sumBefore, uint256 sumAfter) = _applyFactorChunkedByBins(
            marketId, loBin, hiBin, lowerTick, upperTick, qtyWad, true
        );
        
        // Compute exact cost from actual sum change (no view/execute mismatch)
        uint256 costWad = ClmsrMath.computeBuyCostFromSumChange(
            market.liquidityParameter, sumBefore, sumAfter
        );
        uint256 cost6 = _roundDebit(costWad);

        uint256 fee6 = _quoteFeeWithPolicy(feePolicy, true, msg.sender, marketId, lowerTick, upperTick, quantity, cost6);
        uint256 totalCost = cost6 + fee6;
        require(totalCost <= maxCost, SE.CostExceedsMaximum(totalCost, maxCost));

        // Payment after state change (atomic transaction ensures rollback on failure)
        _pullPayment(msg.sender, totalCost);

        market.accumulatedFees += fee6.toWad();
        _addExposureByBins(marketId, loBin, hiBin, quantity, market.numBins);

        positionId = positionContract.mintPosition(msg.sender, marketId, lowerTick, upperTick, quantity);
        if (!market.settled) {
            market.openPositionCount += 1;
        }

        emit PositionOpened(positionId, msg.sender, marketId, lowerTick, upperTick, quantity, cost6);
        emit TradeFeeCharged(msg.sender, marketId, positionId, true, cost6, fee6, feePolicy);
    }

    /// @notice Increase an existing position (execute-first model for exact cost calculation)
    function increasePosition(
        uint256 positionId,
        uint128 quantity,
        uint256 maxCost
    ) external onlyDelegated {
        require(quantity != 0, SE.InvalidQuantity(quantity));
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        require(positionContract.ownerOf(positionId) == msg.sender, SE.UnauthorizedCaller(msg.sender));

        IIcicleOptionsCore.Market storage market = _loadAndValidateMarket(position.marketId);
        address feePolicy = market.feePolicy;
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            position.lowerTick, position.upperTick
        );

        uint256 qtyWad = uint256(quantity).toWad();
        
        // Execute-first: apply factor and get actual sum change
        (uint256 sumBefore, uint256 sumAfter) = _applyFactorChunkedByBins(
            position.marketId, loBin, hiBin, position.lowerTick, position.upperTick, qtyWad, true
        );
        
        // Compute exact cost from actual sum change
        uint256 costWad = ClmsrMath.computeBuyCostFromSumChange(
            market.liquidityParameter, sumBefore, sumAfter
        );
        uint256 cost6 = _roundDebit(costWad);

        uint256 fee6 = _quoteFeeWithPolicy(feePolicy, true, msg.sender, position.marketId, position.lowerTick, position.upperTick, quantity, cost6);
        uint256 totalCost = cost6 + fee6;
        require(totalCost <= maxCost, SE.CostExceedsMaximum(totalCost, maxCost));

        _pullPayment(msg.sender, totalCost);

        market.accumulatedFees += fee6.toWad();
        _addExposureByBins(position.marketId, loBin, hiBin, quantity, market.numBins);

        uint128 newQuantity = position.quantity + quantity;
        positionContract.updateQuantity(positionId, newQuantity);

        emit PositionIncreased(positionId, msg.sender, quantity, newQuantity, cost6);
        emit TradeFeeCharged(msg.sender, position.marketId, positionId, true, cost6, fee6, feePolicy);
    }

    function decreasePosition(
        uint256 positionId,
        uint128 quantity,
        uint256 minProceeds
    ) external onlyDelegated {
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        (uint128 newQuantity, uint256 baseProceeds, uint256 fee6, address feePolicy) = _decreasePositionInternal(
            position,
            positionId,
            quantity,
            minProceeds
        );
        emit PositionDecreased(positionId, msg.sender, quantity, newQuantity, baseProceeds);
        emit TradeFeeCharged(msg.sender, position.marketId, positionId, false, baseProceeds, fee6, feePolicy);
    }

    function closePosition(
        uint256 positionId,
        uint256 minProceeds
    ) external onlyDelegated {
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        (uint128 newQty, uint256 baseProceeds, uint256 fee6, address feePolicy) = _decreasePositionInternal(
            position,
            positionId,
            position.quantity,
            minProceeds
        );
        require(newQty == 0, SE.CloseInconsistent(0, newQty));
        emit PositionClosed(positionId, msg.sender, baseProceeds);
        emit TradeFeeCharged(msg.sender, position.marketId, positionId, false, baseProceeds, fee6, feePolicy);
    }

    /**
     * @notice Claim payout for a winning position after market settlement
     * @dev Claim is gated by time: settlementTimestamp + Δ_claim
     *      Payout draws from escrow (reserved at settlement finalization).
     *      NAV is unaffected because payout was already reserved at settlement.
     *      Batch processing status is irrelevant to claim eligibility.
     * @param positionId Position ID to claim payout for
     */
    function claimPayout(uint256 positionId) external onlyDelegated {
        uint256 payout = _processClaimPayout(positionId);
        if (payout > 0) _pushPayment(msg.sender, payout);
    }

    /**
     * @notice Batch claim payouts from multiple settled positions
     * @dev Aggregates all payouts into a single ERC20 transfer for gas efficiency.
     *      Allowed even when paused - user funds should always be claimable after settlement.
     * @param positionIds Array of position IDs to claim
     */
    function batchClaimPayout(uint256[] calldata positionIds) external onlyDelegated {
        uint256 len = positionIds.length;
        require(len > 0 && len <= MAX_BATCH_CLAIM, SE.BatchClaimTooLarge(len, MAX_BATCH_CLAIM));

        uint256 totalPayout;
        for (uint256 i; i < len; ) {
            totalPayout += _processClaimPayout(positionIds[i]);
            unchecked { ++i; }
        }
        if (totalPayout > 0) _pushPayment(msg.sender, totalPayout);
    }

    /**
     * @dev Process a single claim: validate, update reserves, burn NFT, emit events.
     *      Does NOT transfer tokens - caller aggregates payouts.
     * @param positionId Position ID to process
     * @return payout Amount owed to caller (6-dec)
     */
    function _processClaimPayout(uint256 positionId) internal returns (uint256 payout) {
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        require(positionContract.ownerOf(positionId) == msg.sender, SE.UnauthorizedCaller(msg.sender));

        IIcicleOptionsCore.Market storage market = markets[position.marketId];
        require(market.settled, SE.MarketNotSettled(position.marketId));

        // Time-based gating: claim allowed after Tset + Δ_claim
        uint64 claimOpen = market.settlementTimestamp + claimDelaySeconds;
        require(block.timestamp >= claimOpen, SE.ClaimTooEarly(claimOpen, uint64(block.timestamp)));

        payout = _calculateClaimAmount(position, market.settlementTick);

        // Draw from payout escrow (reserved at settlement finalization)
        // NAV is unaffected since payout was already reflected in P&L at settlement
        if (payout > 0) {
            uint256 remaining = _payoutReserveRemaining[position.marketId];
            require(payout <= remaining, SE.InsufficientPayoutReserve(payout, remaining));
            _payoutReserveRemaining[position.marketId] = remaining - payout;
            _totalPayoutReserve6 -= payout;
        }

        positionContract.burn(positionId);

        if (!positionSettledEmitted[positionId]) {
            positionSettledEmitted[positionId] = true;
            emit PositionSettled(positionId, msg.sender, payout, payout > 0);
        }

        emit PositionClaimed(positionId, msg.sender, payout);
    }

    // --- View stubs ---

    function calculateOpenCost(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) external view returns (uint256 cost) {
        require(quantity != 0, SE.InvalidQuantity(quantity));
        _loadAndValidateMarket(marketId);
        uint256 costWad = _calculateTradeCost(marketId, lowerTick, upperTick, uint256(quantity).toWad());
        return _roundDebit(costWad);
    }

    function calculateIncreaseCost(
        uint256 positionId,
        uint128 quantity
    ) external view returns (uint256 cost) {
        require(quantity != 0, SE.InvalidQuantity(quantity));
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        _loadAndValidateMarket(position.marketId);
        uint256 costWad = _calculateTradeCost(position.marketId, position.lowerTick, position.upperTick, uint256(quantity).toWad());
        return _roundDebit(costWad);
    }

    function calculateDecreaseProceeds(
        uint256 positionId,
        uint128 quantity
    ) external view returns (uint256 proceeds) {
        require(quantity != 0, SE.InvalidQuantity(quantity));
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        _loadAndValidateMarket(position.marketId);
        uint256 proceedsWad = _calculateSellProceeds(position.marketId, position.lowerTick, position.upperTick, uint256(quantity).toWad());
        return _roundCredit(proceedsWad);
    }

    function calculateCloseProceeds(
        uint256 positionId
    ) external view returns (uint256 proceeds) {
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        _loadAndValidateMarket(position.marketId);
        uint256 proceedsWad = _calculateSellProceeds(position.marketId, position.lowerTick, position.upperTick, uint256(position.quantity).toWad());
        return _roundCredit(proceedsWad);
    }

    function calculatePositionValue(
        uint256 positionId
    ) external view returns (uint256 value) {
        IIcicleOptionsPosition.Position memory position = positionContract.getPosition(positionId);
        uint256 proceedsWad = _calculateSellProceeds(position.marketId, position.lowerTick, position.upperTick, uint256(position.quantity).toWad());
        return _roundCredit(proceedsWad);
    }

    // --- Shared validation helpers ---

    function _marketExists(uint256 marketId) internal view returns (bool) {
        return markets[marketId].numBins > 0;
    }

    /// @dev Loads a market and enforces active/time checks shared across trade entrypoints.
    function _loadAndValidateMarket(uint256 marketId)
        internal
        view
        returns (IIcicleOptionsCore.Market storage market)
    {
        market = markets[marketId];
        require(_marketExists(marketId), SE.MarketNotFound(marketId));
        require(!market.settled, SE.MarketAlreadySettled(marketId));
        require(market.isSeeded, SE.MarketNotSeeded());
        require(block.timestamp >= market.startTimestamp, SE.MarketNotStarted());
        require(block.timestamp <= market.endTimestamp, SE.MarketExpired());
    }

    /// @dev Thin wrapper to calculate buy cost using shared library.
    function _calculateTradeCost(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint256 quantityWad
    ) internal view returns (uint256 costWad) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        costWad = tree.calculateTradeCost(market.liquidityParameter, loBin, hiBin, quantityWad);
    }

    function _calculateSellProceeds(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint256 quantityWad
    ) internal view returns (uint256 proceedsWad) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        proceedsWad = tree.calculateSellProceeds(market.liquidityParameter, loBin, hiBin, quantityWad);
    }

    /// @notice Internal decrease position logic (execute-first model for exact proceeds calculation)
    function _decreasePositionInternal(
        IIcicleOptionsPosition.Position memory position,
        uint256 positionId,
        uint128 quantity,
        uint256 minProceeds
    ) internal returns (uint128 newQuantity, uint256 baseProceeds, uint256 fee6, address feePolicy) {
        require(quantity != 0, SE.InvalidQuantity(quantity));
        require(positionContract.ownerOf(positionId) == msg.sender, SE.UnauthorizedCaller(msg.sender));

        IIcicleOptionsCore.Market storage market = _loadAndValidateMarket(position.marketId);
        require(quantity <= position.quantity, SE.InsufficientPositionQuantity(quantity, position.quantity));
        feePolicy = market.feePolicy;
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            position.lowerTick, position.upperTick
        );

        uint256 qtyWad = uint256(quantity).toWad();
        
        // Execute-first: apply factor and get actual sum change
        (uint256 sumBefore, uint256 sumAfter) = _applyFactorChunkedByBins(
            position.marketId, loBin, hiBin, position.lowerTick, position.upperTick, qtyWad, false
        );
        
        // Compute exact proceeds from actual sum change
        uint256 proceedsWad = ClmsrMath.computeSellProceedsFromSumChange(
            market.liquidityParameter, sumBefore, sumAfter
        );
        baseProceeds = _roundCredit(proceedsWad);

        fee6 = _quoteFeeWithPolicy(
            feePolicy,
            false,
            msg.sender,
            position.marketId,
            position.lowerTick,
            position.upperTick,
            quantity,
            baseProceeds
        );
        uint256 netProceeds = baseProceeds - fee6;
        require(netProceeds >= minProceeds, SE.ProceedsBelowMinimum(netProceeds, minProceeds));

        market.accumulatedFees += fee6.toWad();
        _removeExposureByBins(position.marketId, loBin, hiBin, quantity, market.numBins);

        _pushPayment(msg.sender, netProceeds);

        newQuantity = position.quantity - quantity;
        if (newQuantity == 0) {
            positionContract.burn(positionId);
            if (!market.settled && market.openPositionCount > 0) {
                market.openPositionCount -= 1;
            }
        } else {
            positionContract.updateQuantity(positionId, newQuantity);
        }
    }

    // --- Fee/payment helpers ---

    function _roundDebit(uint256 wadAmount) internal pure returns (uint256) {
        return wadAmount.fromWadRoundUp();
    }

    function _roundCredit(uint256 wadAmount) internal pure returns (uint256) {
        return wadAmount.fromWad();
    }

    function _quoteFeeWithPolicy(
        address policyAddress,
        bool isBuy,
        address trader,
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity,
        uint256 baseAmount
    ) internal view returns (uint256 fee6) {
        if (policyAddress == address(0)) return 0;
        IFeePolicy.QuoteParams memory params = IFeePolicy.QuoteParams({
            trader: trader,
            marketId: marketId,
            lowerTick: lowerTick,
            upperTick: upperTick,
            quantity: quantity,
            baseAmount: baseAmount,
            isBuy: isBuy,
            context: bytes32(0)
        });
        fee6 = IFeePolicy(policyAddress).quoteFee(params);
        require(fee6 <= baseAmount, SE.FeeExceedsBase(fee6, baseAmount));
    }

    function _pullPayment(address from, uint256 amount6) internal {
        if (amount6 == 0) return;
        paymentToken.safeTransferFrom(from, address(this), amount6);
    }

    function _pushPayment(address to, uint256 amount6) internal {
        if (amount6 == 0) return;
        // Verify free balance before payment - protects pending deposits and payout reserves
        _requireFreeBalance(amount6);
        paymentToken.safeTransfer(to, amount6);
    }

    /**
     * @notice Get free balance (total balance minus reserved amounts)
     * @dev Includes _totalPendingWithdrawals6 to protect withdrawal funds
     */
    function _getFreeBalance() internal view returns (uint256) {
        uint256 balance = paymentToken.balanceOf(address(this));
        uint256 reserved = _totalPendingDeposits6 + _totalPayoutReserve6 + _totalPendingWithdrawals6;
        return balance > reserved ? balance - reserved : 0;
    }

    /**
     * @notice Require sufficient free balance for payment
     */
    function _requireFreeBalance(uint256 amount6) internal view {
        uint256 free = _getFreeBalance();
        require(amount6 <= free, SE.InsufficientFreeBalance(amount6, free));
    }

    // --- Tree update helper ---

    /// @dev Apply factor with chunking support for large orders
    /// @notice Uses execute-first model: applies factor and returns sum before/after for exact cost calculation
    /// @param marketId Market identifier
    /// @param lowerTick Lower tick of range
    /// @param upperTick Upper tick of range
    /// @param qtyWad Quantity in WAD
    /// @param isBuy True for buy (factor > 1), false for sell (factor < 1)
    /// @return sumBefore Total sum before any factor application
    /// @return sumAfter Total sum after all factor applications
    function _applyFactorChunked(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint256 qtyWad,
        bool isBuy
    ) internal returns (uint256 sumBefore, uint256 sumAfter) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );
        return _applyFactorChunkedByBins(marketId, loBin, hiBin, lowerTick, upperTick, qtyWad, isBuy);
    }

    function _applyFactorChunkedByBins(
        uint256 marketId,
        uint32 loBin,
        uint32 hiBin,
        int256 lowerTick,
        int256 upperTick,
        uint256 qtyWad,
        bool isBuy
    ) internal returns (uint256 sumBefore, uint256 sumAfter) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        
        uint256 alpha = market.liquidityParameter;
        uint256 maxSafeQty = ClmsrMath.maxSafeChunkQuantity(alpha);
        
        sumBefore = tree.totalSum();
        
        // Apply factor in chunks if quantity exceeds safe limit
        uint256 remaining = qtyWad;
        uint256 chunkCount;
        
        while (remaining > 0 && chunkCount < MAX_CHUNKS_PER_TX) {
            uint256 chunkQty = remaining > maxSafeQty ? maxSafeQty : remaining;
            
            uint256 factor = ClmsrMath._safeExp(chunkQty, alpha);
            if (!isBuy) {
                factor = WAD.wDivUp(factor);
            }
            
            tree.applyRangeFactor(loBin, hiBin, factor);
            emit RangeFactorApplied(marketId, lowerTick, upperTick, factor);
            
            unchecked {
                remaining -= chunkQty;
                chunkCount++;
            }
        }
        
        require(remaining == 0, SE.ResidualQuantity(remaining));
        
        sumAfter = tree.totalSum();
    }


    function _calculateClaimAmount(
        IIcicleOptionsPosition.Position memory position,
        int256 settlementTick
    ) internal pure returns (uint256) {
        bool winning = position.lowerTick <= settlementTick && position.upperTick > settlementTick;
        if (!winning) return 0;
        // Payout is position quantity (6-dec) when in winning range
        return uint256(position.quantity);
    }

    // --- Exposure Ledger helpers (Diff-based) ---

    function _addExposure(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) internal {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );
        ExposureDiffLib.rangeAdd(
            _exposureDiff[marketId],
            loBin,
            hiBin,
            int256(uint256(quantity)),
            market.numBins
        );
    }

    function _addExposureByBins(
        uint256 marketId,
        uint32 loBin,
        uint32 hiBin,
        uint128 quantity,
        uint32 numBins
    ) internal {
        ExposureDiffLib.rangeAdd(
            _exposureDiff[marketId],
            loBin,
            hiBin,
            int256(uint256(quantity)),
            numBins
        );
    }

    function _removeExposure(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) internal {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        (uint32 loBin, uint32 hiBin) = TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );
        ExposureDiffLib.rangeAdd(
            _exposureDiff[marketId],
            loBin,
            hiBin,
            -int256(uint256(quantity)),
            market.numBins
        );
    }

    function _removeExposureByBins(
        uint256 marketId,
        uint32 loBin,
        uint32 hiBin,
        uint128 quantity,
        uint32 numBins
    ) internal {
        ExposureDiffLib.rangeAdd(
            _exposureDiff[marketId],
            loBin,
            hiBin,
            -int256(uint256(quantity)),
            numBins
        );
    }

    /**
     * @notice Get payout exposure at a specific tick (Diff-based)
     * @dev Uses O(n) prefix sum - acceptable since only called once per market at settlement
     * @param marketId Market identifier
     * @param tick Settlement tick (must be aligned to tickSpacing)
     * @return exposure Total payout owed if settlement tick is `tick`
     */
    function _getExposureAtTick(
        uint256 marketId,
        int256 tick
    ) internal view returns (uint256 exposure) {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        uint32 bin = TickBinLib.tickToBin(market.minTick, market.tickSpacing, market.numBins, tick);
        return ExposureDiffLib.pointQuery(_exposureDiff[marketId], bin);
    }
}
