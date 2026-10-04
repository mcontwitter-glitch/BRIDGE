// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ILayerZeroDVN, IReceiveUln302} from "../src/dvn/ILayerZeroDVN.sol";
import {ExecutorDVN} from "../src/dvn/ExecutorDVN.sol";

import {IEndpointExec} from "../src/dvn/ExecutorDVN.sol";

contract MockEndpoint is IEndpointExec {
    uint32 public eid = 30101;
    address public sendLib;
    bool public delivered;
    bytes32 public lastHashPreimage;
    address public lastReceiver;

    function setSendLib(address lib) external {
        sendLib = lib;
    }

    function setEid(uint32 eid_) external {
        eid = eid_;
    }

    function isSendLibrary(address lib) external view returns (bool) {
        return lib == sendLib;
    }

    function getSendLibrary(address, uint32) external view returns (address) {
        return sendLib;
    }

    function lzReceive(Origin calldata, address receiver, bytes32, bytes calldata message, bytes calldata)
        external
        payable
    {
        delivered = true;
        lastReceiver = receiver;
        lastHashPreimage = keccak256(message);
    }
}

contract MockUln is IReceiveUln302 {
    bytes public lastHeader;
    bytes32 public lastHash;
    uint64 public lastConfirmations;
    bool public committed;

    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external {
        lastHeader = packetHeader;
        lastHash = payloadHash;
        lastConfirmations = confirmations;
    }

    function commitVerification(bytes calldata, bytes32) external {
        committed = true;
    }

    function getUlnConfig(address, uint32) external pure returns (UlnConfig memory cfg) {
        cfg.confirmations = 20;
        cfg.requiredDVNCount = 1;
    }
}

contract MockExecutor {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    mapping(address => bool) public admin;

    function setAdmin(address account, bool allowed) external {
        admin[account] = allowed;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return role == ADMIN_ROLE && admin[account];
    }
}

contract ExecutorDVNTest is Test {
    ExecutorDVN dvn;
    MockEndpoint endpoint;
    MockUln uln;
    MockExecutor exec;
    address sendLib = address(0x5E1D);
    address admin = address(0xAD01);
    address stranger = address(0xBEEF);

    function setUp() public {
        endpoint = new MockEndpoint();
        endpoint.setSendLib(sendLib);
        uln = new MockUln();
        exec = new MockExecutor();
        exec.setAdmin(admin, true);
        dvn = new ExecutorDVN(address(endpoint), address(uln), address(exec));
    }

    function _header(uint64 nonce, uint32 srcEid, address sender, uint32 dstEid, address receiver)
        internal
        pure
        returns (bytes memory header)
    {
        header = abi.encodePacked(
            bytes1(0x01), nonce, srcEid, bytes32(uint256(uint160(sender))), dstEid, bytes32(uint256(uint160(receiver)))
        );
        assertEq(header.length, 81);
    }

    function _packet(bytes memory header, bytes memory message) internal pure returns (bytes memory packet, bytes32 guid) {
        guid = keccak256("guid");
        packet = abi.encodePacked(header, guid, message);
    }

    function test_assignJobOnlySendLibRecordsHash() public {
        bytes memory header = _header(3, 30324, address(0xA11), 30101, address(0xB22));
        bytes32 hash = keccak256("payload");
        ILayerZeroDVN.AssignJobParam memory param = ILayerZeroDVN.AssignJobParam({
            dstEid: 30101,
            packetHeader: header,
            payloadHash: hash,
            confirmations: 20,
            sender: address(0xA11)
        });
        vm.prank(stranger);
        vm.expectRevert(ExecutorDVN.NotMessageLib.selector);
        dvn.assignJob(param, "");

        vm.prank(sendLib);
        assertEq(dvn.assignJob(param, ""), 0);
        assertEq(dvn.packetHash(keccak256(header)), hash);
        assertEq(dvn.getFee(30101, 20, address(this), ""), 0);
    }

    function test_strangerCannotCommitUnrecordedPacket() public {
        bytes memory header = _header(4, 30324, address(0xA11), 30101, address(0xB22));
        (bytes memory packet,) = _packet(header, hex"1234");
        vm.prank(stranger);
        vm.expectRevert(ExecutorDVN.NotExecutor.selector);
        dvn.verifyAndCommit(packet);
    }

    function test_executorAdminCommitsDerivedHashAndDelivers() public {
        bytes memory header = _header(4, 30324, address(0xA11), 30101, address(0xB22));
        bytes memory message = hex"abcdef";
        (bytes memory packet, bytes32 guid) = _packet(header, message);
        vm.prank(admin);
        dvn.verifyAndCommit(packet);
        assertEq(uln.lastHash(), keccak256(abi.encodePacked(guid, message)));
        assertEq(uln.lastConfirmations(), 20);
        assertTrue(uln.committed());
        assertTrue(endpoint.delivered());
        assertEq(endpoint.lastReceiver(), address(0xB22));
    }

    function test_recordedHashRejectsForgedPayload() public {
        bytes memory header = _header(5, 30324, address(0xA11), 30101, address(0xB22));
        bytes memory realPayload = abi.encodePacked(keccak256("guid"), hex"aaaa");
        vm.prank(sendLib);
        dvn.assignJob(
            ILayerZeroDVN.AssignJobParam({
                dstEid: 30101,
                packetHeader: header,
                payloadHash: keccak256(realPayload),
                confirmations: 20,
                sender: address(0xA11)
            }),
            ""
        );
        bytes memory forged = abi.encodePacked(header, keccak256("other"), hex"bbbb");
        vm.prank(admin);
        vm.expectRevert(ExecutorDVN.ForgedHash.selector);
        dvn.verifyAndCommit(forged);

        bytes memory packet = abi.encodePacked(header, realPayload);
        vm.prank(stranger);
        dvn.verifyAndCommit(packet);
        assertEq(uln.lastHash(), keccak256(realPayload));
        assertTrue(endpoint.delivered());
    }

    function test_apeNoncesOneAndTwoStaySkipped() public {
        endpoint.setEid(30312);
        bytes memory header = _header(1, 30324, address(0xA11), 30312, address(0xB22));
        vm.prank(admin);
        vm.expectRevert(ExecutorDVN.ProtectedNonce.selector);
        (bytes memory packet,) = _packet(header, hex"01");
        dvn.verifyAndCommit(packet);
        header = _header(2, 30324, address(0xA11), 30312, address(0xB22));
        vm.prank(address(exec));
        vm.expectRevert(ExecutorDVN.ProtectedNonce.selector);
        (bytes memory packet2,) = _packet(header, hex"02");
        dvn.verifyAndCommit(packet2);
    }
}
