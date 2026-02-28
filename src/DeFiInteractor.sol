// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {ICalldataParser} from "./interfaces/ICalldataParser.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title DeFiInteractor
 * @notice Zodiac module for Tier B DeFi operations on M2 Safes.
 * @dev Adapted from MultiSub DeFiInteractorModule with the following changes:
 *      - Oracle is owner-settable (test-oracle) instead of Chainlink CRE
 *      - Same Acquired Balance Model for DeFi spending control
 *      - Percentage-based spending limits relative to Safe value
 *      - Compatible with S4b architecture (M2 DeFi operations)
 */
contract DeFiInteractor is Module, ReentrancyGuard, Pausable {
    // ============ Constants ============

    uint16 public constant DEFI_EXECUTE_ROLE = 1;
    uint16 public constant DEFI_TRANSFER_ROLE = 2;
    uint256 public constant DEFAULT_MAX_SPENDING_BPS = 500; // 5%
    uint256 public constant DEFAULT_WINDOW_DURATION = 1 days;

    // ============ Operation Type Classification ============

    enum OperationType {
        UNKNOWN,    // Must revert
        SWAP,       // Costs spending, output is acquired
        DEPOSIT,    // Costs spending, tracked for withdrawal matching
        WITHDRAW,   // FREE, output becomes acquired if matched
        CLAIM,      // FREE, output becomes acquired if matched
        APPROVE     // FREE but capped
    }

    mapping(bytes4 => OperationType) public selectorType;
    mapping(address => ICalldataParser) public protocolParsers;

    // ============ Oracle-Managed State ============
    // In S4b, the "oracle" is owner-settable (test-oracle pattern).
    // Owner calls update functions directly instead of Chainlink CRE.

    mapping(address => uint256) public spendingAllowance;
    mapping(address => mapping(address => uint256)) public acquiredBalance;

    /// @notice Authorized oracle address (owner-settable for testing, swappable for production)
    address public authorizedOracle;

    mapping(address => uint256) public lastOracleUpdate;
    uint256 public maxOracleAge = 60 minutes;

    // ============ Safe Value Storage ============

    struct SafeValue {
        uint256 totalValueUSD;  // 18 decimals
        uint256 lastUpdated;
        uint256 updateCount;
    }

    SafeValue public safeValue;
    uint256 public maxSafeValueAge = 60 minutes;
    uint256 public absoluteMaxSpendingBps = 2000; // 20% safety cap

    // ============ Sub-Account Configuration ============

    struct SubAccountLimits {
        uint256 maxSpendingBps;
        uint256 windowDuration;
        bool isConfigured;
    }

    mapping(address => SubAccountLimits) public subAccountLimits;
    mapping(address => mapping(address => bool)) public allowedAddresses;
    mapping(address => mapping(uint16 => bool)) public subAccountRoles;
    mapping(uint16 => address[]) public subaccounts;

    // ============ Price Feeds ============

    mapping(address => AggregatorV3Interface) public tokenPriceFeeds;
    uint256 public maxPriceFeedAge = 24 hours;

    // ============ Events ============

    event RoleAssigned(address indexed member, uint16 indexed roleId);
    event RoleRevoked(address indexed member, uint16 indexed roleId);
    event SubAccountLimitsSet(address indexed subAccount, uint256 maxSpendingBps, uint256 windowDuration);
    event AllowedAddressesSet(address indexed subAccount, address[] targets, bool allowed);

    event ProtocolExecution(
        address indexed subAccount,
        address indexed target,
        OperationType opType,
        address[] tokensIn,
        uint256[] amountsIn,
        address[] tokensOut,
        uint256[] amountsOut,
        uint256 spendingCost
    );

    event TransferExecuted(
        address indexed subAccount,
        address indexed token,
        address indexed recipient,
        uint256 amount,
        uint256 spendingCost
    );

    event SafeValueUpdated(uint256 totalValueUSD, uint256 updateCount);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event SpendingAllowanceUpdated(address indexed subAccount, uint256 newAllowance);
    event AcquiredBalanceUpdated(address indexed subAccount, address indexed token, uint256 newBalance);
    event SelectorRegistered(bytes4 indexed selector, OperationType opType);
    event SelectorUnregistered(bytes4 indexed selector);
    event ParserRegistered(address indexed protocol, address parser);
    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);

    // ============ Errors ============

    error UnknownSelector(bytes4 selector);
    error TransactionFailed();
    error ApprovalFailed();
    error InvalidLimitConfiguration();
    error AddressNotAllowed();
    error ExceedsSpendingLimit();
    error OnlyAuthorizedOracle();
    error InvalidOracleAddress();
    error StaleOracleData();
    error StalePortfolioValue();
    error InvalidPriceFeed();
    error StalePriceFeed();
    error InvalidPrice();
    error NoPriceFeedSet();
    error ApprovalExceedsLimit();
    error SpenderNotAllowed();
    error NoParserRegistered(address target);
    error ExceedsAbsoluteMaxSpending(uint256 requested, uint256 maximum);
    error CannotRegisterUnknown();
    error LengthMismatch();
    error ExceedsMaxBps();
    error InvalidRecipient(address recipient, address expected);
    error CannotBeSubaccount(address account);
    error CannotBeOracle(address account);
    error CannotWhitelistCoreAddress(address account);
    error CannotRegisterParserForCoreAddress(address account);

    // ============ Modifiers ============

    modifier onlyOracle() {
        if (msg.sender != authorizedOracle) revert OnlyAuthorizedOracle();
        _;
    }

    modifier onlyOwnerOrOracle() {
        if (msg.sender != owner && msg.sender != authorizedOracle) revert OnlyAuthorizedOracle();
        _;
    }

    // ============ Constructor ============

    constructor(address _avatar, address _owner, address _authorizedOracle)
        Module(_avatar, _avatar, _owner)
    {
        if (_authorizedOracle == address(0)) revert InvalidOracleAddress();
        authorizedOracle = _authorizedOracle;
    }

    // ============ Emergency Controls ============

    function pause() external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    // ============ Role Management ============

    function grantRole(address member, uint16 roleId) external onlyOwner {
        if (member == address(0)) revert InvalidAddress();
        if (member == avatar || member == address(this)) revert CannotBeSubaccount(member);
        if (member == authorizedOracle) revert CannotBeSubaccount(member);
        if (!subAccountRoles[member][roleId]) {
            subAccountRoles[member][roleId] = true;
            subaccounts[roleId].push(member);
            emit RoleAssigned(member, roleId);
        }
    }

    function revokeRole(address member, uint16 roleId) external onlyOwner {
        if (member == address(0)) revert InvalidAddress();
        if (subAccountRoles[member][roleId]) {
            subAccountRoles[member][roleId] = false;
            _removeFromSubaccountArray(roleId, member);
            emit RoleRevoked(member, roleId);
        }
    }

    function _removeFromSubaccountArray(uint16 roleId, address member) internal {
        address[] storage accounts = subaccounts[roleId];
        uint256 length = accounts.length;
        for (uint256 i = 0; i < length; i++) {
            if (accounts[i] == member) {
                accounts[i] = accounts[length - 1];
                accounts.pop();
                break;
            }
        }
    }

    function hasRole(address member, uint16 roleId) public view returns (bool) {
        return subAccountRoles[member][roleId];
    }

    function getSubaccountsByRole(uint16 roleId) external view returns (address[] memory) {
        return subaccounts[roleId];
    }

    function getSubaccountCount(uint16 roleId) external view returns (uint256) {
        return subaccounts[roleId].length;
    }

    // ============ Selector Registry ============

    function registerSelector(bytes4 selector, OperationType opType) external onlyOwner {
        if (opType == OperationType.UNKNOWN) revert CannotRegisterUnknown();
        selectorType[selector] = opType;
        emit SelectorRegistered(selector, opType);
    }

    function unregisterSelector(bytes4 selector) external onlyOwner {
        delete selectorType[selector];
        emit SelectorUnregistered(selector);
    }

    function registerParser(address protocol, address parser) external onlyOwner {
        if (protocol == avatar || protocol == address(this)) revert CannotRegisterParserForCoreAddress(protocol);
        protocolParsers[protocol] = ICalldataParser(parser);
        emit ParserRegistered(protocol, parser);
    }

    // ============ Sub-Account Configuration ============

    function setSubAccountLimits(
        address subAccount,
        uint256 maxSpendingBps,
        uint256 windowDuration
    ) external onlyOwner {
        if (subAccount == address(0)) revert InvalidAddress();
        if (subAccount == avatar || subAccount == address(this)) revert CannotBeSubaccount(subAccount);
        if (maxSpendingBps > 10000 || windowDuration < 1 hours) {
            revert InvalidLimitConfiguration();
        }

        subAccountLimits[subAccount] = SubAccountLimits({
            maxSpendingBps: maxSpendingBps,
            windowDuration: windowDuration,
            isConfigured: true
        });

        if (safeValue.totalValueUSD > 0 &&
            safeValue.lastUpdated > 0 &&
            block.timestamp - safeValue.lastUpdated <= maxSafeValueAge) {
            uint256 newMaxAllowance = (safeValue.totalValueUSD * maxSpendingBps) / 10000;
            if (spendingAllowance[subAccount] > newMaxAllowance) {
                spendingAllowance[subAccount] = newMaxAllowance;
                emit SpendingAllowanceUpdated(subAccount, newMaxAllowance);
            }
        }

        emit SubAccountLimitsSet(subAccount, maxSpendingBps, windowDuration);
    }

    function getSubAccountLimits(address subAccount) public view returns (
        uint256 maxSpendingBps,
        uint256 windowDuration
    ) {
        SubAccountLimits memory limits = subAccountLimits[subAccount];
        if (limits.isConfigured) {
            return (limits.maxSpendingBps, limits.windowDuration);
        }
        return (DEFAULT_MAX_SPENDING_BPS, DEFAULT_WINDOW_DURATION);
    }

    function setAllowedAddresses(
        address subAccount,
        address[] calldata targets,
        bool allowed
    ) external onlyOwner {
        if (subAccount == address(0)) revert InvalidAddress();
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] == avatar || targets[i] == address(this)) revert CannotWhitelistCoreAddress(targets[i]);
            if (targets[i] == address(0)) revert InvalidAddress();
            allowedAddresses[subAccount][targets[i]] = allowed;
        }
        emit AllowedAddressesSet(subAccount, targets, allowed);
    }

    // ============ Main Entry Points ============

    function executeOnProtocol(
        address target,
        bytes calldata data
    ) external nonReentrant whenNotPaused returns (bytes memory) {
        if (!hasRole(msg.sender, DEFI_EXECUTE_ROLE)) revert Unauthorized();
        _requireFreshOracle(msg.sender);

        OperationType opType = _classifyOperation(target, data);

        if (opType == OperationType.UNKNOWN) {
            revert UnknownSelector(bytes4(data[:4]));
        } else if (opType == OperationType.APPROVE) {
            return _executeApproveWithCap(msg.sender, target, data);
        }

        if (!allowedAddresses[msg.sender][target]) revert AddressNotAllowed();

        if (opType == OperationType.WITHDRAW || opType == OperationType.CLAIM) {
            return _executeNoSpendingCheck(msg.sender, target, data, opType);
        } else if (opType == OperationType.DEPOSIT || opType == OperationType.SWAP) {
            return _executeWithSpendingCheck(msg.sender, target, data, opType);
        }

        revert UnknownSelector(bytes4(data[:4]));
    }

    function executeOnProtocolWithValue(
        address target,
        bytes calldata data
    ) external payable nonReentrant whenNotPaused returns (bytes memory) {
        if (!hasRole(msg.sender, DEFI_EXECUTE_ROLE)) revert Unauthorized();
        _requireFreshOracle(msg.sender);

        OperationType opType = _classifyOperation(target, data);

        if (opType == OperationType.UNKNOWN) {
            revert UnknownSelector(bytes4(data[:4]));
        } else if (opType == OperationType.APPROVE) {
            return _executeApproveWithCap(msg.sender, target, data);
        }

        if (!allowedAddresses[msg.sender][target]) revert AddressNotAllowed();

        if (opType == OperationType.WITHDRAW || opType == OperationType.CLAIM) {
            return _executeNoSpendingCheckWithValue(msg.sender, target, data, opType, msg.value);
        } else if (opType == OperationType.DEPOSIT || opType == OperationType.SWAP) {
            return _executeWithSpendingCheckWithValue(msg.sender, target, data, opType, msg.value);
        }

        revert UnknownSelector(bytes4(data[:4]));
    }

    // ============ Operation Classification ============

    function _classifyOperation(address target, bytes calldata data) internal view returns (OperationType) {
        ICalldataParser parser = protocolParsers[target];
        if (address(parser) != address(0)) {
            uint8 parserOpType = parser.getOperationType(data);
            if (parserOpType > 0 && parserOpType <= uint8(OperationType.APPROVE)) {
                return OperationType(parserOpType);
            }
        }
        bytes4 selector = bytes4(data[:4]);
        return selectorType[selector];
    }

    // ============ Spending Check Logic ============

    function _executeWithSpendingCheck(
        address subAccount,
        address target,
        bytes calldata data,
        OperationType opType
    ) internal returns (bytes memory) {
        ICalldataParser parser = protocolParsers[target];
        if (address(parser) == address(0)) revert NoParserRegistered(target);

        address recipient = parser.extractRecipient(target, data, avatar);
        if (recipient != avatar) revert InvalidRecipient(recipient, avatar);

        address[] memory tokensIn = parser.extractInputTokens(target, data);
        uint256[] memory amountsIn = parser.extractInputAmounts(target, data);
        if (tokensIn.length != amountsIn.length) revert LengthMismatch();

        uint256 spendingCost = 0;
        for (uint256 i = 0; i < tokensIn.length; i++) {
            uint256 acquired = acquiredBalance[subAccount][tokensIn[i]];
            uint256 fromOriginal = amountsIn[i] > acquired ? amountsIn[i] - acquired : 0;
            spendingCost += _estimateTokenValueUSD(tokensIn[i], fromOriginal);
        }

        if (spendingCost > spendingAllowance[subAccount]) revert ExceedsSpendingLimit();
        spendingAllowance[subAccount] -= spendingCost;

        for (uint256 i = 0; i < tokensIn.length; i++) {
            uint256 acquired = acquiredBalance[subAccount][tokensIn[i]];
            uint256 usedFromAcquired = amountsIn[i] > acquired ? acquired : amountsIn[i];
            acquiredBalance[subAccount][tokensIn[i]] -= usedFromAcquired;
        }

        address[] memory tokensOut = _getOutputTokens(target, data, parser);
        uint256[] memory balancesBefore = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            balancesBefore[i] = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
        }

        bool success = exec(target, 0, data, ISafe.Operation.Call);
        if (!success) revert TransactionFailed();

        uint256[] memory amountsOut = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            uint256 balanceAfter = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
            amountsOut[i] = balanceAfter - balancesBefore[i];
        }

        emit ProtocolExecution(subAccount, target, opType, tokensIn, amountsIn, tokensOut, amountsOut, spendingCost);
        return "";
    }

    function _executeWithSpendingCheckWithValue(
        address subAccount,
        address target,
        bytes calldata data,
        OperationType opType,
        uint256 value
    ) internal returns (bytes memory) {
        ICalldataParser parser = protocolParsers[target];
        if (address(parser) == address(0)) revert NoParserRegistered(target);

        address recipient = parser.extractRecipient(target, data, avatar);
        if (recipient != avatar) revert InvalidRecipient(recipient, avatar);

        address[] memory tokensIn = parser.extractInputTokens(target, data);
        uint256[] memory amountsIn = parser.extractInputAmounts(target, data);
        if (tokensIn.length != amountsIn.length) revert LengthMismatch();

        for (uint256 i = 0; i < tokensIn.length; i++) {
            if (tokensIn[i] == address(0) && value > 0) {
                amountsIn[i] = value;
            }
        }

        uint256 spendingCost = 0;
        for (uint256 i = 0; i < tokensIn.length; i++) {
            uint256 acquired = acquiredBalance[subAccount][tokensIn[i]];
            uint256 fromOriginal = amountsIn[i] > acquired ? amountsIn[i] - acquired : 0;
            spendingCost += _estimateTokenValueUSD(tokensIn[i], fromOriginal);
        }

        if (spendingCost > spendingAllowance[subAccount]) revert ExceedsSpendingLimit();
        spendingAllowance[subAccount] -= spendingCost;

        for (uint256 i = 0; i < tokensIn.length; i++) {
            uint256 acquired = acquiredBalance[subAccount][tokensIn[i]];
            uint256 usedFromAcquired = amountsIn[i] > acquired ? acquired : amountsIn[i];
            acquiredBalance[subAccount][tokensIn[i]] -= usedFromAcquired;
        }

        address[] memory tokensOut = _getOutputTokens(target, data, parser);
        uint256[] memory balancesBefore = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            balancesBefore[i] = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
        }

        bool success = exec(target, value, data, ISafe.Operation.Call);
        if (!success) revert TransactionFailed();

        uint256[] memory amountsOut = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            uint256 balanceAfter = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
            amountsOut[i] = balanceAfter - balancesBefore[i];
        }

        emit ProtocolExecution(subAccount, target, opType, tokensIn, amountsIn, tokensOut, amountsOut, spendingCost);
        return "";
    }

    // ============ No Spending Check Logic ============

    function _executeNoSpendingCheck(
        address subAccount,
        address target,
        bytes calldata data,
        OperationType opType
    ) internal returns (bytes memory) {
        ICalldataParser parser = protocolParsers[target];
        if (address(parser) == address(0)) revert NoParserRegistered(target);

        address recipient = parser.extractRecipient(target, data, avatar);
        if (recipient != avatar) revert InvalidRecipient(recipient, avatar);

        address[] memory tokensOut = parser.extractOutputTokens(target, data);
        uint256[] memory balancesBefore = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            balancesBefore[i] = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
        }

        bool success = exec(target, 0, data, ISafe.Operation.Call);
        if (!success) revert TransactionFailed();

        uint256[] memory amountsOut = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            uint256 balanceAfter = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
            amountsOut[i] = balanceAfter - balancesBefore[i];
        }

        emit ProtocolExecution(subAccount, target, opType, new address[](0), new uint256[](0), tokensOut, amountsOut, 0);
        return "";
    }

    function _executeNoSpendingCheckWithValue(
        address subAccount,
        address target,
        bytes calldata data,
        OperationType opType,
        uint256 value
    ) internal returns (bytes memory) {
        ICalldataParser parser = protocolParsers[target];
        if (address(parser) == address(0)) revert NoParserRegistered(target);

        address recipient = parser.extractRecipient(target, data, avatar);
        if (recipient != avatar) revert InvalidRecipient(recipient, avatar);

        address[] memory tokensOut = parser.extractOutputTokens(target, data);
        uint256[] memory balancesBefore = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            balancesBefore[i] = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
        }

        bool success = exec(target, value, data, ISafe.Operation.Call);
        if (!success) revert TransactionFailed();

        uint256[] memory amountsOut = new uint256[](tokensOut.length);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            uint256 balanceAfter = tokensOut[i] != address(0)
                ? IERC20(tokensOut[i]).balanceOf(avatar)
                : avatar.balance;
            amountsOut[i] = balanceAfter - balancesBefore[i];
        }

        emit ProtocolExecution(subAccount, target, opType, new address[](0), new uint256[](0), tokensOut, amountsOut, 0);
        return "";
    }

    // ============ Approve Logic ============

    function _executeApproveWithCap(
        address subAccount,
        address target,
        bytes calldata data
    ) internal returns (bytes memory) {
        address spender;
        uint256 amount;
        assembly {
            spender := calldataload(add(data.offset, 4))
            amount := calldataload(add(data.offset, 36))
        }

        if (!allowedAddresses[subAccount][spender]) revert SpenderNotAllowed();

        address tokenIn = target;
        uint256 acquired = acquiredBalance[subAccount][tokenIn];

        if (amount > acquired) {
            uint256 originalPortion = amount - acquired;
            uint256 originalValueUSD = _estimateTokenValueUSD(tokenIn, originalPortion);
            if (originalValueUSD > spendingAllowance[subAccount]) revert ApprovalExceedsLimit();
        }

        bool success = exec(target, 0, data, ISafe.Operation.Call);
        if (!success) revert ApprovalFailed();

        address[] memory tokensIn = new address[](1);
        tokensIn[0] = tokenIn;
        uint256[] memory amountsIn = new uint256[](1);
        amountsIn[0] = amount;

        emit ProtocolExecution(
            subAccount, target, OperationType.APPROVE,
            tokensIn, amountsIn, new address[](0), new uint256[](0), 0
        );
        return "";
    }

    // ============ Transfer Function ============

    function transferToken(
        address token,
        address recipient,
        uint256 amount
    ) external nonReentrant whenNotPaused returns (bool) {
        if (!hasRole(msg.sender, DEFI_TRANSFER_ROLE)) revert Unauthorized();
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        _requireFreshOracle(msg.sender);

        uint256 acquired = acquiredBalance[msg.sender][token];
        uint256 usedFromAcquired = amount > acquired ? acquired : amount;
        uint256 fromOriginal = amount - usedFromAcquired;
        uint256 spendingCost = _estimateTokenValueUSD(token, fromOriginal);

        if (spendingCost > spendingAllowance[msg.sender]) revert ExceedsSpendingLimit();

        spendingAllowance[msg.sender] -= spendingCost;
        acquiredBalance[msg.sender][token] -= usedFromAcquired;

        bytes memory transferData = abi.encodeWithSelector(IERC20.transfer.selector, recipient, amount);
        bool success = exec(token, 0, transferData, ISafe.Operation.Call);
        if (!success) revert TransactionFailed();

        emit TransferExecuted(msg.sender, token, recipient, amount, spendingCost);
        return true;
    }

    // ============ Oracle Functions (Owner-Settable for Testing) ============

    function updateSafeValue(uint256 totalValueUSD) external onlyOwnerOrOracle {
        safeValue.totalValueUSD = totalValueUSD;
        safeValue.lastUpdated = block.timestamp;
        safeValue.updateCount += 1;
        emit SafeValueUpdated(totalValueUSD, safeValue.updateCount);
    }

    function updateSpendingAllowance(address subAccount, uint256 newAllowance) external onlyOwnerOrOracle {
        _enforceAllowanceCap(newAllowance);
        spendingAllowance[subAccount] = newAllowance;
        lastOracleUpdate[subAccount] = block.timestamp;
        emit SpendingAllowanceUpdated(subAccount, newAllowance);
    }

    function updateAcquiredBalance(
        address subAccount,
        address token,
        uint256 newBalance
    ) external onlyOwnerOrOracle {
        acquiredBalance[subAccount][token] = newBalance;
        lastOracleUpdate[subAccount] = block.timestamp;
        emit AcquiredBalanceUpdated(subAccount, token, newBalance);
    }

    function batchUpdate(
        address subAccount,
        uint256 newAllowance,
        address[] calldata tokens,
        uint256[] calldata balances
    ) external onlyOwnerOrOracle {
        if (tokens.length != balances.length) revert LengthMismatch();
        _enforceAllowanceCap(newAllowance);

        spendingAllowance[subAccount] = newAllowance;
        lastOracleUpdate[subAccount] = block.timestamp;

        for (uint256 i = 0; i < tokens.length; i++) {
            acquiredBalance[subAccount][tokens[i]] = balances[i];
            emit AcquiredBalanceUpdated(subAccount, tokens[i], balances[i]);
        }

        emit SpendingAllowanceUpdated(subAccount, newAllowance);
    }

    function setAuthorizedOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidOracleAddress();
        if (newOracle == avatar || newOracle == address(this)) revert CannotBeOracle(newOracle);
        if (subAccountRoles[newOracle][DEFI_EXECUTE_ROLE]) revert CannotBeOracle(newOracle);
        address oldOracle = authorizedOracle;
        authorizedOracle = newOracle;
        emit OracleUpdated(oldOracle, newOracle);
    }

    function setAbsoluteMaxSpendingBps(uint256 newMaxBps) external onlyOwner {
        if (newMaxBps > 10000) revert ExceedsMaxBps();
        absoluteMaxSpendingBps = newMaxBps;
    }

    // ============ Price Feed Functions ============

    function setTokenPriceFeed(address token, address priceFeed) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        if (priceFeed == address(0)) revert InvalidPriceFeed();
        tokenPriceFeeds[token] = AggregatorV3Interface(priceFeed);
    }

    function setTokenPriceFeeds(
        address[] calldata tokens,
        address[] calldata priceFeeds
    ) external onlyOwner {
        if (tokens.length != priceFeeds.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokens.length; i++) {
            if (priceFeeds[i] == address(0)) revert InvalidPriceFeed();
            tokenPriceFeeds[tokens[i]] = AggregatorV3Interface(priceFeeds[i]);
        }
    }

    // ============ Internal Helpers ============

    function _requireFreshOracle(address subAccount) internal view {
        if (lastOracleUpdate[subAccount] == 0) revert StaleOracleData();
        if (block.timestamp - lastOracleUpdate[subAccount] > maxOracleAge) revert StaleOracleData();
    }

    function _requireFreshSafeValue() internal view {
        if (safeValue.lastUpdated == 0) revert StalePortfolioValue();
        if (block.timestamp - safeValue.lastUpdated > maxSafeValueAge) revert StalePortfolioValue();
    }

    function _enforceAllowanceCap(uint256 newAllowance) internal view {
        _requireFreshSafeValue();
        uint256 maxAllowance = (safeValue.totalValueUSD * absoluteMaxSpendingBps) / 10000;
        if (newAllowance > maxAllowance) revert ExceedsAbsoluteMaxSpending(newAllowance, maxAllowance);
    }

    function _estimateTokenValueUSD(
        address token,
        uint256 amount
    ) internal view returns (uint256 valueUSD) {
        if (amount == 0) return 0;

        AggregatorV3Interface priceFeed = tokenPriceFeeds[token];
        if (address(priceFeed) == address(0)) revert NoPriceFeedSet();

        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = priceFeed.latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (updatedAt == 0) revert StalePriceFeed();
        if (answeredInRound < roundId) revert StalePriceFeed();
        if (block.timestamp - updatedAt > maxPriceFeedAge) revert StalePriceFeed();

        uint8 priceDecimals = priceFeed.decimals();
        uint256 price = uint256(answer);
        uint8 tokenDecimals = token == address(0) ? 18 : IERC20Metadata(token).decimals();

        valueUSD = Math.mulDiv(
            amount * price,
            10 ** 18,
            10 ** uint256(tokenDecimals + priceDecimals),
            Math.Rounding.Ceil
        );
    }

    function _getOutputTokens(
        address target,
        bytes calldata data,
        ICalldataParser parser
    ) internal view returns (address[] memory) {
        if (address(parser) != address(0)) {
            try parser.extractOutputTokens(target, data) returns (address[] memory tokens) {
                return tokens;
            } catch {
                return new address[](0);
            }
        }
        return new address[](0);
    }

    // ============ View Functions ============

    function getSafeValue() external view returns (uint256 totalValueUSD, uint256 lastUpdated, uint256 updateCount) {
        return (safeValue.totalValueUSD, safeValue.lastUpdated, safeValue.updateCount);
    }

    function getAcquiredBalance(address subAccount, address token) external view returns (uint256) {
        return acquiredBalance[subAccount][token];
    }

    function getSpendingAllowance(address subAccount) external view returns (uint256) {
        return spendingAllowance[subAccount];
    }

    function getTokenBalances(address[] calldata tokens) external view returns (uint256[] memory balances) {
        balances = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = IERC20(tokens[i]).balanceOf(avatar);
        }
    }
}
