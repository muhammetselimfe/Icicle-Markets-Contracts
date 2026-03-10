// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./FixedPointMathU.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/// @title FeeWaterfallLib
/// @notice Pure library implementing the Fee Waterfall algorithm
/// @dev All calculations use WAD (1e18) fixed-point arithmetic
library FeeWaterfallLib {
    using FixedPointMathU for uint256;

    uint256 internal constant WAD = 1e18;

    // ============================================================
    // Structs
    // ============================================================

    /// @notice Input parameters for Fee Waterfall calculation
    struct Params {
        int256 Lt;           // P&L (signed, WAD)
        uint256 Ftot;        // Total gross fees (WAD)
        uint256 Nprev;       // Previous NAV (WAD)
        uint256 Bprev;       // Previous Backstop NAV (WAD)
        uint256 Tprev;       // Previous Treasury NAV (WAD)
        uint256 deltaEt;     // Available backstop support limit (WAD)
        int256 pdd;          // NAV loss floor (negative WAD, pdd := -lambda, e.g., -0.3e18)
        uint256 rhoBS;       // Backstop coverage ratio (WAD)
        uint256 phiLP;       // LP fee share (WAD)
        uint256 phiBS;       // Backstop fee share (WAD)
        uint256 phiTR;       // Treasury fee share (WAD)
    }

    /// @notice Output result from Fee Waterfall calculation
    struct Result {
        // Intermediate values (for audit trail)
        uint256 Floss;       // Loss compensation fee
        uint256 Fpool;       // Remaining fee pool after loss compensation
        uint256 Nraw;        // NAV after loss compensation (before grant)
        uint256 Gt;          // Backstop grant
        uint256 Ffill;       // Backstop coverage fill
        uint256 Fdust;       // Rounding dust (goes to LP)
        
        // Final output values
        uint256 Ft;          // Total fee to LP (Floss + FcoreLP + Fdust)
        uint256 Npre;        // Pre-batch NAV (for VaultAccountingLib)
        uint256 Bnext;       // New Backstop NAV
        uint256 Tnext;       // New Treasury NAV
    }

    // ============================================================
    // Main Function
    // ============================================================

    /// @notice Apply Fee Waterfall algorithm
    /// @param p Input parameters
    /// @return r Output result
    function calculate(Params memory p) internal pure returns (Result memory r) {
        // Validate inputs
        // pdd must be in range (-WAD, 0) - i.e., max 100% NAV loss floor
        if (p.pdd >= 0 || p.pdd < -int256(WAD)) revert SE.InvalidDrawdownFloor(p.pdd);
        
        uint256 phiSum = p.phiLP + p.phiBS + p.phiTR;
        if (phiSum != WAD) revert SE.InvalidPhiSum(phiSum);

        // ========================================
        // Step 1: Loss Compensation
        // ========================================
        // L⁻t = max(0, -Lt)
        uint256 Lneg = p.Lt < 0 ? uint256(-p.Lt) : 0;
        
        // Floss = min(Ftot, L⁻t)
        r.Floss = Lneg < p.Ftot ? Lneg : p.Ftot;
        
        // Fpool = Ftot - Floss
        r.Fpool = p.Ftot - r.Floss;
        
        // Nraw = Nprev + Lt + Floss
        // Note: Lt can be negative, so we handle carefully
        if (p.Lt >= 0) {
            r.Nraw = p.Nprev + uint256(p.Lt) + r.Floss;
        } else {
            uint256 loss = uint256(-p.Lt);
            // Nraw = Nprev - |Lt| + Floss
            // Since Floss <= |Lt|, this could underflow without the loss compensation
            // But loss compensation ensures: Nraw = Nprev - |Lt| + min(Ftot, |Lt|)
            // = Nprev - max(0, |Lt| - Ftot)
            r.Nraw = p.Nprev + r.Floss;
            if (r.Nraw >= loss) {
                r.Nraw = r.Nraw - loss;
            } else {
                // Catastrophic loss: loss > Nprev + Floss
                // This should never happen if risk limits are enforced
                revert SE.CatastrophicLoss(loss, r.Nraw);
            }
        }

        // ========================================
        // Step 2: NAV Floor & Grant
        // ========================================
        // Nfloor = Nprev × (1 + pdd)
        // Note: this is the NAV floor (loss limit), not peak drawdown.
        // Since pdd is negative, (WAD + pdd) < WAD
        // G^need_t := max{0, ⌈G^min_t⌉} requires ceil semantics
        // We use wMulUp for Nfloor to ensure conservative (higher) floor calculation
        uint256 Nfloor;
        if (p.Nprev > 0) {
            int256 wadPlusPdd = int256(WAD) + p.pdd;
            if (wadPlusPdd > 0) {
                // Use wMulUp (ceil) to ensure Nfloor is conservatively high
                Nfloor = p.Nprev.wMulUp(uint256(wadPlusPdd));
            } else {
                Nfloor = 0;
            }
        } else {
            Nfloor = 0;
        }

        // grantNeed = max(0, Nfloor - Nraw)
        // The ceil is achieved by using wMulUp in Nfloor calculation above
        uint256 grantNeed;
        if (Nfloor > r.Nraw) {
            grantNeed = Nfloor - r.Nraw;
        } else {
            grantNeed = 0;
        }
        
        // Safety invariant: if G^need_t > ΔE_t, batch must revert
        if (grantNeed > p.deltaEt) {
            revert SE.GrantExceedsTailBudget(grantNeed, p.deltaEt);
        }
        
        // Gt = grantNeed (no capping - either we can afford it or we revert)
        r.Gt = grantNeed;
        
        // Check Backstop has enough for grant
        if (r.Gt > p.Bprev) {
            revert SE.InsufficientBackstopForGrant(r.Gt, p.Bprev);
        }
        
        // Ngrant = Nraw + Gt
        uint256 Ngrant = r.Nraw + r.Gt;
        
        // Bgrant = Bprev - Gt
        uint256 Bgrant = p.Bprev - r.Gt;

        // ========================================
        // Step 3: Backstop Coverage Target
        // ========================================
        // Btarget = rhoBS × Ngrant
        uint256 Btarget = Ngrant.wMul(p.rhoBS);
        
        // dBneed = max(0, Btarget - Bgrant)
        uint256 dBneed = Btarget > Bgrant ? Btarget - Bgrant : 0;
        
        // Ffill = min(dBneed, Fpool)
        r.Ffill = dBneed < r.Fpool ? dBneed : r.Fpool;
        
        // Fremain = Fpool - Ffill
        uint256 Fremain = r.Fpool - r.Ffill;

        // ========================================
        // Step 4: Residual Split
        // ========================================
        // FcoreLP = floor(Fremain × phiLP / WAD)
        uint256 FcoreLP = Fremain.wMul(p.phiLP);
        
        // FcoreBS = floor(Fremain × phiBS / WAD)
        uint256 FcoreBS = Fremain.wMul(p.phiBS);
        
        // FcoreTR = floor(Fremain × phiTR / WAD)
        uint256 FcoreTR = Fremain.wMul(p.phiTR);
        
        // Fdust = Fremain - FcoreLP - FcoreBS - FcoreTR (dust goes to LP)
        r.Fdust = Fremain - FcoreLP - FcoreBS - FcoreTR;

        // ========================================
        // Step 5: Final Output Values
        // ========================================
        // Ft = Floss + FcoreLP + Fdust (total to LP)
        r.Ft = r.Floss + FcoreLP + r.Fdust;
        
        // Npre = Ngrant + FcoreLP + Fdust (pre-batch NAV for VaultAccountingLib)
        // N^pre_t = N_{t-1} + L_t + F_t + G_t where F_t = F_loss + F_core_LP + F_dust
        r.Npre = Ngrant + FcoreLP + r.Fdust;
        
        // Bnext = Bgrant + Ffill + FcoreBS
        r.Bnext = Bgrant + r.Ffill + FcoreBS;
        
        // Tnext = Tprev + FcoreTR
        r.Tnext = p.Tprev + FcoreTR;
    }
}
