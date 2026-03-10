// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";
import {RiskMath} from "./RiskMath.sol";

/// @notice Helper library for reading factor arrays from SeedData contracts.
/// @dev SeedData runtime code is raw packed uint256 values (numBins * 32 bytes).
library SeedDataLib {
    function codeSize(address seedData) internal view returns (uint256 size) {
        assembly ("memory-safe") {
            size := extcodesize(seedData)
        }
    }

    function validateSeedData(address seedData, uint32 numBins) internal view {
        if (seedData == address(0)) revert SE.ZeroAddress();

        uint256 expectedBytes = uint256(numBins) * 32;
        uint256 providedBytes = codeSize(seedData);
        if (providedBytes != expectedBytes) {
            revert SE.SeedDataLengthMismatch(providedBytes, expectedBytes);
        }
    }

    function readFactors(
        address seedData,
        uint32 start,
        uint32 count
    ) internal view returns (uint256[] memory factors) {
        factors = new uint256[](count);
        if (count == 0) {
            return factors;
        }

        uint256 offset = uint256(start) * 32;
        uint256 size = uint256(count) * 32;
        assembly ("memory-safe") {
            extcodecopy(seedData, add(factors, 32), offset, size)
        }
    }

    function computeSeedStats(
        address seedData,
        uint32 numBins,
        uint256 liquidityParameter
    ) internal view returns (uint256 rootSum, uint256 minFactor, uint256 deltaEt) {
        validateSeedData(seedData, numBins);
        if (numBins == 0) {
            return (0, 0, 0);
        }

        uint256[] memory factors = readFactors(seedData, 0, numBins);
        (rootSum, minFactor) = _computeRootSumMin(factors);
        deltaEt = RiskMath.calculateDeltaEt(liquidityParameter, numBins, rootSum, minFactor);
    }

    function _computeRootSumMin(
        uint256[] memory factors
    ) private pure returns (uint256 rootSum, uint256 minFactor) {
        if (factors.length == 0) {
            return (0, 0);
        }

        minFactor = type(uint256).max;
        for (uint256 i = 0; i < factors.length; i++) {
            uint256 factor = factors[i];
            if (factor == 0) revert SE.InvalidFactor(factor);
            if (factor < minFactor) minFactor = factor;
            rootSum += factor;
        }
    }
}
