// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCoreStorage.sol";
import "../lib/FixedPointMathU.sol";
import "../lib/RiskMath.sol";
import "../lib/SeedDataLib.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/// @title RiskModule
/// @notice Delegate-only module for Risk calculations and enforcement
/// @dev Implements:
///      - ΔEₜ (tail budget) calculation from prior
///      - αbase/αlimit calculation with peak drawdown
///      - Prior admissibility check
///
///      Core-first Risk Gate Architecture:
///      This module provides BOTH calculations AND enforcement via gate functions.
///      IcicleOptionsCore calls gate* functions BEFORE delegating to target modules.
///      This ensures bypass-proof enforcement and clear single point of risk validation.
contract RiskModule is IcicleOptionsCoreStorage {
    using FixedPointMathU for uint256;

    address private immutable self;

    // ============================================================
    // Constants
    // ============================================================

    uint256 internal constant WAD = 1e18;

    // ============================================================
    // Modifiers
    // ============================================================

    modifier onlyDelegated() {
        if (address(this) == self) revert SE.NotDelegated();
        _;
    }

    constructor() {
        self = address(this);
    }

    // ============================================================
    // ΔEₜ (Tail Budget) Calculation
    // ============================================================

    /**
     * @notice Calculate tail budget ΔEₜ from prior concentration
     * @dev E_ent(q₀,t) = C(q₀,t) - min_j q₀,t,j  (entropy budget)
     *      ΔEₜ := E_ent(q₀,t) - α ln n           (tail budget)
     *
     *      For uniform prior (q₀ = 0): E_ent = α ln n, so ΔEₜ = 0
     *      For concentrated prior: E_ent > α ln n, so ΔEₜ > 0
     *
     * @param alpha Market liquidity parameter α (WAD)
     * @param numBins Number of outcome bins n
     * @param priorConcentration Measure of prior concentration (WAD)
     *        0 = uniform prior, higher = more concentrated
     * @return deltaEt Tail budget (WAD)
     */
    function calculateDeltaEt(
        uint256 alpha,
        uint256 numBins,
        uint256 priorConcentration
    ) external pure returns (uint256 deltaEt) {
        if (numBins <= 1) revert SE.InvalidNumBins(numBins);
        
        // For uniform prior (concentration = 0), ΔEₜ = 0
        if (priorConcentration == 0) {
            return 0;
        }

        // For concentrated prior:
        // ΔEₜ = priorConcentration * α (simplified model)
        // Full implementation would compute E_ent(q₀) - α ln n from actual prior weights
        // Here we use concentration as a direct multiplier for tail risk
        deltaEt = alpha.wMul(priorConcentration);
    }

    // ============================================================
    // α Safety Bounds
    // ============================================================

    /**
     * @notice Calculate αbase from NAV and bins
     * @dev Delegates to RiskMath library
     * @param Et Vault NAV (WAD)
     * @param numBins Number of outcome bins n
     * @param lambda Safety parameter λ (WAD, NAV loss limit per batch)
     * @return alphaBase Base liquidity parameter limit (WAD)
     */
    function calculateAlphaBase(
        uint256 Et,
        uint256 numBins,
        uint256 lambda
    ) external pure returns (uint256 alphaBase) {
        return RiskMath.calculateAlphaBase(Et, numBins, lambda);
    }

    /**
     * @notice Calculate αlimit from αbase and peak drawdown
     * @dev Delegates to RiskMath library
     * @param alphaBase Base liquidity parameter (WAD)
     * @param drawdown Current peak drawdown DD_t (WAD, 0 to WAD)
     * @param k Peak drawdown sensitivity factor (WAD, typically 1.0)
     * @return alphaLimit Effective liquidity parameter limit (WAD)
     */
    function calculateAlphaLimit(
        uint256 alphaBase,
        uint256 drawdown,
        uint256 k
    ) external pure returns (uint256 alphaLimit) {
        return RiskMath.calculateAlphaLimit(alphaBase, drawdown, k);
    }

    /**
     * @notice Get current αlimit for the system
     * @dev Combines αbase calculation with current peak drawdown using RiskMath
     * @param numBins Number of bins for α calculation
     * @param lambda Safety parameter λ (WAD, NAV loss limit per batch)
     * @param k Peak drawdown sensitivity factor (WAD)
     * @return alphaLimit Current effective α limit (WAD)
     */
    function getAlphaLimit(
        uint256 numBins,
        uint256 lambda,
        uint256 k
    ) external view onlyDelegated returns (uint256 alphaLimit) {
        if (lpVault.nav == 0) return 0;
        
        uint256 alphaBase = RiskMath.calculateAlphaBase(lpVault.nav, numBins, lambda);
        uint256 drawdown = RiskMath.calculateDrawdown(lpVault.price, lpVault.pricePeak);
        alphaLimit = RiskMath.calculateAlphaLimit(alphaBase, drawdown, k);
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
    function checkPriorAdmissibility(
        uint256 deltaEt,
        uint256 effectiveBackstop
    ) external pure {
        if (deltaEt > effectiveBackstop) {
            revert SE.PriorNotAdmissible(deltaEt, effectiveBackstop);
        }
    }

    // ============================================================
    // Utility Functions
    // ============================================================

    /**
     * @notice Calculate natural log of n in WAD (safe upper bound)
     * @dev Delegates to RiskMath library
     * @param n Input value (not WAD)
     * @return Natural log of n in WAD precision (rounded up)
     */
    function lnWad(uint256 n) external pure returns (uint256) {
        return RiskMath.lnWadUp(n);
    }

    // ============================================================
    // Gate Functions (Enforcement)
    // ============================================================

    /**
     * @notice Gate for market creation - validates α limit and prior admissibility
     * @dev Called by IcicleOptionsCore BEFORE MarketLifecycleModule.createMarket
     *      Enforces: αlimit,t+1 = max{0, αbase,t+1 * (1 - k * DD_t)}
     *      Enforces: ΔEₜ ≤ B^eff_{t-1} (prior admissibility)
     * @param liquidityParameter Market α to validate (WAD)
     * @param numBins Number of outcome bins
     * @param seedData Address of SeedData contract containing factors
     */
    function gateCreateMarket(
        uint256 liquidityParameter,
        uint32 numBins,
        address seedData
    ) external view onlyDelegated {
        (, , uint256 deltaEt) = SeedDataLib.computeSeedStats(seedData, numBins, liquidityParameter);
        _enforceAlphaLimit(liquidityParameter, numBins);
        _enforcePriorAdmissibility(deltaEt);
    }

    /**
     * @notice Gate for position open - validates exposure caps
     * @dev Currently no-op. Exposure cap enforcement to be implemented.
     * @param marketId Market ID
     * @param trader Trader address
     * @param quantity Position quantity
     */
    function gateOpenPosition(
        uint256 marketId,
        address trader,
        uint128 quantity
    ) external view onlyDelegated {
        // Exposure cap enforcement pending implementation
        // Silence unused parameter warnings
        marketId;
        trader;
        quantity;
    }

    /**
     * @notice Gate for position increase - validates exposure caps
     * @dev Currently no-op. Exposure cap enforcement to be implemented.
     * @param positionId Position ID
     * @param trader Trader address
     * @param additionalQuantity Additional quantity
     */
    function gateIncreasePosition(
        uint256 positionId,
        address trader,
        uint128 additionalQuantity
    ) external view onlyDelegated {
        // Exposure cap enforcement pending implementation
        // Silence unused parameter warnings
        positionId;
        trader;
        additionalQuantity;
    }

    // ============================================================
    // Internal Enforcement Helpers
    // ============================================================

    /**
     * @notice Enforce α ≤ αlimit
     * @dev Calculates current αlimit and reverts if exceeded
     *      Uses RiskMath library for core calculations
     * @param liquidityParameter Market α to validate (WAD)
     * @param numBins Number of outcome bins
     */
    function _enforceAlphaLimit(uint256 liquidityParameter, uint32 numBins) internal view {
        if (!riskConfig.enforceAlpha) return; // Skip if enforcement disabled
        if (lpVault.nav == 0) return; // Skip if vault not seeded
        
        // Calculate αbase using RiskMath
        uint256 alphaBase = RiskMath.calculateAlphaBase(lpVault.nav, numBins, riskConfig.lambda);
        
        // Calculate peak drawdown using RiskMath
        uint256 drawdown = RiskMath.calculateDrawdown(lpVault.price, lpVault.pricePeak);
        
        // Calculate αlimit using RiskMath
        uint256 alphaLimit = RiskMath.calculateAlphaLimit(alphaBase, drawdown, riskConfig.kDrawdown);
        
        // Enforce: α ≤ αlimit (using RiskMath error)
        if (liquidityParameter > alphaLimit) {
            revert SE.AlphaExceedsLimit(liquidityParameter, alphaLimit);
        }
    }

    /**
     * @notice Enforce prior admissibility: ΔEₜ ≤ B^eff_{t-1}
     * @dev Reverts if tail budget exceeds effective backstop
     * @param deltaEt Tail budget (WAD)
     */
    function _enforcePriorAdmissibility(uint256 deltaEt) internal view {
        uint256 effectiveBackstop = capitalStack.backstopNav;
        if (deltaEt > effectiveBackstop) {
            revert SE.PriorNotAdmissible(deltaEt, effectiveBackstop);
        }
    }

}
