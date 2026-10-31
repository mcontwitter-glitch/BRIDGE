// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {NftLockVaultUpgradeable} from "../src/upgradeable/NftLockVaultUpgradeable.sol";
import {MockLayerZeroEndpoint} from "../src/mocks/MockLayerZeroEndpoint.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";
import {SwapPayload} from "../src/libraries/SwapPayload.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";
import {OrdinalsSink} from "../src/ordinals/OrdinalsSink.sol";

contract OrdinalsSinkTest is Test {
    uint32 constant ORD_EID = 30110; // Arbitrum: sink chain (no existing vault peer there)
    bytes constant OPTS = hex"00030100110100000000000000000000000000030d40";
    string constant BTC = "bc1pua8xnvy6cx7g632g3rx8gy5z9qg5s446d267gkzgenmsd6ewkwasrsmmg9";

    MockLayerZeroEndpoint ep; // vault side
    address dstEndpoint; // sink-side endpoint
    NftLockVaultUpgradeable vault;
    OrdinalsSink sink;
    MockERC721 nft;
    address alice = address(0xA11CE);

    event OrdinalsRequested(bytes32 indexed lockId, address indexed collection, uint256 indexed tokenId, address recipientCommitment, string tokenURI, bytes32 guid);

    function setUp() public {
        ep = new MockLayerZeroEndpoint();
        nft = new MockERC721("BIGFOOT404", "BF404");
        NftLockVaultUpgradeable impl = new NftLockVaultUpgradeable();
        vault = NftLockVaultUpgradeable(address(new ERC1967Proxy(address(impl),
            abi.encodeCall(NftLockVaultUpgradeable.initialize, (address(ep), ChainIds.ABSTRACT_EID, address(this))))));
        dstEndpoint = address(new MockLayerZeroEndpoint());
        sink = new OrdinalsSink(dstEndpoint, ChainIds.ABSTRACT_EID, address(vault), address(this));
        // Owner config tx #1 (the only one): register the sink as the vault's peer on the Ordinals eid.
        vault.setPeer(ORD_EID, bytes32(uint256(uint160(address(sink)))));
        vm.deal(alice, 1 ether);
    }

    function _origin() internal view returns (OrdinalsSink.Origin memory) {
        return OrdinalsSink.Origin(ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(address(vault)))), 1);
    }

    /// Lock through the real vault push path with the bc1p commitment as recipient; return the LZ message.
    function _lock() internal returns (uint256 id, bytes32 lockId, bytes memory message) {
        id = nft.mint(alice, "ipfs://mock/1");
        vm.prank(alice); vault.prepayPush{value: 0.001 ether}(address(nft), id);
        address commit = sink.ordinalsRecipient(BTC);
        vm.prank(alice);
        nft.safeTransferFrom(alice, address(vault), id, abi.encode(ORD_EID, bytes32(uint256(uint160(commit))), false, OPTS));
        lockId = vault.activeLockId(address(nft), id);
        message = ep.lastMessage();
    }

    function test_receive_emits_and_mints_nothing() public {
        (uint256 id, bytes32 lockId, bytes memory m) = _lock();
        SwapPayload.LockMintPayload memory p = SwapPayload.decodeLockMint(m);
        assertEq(p.recipient, sink.ordinalsRecipient(BTC));
        assertEq(p.lockId, lockId);
        uint256 balBefore = address(sink).balance;
        vm.expectEmit(true, true, true, true, address(sink));
        emit OrdinalsRequested(lockId, address(nft), id, sink.ordinalsRecipient(BTC), "ipfs://mock/1", bytes32(uint256(1)));
        vm.recordLogs();
        vm.prank(dstEndpoint);
        sink.lzReceive(_origin(), bytes32(uint256(1)), m, address(0), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only OrdinalsRequested, no Transfer/mint");
        assertTrue(sink.seen(lockId));
        assertEq(address(sink).balance, balBefore);
        assertEq(nft.ownerOf(id), address(vault)); // original stays locked
    }

    function test_original_cannot_be_bridged_again_or_unlocked() public {
        (uint256 id, bytes32 lockId,) = _lock();
        assertTrue(lockId != bytes32(0));
        // Vault holds it; a second lock is impossible while active, and only a peer UNLOCK message releases it.
        bytes memory unlock = SwapPayload.encodeUnlockBurn(SwapPayload.UnlockBurnPayload(2, address(nft), id, alice, ORD_EID, lockId));
        // An unlock "from the sink" would need the sink to send one; the sink has no send path at all.
        (bool ok,) = address(sink).call(abi.encodeWithSignature("send(bytes)", unlock));
        assertFalse(ok);
        // Anyone else posing as the sink peer is rejected by the vault (wrong sender).
        vm.expectRevert();
        ep.deliver(address(vault), ORD_EID, bytes32(uint256(uint160(alice))), unlock);
        assertEq(nft.ownerOf(id), address(vault));
    }

    function test_only_endpoint() public {
        (,, bytes memory m) = _lock();
        vm.expectRevert(OrdinalsSink.OnlyEndpoint.selector);
        sink.lzReceive(_origin(), bytes32(0), m, address(0), "");
    }

    function test_only_vault_peer() public {
        (,, bytes memory m) = _lock();
        OrdinalsSink.Origin memory o = _origin();
        o.sender = bytes32(uint256(uint160(address(0xBAD))));
        vm.prank(dstEndpoint);
        vm.expectRevert(abi.encodeWithSelector(OrdinalsSink.NotPeer.selector, o.srcEid, o.sender));
        sink.lzReceive(o, bytes32(0), m, address(0), "");
        o = _origin(); o.srcEid = ChainIds.BASE_EID;
        vm.prank(dstEndpoint);
        vm.expectRevert(abi.encodeWithSelector(OrdinalsSink.NotPeer.selector, o.srcEid, o.sender));
        sink.lzReceive(o, bytes32(0), m, address(0), "");
        assertTrue(sink.allowInitializePath(_origin()));
        o.srcEid = ChainIds.ABSTRACT_EID; o.sender = bytes32(uint256(1));
        assertFalse(sink.allowInitializePath(o));
    }

    function test_replay_rejected() public {
        (, bytes32 lockId, bytes memory m) = _lock();
        vm.startPrank(dstEndpoint);
        sink.lzReceive(_origin(), bytes32(uint256(1)), m, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(OrdinalsSink.Replay.selector, lockId));
        sink.lzReceive(_origin(), bytes32(uint256(2)), m, address(0), "");
        vm.stopPrank();
    }

    function test_rejects_unlock_action_value_and_bad_origin() public {
        bytes memory unlock = SwapPayload.encodeUnlockBurn(SwapPayload.UnlockBurnPayload(2, address(nft), 1, alice, ORD_EID, bytes32(uint256(5))));
        vm.startPrank(dstEndpoint);
        vm.expectRevert(abi.encodeWithSelector(OrdinalsSink.BadAction.selector, uint8(2)));
        sink.lzReceive(_origin(), bytes32(0), unlock, address(0), "");
        bytes memory wrongOrigin = SwapPayload.encodeLockMint(SwapPayload.LockMintPayload(1, address(nft), 1, "u", alice, 30184, bytes32(uint256(6))));
        vm.expectRevert(abi.encodeWithSelector(OrdinalsSink.BadOrigin.selector, uint32(30184)));
        sink.lzReceive(_origin(), bytes32(0), wrongOrigin, address(0), "");
        vm.deal(dstEndpoint, 1 ether);
        bytes memory ok = SwapPayload.encodeLockMint(SwapPayload.LockMintPayload(1, address(nft), 1, "u", alice, ChainIds.ABSTRACT_EID, bytes32(uint256(7))));
        vm.expectRevert(OrdinalsSink.NoValue.selector);
        sink.lzReceive{value: 1}(_origin(), bytes32(0), ok, address(0), "");
        vm.stopPrank();
    }

    function test_commitment_vector() public view {
        // Pinned so the JS front end and the delivery service compute the same address.
        assertEq(sink.ordinalsRecipient(BTC),
            address(uint160(uint256(keccak256(abi.encodePacked("BIGFOOT404-ORDINALS-V1:", BTC))))));
    }

    function test_constructor_zero_args() public {
        vm.expectRevert(OrdinalsSink.ZeroArg.selector);
        new OrdinalsSink(address(0), 30324, address(vault), address(this));
        vm.expectRevert(OrdinalsSink.ZeroArg.selector);
        new OrdinalsSink(dstEndpoint, 30324, address(vault), address(0));
    }
}
