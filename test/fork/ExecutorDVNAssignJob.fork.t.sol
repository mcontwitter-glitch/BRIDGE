// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ILayerZeroDVN} from "../../src/dvn/ILayerZeroDVN.sol";
import {ExecutorDVN} from "../../src/dvn/ExecutorDVN.sol";

interface IEp {
    function getSendLibrary(address, uint32) external view returns (address);
    function getReceiveLibrary(address, uint32) external view returns (address, bool);
}

/// @notice Runs assignJob against the live Base EndpointV2 so a mock cannot hide a missing endpoint function.
contract ExecutorDVNAssignJobFork is Test {
    address constant EP = 0x1a44076050125825900e736c501f859c50fE728c;
    address constant OAPP = 0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f;
    uint32 constant HOME = 30324;

    function test_assignJob_liveEndpoint() public {
        vm.createSelectFork(vm.envOr("BASE_RPC", string("https://base.drpc.org")));
        address sendLib = IEp(EP).getSendLibrary(OAPP, HOME);
        (address recvLib,) = IEp(EP).getReceiveLibrary(OAPP, HOME);
        ExecutorDVN dvn = new ExecutorDVN(EP, recvLib, address(0xE1), address(this), address(0x5161));
        ILayerZeroDVN.AssignJobParam memory p = ILayerZeroDVN.AssignJobParam({
            dstEid: HOME,
            packetHeader: hex"01",
            payloadHash: keccak256("payload"),
            confirmations: 10,
            sender: OAPP
        });
        vm.prank(sendLib);
        dvn.assignJob(p, "");
        assertEq(dvn.packetHash(keccak256(hex"01")), keccak256("payload"));

        vm.expectRevert();
        vm.prank(address(0xBAD));
        dvn.assignJob(p, "");
    }
}
