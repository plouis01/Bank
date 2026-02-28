// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {ISpendInteractor} from "./interfaces/ISpendInteractor.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SpendInteractor
 * @notice Authorization-only Zodiac module for M2 client Safes in S4b architecture.
 *
 * @dev This contract validates spending intents and emits authorization events.
 *      It does NOT move funds. The backend bridge listens for SpendAuthorized events
 *      and executes payments from the shared Unlink spending pool.
 *
 *      Key properties:
 *      - Fixed USD daily limits per EOA (set by owner / M2 signers)
 *      - 24h rolling spend window with gas-efficient checkpoint tracking
 *      - Nonce-based replay protection
 *      - Transfer type validation per EOA
 *      - No oracle dependency for spending limits (owner-settable)
 *
 *      Adapted from MultiSub DeFiInteractorModule spending limit pattern,
 *      simplified for authorization-only use case.
 */
contract SpendInteractor is Module, ReentrancyGuard, Pausable, ISpendInteractor {
    // ============ Constants ============

    /// @notice 24-hour rolling window duration
    uint256 public constant WINDOW_DURATION = 24 hours;

    /// @notice Maximum number of spend records to keep per EOA (gas safety)
    uint256 public constant MAX_RECORDS_PER_EOA = 200;

    // ============ Transfer Types ============

    uint8 public constant TYPE_PAYMENT = 0;
    uint8 public constant TYPE_TRANSFER = 1;
    uint8 public constant TYPE_INTERBANK = 2;

    // ============ EOA Registration ============

    struct EOAConfig {
        uint256 dailyLimit;         // Fixed USD daily limit (18 decimals)
        bool isRegistered;          // Whether this EOA is active
        uint8 allowedTypesBitmap;   // Bitmask of allowed transfer types
    }

    /// @notice Configuration per registered EOA
    mapping(address => EOAConfig) public eoaConfigs;

    /// @notice List of all registered EOAs (for enumeration)
    address[] public registeredEOAs;

    // ============ Rolling Spend Tracking ============

    struct SpendRecord {
        uint128 amount;     // USD amount (18 decimals, packed)
        uint128 timestamp;  // Block timestamp (packed)
    }

    /// @notice Spend history per EOA for rolling window calculation
    mapping(address => SpendRecord[]) private _spendHistory;

    /// @notice Index of first valid record per EOA (for gas-efficient cleanup)
    mapping(address => uint256) private _spendHistoryStart;

    // ============ Nonce / Replay Protection ============

    /// @notice Global nonce counter (monotonically increasing)
    uint256 public nonce;

    /// @notice Processed nonces (for backend deduplication verification)
    mapping(uint256 => bool) public processedNonces;

    // ============ Events ============

    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);

    // ============ Errors ============

    error EOANotRegistered();
    error EOAAlreadyRegistered();
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error TransferTypeNotAllowed(uint8 transferType);
    error InvalidDailyLimit();
    error InvalidTransferType();
    error ZeroAmount();
    error CannotRegisterCoreAddress(address account);
    error TooManySpendRecords();

    // ============ Constructor ============

    /**
     * @notice Initialize SpendInteractor module
     * @param _avatar The M2 Safe address
     * @param _owner The owner (typically the M2 Safe itself for signers to manage)
     */
    constructor(address _avatar, address _owner)
        Module(_avatar, _avatar, _owner)
    {}

    // ============ Emergency Controls ============

    function pause() external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    // ============ Core Authorization ============

    /**
     * @notice Authorize a spending intent. Validates limits and emits event.
     * @dev Does NOT move funds. Backend bridge listens for the event.
     *      The caller (msg.sender) must be a registered EOA.
     * @param amount USD amount to authorize (18 decimals)
     * @param recipientHash Hashed recipient identifier (privacy)
     * @param transferType 0=payment, 1=transfer, 2=interbank
     */
    function authorizeSpend(
        uint256 amount,
        bytes32 recipientHash,
        uint8 transferType
    ) external override nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        // 1. Verify caller is registered EOA
        EOAConfig storage config = eoaConfigs[msg.sender];
        if (!config.isRegistered) revert EOANotRegistered();

        // 2. Verify transfer type is allowed for this EOA
        if (!_isTypeAllowed(config.allowedTypesBitmap, transferType)) {
            revert TransferTypeNotAllowed(transferType);
        }

        // 3. Calculate current rolling spend within 24h window
        uint256 currentSpend = _getRollingSpend(msg.sender);
        uint256 remaining = config.dailyLimit > currentSpend
            ? config.dailyLimit - currentSpend
            : 0;

        if (amount > remaining) {
            revert DailyLimitExceeded(amount, remaining);
        }

        // 4. Record this spend
        _recordSpend(msg.sender, amount);

        // 5. Emit authorization event (backend bridge listens for this)
        uint256 currentNonce = nonce++;

        emit SpendAuthorized(
            avatar,             // M2 Safe address
            msg.sender,         // EOA that authorized
            amount,
            recipientHash,
            transferType,
            currentNonce
        );
    }

    // ============ EOA Management ============

    /**
     * @notice Register a new EOA sub-account with spending limits
     * @param eoa The EOA address to register
     * @param dailyLimit Fixed USD daily spending limit (18 decimals)
     * @param allowedTypes Array of allowed transfer type IDs
     */
    function registerEOA(
        address eoa,
        uint256 dailyLimit,
        uint8[] calldata allowedTypes
    ) external override onlyOwner {
        if (eoa == address(0)) revert InvalidAddress();
        if (eoa == avatar || eoa == address(this)) revert CannotRegisterCoreAddress(eoa);
        if (eoaConfigs[eoa].isRegistered) revert EOAAlreadyRegistered();
        if (dailyLimit == 0) revert InvalidDailyLimit();

        // Build allowed types bitmap
        uint8 bitmap = 0;
        for (uint256 i = 0; i < allowedTypes.length; i++) {
            if (allowedTypes[i] > 7) revert InvalidTransferType();
            bitmap |= uint8(1 << allowedTypes[i]);
        }

        eoaConfigs[eoa] = EOAConfig({
            dailyLimit: dailyLimit,
            isRegistered: true,
            allowedTypesBitmap: bitmap
        });

        registeredEOAs.push(eoa);

        emit EOARegistered(eoa, dailyLimit, allowedTypes);
    }

    /**
     * @notice Revoke an EOA sub-account
     * @param eoa The EOA address to revoke
     */
    function revokeEOA(address eoa) external override onlyOwner {
        if (!eoaConfigs[eoa].isRegistered) revert EOANotRegistered();

        eoaConfigs[eoa].isRegistered = false;
        eoaConfigs[eoa].dailyLimit = 0;
        eoaConfigs[eoa].allowedTypesBitmap = 0;

        // Remove from array (swap and pop)
        _removeFromRegisteredEOAs(eoa);

        emit EOARevoked(eoa);
    }

    /**
     * @notice Update daily spending limit for an EOA
     * @param eoa The EOA address
     * @param newDailyLimit New USD daily limit (18 decimals)
     */
    function updateLimit(
        address eoa,
        uint256 newDailyLimit
    ) external override onlyOwner {
        if (!eoaConfigs[eoa].isRegistered) revert EOANotRegistered();
        if (newDailyLimit == 0) revert InvalidDailyLimit();

        eoaConfigs[eoa].dailyLimit = newDailyLimit;

        emit LimitUpdated(eoa, newDailyLimit);
    }

    /**
     * @notice Update allowed transfer types for an EOA
     * @param eoa The EOA address
     * @param allowedTypes New array of allowed transfer type IDs
     */
    function updateAllowedTypes(
        address eoa,
        uint8[] calldata allowedTypes
    ) external onlyOwner {
        if (!eoaConfigs[eoa].isRegistered) revert EOANotRegistered();

        uint8 bitmap = 0;
        for (uint256 i = 0; i < allowedTypes.length; i++) {
            if (allowedTypes[i] > 7) revert InvalidTransferType();
            bitmap |= uint8(1 << allowedTypes[i]);
        }

        eoaConfigs[eoa].allowedTypesBitmap = bitmap;
    }

    // ============ View Functions ============

    /**
     * @notice Get the rolling spend for an EOA within the current 24h window
     * @param eoa The EOA address
     * @return total Total USD spent in rolling 24h window (18 decimals)
     */
    function getRollingSpend(address eoa) external view override returns (uint256) {
        return _getRollingSpend(eoa);
    }

    /**
     * @notice Get remaining daily allowance for an EOA
     * @param eoa The EOA address
     * @return remaining USD remaining in current window (18 decimals)
     */
    function getRemainingLimit(address eoa) external view override returns (uint256) {
        EOAConfig storage config = eoaConfigs[eoa];
        if (!config.isRegistered) return 0;

        uint256 currentSpend = _getRollingSpend(eoa);
        return config.dailyLimit > currentSpend
            ? config.dailyLimit - currentSpend
            : 0;
    }

    /**
     * @notice Get daily limit for an EOA
     * @param eoa The EOA address
     * @return limit USD daily limit (18 decimals)
     */
    function getDailyLimit(address eoa) external view override returns (uint256) {
        return eoaConfigs[eoa].dailyLimit;
    }

    /**
     * @notice Check if an EOA is registered and active
     * @param eoa The EOA address
     * @return registered Whether the EOA is registered
     */
    function isRegisteredEOA(address eoa) external view override returns (bool) {
        return eoaConfigs[eoa].isRegistered;
    }

    /**
     * @notice Get allowed transfer types bitmap for an EOA
     * @param eoa The EOA address
     * @return bitmap Bitmask of allowed transfer types
     */
    function getAllowedTypesBitmap(address eoa) external view returns (uint8) {
        return eoaConfigs[eoa].allowedTypesBitmap;
    }

    /**
     * @notice Get all registered EOA addresses
     * @return eoas Array of registered EOA addresses
     */
    function getRegisteredEOAs() external view returns (address[] memory) {
        return registeredEOAs;
    }

    /**
     * @notice Get the number of spend records for an EOA
     * @param eoa The EOA address
     * @return count Number of active spend records
     */
    function getSpendRecordCount(address eoa) external view returns (uint256) {
        uint256 start = _spendHistoryStart[eoa];
        uint256 length = _spendHistory[eoa].length;
        return length > start ? length - start : 0;
    }

    // ============ Internal Functions ============

    /**
     * @notice Calculate rolling spend within 24h window
     * @dev Iterates backwards from most recent record for gas efficiency
     */
    function _getRollingSpend(address eoa) internal view returns (uint256 total) {
        SpendRecord[] storage records = _spendHistory[eoa];
        uint256 length = records.length;
        uint256 start = _spendHistoryStart[eoa];
        uint256 windowStart = block.timestamp > WINDOW_DURATION
            ? block.timestamp - WINDOW_DURATION
            : 0;

        // Iterate backwards from most recent (most likely to be in window)
        for (uint256 i = length; i > start; i--) {
            SpendRecord storage record = records[i - 1];
            if (uint256(record.timestamp) < windowStart) break;
            total += uint256(record.amount);
        }
    }

    /**
     * @notice Record a spend and clean up old records
     * @dev Uses checkpoint pattern: updates start index instead of deleting
     */
    function _recordSpend(address eoa, uint256 amount) internal {
        SpendRecord[] storage records = _spendHistory[eoa];

        // Clean up expired records by advancing start index
        uint256 start = _spendHistoryStart[eoa];
        uint256 windowStart = block.timestamp > WINDOW_DURATION
            ? block.timestamp - WINDOW_DURATION
            : 0;

        while (start < records.length && uint256(records[start].timestamp) < windowStart) {
            start++;
        }
        _spendHistoryStart[eoa] = start;

        // Check record count safety limit
        uint256 activeRecords = records.length - start;
        if (activeRecords >= MAX_RECORDS_PER_EOA) revert TooManySpendRecords();

        // Append new record
        records.push(SpendRecord({
            amount: uint128(amount),
            timestamp: uint128(block.timestamp)
        }));
    }

    /**
     * @notice Check if a transfer type is allowed by the bitmap
     */
    function _isTypeAllowed(uint8 bitmap, uint8 transferType) internal pure returns (bool) {
        if (transferType > 7) return false;
        return (bitmap & (1 << transferType)) != 0;
    }

    /**
     * @notice Remove an EOA from the registered array (swap and pop)
     */
    function _removeFromRegisteredEOAs(address eoa) internal {
        uint256 length = registeredEOAs.length;
        for (uint256 i = 0; i < length; i++) {
            if (registeredEOAs[i] == eoa) {
                registeredEOAs[i] = registeredEOAs[length - 1];
                registeredEOAs.pop();
                break;
            }
        }
    }
}
