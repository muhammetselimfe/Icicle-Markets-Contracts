// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCoreStorage.sol";
import "../interfaces/IIcicleOptionsCore.sol";
import "../interfaces/IIcicleOptionsPosition.sol";
import "../interfaces/IFeePolicy.sol";
import "../lib/LazyMulSegmentTree.sol";

/// @notice Minimal core proxy to delegate trade/view calls to TradeModule for tests.
contract TradeModuleProxy is IcicleOptionsCoreStorage {
    using LazyMulSegmentTree for LazyMulSegmentTree.Tree;

    address public module;

    constructor(address _module) {
        module = _module;
    }

    // setters for tests
    function setAddresses(
        address payment,
        address position,
        uint64 submitWindow,
        uint64 finalizeDeadline
    ) external {
        paymentToken = IERC20(payment);
        positionContract = IIcicleOptionsPosition(position);
        settlementSubmitWindow = submitWindow;
        claimDelaySeconds = finalizeDeadline;
    }

    function setMarket(uint256 marketId, IIcicleOptionsCore.Market calldata market) external {
        markets[marketId] = market;
    }

    function seedTree(uint256 marketId, uint256[] calldata factors) external {
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        if (tree.size == 0) tree.init(uint32(factors.length));
        tree.seedWithFactors(factors);
    }

    // delegate helpers
    function _delegate(bytes memory data) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = module.delegatecall(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function _delegateView(bytes memory data) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = module.delegatecall(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    // trade entrypoints
    function openPosition(uint256 marketId, int256 lowerTick, int256 upperTick, uint128 quantity, uint256 maxCost)
        external
        returns (uint256 positionId)
    {
        bytes memory ret = _delegate(abi.encodeWithSignature(
            "openPosition(uint256,int256,int256,uint128,uint256)",
            marketId,
            lowerTick,
            upperTick,
            quantity,
            maxCost
        ));
        if (ret.length > 0) positionId = abi.decode(ret, (uint256));
    }

    function increasePosition(uint256 positionId, uint128 quantity, uint256 maxCost) external {
        _delegate(abi.encodeWithSignature("increasePosition(uint256,uint128,uint256)", positionId, quantity, maxCost));
    }

    function decreasePosition(uint256 positionId, uint128 quantity, uint256 minProceeds) external {
        _delegate(abi.encodeWithSignature("decreasePosition(uint256,uint128,uint256)", positionId, quantity, minProceeds));
    }

    function closePosition(uint256 positionId, uint256 minProceeds) external {
        _delegate(abi.encodeWithSignature("closePosition(uint256,uint256)", positionId, minProceeds));
    }

    function claimPayout(uint256 positionId) external {
        _delegate(abi.encodeWithSignature("claimPayout(uint256)", positionId));
    }

    function batchClaimPayout(uint256[] calldata positionIds) external {
        _delegate(abi.encodeWithSignature("batchClaimPayout(uint256[])", positionIds));
    }

    // views
    function calculateOpenCost(uint256 marketId, int256 lowerTick, int256 upperTick, uint128 quantity) external returns (uint256) {
        bytes memory ret = _delegateView(abi.encodeWithSignature(
            "calculateOpenCost(uint256,int256,int256,uint128)",
            marketId,
            lowerTick,
            upperTick,
            quantity
        ));
        return abi.decode(ret, (uint256));
    }

    function calculateDecreaseProceeds(uint256 positionId, uint128 quantity) external returns (uint256) {
        bytes memory ret = _delegateView(abi.encodeWithSignature(
            "calculateDecreaseProceeds(uint256,uint128)",
            positionId,
            quantity
        ));
        return abi.decode(ret, (uint256));
    }

    // Test helpers - direct tree access
    function getMarketBinFactor(uint256 marketId, uint32 bin) external view returns (uint256) {
        return marketTrees[marketId].getRangeSum(bin, bin);
    }

    function getMarketTotalSum(uint256 marketId) external view returns (uint256) {
        LazyMulSegmentTree.Tree storage tree = marketTrees[marketId];
        if (tree.size == 0) return 0;
        return tree.totalSum();
    }

    /// @notice Retrieve market struct for testing
    function harnessGetMarket(uint256 marketId) external view returns (IIcicleOptionsCore.Market memory) {
        return markets[marketId];
    }

    /// @notice Set payout reserve for testing claim flows (additive to total)
    function setPayoutReserve(uint256 marketId, uint256 amount) external {
        _payoutReserveRemaining[marketId] = amount;
        _totalPayoutReserve6 += amount;
    }
}
