// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SwapPayload} from "../src/libraries/SwapPayload.sol";

contract SwapPayloadTest is Test {
    function test_encodeDecodeLockMint() public pure {
        SwapPayload.LockMintPayload memory original = SwapPayload.LockMintPayload({
            action: SwapPayload.ACTION_LOCK_MINT,
            collection: address(0xBEEF),
            tokenId: 42,
            tokenURI: "ipfs://QmExampleMetadataHash/42.json",
            recipient: address(0xCAFE),
            originEid: 30324, // Abstract LZ V2 eid
            lockId: keccak256("lock-1")
        });

        bytes memory encoded = SwapPayload.encodeLockMint(original);
        SwapPayload.LockMintPayload memory decoded = SwapPayload.decodeLockMint(encoded);

        assertEq(decoded.action, SwapPayload.ACTION_LOCK_MINT);
        assertEq(decoded.collection, original.collection);
        assertEq(decoded.tokenId, original.tokenId);
        assertEq(decoded.tokenURI, original.tokenURI);
        assertEq(decoded.recipient, original.recipient);
        assertEq(decoded.originEid, original.originEid);
        assertEq(decoded.lockId, original.lockId);
        assertEq(SwapPayload.peekAction(encoded), SwapPayload.ACTION_LOCK_MINT);
    }

    function test_encodeDecodeUnlockBurn() public pure {
        SwapPayload.UnlockBurnPayload memory original = SwapPayload.UnlockBurnPayload({
            action: SwapPayload.ACTION_UNLOCK_BURN,
            collection: address(0xBEEF),
            tokenId: 7,
            recipient: address(0xABCD),
            destEid: 30184,
            lockId: keccak256("lock-2")
        });

        bytes memory encoded = SwapPayload.encodeUnlockBurn(original);
        SwapPayload.UnlockBurnPayload memory decoded = SwapPayload.decodeUnlockBurn(encoded);

        assertEq(decoded.action, SwapPayload.ACTION_UNLOCK_BURN);
        assertEq(decoded.collection, original.collection);
        assertEq(decoded.tokenId, original.tokenId);
        assertEq(decoded.recipient, original.recipient);
        assertEq(decoded.destEid, original.destEid);
        assertEq(decoded.lockId, original.lockId);
    }
}
