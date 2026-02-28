// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IIntEOA {
    // ============ Events ============

    event EOARegistered(address indexed eoa);
    event EOARevoked(address indexed eoa);
    event TargetAllowed(address indexed eoa, address indexed target, bool allowed);
    event Executed(address indexed eoa, address indexed target, bytes4 selector, bool success);

    // ============ Core Functions ============

    function execute(
        address target,
        bytes calldata data
    ) external returns (bytes memory);

    function executeWithValue(
        address target,
        bytes calldata data
    ) external payable returns (bytes memory);

    // ============ View Functions ============

    function isRegisteredEOA(address eoa) external view returns (bool);
    function isAllowedTarget(address eoa, address target) external view returns (bool);
}
