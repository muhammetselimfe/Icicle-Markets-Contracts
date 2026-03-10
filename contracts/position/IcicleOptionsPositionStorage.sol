// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IIcicleOptionsPosition.sol";

abstract contract IcicleOptionsPositionStorage {
    address public core;
    uint256 internal _nextId;
    mapping(uint256 => IIcicleOptionsPosition.Position) internal _positions;
    mapping(uint256 => uint256[]) internal _marketTokenList;
    mapping(uint256 => uint256) internal _positionMarketIndex;
    mapping(address => uint256[]) internal _ownerTokenList;
    mapping(uint256 => uint256) internal _positionOwnerIndex;

    // Reserve ample slots for future upgrades; do not change after first deployment.
    uint256[48] internal __gap;
}
