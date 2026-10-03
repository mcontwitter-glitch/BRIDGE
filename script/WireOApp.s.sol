// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftLockVaultUpgradeable} from "../src/upgradeable/NftLockVaultUpgradeable.sol";

/// @notice One owner tx: setDelegate, setPeer, setSendConfig, setReceiveConfig.
contract WireOApp is Script {
    function run() external {
        NftLockVaultUpgradeable oapp = NftLockVaultUpgradeable(payable(vm.envAddress("OAPP")));
        uint32 remoteEid = uint32(vm.envUint("REMOTE_EID"));
        address peer = vm.envAddress("PEER");
        address sendLib = vm.envAddress("SEND_LIB");
        address receiveLib = vm.envAddress("RECEIVE_LIB");
        address dvn = vm.envAddress("DVN");
        address executor = vm.envAddress("EXECUTOR");
        uint64 sendConf = uint64(vm.envUint("SEND_CONFIRMATIONS"));
        uint64 recvConf = uint64(vm.envUint("RECV_CONFIRMATIONS"));
        uint32 maxSize = uint32(vm.envOr("MAX_MESSAGE_SIZE", uint256(10000)));
        address delegate = vm.envAddress("DELEGATE");

        vm.startBroadcast();
        oapp.configureRemote(
            remoteEid,
            bytes32(uint256(uint160(peer))),
            delegate,
            sendLib,
            receiveLib,
            sendConf,
            recvConf,
            dvn,
            maxSize,
            executor
        );
        vm.stopBroadcast();

        console2.log("wired", address(oapp));
        console2.log("remoteEid", remoteEid);
    }
}
