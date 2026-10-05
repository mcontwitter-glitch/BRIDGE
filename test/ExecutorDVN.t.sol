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

    function isRegisteredLibrary(address lib) external view returns (bool) {
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
    address signer;
    uint256 signerKey;

    function setUp() public {
        (signer, signerKey) = makeAddrAndKey("relay-signer");
        endpoint = new MockEndpoint();
        endpoint.setSendLib(sendLib);
        uln = new MockUln();
        exec = new MockExecutor();
        exec.setAdmin(admin, true);
        dvn = new ExecutorDVN(address(endpoint), address(uln), address(exec), address(this), signer);
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
        vm.expectRevert(ExecutorDVN.MissingSignature.selector);
        dvn.verifyAndCommit(packet, "");
    }

    function test_executorAdminCommitsDerivedHashAndDelivers() public {
        bytes memory header = _header(4, 30324, address(0xA11), 30101, address(0xB22));
        bytes memory message = hex"abcdef";
        (bytes memory packet, bytes32 guid) = _packet(header, message);
        vm.prank(admin);
        dvn.verifyAndCommit(packet, "");
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
        dvn.verifyAndCommit(forged, "");

        bytes memory packet = abi.encodePacked(header, realPayload);
        vm.prank(stranger);
        vm.expectRevert(ExecutorDVN.MissingSignature.selector);
        dvn.verifyAndCommit(packet, "");

        bytes memory sig = _sign(30324, 30101, keccak256(realPayload));
        vm.prank(stranger);
        dvn.verifyAndCommit(packet, sig);
        assertEq(uln.lastHash(), keccak256(realPayload));
        assertTrue(endpoint.delivered());
    }

    function _sign(uint32 srcEid, uint32 dstEid, bytes32 payloadHash) internal view returns (bytes memory) {
        bytes32 digest = dvn.relayDigest(srcEid, dstEid, payloadHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_matchingSignatureDeliversInsideCallerTransaction() public {
        bytes memory header = _header(8, 30324, address(0xA11), 30101, address(0xB22));
        bytes memory message = hex"010203";
        (bytes memory packet,) = _packet(header, message);
        bytes32 payloadHash = keccak256(abi.encodePacked(bytes32(keccak256("guid")), message));
        bytes memory sig = _sign(30324, 30101, payloadHash);
        vm.prank(stranger);
        dvn.verifyAndCommit(packet, sig);
        assertEq(uln.lastHash(), payloadHash);
        assertTrue(uln.committed());
        assertTrue(endpoint.delivered());
        assertEq(endpoint.lastReceiver(), address(0xB22));
    }

    function test_wrongPacketReverts() public {
        bytes memory header = _header(9, 30324, address(0xA11), 30101, address(0xB22));
        bytes memory realBody = abi.encodePacked(keccak256("guid"), hex"aaaa");
        bytes memory sig = _sign(30324, 30101, keccak256(realBody));
        (bytes memory other,) = _packet(header, hex"bbbb");
        vm.prank(stranger);
        vm.expectRevert(ExecutorDVN.BadSigner.selector);
        dvn.verifyAndCommit(other, sig);
        assertFalse(endpoint.delivered());
    }

    function test_wrongSignerReverts() public {
        bytes memory header = _header(10, 30324, address(0xA11), 30101, address(0xB22));
        bytes memory body = abi.encodePacked(keccak256("guid"), hex"cccc");
        bytes memory packet = abi.encodePacked(header, body);
        uint256 otherKey = uint256(keccak256("not-the-signer"));
        bytes32 digest = dvn.relayDigest(30324, 30101, keccak256(body));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, digest);
        vm.prank(stranger);
        vm.expectRevert(ExecutorDVN.BadSigner.selector);
        dvn.verifyAndCommit(packet, abi.encodePacked(r, s, v));
    }

    function test_missingSignatureRevertsForNormalWallet() public {
        bytes memory header = _header(11, 30324, address(0xA11), 30101, address(0xB22));
        (bytes memory packet,) = _packet(header, hex"dddd");
        vm.prank(stranger);
        vm.expectRevert(ExecutorDVN.MissingSignature.selector);
        dvn.verifyAndCommit(packet, "");
    }

    function test_ethersSignatureMatchesRelayDigest() public {
        address ethersSigner = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        dvn.setSigner(ethersSigner);
        bytes memory packet = hex"01000000000000000700007674000000000000000000000000e81ddab112137112b8feeb853e22bc4c38f999e500007595000000000000000000000000dd3e6cc04168bcfc1acae5e70748618c5b38092babababababababababababababababababababababababababababababababab1234";
        bytes memory sig = hex"cb898312e3b31229c712b906cddff6a101330462dcbb9d96d1ace4da73d120cc457a703570bdccf6fa3ef3c2785f6566492963aaf728b8b1f7f96503589806771b";
        vm.prank(stranger);
        dvn.verifyAndCommit(packet, sig);
        assertTrue(endpoint.delivered());
        assertEq(endpoint.lastReceiver(), 0xDd3E6cc04168bCFC1ACaE5e70748618C5b38092B);
    }

    function test_ownerSetsSigner() public {
        address next = address(0x5151);
        vm.prank(stranger);
        vm.expectRevert(ExecutorDVN.NotOwner.selector);
        dvn.setSigner(next);
        dvn.setSigner(next);
        assertEq(dvn.signer(), next);
    }


    function test_apeNoncesOneAndTwoStaySkipped() public {
        endpoint.setEid(30312);
        bytes memory header = _header(1, 30324, address(0xA11), 30312, address(0xB22));
        vm.prank(admin);
        vm.expectRevert(ExecutorDVN.ProtectedNonce.selector);
        (bytes memory packet,) = _packet(header, hex"01");
        dvn.verifyAndCommit(packet, "");
        header = _header(2, 30324, address(0xA11), 30312, address(0xB22));
        vm.prank(address(exec));
        vm.expectRevert(ExecutorDVN.ProtectedNonce.selector);
        (bytes memory packet2,) = _packet(header, hex"02");
        dvn.verifyAndCommit(packet2, "");
    }
}
