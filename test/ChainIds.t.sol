// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChainIds} from "../src/libraries/ChainIds.sol";

contract ChainIdsTest is Test {
    function test_officialEndpointIds() public pure {
        assertEq(ChainIds.ABSTRACT_EID, 30324);
        assertTrue(ChainIds.ABSTRACT_EID != 30310);
        assertEq(ChainIds.ETHEREUM_EID, 30101);
        assertEq(ChainIds.BASE_EID, 30184);
        assertEq(ChainIds.BNB_EID, 30102);
        assertEq(ChainIds.APECHAIN_EID, 30312);
        assertEq(ChainIds.SOLANA_EID, 30168);
        assertEq(ChainIds.SUI_EID, 30378);
    }
}
