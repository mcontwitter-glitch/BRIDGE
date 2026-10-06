// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {NftLockVaultUpgradeable} from "../src/upgradeable/NftLockVaultUpgradeable.sol";
import {MockLayerZeroEndpoint} from "../src/mocks/MockLayerZeroEndpoint.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";
import {SwapPayload} from "../src/libraries/SwapPayload.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

/// @dev Allows owner-initiated transfers (caller == from) and rejects pulls.
contract OwnerFromOk is MockERC721 {
    error CallerOrFromMustBeWhitelisted();

    constructor() MockERC721("LIL", "LIL") {}

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (msg.sender != from) revert CallerOrFromMustBeWhitelisted();
        super.transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public override {
        if (msg.sender != from) revert CallerOrFromMustBeWhitelisted();
        super.safeTransferFrom(from, to, tokenId, data);
    }
}

/// @dev Also rejects the vault when it is the owner and the caller (smart-wallet OTC).
contract ContractCallerBlocked is MockERC721 {
    error OTCNotAllowedForSmartWallets();

    constructor() MockERC721("LIL", "LIL") {}

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (msg.sender != from || from.code.length > 0) revert OTCNotAllowedForSmartWallets();
        super.transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public override {
        if (msg.sender != from) revert OTCNotAllowedForSmartWallets();
        super.safeTransferFrom(from, to, tokenId, data);
    }
}

