// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IIcicleOptionsLPShare
/// @notice Interface for LP Share token (ERC-20 + ERC-4626 compatible)
interface IIcicleOptionsLPShare {
    /// @notice Mint shares to user (only callable by Core)
    function mint(address to, uint256 shares) external;
    
    /// @notice Burn shares from user (only callable by Core)
    function burn(address from, uint256 shares) external;
    
    /// @notice Get the underlying asset address
    function getAsset() external view returns (address);
    
    /// @notice Get total assets under management
    function totalAssets() external view returns (uint256);
    
    /// @notice Convert assets to shares at current price
    function convertToShares(uint256 assets) external view returns (uint256);
    
    /// @notice Convert shares to assets at current price
    function convertToAssets(uint256 shares) external view returns (uint256);
    
    /// @notice Preview deposit - expected shares
    function previewDeposit(uint256 assets) external view returns (uint256);
    
    /// @notice Preview redeem - expected assets
    function previewRedeem(uint256 shares) external view returns (uint256);
}

