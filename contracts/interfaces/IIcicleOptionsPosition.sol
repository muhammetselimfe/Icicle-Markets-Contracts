// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IIcicleOptionsPosition {
    struct Position {
        uint256 marketId;
        int256 lowerTick;
        int256 upperTick;
        uint128 quantity;
        uint64 createdAt;
    }

    function mintPosition(
        address trader,
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) external returns (uint256 positionId);

    function burn(uint256 positionId) external;

    function updateQuantity(uint256 positionId, uint128 newQuantity) external;

    function getPosition(uint256 positionId) external view returns (Position memory position);

    function exists(uint256 positionId) external view returns (bool);

    function ownerOf(uint256 positionId) external view returns (address);

    // Extended read API
    function getPositionsByOwner(address owner) external view returns (uint256[] memory positions);

    function getMarketTokenLength(uint256 marketId) external view returns (uint256 length);

    function getMarketTokenAt(uint256 marketId, uint256 index) external view returns (uint256 tokenId);

    function getMarketPositions(uint256 marketId) external view returns (uint256[] memory tokenIds);

    function getUserPositionsInMarket(address owner, uint256 marketId) external view returns (uint256[] memory tokenIds);

    function core() external view returns (address);

    function nextId() external view returns (uint256);
}
