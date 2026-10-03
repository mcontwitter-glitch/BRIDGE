// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftTwinMinter} from "../src/NftTwinMinter.sol";
import {MockLayerZeroEndpoint} from "../src/mocks/MockLayerZeroEndpoint.sol";
import {MockTwinCollection} from "../src/mocks/MockTwinCollection.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

/// @notice Deploy twin collection + NftTwinMinter on a dest chain (ETH/Base/BNB/Ape).
/// Env: DEST_EID, LZ_ENDPOINT_DEST, TWIN_COLLECTION (optional — deploys mock if unset)
contract DeployDest is Script {
    function run() external {
        uint32 eid = uint32(vm.envOr("DEST_EID", uint256(ChainIds.BASE_EID)));
        address endpointAddr = vm.envOr("LZ_ENDPOINT_DEST", address(0));
        address twin = vm.envOr("TWIN_COLLECTION", address(0));

        vm.startBroadcast();

        if (endpointAddr == address(0)) {
            MockLayerZeroEndpoint mock = new MockLayerZeroEndpoint();
            endpointAddr = address(mock);
            console2.log("MockLayerZeroEndpoint:", endpointAddr);
        }

        if (twin == address(0)) {
            MockTwinCollection col =
                new MockTwinCollection("BIGFOOT404 Twin", "BF404T", msg.sender);
            twin = address(col);
            console2.log("MockTwinCollection:", twin);
        }

        NftTwinMinter minter = new NftTwinMinter(endpointAddr, eid, twin);
        console2.log("NftTwinMinter:", address(minter));
        console2.log("DEST_EID:", eid);

        // Grant minter role if we just deployed mock collection
        if (vm.envOr("TWIN_COLLECTION", address(0)) == address(0)) {
            MockTwinCollection(twin).grantRole(MockTwinCollection(twin).MINTER_ROLE(), address(minter));
            console2.log("Granted MINTER_ROLE to minter");
        }

        vm.stopBroadcast();
    }
}
