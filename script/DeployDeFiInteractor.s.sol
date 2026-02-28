// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {DeFiInteractor} from "../src/DeFiInteractor.sol";

/**
 * @title DeployDeFiInteractor
 * @notice Deploy DeFiInteractor module for a Tier B M2 Safe
 * @dev Usage: forge script script/DeployDeFiInteractor.s.sol --rpc-url $RPC_URL --broadcast
 *      Required env vars: M2_SAFE_ADDRESS, ORACLE_ADDRESS, DEPLOYER_PRIVATE_KEY
 */
contract DeployDeFiInteractor is Script {
    function run() external {
        address m2Safe = vm.envAddress("M2_SAFE_ADDRESS");
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // Owner is M2 Safe, oracle is owner-settable (test-oracle pattern)
        DeFiInteractor defi = new DeFiInteractor(m2Safe, m2Safe, oracle);

        console.log("DeFiInteractor deployed at:", address(defi));
        console.log("Avatar (M2 Safe):", m2Safe);
        console.log("Oracle:", oracle);

        vm.stopBroadcast();
    }
}
