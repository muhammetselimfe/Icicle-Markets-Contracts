// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Simple 6-decimal ERC20 for dev/test networks (payment token mock).
contract IcicleOptionsUSDToken is ERC20 {
    constructor() ERC20("Payment Token", "PAY") {
        _mint(msg.sender, 1_000_000_000 * 1e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
