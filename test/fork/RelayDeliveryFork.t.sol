// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExecutorDVN} from "../../src/dvn/ExecutorDVN.sol";

interface IMinterView {
    function minted(bytes32 lockId) external view returns (bool);
}

interface IEndpointNonce {
    function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) external view returns (uint64);
}

/// @notice Runs only with RELAY_FORK_RPC, RELAY_FORK_DVN, RELAY_FORK_PACKET, RELAY_FORK_SIG set.
/// @dev Uses deployed bytecode. A random wallet sends verifyAndCommit with the signer's signature.
contract RelayDeliveryForkTest is Test {
    function test_deployedVerifierMintsInsideUserTransaction() public {
        string memory rpc = vm.envOr("RELAY_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        ExecutorDVN dvn = ExecutorDVN(vm.envAddress("RELAY_FORK_DVN"));
        bytes memory packet = vm.envBytes("RELAY_FORK_PACKET");
        bytes memory sig = vm.envBytes("RELAY_FORK_SIG");
        address minter = vm.envAddress("RELAY_FORK_MINTER");
        bytes32 lockId = vm.envBytes32("RELAY_FORK_LOCK_ID");

        assertEq(dvn.signer(), vm.envAddress("RELAY_FORK_SIGNER"));
        assertFalse(IMinterView(minter).minted(lockId));

        address user = makeAddr("normal-user");
        vm.deal(user, 1 ether);

        vm.prank(user);
        vm.expectRevert(ExecutorDVN.MissingSignature.selector);
        dvn.verifyAndCommit(packet, "");

        bytes memory tampered = bytes.concat(packet, hex"00");
        vm.prank(user);
        vm.expectRevert(ExecutorDVN.BadSigner.selector);
        dvn.verifyAndCommit(tampered, sig);

        vm.prank(user);
        dvn.verifyAndCommit(packet, sig);
        assertTrue(IMinterView(minter).minted(lockId));
        assertEq(
            IEndpointNonce(dvn.endpoint()).lazyInboundNonce(
                minter, 30324, bytes32(uint256(uint160(0xe81DdAB112137112B8FeeB853e22BC4c38F999e5)))
            ),
            1
        );
    }
}
