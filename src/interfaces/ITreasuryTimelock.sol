// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITreasuryTimelock {
    // ============ Enums ============

    enum OperationState {
        Unset,
        Pending,
        Ready,
        Executed,
        Cancelled
    }

    // ============ Events ============

    event OperationScheduled(
        bytes32 indexed operationId,
        address indexed proposer,
        address to,
        uint256 value,
        bytes data,
        uint256 executableAt
    );

    event OperationExecuted(bytes32 indexed operationId, address indexed executor);
    event OperationCancelled(bytes32 indexed operationId, address indexed canceller);
    event MinDelayUpdated(uint256 oldDelay, uint256 newDelay);
    event TimelockThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event ProposerUpdated(address indexed account, bool status);
    event CancellerUpdated(address indexed account, bool status);
    event ExecutorUpdated(address indexed account, bool status);

    // ============ Core Functions ============

    function schedule(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 usdAmount,
        bytes32 salt
    ) external returns (bytes32 operationId);

    function execute(bytes32 operationId) external;
    function cancel(bytes32 operationId) external;

    // ============ View Functions ============

    function getOperationState(bytes32 operationId) external view returns (OperationState);
    function getMinDelay() external view returns (uint256);
    function getTimelockThreshold() external view returns (uint256);
    function isProposer(address account) external view returns (bool);
    function isCanceller(address account) external view returns (bool);
    function isExecutor(address account) external view returns (bool);
}
