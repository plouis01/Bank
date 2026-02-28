// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeFiInteractor} from "../../src/DeFiInteractor.sol";
import {MockSafe} from "../mocks/MockSafe.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockProtocol} from "../mocks/MockProtocol.sol";
import {MockChainlinkPriceFeed} from "../mocks/MockChainlinkPriceFeed.sol";
import {MockParser} from "../mocks/MockParser.sol";

abstract contract DeFiInteractorBase is Test {
    DeFiInteractor public defiModule;
    MockSafe public safe;
    MockERC20 public token;
    MockProtocol public protocol;
    MockChainlinkPriceFeed public priceFeed;
    MockParser public parser;

    address public owner;
    address public oracle;
    address public subAccount1;
    address public subAccount2;
    address public recipient;

    bytes4 constant DEPOSIT_SELECTOR = bytes4(keccak256("deposit(uint256,address)"));
    bytes4 constant WITHDRAW_SELECTOR = bytes4(keccak256("withdraw(uint256,address)"));
    bytes4 constant APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));

    function setUp() public virtual {
        owner = address(this);
        oracle = makeAddr("oracle");
        subAccount1 = makeAddr("subAccount1");
        subAccount2 = makeAddr("subAccount2");
        recipient = makeAddr("recipient");

        address[] memory owners = new address[](1);
        owners[0] = owner;
        safe = new MockSafe(owners, 1);

        // Deploy module: owner and oracle are SEPARATE addresses (production-like)
        defiModule = new DeFiInteractor(address(safe), owner, oracle);

        token = new MockERC20();
        protocol = new MockProtocol();
        priceFeed = new MockChainlinkPriceFeed(1_00000000, 8); // $1.00
        parser = new MockParser(address(token));

        safe.enableModule(address(defiModule));
        token.transfer(address(safe), 100000 * 10**18);

        // Owner can call oracle functions directly (test-oracle pattern)
        defiModule.updateSafeValue(1_000_000 * 10**18);
        defiModule.setTokenPriceFeed(address(token), address(priceFeed));

        defiModule.registerSelector(DEPOSIT_SELECTOR, DeFiInteractor.OperationType.DEPOSIT);
        defiModule.registerSelector(WITHDRAW_SELECTOR, DeFiInteractor.OperationType.WITHDRAW);
        defiModule.registerSelector(APPROVE_SELECTOR, DeFiInteractor.OperationType.APPROVE);

        defiModule.registerParser(address(protocol), address(parser));
    }
}
