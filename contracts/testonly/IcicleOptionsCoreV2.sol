// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../core/IcicleOptionsCore.sol";

/// @notice Test-only IcicleOptionsCore upgrade target with a new function.
contract IcicleOptionsCoreV2 is IcicleOptionsCore {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
