// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {SpendInteractor} from "../src/SpendInteractor.sol";

/**
 * @title ConfigureSpendInteractor
 * @notice Register EOA sub-accounts on SpendInteractor
 * @dev Usage: forge script script/ConfigureSpendInteractor.s.sol --rpc-url $RPC_URL --broadcast
 *      Required env vars: SPEND_INTERACTOR_ADDRESS, CARD_EOA, TRANSFER_EOA, OWNER_PRIVATE_KEY
 */
contract ConfigureSpendInteractor is Script {
    uint8 constant TYPE_PAYMENT = 0;
    uint8 constant TYPE_TRANSFER = 1;
    uint8 constant TYPE_INTERBANK = 2;

    function run() external {
        address interactorAddr = vm.envAddress("SPEND_INTERACTOR_ADDRESS");
        address cardEOA = vm.envAddress("CARD_EOA");
        address transferEOA = vm.envAddress("TRANSFER_EOA");
        uint256 ownerKey = vm.envUint("OWNER_PRIVATE_KEY");

        SpendInteractor interactor = SpendInteractor(interactorAddr);

        vm.startBroadcast(ownerKey);

        // Register card EOA: €500/day, payments only
        uint8[] memory cardTypes = new uint8[](1);
        cardTypes[0] = TYPE_PAYMENT;
        interactor.registerEOA(cardEOA, 500e18, cardTypes);
        console.log("Card EOA registered:", cardEOA, "limit: 500 EUR/day");

        // Register transfer EOA: €5000/day, payments + transfers
        uint8[] memory transferTypes = new uint8[](2);
        transferTypes[0] = TYPE_PAYMENT;
        transferTypes[1] = TYPE_TRANSFER;
        interactor.registerEOA(transferEOA, 5000e18, transferTypes);
        console.log("Transfer EOA registered:", transferEOA, "limit: 5000 EUR/day");

        vm.stopBroadcast();
    }
}
