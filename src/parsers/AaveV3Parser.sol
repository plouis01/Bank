// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICalldataParser} from "../interfaces/ICalldataParser.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";

/**
 * @title AaveV3Parser
 * @notice Calldata parser for Aave V3 Pool and RewardsController operations
 * @dev Copied from MultiSub. BORROW intentionally not supported.
 */
contract AaveV3Parser is ICalldataParser {
    error UnsupportedSelector();
    error InvalidCalldata();

    bytes4 public constant SUPPLY_SELECTOR = 0x617ba037;
    bytes4 public constant WITHDRAW_SELECTOR = 0x69328dec;
    bytes4 public constant REPAY_SELECTOR = 0x573ade81;

    bytes4 public constant CLAIM_REWARDS_SELECTOR = 0x236300dc;
    bytes4 public constant CLAIM_REWARDS_ON_BEHALF_SELECTOR = 0x33028b99;
    bytes4 public constant CLAIM_ALL_REWARDS_SELECTOR = 0xbb492bf5;
    bytes4 public constant CLAIM_ALL_ON_BEHALF_SELECTOR = 0x9ff55db9;

    function extractInputTokens(address, bytes calldata data) external pure override returns (address[] memory tokens) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);

        if (selector == SUPPLY_SELECTOR || selector == REPAY_SELECTOR) {
            tokens = new address[](1);
            tokens[0] = abi.decode(data[4:], (address));
            return tokens;
        } else if (_isClaimSelector(selector) || selector == WITHDRAW_SELECTOR) {
            return new address[](0);
        }
        revert UnsupportedSelector();
    }

    function extractInputAmounts(address, bytes calldata data) external pure override returns (uint256[] memory amounts) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);

        if (selector == SUPPLY_SELECTOR || selector == REPAY_SELECTOR) {
            amounts = new uint256[](1);
            (, amounts[0]) = abi.decode(data[4:], (address, uint256));
            return amounts;
        } else if (_isClaimSelector(selector) || selector == WITHDRAW_SELECTOR) {
            return new uint256[](0);
        }
        revert UnsupportedSelector();
    }

    function extractOutputTokens(address target, bytes calldata data) external view override returns (address[] memory tokens) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);

        if (selector == SUPPLY_SELECTOR) {
            address asset = abi.decode(data[4:], (address));
            tokens = new address[](1);
            tokens[0] = IAavePool(target).getReserveData(asset).aTokenAddress;
            return tokens;
        } else if (selector == REPAY_SELECTOR) {
            return new address[](0);
        } else if (selector == WITHDRAW_SELECTOR) {
            tokens = new address[](1);
            tokens[0] = abi.decode(data[4:], (address));
            return tokens;
        } else if (selector == CLAIM_REWARDS_SELECTOR) {
            address token;
            (, , , token) = abi.decode(data[4:], (address[], uint256, address, address));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == CLAIM_REWARDS_ON_BEHALF_SELECTOR) {
            address token;
            (, , , , token) = abi.decode(data[4:], (address[], uint256, address, address, address));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == CLAIM_ALL_REWARDS_SELECTOR || selector == CLAIM_ALL_ON_BEHALF_SELECTOR) {
            return new address[](0);
        }
        revert UnsupportedSelector();
    }

    function extractRecipient(address, bytes calldata data, address defaultRecipient) external pure override returns (address recipient) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);

        if (selector == SUPPLY_SELECTOR) {
            (,, recipient,) = abi.decode(data[4:], (address, uint256, address, uint16));
        } else if (selector == WITHDRAW_SELECTOR) {
            (,, recipient) = abi.decode(data[4:], (address, uint256, address));
        } else if (selector == REPAY_SELECTOR) {
            (,,, recipient) = abi.decode(data[4:], (address, uint256, uint256, address));
        } else if (selector == CLAIM_REWARDS_SELECTOR) {
            (,, recipient,) = abi.decode(data[4:], (address[], uint256, address, address));
        } else if (selector == CLAIM_REWARDS_ON_BEHALF_SELECTOR) {
            (,,, recipient,) = abi.decode(data[4:], (address[], uint256, address, address, address));
        } else if (selector == CLAIM_ALL_REWARDS_SELECTOR) {
            (, recipient) = abi.decode(data[4:], (address[], address));
        } else if (selector == CLAIM_ALL_ON_BEHALF_SELECTOR) {
            (,, recipient) = abi.decode(data[4:], (address[], address, address));
        } else {
            revert UnsupportedSelector();
        }
    }

    function supportsSelector(bytes4 selector) external pure override returns (bool) {
        return selector == SUPPLY_SELECTOR ||
               selector == WITHDRAW_SELECTOR ||
               selector == REPAY_SELECTOR ||
               _isClaimSelector(selector);
    }

    function getOperationType(bytes calldata data) external pure override returns (uint8 opType) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);
        if (selector == SUPPLY_SELECTOR) return 2;
        if (selector == WITHDRAW_SELECTOR || selector == REPAY_SELECTOR) return 3;
        if (_isClaimSelector(selector)) return 4;
        return 0;
    }

    function _isClaimSelector(bytes4 selector) internal pure returns (bool) {
        return selector == CLAIM_REWARDS_SELECTOR ||
               selector == CLAIM_REWARDS_ON_BEHALF_SELECTOR ||
               selector == CLAIM_ALL_REWARDS_SELECTOR ||
               selector == CLAIM_ALL_ON_BEHALF_SELECTOR;
    }
}
