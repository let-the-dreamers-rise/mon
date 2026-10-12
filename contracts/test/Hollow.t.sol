// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hollow} from "../src/Hollow.sol";

contract HollowTest is Test {
    Hollow hollow;
    uint256 constant CELL = 250;
    address[] players;

    function cellCm(uint256 cx, uint256 cy) internal pure returns (uint256) {
        return (cx * CELL + CELL / 2) | ((cy * CELL + CELL / 2) << 16);
    }

    function pt(uint256 x, uint256 y) internal pure returns (uint256) {
        return x | (y << 16);
    }

    function setUp() public {
        // open 32x32 room: solid border + one internal wall column at x=10, y=5..20
        uint256[4] memory walls;
        for (uint256 y = 0; y < 32; y++) {
            for (uint256 x = 0; x < 32; x++) {
                bool solid = x == 0 || y == 0 || x == 31 || y == 31 || (x == 10 && y >= 5 && y <= 20);
                if (solid) {
                    uint256 bit = y * 32 + x;
                    walls[bit >> 8] |= 1 << (bit & 255);
                }
            }
        }
        uint256 spawns;
        for (uint256 i = 0; i < 8; i++) {
            spawns |= cellCm(2 + 2 * i, 2) << (32 * i);
        }
        uint256 objectives = cellCm(5, 8) | (cellCm(6, 8) << 32) | (cellCm(7, 8) << 64) | (cellCm(8, 12) << 96);
        hollow = new Hollow(walls, spawns, objectives);
        for (uint256 i = 0; i < 8; i++) {
            players.push(makeAddr(string(abi.encodePacked("p", vm.toString(i)))));
        }
        vm.roll(1000);
    }

    function _night(uint256 n) internal returns (uint256 id) {
        vm.prank(players[0]);
        id = hollow.createNight();
        for (uint256 i = 0; i < n; i++) {
            vm.prank(players[i]);
            hollow.join(id);
        }
        vm.prank(players[0]);
        hollow.start(id);
    }

    function _start(uint256 id) internal view returns (uint256 s) {
        (,,,,,, s,,,,) = hollow.nights(id);
    }

    function _epochWord(uint256 id, uint256 e) internal view returns (uint256) {
        return hollow.epochs(id, e);
    }

    function _soulInBody(uint256 id, uint256 e, uint256 body) internal view returns (uint256) {
        return (_epochWord(id, e) >> (4 * body)) & 0xF;
    }

    function _hollowSince(uint256 id, uint256 soul) internal view returns (uint64 hs) {
        (, hs,) = hollow.souls(id, soul);
    }

    /// record samples [from, from+pts.length) for `body` as `who`, at the block of the last sample
    function _rec(uint256 id, address who, uint8 body, uint32 from, uint256[] memory pts, uint8 voice) internal {
        uint256 packed;
        for (uint256 k = 0; k < pts.length; k++) {
            packed |= pts[k] << (32 * k);
        }
        uint256 lastBlock = _start(id) + 2 * (uint256(from) + pts.length - 1);
        if (block.number < lastBlock) vm.roll(lastBlock);
        vm.prank(who);
        hollow.record(id, body, from, packed, uint8(pts.length), voice);
    }

    function _one(uint256 p) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = p;
    }

    function test_lobbyAndStartPicksOneHollow() public {
        uint256 id = _night(4);
        uint256 hollows;
        for (uint256 i = 0; i < 4; i++) {
            if (_hollowSince(id, i) != 0) hollows++;
        }
        assertEq(hollows, 1);
        (,,, uint8 living,,,,,,,) = hollow.nights(id);
        assertEq(living, 3);
        // epoch 0: everyone in their own body
        for (uint256 b = 0; b < 4; b++) {
            assertEq(_soulInBody(id, 0, b), b);
        }
    }

    function test_twoHollowsWithSixSouls() public {
        uint256 id = _night(6);
        uint256 hollows;
        for (uint256 i = 0; i < 6; i++) {
            if (_hollowSince(id, i) != 0) hollows++;
        }
        assertEq(hollows, 2);
    }

    function test_recordMovesYourBody() public {
        uint256 id = _night(3);
        uint256[] memory pts = new uint256[](3);
        pts[0] = cellCm(2, 2);
        pts[1] = cellCm(2, 3);
        pts[2] = cellCm(2, 4);
        _rec(id, players[0], 0, 0, pts, 2);
        (uint32 nS, uint32 lastPos,, uint8 voice, uint32 voiceIndex) = hollow.bodies(id, 0);
        assertEq(nS, 3);
        assertEq(lastPos, cellCm(2, 4));
        assertEq(voice, 2);
        assertEq(voiceIndex, 2);
    }

    function test_cannotDriveSomeoneElsesBody() public {
        uint256 id = _night(3);
        vm.roll(_start(id));
        vm.prank(players[1]);
        vm.expectRevert(Hollow.NotYourBody.selector);
        hollow.record(id, 0, 0, cellCm(2, 2), 1, 0);
    }

    function test_rejectsWallsTeleportsAndWallHops() public {
        uint256 id = _night(3);
        vm.roll(_start(id) + 2);
        // into a wall cell
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, 0, 0, cellCm(10, 6), 1, 0);
        // teleport far away
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, 0, 0, cellCm(20, 20), 1, 0);

        // walk next to the wall, then try to hop through it in one sample (midpoint is inside the wall)
        uint256[] memory pts = new uint256[](4);
        pts[0] = cellCm(2, 2);
        pts[1] = cellCm(3, 3);
        pts[2] = cellCm(4, 4);
        pts[3] = cellCm(5, 5);
        _rec(id, players[0], 0, 0, pts, 0);
        uint256[] memory more = new uint256[](3);
        more[0] = cellCm(6, 6);
        more[1] = cellCm(7, 6);
        more[2] = cellCm(8, 6);
        _rec(id, players[0], 0, 4, more, 0);
        _rec(id, players[0], 0, 7, _one(pt(9 * CELL + 240, 6 * CELL + 125)), 0); // hugging the wall
        vm.roll(block.number + 2);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, 0, 8, pt(11 * CELL + 10, 6 * CELL + 125), 1, 0);
    }

    function test_samplesMustBeTimely() public {
        uint256 id = _night(3);
        vm.roll(_start(id));
        // a sample for a future block
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, 0, 5, cellCm(2, 2), 1, 0);
        // a sample older than LATE_BLOCKS
        vm.roll(_start(id) + 100);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.TooLate.selector);
        hollow.record(id, 0, 0, cellCm(2, 2), 1, 0);
    }

    function test_idleGapsAreAllowedButReachIsBounded() public {
        uint256 id = _night(3);
        _rec(id, players[0], 0, 0, _one(cellCm(2, 2)), 0);
        // 5 intervals later the body may have moved up to 5 * MAX_STEP
        _rec(id, players[0], 0, 5, _one(cellCm(2, 9)), 0);
        (uint32 nS,,,,) = hollow.bodies(id, 0);
        assertEq(nS, 6);
    }

    function test_shiftMovesEverySoulToAnotherBody() public {
        uint256 id = _night(5);
        (,,,,,,, uint64 nextShift,,,) = hollow.nights(id);
        vm.roll(nextShift);
        hollow.sync(id);
        (,,,,,,,,,, uint32 epoch) = hollow.nights(id);
        assertEq(epoch, 1);
        bool[5] memory seen;
        for (uint256 b = 0; b < 5; b++) {
            uint256 s = _soulInBody(id, 1, b);
            assertTrue(s != b, "soul stayed in its own body");
            assertFalse(seen[s]);
            seen[s] = true;
        }
        // the soul now in body 0 can drive it; the original owner cannot
        uint256 sNew = _soulInBody(id, 1, 0);
        uint32 idx = uint32((nextShift - _start(id)) / 2) + 1;
        vm.roll(_start(id) + 2 * uint256(idx));
        vm.prank(players[0]);
        vm.expectRevert(Hollow.NotYourBody.selector);
        hollow.record(id, 0, idx, cellCm(2, 2), 1, 0);
        vm.prank(players[sNew]);
        hollow.record(id, 0, idx, cellCm(2, 2), 1, 0);
    }

    function test_hollowTouchTurnsTheLiving() public {
        uint256 id = _night(3);
        // find the hollow soul and a living one
        uint256 h;
        for (uint256 i = 0; i < 3; i++) {
            if (_hollowSince(id, i) != 0) h = i;
        }
        uint256 v = (h + 1) % 3;
        // hollow body walks from its spawn to the victim's spawn (row y=2, cells 2+2i)
        uint256 hx = 2 + 2 * h;
        uint256 vx = 2 + 2 * v;
        uint32 idx = 0;
        // wait out the start grace first: stand still for 20 samples
        _rec(id, players[h], uint8(h), 0, _one(cellCm(hx, 2)), 0);
        idx = 20;
        uint256 x = hx;
        while (x != vx) {
            x = x < vx ? x + 1 : x - 1;
            _rec(id, players[h], uint8(h), idx, _one(cellCm(x, 2)), 0);
            idx++;
        }
        uint32 touch = idx - 1;
        // victim never moved: its position is its spawn once the index is final
        vm.roll(block.number + 50);
        hollow.turn(id, 0, uint8(v), uint8(h), touch);
        assertEq(_hollowSince(id, v), _start(id) + 2 * uint256(touch));
        (,,, uint8 living,,,,,,,) = hollow.nights(id);
        assertEq(living, 1);
        // a living body cannot "turn" anyone
        vm.expectRevert(Hollow.InvalidProof.selector);
        hollow.turn(id, 0, uint8(h), uint8((h + 2) % 3), touch);
    }

    function test_turnRejectsFarBodiesAndGrace() public {
        uint256 id = _night(3);
        uint256 h;
        for (uint256 i = 0; i < 3; i++) {
            if (_hollowSince(id, i) != 0) h = i;
        }
        uint256 v = (h + 1) % 3;
        vm.roll(_start(id) + 200);
        // far apart (different spawns)
        vm.expectRevert(Hollow.InvalidProof.selector);
        hollow.turn(id, 0, uint8(v), uint8(h), 30);
        // inside the start grace window
        vm.expectRevert(Hollow.InvalidProof.selector);
        hollow.turn(id, 0, uint8(v), uint8(h), 2);
    }

    function test_fusesOpenTheExitAndTheLivingEscape() public {
        uint256 id = _night(2);
        uint256 h;
        for (uint256 i = 0; i < 2; i++) {
            if (_hollowSince(id, i) != 0) h = i;
        }
        uint256 v = 1 - h;
        uint8 body = uint8(v);
        // walk from spawn (2+2v, 2) down to row 8, then across the three fuses, then to the exit (8,12)
        uint256 sx = 2 + 2 * v;
        uint32 idx = 0;
        uint256[] memory path = new uint256[](40);
        uint256 n;
        uint256 x = sx;
        uint256 y = 2;
        path[n++] = cellCm(x, y);
        while (y < 8) path[n++] = cellCm(x, ++y);
        while (x > 5) path[n++] = cellCm(--x, y);
        while (x < 5) path[n++] = cellCm(++x, y);
        uint32 f0 = uint32(n - 1);
        path[n++] = cellCm(6, 8);
        uint32 f1 = uint32(n - 1);
        path[n++] = cellCm(7, 8);
        uint32 f2 = uint32(n - 1);
        path[n++] = cellCm(8, 8);
        while (y < 12) path[n++] = cellCm(8, ++y);
        uint32 ex = uint32(n - 1);
        for (uint256 k = 0; k < n; k++) {
            _rec(id, players[v], body, idx, _one(path[k]), 0);
            idx++;
        }
        assertLt(uint256(_start(id)) + 2 * idx, uint256(_start(id)) + 120, "walked past the first shift");
        hollow.collectFuse(id, 0, body, f0, 0);
        hollow.collectFuse(id, 0, body, f1, 1);
        // escape before the exit has power fails
        vm.expectRevert(Hollow.InvalidProof.selector);
        hollow.escape(id, 0, body, ex);
        hollow.collectFuse(id, 0, body, f2, 2);
        // exit opened at the current block; the soul must stand in it at or after that block
        uint256[] memory stay = new uint256[](1);
        stay[0] = cellCm(8, 12);
        vm.roll(block.number + 2);
        uint32 later = uint32((block.number - _start(id)) / 2);
        _rec(id, players[v], body, later, stay, 0);
        hollow.escape(id, 0, body, later);
        (, , uint32 escapedRel) = hollow.souls(id, v);
        assertGt(escapedRel, 0);
        (,,, uint8 living,, uint8 goneMask,,,,,) = hollow.nights(id);
        assertEq(living, 0);
        assertEq(goneMask, 1 << v);
    }

    function test_gasRecordThreeSamples() public {
        uint256 id = _night(8);
        uint256[] memory pts = new uint256[](3);
        pts[0] = cellCm(2, 2);
        pts[1] = cellCm(2, 3);
        pts[2] = cellCm(2, 4);
        _rec(id, players[0], 0, 0, pts, 0);
        uint256[] memory nxt = new uint256[](3);
        nxt[0] = cellCm(3, 4);
        nxt[1] = cellCm(4, 4);
        nxt[2] = cellCm(5, 4);
        uint256 packed = nxt[0] | (nxt[1] << 32) | (nxt[2] << 64);
        vm.roll(_start(id) + 10);
        vm.prank(players[0]);
        uint256 g = gasleft();
        hollow.record(id, 0, 3, packed, 3, 0);
        emit log_named_uint("record(3) gas (excl. 21k base)", g - gasleft());
        // shift-triggering record
        (,,,,,,, uint64 nextShift,,,) = hollow.nights(id);
        vm.roll(nextShift);
        uint256 s = _soulInBody(id, 0, 0);
        s = s; // silence
        g = gasleft();
        hollow.sync(id);
        emit log_named_uint("sync() applying one shift, 8 souls", g - gasleft());
    }
}
