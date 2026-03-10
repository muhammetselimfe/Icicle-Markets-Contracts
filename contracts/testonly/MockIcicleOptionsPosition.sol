// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IIcicleOptionsPosition.sol";

/// @notice Minimal mock position (ERC721-like) for testing TradeModule flows.
contract MockIcicleOptionsPosition is IIcicleOptionsPosition {
    event PositionMinted(uint256 indexed positionId, address owner);

    struct MinimalPosition {
        uint256 marketId;
        int256 lowerTick;
        int256 upperTick;
        uint128 quantity;
        address owner;
    }

    uint256 internal _nextId = 1;
    mapping(uint256 => MinimalPosition) internal _positions;

    function core() external pure returns (address) {
        return address(0);
    }

    function nextId() external view returns (uint256) {
        return _nextId;
    }

    function mintPosition(
        address trader,
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) external returns (uint256 positionId) {
        positionId = _nextId++;
        _positions[positionId] = MinimalPosition({
            marketId: marketId,
            lowerTick: lowerTick,
            upperTick: upperTick,
            quantity: quantity,
            owner: trader
        });
        emit PositionMinted(positionId, trader);
    }

    function burn(uint256 positionId) external {
        delete _positions[positionId];
    }

    function updateQuantity(uint256 positionId, uint128 newQuantity) external {
        MinimalPosition storage p = _positions[positionId];
        p.quantity = newQuantity;
    }

    function getPosition(uint256 positionId) external view returns (IIcicleOptionsPosition.Position memory position) {
        MinimalPosition memory p = _positions[positionId];
        position = IIcicleOptionsPosition.Position({
            marketId: p.marketId,
            lowerTick: p.lowerTick,
            upperTick: p.upperTick,
            quantity: p.quantity,
            createdAt: 0
        });
    }

    function exists(uint256 positionId) external view returns (bool) {
        return _positions[positionId].owner != address(0);
    }

    function ownerOf(uint256 positionId) external view returns (address) {
        return _positions[positionId].owner;
    }

    function getPositionsByOwner(address) external pure returns (uint256[] memory positions_) {
        positions_ = new uint256[](0);
    }

    function getMarketTokenLength(uint256) external pure returns (uint256 length) {
        length = 0;
    }

    function getMarketTokenAt(uint256, uint256) external pure returns (uint256 tokenId) {
        tokenId = 0;
    }

    function getMarketPositions(uint256) external pure returns (uint256[] memory tokenIds) {
        tokenIds = new uint256[](0);
    }

    function getUserPositionsInMarket(address, uint256) external pure returns (uint256[] memory tokenIds) {
        tokenIds = new uint256[](0);
    }

    /// @notice Test helper to mint a position with a specific ID
    /// @dev Used in TDD tests to control position IDs
    function mockMint(
        address trader,
        uint256 positionId,
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) external {
        _positions[positionId] = MinimalPosition({
            marketId: marketId,
            lowerTick: lowerTick,
            upperTick: upperTick,
            quantity: quantity,
            owner: trader
        });
        if (positionId >= _nextId) {
            _nextId = positionId + 1;
        }
        emit PositionMinted(positionId, trader);
    }
}
