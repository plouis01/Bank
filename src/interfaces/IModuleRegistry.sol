// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IModuleRegistry {
    struct ModuleInfo {
        address safeAddress;
        address authorizedOracle;
        uint256 deployedAt;
        bool isActive;
    }

    function registerModuleFromFactory(address module, address safe, address oracle) external;
    function getActiveModules() external view returns (address[] memory modules);
    function getActiveModulesPaginated(uint256 offset, uint256 limit) external view returns (address[] memory modules, uint256 total);
    function getModuleForSafe(address safe) external view returns (address module);
    function getActiveModuleCount() external view returns (uint256 count);
    function isRegistered(address module) external view returns (bool registered);
    function moduleInfo(address module) external view returns (ModuleInfo memory info);
}
