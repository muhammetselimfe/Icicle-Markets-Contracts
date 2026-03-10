// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FixedPointMathU.sol";
import "./FeeWaterfallLib.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/**
 * @title VaultAccountingLib
 * @notice Pure math library for LP Vault accounting
 * @dev Formulas:
 *      - N^pre_t = N_{t-1} + Π_t  where Π_t = L_t + F_t + G_t
 *      - P^e_t = N^pre_t / S_{t-1}
 *      - Deposit: (N', S') = (N + D, S + D/P)
 *      - Withdraw: (N'', S'') = (N - x·P, S - x)
 *      - DD_t = 1 - P_t / P^peak_t (peak drawdown)
 */
library VaultAccountingLib {
    using FixedPointMathU for uint256;

    uint256 internal constant WAD = 1e18;

    // ============================================================
    // Structs
    // ============================================================
    
    /// @notice Inputs for pre-batch NAV calculation
    struct PreBatchInputs {
        uint256 navPrev;     // N_{t-1}: previous NAV (WAD)
        uint256 sharesPrev;  // S_{t-1}: previous shares (WAD)
        int256 pnl;          // L_t: CLMSR P&L, can be negative (WAD)
        uint256 fees;        // F_t: LP-attributed fees (WAD)
        uint256 grant;       // G_t: Backstop grant (WAD)
    }

    /// @notice Result of pre-batch calculation
    struct PreBatchResult {
        uint256 navPre;      // N^pre_t: pre-batch NAV (WAD)
        uint256 batchPrice;  // P^e_t: batch price (WAD)
    }

    /// @notice State after applying deposits and withdrawals
    struct PostBatchState {
        uint256 nav;         // N_t: final NAV (WAD)
        uint256 shares;      // S_t: final shares (WAD)
        uint256 price;       // P_t: final price (WAD)
        uint256 pricePeak;   // P^peak_t: updated peak price (WAD)
        uint256 drawdown;    // DD_t: peak drawdown (WAD)
    }

    // ============================================================
    // Pre-batch Calculation
    // ============================================================

    /**
     * @notice Compute batch price from FeeWaterfallLib result
     * @dev Uses FeeWaterfallLib.Result.Npre directly and validates invariant:
     *      Npre == Nprev + Lt + Ft + Gt
     * @param navPrev Previous NAV N_{t-1} (WAD)
     * @param sharesPrev Previous shares S_{t-1} (WAD)
     * @param lt CLMSR P&L L_t (signed, WAD)
     * @param wf FeeWaterfallLib calculation result
     * @return navPre Pre-batch NAV (WAD) - directly from wf.Npre
     * @return batchPrice Batch price P^e_t (WAD)
     */
    function applyPreBatchFromWaterfall(
        uint256 navPrev,
        uint256 sharesPrev,
        int256 lt,
        FeeWaterfallLib.Result memory wf
    ) internal pure returns (uint256 navPre, uint256 batchPrice) {
        if (sharesPrev == 0) revert SE.ZeroSharesNotAllowed();
        
        // Validate invariant: Npre == Nprev + Lt + Ft + Gt
        int256 pi = lt + int256(wf.Ft) + int256(wf.Gt);
        uint256 expected;
        if (pi >= 0) {
            expected = navPrev + uint256(pi);
        } else {
            uint256 loss = uint256(-pi);
            if (loss > navPrev) revert SE.NAVUnderflow(navPrev, loss);
            expected = navPrev - loss;
        }
        
        // Consistency check: FeeWaterfallLib.Npre should match our calculation
        if (wf.Npre != expected) revert SE.PreBatchNavMismatch(expected, wf.Npre);
        
        navPre = wf.Npre;
        batchPrice = navPre.wDiv(sharesPrev);
    }

    /**
     * @notice Compute pre-batch NAV and batch price
     * @dev N^pre_t = N_{t-1} + L_t + F_t + G_t
     *      P^e_t = N^pre_t / S_{t-1}
     *
     *      Safety Layer ensures NAV never goes negative via Backstop Grants (G_t).
     *      If NAV would go negative, this reverts with NAVUnderflow.
     * @param inputs Pre-batch inputs
     * @return result Pre-batch NAV and price
     */
    function computePreBatch(PreBatchInputs memory inputs) internal pure returns (PreBatchResult memory result) {
        // Π_t = L_t + F_t + G_t (signed addition)
        int256 pi = inputs.pnl + int256(inputs.fees) + int256(inputs.grant);
        
        // N^pre_t = N_{t-1} + Π_t
        if (pi >= 0) {
            result.navPre = inputs.navPrev + uint256(pi);
        } else {
            uint256 loss = uint256(-pi);
            // Safety Layer must prevent NAV from going negative - revert if violated
            if (loss > inputs.navPrev) {
                revert SE.NAVUnderflow(inputs.navPrev, loss);
            }
            result.navPre = inputs.navPrev - loss;
        }

        // P^e_t = N^pre_t / S_{t-1}
        if (inputs.sharesPrev == 0) {
            revert SE.ZeroSharesNotAllowed();
        }
        result.batchPrice = result.navPre.wDiv(inputs.sharesPrev);
    }

    /**
     * @notice Compute pre-batch for seeding scenario (first deposit)
     * @dev When S_{t-1} = 0, price is set to 1e18 (1.0)
     *      Seeding should only happen with fresh vault (navPrev=0, pnl=0, fees=0, grant=0)
     * @param navPrev Previous NAV (should be 0 for fresh vault)
     * @param pnl P&L (should be 0 for fresh vault)
     * @param fees Fees (should be 0 for fresh vault)
     * @param grant Grant (should be 0 for fresh vault)
     * @return navPre Pre-batch NAV
     * @return batchPrice Batch price (1e18 for seeding)
     */
    function computePreBatchForSeed(
        uint256 navPrev,
        int256 pnl,
        uint256 fees,
        uint256 grant
    ) internal pure returns (uint256 navPre, uint256 batchPrice) {
        int256 pi = pnl + int256(fees) + int256(grant);
        if (pi >= 0) {
            navPre = navPrev + uint256(pi);
        } else {
            uint256 loss = uint256(-pi);
            // For seeding, NAV underflow should never happen, but revert if it does
            if (loss > navPrev) {
                revert SE.NAVUnderflow(navPrev, loss);
            }
            navPre = navPrev - loss;
        }
        // For seeding, price is always 1.0
        batchPrice = WAD;
    }

    // ============================================================
    // Deposit
    // ============================================================

    /**
     * @notice Apply deposit to vault state
     * @dev S_mint = floor(A / P), A_used = S_mint * P
     *      Residual A - A_used is refunded (handled by caller).
     *      This preserves N'/S' = P within 1 wei tolerance.
     * @param nav Current NAV (WAD)
     * @param shares Current shares (WAD)
     * @param price Batch price P (WAD)
     * @param depositAmount Deposit amount D (WAD)
     * @return newNav Updated NAV (WAD) - only A_used is added
     * @return newShares Updated shares (WAD)
     * @return mintedShares Shares minted (WAD)
     * @return refundAmount Amount to refund to depositor (WAD)
     */
    function applyDeposit(
        uint256 nav,
        uint256 shares,
        uint256 price,
        uint256 depositAmount
    ) internal pure returns (uint256 newNav, uint256 newShares, uint256 mintedShares, uint256 refundAmount) {
        if (price == 0) revert SE.ZeroPriceNotAllowed();
        
        // S_mint = floor(A / P) - round down shares to favor protocol
        mintedShares = depositAmount.wDiv(price);
        
        // A_used = S_mint * P - round down to favor protocol
        uint256 amountUsed = mintedShares.wMul(price);
        
        // N' = N + A_used (NOT full depositAmount)
        newNav = nav + amountUsed;
        
        // S' = S + S_mint
        newShares = shares + mintedShares;
        
        // Refund = A - A_used (at most 1 wei due to rounding)
        refundAmount = depositAmount - amountUsed;
    }

    // ============================================================
    // Withdraw
    // ============================================================

    /**
     * @notice Apply withdrawal to vault state
     * @dev (N'', S'') = (N - x·P, S - x) preserves N''/S'' = P
     * @param nav Current NAV (WAD)
     * @param shares Current shares (WAD)
     * @param price Batch price P (WAD)
     * @param withdrawShares Shares to burn x (WAD)
     * @return newNav Updated NAV (WAD)
     * @return newShares Updated shares (WAD)
     * @return withdrawAmount Asset amount paid out (WAD)
     */
    function applyWithdraw(
        uint256 nav,
        uint256 shares,
        uint256 price,
        uint256 withdrawShares
    ) internal pure returns (uint256 newNav, uint256 newShares, uint256 withdrawAmount) {
        if (withdrawShares > shares) {
            revert SE.InsufficientShares(withdrawShares, shares);
        }
        
        // W = x · P (amount to pay out)
        // Round down payout to favor protocol
        withdrawAmount = withdrawShares.wMul(price);
        
        if (withdrawAmount > nav) {
            revert SE.InsufficientNAV(withdrawAmount, nav);
        }
        
        // N'' = N - x·P
        newNav = nav - withdrawAmount;
        
        // S'' = S - x
        newShares = shares - withdrawShares;
    }

    // ============================================================
    // Peak & Drawdown
    // ============================================================

    /**
     * @notice Update peak price (monotonically increasing)
     * @dev P^peak_t = max(P^peak_{t-1}, P_t)
     * @param currentPeak Previous peak price (WAD)
     * @param newPrice New price P_t (WAD)
     * @return updatedPeak Updated peak price (WAD)
     */
    function updatePeak(uint256 currentPeak, uint256 newPrice) internal pure returns (uint256 updatedPeak) {
        updatedPeak = newPrice > currentPeak ? newPrice : currentPeak;
    }

    /**
     * @notice Compute peak drawdown from peak
     * @dev DD_t = 1 - P_t / P^peak_t
     *      Returns 0 if price >= peak
     *      Returns WAD (100%) if price = 0 and peak > 0
     * @param price Current price P_t (WAD)
     * @param peak Peak price P^peak_t (WAD)
     * @return drawdown Peak drawdown (WAD, 0 to 1e18)
     */
    function computeDrawdown(uint256 price, uint256 peak) internal pure returns (uint256 drawdown) {
        if (peak == 0) {
            return 0;
        }
        if (price >= peak) {
            return 0;
        }
        // DD = 1 - P/P_peak = (P_peak - P) / P_peak
        drawdown = (peak - price).wDiv(peak);
    }

    // ============================================================
    // Full Batch Processing
    // ============================================================

    /**
     * @notice Compute final price from NAV and shares
     * @dev When shares=0 (empty vault), price defaults to 1.0 (WAD)
     *      This is an edge case that should rarely occur in practice.
     * @param nav Final NAV (WAD)
     * @param shares Final shares (WAD)
     * @return price Final price P_t (WAD)
     */
    function computePrice(uint256 nav, uint256 shares) internal pure returns (uint256 price) {
        if (shares == 0) {
            return WAD; // Default to 1.0 if no shares (empty vault)
        }
        price = nav.wDiv(shares);
    }

    /**
     * @notice Full post-batch state calculation
     * @dev When shares=0 (all LPs exited):
     *      - price defaults to 1.0 (WAD)
     *      - pricePeak is preserved from previous state
     *      - peak drawdown is set to 0 (no active LP exposure)
     * 
     *      This ensures peak drawdown-based calculations (like α_limit) don't
     *      produce misleading values when the vault is empty.
     * 
     * @param nav Final NAV after deposits/withdrawals
     * @param shares Final shares after deposits/withdrawals
     * @param previousPeak Previous peak price
     * @return state Complete post-batch state
     */
    function computePostBatchState(
        uint256 nav,
        uint256 shares,
        uint256 previousPeak
    ) internal pure returns (PostBatchState memory state) {
        state.nav = nav;
        state.shares = shares;
        
        if (shares == 0) {
            // Empty vault: preserve peak, set price to 1.0, drawdown to 0
            state.price = WAD;
            state.pricePeak = previousPeak;
            state.drawdown = 0;
        } else {
            state.price = computePrice(nav, shares);
            state.pricePeak = updatePeak(previousPeak, state.price);
            state.drawdown = computeDrawdown(state.price, state.pricePeak);
        }
    }
}
