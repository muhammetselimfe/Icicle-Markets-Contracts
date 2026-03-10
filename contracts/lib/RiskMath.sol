// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FixedPointMathU.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/// @title RiskMath
/// @notice Core risk calculation library for Icicle Options Protocol
/// @dev Implements:
///      - ΔEₜ (tail budget) calculation from prior
///      - αbase/αlimit calculation with peak drawdown
///      - Prior admissibility check
///
///      This library contains ONLY pure calculations.
///      Enforcement (gate functions) remains in RiskModule.
library RiskMath {
    using FixedPointMathU for uint256;

    // ============================================================
    // Constants
    // ============================================================

    uint256 internal constant WAD = 1e18;

    // ============================================================
    // ΔEₜ (Tail Budget) Calculation
    // ============================================================

    /**
     * @notice Calculate tail budget ΔEₜ from prior factors
     * @dev ΔEₜ = α * ln(rootSum / (n * minFactor))
     *      Uniform prior (all factors equal) → ΔEₜ = 0
     *      Concentrated prior (factors vary) → ΔEₜ > 0
     * @param alpha Market liquidity parameter α (WAD)
     * @param numBins Number of outcome bins n
     * @param baseFactors Prior factor weights
     * @return deltaEt Tail budget (WAD)
     */
    function calculateDeltaEtFromFactors(
        uint256 alpha,
        uint32 numBins,
        uint256[] calldata baseFactors
    ) internal pure returns (uint256 deltaEt) {
        if (baseFactors.length != numBins || numBins == 0) return 0;
        
        uint256 minFactor = type(uint256).max;
        uint256 rootSum = 0;
        for (uint256 i = 0; i < numBins; i++) {
            if (baseFactors[i] == 0) return 0;
            if (baseFactors[i] < minFactor) minFactor = baseFactors[i];
            rootSum += baseFactors[i];
        }
        
        uint256 uniformSum = uint256(numBins) * minFactor;
        if (rootSum <= uniformSum) {
            return 0; // Uniform prior
        }
        
        // ratio = rootSum / uniformSum (WAD precision, ceiling division)
        uint256 ratio = rootSum.wDivUp(uniformSum);
        
        // ln(ratio) with conservative upper bound
        uint256 lnRatio = FixedPointMathU.wLn(ratio) + 1;
        
        // ΔEₜ = α * lnRatio (ceiling multiplication)
        deltaEt = alpha.wMulUp(lnRatio);
    }

    /**
     * @notice Calculate tail budget ΔEₜ from pre-computed sums
     * @dev Used when rootSum and minFactor are already known
     * @param alpha Market liquidity parameter α (WAD)
     * @param numBins Number of outcome bins n
     * @param rootSum Sum of all factors (WAD)
     * @param minFactor Minimum factor value (WAD)
     * @return deltaEt Tail budget (WAD)
     */
    function calculateDeltaEt(
        uint256 alpha,
        uint32 numBins,
        uint256 rootSum,
        uint256 minFactor
    ) internal pure returns (uint256 deltaEt) {
        uint256 uniformSum = uint256(numBins) * minFactor;
        
        if (rootSum <= uniformSum) {
            return 0; // Uniform or near-uniform prior
        }
        
        // ratio = rootSum / uniformSum (ceiling division for safety)
        uint256 ratio = rootSum.wDivUp(uniformSum);
        
        // ln(ratio) with conservative upper bound
        uint256 lnRatio = FixedPointMathU.wLn(ratio) + 1;
        
        // ΔEₜ = α * lnRatio (ceiling multiplication)
        deltaEt = alpha.wMulUp(lnRatio);
    }

    // ============================================================
    // α Safety Bounds
    // ============================================================

    /**
     * @notice Calculate αbase from NAV and bins
     * @dev αbase,t = λ * E_t / ln(n), where E_t = vault NAV.
     *      Ensures uniform-prior worst-case loss ≤ λ * E_t
     * @param Et Vault NAV (WAD)
     * @param numBins Number of outcome bins n
     * @param lambda Safety parameter λ (WAD, NAV loss limit per batch)
     * @return alphaBase Base liquidity parameter limit (WAD)
     */
    function calculateAlphaBase(
        uint256 Et,
        uint256 numBins,
        uint256 lambda
    ) internal pure returns (uint256 alphaBase) {
        if (numBins <= 1) revert SE.InvalidNumBins(numBins);
        
        // Use safe (upward-rounded) ln to ensure conservative α_base
        uint256 lnN = FixedPointMathU.lnWadUp(numBins);
        if (lnN == 0) return type(uint256).max; // Edge case: n=1
        
        // αbase = λ * E_t / ln(n)
        alphaBase = lambda.wMul(Et).wDiv(lnN);
    }

    /**
     * @notice Calculate αlimit from αbase and peak drawdown
     * @dev αlimit,t+1 = max{0, αbase,t+1 * (1 - k * DD_t)}
     *      where DD_t = 1 - P_t / P^peak_t
     * @param alphaBase Base liquidity parameter (WAD)
     * @param drawdown Current peak drawdown DD_t (WAD, 0 to WAD)
     * @param k Peak drawdown sensitivity factor (WAD, typically 1.0)
     * @return alphaLimit Effective liquidity parameter limit (WAD)
     */
    function calculateAlphaLimit(
        uint256 alphaBase,
        uint256 drawdown,
        uint256 k
    ) internal pure returns (uint256 alphaLimit) {
        // αlimit = αbase * (1 - k * DD)
        uint256 kDD = k.wMul(drawdown);
        
        if (kDD >= WAD) {
            // k * DD >= 1 → factor would be negative → return 0
            return 0;
        }
        
        uint256 factor = WAD - kDD; // 1 - k * DD
        alphaLimit = alphaBase.wMul(factor);
    }

    /**
     * @notice Calculate peak drawdown from current price and peak
     * @dev DD_t = 1 - P_t / P^peak_t. Returns 0 if price >= peak.
     * @param price Current price (WAD)
     * @param pricePeak Peak price (WAD)
     * @return drawdown Peak drawdown ratio (WAD, 0 to WAD)
     */
    function calculateDrawdown(
        uint256 price,
        uint256 pricePeak
    ) internal pure returns (uint256 drawdown) {
        if (pricePeak == 0 || price >= pricePeak) {
            return 0;
        }
        drawdown = WAD - price.wDiv(pricePeak);
    }

    // ============================================================
    // Prior Admissibility
    // ============================================================

    /**
     * @notice Check if prior is admissible
     * @dev Invariant: ΔEₜ ≤ B^eff_{t-1}. Reverts if violated.
     * @param deltaEt Tail budget from prior (WAD)
     * @param effectiveBackstop Effective backstop budget B^eff (WAD)
     */
    function enforcePriorAdmissibility(
        uint256 deltaEt,
        uint256 effectiveBackstop
    ) internal pure {
        if (deltaEt > effectiveBackstop) {
            revert SE.PriorNotAdmissible(deltaEt, effectiveBackstop);
        }
    }

    /**
     * @notice Check if α is within limit
     * @dev Reverts with AlphaExceedsLimit if α > αlimit
     * 
     * @param alpha Market α to validate (WAD)
     * @param alphaLimit Maximum allowed α (WAD)
     */
    function enforceAlphaLimit(
        uint256 alpha,
        uint256 alphaLimit
    ) internal pure {
        if (alpha > alphaLimit) {
            revert SE.AlphaExceedsLimit(alpha, alphaLimit);
        }
    }

    // ============================================================
    // Utility Functions
    // ============================================================

    /**
     * @notice Calculate natural log of n in WAD (safe upper bound)
     * @dev Uses FixedPointMathU.lnWadUp for conservative α calculation
     * @param n Input value (not WAD)
     * @return Natural log of n in WAD precision (rounded up)
     */
    function lnWadUp(uint256 n) internal pure returns (uint256) {
        return FixedPointMathU.lnWadUp(n);
    }
}
