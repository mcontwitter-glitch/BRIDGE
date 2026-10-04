// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {NftTwinMinterUpgradeable} from "../src/upgradeable/NftTwinMinterUpgradeable.sol";
import {MockLayerZeroEndpoint} from "../src/mocks/MockLayerZeroEndpoint.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";
import {MockTwinCollection} from "../src/mocks/MockTwinCollection.sol";
import {SwapPayload} from "../src/libraries/SwapPayload.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

contract PushUnlockTest is Test {
    MockLayerZeroEndpoint ep;
    NftTwinMinterUpgradeable minter;
    MockERC721 origin;
    MockTwinCollection twin;
    address alice = address(0xA11CE);
    address vault = address(0xAB57);

    bytes constant OPTS = hex"000301001101000000000000000000000000004c4b40";

    function setUp() public {
        ep = new MockLayerZeroEndpoint();
        origin = new MockERC721("LIL", "LIL");
        twin = new MockTwinCollection("Twin LIL", "TLIL", address(this));
        NftTwinMinterUpgradeable impl = new NftTwinMinterUpgradeable();
        bytes memory init = abi.encodeCall(
            NftTwinMinterUpgradeable.initialize, (address(ep), ChainIds.BASE_EID, address(this))
        );
        minter = NftTwinMinterUpgradeable(address(new ERC1967Proxy(address(impl), init)));
        minter.prepareCollection(address(origin), address(twin));
        twin.grantRole(twin.MINTER_ROLE(), address(minter));
        minter.setPeer(ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(vault))));
        vm.deal(alice, 10 ether);
    }

    function _pushData(bytes32 lockId) internal pure returns (bytes memory) {
        return abi.encode(lockId, OPTS);
    }

    function _mint(uint256 tokenId) internal returns (bytes32 lockId) {
        lockId = keccak256(abi.encodePacked("lock", tokenId));
        bytes memory message = SwapPayload.encodeLockMint(
            SwapPayload.LockMintPayload({
                action: SwapPayload.ACTION_LOCK_MINT,
                collection: address(origin),
                tokenId: tokenId,
                tokenURI: "ipfs://Qm/1",
                recipient: alice,
                originEid: ChainIds.ABSTRACT_EID,
                lockId: lockId
            })
        );
        vm.prank(address(ep));
        minter.lzReceive(ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(vault))), bytes32(0), message, "");
    }

    function test_storageSlotsUnshifted() public view {
        assertEq(uint256(uint160(minter.owner())), uint256(vm.load(address(minter), bytes32(uint256(0)))));
        assertEq(uint256(uint160(address(minter.endpoint()))), uint256(vm.load(address(minter), bytes32(uint256(1)))));
        assertEq(minter.localEid(), uint32(uint256(vm.load(address(minter), bytes32(uint256(4))))));
        assertEq(uint256(vm.load(address(minter), bytes32(uint256(47)))), 0);
        assertEq(minter.peers(ChainIds.ABSTRACT_EID), bytes32(uint256(uint160(vault))));
    }

    function test_holderPushBurnsAndMessagesSameWallet() public {
        bytes32 lockId = _mint(7);
        assertEq(twin.ownerOf(7), alice);

        vm.startPrank(alice);
        minter.prepayPush{value: 0.001 ether}(address(twin), 7);
        twin.safeTransferFrom(alice, address(minter), 7, _pushData(lockId));
        vm.stopPrank();

        vm.expectRevert();
        twin.ownerOf(7);
        (,,,, bool active) = minter.twins(lockId);
        assertFalse(active);
        assertEq(minter.pushCredit(alice, address(twin), 7), 0);

        SwapPayload.UnlockBurnPayload memory p = SwapPayload.decodeUnlockBurn(ep.lastMessage());
        assertEq(p.action, SwapPayload.ACTION_UNLOCK_BURN);
        assertEq(p.recipient, alice);
        assertEq(p.collection, address(origin));
        assertEq(p.tokenId, 7);
        assertEq(p.lockId, lockId);
        assertEq(p.destEid, ChainIds.BASE_EID);
    }

    function test_unlockBackDoesNotPull() public {
        bytes32 lockId = _mint(8);
        vm.prank(alice);
        vm.expectRevert(NftTwinMinterUpgradeable.MinterDoesNotPull.selector);
        minter.unlockBack{value: 0.001 ether}(lockId, alice, OPTS);
        assertEq(twin.ownerOf(8), alice);
    }

    function test_transferWithoutFeeOrDataReverts() public {
        bytes32 lockId = _mint(9);
        vm.startPrank(alice);
        vm.expectRevert(NftTwinMinterUpgradeable.InsufficientPushFee.selector);
        twin.safeTransferFrom(alice, address(minter), 9, _pushData(lockId));
        vm.expectRevert(NftTwinMinterUpgradeable.BridgeDataRequired.selector);
        twin.safeTransferFrom(alice, address(minter), 9, "");
        vm.stopPrank();
        assertEq(twin.ownerOf(9), alice);
    }

    function test_quoteUsesType3Options() public {
        bytes32 lockId = _mint(10);
        uint256 nativeFee = minter.quoteUnlock(lockId, alice, OPTS).nativeFee;
        assertEq(nativeFee, 0.001 ether);
    }
}
