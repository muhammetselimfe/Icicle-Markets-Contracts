// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/Create2.sol";
import "../errors/IcicleOptionsErrors.sol";

/// @notice Permissioned CREATE2 factory for deterministic deployments.
contract IcicleOptionsCreate2Factory is IcicleOptionsErrors {
    address public immutable allowedDeployer;

    constructor(address allowedDeployer_) {
        if (allowedDeployer_ == address(0)) revert ZeroAddress();
        allowedDeployer = allowedDeployer_;
    }

    function deploy(bytes32 salt, bytes memory initCode) external returns (address deployed) {
        if (msg.sender != allowedDeployer) revert UnauthorizedCaller(msg.sender);
        deployed = Create2.deploy(0, salt, initCode);
    }

    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return Create2.computeAddress(salt, initCodeHash);
    }
}
