// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../modules/TradeModule.sol";
import "../lib/TickBinLib.sol";

/// @notice Harness to expose TradeModule validation helpers for testing.
contract TradeModuleHarness is TradeModule {
    /// @notice Set a market struct directly for testing.
    function setMarket(uint256 marketId, IIcicleOptionsCore.Market calldata market) external {
        markets[marketId] = market;
    }

    /// @notice Expose market existence check.
    function exposedMarketExists(uint256 marketId) external view returns (bool) {
        return _marketExists(marketId);
    }

    /// @notice Expose shared market validation (active + time).
    function exposedLoadAndValidateMarket(uint256 marketId)
        external
        view
        returns (IIcicleOptionsCore.Market memory)
    {
        IIcicleOptionsCore.Market storage market = _loadAndValidateMarket(marketId);
        return market;
    }

    /// @notice Expose tick range validation via TickBinLib.ticksToBins.
    function exposedValidateTickRange(
        int256 lowerTick,
        int256 upperTick,
        uint256 marketId
    ) external view {
        IIcicleOptionsCore.Market storage market = markets[marketId];
        // TickBinLib.ticksToBins validates tick range internally
        TickBinLib.ticksToBins(
            market.minTick, market.maxTick, market.tickSpacing, market.numBins,
            lowerTick, upperTick
        );
    }
}
