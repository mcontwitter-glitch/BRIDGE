// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NftLockVault} from "../src/NftLockVault.sol";
import {NftTwinMinter} from "../src/NftTwinMinter.sol";
import {MockLayerZeroEndpoint} from "../src/mocks/MockLayerZeroEndpoint.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";
import {MockTwinCollection} from "../src/mocks/MockTwinCollection.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

contract LockUnlockFlowTest is Test {
    MockLayerZeroEndpoint homeEp;
    MockLayerZeroEndpoint destEp;
    NftLockVault vault;
    NftTwinMinter minter;
    MockERC721 homeNft;
    MockTwinCollection twinNft;

    address alice = address(0xA11CE);

    function setUp() public {
        homeEp = new MockLayerZeroEndpoint();
        destEp = new MockLayerZeroEndpoint();
        homeNft = new MockERC721("BIGFOOT404", "BF404");
        twinNft = new MockTwinCollection("BIGFOOT404 Twin", "BF404T", address(this));

        vault = new NftLockVault(address(homeEp), ChainIds.ABSTRACT_EID);
        minter = new NftTwinMinter(address(destEp), ChainIds.BASE_EID);
        minter.prepareCollection(address(homeNft), address(twinNft));

        twinNft.grantRole(twinNft.MINTER_ROLE(), address(minter));

        vault.setPeer(ChainIds.BASE_EID, bytes32(uint256(uint160(address(minter)))));
        minter.setPeer(ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(address(vault)))));

        vm.deal(alice, 10 ether);
        vm.prank(alice);
        // mint helper is public on mock
    }

    function test_lockSwapUnlockRoundTrip() public {
        uint256 tokenId = homeNft.mint(alice, "ipfs://QmTwinMeta/1.json");

        vm.startPrank(alice);
        homeNft.approve(address(vault), tokenId);
        bytes32 lockId = vault.lockAndSwap{value: 0.01 ether}(
            address(homeNft), tokenId, ChainIds.BASE_EID, alice, ""
        );
        vm.stopPrank();

        assertEq(homeNft.ownerOf(tokenId), address(vault));

        // Deliver lock message to dest minter via mock endpoint
        bytes memory lockMsg = _lastHomeMessage();
        destEp.deliver(
            address(minter),
            ChainIds.ABSTRACT_EID,
            bytes32(uint256(uint160(address(vault)))),
            lockMsg
        );

        assertEq(twinNft.ownerOf(tokenId), alice);
        assertEq(twinNft.tokenURI(tokenId), "ipfs://QmTwinMeta/1.json");

        // Unlock back
        vm.startPrank(alice);
        twinNft.approve(address(minter), tokenId); // burn may not need approve if minter burns
        minter.unlockBack{value: 0.01 ether}(lockId, alice, "");
        vm.stopPrank();

        bytes memory unlockMsg = _lastDestMessage();
        homeEp.deliver(
            address(vault),
            ChainIds.BASE_EID,
            bytes32(uint256(uint160(address(minter)))),
            unlockMsg
        );

        assertEq(homeNft.ownerOf(tokenId), alice);
        (,,,,, bool active) = vault.locks(lockId);
        assertFalse(active);
    }


    function test_twoOriginsGetTwoCollections() public {
        MockERC721 chicken = new MockERC721("Chicken", "CHK");
        MockERC721 monkey = new MockERC721("Monkey", "MNK");
        uint256 chickenId = chicken.mint(alice, "ipfs://chicken/1.json");
        uint256 monkeyId = monkey.mint(alice, "ipfs://monkey/1.json");

        vm.startPrank(alice);
        chicken.approve(address(vault), chickenId);
        vault.lockAndSwap{value: 0.01 ether}(address(chicken), chickenId, ChainIds.BASE_EID, alice, "");
        bytes memory chickenMsg = homeEp.lastMessage();
        monkey.approve(address(vault), monkeyId);
        vault.lockAndSwap{value: 0.01 ether}(address(monkey), monkeyId, ChainIds.BASE_EID, alice, "");
        bytes memory monkeyMsg = homeEp.lastMessage();
        vm.stopPrank();

        destEp.deliver(address(minter), ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(address(vault)))), chickenMsg);
        destEp.deliver(address(minter), ChainIds.ABSTRACT_EID, bytes32(uint256(uint160(address(vault)))), monkeyMsg);

        address chickenTwin = minter.collectionOf(address(chicken));
        address monkeyTwin = minter.collectionOf(address(monkey));
        assertTrue(chickenTwin != address(0));
        assertTrue(monkeyTwin != address(0));
        assertTrue(chickenTwin != monkeyTwin);
        assertEq(MockTwinCollection(chickenTwin).ownerOf(chickenId), alice);
        assertEq(MockTwinCollection(monkeyTwin).ownerOf(monkeyId), alice);
    }

    function _lastHomeMessage() internal view returns (bytes memory) {
        return homeEp.lastMessage();
    }

    function _lastDestMessage() internal view returns (bytes memory) {
        return destEp.lastMessage();
    }
}
