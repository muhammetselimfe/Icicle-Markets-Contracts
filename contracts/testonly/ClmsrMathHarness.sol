// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../lib/LazyMulSegmentTree.sol";
import "../lib/ClmsrMath.sol";

/// @notice Harness for CLMSR math: initializes a tree from bins and exposes quote helpers.
/// @dev Uses the same LazyMulSegmentTree/ClmsrMath stack that backs TradeModule,
///      but without touching IcicleOptionsCore storage.
contract ClmsrMathHarness {
    using LazyMulSegmentTree for LazyMulSegmentTree.Tree;

    error EmptyFactors();

    LazyMulSegmentTree.Tree private tree;

    /// @notice Seed the tree with explicit bin factors.
    function seed(uint256[] memory factors) external {
        if (factors.length == 0) revert EmptyFactors();
        // Reset entire tree struct for re-use (dense version)
        delete tree;
        tree.init(uint32(factors.length));
        tree.seedWithFactors(factors);
    }

    function applyRangeFactor(uint32 loBin, uint32 hiBin, uint256 factor) external {
        tree.applyRangeFactor(loBin, hiBin, factor);
    }

    function rangeSum(uint32 loBin, uint32 hiBin) external view returns (uint256) {
        return tree.getRangeSum(loBin, hiBin);
    }

    function quoteBuy(
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 quantityWad
    ) external view returns (uint256 costWad) {
        costWad = ClmsrMath.calculateTradeCost(tree, alpha, loBin, hiBin, quantityWad);
    }

    function quoteSell(
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 quantityWad
    ) external view returns (uint256 proceedsWad) {
        proceedsWad = ClmsrMath.calculateSellProceeds(tree, alpha, loBin, hiBin, quantityWad);
    }

    function quantityFromCost(
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 costWad
    ) external view returns (uint256 quantityWad) {
        quantityWad = ClmsrMath.calculateQuantityFromCost(tree, alpha, loBin, hiBin, costWad);
    }

    /// @notice Expose the core safe exponential helper for parity tests against v0.
    function exposedSafeExp(uint256 qWad, uint256 alphaWad) external pure returns (uint256) {
        return ClmsrMath._safeExp(qWad, alphaWad);
    }

    // ============================================================
    // Pure math helpers (no tree state)
    // ============================================================

    function maxSafeChunkQuantity(uint256 alpha) external pure returns (uint256) {
        return ClmsrMath.maxSafeChunkQuantity(alpha);
    }

    function computeBuyCostFromSumChange(
        uint256 alpha,
        uint256 sumBefore,
        uint256 sumAfter
    ) external pure returns (uint256) {
        return ClmsrMath.computeBuyCostFromSumChange(alpha, sumBefore, sumAfter);
    }

    function computeSellProceedsFromSumChange(
        uint256 alpha,
        uint256 sumBefore,
        uint256 sumAfter
    ) external pure returns (uint256) {
        return ClmsrMath.computeSellProceedsFromSumChange(alpha, sumBefore, sumAfter);
    }
}
