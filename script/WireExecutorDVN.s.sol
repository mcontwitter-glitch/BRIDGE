// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ExecutorDVN} from "../src/dvn/ExecutorDVN.sol";

/// @notice Deploy ExecutorDVN and point send/receive ULN config at it.
/// @dev Peers are not written. Ape nonces are not skipped or cleared. The executor
///      address and confirmations already on the pathway are copied forward.
contract WireExecutorDVN is Script {
    uint32 internal constant CONFIG_EXECUTOR = 1;
    uint32 internal constant CONFIG_ULN = 2;
    uint32 internal constant ABSTRACT_EID = 30324;

    struct Pathway {
        address oapp;
        address oldDvn;
        address executor;
        uint32[] eids;
    }

    function run() external {
        string memory raw = vm.envString("BRIDGE_OWNER_PK");
        if (bytes(raw).length == 64) raw = string.concat("0x", raw);
        uint256 pk = vm.parseUint(raw);
        address owner = vm.addr(pk);

        Pathway memory path = _path();
        address endpoint = IOApp(path.oapp).endpoint();
        address receiveUln = IOldDvn(path.oldDvn).receiveUln();

        console2.log("chain", block.chainid);
        console2.log("oapp", path.oapp);
        console2.log("owner", owner);
        console2.log("balance", owner.balance);

        uint256 n = path.eids.length;
        address[] memory sendLibs = new address[](n);
        address[] memory receiveLibs = new address[](n);
        uint32[] memory maxSizes = new uint32[](n);
        uint64[] memory sendConfs = new uint64[](n);
        uint64[] memory recvConfs = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            (sendLibs[i], receiveLibs[i], maxSizes[i], sendConfs[i], recvConfs[i]) =
                _read(endpoint, path.oapp, path.eids[i], path.oldDvn, path.executor);
            if (sendConfs[i] != _expect(path.eids[i], true)) revert ConfirmationMismatch(path.eids[i], sendConfs[i], _expect(path.eids[i], true));
            if (recvConfs[i] != _expect(path.eids[i], false)) revert ConfirmationMismatch(path.eids[i], recvConfs[i], _expect(path.eids[i], false));
            if (maxSizes[i] != 10000) revert ConfirmationMismatch(path.eids[i], maxSizes[i], 10000);
            console2.log("eid", path.eids[i]);
            console2.log("sendConf", sendConfs[i]);
            console2.log("recvConf", recvConfs[i]);
        }

        address signer = vm.envAddress("BRIDGE_RELAY_SIGNER");
        if (signer == address(0)) revert SignerZero();
        console2.log("signer", signer);

        vm.startBroadcast(pk);
        address dvn = vm.envOr("EXECUTOR_DVN", address(0));
        if (dvn == address(0)) {
            dvn = address(new ExecutorDVN(endpoint, receiveUln, path.executor, owner, signer));
        }
        if (ExecutorDVN(dvn).signer() != signer) {
            ExecutorDVN(dvn).setSigner(signer);
        }
        console2.log("executorDvn", dvn);
        for (uint256 i = 0; i < n; i++) {
            IOApp(path.oapp).setSendConfig(
                sendLibs[i], path.eids[i], sendConfs[i], dvn, maxSizes[i], path.executor
            );
            IOApp(path.oapp).setReceiveConfig(receiveLibs[i], path.eids[i], recvConfs[i], dvn);
            console2.log("wired eid", path.eids[i]);
        }
        vm.stopBroadcast();
    }


    function _read(address endpoint, address oapp, uint32 eid, address oldDvn, address expectExecutor)
        internal
        view
        returns (address sendLib, address receiveLib, uint32 maxSize, uint64 sendConf, uint64 recvConf)
    {
        sendLib = IEndpoint(endpoint).getSendLibrary(oapp, eid);
        address executor_;
        (maxSize, executor_) = abi.decode(IEndpoint(endpoint).getConfig(oapp, sendLib, eid, CONFIG_EXECUTOR), (uint32, address));
        Uln memory sendUln = abi.decode(IEndpoint(endpoint).getConfig(oapp, sendLib, eid, CONFIG_ULN), (Uln));
        if (executor_ != expectExecutor) revert ExecutorMismatch(executor_, expectExecutor);
        if (sendUln.requiredDVNs.length != 1 || sendUln.requiredDVNs[0] != oldDvn) {
            revert DvnMismatch(sendUln.requiredDVNs.length == 0 ? address(0) : sendUln.requiredDVNs[0]);
        }
        (receiveLib,) = IEndpoint(endpoint).getReceiveLibrary(oapp, eid);
        Uln memory recvUln = abi.decode(IEndpoint(endpoint).getConfig(oapp, receiveLib, eid, CONFIG_ULN), (Uln));
        if (recvUln.requiredDVNs.length != 1 || recvUln.requiredDVNs[0] != oldDvn) {
            revert DvnMismatch(recvUln.requiredDVNs.length == 0 ? address(0) : recvUln.requiredDVNs[0]);
        }
        sendConf = sendUln.confirmations;
        recvConf = recvUln.confirmations;
    }

    function _path() internal view returns (Pathway memory path) {
        uint32[] memory one = new uint32[](1);
        one[0] = ABSTRACT_EID;
        if (block.chainid == 2741) {
            uint32[] memory eids = new uint32[](5);
            eids[0] = 30101;
            eids[1] = 30184;
            eids[2] = 30102;
            eids[3] = 30312;
            eids[4] = 30416;
            path = Pathway({
                oapp: 0xe81DdAB112137112B8FeeB853e22BC4c38F999e5,
                oldDvn: 0x565D9E3BA522de1090C645f372C2FF0Df67a9b42,
                executor: 0x643E1471f37c4680Df30cF0C540Cd379a0fF58A5,
                eids: eids
            });
        } else if (block.chainid == 1) {
            path = Pathway({
                oapp: 0xDd3E6cc04168bCFC1ACaE5e70748618C5b38092B,
                oldDvn: 0x0a3D1dEd83B443399073537eCd6d4040dD707731,
                executor: 0x173272739Bd7Aa6e4e214714048a9fE699453059,
                eids: one
            });
        } else if (block.chainid == 8453) {
            path = Pathway({
                oapp: 0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f,
                oldDvn: 0xf7e5bAaE563B90295ac13aD199aC3c084962b09D,
                executor: 0x2CCA08ae69E0C44b18a57Ab2A87644234dAebaE4,
                eids: one
            });
        } else if (block.chainid == 56) {
            path = Pathway({
                oapp: 0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f,
                oldDvn: 0xf7e5bAaE563B90295ac13aD199aC3c084962b09D,
                executor: 0x3ebD570ed38B1b3b4BC886999fcF507e9D584859,
                eids: one
            });
        } else if (block.chainid == 33139) {
            path = Pathway({
                oapp: 0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f,
                oldDvn: 0x2e57bb5c4c78F9BeDcdfaE9a8eeABE0F6f6E3FB4,
                executor: 0xcCE466a522984415bC91338c232d98869193D46e,
                eids: one
            });
        } else if (block.chainid == 4663) {
            path = Pathway({
                oapp: 0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f,
                oldDvn: 0xf7e5bAaE563B90295ac13aD199aC3c084962b09D,
                executor: 0x4208D6E27538189bB48E603D6123A94b8Abe0A0b,
                eids: one
            });
        } else {
            revert UnknownChain(block.chainid);
        }
    }

    error UnknownChain(uint256 chainId);
    error ExecutorMismatch(address found, address expected);
    error DvnMismatch(address found);
    error ConfirmationMismatch(uint32 eid, uint64 found, uint64 expected);
    error SignerZero();

    function _expect(uint32 eid, bool sendSide) internal view returns (uint64) {
        if (block.chainid == 2741) {
            if (sendSide) return 20;
            if (eid == 30101) return 15;
            if (eid == 30184) return 10;
            if (eid == 30102) return 20;
            if (eid == 30312) return 20;
            if (eid == 30416) return 5;
        } else if (eid == ABSTRACT_EID) {
            if (!sendSide) return 20;
            if (block.chainid == 1) return 15;
            if (block.chainid == 8453) return 10;
            if (block.chainid == 56) return 20;
            if (block.chainid == 33139) return 20;
            if (block.chainid == 4663) return 5;
        }
        revert ConfirmationMismatch(eid, 0, 0);
    }
}

interface IOApp {
    function endpoint() external view returns (address);

    function setSendConfig(
        address sendLib,
        uint32 eid,
        uint64 confirmations,
        address dvn,
        uint32 maxMessageSize,
        address executor_
    ) external;

    function setReceiveConfig(address receiveLib, uint32 eid, uint64 confirmations, address dvn) external;
}

interface IOldDvn {
    function receiveUln() external view returns (address);
}

interface IEndpoint {
    function getSendLibrary(address sender, uint32 dstEid) external view returns (address);

    function getReceiveLibrary(address receiver, uint32 srcEid) external view returns (address lib, bool isDefault);

    function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory);
}

struct Uln {
    uint64 confirmations;
    uint8 requiredDVNCount;
    uint8 optionalDVNCount;
    uint8 optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
}
