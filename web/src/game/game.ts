import * as THREE from 'three';
import { NET, SAMPLE_BLOCKS, VOICE_LABELS, VOICES, type Hex } from '../config';
import { NightState, Pilot, objective, short, spawnOf, unpack } from '../chain/night';
import type { Burner } from '../chain/wallet';
import { Hud } from '../ui/hud';
import { Audio } from './audio';
import { Figure, SKINS, SUITS } from './figures';
import { Fx } from './fx';
import { Player } from './player';
import { Psych } from './psych';
import { World, openYaw, CELL } from './world';
import { Town } from './town';
import { loadEnvironment } from './assets';

export type Mode = 'play' | 'watch' | 'replay';

const QUALITY = new URLSearchParams(location.search).get('quality') ?? 'auto';

const cmToM = (v: number) => v / 100;

/** ?norender=1: run the whole game and chain loop without drawing (headless soak tests) */
const NO_RENDER = new URLSearchParams(location.search).has('norender');

/** One night in the Archive, from the inside (play) or through the bodycams (watch). */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly world: World;
  readonly player: Player;
  readonly fx: Fx;
  readonly audio: Audio;
  readonly psych: Psych;
  readonly hud: Hud;
  night: NightState | null = null;
  pilot: Pilot | null = null;
  mode: Mode = 'play';
  mySoul = -1;
  readonly figures: Figure[] = [];
  readonly town: Town;
  private last = performance.now();
  private pollAt = 0;
  private lastPulse = 0;
  private voiceQueued = 0;
  private lastVoiceIdx: number[] = [];
  private turnedSeen = new Set<number>();
  private fusesSeen = 0;
  private exitSeen = false;
  private wasHollow = false;
  private dead = false;
  private escaped = false;
  private over = false;
  private claimed = new Set<string>();
  private watchBody = 0;
  private watchCam: THREE.PerspectiveCamera;
  private jumpscare: { fig: Figure; t: number } | null = null;
  private proofAge = new Map<string, number>();
  private heartbeatAt = 0;
  private started = false;
  private introDone = false;
  private shiftWarned = 0;
  private countingDown = false;
  private originalLost = false;
  private pixelRatio = 1;
  private frameTimes: number[] = [];
  private torchSpots: THREE.SpotLight[] = [];
  /** replay director: when the camera may cut next, and the soul last seen in the watched body */
  private cutAt = 0;
  private camSoul = -1;
  private pinnedCam = (() => {
    const c = new URLSearchParams(location.search).get('cam');
    return c ? Number(c) - 1 : -1;
  })();
  onOver?: (summary: { escaped: boolean; hollow: boolean; txs: { hash: Hex; fn: string }[]; night: NightState }) => void;

  constructor(private canvas: HTMLCanvasElement, readonly wallet: Burner) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.pixelRatio = QUALITY === 'low' ? 0.6 : Math.min(devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = QUALITY !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    addEventListener('resize', () => this.renderer.setSize(innerWidth, innerHeight));

    this.scene.background = new THREE.Color(0x020202);
    this.scene.fog = new THREE.FogExp2(0x06080b, 0.055);
    this.scene.add(new THREE.AmbientLight(0x1c2230, 0.32));
    this.scene.add(new THREE.HemisphereLight(0x2a3448, 0x050403, 0.28));
    void loadEnvironment(this.renderer, this.scene);

    this.world = new World(this.scene);
    this.player = new Player(this.scene, canvas);
    this.audio = new Audio(this.scene);
    this.player.camera.add(this.audio.listener);
    this.fx = new Fx(this.renderer, this.scene, this.player.camera);
    this.psych = new Psych(this.scene, this.player, this.world, this.audio, this.fx);
    this.hud = new Hud();
    this.town = new Town(this);
    this.world.onThunder = () => this.audio.thunder();
    this.watchCam = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 80);
    addEventListener('resize', () => {
      this.watchCam.aspect = innerWidth / innerHeight;
      this.watchCam.updateProjectionMatrix();
    });

    this.player.onStep = (sprint) => this.audio.step(new THREE.Vector3(this.player.position.x, 0.1, this.player.position.z), sprint);
    this.player.onFlashlight = (on) => {
      void this.audio.play('flashlight_click.mp3', 0.6);
      this.hud.flash(on ? '' : 'TORCH OFF');
    };
    this.player.onVoice = (id) => {
      if (this.mode !== 'play' || !this.pilot) return;
      this.voiceQueued = id;
      this.audio.voiceAt(VOICES[id], new THREE.Vector3(this.player.position.x, 1.6, this.player.position.z));
      this.hud.subtitle(`you: “${VOICE_LABELS[id].toLowerCase()}”`);
    };
    this.psych.onFakeShift = () => this.hud.scrambleCam(1800);
    wallet.onSent = (tx) => this.hud.tx(tx.hash, tx.fn);

    // two shared torch lights for the nearest figures (constant light count = no shader recompiles)
    for (let i = 0; i < 2; i++) {
      const sp = new THREE.SpotLight(0xfff1d6, 0, 14, 0.5, 0.6, 1.8);
      this.scene.add(sp, sp.target);
      this.torchSpots.push(sp);
    }
    if (QUALITY === 'low') this.fx.bloom.intensity = 0;

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /** explore Halden with no night running (dev tool + attract mode) */
  roaming = false;
  roam(cell: number[] = [31, 31]) {
    this.roaming = true;
    this.hud.show('play');
    this.player.enabled = true;
    this.player.teleport((cell[0] + 0.5) * CELL, (cell[1] + 0.5) * CELL, openYaw(cell));
  }

  // ------------------------------------------------------------------ entering
  async enter(night: NightState, mode: Mode, soul: number) {
    this.night = night;
    this.mode = mode;
    this.mySoul = soul;
    night.onShiftVerified = (e, ok, at) =>
      this.hud.feed(ok ? `SWAP #${e} VERIFIED · hash of block ${at - 1} → same bodies as the chain` : `SWAP #${e} MISMATCH · the chain's word is final`);
    this.pilot = mode === 'play' && soul >= 0 ? new Pilot(night, this.wallet, soul) : null;
    if (this.pilot) {
      const pilot = this.pilot;
      const timer = setInterval(() => (this.pilot === pilot ? pilot.pump() : clearInterval(timer)), 250);
    }
    night.onTorment = (t) => this.onTorment(t);
    night.onUsed = (u) => this.town.onUsed(u);
    await this.audio.start();
    this.hud.show(mode);
    this.player.enabled = mode === 'play';
    // replays are seen through the bodycams themselves: the player's camera, hands and torch
    this.fx.setCamera(mode === 'watch' ? this.watchCam : this.player.camera);
    if (mode === 'watch') this.watchCam.add(this.audio.listener);
    const spawn = unpack(spawnOf(Math.max(soul, 0)));
    const sx = cmToM(spawn.x), sz = cmToM(spawn.y);
    this.player.teleport(sx, sz, openYaw([Math.floor(sx / CELL), Math.floor(sz / CELL)]));
    this.hud.showControls(25000);
    this.player.wear(SUITS[Math.max(soul, 0) % 8], SKINS[Math.max(soul, 0) % 8]);
    this.started = true;
  }

  // ------------------------------------------------------------------ loop
  private loop(now: number) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.adapt(now - this.last);
    this.last = now;
    const n = this.night;
    if (n && now > this.pollAt) {
      this.pollAt = now + Math.max(220, n.msPerBlock * 0.9);
      void n.poll().then(() => this.afterPoll(now)).catch(() => undefined);
    }
    if (n && this.started) this.step(now, dt, n);
    if (n && this.started && this.mode === 'replay') this.replayCam(now, dt, n);
    else if (this.roaming) {
      // the film harness can drive the camera along a scripted path
      const tour = (window as unknown as { __tour?: (now: number, dt: number, p: Player) => void }).__tour;
      if (tour) tour(now, dt, this.player);
      else this.player.update(dt);
      this.town.update(now, dt);
      this.psych.update(now, dt, 99, false, true);
    } else this.idleCamera(now);
    this.world.update(now, dt, this.mode === 'watch' ? this.watchCam.position : this.player.yawObj.position, 1 - this.psych.sanity);
    this.fx.update(now, dt);
    if (!NO_RENDER) this.fx.render(dt);
    this.town.capture(this.canvas);
  }

  /** keep the frame rate up: drop resolution, then shadows, if frames are slow */
  private adapt(ms: number) {
    if (QUALITY !== 'auto') return;
    this.frameTimes.push(ms);
    if (this.frameTimes.length < 120) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 36 && this.pixelRatio > 0.55) {
      this.pixelRatio = Math.max(0.5, this.pixelRatio - 0.15);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.fx.composer.setSize(innerWidth, innerHeight);
    } else if (avg > 36 && this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
    } else if (avg < 14 && this.pixelRatio < Math.min(devicePixelRatio, 1.5)) {
      this.pixelRatio = Math.min(Math.min(devicePixelRatio, 1.5), this.pixelRatio + 0.1);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.fx.composer.setSize(innerWidth, innerHeight);
    }
  }

  private idleCamera(now: number) {
    // title screen: a slow drift down an empty corridor
    const t = now / 1000;
    const s = unpack(spawnOf(0));
    this.player.teleport(cmToM(s.x) + Math.sin(t * 0.05) * 0.5, cmToM(s.y) + Math.cos(t * 0.04) * 0.5);
    this.player.yawObj.rotation.y = t * 0.03;
    this.player.update(0.016);
  }

  private step(now: number, dt: number, n: NightState) {
    const h = n.header;
    if (!h) return;
    const est = n.estBlock(now);
    const phase = n.phase(now);

    // the building breathes with every Monad block
    if (Math.floor(est) > this.lastPulse) {
      this.lastPulse = Math.floor(est);
      this.world.pulse(0.6);
      this.hud.block(this.lastPulse);
    }

    if (phase === 'countdown') {
      const secs = Math.max(0, ((h.startBlock - est) * n.msPerBlock) / 1000);
      this.countingDown = true;
      this.hud.center(`THE LIGHTS GO OUT IN ${secs.toFixed(1)}`, 'Check your hands when you wake up.');
      if (!this.introDone) {
        this.introDone = true;
        void this.audio.play('voice_intro.mp3', 0.9);
      }
    } else if (phase === 'night' && this.countingDown) {
      // clear the countdown once; later messages (touched, hollow, got out) must stay up
      this.countingDown = false;
      this.hud.center('');
    }

    const myBody = this.pilot?.body ?? -1;
    const soul = this.mySoul;
    const hollow = soul >= 0 && n.isHollowAt(soul, est);

    if (this.mode === 'play' && this.pilot && phase === 'night' && !this.escaped) {
      const pos = { x: this.player.position.x * 100, y: this.player.position.z * 100 };
      const changed = this.pilot.tick(now, pos, this.voiceQueued);
      this.voiceQueued = 0;
      if (changed) this.onSwap(n, this.pilot.body, est);
      else if (this.pilot.pull) {
        // the chain did not accept where this body went: it is where the chain says it is
        const to = this.pilot.pull;
        const far = Math.hypot(to.x / 100 - this.player.position.x, to.y / 100 - this.player.position.z) > 1.5;
        this.player.teleport(to.x / 100, to.y / 100);
        if (far) {
          this.fx.staticBurst = Math.max(this.fx.staticBurst, 0.6);
          this.hud.feed('SIGNAL DRIFT · RESYNCED TO CHAIN');
        }
      }
      this.pilot.pull = null;
      this.player.update(dt, { speedScale: (hollow ? 1.08 : 1) * this.town.speedScale });
      if (hollow || this.town.infiniteStamina) this.player.stamina = 1;
    } else if (this.mode === 'play') {
      this.player.update(dt);
    }

    // render every other body
    const renderIdx = n.indexAtBlock(est) - 1.2;
    let nearest = 99;
    const torchCandidates: { f: Figure; d: number }[] = [];
    while (this.figures.length < h.nSouls) {
      const b = this.figures.length;
      const owner = n.souls[b];
      const f = new Figure(b, owner?.name ?? `worker ${b + 1}`, true);
      this.scene.add(f.root);
      this.figures.push(f);
      this.lastVoiceIdx.push(-1);
    }
    for (let b = 0; b < this.figures.length; b++) {
      const f = this.figures[b];
      const isMe = (this.mode === 'play' && b === myBody && !this.escaped) || (this.mode === 'replay' && b === this.watchBody);
      const gone = n.bodyGone(b);
      f.root.visible = !isMe && !gone && phase !== 'lobby';
      if (!f.root.visible) continue;
      const rp = n.renderPosition(b, renderIdx);
      const perSec = 1000 / (n.msPerBlock * SAMPLE_BLOCKS);
      f.update(now, dt, cmToM(rp.x), cmToM(rp.y), (cmToM(rp.vx) * perSec), (cmToM(rp.vy) * perSec));
      const d = f.root.position.distanceTo(new THREE.Vector3(this.player.position.x, 0, this.player.position.z));
      nearest = Math.min(nearest, d);
      f.setTorch(true);
      torchCandidates.push({ f, d });
      // voice lines spoken from this body
      const body = n.bodies[b];
      if (body && body.voice && body.voiceIndex !== this.lastVoiceIdx[b]) {
        if (this.lastVoiceIdx[b] !== -1 || body.voiceIndex > renderIdx - 30) {
          this.audio.voiceAt(VOICES[body.voice], f.root.position.clone().setY(1.6));
          if (d < 25) this.hud.subtitle(`someone: “${VOICE_LABELS[body.voice].toLowerCase()}”`);
        }
        this.lastVoiceIdx[b] = body.voiceIndex;
      }
      // the Hollow hears the living: their heartbeats, through the walls
      if (hollow && this.mode === 'play' && now > this.heartbeatAt && d < 14) {
        const s = n.soulInBody(b, est);
        if (n.isLivingAt(s, est)) {
          this.heartbeatAt = now + 1100;
          void this.audio.playAt('heartbeat_fast_loop.mp3', f.root.position.clone().setY(1.2), 0.6, 1.5);
        }
      }
    }

    torchCandidates.sort((a, b) => a.d - b.d);
    this.torchSpots.forEach((sp, i) => {
      const c = torchCandidates[i];
      if (!c || c.d > 16) {
        sp.intensity = 0;
        return;
      }
      const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), c.f.heading);
      const tp = new THREE.Vector3();
      const td = new THREE.Vector3();
      if (c.f.torchRay(tp, td)) {
        sp.position.copy(tp);
        sp.target.position.copy(tp).addScaledVector(td, 4);
      } else {
        sp.position.copy(c.f.root.position).add(new THREE.Vector3(0, 1.25, 0)).addScaledVector(fwd, 0.3);
        sp.target.position.copy(sp.position).addScaledVector(fwd, 4).setY(0.6);
      }
      sp.intensity = 14;
    });

    if (this.mode === 'watch') this.updateWatchCam(n, dt);

    // psychology
    this.psych.names = n.souls.filter((_, i) => i !== soul).map((s) => s.name);
    this.psych.update(now, dt, nearest, hollow, this.town.visionsSuppressed);
    this.town.update(now, dt);
    this.fx.hollow += ((hollow ? 1 : 0) - this.fx.hollow) * Math.min(1, dt * 2);

    // jumpscare animation
    if (this.jumpscare) {
      const js = this.jumpscare;
      js.t += dt;
      const cam = this.player.camera;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
      const eye = cam.getWorldPosition(new THREE.Vector3());
      const dist = Math.max(0.25, 2.2 - js.t * 6);
      const at = eye.clone().addScaledVector(fwd, dist);
      js.fig.heading = Math.atan2(fwd.x, fwd.z);
      js.fig.update(now, dt, at.x, at.z, 0, 0);
      js.fig.root.position.y = eye.y - 1.65;
      js.fig.root.rotation.y = js.fig.heading;
      if (js.t > 1.1) {
        this.scene.remove(js.fig.root);
        this.jumpscare = null;
      }
    }

    // hud
    this.hud.update({
      now,
      est,
      night: n,
      mode: this.mode,
      myBody,
      soul,
      hollow,
      player: this.player,
      psych: this.psych,
      pilot: this.pilot,
      watchBody: this.watchBody,
      watchers: n.watcherAddrs.size,
    });

    // shift warning hum a few seconds before (felt, never shown)
    const ns = n.nextShiftBlock();
    if (ns && est > ns - 12 && this.shiftWarned !== ns && phase === 'night') {
      this.shiftWarned = ns;
      void this.audio.play('flashlight_flicker.mp3', 0.7, 0.7);
      this.player.shake = 0.4;
    }

    if (phase === 'over' && !this.over) this.finish(n);
  }

  private syncSentFor = 0;

  private afterPoll(now: number) {
    const n = this.night;
    if (!n || !n.header || !n.header.startBlock) return;
    const est = n.estBlock(now);
    // keeper: materialize a due shift so nobody's move has to pay for it
    const due = n.header.nextShift;
    if (due && n.chainBlock >= due + 1 && this.syncSentFor !== due && !n.header.endBlock && this.mode === 'play') {
      this.syncSentFor = due;
      const delay = Math.max(0, this.mySoul) * 700;
      setTimeout(() => {
        if (n.header && n.header.nextShift === due) void this.wallet.call('sync', [n.id]);
      }, delay);
    }
    // turned souls
    n.souls.forEach((s, i) => {
      if (s.hollowSince && s.hollowSince > n.header!.startBlock && !this.turnedSeen.has(i)) {
        this.turnedSeen.add(i);
        if (i === this.mySoul) this.onTurned(n, est);
        else if (this.mode === 'replay' && n.soulInBody(this.watchBody, est) === i) this.replayTouched(n, i, s.hollowSince);
        else {
          void this.audio.play('scream_turned.mp3', 0.35, 0.85);
          this.hud.feed(`someone stopped screaming.`);
          // was it the person wearing my original body?
          if (this.mode === 'play' && n.bodyOfSoul(i, s.hollowSince) === this.mySoul) {
            this.originalLost = true;
            this.hud.originalLost();
          }
        }
      }
    });
    // fuses & exit
    const fuses = n.header.fuses;
    for (let f = 0; f < 3; f++) {
      const bit = 1 << f;
      if (fuses & bit && !(this.fusesSeen & bit)) {
        this.world.setFuse(f, true);
        void this.audio.playAt('fuse_pickup.mp3', this.world.fuseBoxes[f].group.position.clone().setY(1.3), 1.2, 6);
        this.hud.feed(`a fuse clicked into place (${countBits(fuses)}/3)`);
      }
    }
    this.fusesSeen = fuses;
    if (n.header.exitOpenBlock && !this.exitSeen) {
      this.exitSeen = true;
      this.world.setExitOpen(true);
      void this.audio.play('exit_power.mp3', 1);
      void this.audio.playAt('door_open.mp3', this.world.exitDoor.position, 1.5, 8);
      this.hud.feed('THE EXIT HAS POWER');
    }
    if (this.mySoul >= 0 && n.souls[this.mySoul]?.escapedRel && !this.escaped) {
      this.escaped = true;
      this.hud.center('YOU GOT OUT', `…in ${n.souls[n.soulInBody(this.pilot?.body ?? 0, est)]?.name ?? 'someone'}'s body. They are still in there.`);
    }
    this.prove(n, now);
  }

  /** submit every proof we can see: touches, fuses, escapes */
  private prove(n: NightState, now: number) {
    if (this.mode !== 'play' && this.mode !== 'watch') return; // replays never write to the chain
    for (const p of n.findTurns()) {
      const key = `t${p.victimSoul}`;
      const involved = p.victimSoul === this.mySoul || p.hollowSoul === this.mySoul;
      const first = this.proofAge.get(key) ?? now;
      this.proofAge.set(key, first);
      if (!involved && now - first < 2500) continue;
      n.markProven(p.victimSoul);
      void this.wallet.call('turn', [n.id, p.epoch, p.victim, p.hollow, p.index]);
    }
    const body = this.pilot?.body ?? -1;
    if (body < 0 || this.mySoul < 0 || !n.isLivingAt(this.mySoul, n.chainBlock)) return;
    const e = n.epochAt(n.chainBlock);
    const h = n.header!;
    for (let f = 0; f < 3; f++) {
      if (h.fuses & (1 << f) || this.claimed.has(`f${f}`)) continue;
      const idx = n.findObjective(body, f);
      if (idx !== null && e) {
        this.claimed.add(`f${f}`);
        void this.wallet.call('collectFuse', [n.id, n.epochAt(n.blockOfIndex(idx))!.index, body, idx, f]);
        setTimeout(() => this.claimed.delete(`f${f}`), 6000);
      }
    }
    if (h.exitOpenBlock && !this.claimed.has('exit')) {
      const idx = n.findObjective(body, 3, h.exitOpenBlock);
      if (idx !== null) {
        this.claimed.add('exit');
        void this.wallet.call('escape', [n.id, n.epochAt(n.blockOfIndex(idx))!.index, body, idx]);
        setTimeout(() => this.claimed.delete('exit'), 6000);
      }
    }
  }

  // ------------------------------------------------------------------ moments
  private onSwap(n: NightState, body: number, est: number) {
    this.fx.swap();
    this.audio.shift();
    this.audio.duck(1.2);
    this.player.shake = 1.4;
    this.psych.hit(0.12);
    const rp = n.renderPosition(body, n.indexAtBlock(est));
    // wake up facing somewhere you didn't choose
    this.player.teleport(cmToM(rp.x), cmToM(rp.y), openYaw([Math.floor(cmToM(rp.x) / CELL), Math.floor(cmToM(rp.y) / CELL)]) + (Math.random() - 0.5) * 1.2);
    this.player.pitchObj.rotation.x = 0;
    this.player.wear(SUITS[body % 8], SKINS[body % 8]);
    this.hud.scrambleCam(2600);
    this.hud.feed('SIGNAL REACQUIRED');
  }

  private onTurned(n: NightState, est: number) {
    if (this.dead) return;
    this.dead = true;
    this.wasHollow = true;
    // the thing that touched you comes right at the lens
    const fig = new Figure((this.pilot?.body ?? 0 + 3) % 8, '', true);
    fig.setTorch(false);
    this.scene.add(fig.root);
    this.jumpscare = { fig, t: 0 };
    setTimeout(() => fig.reach(), 30);
    void this.audio.play('jumpscare_sting.mp3', 1);
    void this.audio.play('scream_turned.mp3', 0.8);
    this.fx.staticBurst = 0.55;
    this.fx.tearBurst = 1;
    this.player.shake = 2.5;
    this.audio.duck(2.2);
    setTimeout(() => {
      this.hud.center('YOU WERE TOUCHED', `block #${Math.floor(est).toLocaleString()} — recorded forever`);
      void this.audio.play('voice_turned.mp3', 1);
    }, 1200);
    setTimeout(() => this.hud.center('NOW YOU ARE HOLLOW', 'Wear them. Touch the living. Nobody can tell.'), 4200);
    setTimeout(() => this.hud.center(''), 8000);
  }

  private onTorment(t: { watcher: Hex; kind: number; body: number }) {
    const n = this.night;
    if (!n) return;
    const myBody = this.pilot?.body ?? this.watchBody;
    const mine = t.body === myBody;
    const who = short(t.watcher);
    const fig = this.figures[t.body];
    const at = mine || !fig ? this.player.yawObj.position.clone() : fig.root.position.clone();
    if (t.kind === 1) {
      this.world.blackout(at, 9, performance.now());
      void this.audio.play('flashlight_flicker.mp3', 0.9);
      if (mine) this.hud.feed(`${who} paid 0.01 MON to blind you`);
    } else if (t.kind === 2) {
      this.audio.whisper(at.clone().add(new THREE.Vector3(0.4, 0, 0.4)));
      if (mine) {
        this.hud.feed(`${who} paid to whisper to you`);
        this.psych.hit(0.1);
      }
    } else if (t.kind === 3) {
      void this.audio.playAt('jumpscare_sting.mp3', at.clone().add(new THREE.Vector3(1, 0, 1)), mine ? 1.2 : 0.5, 3);
      if (mine) {
        this.player.shake = 1.2;
        this.fx.staticBurst = 0.6;
        this.psych.hit(0.15);
        this.hud.feed(`${who} paid to make you scream`);
      }
    } else if (t.kind === 4) {
      this.hud.feed(`${who} paid to break the night early`);
    }
  }

  private finish(n: NightState) {
    this.over = true;
    this.player.enabled = false;
    document.exitPointerLock?.();
    const txs = this.wallet.sent.map((s) => ({ hash: s.hash, fn: s.fn }));
    this.onOver?.({ escaped: this.escaped, hollow: this.wasHollow, txs, night: n });
  }

  // ------------------------------------------------------------------ watch mode
  cycleWatch(dir: number) {
    const n = this.night;
    if (!n?.header) return;
    const count = n.header.nSouls;
    for (let k = 1; k <= count; k++) {
      const b = (this.watchBody + dir * k + count * 4) % count;
      if (!n.bodyGone(b)) {
        this.watchBody = b;
        this.fx.swap();
        void this.audio.play('static_burst.mp3', 0.4);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ replay
  /** the soul wearing the body this camera is strapped to was touched: the footage shows it */
  private replayTouched(n: NightState, soul: number, atBlock: number) {
    const name = n.souls[soul]?.name ?? 'someone';
    const fig = new Figure((this.watchBody + 3) % 8, '', true);
    fig.setTorch(false);
    this.scene.add(fig.root);
    this.jumpscare = { fig, t: 0 };
    setTimeout(() => fig.reach(), 30);
    void this.audio.play('jumpscare_sting.mp3', 1);
    void this.audio.play('scream_turned.mp3', 0.8);
    this.fx.staticBurst = 0.55;
    this.fx.tearBurst = 1;
    this.player.shake = 2.5;
    this.audio.duck(2.2);
    setTimeout(() => this.hud.center(`${name.toUpperCase()} WAS TOUCHED`, `block #${atBlock.toLocaleString('en-US')} — proven onchain`), 1200);
    setTimeout(() => this.hud.center(`${name.toUpperCase()} IS HOLLOW NOW`, 'and still wearing this body'), 4200);
    setTimeout(() => this.hud.center(''), 7500);
  }

  /**
   * The director: watch through the bodycam of whoever is closest to a Hollow (or of the Hollow
   * closing in), cut when someone else gets closer, and never hold a shot too long.
   */
  private replayCam(now: number, dt: number, n: NightState) {
    const h = n.header;
    if (!h) return;
    const est = n.estBlock(now);
    const idx = n.indexAtBlock(est) - 1.2;
    const count = h.nSouls;
    const pos = (b: number) => n.renderPosition(b, idx);
    if (this.pinnedCam >= 0 && this.pinnedCam < count) this.watchBody = this.pinnedCam;
    else if (now > this.cutAt || n.bodyGone(this.watchBody)) {
      let best = -1;
      let bestD = Infinity;
      let hunter = -1;
      for (let a = 0; a < count; a++) {
        if (n.bodyGone(a) || !n.isHollowAt(n.soulInBody(a, est), est)) continue;
        for (let b = 0; b < count; b++) {
          if (b === a || n.bodyGone(b) || !n.isLivingAt(n.soulInBody(b, est), est)) continue;
          const pa = pos(a), pb = pos(b);
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (d < bestD) [bestD, best, hunter] = [d, b, a];
        }
      }
      let next = best;
      if (best < 0 || bestD > 4000) {
        // nobody close: wander between the living
        const alive = [...Array(count).keys()].filter((b) => !n.bodyGone(b));
        next = alive[Math.floor(Math.random() * alive.length)] ?? 0;
      } else if (hunter >= 0 && Math.random() < 0.3) next = hunter; // sometimes, the thing hunting
      if (next !== this.watchBody) {
        this.watchBody = next;
        this.fx.swap();
        this.fx.staticBurst = Math.max(this.fx.staticBurst, 0.5);
        void this.audio.play('static_burst.mp3', 0.35);
        this.camSoul = -1;
      }
      this.cutAt = now + (bestD < 1500 ? 7000 : 10000) + Math.random() * 4000;
    }
    const rp = n.renderPosition(this.watchBody, idx);
    const perSec = 1000 / (n.msPerBlock * SAMPLE_BLOCKS);
    this.player.puppet(dt, cmToM(rp.x), cmToM(rp.y), cmToM(rp.vx) * perSec, cmToM(rp.vy) * perSec);
    const soul = n.soulInBody(this.watchBody, est);
    if (soul !== this.camSoul) {
      if (this.camSoul !== -1) {
        // the body this camera is strapped to was just taken over by someone else
        this.fx.swap();
        this.player.shake = 1.2;
        void this.audio.play('glitch_shift.mp3', 0.7);
        this.hud.scrambleCam(1600);
      }
      this.camSoul = soul;
      const owner = n.souls[this.watchBody]?.name ?? `worker ${this.watchBody + 1}`;
      const inside = n.souls[soul]?.name ?? '??';
      this.hud.feed(soul === this.watchBody ? `CAM ${String(this.watchBody + 1).padStart(2, '0')} · ${owner}` : `CAM ${String(this.watchBody + 1).padStart(2, '0')} · ${owner}'s body · worn by ${inside}`);
      this.player.wear(SUITS[this.watchBody % 8], SKINS[this.watchBody % 8]);
    }
  }

  setWatch(b: number) {
    this.watchBody = b;
    this.fx.swap();
  }

  private updateWatchCam(n: NightState, dt: number) {
    const f = this.figures[this.watchBody];
    if (!f) return;
    const behind = new THREE.Vector3(0, 0, 1.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.heading);
    const target = f.root.position.clone().add(behind).setY(1.95);
    // keep the camera out of walls
    this.watchCam.position.lerp(target, Math.min(1, dt * 4));
    const look = f.root.position.clone().add(new THREE.Vector3(0, 1.45, 0)).add(new THREE.Vector3(0, 0, -2).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.heading));
    this.watchCam.lookAt(look);
    this.player.position.copy(f.root.position);
  }

  torment(kind: number, price: bigint) {
    const n = this.night;
    if (!n) return;
    void this.wallet.call('torment', [n.id, kind, this.watchBody], { value: price });
    void this.audio.play('ui_click.mp3', 0.6);
  }

  get watching() {
    return this.watchBody;
  }

  objectiveTarget(): THREE.Vector3 {
    const o = unpack(objective(3));
    return new THREE.Vector3(cmToM(o.x), 0, cmToM(o.y));
  }
}

function countBits(v: number) {
  let c = 0;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
}

export { NET };
