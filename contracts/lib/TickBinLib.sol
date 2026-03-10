// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/**
 * @title TickBinLib
 * @notice Library for converting between ticks and bin indices
 * @dev Centralizes tick-to-bin conversion logic used across modules
 *
 * Tick System:
 *   - Market has range [minTick, maxTick] with tickSpacing
 *   - Bins are 0-based indices: bin = (tick - minTick) / tickSpacing
 *   - Total bins = numBins (set at market creation)
 *
 * Trade Ranges:
 *   - Positions use [lowerTick, upperTick) convention (lower inclusive, upper exclusive)
 *   - Converted to [loBin, hiBin] inclusive for internal operations
 */
library TickBinLib {
    /**
     * @notice Convert a single tick to bin index
     * @param minTick Market minimum tick
     * @param tickSpacing Market tick spacing
     * @param numBins Market number of bins
     * @param tick The tick value to convert (must be aligned to tickSpacing)
     * @return bin The 0-based bin index
     */
    function tickToBin(
        int256 minTick,
        int256 tickSpacing,
        uint32 numBins,
        int256 tick
    ) internal pure returns (uint32 bin) {
        int256 offset = tick - minTick;

        // Tick must be >= minTick and aligned to tickSpacing
        if (offset < 0 || offset % tickSpacing != 0) {
            revert SE.InvalidTickSpacing(tick, tickSpacing);
        }

        int256 rawBin = offset / tickSpacing;
        if (rawBin > int256(uint256(type(uint32).max))) {
            revert SE.RangeBinOutOfBounds(rawBin, numBins);
        }

        bin = uint32(uint256(rawBin));

        // Bin must be within valid range
        if (bin >= numBins) {
            revert SE.RangeBinsOutOfBounds(bin, bin, numBins);
        }
    }

    /**
     * @notice Convert tick range [lowerTick, upperTick) to inclusive bin range [loBin, hiBin]
     * @dev lowerTick is inclusive, upperTick is exclusive (standard range convention)
     * @param minTick Market minimum tick
     * @param maxTick Market maximum tick
     * @param tickSpacing Market tick spacing
     * @param numBins Market number of bins
     * @param lowerTick Lower bound (inclusive)
     * @param upperTick Upper bound (exclusive)
     * @return loBin Lower bin index (inclusive)
     * @return hiBin Upper bin index (inclusive)
     */
    function ticksToBins(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint32 numBins,
        int256 lowerTick,
        int256 upperTick
    ) internal pure returns (uint32 loBin, uint32 hiBin) {
        // Validate tick range
        if (lowerTick >= upperTick) {
            revert SE.InvalidTickRange(lowerTick, upperTick);
        }
        if (lowerTick < minTick) {
            revert SE.InvalidTick(lowerTick, minTick, maxTick);
        }
        if (upperTick > maxTick + tickSpacing) {
            revert SE.InvalidTick(upperTick, minTick, maxTick);
        }

        // Check alignment
        if ((lowerTick - minTick) % tickSpacing != 0) {
            revert SE.InvalidTickSpacing(lowerTick, tickSpacing);
        }
        if ((upperTick - minTick) % tickSpacing != 0) {
            revert SE.InvalidTickSpacing(upperTick, tickSpacing);
        }

        // Convert to 0-based bin indices
        int256 loRaw = (lowerTick - minTick) / tickSpacing;
        int256 hiExclusiveRaw = (upperTick - minTick) / tickSpacing;
        int256 hiRaw = hiExclusiveRaw - 1;

        if (loRaw > int256(uint256(type(uint32).max))) {
            revert SE.RangeBinOutOfBounds(loRaw, numBins);
        }
        if (hiRaw > int256(uint256(type(uint32).max))) {
            revert SE.RangeBinOutOfBounds(hiRaw, numBins);
        }

        loBin = uint32(uint256(loRaw));
        hiBin = uint32(uint256(hiRaw));

        // Validate bin range
        if (loBin > hiBin) {
            revert SE.InvalidRangeBins(loBin, hiBin);
        }
        if (hiBin >= numBins) {
            revert SE.RangeBinsOutOfBounds(loBin, hiBin, numBins);
        }
    }
}
