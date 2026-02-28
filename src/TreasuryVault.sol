// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {ITreasuryVault} from "./interfaces/ITreasuryVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TreasuryVault (xVault)
 * @notice Role-based access control module for M1 Treasury Safe.
 *
 * @dev Controls who can move funds from the M1 Treasury and to where.
 *      Three roles with escalating limits:
 *      - Operator: routine operations (e.g., < €10k) — Unlink pool top-ups
 *      - Manager: fund management (e.g., < €100k) — DeFi allocations
 *      - Director: full access (still subject to timelock for very large ops)
 *
 *      All transfers restricted to whitelisted target addresses.
 *      Reserve requirements ensure minimum liquid balance is maintained.
 *
 *      Designed for the S4b M1 Treasury Safe (3/5 multisig).
 */
contract TreasuryVault is Module, ReentrancyGuard, Pausable, ITreasuryVault {
    // ============ State ============

    /// @notice Role assigned to each address
    mapping(address => Role) public roles;

    /// @notice Whitelisted target addresses (Unlink pool, DeFi protocols, etc.)
    mapping(address => bool) public whitelistedTargets;

    /// @notice Per-role transfer limits (USD, 18 decimals)
    uint256 public operatorLimit;
    uint256 public managerLimit;

    /// @notice Minimum token balance the Safe must maintain (per token)
    mapping(address => uint256) public reserveRequirements;

    /// @notice Address of the TreasuryTimelock module (for routing large ops)
    address public timelockModule;

    // ============ Errors ============

    error NotAuthorized();
    error TargetNotWhitelisted(address target);
    error AmountExceedsRoleLimit(uint256 amount, uint256 limit);
    error ReserveViolation(address token, uint256 currentBalance, uint256 reserve);
    error InvalidLimit();
    error TimelockNotSet();

    // ============ Constructor ============

    /**
     * @notice Initialize TreasuryVault module
     * @param _avatar The M1 Safe address
     * @param _owner The owner (typically the M1 Safe itself)
     * @param _operatorLimit Max transfer for Operator role (18 decimals)
     * @param _managerLimit Max transfer for Manager role (18 decimals)
     */
    constructor(
        address _avatar,
        address _owner,
        uint256 _operatorLimit,
        uint256 _managerLimit
    ) Module(_avatar, _avatar, _owner) {
        if (_operatorLimit == 0 || _managerLimit == 0) revert InvalidLimit();
        if (_operatorLimit > _managerLimit) revert InvalidLimit();

        operatorLimit = _operatorLimit;
        managerLimit = _managerLimit;
    }

    // ============ Emergency Controls ============

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============ Role Management ============

    /**
     * @notice Assign a role to an address
     * @param account The address to assign the role to
     * @param role The role to assign
     */
    function assignRole(address account, Role role) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        roles[account] = role;
        emit RoleAssigned(account, role);
    }

    /**
     * @notice Revoke role from an address
     * @param account The address to revoke
     */
    function revokeRole(address account) external onlyOwner {
        roles[account] = Role.None;
        emit RoleRevoked(account);
    }

    // ============ Target Whitelisting ============

    /**
     * @notice Add or remove a target from the whitelist
     * @param _target The target address
     * @param status Whether to whitelist (true) or remove (false)
     */
    function setWhitelistedTarget(address _target, bool status) external onlyOwner {
        if (_target == address(0)) revert InvalidAddress();
        whitelistedTargets[_target] = status;
        emit TargetWhitelisted(_target, status);
    }

    // ============ Configuration ============

    function setOperatorLimit(uint256 _limit) external onlyOwner {
        if (_limit == 0) revert InvalidLimit();
        uint256 oldLimit = operatorLimit;
        operatorLimit = _limit;
        emit OperatorLimitUpdated(oldLimit, _limit);
    }

    function setManagerLimit(uint256 _limit) external onlyOwner {
        if (_limit == 0) revert InvalidLimit();
        uint256 oldLimit = managerLimit;
        managerLimit = _limit;
        emit ManagerLimitUpdated(oldLimit, _limit);
    }

    function setReserveRequirement(address token, uint256 reserve) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        uint256 oldReserve = reserveRequirements[token];
        reserveRequirements[token] = reserve;
        emit ReserveRequirementUpdated(token, oldReserve, reserve);
    }

    function setTimelockModule(address _timelock) external onlyOwner {
        if (_timelock == address(0)) revert InvalidAddress();
        timelockModule = _timelock;
    }

    // ============ Core Operations ============

    /**
     * @notice Execute an ERC20 transfer from the M1 Safe
     * @dev Validates: caller role, target whitelist, role limit, reserve requirement
     * @param token The ERC20 token to transfer
     * @param to The recipient (must be whitelisted)
     * @param amount The amount to transfer
     */
    function executeTransfer(
        address token,
        address to,
        uint256 amount
    ) external override nonReentrant whenNotPaused {
        _validateTransfer(msg.sender, to, amount);
        _checkReserve(token, amount);

        // Encode ERC20 transfer call
        bytes memory data = abi.encodeWithSelector(
            IERC20.transfer.selector,
            to,
            amount
        );

        bool success = exec(token, 0, data, ISafe.Operation.Call);
        if (!success) revert ModuleTransactionFailed();

        emit TransferExecuted(msg.sender, token, to, amount);
    }

    /**
     * @notice Execute a native ETH transfer from the M1 Safe
     * @param to The recipient (must be whitelisted)
     * @param amount The amount of ETH to transfer
     */
    function executeEthTransfer(
        address to,
        uint256 amount
    ) external override nonReentrant whenNotPaused {
        _validateTransfer(msg.sender, to, amount);

        bool success = exec(to, amount, "", ISafe.Operation.Call);
        if (!success) revert ModuleTransactionFailed();

        emit EthTransferExecuted(msg.sender, to, amount);
    }

    // ============ View Functions ============

    function getRole(address account) external view override returns (Role) {
        return roles[account];
    }

    function isWhitelistedTarget(address _target) external view override returns (bool) {
        return whitelistedTargets[_target];
    }

    function getOperatorLimit() external view override returns (uint256) {
        return operatorLimit;
    }

    function getManagerLimit() external view override returns (uint256) {
        return managerLimit;
    }

    function getReserveRequirement(address token) external view override returns (uint256) {
        return reserveRequirements[token];
    }

    /**
     * @notice Get the transfer limit for a given role
     */
    function getRoleLimit(Role role) public view returns (uint256) {
        if (role == Role.Operator) return operatorLimit;
        if (role == Role.Manager) return managerLimit;
        if (role == Role.Director) return type(uint256).max;
        return 0;
    }

    // ============ Internal Functions ============

    /**
     * @notice Validate a transfer: role, whitelist, and limit checks
     */
    function _validateTransfer(address caller, address to, uint256 amount) internal view {
        Role role = roles[caller];
        if (role == Role.None) revert NotAuthorized();
        if (!whitelistedTargets[to]) revert TargetNotWhitelisted(to);

        uint256 limit = getRoleLimit(role);
        if (amount > limit) revert AmountExceedsRoleLimit(amount, limit);
    }

    /**
     * @notice Check that the transfer won't violate the reserve requirement
     */
    function _checkReserve(address token, uint256 amount) internal view {
        uint256 reserve = reserveRequirements[token];
        if (reserve == 0) return; // No reserve requirement set

        uint256 currentBalance = IERC20(token).balanceOf(avatar);
        if (currentBalance < amount + reserve) {
            revert ReserveViolation(token, currentBalance, reserve);
        }
    }
}
