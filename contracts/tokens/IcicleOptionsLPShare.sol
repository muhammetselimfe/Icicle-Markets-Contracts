// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../errors/IcicleOptionsErrors.sol";

/// @title IcicleOptionsLPShare
/// @notice ERC-4626 compliant LP share token for Icicle Options Protocol
/// @dev Adapts async batch model to ERC-4626 interface
///
///      Key differences from standard ERC-4626:
///      - deposit/mint → requestDeposit (returns 0, actual shares at claim)
///      - withdraw/redeem → requestWithdraw (returns 0, actual assets at claim)
///      - previewDeposit/previewRedeem → estimates at current batch price
///
///      The vault is the IcicleOptionsCore contract which holds actual NAV.
///      This token represents claims on the vault.
contract IcicleOptionsLPShare is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    IcicleOptionsErrors
{
    /// @notice The IcicleOptionsCore contract that manages the vault
    address public core;
    
    /// @notice The underlying asset (payment token)
    address public asset;

    modifier onlyCore() {
        if (msg.sender != core) revert IcicleOptionsErrors.OnlyCore();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address core_,
        address asset_,
        string memory name_,
        string memory symbol_,
        address ownerSafe_
    ) external initializer {
        if (core_ == address(0)) revert IcicleOptionsErrors.ZeroAddress();
        if (asset_ == address(0)) revert IcicleOptionsErrors.ZeroAddress();
        if (ownerSafe_ == address(0)) revert IcicleOptionsErrors.ZeroAddress();
        if (core_.code.length == 0 || asset_.code.length == 0) revert IcicleOptionsErrors.ModuleNotSet();
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __Ownable_init(ownerSafe_);
        __UUPSUpgradeable_init();
        core = core_;
        asset = asset_;
    }

    // ============================================================
    // Core-only Mint/Burn (called by LPVaultModule via delegatecall)
    // ============================================================

    /// @notice Mint shares to user after deposit claim
    /// @dev Only callable by Core (via LPVaultModule delegatecall)
    /// @param to Recipient address
    /// @param shares Amount of shares to mint
    function mint(address to, uint256 shares) external onlyCore {
        _mint(to, shares);
    }

    /// @notice Burn shares from user after withdraw claim
    /// @dev Only callable by Core (via LPVaultModule delegatecall)
    /// @param from Address to burn from
    /// @param shares Amount of shares to burn
    function burn(address from, uint256 shares) external onlyCore {
        _burn(from, shares);
    }

    // ============================================================
    // ERC-4626 View Functions (Informational)
    // ============================================================

    /// @notice Returns the underlying asset
    function getAsset() external view returns (address) {
        return asset;
    }

    /// @notice Total assets under management
    /// @dev Returns vault NAV from Core
    function totalAssets() external view returns (uint256) {
        // Call Core to get NAV
        (bool success, bytes memory data) = core.staticcall(
            abi.encodeWithSignature("getVaultNav()")
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        return 0;
    }

    /// @notice Convert assets to shares
    /// @dev Uses current batch price from Core
    function convertToShares(uint256 assets) external view returns (uint256) {
        uint256 price = _getVaultPrice();
        if (price == 0) return assets; // 1:1 if not seeded
        return (assets * 1e18) / price;
    }

    /// @notice Convert shares to assets
    /// @dev Uses current batch price from Core
    function convertToAssets(uint256 shares) external view returns (uint256) {
        uint256 price = _getVaultPrice();
        if (price == 0) return shares; // 1:1 if not seeded
        return (shares * price) / 1e18;
    }

    /// @notice Preview deposit - expected shares at current price
    /// @dev Note: Actual shares depend on batch price at claim time
    function previewDeposit(uint256 assets) external view returns (uint256) {
        uint256 price = _getVaultPrice();
        if (price == 0) return assets;
        return (assets * 1e18) / price;
    }

    /// @notice Preview redeem - expected assets at current price
    /// @dev Note: Actual assets depend on batch price at claim time
    function previewRedeem(uint256 shares) external view returns (uint256) {
        uint256 price = _getVaultPrice();
        if (price == 0) return shares;
        return (shares * price) / 1e18;
    }

    // ============================================================
    // ERC-4626 Deposit/Withdraw (Async - Reverts)
    // ============================================================

    /// @notice Standard deposit not supported - use requestDeposit on Core
    function deposit(uint256, address) external pure returns (uint256) {
        revert IcicleOptionsErrors.AsyncVaultUseRequestDeposit();
    }

    /// @notice Standard mint not supported - use requestDeposit on Core
    function mintShares(uint256, address) external pure returns (uint256) {
        revert IcicleOptionsErrors.AsyncVaultUseRequestDeposit();
    }

    /// @notice Standard withdraw not supported - use requestWithdraw on Core
    function withdraw(uint256, address, address) external pure returns (uint256) {
        revert IcicleOptionsErrors.AsyncVaultUseRequestWithdraw();
    }

    /// @notice Standard redeem not supported - use requestWithdraw on Core
    function redeem(uint256, address, address) external pure returns (uint256) {
        revert IcicleOptionsErrors.AsyncVaultUseRequestWithdraw();
    }

    // ============================================================
    // Internal Helpers
    // ============================================================

    /// @dev Get current vault price from Core
    function _getVaultPrice() internal view returns (uint256) {
        (bool success, bytes memory data) = core.staticcall(
            abi.encodeWithSignature("getVaultPrice()")
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        return 1e18; // Default 1:1
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
