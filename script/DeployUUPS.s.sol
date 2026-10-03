// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {NftLockVaultUpgradeable} from "../src/upgradeable/NftLockVaultUpgradeable.sol";
import {NftTwinMinterUpgradeable} from "../src/upgradeable/NftTwinMinterUpgradeable.sol";

/// @notice Deploy a UUPS vault or minter. KIND=vault|minter. No key in source.
contract DeployUUPS is Script {
    function run() external {
        address endpoint = vm.envAddress("LZ_ENDPOINT");
        uint32 eid = uint32(vm.envUint("LOCAL_EID"));
        address owner = vm.envAddress("OWNER");
        string memory kind = vm.envString("KIND");

        vm.startBroadcast();
        address impl;
        address proxy;
        if (keccak256(bytes(kind)) == keccak256("vault")) {
            NftLockVaultUpgradeable implementation = new NftLockVaultUpgradeable();
            impl = address(implementation);
            bytes memory init = abi.encodeCall(NftLockVaultUpgradeable.initialize, (endpoint, eid, owner));
            proxy = address(new ERC1967Proxy(impl, init));
        } else if (keccak256(bytes(kind)) == keccak256("minter")) {
            NftTwinMinterUpgradeable implementation = new NftTwinMinterUpgradeable();
            impl = address(implementation);
            bytes memory init = abi.encodeCall(NftTwinMinterUpgradeable.initialize, (endpoint, eid, owner));
            proxy = address(new ERC1967Proxy(impl, init));
        } else {
            revert("bad KIND");
        }
        vm.stopBroadcast();

        console2.log("kind", kind);
        console2.log("implementation", impl);
        console2.log("proxy", proxy);
        console2.log("endpoint", endpoint);
        console2.log("localEid", eid);
        console2.log("owner", owner);
    }
}
