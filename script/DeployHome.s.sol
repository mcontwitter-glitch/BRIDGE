// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NftLockVault} from "../src/NftLockVault.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

/// @title DeployHome
/// @notice Deploy NftLockVault on Abstract mainnet against the official LayerZero Endpoint V2.
/// @dev This script does not contain a private key. `vm.startBroadcast` only sends a
///      transaction when the owner runs `forge script --broadcast` with their own key
///      and Abstract ETH. A plain `forge script` simulation does not broadcast.
///
/// Official endpoint (hardcoded):
/// https://metadata.layerzero-api.com/v1/metadata
/// chainKey "abstract" -> deployments[version=2, eid=30324].endpointV2.address
contract DeployHome is Script {
    /// @dev Abstract mainnet LayerZero Endpoint V2 (eid 30324).
    address internal constant ABSTRACT_LZ_ENDPOINT_V2 = 0x5c6cfF4b7C49805F8295Ff73C204ac83f3bC4AE7;

    function run() external {
        uint32 eid = ChainIds.ABSTRACT_EID;

        vm.startBroadcast();
        NftLockVault vault = new NftLockVault(ABSTRACT_LZ_ENDPOINT_V2, eid);
        vm.stopBroadcast();

        console2.log("NftLockVault", address(vault));
        console2.log("lzEndpoint", ABSTRACT_LZ_ENDPOINT_V2);
        console2.log("localEid", eid);
    }
}
