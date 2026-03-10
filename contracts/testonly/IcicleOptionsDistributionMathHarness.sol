// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../lib/ClmsrMath.sol";

/// @title ClmsrMathCostHarness
/// @notice Test harness to expose ClmsrMath cost/proceeds functions
contract ClmsrMathCostHarness {
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

    function safeExp(uint256 numeratorWad, uint256 alpha) external pure returns (uint256) {
        return ClmsrMath._safeExp(numeratorWad, alpha);
    }
}
