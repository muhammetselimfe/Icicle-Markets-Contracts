// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LazyMulSegmentTree} from "./LazyMulSegmentTree.sol";
import {FixedPointMathU} from "./FixedPointMathU.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/// @notice CLMSR math library for cost/proceeds calculation over segment trees.
/// @dev Implements whitepaper Section 2 (CLMSR Pricing Engine).
library ClmsrMath {
    using FixedPointMathU for uint256;
    using LazyMulSegmentTree for LazyMulSegmentTree.Tree;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_CHUNKS_PER_TX = 100;
    uint256 internal constant OVERFLOW_GUARD_MULTIPLIER = 50e18; // 50 * WAD

    /// @notice ln(MAX_FACTOR) = ln(100) ≈ 4.605170... in WAD
    /// @dev Used to cap chunk quantity so that exp(q/α) ≤ MAX_FACTOR.
    ///      Slightly conservative (4.6e18) to avoid boundary issues.
    uint256 internal constant LN_MAX_FACTOR_WAD = 4_605_170_185_988_091_368; // ln(100) * 1e18

    // ============================================================
    // Core CLMSR Math
    // ============================================================

    /// @notice Safe exp(numerator/alpha) with overflow protection
    /// @dev Reverts if result would overflow MAX_EXP_INPUT_WAD
    function _safeExp(uint256 numeratorWad, uint256 alpha) internal pure returns (uint256) {
        if (alpha == 0) revert SE.InvalidLiquidityParameter();
        uint256 inputWad = numeratorWad.wDiv(alpha);
        if (inputWad > FixedPointMathU.MAX_EXP_INPUT_WAD) revert SE.FP_Overflow();
        return inputWad.wExp();
    }

    // ============================================================
    // Execute-First Cost/Proceeds Calculation (from actual sum change)
    // ============================================================

    /// @notice Compute buy cost from actual sum change (post-update)
    /// @dev Use this for execute-first model: apply factor first, then compute exact cost
    /// @param alpha Liquidity parameter
    /// @param sumBefore Total sum before factor application
    /// @param sumAfter Total sum after factor application
    /// @return costWad Exact cost in WAD
    function computeBuyCostFromSumChange(
        uint256 alpha,
        uint256 sumBefore,
        uint256 sumAfter
    ) internal pure returns (uint256 costWad) {
        if (sumAfter <= sumBefore) return 0;
        uint256 ratio = sumAfter.wDivUp(sumBefore);
        return alpha.wMul(ratio.wLn());
    }

    /// @notice Compute sell proceeds from actual sum change (post-update)
    /// @dev Use this for execute-first model: apply factor first, then compute exact proceeds
    ///      Uses floor division for ratio to ensure proceeds never exceed theoretical value (safety)
    /// @param alpha Liquidity parameter
    /// @param sumBefore Total sum before factor application
    /// @param sumAfter Total sum after factor application
    /// @return proceedsWad Exact proceeds in WAD
    function computeSellProceedsFromSumChange(
        uint256 alpha,
        uint256 sumBefore,
        uint256 sumAfter
    ) internal pure returns (uint256 proceedsWad) {
        if (sumAfter >= sumBefore) return 0;
        // Floor division ensures we never overpay (credit safety)
        uint256 ratio = sumBefore.wDiv(sumAfter);
        return alpha.wMul(ratio.wLn());
    }

    /// @notice Maximum safe quantity per chunk for tree factor bounds AND exp input bounds.
    /// @dev Returns min(α * MAX_EXP_INPUT, α * ln(MAX_FACTOR)).
    ///      The tree enforces factor ≤ MAX_FACTOR, so exp(q/α) ≤ MAX_FACTOR ⟹ q ≤ α * ln(MAX_FACTOR).
    ///      This is typically the binding constraint (ln(100) ≈ 4.6 << MAX_EXP_INPUT ≈ 135).
    function maxSafeChunkQuantity(uint256 alpha) internal pure returns (uint256) {
        if (alpha == 0) return 0;
        // Tree factor limit: exp(q/α) ≤ MAX_FACTOR ⟹ q ≤ α * ln(MAX_FACTOR)
        uint256 treeLimit = alpha.wMul(LN_MAX_FACTOR_WAD);
        // Exp computation limit: q/α ≤ MAX_EXP_INPUT
        uint256 expLimit = alpha.wMul(FixedPointMathU.MAX_EXP_INPUT_WAD);
        // Return the more restrictive limit
        return treeLimit < expLimit ? treeLimit : expLimit;
    }

    /// @notice Private helper for internal use (identical logic)
    function _maxSafeChunkQuantity(uint256 alpha) private pure returns (uint256) {
        if (alpha == 0) return 0;
        uint256 treeLimit = alpha.wMul(LN_MAX_FACTOR_WAD);
        uint256 expLimit = alpha.wMul(FixedPointMathU.MAX_EXP_INPUT_WAD);
        return treeLimit < expLimit ? treeLimit : expLimit;
    }

    function calculateTradeCost(
        LazyMulSegmentTree.Tree storage tree,
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 quantityWad
    ) internal view returns (uint256 costWad) {
        uint256 totalQuantity = quantityWad;
        uint256 maxSafeQuantityPerChunk = _maxSafeChunkQuantity(alpha);

        if (totalQuantity == 0) return 0;
        if (totalQuantity <= maxSafeQuantityPerChunk) {
            return _calculateSingleTradeCost(tree, alpha, loBin, hiBin, totalQuantity);
        }

        uint256 sumBefore = tree.totalSum();
        uint256 affectedSum = tree.getRangeSum(loBin, hiBin);
        require(sumBefore != 0, SE.TreeNotInitialized());

        uint256 requiredChunks = (totalQuantity + maxSafeQuantityPerChunk - 1) / maxSafeQuantityPerChunk;
        require(requiredChunks <= MAX_CHUNKS_PER_TX, SE.ChunkLimitExceeded(requiredChunks, MAX_CHUNKS_PER_TX));

        uint256 cumulativeCostWad;
        uint256 remainingQuantity = totalQuantity;
        uint256 currentSumBefore = sumBefore;
        uint256 currentAffectedSum = affectedSum;
        uint256 chunkCount;

        while (remainingQuantity > 0 && chunkCount < MAX_CHUNKS_PER_TX) {
            uint256 chunkQuantity = remainingQuantity > maxSafeQuantityPerChunk
                ? maxSafeQuantityPerChunk
                : remainingQuantity;

            uint256 quantityScaled = chunkQuantity.wDiv(alpha);
            uint256 factor = quantityScaled.wExp();

            if (currentAffectedSum > type(uint256).max / factor) {
                chunkQuantity = _computeSafeChunk(
                    currentAffectedSum,
                    alpha,
                    remainingQuantity,
                    MAX_CHUNKS_PER_TX - chunkCount
                );
                if (chunkQuantity > remainingQuantity) {
                    chunkQuantity = remainingQuantity;
                }
                quantityScaled = chunkQuantity.wDiv(alpha);
                factor = quantityScaled.wExp();
            }

            require(currentAffectedSum == 0 || factor <= type(uint256).max / currentAffectedSum, SE.MathMulOverflow());

            uint256 newAffectedSum = currentAffectedSum.wMulNearest(factor);
            uint256 sumAfter = currentSumBefore - currentAffectedSum + newAffectedSum;
            require(sumAfter > currentSumBefore, SE.NonIncreasingSum(currentSumBefore, sumAfter));

            uint256 ratio = sumAfter.wDivUp(currentSumBefore);
            uint256 chunkCost = alpha.wMul(ratio.wLn());
            cumulativeCostWad += chunkCost;

            require(chunkQuantity != 0, SE.NoChunkProgress());

            currentSumBefore = sumAfter;
            currentAffectedSum = newAffectedSum;
            remainingQuantity -= chunkQuantity;
            chunkCount++;
        }

        require(remainingQuantity == 0, SE.ResidualQuantity(remainingQuantity));
        return cumulativeCostWad;
    }

    function _calculateSingleTradeCost(
        LazyMulSegmentTree.Tree storage tree,
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 quantityWad
    ) private view returns (uint256 cost) {
        uint256 sumBefore = tree.totalSum();
        require(sumBefore != 0, SE.TreeNotInitialized());
        uint256 quantityScaled = quantityWad.wDiv(alpha);
        uint256 factor = quantityScaled.wExp();
        uint256 affectedSum = tree.getRangeSum(loBin, hiBin);
        require(affectedSum != 0, SE.AffectedSumZero());
        if (affectedSum > type(uint256).max / factor) {
            return calculateTradeCost(tree, alpha, loBin, hiBin, quantityWad);
        }
        uint256 sumAfter = sumBefore - affectedSum + affectedSum.wMulNearest(factor);
        if (sumAfter <= sumBefore) return 0;
        uint256 ratio = sumAfter.wDivUp(sumBefore);
        cost = alpha.wMul(ratio.wLn());
    }

    function calculateSellProceeds(
        LazyMulSegmentTree.Tree storage tree,
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 quantityWad
    ) internal view returns (uint256 proceedsWad) {
        uint256 totalQuantity = quantityWad;
        uint256 maxSafeQuantityPerChunk = _maxSafeChunkQuantity(alpha);
        if (totalQuantity == 0) return 0;
        if (totalQuantity <= maxSafeQuantityPerChunk) {
            return _calculateSingleSellProceeds(tree, alpha, loBin, hiBin, totalQuantity);
        }

        uint256 sumBefore = tree.totalSum();
        uint256 affectedSum = tree.getRangeSum(loBin, hiBin);
        require(sumBefore != 0, SE.TreeNotInitialized());

        uint256 requiredChunks = (totalQuantity + maxSafeQuantityPerChunk - 1) / maxSafeQuantityPerChunk;
        require(requiredChunks <= MAX_CHUNKS_PER_TX, SE.ChunkLimitExceeded(requiredChunks, MAX_CHUNKS_PER_TX));

        uint256 cumulativeProceeds;
        uint256 remainingQuantity = totalQuantity;
        uint256 currentSumBefore = sumBefore;
        uint256 currentAffectedSum = affectedSum;
        uint256 chunkCount;

        while (remainingQuantity > 0 && chunkCount < MAX_CHUNKS_PER_TX) {
            uint256 chunkQuantity = remainingQuantity > maxSafeQuantityPerChunk
                ? maxSafeQuantityPerChunk
                : remainingQuantity;

            uint256 quantityScaled = chunkQuantity.wDiv(alpha);
            uint256 factor = quantityScaled.wExp();
            uint256 inverseFactor = WAD.wDivUp(factor);

            if (currentAffectedSum > type(uint256).max / inverseFactor) {
                chunkQuantity = _computeSafeChunk(
                    currentAffectedSum,
                    alpha,
                    remainingQuantity,
                    MAX_CHUNKS_PER_TX - chunkCount
                );
                if (chunkQuantity > remainingQuantity) {
                    chunkQuantity = remainingQuantity;
                }
                quantityScaled = chunkQuantity.wDiv(alpha);
                factor = quantityScaled.wExp();
                inverseFactor = WAD.wDivUp(factor);
            }

            require(currentAffectedSum == 0 || inverseFactor <= type(uint256).max / currentAffectedSum, SE.MathMulOverflow());

            uint256 newAffectedSum = currentAffectedSum.wMulNearest(inverseFactor);
            uint256 sumAfter = currentSumBefore - currentAffectedSum + newAffectedSum;
            require(sumAfter != 0, SE.SumAfterZero());
            if (sumBefore <= sumAfter) return 0;

            uint256 ratio = currentSumBefore.wDivUp(sumAfter);
            uint256 chunkProceeds = alpha.wMul(ratio.wLn());
            cumulativeProceeds += chunkProceeds;

            require(chunkQuantity != 0, SE.NoChunkProgress());

            currentSumBefore = sumAfter;
            currentAffectedSum = newAffectedSum;
            remainingQuantity -= chunkQuantity;
            chunkCount++;
        }

        require(remainingQuantity == 0, SE.ResidualQuantity(remainingQuantity));
        return cumulativeProceeds;
    }

    function _calculateSingleSellProceeds(
        LazyMulSegmentTree.Tree storage tree,
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 quantityWad
    ) private view returns (uint256 proceeds) {
        uint256 sumBefore = tree.totalSum();
        require(sumBefore != 0, SE.TreeNotInitialized());

        uint256 quantityScaled = quantityWad.wDiv(alpha);
        uint256 factor = quantityScaled.wExp();
        uint256 inverseFactor = WAD.wDivUp(factor);

        uint256 affectedSum = tree.getRangeSum(loBin, hiBin);
        require(affectedSum != 0, SE.AffectedSumZero());
        if (affectedSum > type(uint256).max / inverseFactor) {
            return calculateSellProceeds(tree, alpha, loBin, hiBin, quantityWad);
        }

        uint256 sumAfter = sumBefore - affectedSum + affectedSum.wMulNearest(inverseFactor);
        require(sumAfter != 0, SE.SumAfterZero());
        if (sumBefore <= sumAfter) return 0;

        uint256 ratio = sumBefore.wDivUp(sumAfter);
        uint256 lnRatio = ratio.wLn();
        proceeds = alpha.wMul(lnRatio);
    }

    function calculateQuantityFromCost(
        LazyMulSegmentTree.Tree storage tree,
        uint256 alpha,
        uint32 loBin,
        uint32 hiBin,
        uint256 costWad
    ) internal view returns (uint256 quantityWad) {
        uint256 sumBefore = tree.totalSum();
        uint256 affectedSum = tree.getRangeSum(loBin, hiBin);
        require(sumBefore != 0, SE.TreeNotInitialized());
        require(affectedSum != 0, SE.AffectedSumZero());

        uint256 expValue = _safeExp(costWad, alpha);
        uint256 targetSumAfter = sumBefore.wMul(expValue);
        uint256 requiredAffectedSum = targetSumAfter - (sumBefore - affectedSum);
        uint256 factor = requiredAffectedSum.wDiv(affectedSum);
        quantityWad = alpha.wMul(factor.wLn());
    }

    function _computeSafeChunk(
        uint256 currentSum,
        uint256 alpha,
        uint256 remainingQty,
        uint256 chunksLeft
    ) private pure returns (uint256 safeChunk) {
        if (chunksLeft == 0) return remainingQty;

        uint256 minProgress = (remainingQty + chunksLeft - 1) / chunksLeft;
        if (minProgress == 0) minProgress = 1;

        uint256 maxSafeQuantity = alpha.wMul(FixedPointMathU.MAX_EXP_INPUT_WAD);
        if (currentSum > alpha.wMul(OVERFLOW_GUARD_MULTIPLIER)) {
            maxSafeQuantity = alpha / 10;
        }

        safeChunk = minProgress < maxSafeQuantity ? minProgress : maxSafeQuantity;
        if (safeChunk > remainingQty) {
            safeChunk = remainingQty;
        }
    }
}
