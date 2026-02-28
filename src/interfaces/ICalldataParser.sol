// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICalldataParser {
    function extractInputTokens(address target, bytes calldata data) external view returns (address[] memory tokens);
    function extractInputAmounts(address target, bytes calldata data) external view returns (uint256[] memory amounts);
    function extractOutputTokens(address target, bytes calldata data) external view returns (address[] memory tokens);
    function extractRecipient(address target, bytes calldata data, address defaultRecipient) external view returns (address recipient);
    function supportsSelector(bytes4 selector) external pure returns (bool supported);
    function getOperationType(bytes calldata data) external pure returns (uint8 opType);
}
