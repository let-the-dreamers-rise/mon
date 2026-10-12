// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Hollow} from "../src/Hollow.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --private-key $PRIVATE_KEY
contract Deploy is Script {
    function run() external returns (Hollow hollow) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../tools/map/hollow-map.json"));
        bytes32[] memory w = vm.parseJsonBytes32Array(json, ".walls");
        uint256[16] memory walls;
        for (uint256 i = 0; i < 16; i++) {
            walls[i] = uint256(w[i]);
        }
        uint256 spawns = uint256(vm.parseJsonBytes32(json, ".spawns"));
        uint256 objectives = uint256(vm.parseJsonBytes32(json, ".objectives"));
        vm.startBroadcast();
        hollow = new Hollow(walls, spawns, objectives);
        vm.stopBroadcast();
        console.log("Hollow deployed at", address(hollow));
    }
}
