// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";
import {MockChainlinkPriceFeedDeployable} from "../src/mocks/MockChainlinkPriceFeedDeployable.sol";
import {MockAaveVault} from "../src/mocks/MockAaveVault.sol";
import {SpendInteractor} from "../src/SpendInteractor.sol";
import {DeFiInteractor} from "../src/DeFiInteractor.sol";
import {IntEOA} from "../src/IntEOA.sol";
import {AaveV3Parser} from "../src/parsers/AaveV3Parser.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";

/**
 * @title DeployAll
 * @notice End-to-end deployment script for S4b on Monad testnet.
 *
 *         Deploys mock infrastructure (tokens, price feeds, Aave vault),
 *         M2 modules (SpendInteractor, DeFiInteractor, IntEOA),
 *         configures everything, and optionally deploys M1 Treasury modules.
 *
 * @dev Usage:
 *      forge script script/DeployAll.s.sol --rpc-url $MONAD_TESTNET_RPC_URL --broadcast
 *
 *      Required env vars:
 *        DEPLOYER_PRIVATE_KEY  - Deployer + initial owner key
 *        M2_SAFE_ADDRESS       - M2 Safe address (pre-deployed or mock)
 *
 *      Optional env vars:
 *        ORACLE_ADDRESS        - Oracle EOA (defaults to deployer)
 *        CARD_EOA              - Card spending EOA (defaults to deployer)
 *        TRANSFER_EOA          - Transfer spending EOA (defaults to deployer)
 *        DEFI_EOA              - DeFi execution EOA (defaults to deployer)
 *        DEPLOY_M1             - Set to "true" to deploy M1 Treasury modules
 *        M1_SAFE_ADDRESS       - M1 Safe address (required if DEPLOY_M1=true)
 */
