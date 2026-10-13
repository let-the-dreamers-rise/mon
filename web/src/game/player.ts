import * as THREE from 'three';
import { flashlightCookie } from './textures';
import { BODY_RADIUS as RADIUS, HEIGHT, isSolidAt, slideOffProps } from './world';

const WALK = 2.3;
const SPRINT = 4.3;

/** How a body carries you. A swap changes all of it: your height, your pace, your nerve. */
export interface Physique {
  eye: number;
  pace: number;
  limp: number;
  tremor: number;
  lungs: number;
  tag: string;
  feel: string;
}
export const PHYSIQUES: Physique[] = [
  { eye: 1.62, pace: 1.0, limp: 0, tremor: 0, lungs: 1, tag: '1.71 m · STEADY', feel: 'Average height. Steady hands. Somebody kept this body in shape.' },
  { eye: 1.74, pace: 1.04, limp: 0, tremor: 0.7, lungs: 1, tag: '1.83 m · SHAKING HANDS', feel: 'Taller. The ground is further away. Your hands will not stop shaking.' },
  { eye: 1.49, pace: 0.9, limp: 0.85, tremor: 0, lungs: 1, tag: '1.58 m · BAD KNEE', feel: 'Shorter. The left knee does not bend the way yours did.' },
  { eye: 1.66, pace: 0.98, limp: 0, tremor: 0.15, lungs: 0.55, tag: '1.75 m · WEAK LUNGS', feel: 'Your chest is tight. This body cannot run for long.' },
  { eye: 1.8, pace: 1.1, limp: 0, tremor: 0, lungs: 1.3, tag: '1.89 m · RUNNER', feel: 'Tall. Long legs. This body was made to run.' },
  { eye: 1.55, pace: 0.95, limp: 0, tremor: 0.45, lungs: 0.85, tag: '1.64 m · NUMB FINGERS', feel: 'Small and cold. You can barely feel the torch in your hand.' },
  { eye: 1.68, pace: 0.88, limp: 0.45, tremor: 0.25, lungs: 0.8, tag: '1.77 m · BAD HIP', feel: 'Heavy. Your back aches and your hip clicks with every step.' },
  { eye: 1.59, pace: 1.04, limp: 0, tremor: 0, lungs: 1.2, tag: '1.68 m · YOUNG', feel: 'Light on your feet. Young. Whoever this was, they were young.' },
];

