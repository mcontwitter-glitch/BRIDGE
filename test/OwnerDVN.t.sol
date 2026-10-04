// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ILayerZeroDVN, IReceiveUln302} from "../src/dvn/ILayerZeroDVN.sol";
import {OwnerDVN} from "../src/dvn/OwnerDVN.sol";

contract MockReceiveUln is IReceiveUln302 {
    bytes public lastHeader;
    bytes32 public lastHash;
    uint64 public lastConfirmations;
    address public lastCaller;

    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external {
        lastHeader = packetHeader;
        lastHash = payloadHash;
        lastConfirmations = confirmations;
        lastCaller = msg.sender;
    }
}

contract OwnerDVNTest is Test {
    OwnerDVN dvn;
    MockReceiveUln uln;
    address owner = address(0xB19F);
    address stranger = address(0xBEEF);

    function setUp() public {
        uln = new MockReceiveUln();
        dvn = new OwnerDVN(address(uln), owner);
    }

    function test_getFeeIsZero() public view {
        assertEq(dvn.getFee(30101, 20, address(this), ""), 0);
        assertEq(dvn.getFee(30324, 15, address(0x1234), hex"0001"), 0);
    }

    function test_assignJobReturnsZero() public {
        ILayerZeroDVN.AssignJobParam memory param = ILayerZeroDVN.AssignJobParam({
            dstEid: 30184,
            packetHeader: hex"01",
            payloadHash: keccak256("payload"),
            confirmations: 20,
            sender: address(this)
        });
        uint256 fee = dvn.assignJob(param, "");
        assertEq(fee, 0);
    }

    function test_ownerVerifyForwardsHeaderAndHash() public {
        bytes memory header = hex"0100000001";
        bytes32 payloadHash = keccak256("twin");
        vm.prank(owner);
        dvn.verify(header, payloadHash, 20);
        assertEq(uln.lastHeader(), header);
        assertEq(uln.lastHash(), payloadHash);
        assertEq(uln.lastConfirmations(), 20);
        assertEq(uln.lastCaller(), address(dvn));
    }

    function test_strangerCannotVerify() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        dvn.verify(hex"01", bytes32(uint256(1)), 15);
    }

    function test_singleDvnIsStrictlyAscending() public view {
        address[] memory dvns = new address[](1);
        dvns[0] = address(dvn);
        assertGt(uint160(dvns[0]), 0);
        for (uint256 i = 1; i < dvns.length; i++) {
            assertGt(uint160(dvns[i]), uint160(dvns[i - 1]));
        }
    }
}