contract PushLockTest is Test {
    MockLayerZeroEndpoint ep;
    NftLockVaultUpgradeable vault;
    MockERC721 nft;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address peer = address(0xDE57);

    bytes constant OPTS = hex"000301001101000000000000000000000000004c4b40";

    function setUp() public {
        ep = new MockLayerZeroEndpoint();
        nft = new MockERC721("BIGFOOT404", "BF404");
        NftLockVaultUpgradeable impl = new NftLockVaultUpgradeable();
        bytes memory init = abi.encodeCall(
            NftLockVaultUpgradeable.initialize, (address(ep), ChainIds.ABSTRACT_EID, address(this))
        );
        vault = NftLockVaultUpgradeable(address(new ERC1967Proxy(address(impl), init)));
        vault.setPeer(ChainIds.BASE_EID, bytes32(uint256(uint160(peer))));
        vm.deal(alice, 10 ether);
    }

    function _pushData(address recipient) internal pure returns (bytes memory) {
        return abi.encode(ChainIds.BASE_EID, bytes32(uint256(uint160(recipient))), false, OPTS);
    }

    function test_storageSlotsUnshifted() public view {
        assertEq(uint256(uint160(vault.owner())), uint256(vm.load(address(vault), bytes32(uint256(0)))));
        assertEq(uint256(uint160(address(vault.endpoint()))), uint256(vm.load(address(vault), bytes32(uint256(1)))));
        assertEq(vault.localEid(), uint32(uint256(vm.load(address(vault), bytes32(uint256(4))))));
        // pushCredit lives at the old last gap slot
        bytes32 credit = vm.load(address(vault), bytes32(uint256(46)));
        assertEq(uint256(credit), 0);
        assertEq(vault.peers(ChainIds.BASE_EID), bytes32(uint256(uint160(peer))));
    }

    function test_userPushLocksWithoutApproval() public {
        uint256 tokenId = nft.mint(alice, "ipfs://Qm/1");
        vm.startPrank(alice);
        vault.prepayPush{value: 0.001 ether}(address(nft), tokenId);
        nft.safeTransferFrom(alice, address(vault), tokenId, _pushData(alice));
        vm.stopPrank();

        assertEq(nft.ownerOf(tokenId), address(vault));
        bytes32 lockId = vault.activeLockId(address(nft), tokenId);
        assertTrue(lockId != bytes32(0));
        (,, address owner,, , bool active) = vault.locks(lockId);
        assertEq(owner, alice);
        assertTrue(active);
        assertEq(vault.pushCredit(alice, address(nft), tokenId), 0);
        assertGt(ep.lastMessage().length, 0);
    }

    function test_lockAndSwapDoesNotPull() public {
        uint256 tokenId = nft.mint(alice, "ipfs://Qm/2");
        vm.startPrank(alice);
        nft.approve(address(vault), tokenId);
        vm.expectRevert(NftLockVaultUpgradeable.VaultDoesNotPull.selector);
        vault.lockAndSwap{value: 0.001 ether}(address(nft), tokenId, ChainIds.BASE_EID, alice, OPTS);
        vm.stopPrank();
        assertEq(nft.ownerOf(tokenId), alice);
    }

    function test_transferWithoutFeeOrDataReverts() public {
        uint256 tokenId = nft.mint(alice, "ipfs://Qm/3");
        vm.startPrank(alice);
        vm.expectRevert(NftLockVaultUpgradeable.InsufficientPushFee.selector);
        nft.safeTransferFrom(alice, address(vault), tokenId, _pushData(alice));
        vm.expectRevert(NftLockVaultUpgradeable.BridgeDataRequired.selector);
        nft.safeTransferFrom(alice, address(vault), tokenId, "");
        vm.stopPrank();
        assertEq(nft.ownerOf(tokenId), alice);
    }

    function test_returnLockedRemoved() public {
        // Live Abstract impl has no returnLocked; keep it out of the upgrade.
        (bool ok,) = address(vault).call(abi.encodeWithSignature("returnLocked(bytes32)", bytes32(uint256(1))));
        assertFalse(ok);
    }

    function test_prepayPushBatchCreditsEach() public {
        uint256 a = nft.mint(alice, "ipfs://Qm/b1");
        uint256 b = nft.mint(alice, "ipfs://Qm/b2");
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        uint256[] memory vals = new uint256[](2);
        vals[0] = 0.001 ether;
        vals[1] = 0.002 ether;
        vm.prank(alice);
        vault.prepayPushBatch{value: 0.003 ether}(address(nft), ids, vals);
        assertEq(vault.pushCredit(alice, address(nft), a), 0.001 ether);
        assertEq(vault.pushCredit(alice, address(nft), b), 0.002 ether);

        vm.prank(alice);
        vm.expectRevert(NftLockVaultUpgradeable.ValueMismatch.selector);
        vault.prepayPushBatch{value: 0.001 ether}(address(nft), ids, vals);

        uint256[] memory empty;
        vm.prank(alice);
        vm.expectRevert(NftLockVaultUpgradeable.EmptyBatch.selector);
        vault.prepayPushBatch{value: 0}(address(nft), empty, empty);
    }

    function test_lockBatchWithApprovalAndPrepaid() public {
        uint256 a = nft.mint(alice, "ipfs://Qm/lb1");
        uint256 b = nft.mint(alice, "ipfs://Qm/lb2");
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        uint256[] memory vals = new uint256[](2);
        vals[0] = 0.001 ether;
        vals[1] = 0.001 ether;

        vm.startPrank(alice);
        vault.prepayPushBatch{value: 0.002 ether}(address(nft), ids, vals);
        nft.setApprovalForAll(address(vault), true);
        bytes32[] memory lockIds = vault.lockBatch(address(nft), ids, ChainIds.BASE_EID, alice, OPTS);
        vm.stopPrank();

        assertEq(lockIds.length, 2);
        assertEq(nft.ownerOf(a), address(vault));
        assertEq(nft.ownerOf(b), address(vault));
        assertEq(vault.activeLockId(address(nft), a), lockIds[0]);
        assertEq(vault.activeLockId(address(nft), b), lockIds[1]);
        assertTrue(lockIds[0] != lockIds[1]);
        assertEq(vault.pushCredit(alice, address(nft), a), 0);
        assertEq(vault.pushCredit(alice, address(nft), b), 0);
        (,, address ownerA,, , bool activeA) = vault.locks(lockIds[0]);
        (,, address ownerB,, , bool activeB) = vault.locks(lockIds[1]);
        assertEq(ownerA, alice);
        assertEq(ownerB, alice);
        assertTrue(activeA);
        assertTrue(activeB);
    }

    function test_lockBatchRequiresApproval() public {
        uint256 a = nft.mint(alice, "ipfs://Qm/lb3");
        uint256[] memory ids = new uint256[](1);
        ids[0] = a;
        vm.startPrank(alice);
        vm.expectRevert(NftLockVaultUpgradeable.NotApproved.selector);
        vault.lockBatch{value: 0.001 ether}(address(nft), ids, ChainIds.BASE_EID, alice, OPTS);
        vm.stopPrank();
    }

    function test_unlockSendsToBuyerNotOriginalBridger() public {
        uint256 tokenId = nft.mint(alice, "ipfs://Qm/4");
        vm.startPrank(alice);
        vault.prepayPush{value: 0.001 ether}(address(nft), tokenId);
        nft.safeTransferFrom(alice, address(vault), tokenId, _pushData(bob));
        vm.stopPrank();
        bytes32 lockId = vault.activeLockId(address(nft), tokenId);

        bytes memory unlockMsg = SwapPayload.encodeUnlockBurn(
            SwapPayload.UnlockBurnPayload({
                action: SwapPayload.ACTION_UNLOCK_BURN,
                collection: address(nft),
                tokenId: tokenId,
                recipient: bob,
                destEid: ChainIds.BASE_EID,
                lockId: lockId
            })
        );
        vm.prank(address(ep));
        vault.lzReceive(ChainIds.BASE_EID, bytes32(uint256(uint160(peer))), bytes32(0), unlockMsg, "");
        assertEq(nft.ownerOf(tokenId), bob);
        (,,,,, bool active) = vault.locks(lockId);
        assertFalse(active);
    }

    function test_ownerFromReturnPassesPullBlock() public {
        OwnerFromOk blocked = new OwnerFromOk();
        uint256 tokenId = blocked.mint(alice, "ipfs://Qm/5");
        vm.startPrank(alice);
        vault.prepayPush{value: 0.001 ether}(address(blocked), tokenId);
        blocked.safeTransferFrom(alice, address(vault), tokenId, _pushData(alice));
        vm.stopPrank();
        bytes32 lockId = vault.activeLockId(address(blocked), tokenId);
        bytes memory unlockMsg = SwapPayload.encodeUnlockBurn(
            SwapPayload.UnlockBurnPayload({
                action: SwapPayload.ACTION_UNLOCK_BURN,
                collection: address(blocked),
                tokenId: tokenId,
                recipient: bob,
                destEid: ChainIds.BASE_EID,
                lockId: lockId
            })
        );
        vm.prank(address(ep));
        vault.lzReceive(ChainIds.BASE_EID, bytes32(uint256(uint160(peer))), bytes32(0), unlockMsg, "");
        assertEq(blocked.ownerOf(tokenId), bob);
    }

    function test_returnStillRevertsIfValidatorBlocksContractCaller() public {
        ContractCallerBlocked blocked = new ContractCallerBlocked();
        uint256 tokenId = blocked.mint(alice, "ipfs://Qm/6");
        vm.startPrank(alice);
        vault.prepayPush{value: 0.001 ether}(address(blocked), tokenId);
        blocked.safeTransferFrom(alice, address(vault), tokenId, _pushData(alice));
        vm.stopPrank();
        bytes32 lockId = vault.activeLockId(address(blocked), tokenId);
        bytes memory unlockMsg = SwapPayload.encodeUnlockBurn(
            SwapPayload.UnlockBurnPayload({
                action: SwapPayload.ACTION_UNLOCK_BURN,
                collection: address(blocked),
                tokenId: tokenId,
                recipient: bob,
                destEid: ChainIds.BASE_EID,
                lockId: lockId
            })
        );
        vm.prank(address(ep));
        vm.expectRevert(ContractCallerBlocked.OTCNotAllowedForSmartWallets.selector);
        vault.lzReceive(ChainIds.BASE_EID, bytes32(uint256(uint160(peer))), bytes32(0), unlockMsg, "");
        assertEq(blocked.ownerOf(tokenId), address(vault));
    }

    function test_endpointV2ReceiveUnlocksAndPathChecks() public {
        uint256 tokenId = nft.mint(alice, "ipfs://Qm/7");
        vm.startPrank(alice);
        vault.prepayPush{value: 0.001 ether}(address(nft), tokenId);
        nft.safeTransferFrom(alice, address(vault), tokenId, _pushData(bob));
        vm.stopPrank();
        bytes32 lockId = vault.activeLockId(address(nft), tokenId);

        bytes32 peerRaw = bytes32(uint256(uint160(peer)));
        NftLockVaultUpgradeable.LzOrigin memory origin = NftLockVaultUpgradeable.LzOrigin({
            srcEid: ChainIds.BASE_EID,
            sender: peerRaw,
            nonce: 1
        });
        assertTrue(vault.allowInitializePath(origin));
        origin.sender = bytes32(0);
        assertFalse(vault.allowInitializePath(origin));
        origin.sender = bytes32(uint256(uint160(address(0xBEEF))));
        assertFalse(vault.allowInitializePath(origin));
        assertEq(vault.nextNonce(ChainIds.BASE_EID, peerRaw), 0);

        bytes memory unlockMsg = SwapPayload.encodeUnlockBurn(
            SwapPayload.UnlockBurnPayload({
                action: SwapPayload.ACTION_UNLOCK_BURN,
                collection: address(nft),
                tokenId: tokenId,
                recipient: bob,
                destEid: ChainIds.BASE_EID,
                lockId: lockId
            })
        );
        vm.prank(address(ep));
        vault.lzReceive(
            NftLockVaultUpgradeable.LzOrigin({srcEid: ChainIds.BASE_EID, sender: peerRaw, nonce: 1}),
            bytes32(0),
            unlockMsg,
            address(0),
            ""
        );
        assertEq(nft.ownerOf(tokenId), bob);
    }
}