/** First-person bodycam controller: pointer-lock look, WASD, sprint stamina, flashlight. */
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly yawObj = new THREE.Object3D();
  readonly pitchObj = new THREE.Object3D();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly flashlight: THREE.SpotLight;
  private keys = new Set<string>();
  stamina = 1;
  battery = 1;
  flashlightOn = true;
  sprinting = false;
  moving = false;
  enabled = false;
  private bob = 0;
  private stepAcc = 0;
  onStep?: (sprint: boolean) => void;
  onFlashlight?: (on: boolean) => void;
  onVoice?: (id: number) => void;
  hands: THREE.Group;
  private sleeveMat: THREE.MeshStandardMaterial;
  private bandMat: THREE.MeshStandardMaterial;
  shake = 0;
  physique: Physique = PHYSIQUES[0];
  private wakeT = 9;
  private t = 0;

  constructor(scene: THREE.Scene, private dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(82, innerWidth / innerHeight, 0.05, 80);
    this.yawObj.add(this.pitchObj);
    this.pitchObj.add(this.camera);
    scene.add(this.yawObj);

    this.flashlight = new THREE.SpotLight(0xfff6e6, 38, 22, 0.46, 0.55, 1.6);
    this.flashlight.map = flashlightCookie();
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.bias = -0.0008;
    this.flashlight.position.set(0.2, -0.19, -0.62); // in front of the hand, at the torch lens
    this.flashlight.target.position.set(0.05, -0.12, -4);
    this.camera.add(this.flashlight, this.flashlight.target);

    // first-person hands: a sleeve and a pale hand holding the torch, with an ID wristband
    this.hands = new THREE.Group();
    this.sleeveMat = new THREE.MeshStandardMaterial({ color: 0x3a4a5a, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x141312, roughness: 0.55 }); // black work glove
    this.bandMat = new THREE.MeshStandardMaterial({ color: 0xe8e2cf, roughness: 0.6 });
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.42, 10), this.sleeveMat);
    sleeve.rotation.x = Math.PI / 2.3;
    sleeve.position.set(0.24, -0.3, -0.18);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.07, 0.11, 2, 2, 2), skin);
    hand.rotation.x = 0.35;
    hand.position.set(0.22, -0.22, -0.4);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.035, 12), this.bandMat);
    band.rotation.x = Math.PI / 2.3;
    band.position.set(0.225, -0.245, -0.36);
    const torch = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.034, 0.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.4, metalness: 0.7 }),
    );
    torch.rotation.x = Math.PI / 2;
    torch.position.set(0.2, -0.2, -0.48);
    this.hands.add(sleeve, hand, band, torch);
    this.camera.add(this.hands);

    addEventListener('keydown', (e) => this.key(e, true));
    addEventListener('keyup', (e) => this.key(e, false));
    addEventListener('mousemove', (e) => this.look(e));
    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  /** dress the hands in the body you currently wear */
  /** wake up in a body: on your knees, unsteady, then up */
  wake(ph: Physique) {
    this.physique = ph;
    this.wakeT = 0;
  }

  wear(color: THREE.ColorRepresentation, skinTone?: THREE.ColorRepresentation) {
    this.sleeveMat.color.set(color);
    void skinTone; // gloves hide the skin; the sleeve and the wristband tell you whose body this is
  }

  lock() {
    this.dom.requestPointerLock?.();
  }

  get locked() {
    return document.pointerLockElement === this.dom;
  }

  private key(e: KeyboardEvent, down: boolean) {
    if (!this.enabled) return;
    const k = e.code;
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (down && k === 'KeyF' && !e.repeat) {
      this.flashlightOn = !this.flashlightOn;
      this.onFlashlight?.(this.flashlightOn);
    }
    if (down && !e.repeat && /^Digit[1-6]$/.test(k)) this.onVoice?.(Number(k.slice(5)));
  }

  private look(e: MouseEvent) {
    if (!this.enabled || !this.locked) return;
    this.yawObj.rotation.y -= e.movementX * 0.0022;
    this.pitchObj.rotation.x = THREE.MathUtils.clamp(this.pitchObj.rotation.x - e.movementY * 0.0022, -1.45, 1.35);
  }

  get pitch() {
    return this.pitchObj.rotation.x;
  }

  get yaw() {
    return this.yawObj.rotation.y;
  }

  teleport(x: number, z: number, yaw?: number) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yawObj.rotation.y = yaw;
  }

  private collide(nx: number, nz: number): [number, number] {
    // axis-separated circle vs grid
    const free = (x: number, z: number) =>
      !isSolidAt(x - RADIUS, z - RADIUS) && !isSolidAt(x + RADIUS, z - RADIUS) && !isSolidAt(x - RADIUS, z + RADIUS) && !isSolidAt(x + RADIUS, z + RADIUS);
    let x = this.position.x;
    let z = this.position.z;
    if (free(nx, z)) x = nx;
    if (free(x, nz)) z = nz;
    // then around the props; a slide that would end in a wall stops instead
    const [sx, sz] = slideOffProps(this.position.x, this.position.z, x, z);
    if (sx === x && sz === z) return [x, z];
    return free(sx, sz) ? [sx, sz] : [this.position.x, this.position.z];
  }

  update(dt: number, opts: { speedScale?: number } = {}) {
    const f = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const s = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const wantsSprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    this.moving = this.enabled && (f !== 0 || s !== 0);
    this.sprinting = this.moving && wantsSprint && this.stamina > 0.05;
    this.stamina = THREE.MathUtils.clamp(this.stamina + (this.sprinting ? -dt / (5.5 * this.physique.lungs) : dt / 9), 0, 1);
    const risen = Math.min(1, this.wakeT / 1.8);
    const speed = (this.sprinting ? SPRINT : WALK) * (opts.speedScale ?? 1) * this.physique.pace * (0.25 + 0.75 * risen);

    const dir = new THREE.Vector3(s, 0, -f);
    if (dir.lengthSq() > 0) dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const target = dir.multiplyScalar(this.moving ? speed : 0);
    this.velocity.lerp(target, 1 - Math.exp(-dt * 10));
    const [x, z] = this.collide(this.position.x + this.velocity.x * dt, this.position.z + this.velocity.z * dt);
    this.position.x = x;
    this.position.z = z;
    this.animate(dt);
  }

  /**
   * Replays: walk this camera along a recorded path. Position and velocity come from the chain,
   * the head turns toward where the body is going, and the bob, steps and torch behave as if a
   * person were holding them.
   */
  puppet(dt: number, x: number, z: number, vx: number, vz: number) {
    this.position.set(x, 0, z);
    this.velocity.set(vx, 0, vz);
    const v = Math.hypot(vx, vz);
    this.moving = v > 0.3;
    this.sprinting = v > 3.2;
    if (v > 0.4) {
      const want = Math.atan2(-vx, -vz);
      let d = want - this.yawObj.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yawObj.rotation.y += d * Math.min(1, dt * 2.6);
    }
    this.pitchObj.rotation.x += (-0.08 - this.pitchObj.rotation.x) * Math.min(1, dt * 2);
    this.animate(dt);
  }

  private animate(dt: number) {
    // head bob + footsteps
    const v = Math.hypot(this.velocity.x, this.velocity.z);
    this.bob += dt * v * 2.6;
    this.stepAcc += dt * v;
    if (this.stepAcc > (this.sprinting ? 0.95 : 0.75)) {
      this.stepAcc = 0;
      this.onStep?.(this.sprinting);
    }
    const ph = this.physique;
    this.t += dt;
    this.wakeT += dt;
    const gait = Math.min(v / WALK, 1.6);
    // a bad leg drops you on every other step
    const limp = ph.limp * Math.max(0, Math.sin(this.bob * 0.5)) * 0.07 * gait;
    const bobY = Math.sin(this.bob) * 0.035 * gait - limp;
    const bobX = Math.cos(this.bob * 0.5) * 0.02 * gait;
    this.shake = Math.max(0, this.shake - dt * 2);
    const sh = this.shake * 0.05;
    // waking up: from your knees, tilted, to standing
    const k = Math.min(1, this.wakeT / 1.8);
    const down = (1 - k * k * (3 - 2 * k)) * 0.85;
    this.yawObj.position.set(this.position.x + bobX + (Math.random() - 0.5) * sh, ph.eye - down + bobY + (Math.random() - 0.5) * sh, this.position.z);
    this.yawObj.position.y = Math.min(this.yawObj.position.y, HEIGHT - 0.15);
    const tremor = ph.tremor * (Math.sin(this.t * 23) * 0.6 + Math.sin(this.t * 37.3) * 0.4) * 0.006;
    this.camera.rotation.z = bobX * 0.5 + limp * 0.6 + down * 0.4;
    this.camera.rotation.x = tremor;
    this.camera.rotation.y = tremor * 0.7;

    // flashlight battery
    if (this.flashlightOn) this.battery = Math.max(0, this.battery - dt / 240);
    else this.battery = Math.min(1, this.battery + dt / 600);
    const flicker = this.battery < 0.2 ? (Math.random() < (0.2 - this.battery) * 2 ? 0.1 : 1) : 1;
    this.flashlight.intensity = this.flashlightOn && this.battery > 0 ? 38 * Math.min(1, 0.35 + this.battery) * flicker : 0;
    this.hands.position.y = bobY * 0.5;
  }
}
