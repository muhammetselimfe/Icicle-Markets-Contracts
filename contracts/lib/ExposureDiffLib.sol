// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/**
 * @title ExposureDiffLib
 * @notice Diff-array based exposure tracking for O(1) range updates
 * @dev Replaces Fenwick tree for small bin counts (100-200 bins)
 *
 * Trade-off:
 *   - Update (rangeAdd): O(1) - exactly 2 storage writes
 *   - Query (pointQuery): O(n) - prefix sum up to bin
 *
 * This is optimal when:
 *   - Updates are frequent (every trade)
 *   - Queries are rare (only at settlement, once per market)
 *
 * Storage layout:
 *   - Uses existing _exposureDiff mapping as diff array
 *   - diff[bin] stores the delta at that bin boundary
 *   - Exposure at bin b = sum(diff[0..b])
 */
library ExposureDiffLib {
    /**
     * @notice Add delta to range [lo, hi] inclusive
     * @dev Diff array pattern: diff[lo] += delta, diff[hi+1] -= delta
     *      This results in exactly 2 SSTORE operations
     * @param diff The diff array storage (mapping bin => delta)
     * @param lo Lower bin index (inclusive)
     * @param hi Upper bin index (inclusive)
     * @param delta Value to add (can be negative for removal)
     * @param numBins Total number of bins in the market
     */
    function rangeAdd(
        mapping(uint32 => int256) storage diff,
        uint32 lo,
        uint32 hi,
        int256 delta,
        uint32 numBins
    ) internal {
        if (lo > hi) revert SE.ExposureDiffInvalidRange(int256(uint256(lo)), int256(uint256(hi)));
        if (hi >= numBins) revert SE.ExposureDiffBinOutOfBounds(int256(uint256(hi)), numBins);
        
        // Add delta at lo
        diff[lo] += delta;
        
        // Subtract delta at hi+1 (if within bounds)
        if (hi + 1 < numBins) {
            diff[hi + 1] -= delta;
        }
    }

    /**
     * @notice Query exposure at a specific bin
     * @dev Computes prefix sum: exposure[bin] = sum(diff[0..bin])
     *      O(n) complexity but only called once per market at settlement
     * @param diff The diff array storage
     * @param bin Bin index to query
     * @return exposure The accumulated exposure at this bin (must be >= 0)
     */
    function pointQuery(
        mapping(uint32 => int256) storage diff,
        uint32 bin
    ) internal view returns (uint256 exposure) {
        int256 sum = 0;
        for (uint32 i = 0; i <= bin; i++) {
            sum += diff[i];
        }
        
        // Exposure must be non-negative (invariant check)
        if (sum < 0) revert SE.ExposureDiffNegativeExposure(int256(uint256(bin)), sum);

        return uint256(sum);
    }

    /**
     * @notice Maximum exposure across bins [loBin, hiBin] (inclusive).
     * @dev Single prefix-sum pass from 0..hiBin, tracking the max within the range.
     *      Used by the per-bin exposure cap. O(hiBin).
     */
    function maxInRange(
        mapping(uint32 => int256) storage diff,
        uint32 loBin,
        uint32 hiBin
    ) internal view returns (uint256 maxExposure) {
        int256 sum = 0;
        for (uint32 i = 0; i <= hiBin; i++) {
            sum += diff[i];
            if (i >= loBin) {
                if (sum < 0) revert SE.ExposureDiffNegativeExposure(int256(uint256(i)), sum);
                if (uint256(sum) > maxExposure) maxExposure = uint256(sum);
            }
        }
    }
}

