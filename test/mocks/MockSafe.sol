// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISafe} from "../../src/interfaces/ISafe.sol";

contract MockSafe {
    mapping(address => bool) public enabledModules;
    address[] public owners;
    uint256 public threshold;

    constructor(address[] memory _owners, uint256 _threshold) {
        owners = _owners;
        threshold = _threshold;
    }

    function enableModule(address module) external {
        enabledModules[module] = true;
    }

    function disableModule(address, address module) external {
        enabledModules[module] = false;
    }

    function isModuleEnabled(address module) external view returns (bool) {
        return enabledModules[module];
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        ISafe.Operation
    ) external returns (bool) {
        (bool success,) = to.call{value: value}(data);
        return success;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    receive() external payable {}
}
