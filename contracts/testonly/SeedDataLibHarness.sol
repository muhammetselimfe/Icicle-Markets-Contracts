// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../errors/IcicleOptionsErrors.sol";
import "../lib/SeedDataLib.sol";
import "../lib/RiskMath.sol";

/// @title SeedDataLibHarness
/// @notice Exposes SeedDataLib helpers for unit testing.
contract SeedDataLibHarness is IcicleOptionsErrors {
    function codeSize(address seedData) external view returns (uint256) {
        return SeedDataLib.codeSize(seedData);
    }

    function validateSeedData(address seedData, uint32 numBins) external view {
        SeedDataLib.validateSeedData(seedData, numBins);
    }

    function readFactors(
        address seedData,
        uint32 start,
        uint32 count
    ) external view returns (uint256[] memory) {
        return SeedDataLib.readFactors(seedData, start, count);
    }

    function computeSeedStats(
        address seedData,
        uint32 numBins,
        uint256 liquidityParameter
    ) external view returns (uint256 rootSum, uint256 minFactor, uint256 deltaEt) {
        return SeedDataLib.computeSeedStats(seedData, numBins, liquidityParameter);
    }

    function calculateDeltaEt(
        uint256 alpha,
        uint32 numBins,
        uint256 rootSum,
        uint256 minFactor
    ) external pure returns (uint256) {
        return RiskMath.calculateDeltaEt(alpha, numBins, rootSum, minFactor);
    }
}
