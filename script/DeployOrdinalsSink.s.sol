// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {OrdinalsSink} from "../src/ordinals/OrdinalsSink.sol";
import {ILayerZeroEndpointConfig} from "../src/interfaces/ILayerZeroEndpointConfig.sol";

/// @notice DRY RUN ONLY. Simulates deploying OrdinalsSink on an Arbitrum One fork, simulates the sink's receive
///         config as the delegate, and prints every owner transaction to run later. There is no vm.startBroadcast
///         and no key is read, so even `--broadcast` sends nothing.
///   forge script script/DeployOrdinalsSink.s.sol --rpc-url https://arb1.arbitrum.io/rpc
contract DeployOrdinalsSink is Script {
    // Arbitrum One
    address constant ARB_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    address constant ARB_RECEIVE_ULN = 0x7B9E184e07a6EE1aC23eAe0fe8D6Be2f663f05e6; // ReceiveUln302
    address constant ARB_LZ_LABS_DVN = 0x2f55C492897526677C5B68fb199ea31E2c126416;
    // Abstract
    uint32 constant ABSTRACT_EID = 30324;
    address constant VAULT = 0xe81DdAB112137112B8FeeB853e22BC4c38F999e5;
    address constant VAULT_OWNER = 0xb19F00e095B1387061d73751C772bbA848D196b1; // owner() and LZ delegate, read 2026-10-31
    address constant ABS_SEND_ULN = 0x166CAb679EBDB0853055522D3B523621b94029a1; // SendUln302 (vault's current send lib)
    address constant ABS_LZ_LABS_DVN = 0xF4DA94b4EE9D8e209e3bf9f469221CE2731A7112;
    address constant ABS_EXECUTOR = 0x643E1471f37c4680Df30cF0C540Cd379a0fF58A5; // same executor the vault uses today
    uint32 constant ORDINALS_EID = 30110; // Arbitrum One; the vault has no peer there today
    uint64 constant CONFIRMATIONS = 20;

    function run() external {
        uint256 g0 = gasleft();
        OrdinalsSink sink = new OrdinalsSink(ARB_ENDPOINT, ABSTRACT_EID, VAULT, VAULT_OWNER);
        console2.log("SIMULATED sink (real address = CREATE of the deployer):", address(sink));
        console2.log("deploy gas (execution, approx):", g0 - gasleft());

        // Simulate the delegate's receive config on the fork (proves the endpoint accepts it).
        bytes memory recvCfg = abi.encodeWithSelector(
            ILayerZeroEndpointConfig.setConfig.selector, address(sink), ARB_RECEIVE_ULN, _recvParams()
        );
        bytes memory recvLib = abi.encodeWithSignature(
            "setReceiveLibrary(address,uint32,address,uint256)", address(sink), ABSTRACT_EID, ARB_RECEIVE_ULN, uint256(0)
        );
        vm.startPrank(VAULT_OWNER);
        (bool ok1,) = ARB_ENDPOINT.call(recvLib);
        uint256 g1 = gasleft();
        (bool ok2,) = ARB_ENDPOINT.call(recvCfg);
        console2.log("setReceiveLibrary simulated ok:", ok1);
        console2.log("setConfig (receive ULN) simulated ok:", ok2, "gas ~", g1 - gasleft());
        vm.stopPrank();

        console2.log("=== Owner txs, ARBITRUM ONE (chainId 42161), from delegate", VAULT_OWNER, "to", ARB_ENDPOINT);
        console2.log("A1 setReceiveLibrary(sink, 30324, ReceiveUln302, 0):");
        console2.logBytes(recvLib);
        console2.log("A2 setConfig(sink, ReceiveUln302, [ULN 30324: 20 conf, LZ Labs DVN]):");
        console2.logBytes(recvCfg);

        console2.log("=== Owner txs, ABSTRACT (chainId 2741), from", VAULT_OWNER, "to vault", VAULT);
        console2.log("B1 setSendConfig(SendUln302, 30110, 20, LZ Labs DVN, 10000, executor):");
        console2.logBytes(abi.encodeWithSignature(
            "setSendConfig(address,uint32,uint64,address,uint32,address)",
            ABS_SEND_ULN, ORDINALS_EID, CONFIRMATIONS, ABS_LZ_LABS_DVN, uint32(10000), ABS_EXECUTOR));
        console2.log("B2 setPeer(30110, sink)  -- LAST: this opens the route:");
        console2.logBytes(abi.encodeWithSignature("setPeer(uint32,bytes32)", ORDINALS_EID, bytes32(uint256(uint160(address(sink))))));
        console2.log("(sink address above is a simulation; re-encode A1/A2/B2 with the real one)");
    }

    function _recvParams() internal pure returns (ILayerZeroEndpointConfig.SetConfigParam[] memory p) {
        address[] memory req = new address[](1);
        req[0] = ARB_LZ_LABS_DVN;
        p = new ILayerZeroEndpointConfig.SetConfigParam[](1);
        p[0] = ILayerZeroEndpointConfig.SetConfigParam({
            eid: ABSTRACT_EID,
            configType: 2,
            config: abi.encode(ILayerZeroEndpointConfig.UlnConfig({
                confirmations: CONFIRMATIONS, requiredDVNCount: 1, optionalDVNCount: 0, optionalDVNThreshold: 0,
                requiredDVNs: req, optionalDVNs: new address[](0)}))
        });
    }
}
