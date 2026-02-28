// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {IIntEOA} from "./interfaces/IIntEOA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title IntEOA
 * @notice EOA extension module for M2 client Safes.
 *
 * @dev Allows registered EOA subaccounts to execute transactions through the
 *      M2 Safe without requiring the full 3/3 multisig. The module itself
 *      enforces access control — only registered EOAs can call, and only to
 *      allowed target addresses (other modules, DeFi protocols).
 *
 *      Call chain: EOA → IntEOA.execute() → M2 Safe.execTransactionFromModule() → target
 *
 *      This is the on-ramp for Path A (daily operations):
 *      - EOA → IntEOA → SpendInteractor.authorizeSpend() (spending)
 *      - EOA → IntEOA → DeFiInteractor.executeOnProtocol() (DeFi)
 *
 *      Security: IntEOA only forwards calls to explicitly whitelisted targets.
 *      The target modules (SpendInteractor, DeFiInteractor) perform their own
 *      validation (limits, types, allowlists) as a second layer of defense.
 */
contract IntEOA is Module, ReentrancyGuard, Pausable, IIntEOA {
    // ============ State ============

    /// @notice Registered EOAs that can call through this module
    mapping(address => bool) public registeredEOAs;

    /// @notice Per-EOA allowed target addresses
    mapping(address => mapping(address => bool)) public allowedTargets;

    /// @notice List of registered EOAs for enumeration
    address[] public eoaList;

    // ============ Errors ============

    error EOANotRegistered();
    error EOAAlreadyRegistered();
    error TargetNotAllowed(address target);
    error ExecutionFailed();
    error CannotRegisterCoreAddress(address account);

    // ============ Constructor ============

    /**
     * @notice Initialize IntEOA module
     * @param _avatar The M2 Safe address
     * @param _owner The owner (typically the M2 Safe itself, managed by 3/3 multisig)
     */
    constructor(address _avatar, address _owner)
        Module(_avatar, _avatar, _owner)
    {}

    // ============ Emergency Controls ============

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============ EOA Management (owner only — requires 3/3 multisig) ============

    /**
     * @notice Register an EOA subaccount
     * @param eoa The EOA address to register
     */
    function registerEOA(address eoa) external onlyOwner {
        if (eoa == address(0)) revert InvalidAddress();
        if (eoa == avatar || eoa == address(this)) revert CannotRegisterCoreAddress(eoa);
        if (registeredEOAs[eoa]) revert EOAAlreadyRegistered();

        registeredEOAs[eoa] = true;
        eoaList.push(eoa);

        emit EOARegistered(eoa);
    }

    /**
     * @notice Revoke an EOA subaccount
     * @param eoa The EOA address to revoke
     */
    function revokeEOA(address eoa) external onlyOwner {
        if (!registeredEOAs[eoa]) revert EOANotRegistered();

        registeredEOAs[eoa] = false;
        _removeFromEOAList(eoa);

        emit EOARevoked(eoa);
    }

    /**
     * @notice Set allowed targets for an EOA (e.g., SpendInteractor, DeFiInteractor)
     * @param eoa The EOA address
     * @param targets Array of target addresses
     * @param allowed Whether to allow or disallow
     */
    function setAllowedTargets(
        address eoa,
        address[] calldata targets,
        bool allowed
    ) external onlyOwner {
        if (!registeredEOAs[eoa]) revert EOANotRegistered();

        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] == address(0)) revert InvalidAddress();
            allowedTargets[eoa][targets[i]] = allowed;
            emit TargetAllowed(eoa, targets[i], allowed);
        }
    }

    // ============ Core Execution ============

    /**
     * @notice Execute a transaction through the M2 Safe
     * @dev Only registered EOAs can call. Target must be whitelisted for the caller.
     *      The target contract (e.g., SpendInteractor) performs its own validation.
     * @param target The target contract address
     * @param data The calldata to forward
     * @return result The return data from the execution
     */
    function execute(
        address target,
        bytes calldata data
    ) external override nonReentrant whenNotPaused returns (bytes memory result) {
        _validateCaller(msg.sender, target);

        bool success = exec(target, 0, data, ISafe.Operation.Call);
        if (!success) revert ExecutionFailed();

        emit Executed(msg.sender, target, bytes4(data[:4]), true);
        return "";
    }

    /**
     * @notice Execute a transaction with ETH value through the M2 Safe
     * @param target The target contract address
     * @param data The calldata to forward
     * @return result The return data from the execution
     */
    function executeWithValue(
        address target,
        bytes calldata data
    ) external payable override nonReentrant whenNotPaused returns (bytes memory result) {
        _validateCaller(msg.sender, target);

        bool success = exec(target, msg.value, data, ISafe.Operation.Call);
        if (!success) revert ExecutionFailed();

        emit Executed(msg.sender, target, bytes4(data[:4]), true);
        return "";
    }

    // ============ View Functions ============

    function isRegisteredEOA(address eoa) external view override returns (bool) {
        return registeredEOAs[eoa];
    }

    function isAllowedTarget(address eoa, address target) external view override returns (bool) {
        return allowedTargets[eoa][target];
    }

    function getRegisteredEOAs() external view returns (address[] memory) {
        return eoaList;
    }

    // ============ Internal ============

    function _validateCaller(address caller, address target) internal view {
        if (!registeredEOAs[caller]) revert EOANotRegistered();
        if (!allowedTargets[caller][target]) revert TargetNotAllowed(target);
    }

    function _removeFromEOAList(address eoa) internal {
        uint256 length = eoaList.length;
        for (uint256 i = 0; i < length; i++) {
            if (eoaList[i] == eoa) {
                eoaList[i] = eoaList[length - 1];
                eoaList.pop();
                break;
            }
        }
    }
}
