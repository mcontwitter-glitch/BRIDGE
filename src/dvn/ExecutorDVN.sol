// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILayerZeroDVN, IReceiveUln302} from "./ILayerZeroDVN.sol";

/// @title ExecutorDVN
/// @notice DVN whose attestation is the packet hash the pathway MessageLib already produced.
/// @dev assignJob is called by the send MessageLib and is the only writer of `packetHash`.
///      A caller cannot pass a detached payload hash. verifyAndCommit hashes the packet the
///      same way SendUln302 does (keccak256 of the bytes after the 81-byte header). If this
///      chain's MessageLib already recorded that header, the hash must match. Otherwise only
///      the configured executor (or its ADMIN_ROLE) may present the packet, then this contract
///      calls ReceiveUln302.verify and commitVerification and EndpointV2.lzReceive.
///      ApeChain inbound nonces 1 and 2 stay skipped.
contract ExecutorDVN is ILayerZeroDVN {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint32 internal constant APE_EID = 30312;
    uint256 internal constant HEADER_LEN = 81;

    address public immutable endpoint;
    address public immutable receiveUln;
    address public immutable executor;

    /// @dev keccak256(packetHeader) => payload hash supplied by the send MessageLib.
    mapping(bytes32 headerHash => bytes32 payloadHash) public packetHash;

    error ReceiveUlnZero();
    error EndpointZero();
    error ExecutorZero();
    error NotMessageLib();
    error NotExecutor();
    error BadPacket();
    error ForgedHash();
    error ProtectedNonce();
    error HashConflict();

    event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender);
    event PayloadSubmitted(bytes32 payloadHash, uint64 confirmations);

    constructor(address endpoint_, address receiveUln_, address executor_) {
        if (endpoint_ == address(0)) revert EndpointZero();
        if (receiveUln_ == address(0)) revert ReceiveUlnZero();
        if (executor_ == address(0)) revert ExecutorZero();
        endpoint = endpoint_;
        receiveUln = receiveUln_;
        executor = executor_;
    }

    /// @inheritdoc ILayerZeroDVN
    function assignJob(AssignJobParam calldata param, bytes calldata) external payable returns (uint256 fee) {
        if (!IEndpointView(endpoint).isSendLibrary(msg.sender)) revert NotMessageLib();
        if (IEndpointView(endpoint).getSendLibrary(param.sender, param.dstEid) != msg.sender) revert NotMessageLib();
        bytes32 key = keccak256(param.packetHeader);
        bytes32 existing = packetHash[key];
        if (existing != bytes32(0) && existing != param.payloadHash) revert HashConflict();
        packetHash[key] = param.payloadHash;
        emit JobAssigned(param.dstEid, param.payloadHash, param.confirmations, param.sender);
        return 0;
    }

    /// @inheritdoc ILayerZeroDVN
    function getFee(uint32, uint64, address, bytes calldata) external pure returns (uint256 fee) {
        return 0;
    }

    /// @notice Verify, commit, and deliver one packet.
    /// @dev `encodedPacket` is header || guid || message, the bytes the send MessageLib returns.
    ///      The payload hash is keccak256(encodedPacket[81:]). There is no hash argument.
    function verifyAndCommit(bytes calldata encodedPacket) external payable {
        if (encodedPacket.length < HEADER_LEN + 32) revert BadPacket();
        if (uint8(encodedPacket[0]) != 1) revert BadPacket();

        bytes calldata header = encodedPacket[:HEADER_LEN];
        uint64 nonce = uint64(bytes8(header[1:9]));
        uint32 srcEid = uint32(bytes4(header[9:13]));
        uint32 dstEid = uint32(bytes4(header[45:49]));
        if (dstEid != IEndpointView(endpoint).eid()) revert BadPacket();
        if (dstEid == APE_EID && (nonce == 1 || nonce == 2)) revert ProtectedNonce();

        bytes32 payloadHash = keccak256(encodedPacket[HEADER_LEN:]);
        bytes32 recorded = packetHash[keccak256(header)];
        if (recorded != bytes32(0)) {
            if (recorded != payloadHash) revert ForgedHash();
        } else if (!_isExecutor(msg.sender)) {
            revert NotExecutor();
        }

        address receiver = address(uint160(uint256(bytes32(header[49:81]))));
        bytes32 sender = bytes32(header[13:45]);
        uint64 confirmations = IReceiveUln302(receiveUln).getUlnConfig(receiver, srcEid).confirmations;
        IReceiveUln302(receiveUln).verify(header, payloadHash, confirmations);
        IReceiveUln302(receiveUln).commitVerification(header, payloadHash);

        bytes32 guid = bytes32(encodedPacket[HEADER_LEN:HEADER_LEN + 32]);
        bytes calldata message = encodedPacket[HEADER_LEN + 32:];
        IEndpointExec(endpoint).lzReceive{value: msg.value}(
            IEndpointExec.Origin({srcEid: srcEid, sender: sender, nonce: nonce}),
            receiver,
            guid,
            message,
            bytes("")
        );
        emit PayloadSubmitted(payloadHash, confirmations);
    }

    function _isExecutor(address caller) internal view returns (bool) {
        if (caller == executor) return true;
        return IExecutorRoles(executor).hasRole(ADMIN_ROLE, caller);
    }
}

interface IEndpointView {
    function eid() external view returns (uint32);
    function isSendLibrary(address lib) external view returns (bool);
    function getSendLibrary(address sender, uint32 dstEid) external view returns (address lib);
}

interface IEndpointExec {
    struct Origin {
        uint32 srcEid;
        bytes32 sender;
        uint64 nonce;
    }

    function lzReceive(
        Origin calldata origin,
        address receiver,
        bytes32 guid,
        bytes calldata message,
        bytes calldata extraData
    ) external payable;
}

interface IExecutorRoles {
    function hasRole(bytes32 role, address account) external view returns (bool);
}
