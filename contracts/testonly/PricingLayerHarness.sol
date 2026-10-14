// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// TEST-ONLY harness. NOT a deployed protocol contract — lives in testonly/ next
// to the other mocks/harnesses (OracleModuleHarness, MockFeePolicy). It does NOT
// modify or touch any deployed contract. Purpose: prove the PricingLayer v2 math
// (oracle re-center + volatility-adaptive sigma -> effective Zeff) compiles and
// runs on-chain against the REAL ClmsrMath / FixedPointMathU, so the novel logic
// is verified before the (separate, multi-week) module integration.
//
// Self-contained: takes tradeFactors as an array instead of the live
// LazyMulSegmentTree, to isolate the pricing math from segment-tree integration.

import {FixedPointMathU} from "../lib/FixedPointMathU.sol";
import {ClmsrMath} from "../lib/ClmsrMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract PricingLayerHarness {
    using FixedPointMathU for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_EXP_INPUT_WAD = 133_084258667509499440;

    /// @notice Gaussian base factor for one bin (WAD), floored.
    /// @dev exp(-x) computed as WAD / exp(x) since wExp takes only non-negative input.
    function bellFactor(uint32 bin, uint256 centerWad, uint256 sigmaWad, uint256 floorWad)
        public
        pure
        returns (uint256)
    {
        return _bell(bin, centerWad, sigmaWad, floorWad);
    }

    function _bell(uint32 bin, uint256 centerWad, uint256 sigmaWad, uint256 floorWad)
        internal
        pure
        returns (uint256)
    {
        uint256 iWad = uint256(bin) * WAD;
        uint256 dWad = iWad > centerWad ? iWad - centerWad : centerWad - iWad;
        uint256 dSq = dWad.wMul(dWad);
        uint256 twoSigSq = 2 * sigmaWad.wMul(sigmaWad); // sigma floored > 0 by caller
        uint256 xWad = dSq.wDiv(twoSigSq);
        if (xWad >= MAX_EXP_INPUT_WAD) return floorWad; // exp(-large) -> ~0 -> floor
        uint256 f = WAD.wDiv(FixedPointMathU.wExp(xWad)); // exp(-x)
        return f > floorWad ? f : floorWad;
    }

    /// @notice Blended center bin in WAD bin-units: (1-w)*anchor + w*oracle.
    function centerWad(uint32 anchorBin, uint32 oracleBin, uint256 w) public pure returns (uint256) {
        uint256 anchorW = uint256(anchorBin) * WAD;
        uint256 oracleW = uint256(oracleBin) * WAD;
        return (WAD - w).wMul(anchorW) + w.wMul(oracleW);
    }

    /// @notice sigma_t (WAD bins) = clamp(volBins * sqrt(remaining/total), min, max).
    function sigmaWad(uint256 volBinsWad, uint64 remaining, uint64 total, uint256 sigmaMin, uint256 sigmaMax)
        public
        pure
        returns (uint256 s)
    {
        uint256 tauWad = total == 0 ? 0 : (uint256(remaining) * WAD) / total;
        uint256 sqrtTau = Math.sqrt(tauWad * WAD); // sqrt(tau) * WAD
        s = volBinsWad.wMul(sqrtTau);
        if (s < sigmaMin) s = sigmaMin;
        if (s > sigmaMax) s = sigmaMax;
    }

    /// @notice Effective partition function Zeff = sum_i base[i]*tradeFactor[i].
    function computeZeff(uint256[] calldata tradeFactors, uint256 centerW, uint256 sigmaW, uint256 floorWad)
        public
        pure
        returns (uint256 z)
    {
        for (uint32 i = 0; i < tradeFactors.length; i++) {
            z += _bell(i, centerW, sigmaW, floorWad).wMul(tradeFactors[i]);
        }
    }

    /// @notice Cost (WAD) to buy `qWad` over [loBin,hiBin] under the dynamic prior.
    /// @dev factor = exp(q/alpha) applied to the range; cost = alpha*ln(Zafter/Zbefore)
    ///      via the REAL ClmsrMath. (q assumed pre-chunked, exp(q/alpha) <= MAX_FACTOR.)
    function quoteBuyCost(
        uint256[] calldata tradeFactors,
        uint32 loBin,
        uint32 hiBin,
        uint256 qWad,
        uint256 alpha,
        uint256 centerW,
        uint256 sigmaW,
        uint256 floorWad
    ) external pure returns (uint256 cost, uint256 zBefore, uint256 zAfter) {
        zBefore = computeZeff(tradeFactors, centerW, sigmaW, floorWad);
        uint256 factor = FixedPointMathU.wExp(qWad.wDiv(alpha)); // > WAD for a buy
        uint256 partialSum;
        for (uint32 i = loBin; i <= hiBin; i++) {
            partialSum += _bell(i, centerW, sigmaW, floorWad).wMul(tradeFactors[i]);
        }
        zAfter = zBefore + partialSum.wMul(factor - WAD);
        cost = ClmsrMath.computeBuyCostFromSumChange(alpha, zBefore, zAfter);
    }

    /// @notice Implied price (probability) of a single bin under the dynamic prior.
    function impliedBinPrice(uint256[] calldata tradeFactors, uint32 bin, uint256 centerW, uint256 sigmaW, uint256 floorWad)
        external
        pure
        returns (uint256 priceWad)
    {
        uint256 z = computeZeff(tradeFactors, centerW, sigmaW, floorWad);
        uint256 num = _bell(bin, centerW, sigmaW, floorWad).wMul(tradeFactors[bin]);
        priceWad = num.wDiv(z);
    }
}
