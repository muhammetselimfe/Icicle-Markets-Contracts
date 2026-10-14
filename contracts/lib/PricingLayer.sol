// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixedPointMathU} from "./FixedPointMathU.sol";
import {LazyMulSegmentTree} from "./LazyMulSegmentTree.sol";
import {ClmsrMath} from "./ClmsrMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PricingLayer
/// @notice Oracle-anchored, volatility-adaptive CLMSR prior (dynamic pricing).
/// @dev effectiveFactor[i] = baseFactor_t[i] * tradeFactor[i].
///      tradeFactor lives in the LazyMulSegmentTree (unchanged); baseFactor_t is a
///      pure function of (center_t, sigma_t, floor) recomputed per trade and never
///      stored per-bin. The CLMSR cost (alpha*ln(Z'/Z)) is unchanged in ClmsrMath;
///      only the Z it is fed becomes the effective Zeff computed here.
///      Math verified on-chain in PricingLayerHarness against the real ClmsrMath.
library PricingLayer {
    using FixedPointMathU for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_EXP_INPUT_WAD = 133_084258667509499440;
    /// @dev sqrt(2*pi) in WAD — a Gaussian bell's mass is ~ sigma*sqrt(2pi) (in bins).
    uint256 internal constant SQRT_2PI_WAD = 2_506628274631000502;
    /// @dev Absolute bounds for the derived floor: keeps wExp/wDiv precision sane and the
    ///      bell meaningful (the floor can never reach the peak).
    uint256 internal constant FLOOR_ABS_MIN_WAD = 1e12;   // 1e-6
    uint256 internal constant FLOOR_ABS_MAX_WAD = 5e17;   // 0.5
    uint256 internal constant TAU_MIN_WAD = 1e15;         // 0.1 % tail mass
    uint256 internal constant TAU_MAX_WAD = 2e17;         // 20 % tail mass

    /// @notice v2.1 floor as a TAIL-MASS BUDGET: floor_t = τ · σ_t · √(2π) / (numBins − 1).
    /// @dev A fixed floor lets the (n−1) tail bins outweigh the bell as σ shrinks (at σ=0.75,
    ///      floor=0.05, n=80 the tails hold ~68 % of the prior mass and the modal bin is priced
    ///      ~3x too cheap). Deriving the floor from σ keeps the tails at ≈ τ of total mass at
    ///      every σ, so the modal bin tracks the Gaussian. Clamped to [FLOOR_ABS_MIN, FLOOR_ABS_MAX].
    function floorFromTau(uint256 tauWad, uint256 sigmaW, uint32 numBins) internal pure returns (uint256 f) {
        if (numBins <= 1) return FLOOR_ABS_MAX_WAD;
        f = tauWad.wMul(sigmaW).wMul(SQRT_2PI_WAD) / (uint256(numBins) - 1);
        if (f < FLOOR_ABS_MIN_WAD) f = FLOOR_ABS_MIN_WAD;
        if (f > FLOOR_ABS_MAX_WAD) f = FLOOR_ABS_MAX_WAD;
    }

    /// @notice Per-market dynamic pricing config (stored in the Market struct).
    struct Config {
        uint256 w;            // anchoring weight, WAD in [0,1e18]. 1e18 = full oracle tracking
        uint256 volBinsWad;   // terminal-price std in bins, WAD
        uint256 sigmaMinWad;  // min bell width (bins), WAD  (prevents degenerate spike)
        uint256 sigmaMaxWad;  // max bell width (bins), WAD  (opening width cap)
        uint256 floorWad;     // min base factor, WAD (>= tree MIN_FACTOR)
    }

    /// @notice Gaussian base factor for one bin (WAD), floored.
    /// @dev exp(-x) = WAD / exp(x) since FixedPointMathU.wExp takes non-negative input.
    function bellFactor(uint32 bin, uint256 centerW, uint256 sigmaW, uint256 floorWad)
        internal
        pure
        returns (uint256)
    {
        uint256 iWad = uint256(bin) * WAD;
        uint256 dWad = iWad > centerW ? iWad - centerW : centerW - iWad;
        uint256 dSq = dWad.wMul(dWad);
        uint256 twoSigSq = 2 * sigmaW.wMul(sigmaW); // sigmaW floored > 0 by sigmaWad()
        uint256 xWad = dSq.wDiv(twoSigSq);
        if (xWad >= MAX_EXP_INPUT_WAD) return floorWad; // exp(-large) -> ~0 -> floor
        uint256 f = WAD.wDiv(FixedPointMathU.wExp(xWad));
        return f > floorWad ? f : floorWad;
    }

    /// @notice Blended center bin in WAD bin-units: (1-w)*anchor + w*oracle.
    function centerWad(uint32 anchorBin, uint32 oracleBin, uint256 w) internal pure returns (uint256) {
        uint256 anchorW = uint256(anchorBin) * WAD;
        uint256 oracleW = uint256(oracleBin) * WAD;
        return (WAD - w).wMul(anchorW) + w.wMul(oracleW);
    }

    /// @notice sigma_t (WAD bins) = clamp(volBins * sqrt(remaining/total), min, max).
    /// @dev Narrows toward settlement so the modal bin is priced at its true (rising) prob.
    function sigmaWad(Config memory cfg, uint64 nowTs, uint64 startTs, uint64 endTs)
        internal
        pure
        returns (uint256 s)
    {
        uint64 total = endTs > startTs ? endTs - startTs : 0;
        uint64 remaining = nowTs >= endTs ? 0 : endTs - nowTs;
        uint256 tauWad = total == 0 ? 0 : (uint256(remaining) * WAD) / total;
        uint256 sqrtTau = Math.sqrt(tauWad * WAD); // sqrt(tau) * WAD
        s = cfg.volBinsWad.wMul(sqrtTau);
        if (s < cfg.sigmaMinWad) s = cfg.sigmaMinWad;
        if (s > cfg.sigmaMaxWad) s = cfg.sigmaMaxWad;
    }

    /// @notice Map an oracle tick to a bin index, clamped to [0, numBins-1].
    function oracleBin(int256 tick, int256 minTick, int256 tickSpacing, uint32 numBins)
        internal
        pure
        returns (uint32)
    {
        if (tick <= minTick) return 0;
        uint256 b = uint256(tick - minTick) / uint256(tickSpacing);
        return b >= numBins ? numBins - 1 : uint32(b);
    }

    /// @notice Effective partition function Zeff = sum_i baseFactor_t[i] * tradeFactor[i].
    /// @dev Reads each leaf's trade factor via the tree's getRangeSum(i,i). O(n) leaf
    ///      reads (n <= 256). Caller supplies the pre-computed center/sigma.
    function computeZeff(
        LazyMulSegmentTree.Tree storage tree,
        uint32 numBins,
        uint256 centerW,
        uint256 sigmaW,
        uint256 floorWad
    ) internal view returns (uint256 z) {
        for (uint32 i = 0; i < numBins; i++) {
            uint256 tradeFactor = LazyMulSegmentTree.getRangeSum(tree, i, i);
            z += bellFactor(i, centerW, sigmaW, floorWad).wMul(tradeFactor);
        }
    }

    /// @notice Sum of effective factors over [loBin,hiBin]: Σ base[i]*tradeFactor[i].
    function partialEff(
        LazyMulSegmentTree.Tree storage tree,
        uint32 loBin,
        uint32 hiBin,
        uint256 centerW,
        uint256 sigmaW,
        uint256 floorWad
    ) internal view returns (uint256 s) {
        for (uint32 i = loBin; i <= hiBin; i++) {
            s += bellFactor(i, centerW, sigmaW, floorWad).wMul(LazyMulSegmentTree.getRangeSum(tree, i, i));
        }
    }

    /// @notice VIEW quote (no mutation) matching execution exactly:
    ///         zAfter = zBefore + partial*(factor-1). Buy: factor = exp(q/alpha).
    /// @dev q assumed within one safe chunk (exp(q/alpha) bounded); large q is chunked
    ///      on the execution path. For typical quotes this is exact.
    function quoteBuyView(
        LazyMulSegmentTree.Tree storage tree,
        uint32 numBins,
        uint32 loBin,
        uint32 hiBin,
        uint256 qWad,
        uint256 alpha,
        uint256 centerW,
        uint256 sigmaW,
        uint256 floorWad
    ) internal view returns (uint256 costWad) {
        uint256 zBefore = computeZeff(tree, numBins, centerW, sigmaW, floorWad);
        uint256 factor = FixedPointMathU.wExp(qWad.wDiv(alpha)); // > WAD
        uint256 ps = partialEff(tree, loBin, hiBin, centerW, sigmaW, floorWad);
        uint256 zAfter = zBefore + ps.wMul(factor - WAD);
        costWad = ClmsrMath.computeBuyCostFromSumChange(alpha, zBefore, zAfter);
    }

    /// @notice VIEW sell quote. Sell: factor = exp(-q/alpha) = WAD/exp(q/alpha) < WAD.
    function quoteSellView(
        LazyMulSegmentTree.Tree storage tree,
        uint32 numBins,
        uint32 loBin,
        uint32 hiBin,
        uint256 qWad,
        uint256 alpha,
        uint256 centerW,
        uint256 sigmaW,
        uint256 floorWad
    ) internal view returns (uint256 proceedsWad) {
        uint256 zBefore = computeZeff(tree, numBins, centerW, sigmaW, floorWad);
        uint256 factor = WAD.wDiv(FixedPointMathU.wExp(qWad.wDiv(alpha))); // < WAD
        uint256 ps = partialEff(tree, loBin, hiBin, centerW, sigmaW, floorWad);
        uint256 reduction = ps.wMul(WAD - factor);
        uint256 zAfter = zBefore > reduction ? zBefore - reduction : 0;
        proceedsWad = ClmsrMath.computeSellProceedsFromSumChange(alpha, zBefore, zAfter);
    }
}
