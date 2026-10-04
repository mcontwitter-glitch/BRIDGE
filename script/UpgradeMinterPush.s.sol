// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftTwinMinterUpgradeable} from "../src/upgradeable/NftTwinMinterUpgradeable.sol";

/// @notice Deploy a new minter implementation and UUPS-upgrade the live proxy.
/// @dev No initializer call. Peers, delegate, DVN, and endpoint storage stay put.
///      The signer is the owner. Do not pass a private key in source.
contract UpgradeMinterPush is Script {
    function run() external {
        address proxy = vm.envAddress("MINTER_PROXY");
        vm.startBroadcast();
        NftTwinMinterUpgradeable implementation = new NftTwinMinterUpgradeable();
        NftTwinMinterUpgradeable(proxy).upgradeToAndCall(address(implementation), "");
        vm.stopBroadcast();
        console2.log("implementation", address(implementation));
        console2.log("proxy", proxy);
    }
}
