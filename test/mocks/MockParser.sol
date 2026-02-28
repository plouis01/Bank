// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockParser {
    bytes4 constant DEPOSIT_SELECTOR = bytes4(keccak256("deposit(uint256,address)"));
    bytes4 constant WITHDRAW_SELECTOR = bytes4(keccak256("withdraw(uint256,address)"));

    address public tokenAddress;

    constructor(address _token) {
        tokenAddress = _token;
    }

    function extractInputTokens(address, bytes calldata) external view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = tokenAddress;
        return tokens;
    }

    function extractInputAmounts(address, bytes calldata data) external pure returns (uint256[] memory amounts) {
        (uint256 amount,) = abi.decode(data[4:], (uint256, address));
        amounts = new uint256[](1);
        amounts[0] = amount;
        return amounts;
    }

    function extractOutputTokens(address, bytes calldata) external view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = tokenAddress;
        return tokens;
    }

    function extractRecipient(address, bytes calldata data, address) external pure returns (address recipient) {
        (, recipient) = abi.decode(data[4:], (uint256, address));
    }

    function supportsSelector(bytes4 selector) external pure returns (bool) {
        return selector == DEPOSIT_SELECTOR || selector == WITHDRAW_SELECTOR;
    }

    function getOperationType(bytes calldata data) external pure returns (uint8) {
        bytes4 selector = bytes4(data[:4]);
        if (selector == DEPOSIT_SELECTOR) return 2;
        if (selector == WITHDRAW_SELECTOR) return 3;
        return 0;
    }
}