contract DeployAll is Script {
    // Transfer types for SpendInteractor
    uint8 constant TYPE_PAYMENT = 0;
    uint8 constant TYPE_TRANSFER = 1;

    // Aave V3 selectors
    bytes4 constant SUPPLY_SELECTOR = 0x617ba037;
    bytes4 constant WITHDRAW_SELECTOR = 0x69328dec;
    bytes4 constant REPAY_SELECTOR = 0x573ade81;

    // Deployed addresses
    MockERC20Mintable public usdc;
    MockERC20Mintable public weth;
    MockERC20Mintable public dai;

    MockChainlinkPriceFeedDeployable public usdcFeed;
    MockChainlinkPriceFeedDeployable public ethFeed;
    MockChainlinkPriceFeedDeployable public daiFeed;

    MockAaveVault public aaveVault;
    AaveV3Parser public aaveParser;

    SpendInteractor public spendInteractor;
    DeFiInteractor public defiInteractor;
    IntEOA public intEOA;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address m2Safe = vm.envAddress("M2_SAFE_ADDRESS");
        address oracle = vm.envOr("ORACLE_ADDRESS", deployer);
        address cardEOA = vm.envOr("CARD_EOA", deployer);
        address transferEOA = vm.envOr("TRANSFER_EOA", deployer);
        address defiEOA = vm.envOr("DEFI_EOA", deployer);

        console.log("=== S4b Full Deployment ===");
        console.log("Deployer:", deployer);
        console.log("M2 Safe:", m2Safe);
        console.log("Oracle:", oracle);

        vm.startBroadcast(deployerKey);

        // ============ Phase 1: Mock Infrastructure ============
        console.log("");
        console.log("--- Phase 1: Mock Infrastructure ---");

        _deployTokens();
        _deployPriceFeeds();
        _deployAaveVault();
        _mintInitialSupply(deployer, m2Safe);

        // ============ Phase 2: M2 Modules ============
        console.log("");
        console.log("--- Phase 2: M2 Modules ---");

        // Deploy with deployer as owner (for configuration), then transfer to m2Safe
        spendInteractor = new SpendInteractor(m2Safe, deployer);
        console.log("SpendInteractor:", address(spendInteractor));

        defiInteractor = new DeFiInteractor(m2Safe, deployer, oracle);
        console.log("DeFiInteractor:", address(defiInteractor));

        intEOA = new IntEOA(m2Safe, deployer);
        console.log("IntEOA:", address(intEOA));

        aaveParser = new AaveV3Parser();
        console.log("AaveV3Parser:", address(aaveParser));

        // ============ Phase 3: Configure M2 Modules ============
        console.log("");
        console.log("--- Phase 3: Configuration ---");

        _configureSpendInteractor(cardEOA, transferEOA);
        _configureDeFiInteractor(defiEOA);
        _configureIntEOA(cardEOA, transferEOA, defiEOA);

        // ============ Phase 4: M1 Treasury (Optional) ============
        bool deployM1 = vm.envOr("DEPLOY_M1", false);
        if (deployM1) {
            console.log("");
            console.log("--- Phase 4: M1 Treasury ---");
            _deployM1Treasury();
        }

        vm.stopBroadcast();

        // ============ Output Summary ============
        _printSummary(deployer, m2Safe, oracle, cardEOA, transferEOA, defiEOA);

        // Write JSON deployment file
        _writeDeploymentJson();
    }

    // ============ Phase 1: Mock Infrastructure ============

    function _deployTokens() internal {
        usdc = new MockERC20Mintable("USD Coin", "USDC", 6);
        console.log("USDC:", address(usdc));

        weth = new MockERC20Mintable("Wrapped Ether", "WETH", 18);
        console.log("WETH:", address(weth));

        dai = new MockERC20Mintable("Dai Stablecoin", "DAI", 18);
        console.log("DAI:", address(dai));
    }

    function _deployPriceFeeds() internal {
        // USDC/USD: $1.00 (8 decimals like Chainlink)
        usdcFeed = new MockChainlinkPriceFeedDeployable(1e8, 8, "USDC / USD");
        console.log("PriceFeed USDC/USD:", address(usdcFeed));

        // ETH/USD: $3000 (8 decimals)
        ethFeed = new MockChainlinkPriceFeedDeployable(3000e8, 8, "ETH / USD");
        console.log("PriceFeed ETH/USD:", address(ethFeed));

        // DAI/USD: $1.00 (8 decimals)
        daiFeed = new MockChainlinkPriceFeedDeployable(1e8, 8, "DAI / USD");
        console.log("PriceFeed DAI/USD:", address(daiFeed));
    }

    function _deployAaveVault() internal {
        aaveVault = new MockAaveVault();
        console.log("MockAaveVault:", address(aaveVault));

        // Register supported assets (creates mock aTokens)
        address aUsdc = aaveVault.addAsset(address(usdc));
        console.log("aUSDC:", aUsdc);

        address aWeth = aaveVault.addAsset(address(weth));
        console.log("aWETH:", aWeth);

        address aDai = aaveVault.addAsset(address(dai));
        console.log("aDAI:", aDai);
    }

    function _mintInitialSupply(address deployer, address m2Safe) internal {
        // Mint to deployer for initial operations
        usdc.mint(deployer, 1_000_000e6);    // 1M USDC
        weth.mint(deployer, 1_000e18);        // 1000 WETH
        dai.mint(deployer, 1_000_000e18);     // 1M DAI

        // Fund M2 Safe for DeFi operations
        usdc.mint(m2Safe, 100_000e6);         // 100K USDC
        weth.mint(m2Safe, 100e18);            // 100 WETH
        dai.mint(m2Safe, 100_000e18);         // 100K DAI

        console.log("Initial supply minted to deployer and M2 Safe");
    }

    // ============ Phase 3: Configuration ============

    function _configureSpendInteractor(address cardEOA, address transferEOA) internal {
        // Register card EOA: 500 EUR/day, payments only
        uint8[] memory cardTypes = new uint8[](1);
        cardTypes[0] = TYPE_PAYMENT;
        spendInteractor.registerEOA(cardEOA, 500e18, cardTypes);
        console.log("SpendInteractor: registered card EOA", cardEOA, "limit 500/day");

        // Register transfer EOA: 5000 EUR/day, payments + transfers
        uint8[] memory transferTypes = new uint8[](2);
        transferTypes[0] = TYPE_PAYMENT;
        transferTypes[1] = TYPE_TRANSFER;
        spendInteractor.registerEOA(transferEOA, 5000e18, transferTypes);
        console.log("SpendInteractor: registered transfer EOA", transferEOA, "limit 5000/day");
    }

    function _configureDeFiInteractor(address defiEOA) internal {
        // Set token price feeds
        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);
        tokens[2] = address(dai);
        address[] memory feeds = new address[](3);
        feeds[0] = address(usdcFeed);
        feeds[1] = address(ethFeed);
        feeds[2] = address(daiFeed);
        defiInteractor.setTokenPriceFeeds(tokens, feeds);
        console.log("DeFiInteractor: set price feeds for USDC, WETH, DAI");

        // Also set price feeds for aTokens (same price as underlying)
        address aUsdc = aaveVault.aTokens(address(usdc));
        address aWeth = aaveVault.aTokens(address(weth));
        address aDai = aaveVault.aTokens(address(dai));

        address[] memory aTokens = new address[](3);
        aTokens[0] = aUsdc;
        aTokens[1] = aWeth;
        aTokens[2] = aDai;
        defiInteractor.setTokenPriceFeeds(aTokens, feeds);
        console.log("DeFiInteractor: set price feeds for aUSDC, aWETH, aDAI");

        // Register Aave V3 selectors
        // supply = DEPOSIT (costs spending, tracked for withdrawal)
        defiInteractor.registerSelector(SUPPLY_SELECTOR, DeFiInteractor.OperationType.DEPOSIT);
        // withdraw = WITHDRAW (free, becomes acquired if matched)
        defiInteractor.registerSelector(WITHDRAW_SELECTOR, DeFiInteractor.OperationType.WITHDRAW);
        // repay = WITHDRAW (free, reduces debt)
        defiInteractor.registerSelector(REPAY_SELECTOR, DeFiInteractor.OperationType.WITHDRAW);
        console.log("DeFiInteractor: registered Aave V3 selectors (supply/withdraw/repay)");

        // Register AaveV3Parser for MockAaveVault
        defiInteractor.registerParser(address(aaveVault), address(aaveParser));
        console.log("DeFiInteractor: registered AaveV3Parser for MockAaveVault");

        // Grant DEFI_EXECUTE_ROLE to defi EOA
        defiInteractor.grantRole(defiEOA, 1); // DEFI_EXECUTE_ROLE
        console.log("DeFiInteractor: granted DEFI_EXECUTE_ROLE to", defiEOA);

        // Set sub-account limits: 5% max spending, 24h window
        defiInteractor.setSubAccountLimits(defiEOA, 500, 1 days);
        console.log("DeFiInteractor: set sub-account limits (5%, 24h)");

        // Set allowed addresses for defi EOA
        address[] memory allowedTargets = new address[](1);
        allowedTargets[0] = address(aaveVault);
        defiInteractor.setAllowedAddresses(defiEOA, allowedTargets, true);
        console.log("DeFiInteractor: whitelisted MockAaveVault for defi EOA");

        // Set initial oracle state
        defiInteractor.updateSafeValue(500_000e18); // $500K initial safe value
        defiInteractor.updateSpendingAllowance(defiEOA, 25_000e18); // $25K = 5% of $500K
        console.log("DeFiInteractor: set initial safe value ($500K) and spending allowance ($25K)");
    }

    function _configureIntEOA(address cardEOA, address transferEOA, address defiEOA) internal {
        // Register EOAs
        intEOA.registerEOA(cardEOA);
        intEOA.registerEOA(transferEOA);
        intEOA.registerEOA(defiEOA);
        console.log("IntEOA: registered 3 EOAs");

        // Set allowed targets: card/transfer -> SpendInteractor, defi -> DeFiInteractor
        address[] memory spendTarget = new address[](1);
        spendTarget[0] = address(spendInteractor);
        intEOA.setAllowedTargets(cardEOA, spendTarget, true);
        intEOA.setAllowedTargets(transferEOA, spendTarget, true);

        address[] memory defiTarget = new address[](1);
        defiTarget[0] = address(defiInteractor);
        intEOA.setAllowedTargets(defiEOA, defiTarget, true);
        console.log("IntEOA: set allowed targets (card/transfer->Spend, defi->DeFi)");
    }

    // ============ Phase 4: M1 Treasury (Optional) ============

    function _deployM1Treasury() internal {
        address m1Safe = vm.envAddress("M1_SAFE_ADDRESS");

        TreasuryTimelock timelock = new TreasuryTimelock(
            m1Safe,
            m1Safe,
            1 days,     // 24h min delay
            100_000e18  // $100K threshold
        );
        console.log("TreasuryTimelock:", address(timelock));

        TreasuryVault vault = new TreasuryVault(
            m1Safe,
            m1Safe,
            10_000e18,  // $10K operator limit
            100_000e18  // $100K manager limit
        );
        console.log("TreasuryVault:", address(vault));
    }

    // ============ Output ============

    function _printSummary(
        address deployer,
        address m2Safe,
        address oracle,
        address cardEOA,
        address transferEOA,
        address defiEOA
    ) internal view {
        console.log("");
        console.log("============================================");
        console.log("  S4b Deployment Complete");
        console.log("============================================");
        console.log("");
        console.log("# test-oracle/.env");
        console.log("MODULE_ADDRESS=", address(defiInteractor));
        console.log("PRIVATE_KEY=<oracle-private-key>");
        console.log("TOKEN_USDC=", address(usdc));
        console.log("TOKEN_WETH=", address(weth));
        console.log("TOKEN_DAI=", address(dai));
        console.log("TOKEN_AUSDC=", aaveVault.aTokens(address(usdc)));
        console.log("TOKEN_AWETH=", aaveVault.aTokens(address(weth)));
        console.log("TOKEN_ADAI=", aaveVault.aTokens(address(dai)));
        console.log("PRICE_FEED_USDC_USD=", address(usdcFeed));
        console.log("PRICE_FEED_ETH_USD=", address(ethFeed));
        console.log("PRICE_FEED_DAI_USD=", address(daiFeed));
        console.log("");
        console.log("# indexer/.env");
        console.log("SPEND_INTERACTOR_ADDRESS=", address(spendInteractor));
        console.log("DEFI_INTERACTOR_ADDRESS=", address(defiInteractor));
        console.log("");
        console.log("# Key addresses");
        console.log("M2_SAFE=", m2Safe);
        console.log("DEPLOYER=", deployer);
        console.log("ORACLE=", oracle);
        console.log("CARD_EOA=", cardEOA);
        console.log("TRANSFER_EOA=", transferEOA);
        console.log("DEFI_EOA=", defiEOA);
        console.log("MOCK_AAVE_VAULT=", address(aaveVault));
        console.log("AAVE_PARSER=", address(aaveParser));
        console.log("INT_EOA=", address(intEOA));
    }

    function _writeDeploymentJson() internal {
        string memory json = string.concat(
            '{\n',
            '  "network": "monad-testnet",\n',
            '  "chainId": 10143,\n',
            _jsonAddr("usdc", address(usdc)), ',\n',
            _jsonAddr("weth", address(weth)), ',\n',
            _jsonAddr("dai", address(dai)), ',\n',
            _jsonAddr("aUsdc", aaveVault.aTokens(address(usdc))), ',\n',
            _jsonAddr("aWeth", aaveVault.aTokens(address(weth))), ',\n',
            _jsonAddr("aDai", aaveVault.aTokens(address(dai))), ',\n',
            _jsonAddr("priceFeedUsdcUsd", address(usdcFeed)), ',\n',
            _jsonAddr("priceFeedEthUsd", address(ethFeed)), ',\n',
            _jsonAddr("priceFeedDaiUsd", address(daiFeed)), ',\n',
            _jsonAddr("mockAaveVault", address(aaveVault)), ',\n',
            _jsonAddr("aaveV3Parser", address(aaveParser)), ',\n',
            _jsonAddr("spendInteractor", address(spendInteractor)), ',\n',
            _jsonAddr("defiInteractor", address(defiInteractor)), ',\n',
            _jsonAddr("intEOA", address(intEOA)), '\n',
            '}'
        );

        vm.writeFile("deployments/monad-testnet.json", json);
        console.log("");
        console.log("Deployment JSON written to deployments/monad-testnet.json");
    }

    function _jsonAddr(string memory key, address addr) internal pure returns (string memory) {
        return string.concat('  "', key, '": "', vm.toString(addr), '"');
    }
}
