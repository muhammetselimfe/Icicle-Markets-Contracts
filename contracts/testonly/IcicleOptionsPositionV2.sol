// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../position/IcicleOptionsPosition.sol";

/// @notice Test-only IcicleOptionsPosition upgrade target with a new function.
contract IcicleOptionsPositionV2 is IcicleOptionsPosition {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
