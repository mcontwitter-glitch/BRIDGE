// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftTwinMinter} from "../src/NftTwinMinter.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

contract DeployRobinhood is Script {
    address internal constant ROBINHOOD_LZ_ENDPOINT_V2 = 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B;
    address internal constant ABSTRACT_VAULT = 0xAaB3eEb4ef0BC311D79898A0B84FC74D24f64622;
    uint32 internal constant ROBINHOOD_EID = 30416;

    function run() external {
        vm.startBroadcast();
        NftTwinMinter minter = new NftTwinMinter(ROBINHOOD_LZ_ENDPOINT_V2, ROBINHOOD_EID);
        minter.setPeer(ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(ABSTRACT_VAULT))));
        vm.stopBroadcast();
        console2.log("NftTwinMinter", address(minter));
    }
}
