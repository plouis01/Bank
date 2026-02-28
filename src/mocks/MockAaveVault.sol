// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAavePool} from "../interfaces/IAavePool.sol";
import {MockERC20Mintable} from "./MockERC20Mintable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockAaveVault
 * @notice Parser-compliant Aave V3 Pool mock for Monad testnet.
 * @dev Implements the exact function signatures that AaveV3Parser expects:
 *      - supply(address,uint256,address,uint16) selector 0x617ba037
 *      - withdraw(address,uint256,address)      selector 0x69328dec
 *      - repay(address,uint256,uint256,address)  selector 0x573ade81
 *      - getReserveData(address) returns ReserveData with aTokenAddress
 *
 *      On supply: transfers underlying from caller, mints aToken 1:1 to onBehalfOf.
 *      On withdraw: burns aToken from msg.sender, returns underlying to recipient.
 *      On repay: transfers underlying from caller (simulates debt repayment).
 */
contract MockAaveVault is IAavePool {
    using SafeERC20 for IERC20;

    /// @notice Maps underlying asset → mock aToken address
    mapping(address => address) public aTokens;

    /// @notice Maps underlying asset → per-user balances (for tracking)
    mapping(address => mapping(address => uint256)) public userDeposits;

    /// @notice Owner for admin operations
    address public owner;

    event AssetSupplied(address indexed asset, address indexed onBehalfOf, uint256 amount);
    event AssetWithdrawn(address indexed asset, address indexed to, uint256 amount);
    event DebtRepaid(address indexed asset, address indexed onBehalfOf, uint256 amount);
    event ATokenCreated(address indexed asset, address indexed aToken);

    error OnlyOwner();
    error AssetNotSupported();
    error InsufficientBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Register a supported asset by deploying a mock aToken for it.
     * @param asset The underlying ERC20 token address
     */
    function addAsset(address asset) external onlyOwner returns (address aToken) {
        if (aTokens[asset] != address(0)) return aTokens[asset];

        string memory name = string.concat("Aave Mock ", IERC20Metadata(asset).name());
        string memory symbol = string.concat("a", IERC20Metadata(asset).symbol());
        uint8 dec = IERC20Metadata(asset).decimals();

        aToken = address(new MockERC20Mintable(name, symbol, dec));
        aTokens[asset] = aToken;

        emit ATokenCreated(asset, aToken);
    }

    /**
     * @notice Manually set an aToken address for an asset (for pre-deployed aTokens).
     */
    function setAToken(address asset, address aToken) external onlyOwner {
        aTokens[asset] = aToken;
        emit ATokenCreated(asset, aToken);
    }

    // ============ Aave V3 Pool Interface ============

    /**
     * @notice Supply assets to the pool. Selector: 0x617ba037
     * @param asset The underlying token to supply
     * @param amount Amount to supply
     * @param onBehalfOf Recipient of the aTokens
     * @param referralCode Unused (Aave referral system)
     */
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external {
        referralCode; // silence unused warning
        address aToken = aTokens[asset];
        if (aToken == address(0)) revert AssetNotSupported();

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        MockERC20Mintable(aToken).mint(onBehalfOf, amount);
        userDeposits[asset][onBehalfOf] += amount;

        emit AssetSupplied(asset, onBehalfOf, amount);
    }

    /**
     * @notice Withdraw assets from the pool. Selector: 0x69328dec
     * @param asset The underlying token to withdraw
     * @param amount Amount to withdraw (type(uint256).max for full balance)
     * @param to Recipient of the underlying tokens
     * @return The actual amount withdrawn
     */
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        address aToken = aTokens[asset];
        if (aToken == address(0)) revert AssetNotSupported();

        uint256 aBalance = IERC20(aToken).balanceOf(msg.sender);
        uint256 withdrawAmount = amount == type(uint256).max ? aBalance : amount;
        if (withdrawAmount > aBalance) revert InsufficientBalance();

        MockERC20Mintable(aToken).burn(msg.sender, withdrawAmount);
        IERC20(asset).safeTransfer(to, withdrawAmount);

        if (userDeposits[asset][msg.sender] >= withdrawAmount) {
            userDeposits[asset][msg.sender] -= withdrawAmount;
        } else {
            userDeposits[asset][msg.sender] = 0;
        }

        emit AssetWithdrawn(asset, to, withdrawAmount);
        return withdrawAmount;
    }

    /**
     * @notice Repay borrowed assets. Selector: 0x573ade81
     * @param asset The token to repay
     * @param amount Amount to repay
     * @param rateMode Interest rate mode (unused in mock)
     * @param onBehalfOf The borrower whose debt to repay
     * @return The actual amount repaid
     */
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256) {
        rateMode; // silence unused warning
        onBehalfOf; // silence unused warning
        // Just accept the tokens (simulates debt repayment)
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        emit DebtRepaid(asset, onBehalfOf, amount);
        return amount;
    }

    /**
     * @notice Get reserve data for an asset. Critical for AaveV3Parser.extractOutputTokens().
     * @param asset The underlying token
     * @return data ReserveData struct with aTokenAddress populated
     */
    function getReserveData(address asset) external view override returns (ReserveData memory data) {
        data.aTokenAddress = aTokens[asset];
        data.lastUpdateTimestamp = uint40(block.timestamp);
        data.liquidityIndex = 1e27; // RAY = 1.0 (no interest accrued)
        data.currentLiquidityRate = 0;
    }

    /**
     * @notice Allow owner to rescue tokens accidentally sent to this contract.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }
}
