// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HOLLOW — onchain body-swap horror on Monad
/// @notice Up to 8 souls enter the Archive, each in their own body. Every 30-75s the chain
///         reshuffles every soul into a different body (a random single-cycle permutation
///         seeded by the previous block hash). A hidden Hollow soul turns whoever its body
///         touches; the turned soul becomes Hollow in place. The living must collect three
///         fuses and reach the exit. Every body's position is recorded onchain every
///         2 blocks, so kills, fuses and escapes are all proven against recorded samples.
contract Hollow {
    // ---------------------------------------------------------------- map
    uint256 public constant GRID = 64; // cells per side
    uint256 public constant CELL_CM = 300; // cell size in centimetres
    uint256 public constant WORLD_CM = GRID * CELL_CM; // 19200cm = 192m: the town of Halden

    // ---------------------------------------------------------------- timing (in blocks, ~0.3s each)
    uint256 public constant SAMPLE_BLOCKS = 2; // one position sample per body every 2 blocks
    uint256 public constant LATE_BLOCKS = 40; // samples must be submitted within ~12s
    uint256 public constant COUNTDOWN_BLOCKS = 20; // after start() before the night begins
    uint256 public constant START_GRACE_BLOCKS = 30; // no turning in the first ~9s
    uint256 public constant SHIFT_GRACE_BLOCKS = 10; // no turning ~3s after each shift
    uint256 public constant FIRST_SHIFT_MIN = 120;
    uint256 public constant SHIFT_MIN = 100; // shifts every 30s..75s
    uint256 public constant SHIFT_RANGE = 150;
    uint256 public constant NIGHT_BLOCKS = 2400; // a night lasts at most ~12 minutes
    uint256 public constant LOBBY_BLOCKS = 600;

    // ---------------------------------------------------------------- distances (cm)
    uint256 public constant MAX_STEP_CM = 420; // per sample (0.6s) => 7 m/s ceiling
    uint256 public constant TURN_RADIUS_CM = 120;
    uint256 public constant OBJECTIVE_RADIUS_CM = 160;
    uint256 public constant SPAWN_RADIUS_CM = 200;

    // ---------------------------------------------------------------- watchers
    uint256 public constant TORMENT_FEE = 0.01 ether; // in MON
    uint256 public constant FORCE_SHIFT_MULTIPLIER = 5;
    uint256 public constant FORCE_SHIFT_COOLDOWN = 200;
    uint256 public constant FORCE_SHIFT_DELAY = 10;
    uint8 public constant TORMENT_LIGHTS_OUT = 1;
    uint8 public constant TORMENT_WHISPER = 2;
    uint8 public constant TORMENT_SCREAM = 3;
    uint8 public constant TORMENT_FORCE_SHIFT = 4;

    // ---------------------------------------------------------------- shops & items
    uint256 public constant SHOP_RADIUS_CM = 250;
    uint256 public constant MAX_ITEM_STACK = 9;
    uint8 public constant ITEM_COUNT = 6;
    // 0 battery, 1 flare, 2 music box (24/7 mart) · 3 pills, 4 adrenaline (pharmacy) · 5 polaroid (photo)

    uint256 public constant MAX_SOULS = 8;
    /// @dev how far back a proof may look for the last recorded sample of an idle body
    uint256 public constant MAX_SCAN = 256;

    // ---------------------------------------------------------------- immutable map data
    /// @dev bit (cy*GRID + cx) set => solid cell. 4096 bits over 16 words.
    uint256[16] public walls;
    /// @dev 8 spawn points, 32 bits each: x(16) | y(16) << 16
    uint256 public spawns;
    /// @dev fuse0, fuse1, fuse2, exit, shop0 (24/7 mart), shop1 (pharmacy), shop2 (photo) — 32 bits each
    uint256 public objectives;

    // ---------------------------------------------------------------- state
    struct Night {
        // slot 0
        address host;
        uint64 lobbyEnd;
        uint8 nSouls;
        uint8 living; // living souls still in play
        uint8 fuses; // bitmask of collected fuses
        uint8 goneMask; // bodies that left through the exit
        // slot 1
        uint64 startBlock; // 0 until start() is called
        uint64 nextShift;
        uint64 exitOpenBlock;
        uint64 endBlock; // set when the last living soul is turned or escapes
        // slot 2
        uint32 epoch;
        uint8 escapedCount;
        uint64 lastForcedShift;
    }

    struct Soul {
        address addr;
        uint64 hollowSince; // 0 = living
        uint32 escapedRel; // block offset from startBlock when escaped, 0 = not escaped
    }

    struct Body {
        uint32 nSamples;
        uint32 lastPos; // packed x | y<<16
        uint32 goneRel; // escaped through the exit (offset from start), 0 = in play
        uint8 voice; // last voice line id spoken from this body
        uint32 voiceIndex; // sample index the voice was spoken at
    }

    uint256 public nightCount;
    mapping(uint256 => Night) public nights;
    mapping(uint256 => mapping(uint256 => Soul)) public souls;
    mapping(uint256 => mapping(address => uint256)) public soulIndexPlus1;
    mapping(uint256 => mapping(uint256 => Body)) public bodies;
    /// @dev night => epoch => word: assign (body i -> soul, 4 bits each, low 32 bits) |
    ///      epochStart (64 bits at offset 32) | in-play body mask (8 bits at offset 96)
    mapping(uint256 => mapping(uint256 => uint256)) public epochs;
    /// @dev night => (body << 32 | slotIndex) => 8 packed samples
    mapping(uint256 => mapping(uint256 => uint256)) public samples;
    mapping(address => bytes16) public names;
    /// @dev watcher fees collected per night, split between the souls that escape
    mapping(uint256 => uint256) public pot;
    mapping(uint256 => mapping(uint256 => bool)) public potClaimed;
    /// @dev night => body => item counts (16 bits per item). Pockets belong to bodies, not souls.
    mapping(uint256 => mapping(uint256 => uint256)) public pockets;

    // ---------------------------------------------------------------- events
    event NightCreated(uint256 indexed night, address indexed host, uint64 lobbyEnd);
    event Joined(uint256 indexed night, address indexed player, uint8 soul);
    event NightStarted(uint256 indexed night, uint64 startBlock);
    event Shifted(uint256 indexed night, uint32 epoch, uint64 atBlock);
    event Turned(uint256 indexed night, uint8 victimSoul, uint8 hollowSoul, uint8 body, uint64 atBlock);
    event FuseCollected(uint256 indexed night, uint8 fuse, uint8 soul, uint64 atBlock);
    event ExitOpened(uint256 indexed night, uint64 atBlock);
    event Escaped(uint256 indexed night, uint8 soul, uint8 body, uint64 atBlock);
    event Voice(uint256 indexed night, uint8 body, uint8 voice, uint32 sampleIndex);
    event Torment(uint256 indexed night, address indexed watcher, uint8 kind, uint8 body, uint64 atBlock, uint256 paid);
    event PotClaimed(uint256 indexed night, uint8 soul, uint256 amount);
    event PotRolledOver(uint256 indexed fromNight, uint256 indexed toNight, uint256 amount);
    event Bought(uint256 indexed night, uint8 body, uint8 soul, uint8 item, uint256 paid);
    event Used(uint256 indexed night, uint8 body, uint8 soul, uint8 item, uint32 pos, uint64 atBlock);

    error NotInLobby();
    error NightFull();
    error AlreadyJoined();
    error NotStarted();
    error NightOver();
    error NotASoul();
    error NotYourBody();
    error BadSamples();
    error TooLate();
    error InvalidProof();
    error FeeTooLow();
    error Cooldown();
    error NothingToClaim();
    error NotAtShop();
    error PocketsFull();
    error NoItem();

    constructor(uint256[16] memory walls_, uint256 spawns_, uint256 objectives_) {
        walls = walls_;
        spawns = spawns_;
        objectives = objectives_;
    }

    // ================================================================ lobby

    function setName(bytes16 name) external {
        names[msg.sender] = name;
    }

    function createNight() external returns (uint256 id) {
        id = ++nightCount;
        Night storage n = nights[id];
        n.host = msg.sender;
        n.lobbyEnd = uint64(block.number + LOBBY_BLOCKS);
        emit NightCreated(id, msg.sender, n.lobbyEnd);
    }

    function join(uint256 id) external {
        Night storage n = nights[id];
        if (n.host == address(0) || n.startBlock != 0 || block.number >= n.lobbyEnd) revert NotInLobby();
        if (n.nSouls >= MAX_SOULS) revert NightFull();
        if (soulIndexPlus1[id][msg.sender] != 0) revert AlreadyJoined();
        uint8 s = n.nSouls++;
        souls[id][s].addr = msg.sender;
        soulIndexPlus1[id][msg.sender] = uint256(s) + 1;
        emit Joined(id, msg.sender, s);
    }

    /// @notice The host can start early; anyone can start once the lobby window has passed.
    function start(uint256 id) external {
        Night storage n = nights[id];
        if (n.host == address(0) || n.startBlock != 0) revert NotInLobby();
        if (msg.sender != n.host && block.number < n.lobbyEnd) revert NotInLobby();
        uint256 count = n.nSouls;
        if (count == 0) revert NotASoul();

        uint64 startBlock = uint64(block.number + COUNTDOWN_BLOCKS);
        n.startBlock = startBlock;
        uint256 seed = uint256(keccak256(abi.encode(blockhash(block.number - 1), id, "hollow")));

        // choose the hidden Hollow(s)
        uint256 hollows = count >= 6 ? 2 : (count >= 2 ? 1 : 0);
        if (hollows > 0) {
            uint256 h1 = seed % count;
            souls[id][h1].hollowSince = startBlock;
            if (hollows == 2) {
                uint256 h2 = (h1 + 1 + (seed >> 8) % (count - 1)) % count;
                souls[id][h2].hollowSince = startBlock;
            }
        }
        n.living = uint8(count - hollows);

        // epoch 0: every soul starts in its own body
        uint256 assign;
        uint256 mask;
        for (uint256 i = 0; i < count; i++) {
            assign |= i << (4 * i);
            mask |= 1 << i;
        }
        epochs[id][0] = _packEpoch(assign, startBlock, mask);
        n.nextShift = uint64(startBlock + FIRST_SHIFT_MIN + (seed >> 16) % SHIFT_RANGE);
        emit NightStarted(id, startBlock);
    }

    // ================================================================ movement

    /// @notice Record up to 8 position samples for the body you currently control.
    /// @param fromIndex first sample index (sample k is at block startBlock + 2k)
    /// @param packed samples, 32 bits each (x | y<<16), first sample in the low bits
    /// @param voice voice line id spoken at the last sample (0 = none)
    function record(uint256 id, uint8 body, uint32 fromIndex, uint256 packed, uint8 count, uint8 voice) external {
        Night storage n = nights[id];
        uint256 startBlock = n.startBlock;
        if (startBlock == 0 || block.number < startBlock) revert NotStarted();
        if (_isOver(n)) revert NightOver();
        _sync(id, n);

        uint256 s = soulIndexPlus1[id][msg.sender];
        if (s == 0) revert NotASoul();
        s -= 1;
        if (count == 0 || count > 8 || body >= n.nSouls) revert BadSamples();

        Body storage b = bodies[id][body];
        if (b.goneRel != 0) revert NotYourBody();
        uint256 first = fromIndex;
        uint256 last = first + count - 1;
        if (first < b.nSamples) revert BadSamples();
        if (startBlock + last * SAMPLE_BLOCKS > block.number) revert BadSamples();
        if (startBlock + first * SAMPLE_BLOCKS + LATE_BLOCKS < block.number) revert TooLate();

        // the whole batch must sit inside one epoch in which msg.sender controls `body`
        {
            uint256 e = _epochAt(id, n.epoch, startBlock + first * SAMPLE_BLOCKS);
            if (e < n.epoch) {
                uint256 nextStart = (epochs[id][e + 1] >> 32) & type(uint64).max;
                if (startBlock + last * SAMPLE_BLOCKS >= nextStart) revert BadSamples();
            }
            if ((epochs[id][e] >> (4 * body)) & 0xF != s) revert NotYourBody();
        }

        // samples are append-only; skipped indices mean "stood still" (a zero word marks a gap)
        uint256 prevIndex = b.nSamples; // index the previous position belongs to (+1)
        uint256 pos = prevIndex == 0 ? (spawns >> (32 * body)) & 0xFFFFFFFF : b.lastPos;
        uint256 idx = first;
        uint256 slotKey = (uint256(body) << 32) | (idx >> 3);
        uint256 word = samples[id][slotKey];

        for (uint256 k = 0; k < count; k++) {
            uint256 p = (packed >> (32 * k)) & 0xFFFFFFFF;
            uint256 x = p & 0xFFFF;
            uint256 y = p >> 16;
            if (x >= WORLD_CM || y >= WORLD_CM || _solid(x, y)) revert BadSamples();
            // allowed travel grows with the number of sample intervals since the last known position
            uint256 steps = idx + 1 - prevIndex;
            uint256 reach = prevIndex == 0 && k == 0 ? SPAWN_RADIUS_CM + MAX_STEP_CM * idx : MAX_STEP_CM * steps;
            if (_dist2(p, pos) > reach * reach) revert BadSamples();
            // no stepping through walls: the midpoint of each hop must be open too
            if (_solid(((p & 0xFFFF) + (pos & 0xFFFF)) / 2, ((p >> 16) + (pos >> 16)) / 2)) revert BadSamples();
            (slotKey, word) = _put(id, body, slotKey, word, idx, p);
            pos = p;
            prevIndex = idx + 1;
            idx++;
        }
        samples[id][slotKey] = word;

        b.nSamples = uint32(idx);
        b.lastPos = uint32(pos);
        if (voice != 0) {
            b.voice = voice;
            b.voiceIndex = uint32(idx - 1);
            emit Voice(id, body, voice, uint32(idx - 1));
        }
    }

    /// @dev writes sample `idx` into the cached slot word, flushing when the slot changes
    function _put(uint256 id, uint8 body, uint256 slotKey, uint256 word, uint256 idx, uint256 p)
        private
        returns (uint256, uint256)
    {
        uint256 key = (uint256(body) << 32) | (idx >> 3);
        if (key != slotKey) {
            samples[id][slotKey] = word;
            slotKey = key;
            word = samples[id][key];
        }
        uint256 shift = 32 * (idx & 7);
        word = (word & ~(uint256(0xFFFFFFFF) << shift)) | (p << shift);
        return (slotKey, word);
    }

    // ================================================================ proofs

    /// @notice Prove that a Hollow-controlled body touched a living soul's body.
    function turn(uint256 id, uint32 epoch, uint8 victimBody, uint8 hollowBody, uint32 index) external {
        Night storage n = nights[id];
        _sync(id, n);
        if (_isOver(n)) revert NightOver();
        uint256 blk = _checkSample(id, n, epoch, index);
        uint256 ew = epochs[id][epoch];
        if (blk < ((ew >> 32) & type(uint64).max) + SHIFT_GRACE_BLOCKS) revert InvalidProof();
        if (blk < n.startBlock + START_GRACE_BLOCKS) revert InvalidProof();

        uint8 sv = uint8((ew >> (4 * victimBody)) & 0xF);
        uint8 sh = uint8((ew >> (4 * hollowBody)) & 0xF);
        if (victimBody == hollowBody) revert InvalidProof();
        Soul storage v = souls[id][sv];
        Soul storage h = souls[id][sh];
        if (h.hollowSince == 0 || h.hollowSince >= blk) revert InvalidProof();
        if (v.hollowSince != 0 || v.escapedRel != 0) revert InvalidProof();
        if (_dist2(_sampleAt(id, n, victimBody, index), _sampleAt(id, n, hollowBody, index)) > TURN_RADIUS_CM * TURN_RADIUS_CM) {
            revert InvalidProof();
        }

        v.hollowSince = uint64(blk);
        n.living -= 1;
        if (n.living == 0) n.endBlock = uint64(block.number);
        emit Turned(id, sv, sh, victimBody, uint64(blk));
    }

    /// @notice Prove that a living soul walked a body onto a fuse.
    function collectFuse(uint256 id, uint32 epoch, uint8 body, uint32 index, uint8 fuse) external {
        Night storage n = nights[id];
        _sync(id, n);
        if (_isOver(n)) revert NightOver();
        if (fuse > 2 || (n.fuses >> fuse) & 1 == 1) revert InvalidProof();
        uint256 blk = _checkSample(id, n, epoch, index);
        uint8 s = uint8((epochs[id][epoch] >> (4 * body)) & 0xF);
        if (!_livingAt(souls[id][s], blk)) revert InvalidProof();
        uint256 target = (objectives >> (32 * fuse)) & 0xFFFFFFFF;
        if (_dist2(_sampleAt(id, n, body, index), target) > OBJECTIVE_RADIUS_CM * OBJECTIVE_RADIUS_CM) {
            revert InvalidProof();
        }
        n.fuses |= uint8(1 << fuse);
        emit FuseCollected(id, fuse, s, uint64(blk));
        if (n.fuses == 7) {
            n.exitOpenBlock = uint64(block.number);
            emit ExitOpened(id, uint64(block.number));
        }
    }

    /// @notice Prove that a living soul reached the powered exit. The soul and the body it wore leave the night.
    function escape(uint256 id, uint32 epoch, uint8 body, uint32 index) external {
        Night storage n = nights[id];
        _sync(id, n);
        if (_isOver(n)) revert NightOver();
        if (n.exitOpenBlock == 0) revert InvalidProof();
        uint256 blk = _checkSample(id, n, epoch, index);
        if (blk < n.exitOpenBlock) revert InvalidProof();
        uint8 s = uint8((epochs[id][epoch] >> (4 * body)) & 0xF);
        Soul storage soul = souls[id][s];
        if (soul.hollowSince != 0 || soul.escapedRel != 0) revert InvalidProof();
        Body storage b = bodies[id][body];
        if (b.goneRel != 0) revert InvalidProof();
        uint256 target = (objectives >> 96) & 0xFFFFFFFF;
        if (_dist2(_sampleAt(id, n, body, index), target) > OBJECTIVE_RADIUS_CM * OBJECTIVE_RADIUS_CM) {
            revert InvalidProof();
        }
        uint32 rel = uint32(blk - n.startBlock);
        if (rel == 0) rel = 1;
        soul.escapedRel = rel;
        b.goneRel = rel;
        n.goneMask |= uint8(1 << body);
        n.escapedCount += 1;
        n.living -= 1;
        if (n.living == 0) n.endBlock = uint64(block.number);
        emit Escaped(id, s, body, uint64(blk));
    }

    // ================================================================ shops

    function itemPrice(uint8 item) public pure returns (uint256) {
        if (item == 0) return 0.004 ether; // battery
        if (item == 1) return 0.008 ether; // flare
        if (item == 2) return 0.006 ether; // music box
        if (item == 3) return 0.004 ether; // pills
        if (item == 4) return 0.01 ether; // adrenaline
        if (item == 5) return 0.02 ether; // polaroid
        revert NoItem();
    }

    function itemShop(uint8 item) public pure returns (uint256) {
        return item <= 2 ? 0 : item <= 4 ? 1 : 2;
    }

    /// @notice Buy an item into the pockets of the body you wear. Your recorded position at sample
    ///         `index` must be at the counter of the shop that sells it. The price goes to the pot.
    function buy(uint256 id, uint32 epoch, uint8 body, uint32 index, uint8 item) external payable {
        Night storage n = nights[id];
        _sync(id, n);
        if (_isOver(n)) revert NightOver();
        if (msg.value < itemPrice(item)) revert FeeTooLow();
        _checkSample(id, n, epoch, index);
        uint256 s = soulIndexPlus1[id][msg.sender];
        if (s == 0) revert NotASoul();
        s -= 1;
        if ((epochs[id][epoch] >> (4 * body)) & 0xF != s) revert NotYourBody();
        uint256 counter = (objectives >> (32 * (4 + itemShop(item)))) & 0xFFFFFFFF;
        if (_dist2(_sampleAt(id, n, body, index), counter) > SHOP_RADIUS_CM * SHOP_RADIUS_CM) revert NotAtShop();
        uint256 p = pockets[id][body];
        uint256 count = (p >> (16 * item)) & 0xFFFF;
        if (count >= MAX_ITEM_STACK) revert PocketsFull();
        pockets[id][body] = p + (uint256(1) << (16 * item));
        pot[id] += msg.value;
        emit Bought(id, body, uint8(s), item, msg.value);
    }

    /// @notice Use an item from the pockets of the body you wear right now.
    function use(uint256 id, uint8 body, uint8 item) external {
        Night storage n = nights[id];
        _sync(id, n);
        if (_isOver(n) || n.startBlock == 0 || block.number < n.startBlock) revert NightOver();
        if (item >= ITEM_COUNT) revert NoItem();
        uint256 s = soulIndexPlus1[id][msg.sender];
        if (s == 0) revert NotASoul();
        s -= 1;
        if ((epochs[id][n.epoch] >> (4 * body)) & 0xF != s) revert NotYourBody();
        uint256 p = pockets[id][body];
        if ((p >> (16 * item)) & 0xFFFF == 0) revert NoItem();
        pockets[id][body] = p - (uint256(1) << (16 * item));
        Body storage b = bodies[id][body];
        uint32 pos = b.nSamples == 0 ? uint32((spawns >> (32 * body)) & 0xFFFFFFFF) : b.lastPos;
        emit Used(id, body, uint8(s), item, pos, uint64(block.number));
    }

    function getPockets(uint256 id) external view returns (uint256[] memory out) {
        uint256 c = nights[id].nSouls;
        out = new uint256[](c);
        for (uint256 i = 0; i < c; i++) {
            out[i] = pockets[id][i];
        }
    }

    // ================================================================ watchers

    /// @notice Watchers pay to torment a running night. Every fee goes to the survivors' pot.
    /// @param kind 1 lights out around a body, 2 whisper at a body, 3 scream at a body, 4 force an early shift
    function torment(uint256 id, uint8 kind, uint8 body) external payable {
        Night storage n = nights[id];
        if (n.startBlock == 0 || block.number < n.startBlock) revert NotStarted();
        if (_isOver(n)) revert NightOver();
        if (kind == 0 || kind > TORMENT_FORCE_SHIFT || body >= n.nSouls) revert InvalidProof();
        uint256 fee = kind == TORMENT_FORCE_SHIFT ? TORMENT_FEE * FORCE_SHIFT_MULTIPLIER : TORMENT_FEE;
        if (msg.value < fee) revert FeeTooLow();
        _sync(id, n);
        if (kind == TORMENT_FORCE_SHIFT) {
            if (n.lastForcedShift != 0 && block.number < n.lastForcedShift + FORCE_SHIFT_COOLDOWN) revert Cooldown();
            n.lastForcedShift = uint64(block.number);
            uint256 soon = block.number + FORCE_SHIFT_DELAY;
            if (n.nextShift > soon) n.nextShift = uint64(soon);
        }
        pot[id] += msg.value;
        emit Torment(id, msg.sender, kind, body, uint64(block.number), msg.value);
    }

    /// @notice After the night, each escaped soul claims an equal share of the watchers' pot.
    function claimPot(uint256 id) external {
        Night storage n = nights[id];
        if (!_isOver(n)) revert NightOver();
        uint256 s = soulIndexPlus1[id][msg.sender];
        if (s == 0) revert NotASoul();
        s -= 1;
        if (souls[id][s].escapedRel == 0 || potClaimed[id][s] || n.escapedCount == 0) revert NothingToClaim();
        potClaimed[id][s] = true;
        uint256 share = pot[id] / n.escapedCount;
        emit PotClaimed(id, uint8(s), share);
        (bool ok,) = msg.sender.call{value: share}("");
        require(ok, "transfer failed");
    }

    /// @notice If nobody escaped, the pot haunts the next night instead.
    function rollOver(uint256 id, uint256 toNight) external {
        Night storage n = nights[id];
        if (!_isOver(n) || n.escapedCount != 0) revert NothingToClaim();
        if (toNight <= id || nights[toNight].host == address(0) || _isOver(nights[toNight])) revert InvalidProof();
        uint256 amount = pot[id];
        if (amount == 0) revert NothingToClaim();
        pot[id] = 0;
        pot[toNight] += amount;
        emit PotRolledOver(id, toNight, amount);
    }

    /// @notice Anyone can push pending shifts forward (clients do it automatically).
    function sync(uint256 id) external {
        _sync(id, nights[id]);
    }

    // ================================================================ internals

    function _checkSample(uint256 id, Night storage n, uint32 epoch, uint32 index) private view returns (uint256 blk) {
        if (n.startBlock == 0) revert NotStarted();
        blk = n.startBlock + uint256(index) * SAMPLE_BLOCKS;
        uint256 ew = epochs[id][epoch];
        uint256 eStart = (ew >> 32) & type(uint64).max;
        if (ew == 0 && epoch != 0) revert InvalidProof();
        if (blk < eStart) revert InvalidProof();
        if (epoch < n.epoch) {
            uint256 nextStart = (epochs[id][epoch + 1] >> 32) & type(uint64).max;
            if (blk >= nextStart) revert InvalidProof();
        } else if (epoch > n.epoch) {
            revert InvalidProof();
        }
    }

    function _livingAt(Soul storage s, uint256 blk) private view returns (bool) {
        return (s.hollowSince == 0 || s.hollowSince > blk) && s.escapedRel == 0;
    }

    /// @dev position of `body` at sample `index`: the last recorded sample at or before it, the
    ///      body's spawn if it never moved, or its last position once the index can no longer be written
    function _sampleAt(uint256 id, Night storage n, uint8 body, uint32 index) private view returns (uint256) {
        Body storage b = bodies[id][body];
        uint256 nS = b.nSamples;
        if (index >= nS) {
            if (n.startBlock + uint256(index) * SAMPLE_BLOCKS + LATE_BLOCKS >= block.number) revert InvalidProof();
            return nS == 0 ? (spawns >> (32 * body)) & 0xFFFFFFFF : b.lastPos;
        }
        uint256 i = index;
        uint256 slot = type(uint256).max;
        uint256 word;
        for (uint256 scanned = 0; scanned < MAX_SCAN; scanned++) {
            if ((i >> 3) != slot) {
                slot = i >> 3;
                word = samples[id][(uint256(body) << 32) | slot];
            }
            uint256 v = (word >> (32 * (i & 7))) & 0xFFFFFFFF;
            if (v != 0) return v;
            if (i == 0) return (spawns >> (32 * body)) & 0xFFFFFFFF;
            i--;
        }
        revert InvalidProof();
    }

    function _isOver(Night storage n) private view returns (bool) {
        return n.endBlock != 0 || (n.startBlock != 0 && block.number >= n.startBlock + NIGHT_BLOCKS);
    }

    /// @dev finds the epoch containing `blk`, walking back from the current epoch
    function _epochAt(uint256 id, uint256 current, uint256 blk) private view returns (uint256 e) {
        e = current;
        while (e > 0 && ((epochs[id][e] >> 32) & type(uint64).max) > blk) {
            e--;
        }
    }

    /// @dev applies every shift whose block has arrived
    function _sync(uint256 id, Night storage n) private {
        uint256 next = n.nextShift;
        if (n.startBlock == 0 || block.number < next || n.endBlock != 0) return;
        uint256 nightEnd = n.startBlock + NIGHT_BLOCKS;
        uint256 e = n.epoch;
        uint256 count = n.nSouls;
        for (uint256 guard = 0; guard < 16 && block.number >= next && next < nightEnd; guard++) {
            bytes32 bh = blockhash(next - 1);
            uint256 seed = uint256(keccak256(abi.encode(bh == bytes32(0) ? keccak256(abi.encode(id, e)) : bh, id, e)));
            uint256 prev = epochs[id][e];
            uint256 assign = prev & 0xFFFFFFFF;

            // bodies still in play, and the souls inside them
            uint256 gone = n.goneMask;
            uint256 mask;
            uint256[8] memory list;
            uint256 m;
            for (uint256 i = 0; i < count; i++) {
                if ((gone >> i) & 1 == 0) {
                    mask |= 1 << i;
                    list[m++] = i;
                }
            }
            // Sattolo's algorithm: a random single cycle, so every soul lands in a different body
            uint256[8] memory soulOf;
            for (uint256 k = 0; k < m; k++) {
                soulOf[k] = (assign >> (4 * list[k])) & 0xF;
            }
            for (uint256 k = m; k > 1; k--) {
                uint256 j = seed % (k - 1);
                (soulOf[k - 1], soulOf[j]) = (soulOf[j], soulOf[k - 1]);
                seed = uint256(keccak256(abi.encode(seed)));
            }
            uint256 nextAssign = assign;
            for (uint256 k = 0; k < m; k++) {
                uint256 sh = 4 * list[k];
                nextAssign = (nextAssign & ~(uint256(0xF) << sh)) | (soulOf[k] << sh);
            }
            e++;
            epochs[id][e] = _packEpoch(nextAssign, next, mask);
            emit Shifted(id, uint32(e), uint64(next));
            next = next + SHIFT_MIN + uint256(keccak256(abi.encode(seed, "next"))) % SHIFT_RANGE;
        }
        n.epoch = uint32(e);
        n.nextShift = uint64(next);
    }

    function _packEpoch(uint256 assign, uint256 startBlock, uint256 mask) private pure returns (uint256) {
        return assign | (startBlock << 32) | (mask << 96);
    }

    function _solid(uint256 x, uint256 y) private view returns (bool) {
        uint256 bit = (y / CELL_CM) * GRID + (x / CELL_CM);
        return (walls[bit >> 8] >> (bit & 255)) & 1 == 1;
    }

    function _dist2(uint256 a, uint256 b) private pure returns (uint256) {
        uint256 ax = a & 0xFFFF;
        uint256 ay = a >> 16;
        uint256 bx = b & 0xFFFF;
        uint256 by = b >> 16;
        uint256 dx = ax > bx ? ax - bx : bx - ax;
        uint256 dy = ay > by ? ay - by : by - ay;
        return dx * dx + dy * dy;
    }

    // ================================================================ views for clients

    function getWalls() external view returns (uint256[16] memory) {
        return walls;
    }

    function getSouls(uint256 id)
        external
        view
        returns (address[] memory addrs, bytes16[] memory soulNames, uint64[] memory hollowSince, uint32[] memory escapedRel)
    {
        uint256 c = nights[id].nSouls;
        addrs = new address[](c);
        soulNames = new bytes16[](c);
        hollowSince = new uint64[](c);
        escapedRel = new uint32[](c);
        for (uint256 i = 0; i < c; i++) {
            Soul storage s = souls[id][i];
            addrs[i] = s.addr;
            soulNames[i] = names[s.addr];
            hollowSince[i] = s.hollowSince;
            escapedRel[i] = s.escapedRel;
        }
    }

    /// @notice One call per poll: night header, current epoch word, every body's tail samples.
    function snapshot(uint256 id, uint256 tail)
        external
        view
        returns (Night memory night, uint256 epochWord, uint256 blockNumber, Body[] memory bodyList, uint256[] memory tails)
    {
        night = nights[id];
        epochWord = epochs[id][night.epoch];
        blockNumber = block.number;
        uint256 c = night.nSouls;
        bodyList = new Body[](c);
        if (tail > 32) tail = 32;
        tails = new uint256[](c * tail);
        for (uint256 i = 0; i < c; i++) {
            Body storage b = bodies[id][i];
            bodyList[i] = b;
            uint256 nS = b.nSamples;
            for (uint256 t = 0; t < tail && t < nS; t++) {
                uint256 index = nS - 1 - t;
                uint256 word = samples[id][(i << 32) | (index >> 3)];
                tails[i * tail + t] = (index << 32) | ((word >> (32 * (index & 7))) & 0xFFFFFFFF);
            }
        }
    }

    /// @notice Epoch words from `from` up to the current epoch (inclusive).
    function getEpochs(uint256 id, uint256 from) external view returns (uint256[] memory out) {
        uint256 cur = nights[id].epoch;
        if (from > cur) return new uint256[](0);
        out = new uint256[](cur - from + 1);
        for (uint256 e = from; e <= cur; e++) {
            out[e - from] = epochs[id][e];
        }
    }

    /// @notice Raw packed sample slots for replays.
    function getSampleSlots(uint256 id, uint8 body, uint256 fromSlot, uint256 count) external view returns (uint256[] memory out) {
        out = new uint256[](count);
        for (uint256 k = 0; k < count; k++) {
            out[k] = samples[id][(uint256(body) << 32) | (fromSlot + k)];
        }
    }
}
