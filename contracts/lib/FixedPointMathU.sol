// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {UD60x18, ud, unwrap, exp, ln} from "@prb/math/src/UD60x18.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/// @notice Fixed-point math utilities (WAD = 1e18) with 512-bit safe arithmetic.
/// @dev Uses OpenZeppelin Math.mulDiv for overflow-safe multiplication/division.
///      exp/ln operations use PRBMath for production-grade numerical stability.
library FixedPointMathU {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant HALF_WAD = 5e17;
    uint256 internal constant SCALE_DIFF = 1e12; // 6-dec → 18-dec
    uint256 internal constant HALF_SCALE = SCALE_DIFF / 2;

    // ============================================================
    // Decimal Conversion (6-dec ↔ 18-dec)
    // ============================================================

    /// @dev 6-decimal → 18-decimal (multiply by 1e12)
    /// @notice Overflow-safe: explicitly checks before multiplication
    function toWad(uint256 x) internal pure returns (uint256) {
        // Explicit overflow check to prevent wrap-around
        if (x > type(uint256).max / SCALE_DIFF) revert SE.FP_Overflow();
        return x * SCALE_DIFF;
    }

    /// @dev 18-decimal → 6-decimal (truncates/floor)
    function fromWad(uint256 x) internal pure returns (uint256) {
        return x / SCALE_DIFF;
    }

    /// @dev 18-decimal → 6-decimal with round-up (ceil)
    /// @notice Prevents zero-cost attacks by ensuring non-zero WAD → non-zero 6-dec
    function fromWadRoundUp(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        return ((x - 1) / SCALE_DIFF) + 1;
    }

    /// @dev 18-decimal → 6-decimal nearest (ties up)
    function fromWadNearest(uint256 x) internal pure returns (uint256) {
        uint256 quotient = x / SCALE_DIFF;
        uint256 remainder = x % SCALE_DIFF;
        if (remainder >= HALF_SCALE) {
            unchecked {
                quotient += 1;
            }
        }
        return quotient;
    }

    /// @dev fromWadNearest but returns at least 1 if x > 0
    function fromWadNearestMin1(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 res = fromWadNearest(x);
        return res == 0 ? 1 : res;
    }

    // ============================================================
    // WAD Multiplication (512-bit safe via mulDiv)
    // ============================================================

    /// @notice WAD multiply with floor (truncate)
    /// @dev result = floor(x * y / WAD)
    ///      Uses 512-bit intermediate to prevent overflow
    function wMul(uint256 x, uint256 y) internal pure returns (uint256) {
        return Math.mulDiv(x, y, WAD);
    }

    /// @notice WAD multiply with ceil (round up)
    /// @dev result = ceil(x * y / WAD)
    ///      Uses mulDiv + mulmod to check for remainder
    function wMulUp(uint256 x, uint256 y) internal pure returns (uint256) {
        uint256 result = Math.mulDiv(x, y, WAD);
        // Check if there's a remainder (x*y % WAD != 0)
        if (mulmod(x, y, WAD) > 0) {
            unchecked {
                result += 1;
            }
        }
        return result;
    }

    /// @notice WAD multiply with round-to-nearest (ties up)
    /// @dev result = round(x * y / WAD)
    ///      Uses mulDiv + mulmod to check remainder against HALF_WAD
    function wMulNearest(uint256 x, uint256 y) internal pure returns (uint256) {
        uint256 result = Math.mulDiv(x, y, WAD);
        uint256 remainder = mulmod(x, y, WAD);
        if (remainder >= HALF_WAD) {
            unchecked {
                result += 1;
            }
        }
        return result;
    }

    // ============================================================
    // WAD Division (512-bit safe via mulDiv)
    // ============================================================

    /// @notice WAD divide with floor (truncate)
    /// @dev result = floor(x * WAD / y)
    ///      Uses 512-bit intermediate to prevent overflow
    function wDiv(uint256 x, uint256 y) internal pure returns (uint256) {
        if (y == 0) revert SE.FP_DivisionByZero();
        return Math.mulDiv(x, WAD, y);
    }

    /// @notice WAD divide with ceil (round up)
    /// @dev result = ceil(x * WAD / y)
    ///      Uses mulDiv + mulmod to check for remainder
    function wDivUp(uint256 x, uint256 y) internal pure returns (uint256) {
        if (y == 0) revert SE.FP_DivisionByZero();
        uint256 result = Math.mulDiv(x, WAD, y);
        // Check if there's a remainder (x*WAD % y != 0)
        if (mulmod(x, WAD, y) > 0) {
            unchecked {
                result += 1;
            }
        }
        return result;
    }

    /// @notice WAD divide with round-to-nearest (ties up)
    /// @dev result = round(x * WAD / y)
    ///      Uses mulDiv + mulmod to check remainder against y/2
    function wDivNearest(uint256 x, uint256 y) internal pure returns (uint256) {
        if (y == 0) revert SE.FP_DivisionByZero();
        uint256 result = Math.mulDiv(x, WAD, y);
        uint256 remainder = mulmod(x, WAD, y);
        // Round up if remainder >= y/2
        if (remainder >= (y >> 1) + (y & 1)) {
            // (y + 1) / 2 for correct rounding
            unchecked {
                result += 1;
            }
        }
        return result;
    }

    // ============================================================
    // Exponential & Logarithm (PRBMath based)
    // ============================================================

    /// @dev PRBMath exp input upper bound: exp(133.084...) overflows UD60x18
    uint256 internal constant MAX_EXP_INPUT_WAD = 133_084258667509499440;

    /// @notice High-precision exponential using PRBMath
    /// @dev Wraps PRBMath UD60x18.exp() for production-grade numerical stability
    /// @param xWad Input in WAD (must be <= MAX_EXP_INPUT_WAD ≈ 133.084)
    function wExp(uint256 xWad) internal pure returns (uint256) {
        if (xWad == 0) return WAD;
        if (xWad > MAX_EXP_INPUT_WAD) revert SE.FP_Overflow();
        return unwrap(exp(ud(xWad)));
    }

    /// @notice High-precision natural logarithm using PRBMath
    /// @dev Wraps PRBMath UD60x18.ln() for production-grade numerical stability
    /// @param xWad Input value in WAD (MUST be >= WAD = 1e18)
    function wLn(uint256 xWad) internal pure returns (uint256) {
        if (xWad < WAD) revert SE.FP_InvalidInput();
        if (xWad == WAD) return 0;
        return unwrap(ln(ud(xWad)));
    }

    // ============================================================
    // Safe ln(n) for α Safety Bounds (PRBMath based)
    // ============================================================

    /// @notice Calculate ln(n) with safe (upward) rounding for α calculation
    /// @dev Returns ln(n) in WAD, rounded UP (+1 wei) to ensure α_base is conservative.
    ///      α_base = λE/ln(n) must never exceed the safety bound.
    /// @param n Number of bins (integer, not WAD)
    /// @return lnN ln(n) in WAD, rounded up for safety
    function lnWadUp(uint256 n) internal pure returns (uint256 lnN) {
        if (n <= 1) return 0;
        // ln(n) = ln(n * WAD) using PRBMath, then +1 wei for conservative upper bound
        return unwrap(ln(ud(n * WAD))) + 1;
    }
}
