// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICalldataParser} from "../interfaces/ICalldataParser.sol";

/**
 * @title INonfungiblePositionManager
 * @notice Interface for querying position details from Uniswap V3 NonfungiblePositionManager
 */
interface INonfungiblePositionManager {
    function positions(uint256 tokenId) external view returns (
        uint96 nonce,
        address operator,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 feeGrowthInside0LastX128,
        uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0,
        uint128 tokensOwed1
    );
}

/**
 * @title UniswapV3Parser
 * @notice Calldata parser for Uniswap V3 SwapRouter and NonfungiblePositionManager operations
 * @dev Extracts token/amount from Uniswap V3 function calldata
 *
 *      Supported contracts:
 *      - SwapRouter (0xE592427A0AEce92De3Edee1F18E0157C05861564)
 *      - SwapRouter02 (0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45)
 *      - NonfungiblePositionManager (0xC36442b4a4522E871399CD717aBDD847Ab11FE88)
 *
 *      Note on INCREASE_LIQUIDITY:
 *      - Queries the position's token0 on-chain via the NonfungiblePositionManager
 *      - Both token0 and token1 are spent, but we track token0 for spending calculations
 *      - Balance differences are tracked to capture actual amounts spent
 */
contract UniswapV3Parser is ICalldataParser {
    error UnsupportedSelector();
    error InvalidCalldata();
    error InvalidPath();

    // ============ SwapRouter Selectors ============

    // Uniswap V3 SwapRouter function selectors (with deadline in struct)
    bytes4 public constant EXACT_INPUT_SINGLE_SELECTOR = 0x414bf389;  // exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
    bytes4 public constant EXACT_INPUT_SELECTOR = 0xc04b8d59;          // exactInput((bytes,address,uint256,uint256,uint256))
    bytes4 public constant EXACT_OUTPUT_SINGLE_SELECTOR = 0xdb3e2198; // exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
    bytes4 public constant EXACT_OUTPUT_SELECTOR = 0xf28c0498;         // exactOutput((bytes,address,uint256,uint256,uint256))

    // SwapRouter02 function selectors (no deadline in struct, handled via multicall)
    bytes4 public constant EXACT_INPUT_SINGLE_02_SELECTOR = 0x04e45aaf;  // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
    bytes4 public constant EXACT_INPUT_02_SELECTOR = 0xb858183f;          // exactInput((bytes,address,uint256,uint256))
    bytes4 public constant EXACT_OUTPUT_SINGLE_02_SELECTOR = 0x5023b4df; // exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))
    bytes4 public constant EXACT_OUTPUT_02_SELECTOR = 0x09b81346;         // exactOutput((bytes,address,uint256,uint256))

    // ============ NonfungiblePositionManager Selectors ============

    // mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))
    bytes4 public constant MINT_SELECTOR = 0x88316456;
    // increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))
    bytes4 public constant INCREASE_LIQUIDITY_SELECTOR = 0x219f5d17;
    // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
    bytes4 public constant DECREASE_LIQUIDITY_SELECTOR = 0x0c49ccbe;
    // collect((uint256,address,uint128,uint128))
    bytes4 public constant COLLECT_SELECTOR = 0xfc6f7865;

    /// @inheritdoc ICalldataParser
    function extractInputTokens(address target, bytes calldata data) external view override returns (address[] memory tokens) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);
        address token;

        // ============ SwapRouter Functions (single input token) ============
        if (selector == EXACT_INPUT_SINGLE_SELECTOR) {
            (token,,,,,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint256, uint160));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_INPUT_SINGLE_02_SELECTOR) {
            (token,,,,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint160));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_OUTPUT_SINGLE_SELECTOR) {
            (token,,,,,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint256, uint160));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_OUTPUT_SINGLE_02_SELECTOR) {
            (token,,,,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint160));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_INPUT_SELECTOR) {
            (bytes memory path,,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(path, 32)))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_INPUT_02_SELECTOR) {
            (bytes memory path,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(path, 32)))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_OUTPUT_SELECTOR) {
            (bytes memory path,,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_OUTPUT_02_SELECTOR) {
            (bytes memory path,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        }
        // ============ NonfungiblePositionManager Functions (dual input tokens) ============
        else if (selector == MINT_SELECTOR) {
            // MintParams: (token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline)
            // Both tokens are inputs
            (address token0, address token1,,,,,,,,,) = abi.decode(data[4:], (address, address, uint24, int24, int24, uint256, uint256, uint256, uint256, address, uint256));
            tokens = new address[](2);
            tokens[0] = token0;
            tokens[1] = token1;
            return tokens;
        } else if (selector == INCREASE_LIQUIDITY_SELECTOR) {
            // IncreaseLiquidityParams: (tokenId, amount0Desired, amount1Desired, amount0Min, amount1Min, deadline)
            // Query the position's tokens from the NonfungiblePositionManager
            (uint256 tokenId,,,,,) = abi.decode(data[4:], (uint256, uint256, uint256, uint256, uint256, uint256));
            (,, address token0, address token1,,,,,,,,) = INonfungiblePositionManager(target).positions(tokenId);
            tokens = new address[](2);
            tokens[0] = token0;
            tokens[1] = token1;
            return tokens;
        } else if (selector == DECREASE_LIQUIDITY_SELECTOR || selector == COLLECT_SELECTOR) {
            // These are withdraw/claim operations - no input tokens
            return new address[](0);
        } else {
            revert UnsupportedSelector();
        }
    }

    /// @inheritdoc ICalldataParser
    function extractInputAmounts(address, bytes calldata data) external pure override returns (uint256[] memory amounts) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);
        uint256 amount;

        // ============ SwapRouter Functions (single input amount) ============
        if (selector == EXACT_INPUT_SINGLE_SELECTOR) {
            (,,,,, amount,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint256, uint160));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        } else if (selector == EXACT_INPUT_SINGLE_02_SELECTOR) {
            (,,,, amount,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint160));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        } else if (selector == EXACT_INPUT_SELECTOR) {
            (,,, amount,) = abi.decode(data[4:], (bytes, address, uint256, uint256, uint256));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        } else if (selector == EXACT_INPUT_02_SELECTOR) {
            (,, amount,) = abi.decode(data[4:], (bytes, address, uint256, uint256));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        } else if (selector == EXACT_OUTPUT_SINGLE_SELECTOR) {
            (,,,,,, amount,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint256, uint160));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        } else if (selector == EXACT_OUTPUT_SINGLE_02_SELECTOR) {
            (,,,,, amount,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint160));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        } else if (selector == EXACT_OUTPUT_SELECTOR) {
            (,,,, amount) = abi.decode(data[4:], (bytes, address, uint256, uint256, uint256));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        } else if (selector == EXACT_OUTPUT_02_SELECTOR) {
            (,,, amount) = abi.decode(data[4:], (bytes, address, uint256, uint256));
            amounts = new uint256[](1);
            amounts[0] = amount;
            return amounts;
        }
        // ============ NonfungiblePositionManager Functions (dual input amounts) ============
        else if (selector == MINT_SELECTOR) {
            // MintParams: (token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline)
            (,,,,, uint256 amount0Desired, uint256 amount1Desired,,,) = abi.decode(data[4:], (address, address, uint24, int24, int24, uint256, uint256, uint256, uint256, address));
            amounts = new uint256[](2);
            amounts[0] = amount0Desired;
            amounts[1] = amount1Desired;
            return amounts;
        } else if (selector == INCREASE_LIQUIDITY_SELECTOR) {
            // IncreaseLiquidityParams: (tokenId, amount0Desired, amount1Desired, amount0Min, amount1Min, deadline)
            (, uint256 amount0Desired, uint256 amount1Desired,,,) = abi.decode(data[4:], (uint256, uint256, uint256, uint256, uint256, uint256));
            amounts = new uint256[](2);
            amounts[0] = amount0Desired;
            amounts[1] = amount1Desired;
            return amounts;
        } else if (selector == DECREASE_LIQUIDITY_SELECTOR || selector == COLLECT_SELECTOR) {
            // These are withdraw/claim operations - no input amounts
            return new uint256[](0);
        } else {
            revert UnsupportedSelector();
        }
    }

    /// @inheritdoc ICalldataParser
    function extractOutputTokens(address target, bytes calldata data) external view override returns (address[] memory tokens) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);
        address token;

        // ============ SwapRouter Functions ============
        if (selector == EXACT_INPUT_SINGLE_SELECTOR || selector == EXACT_OUTPUT_SINGLE_SELECTOR) {
            // tokenOut is second field (V1)
            (, token,,,,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint256, uint160));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_INPUT_SINGLE_02_SELECTOR || selector == EXACT_OUTPUT_SINGLE_02_SELECTOR) {
            // tokenOut is second field (V2, no deadline)
            (, token,,,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint160));
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_INPUT_SELECTOR) {
            // ExactInputParams (V1): path contains tokenOut as last 20 bytes
            (bytes memory path,,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_INPUT_02_SELECTOR) {
            // ExactInputParams (V2): no deadline
            (bytes memory path,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_OUTPUT_SELECTOR) {
            // ExactOutputParams (V1): path is reversed, tokenOut is first 20 bytes
            (bytes memory path,,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(path, 32)))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        } else if (selector == EXACT_OUTPUT_02_SELECTOR) {
            // ExactOutputParams (V2): no deadline
            (bytes memory path,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256));
            if (path.length < 20) revert InvalidPath();
            assembly {
                token := shr(96, mload(add(path, 32)))
            }
            tokens = new address[](1);
            tokens[0] = token;
            return tokens;
        }
        // ============ NonfungiblePositionManager Functions ============
        else if (selector == MINT_SELECTOR || selector == INCREASE_LIQUIDITY_SELECTOR) {
            // Deposit operations - no output tokens (LP NFT is not tracked)
            return new address[](0);
        } else if (selector == DECREASE_LIQUIDITY_SELECTOR) {
            // DecreaseLiquidityParams: (tokenId, liquidity, amount0Min, amount1Min, deadline)
            // Returns both token0 and token1 - query position for tokens
            (uint256 tokenId,,,,) = abi.decode(data[4:], (uint256, uint128, uint256, uint256, uint256));
            (,, address token0, address token1,,,,,,,,) = INonfungiblePositionManager(target).positions(tokenId);
            tokens = new address[](2);
            tokens[0] = token0;
            tokens[1] = token1;
            return tokens;
        } else if (selector == COLLECT_SELECTOR) {
            // CollectParams: (tokenId, recipient, amount0Max, amount1Max)
            // Returns fees in both token0 and token1 - query position for tokens
            (uint256 tokenId,,,) = abi.decode(data[4:], (uint256, address, uint128, uint128));
            (,, address token0, address token1,,,,,,,,) = INonfungiblePositionManager(target).positions(tokenId);
            tokens = new address[](2);
            tokens[0] = token0;
            tokens[1] = token1;
            return tokens;
        } else {
            revert UnsupportedSelector();
        }
    }

    /// @inheritdoc ICalldataParser
    function extractRecipient(address, bytes calldata data, address defaultRecipient) external pure override returns (address recipient) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);

        // ============ SwapRouter Functions ============
        if (selector == EXACT_INPUT_SINGLE_SELECTOR || selector == EXACT_OUTPUT_SINGLE_SELECTOR) {
            // V1 Single: (tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMin, sqrtPriceLimitX96)
            (,,, recipient,,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint256, uint160));
        } else if (selector == EXACT_INPUT_SINGLE_02_SELECTOR || selector == EXACT_OUTPUT_SINGLE_02_SELECTOR) {
            // V2 Single (no deadline): (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMin, sqrtPriceLimitX96)
            (,,, recipient,,,) = abi.decode(data[4:], (address, address, uint24, address, uint256, uint256, uint160));
        } else if (selector == EXACT_INPUT_SELECTOR || selector == EXACT_OUTPUT_SELECTOR) {
            // V1 Multi: (path, recipient, deadline, amountIn, amountOutMin)
            (, recipient,,,) = abi.decode(data[4:], (bytes, address, uint256, uint256, uint256));
        } else if (selector == EXACT_INPUT_02_SELECTOR || selector == EXACT_OUTPUT_02_SELECTOR) {
            // V2 Multi (no deadline): (path, recipient, amountIn, amountOutMin)
            (, recipient,,) = abi.decode(data[4:], (bytes, address, uint256, uint256));
        }
        // ============ NonfungiblePositionManager Functions ============
        else if (selector == MINT_SELECTOR) {
            // MintParams: (token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline)
            (,,,,,,,,, recipient,) = abi.decode(data[4:], (address, address, uint24, int24, int24, uint256, uint256, uint256, uint256, address, uint256));
        } else if (selector == INCREASE_LIQUIDITY_SELECTOR || selector == DECREASE_LIQUIDITY_SELECTOR) {
            // These operate on existing positions owned by the caller
            // No explicit recipient - tokens go to/from msg.sender (Safe)
            return defaultRecipient;
        } else if (selector == COLLECT_SELECTOR) {
            // CollectParams: (tokenId, recipient, amount0Max, amount1Max)
            (, recipient,,) = abi.decode(data[4:], (uint256, address, uint128, uint128));
        } else {
            revert UnsupportedSelector();
        }
    }

    /// @inheritdoc ICalldataParser
    function supportsSelector(bytes4 selector) external pure override returns (bool) {
        return selector == EXACT_INPUT_SINGLE_SELECTOR ||
               selector == EXACT_INPUT_SELECTOR ||
               selector == EXACT_OUTPUT_SINGLE_SELECTOR ||
               selector == EXACT_OUTPUT_SELECTOR ||
               selector == EXACT_INPUT_SINGLE_02_SELECTOR ||
               selector == EXACT_INPUT_02_SELECTOR ||
               selector == EXACT_OUTPUT_SINGLE_02_SELECTOR ||
               selector == EXACT_OUTPUT_02_SELECTOR ||
               selector == MINT_SELECTOR ||
               selector == INCREASE_LIQUIDITY_SELECTOR ||
               selector == DECREASE_LIQUIDITY_SELECTOR ||
               selector == COLLECT_SELECTOR;
    }

    /**
     * @notice Get the operation type for the given calldata
     * @param data The calldata to analyze
     * @return opType 1=SWAP, 2=DEPOSIT, 3=WITHDRAW, 4=CLAIM, 5=APPROVE
     */
    function getOperationType(bytes calldata data) external pure override returns (uint8 opType) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector = bytes4(data[:4]);
        // Swap operations
        if (selector == EXACT_INPUT_SINGLE_SELECTOR ||
            selector == EXACT_INPUT_SELECTOR ||
            selector == EXACT_OUTPUT_SINGLE_SELECTOR ||
            selector == EXACT_OUTPUT_SELECTOR ||
            selector == EXACT_INPUT_SINGLE_02_SELECTOR ||
            selector == EXACT_INPUT_02_SELECTOR ||
            selector == EXACT_OUTPUT_SINGLE_02_SELECTOR ||
            selector == EXACT_OUTPUT_02_SELECTOR) {
            return 1; // SWAP
        }
        // Deposit operations (adding liquidity)
        if (selector == MINT_SELECTOR || selector == INCREASE_LIQUIDITY_SELECTOR) {
            return 2; // DEPOSIT
        }
        // Withdraw operations (removing liquidity)
        if (selector == DECREASE_LIQUIDITY_SELECTOR) {
            return 3; // WITHDRAW
        }
        // Claim operations (collecting fees)
        if (selector == COLLECT_SELECTOR) {
            return 4; // CLAIM
        }
        return 0; // UNKNOWN
    }
}
