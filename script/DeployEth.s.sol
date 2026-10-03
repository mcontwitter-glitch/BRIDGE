// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftTwinMinter} from "../src/NftTwinMinter.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

/// @notice Deploy the Ethereum twin minter and point it at the Abstract vault.
contract DeployEth is Script {
    address internal constant ETH_LZ_ENDPOINT_V2 = 0x1a44076050125825900e736c501f859c50fE728c;
    address internal constant ABSTRACT_VAULT = 0xAaB3eEb4ef0BC311D79898A0B84FC74D24f64622;

    function run() external {
        vm.startBroadcast();
        NftTwinMinter minter = new NftTwinMinter(ETH_LZ_ENDPOINT_V2, ChainIds.ETHEREUM_EID);
        minter.setPeer(ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(ABSTRACT_VAULT))));
        vm.stopBroadcast();

        console2.log("NftTwinMinter", address(minter));
        console2.log("lzEndpoint", ETH_LZ_ENDPOINT_V2);
    }
}
