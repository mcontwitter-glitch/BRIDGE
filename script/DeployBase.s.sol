// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftTwinMinter} from "../src/NftTwinMinter.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

contract DeployBase is Script {
    address internal constant BASE_LZ_ENDPOINT_V2 = 0x1a44076050125825900e736c501f859c50fE728c;
    address internal constant ABSTRACT_VAULT = 0xAaB3eEb4ef0BC311D79898A0B84FC74D24f64622;
    uint32 internal constant BASE_EID = 30184;

    function run() external {
        vm.startBroadcast();
        NftTwinMinter minter = new NftTwinMinter(BASE_LZ_ENDPOINT_V2, BASE_EID);
        minter.setPeer(ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(ABSTRACT_VAULT))));
        vm.stopBroadcast();
        console2.log("NftTwinMinter", address(minter));
    }
}
