// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITreasuryVault {
    // ============ Enums ============

    enum Role {
        None,
        Operator,   // Routine operations below operator limit
        Manager,    // Fund management below manager limit
        Director    // Full access (still subject to timelock for large ops)
    }

    // ============ Events ============

    event RoleAssigned(address indexed account, Role role);
    event RoleRevoked(address indexed account);
    event TargetWhitelisted(address indexed target, bool status);
    event OperatorLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event ManagerLimitUpdated(uint256 oldLimit, uint256 newLimit);
    event ReserveRequirementUpdated(address indexed token, uint256 oldReserve, uint256 newReserve);
    event TransferExecuted(
        address indexed executor,
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event EthTransferExecuted(
        address indexed executor,
        address indexed to,
        uint256 amount
    );

    // ============ Core Functions ============

    function executeTransfer(
        address token,
        address to,
        uint256 amount
    ) external;

    function executeEthTransfer(
        address to,
        uint256 amount
    ) external;

    // ============ View Functions ============

    function getRole(address account) external view returns (Role);
    function isWhitelistedTarget(address target) external view returns (bool);
    function getOperatorLimit() external view returns (uint256);
    function getManagerLimit() external view returns (uint256);
    function getReserveRequirement(address token) external view returns (uint256);
}
