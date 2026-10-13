// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hollow} from "../src/Hollow.sol";

contract HollowTest is Test {
    Hollow hollow;
    uint256 constant CELL = 300;
    address[] players;

    function cellCm(uint256 cx, uint256 cy) internal pure returns (uint256) {
        return (cx * CELL + CELL / 2) | ((cy * CELL + CELL / 2) << 16);
    }

    function pt(uint256 x, uint256 y) internal pure returns (uint256) {
        return x | (y << 16);
    }

    function setUp() public {
        // open 64x64 room: solid border + one internal wall column at x=10, y=5..20
        uint256[16] memory walls;
        for (uint256 y = 0; y < 64; y++) {
            for (uint256 x = 0; x < 64; x++) {
                bool solid = x == 0 || y == 0 || x == 63 || y == 63 || (x == 10 && y >= 5 && y <= 20);
                if (solid) {
                    uint256 bit = y * 64 + x;
                    walls[bit >> 8] |= 1 << (bit & 255);
                }
            }
        }
        uint256 spawns;
        for (uint256 i = 0; i < 8; i++) {
            spawns |= cellCm(2 + 2 * i, 2) << (32 * i);
        }
        uint256 objectives = cellCm(5, 8) | (cellCm(6, 8) << 32) | (cellCm(7, 8) << 64) | (cellCm(8, 12) << 96)
            | (cellCm(3, 3) << 128) | (cellCm(4, 3) << 160) | (cellCm(5, 3) << 192);
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
        // roles come from the hash of the block before the night begins
        vm.roll(_start(id));
        hollow.sync(id);
    }

    function _start(uint256 id) internal view returns (uint256 s) {
        s = hollow.nights(id).startBlock;
    }

    function _n(uint256 id) internal view returns (Hollow.Night memory) {
        return hollow.nights(id);
    }

    function _epochWord(uint256 id, uint256 e) internal view returns (uint256) {
        return hollow.epochWord(id, e);
    }

    function _soul(address who, uint256 id) internal view returns (uint8) {
        return uint8(hollow.soulIndexPlus1(id, who) - 1);
    }

    function _soulInBody(uint256 id, uint256 e, uint256 body) internal view returns (uint256) {
        return (_epochWord(id, e) >> (4 * body)) & 0xF;
    }

    function _hollowSince(uint256 id, uint256 soul) internal view returns (uint64 hs) {
        hs = hollow.soulInfo(id, soul).hollowSince;
    }

    /// record samples [from, from+pts.length) for `body` as `who`, at the block of the last sample
    function _rec(uint256 id, address who, uint8 body, uint32 from, uint256[] memory pts, uint8 voice) internal {
        uint256 packed;
        for (uint256 k = 0; k < pts.length; k++) {
            packed |= pts[k] << (32 * k);
        }
        uint256 lastBlock = _start(id) + 2 * (uint256(from) + pts.length - 1);
        if (block.number < lastBlock) vm.roll(lastBlock);
        uint8 soul = _soul(who, id);
        vm.prank(who);
        hollow.record(id, soul, body, from, packed, uint8(pts.length), voice);
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
        uint8 living = _n(id).living;
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
        Hollow.Body memory bd = hollow.bodyInfo(id, 0);
        (uint32 nS, uint32 lastPos, uint8 voice, uint32 voiceIndex) = (bd.nSamples, bd.lastPos, bd.voice, bd.voiceIndex);
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
        hollow.record(id, uint8(1), 0, 0, cellCm(2, 2), 1, 0);
    }

    function test_rejectsWallsTeleportsAndWallHops() public {
        uint256 id = _night(3);
        vm.roll(_start(id) + 2);
        // into a wall cell
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, uint8(0), 0, 0, cellCm(10, 6), 1, 0);
        // teleport far away
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, uint8(0), 0, 0, cellCm(20, 20), 1, 0);

        // walk next to the wall, then try to hop through it in one sample (midpoint is inside the wall)
        uint256[] memory pts = new uint256[](4);
        pts[0] = cellCm(2, 2);
        pts[1] = cellCm(2, 3);
        pts[2] = cellCm(2, 4);
        pts[3] = cellCm(2, 5);
        _rec(id, players[0], 0, 0, pts, 0);
        uint256[] memory more = new uint256[](3);
        more[0] = cellCm(2, 6);
        more[1] = cellCm(3, 6);
        more[2] = cellCm(4, 6);
        _rec(id, players[0], 0, 4, more, 0);
        uint256[] memory walk = new uint256[](5);
        walk[0] = cellCm(5, 6);
        walk[1] = cellCm(6, 6);
        walk[2] = cellCm(7, 6);
        walk[3] = cellCm(8, 6);
        walk[4] = cellCm(9, 6);
        _rec(id, players[0], 0, 7, walk, 0);
        _rec(id, players[0], 0, 12, _one(pt(9 * CELL + 290, 6 * CELL + 150)), 0); // hugging the wall
        vm.roll(block.number + 2);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, uint8(0), 0, 13, pt(11 * CELL + 10, 6 * CELL + 150), 1, 0);
        // a longer hop after a gap whose midpoint is open (cell 12) but that crosses the wall at cell 10
        vm.roll(_start(id) + 2 * 17);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, uint8(0), 0, 17, cellCm(15, 6), 1, 0);
    }

    function test_samplesMustBeTimely() public {
        uint256 id = _night(3);
        vm.roll(_start(id));
        // a sample for a future block
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, uint8(0), 0, 5, cellCm(2, 2), 1, 0);
        // a sample older than LATE_BLOCKS
        vm.roll(_start(id) + 100);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.TooLate.selector);
        hollow.record(id, uint8(0), 0, 0, cellCm(2, 2), 1, 0);
    }

    function test_idleGapsAreAllowedButReachIsBounded() public {
        uint256 id = _night(3);
        _rec(id, players[0], 0, 0, _one(cellCm(2, 2)), 0);
        // 5 intervals later the body may have moved up to 5 * MAX_STEP
        _rec(id, players[0], 0, 5, _one(cellCm(2, 9)), 0);
        uint32 nS = hollow.bodyInfo(id, 0).nSamples;
        assertEq(nS, 6);
    }

    /// Not recording must not hide a walk: after a long gap the body can only have covered what the
    /// late window allows (MAX_GAP_STEPS samples), not gap * MAX_STEP.
    function test_longGapCannotHideAWalk() public {
        uint256 id = _night(1); // a lone soul: no shifts get in the way of the arithmetic
        _rec(id, players[0], 0, 0, _one(cellCm(2, 2)), 0);
        uint256 cap = hollow.MAX_GAP_STEPS() * hollow.MAX_STEP_CM();
        // 40 samples later, 40 * 4.2m away would have been fine before; now only `cap` is
        uint256 far = pt(2 * CELL + 150, 2 * CELL + 150 + cap + 300);
        vm.roll(_start(id) + 80);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, 0, 0, 40, far, 1, 0);
        uint256 near = pt(2 * CELL + 150, 2 * CELL + 150 + cap - 100);
        vm.prank(players[0]);
        hollow.record(id, 0, 0, 40, near, 1, 0);
    }

    function test_zeroIsNeverASample() public {
        uint256 id = _night(1);
        vm.roll(_start(id) + 2);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.BadSamples.selector);
        hollow.record(id, 0, 0, 0, 0, 1, 0);
    }

    function test_shiftMovesEverySoulToAnotherBody() public {
        uint256 id = _night(5);
        uint64 nextShift = _n(id).nextShift;
        vm.roll(nextShift);
        hollow.sync(id);
        uint32 epoch = _n(id).epoch;
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
        hollow.record(id, uint8(0), 0, idx, cellCm(2, 2), 1, 0);
        vm.prank(players[sNew]);
        hollow.record(id, uint8(sNew), 0, idx, cellCm(2, 2), 1, 0);
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
        uint8 living = _n(id).living;
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
        uint32 escapedRel = hollow.soulInfo(id, v).escapedRel;
        assertGt(escapedRel, 0);
        uint8 living = _n(id).living;
        uint8 goneMask = _n(id).goneMask;
        uint8 escapedCount = _n(id).escapedCount;
        assertEq(escapedCount, 1);
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
        hollow.record(id, uint8(0), 0, 3, packed, 3, 0);
        emit log_named_uint("record(3) gas (excl. 21k base)", g - gasleft());
        // shift-triggering record
        uint64 nextShift = _n(id).nextShift;
        vm.roll(nextShift);
        uint256 s = _soulInBody(id, 0, 0);
        s = s; // silence
        g = gasleft();
        hollow.sync(id);
        emit log_named_uint("sync() applying one shift, 8 souls", g - gasleft());
    }

    function test_watchersTormentAndForceShift() public {
        uint256 id = _night(4);
        address watcher = makeAddr("watcher");
        vm.deal(watcher, 1 ether);
        vm.roll(_start(id) + 5);
        vm.prank(watcher);
        vm.expectRevert(Hollow.FeeTooLow.selector);
        hollow.torment{value: 0.001 ether}(id, 1, 0);
        vm.prank(watcher);
        hollow.torment{value: 0.01 ether}(id, 2, 1);
        vm.prank(watcher);
        hollow.torment{value: 0.05 ether}(id, 4, 0);
        uint64 nextShift = _n(id).nextShift;
        assertEq(nextShift, block.number + 10);
        // cooldown
        vm.prank(watcher);
        vm.expectRevert(Hollow.Cooldown.selector);
        hollow.torment{value: 0.05 ether}(id, 4, 0);
        assertEq(hollow.pot(id), 0.06 ether);
        vm.roll(nextShift);
        hollow.sync(id);
        uint32 epoch = _n(id).epoch;
        assertEq(epoch, 1);
    }

    function _roles(uint256 id, uint256 count) internal view returns (uint256 h) {
        for (uint256 i = 0; i < count; i++) {
            if (_hollowSince(id, i) != 0) h = i;
        }
    }

    function test_nobodyEscapedSoTheHollowKeepsThePot() public {
        uint256 id = _night(2);
        address watcher = makeAddr("watcher");
        vm.deal(watcher, 1 ether);
        vm.roll(_start(id) + 1);
        vm.prank(watcher);
        hollow.torment{value: 0.01 ether}(id, 3, 0);
        uint256 h = _roles(id, 2);
        uint256 v = 1 - h;
        // not before dawn
        vm.prank(players[h]);
        vm.expectRevert(Hollow.NightOver.selector);
        hollow.claimPot(id, uint8(h));
        vm.roll(_start(id) + hollow.NIGHT_BLOCKS());
        // the living soul that never got out wins nothing
        vm.prank(players[v]);
        vm.expectRevert(Hollow.NothingToClaim.selector);
        hollow.claimPot(id, uint8(v));
        // nobody can claim as someone else
        vm.prank(players[v]);
        vm.expectRevert(Hollow.NotASoul.selector);
        hollow.claimPot(id, uint8(h));
        assertEq(hollow.claimable(id, uint8(h)), 0.01 ether);
        uint256 before = players[h].balance;
        vm.prank(players[h]);
        hollow.claimPot(id, uint8(h));
        assertEq(players[h].balance - before, 0.01 ether);
        assertEq(hollow.claimable(id, uint8(h)), 0);
        // once only
        vm.prank(players[h]);
        vm.expectRevert(Hollow.NothingToClaim.selector);
        hollow.claimPot(id, uint8(h));
    }

    function test_escapeesSplitThePot() public {
        uint256 id = _night(2);
        uint256 h = _roles(id, 2);
        uint256 v = 1 - h;
        address watcher = makeAddr("watcher");
        vm.deal(watcher, 1 ether);
        vm.roll(_start(id) + 1);
        vm.prank(watcher);
        hollow.torment{value: 0.01 ether}(id, 2, 0);
        // walk soul v's body over the fuses to the exit (same route as the escape test)
        uint8 body = uint8(v);
        uint256 x = 2 + 2 * v;
        uint256 y = 2;
        uint32 idx = 0;
        _rec(id, players[v], body, idx++, _one(cellCm(x, y)), 0);
        while (y < 8) _rec(id, players[v], body, idx++, _one(cellCm(x, ++y)), 0);
        while (x > 5) _rec(id, players[v], body, idx++, _one(cellCm(--x, y)), 0);
        while (x < 5) _rec(id, players[v], body, idx++, _one(cellCm(++x, y)), 0);
        hollow.collectFuse(id, 0, body, idx - 1, 0);
        _rec(id, players[v], body, idx++, _one(cellCm(6, 8)), 0);
        hollow.collectFuse(id, 0, body, idx - 1, 1);
        _rec(id, players[v], body, idx++, _one(cellCm(7, 8)), 0);
        hollow.collectFuse(id, 0, body, idx - 1, 2);
        _rec(id, players[v], body, idx++, _one(cellCm(8, 8)), 0);
        y = 8;
        while (y < 12) _rec(id, players[v], body, idx++, _one(cellCm(8, ++y)), 0);
        hollow.escape(id, 0, body, idx - 1);
        // the night ended when the last living soul left
        assertGt(_n(id).endBlock, 0);
        // the Hollow gets nothing when someone escaped
        vm.prank(players[h]);
        vm.expectRevert(Hollow.NothingToClaim.selector);
        hollow.claimPot(id, uint8(h));
        uint256 before = players[v].balance;
        vm.prank(players[v]);
        hollow.claimPot(id, uint8(v));
        assertEq(players[v].balance - before, 0.01 ether);
    }

    /// The old rollOver let anyone park a pot in a lobby that never starts (locked forever) or farm
    /// failed nights' pots with a solo night. There is no path for MON other than claimPot.
    function test_potHasNoOtherExit() public {
        uint256 id = _night(1);
        address watcher = makeAddr("watcher");
        vm.deal(watcher, 1 ether);
        vm.roll(_start(id) + 1);
        vm.prank(watcher);
        hollow.torment{value: 0.01 ether}(id, 2, 0);
        vm.roll(_start(id) + hollow.NIGHT_BLOCKS());
        // a lone soul with no Hollow and no escape gets its own night's pot back, nobody else can
        vm.prank(watcher);
        vm.expectRevert(Hollow.NotASoul.selector);
        hollow.claimPot(id, 0);
        vm.prank(players[0]);
        hollow.claimPot(id, 0);
        assertEq(address(hollow).balance, 0);
    }

    /// Long idle gaps used to make a body unprovable (a 256-sample scan limit): a camper could resume
    /// recording right after being touched and void the proof. Gaps of any length are now provable.
    function test_longGapsStayProvable() public {
        uint256 id = _night(2);
        uint256 h = _roles(id, 2);
        uint256 v = 1 - h;
        uint256 vx = 2 + 2 * v;
        // the Hollow's body walks onto the victim's spawn and stands there
        _rec(id, players[h], uint8(h), 0, _one(cellCm(2 + 2 * h, 2)), 0);
        _rec(id, players[h], uint8(h), 1, _one(cellCm(3, 2)), 0);
        _rec(id, players[h], uint8(h), 2, _one(cellCm(vx, 2)), 0);
        // the victim's body records once, idles for 300 samples, then records again in place
        _rec(id, players[v], uint8(v), 0, _one(cellCm(vx, 2)), 0);
        uint32 resume = 300;
        vm.roll(_start(id) + 2 * uint256(resume));
        hollow.sync(id);
        uint256 e = _n(id).epoch;
        uint8 wearer = uint8(_soulInBody(id, e, v));
        vm.prank(players[wearer]);
        hollow.record(id, wearer, uint8(v), resume, cellCm(vx, 2), 1, 0);
        // a touch deep inside the gap (more than 256 samples after the last recorded one)
        uint32 index = 290;
        (uint32 ep, uint256 eStart) = _epochOf(id, _start(id) + 2 * uint256(index));
        while (_start(id) + 2 * uint256(index) < eStart + hollow.SHIFT_GRACE_BLOCKS()) {
            index--;
            (ep, eStart) = _epochOf(id, _start(id) + 2 * uint256(index));
        }
        assertGt(index, 256);
        uint8 victimBody = uint8(_soulInBody(id, ep, v) == v ? v : h);
        uint8 hollowBody = victimBody == uint8(v) ? uint8(h) : uint8(v);
        hollow.turn(id, ep, victimBody, hollowBody, index);
        assertGt(_hollowSince(id, v), 0);
    }

    /// The gas design relies on each night's record and each body's samples sitting inside one
    /// 128-slot storage page: check the data really lands at the page-aligned slots.
    function test_storageIsPageAligned() public {
        uint256 id = _night(2);
        bytes32 nightSlot = keccak256(abi.encode(id, "hollow.night")) & ~bytes32(uint256(0x7f));
        assertEq(uint256(nightSlot) % 128, 0);
        assertEq(address(uint160(uint256(vm.load(address(hollow), nightSlot)))), players[0]);
        _rec(id, players[0], 0, 0, _one(cellCm(2, 2)), 0);
        bytes32 sampleSlot = keccak256(abi.encode(id, uint256(0), "hollow.samples")) & ~bytes32(uint256(0x7f));
        assertEq(uint256(vm.load(address(hollow), sampleSlot)) & 0xFFFFFFFF, cellCm(2, 2));
    }

    function _epochOf(uint256 id, uint256 blk) internal view returns (uint32 e, uint256 eStart) {
        uint256 cur = _n(id).epoch;
        for (uint256 i = 0; i <= cur; i++) {
            uint256 st = (_epochWord(id, i) >> 32) & type(uint64).max;
            if (st <= blk) (e, eStart) = (uint32(i), st);
        }
    }

    function test_shopsSellIntoTheBodysPockets() public {
        uint256 id = _night(3);
        vm.deal(players[0], 1 ether);
        // body 0 spawns at (2,2); the 24/7 mart counter is at (3,3), the pharmacy at (4,3)
        uint256[] memory pts = new uint256[](3);
        pts[0] = cellCm(2, 2);
        pts[1] = cellCm(3, 2);
        pts[2] = cellCm(3, 3);
        _rec(id, players[0], 0, 0, pts, 0);
        // too cheap
        vm.prank(players[0]);
        vm.expectRevert(Hollow.FeeTooLow.selector);
        hollow.buy{value: 0.001 ether}(id, 0, 0, 0, 2, 0);
        // pills are sold at the pharmacy, not here
        vm.prank(players[0]);
        vm.expectRevert(Hollow.NotAtShop.selector);
        hollow.buy{value: 0.004 ether}(id, 0, 0, 0, 2, 3);
        // a battery from the mart
        vm.prank(players[0]);
        hollow.buy{value: 0.004 ether}(id, 0, 0, 0, 2, 0);
        assertEq(hollow.pocketsOf(id, 0) & 0xFFFF, 1);
        assertEq(hollow.pot(id), 0.004 ether);
        // someone else cannot use body 0's battery
        vm.prank(players[1]);
        vm.expectRevert(Hollow.NotYourBody.selector);
        hollow.use(id, 1, 0, 0);
        // nor pretend to be its soul
        vm.prank(players[1]);
        vm.expectRevert(Hollow.NotASoul.selector);
        hollow.use(id, 0, 0, 0);
        vm.prank(players[0]);
        hollow.use(id, 0, 0, 0);
        assertEq(hollow.pocketsOf(id, 0) & 0xFFFF, 0);
        vm.prank(players[0]);
        vm.expectRevert(Hollow.NoItem.selector);
        hollow.use(id, 0, 0, 0);
    }

    function test_pocketsStayWithTheBodyAfterAShift() public {
        uint256 id = _night(3);
        vm.deal(players[0], 1 ether);
        uint256[] memory pts = new uint256[](3);
        pts[0] = cellCm(2, 2);
        pts[1] = cellCm(3, 2);
        pts[2] = cellCm(3, 3);
        _rec(id, players[0], 0, 0, pts, 0);
        vm.prank(players[0]);
        hollow.buy{value: 0.008 ether}(id, 0, 0, 0, 2, 1); // a flare in body 0's pocket
        uint64 nextShift = _n(id).nextShift;
        vm.roll(nextShift);
        hollow.sync(id);
        uint256 wearer = _soulInBody(id, 1, 0);
        assertTrue(wearer != 0);
        // the original owner lost it; whoever wears body 0 now can light it
        vm.prank(players[0]);
        vm.expectRevert(Hollow.NotYourBody.selector);
        hollow.use(id, 0, 0, 1);
        vm.prank(players[wearer]);
        hollow.use(id, uint8(wearer), 0, 1);
    }

    function test_rolesComeFromAFutureBlock() public {
        vm.prank(players[0]);
        uint256 id = hollow.createNight();
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(players[i]);
            hollow.join(id);
        }
        vm.prank(players[0]);
        hollow.start(id);
        // right after start() nobody is Hollow yet: the deciding block hash does not exist
        for (uint256 i = 0; i < 4; i++) assertEq(_hollowSince(id, i), 0);
        assertFalse(_n(id).rolesSet);
        vm.roll(_start(id));
        hollow.sync(id);
        assertTrue(_n(id).rolesSet);
        uint256 hollows;
        for (uint256 i = 0; i < 4; i++) if (_hollowSince(id, i) != 0) hollows++;
        assertEq(hollows, 1);
        assertEq(_n(id).living, 3);
    }

    function test_paymentsMustBeExact() public {
        uint256 id = _night(3);
        address watcher = makeAddr("watcher");
        vm.deal(watcher, 1 ether);
        vm.roll(_start(id) + 3);
        vm.prank(watcher);
        vm.expectRevert(Hollow.FeeTooLow.selector);
        hollow.torment{value: 0.02 ether}(id, 1, 0);
    }
}
