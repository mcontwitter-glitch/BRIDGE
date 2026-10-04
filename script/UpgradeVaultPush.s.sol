// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftLockVaultUpgradeable} from "../src/upgradeable/NftLockVaultUpgradeable.sol";

/// @notice Deploy a new vault implementation and UUPS-upgrade the live proxy.
/// @dev No initializer call. Peers, delegate, and endpoint storage stay put.
///      The signer is the owner. Do not pass a private key in source.
contract UpgradeVaultPush is Script {
    function run() external {
        address proxy = vm.envAddress("VAULT_PROXY");
        vm.startBroadcast();
        NftLockVaultUpgradeable implementation = new NftLockVaultUpgradeable();
        NftLockVaultUpgradeable(proxy).upgradeToAndCall(address(implementation), "");
        vm.stopBroadcast();
        console2.log("implementation", address(implementation));
        console2.log("proxy", proxy);
    }
}
