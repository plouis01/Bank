// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {ITreasuryTimelock} from "./interfaces/ITreasuryTimelock.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TreasuryTimelock (xTimelock)
 * @notice Time-delay enforcement module for M1 Treasury Safe.
 *
 * @dev Operations above a configurable USD threshold require a minimum delay
 *      before execution. Operations below the threshold execute immediately
 *      (still subject to role checks via TreasuryVault).
 *
 *      Lifecycle: schedule → (wait minDelay) → execute
 *      Emergency: any canceller can cancel during the delay period
 *
 *      Designed for the S4b M1 Treasury Safe (3/5 multisig).
 */
contract TreasuryTimelock is Module, ReentrancyGuard, Pausable, ITreasuryTimelock {
    // ============ Structs ============

    struct TimelockOperation {
        address to;
        uint256 value;
        bytes data;
        address proposer;
        uint256 scheduledAt;
        uint256 executableAt;
        OperationState state;
    }

    // ============ State ============

    /// @notice Minimum delay for timelocked operations (e.g., 24 hours)
    uint256 public minDelay;

    /// @notice USD threshold above which timelock applies (18 decimals)
    uint256 public timelockThreshold;

    /// @notice Maximum delay that can be set (7 days)
    uint256 public constant MAX_DELAY = 7 days;

    /// @notice All timelocked operations
    mapping(bytes32 => TimelockOperation) public operations;

    /// @notice Role mappings
    mapping(address => bool) public proposers;
    mapping(address => bool) public executors;
    mapping(address => bool) public cancellers;

    // ============ Errors ============

    error DelayTooLong(uint256 delay);
    error InvalidThreshold();
    error NotProposer();
    error NotExecutor();
    error NotCanceller();
    error OperationAlreadyExists(bytes32 operationId);
    error OperationNotPending(bytes32 operationId);
    error OperationNotReady(bytes32 operationId);
    error OperationBelowThreshold(uint256 amount, uint256 threshold);
    error TimelockNotExpired(uint256 executableAt, uint256 currentTime);

    // ============ Modifiers ============

    modifier onlyProposer() {
        if (!proposers[msg.sender]) revert NotProposer();
        _;
    }

    modifier onlyExecutor() {
        if (!executors[msg.sender]) revert NotExecutor();
        _;
    }

    modifier onlyCanceller() {
        if (!cancellers[msg.sender]) revert NotCanceller();
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Initialize TreasuryTimelock module
     * @param _avatar The M1 Safe address
     * @param _owner The owner (typically the M1 Safe itself)
     * @param _minDelay Minimum delay for timelocked operations
     * @param _timelockThreshold USD threshold above which timelock applies (18 decimals)
     */
    constructor(
        address _avatar,
        address _owner,
        uint256 _minDelay,
        uint256 _timelockThreshold
    ) Module(_avatar, _avatar, _owner) {
        if (_minDelay > MAX_DELAY) revert DelayTooLong(_minDelay);
        if (_timelockThreshold == 0) revert InvalidThreshold();

        minDelay = _minDelay;
        timelockThreshold = _timelockThreshold;
    }

    // ============ Emergency Controls ============

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============ Role Management ============

    function setProposer(address account, bool status) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        proposers[account] = status;
        emit ProposerUpdated(account, status);
    }

    function setExecutor(address account, bool status) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        executors[account] = status;
        emit ExecutorUpdated(account, status);
    }

    function setCanceller(address account, bool status) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        cancellers[account] = status;
        emit CancellerUpdated(account, status);
    }

    // ============ Configuration ============

    function setMinDelay(uint256 _minDelay) external onlyOwner {
        if (_minDelay > MAX_DELAY) revert DelayTooLong(_minDelay);
        uint256 oldDelay = minDelay;
        minDelay = _minDelay;
        emit MinDelayUpdated(oldDelay, _minDelay);
    }

    function setTimelockThreshold(uint256 _threshold) external onlyOwner {
        if (_threshold == 0) revert InvalidThreshold();
        uint256 oldThreshold = timelockThreshold;
        timelockThreshold = _threshold;
        emit TimelockThresholdUpdated(oldThreshold, _threshold);
    }

    // ============ Core Operations ============

    /**
     * @notice Schedule a timelocked operation
     * @param to Target address for the operation
     * @param value ETH value to send
     * @param data Calldata for the operation
     * @param usdAmount USD amount of the operation (for threshold check, 18 decimals)
     * @param salt Unique salt to differentiate identical operations
     * @return operationId The unique operation identifier
     */
    function schedule(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 usdAmount,
        bytes32 salt
    ) external override onlyProposer whenNotPaused nonReentrant returns (bytes32 operationId) {
        if (usdAmount < timelockThreshold) {
            revert OperationBelowThreshold(usdAmount, timelockThreshold);
        }

        operationId = hashOperation(to, value, data, salt);

        if (operations[operationId].state != OperationState.Unset) {
            revert OperationAlreadyExists(operationId);
        }

        uint256 executableAt = block.timestamp + minDelay;

        operations[operationId] = TimelockOperation({
            to: to,
            value: value,
            data: data,
            proposer: msg.sender,
            scheduledAt: block.timestamp,
            executableAt: executableAt,
            state: OperationState.Pending
        });

        emit OperationScheduled(operationId, msg.sender, to, value, data, executableAt);
    }

    /**
     * @notice Execute a timelocked operation after the delay has passed
     * @param operationId The operation to execute
     */
    function execute(
        bytes32 operationId
    ) external override onlyExecutor whenNotPaused nonReentrant {
        TimelockOperation storage op = operations[operationId];

        if (op.state != OperationState.Pending) {
            revert OperationNotPending(operationId);
        }

        if (block.timestamp < op.executableAt) {
            revert TimelockNotExpired(op.executableAt, block.timestamp);
        }

        op.state = OperationState.Executed;

        // Execute through the Safe
        bool success = exec(op.to, op.value, op.data, ISafe.Operation.Call);
        if (!success) revert ModuleTransactionFailed();

        emit OperationExecuted(operationId, msg.sender);
    }

    /**
     * @notice Cancel a pending operation (emergency veto)
     * @param operationId The operation to cancel
     */
    function cancel(
        bytes32 operationId
    ) external override onlyCanceller nonReentrant {
        TimelockOperation storage op = operations[operationId];

        if (op.state != OperationState.Pending) {
            revert OperationNotPending(operationId);
        }

        op.state = OperationState.Cancelled;

        emit OperationCancelled(operationId, msg.sender);
    }

    // ============ View Functions ============

    /**
     * @notice Compute the operation ID from its parameters
     */
    function hashOperation(
        address to,
        uint256 value,
        bytes memory data,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(to, value, data, salt));
    }

    function getOperationState(bytes32 operationId) external view override returns (OperationState) {
        TimelockOperation storage op = operations[operationId];
        if (op.state == OperationState.Pending && block.timestamp >= op.executableAt) {
            return OperationState.Ready;
        }
        return op.state;
    }

    function getMinDelay() external view override returns (uint256) {
        return minDelay;
    }

    function getTimelockThreshold() external view override returns (uint256) {
        return timelockThreshold;
    }

    function isProposer(address account) external view override returns (bool) {
        return proposers[account];
    }

    function isCanceller(address account) external view override returns (bool) {
        return cancellers[account];
    }

    function isExecutor(address account) external view override returns (bool) {
        return executors[account];
    }

    /**
     * @notice Get full operation details
     */
    function getOperation(bytes32 operationId) external view returns (
        address to,
        uint256 value,
        bytes memory data,
        address proposer,
        uint256 scheduledAt,
        uint256 executableAt,
        OperationState state
    ) {
        TimelockOperation storage op = operations[operationId];
        OperationState currentState = op.state;
        if (currentState == OperationState.Pending && block.timestamp >= op.executableAt) {
            currentState = OperationState.Ready;
        }
        return (op.to, op.value, op.data, op.proposer, op.scheduledAt, op.executableAt, currentState);
    }
}
