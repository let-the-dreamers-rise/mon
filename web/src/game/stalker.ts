import * as THREE from 'three';
import { GRID } from '../config';
import { fieldTo } from '../ui/tracker';
import type { Audio } from './audio';
import { Figure } from './figures';
import type { Player } from './player';
import { CELL, isSolidAt, type World } from './world';

type State = 'away' | 'watching' | 'hunting' | 'leaving';

const WHISPERS = Array.from({ length: 12 }, (_, i) => `voice_whisper_${String(i + 1).padStart(2, '0')}.mp3`);

/**
 * IT: what fear looks like when nobody else is near. It is never onchain and it cannot turn you;
 * only a real Hollow can do that. But it can take your nerve.
 *
 * It stands where the street ends, facing you. Look away and it is closer. When it is close enough
 * it hunts: the lamps around you die and it runs at you through the streets. Hold the torch on it
 * and it can't stand it; sprint and break its line of sight and it loses you. If it reaches you,
 * you'll know.
 */
export class Stalker {
  state: State = 'away';
  /** metres to it while it is out, Infinity otherwise */
  distance = Infinity;
  onCatch?: () => void;
  onHint?: (text: string) => void;
  private fig: Figure;
  private nextAt = 0;
  private since = 0;
  private unseenFor = 0;
  private lit = 0;
  private fade = 0;
  private stepAt = 0;
  private enabledAt = 0;
  private hinted = new Set<string>();
  private pos = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private player: Player, private world: World, private audio: Audio) {
    this.fig = new Figure(7, '', false);
    this.fig.setTorch(false);
    this.fig.root.scale.set(1.06, 1.2, 1.06);
    // two pinpoints where its eyes should be: the only thing you see of it in the dark
    const eye = new THREE.MeshBasicMaterial({ color: 0xdfe8ff, fog: false, toneMapped: false });
    for (const x of [-0.032, 0.032]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6), eye);
      e.userData.x = x;
      e.visible = false;
      this.eyes.push(e);
      this.fig.root.add(e);
    }
  }

  private eyes: THREE.Mesh[] = [];
  private headBone: THREE.Object3D | null = null;

  /** keep the eyes on the face as the head twitches and the body runs */
  private placeEyes() {
    this.headBone ??= this.fig.root.getObjectByName('Head') ?? null;
    if (!this.headBone) return;
    this.fig.root.updateMatrixWorld(true);
    const at = this.fig.root.worldToLocal(this.headBone.getWorldPosition(new THREE.Vector3()));
    // the same few pixels on screen however far away it stands
    const k = Math.min(6, Math.max(1, this.distance / 5));
    for (const e of this.eyes) {
      e.position.set(at.x + e.userData.x * Math.min(k, 1.6), at.y + 0.085, at.z - 0.115);
      e.scale.setScalar(k);
      // a glint from a distance; up close there is only the band
      e.visible = this.distance > 2.5;
    }
  }

  /** `active` false hides it at once (watching, replays, the Hollow, cut-scenes) */
  update(now: number, dt: number, active: boolean, pace = 1) {
    if (!active) {
      if (this.state !== 'away') this.vanish(now, 8000);
      if (this.state === 'leaving') this.finishLeaving();
      return;
    }
    if (!this.enabledAt) {
      this.enabledAt = now;
      this.nextAt = now + (20000 + Math.random() * 10000) * pace;
    }
    const p = this.player;
    const eye = p.yawObj.position;
    this.distance = this.state === 'away' ? Infinity : Math.hypot(this.pos.x - eye.x, this.pos.z - eye.z);

    if (this.state === 'away') {
      if (now > this.nextAt && !this.appear(now)) this.nextAt = now + 4000;
      return;
    }

    const seen = this.inView();
    const torchOnIt = seen && p.flashlightOn && p.battery > 0.05 && this.distance < (this.state === 'hunting' ? 14 : 22) && this.beamDot() > (this.state === 'hunting' ? 0.965 : 0.975);
    this.lit = torchOnIt ? this.lit + dt : Math.max(0, this.lit - dt * 0.5);

    if (this.state === 'leaving') {
      this.fade = Math.max(0, this.fade - dt * 2.2);
      this.fig.setOpacity(this.fade);
      this.fig.update(now, dt, this.pos.x, this.pos.z, 0, 0);
      if (this.fade <= 0) this.finishLeaving();
      return;
    }
    this.fade = Math.min(1, this.fade + dt * 1.6);
    this.fig.setOpacity(this.fade);

    if (this.state === 'watching') {
      this.face(eye);
      this.fig.update(now, dt, this.pos.x, this.pos.z, 0, 0);
      this.placeEyes();
      this.unseenFor = seen ? 0 : this.unseenFor + dt;
      if (seen) this.hint('watch', 'SOMETHING IS STANDING AT THE END OF THE STREET. DON\'T LOOK AWAY FOR LONG.');
      if (this.lit > 0.7) {
        this.audio.playAt('static_burst.mp3', this.pos, 0.5, 3);
        return this.vanish(now, 30000 + Math.random() * 20000);
      }
      // look away and it is closer; once it is about a street away, it comes
      if (this.unseenFor > 1.1) {
        this.unseenFor = 0;
        if (!this.advance(eye, 0.4)) this.hunt(now);
        else this.audio.playAt(WHISPERS[Math.floor(Math.random() * WHISPERS.length)], this.pos, 0.8, 2);
      }
      if (now - this.since > 32000) this.vanish(now, 30000);
      return;
    }

    // hunting
    if (this.lit > 1.1) {
      this.hint('lit', 'IT CAN\'T STAND THE LIGHT.');
      this.audio.playAt('static_burst.mp3', this.pos, 0.8, 3);
      this.player.shake = 0.5;
      return this.vanish(now, 45000 + Math.random() * 25000);
    }
    if (this.distance < 1.05) {
      this.scene.remove(this.fig.root);
      this.state = 'away';
      this.nextAt = now + (40000 + Math.random() * 20000) * pace;
      this.onCatch?.();
      return;
    }
    if (now - this.since > 22000) {
      this.hint('lost', 'IT LOST YOU. FOR NOW.');
      return this.vanish(now, 35000 + Math.random() * 20000);
    }
    const speed = 2.9 + Math.min(1.2, (now - this.since) / 12000);
    const [tx, tz] = this.nextStep(eye);
    const dx = tx - this.pos.x, dz = tz - this.pos.z, d = Math.hypot(dx, dz) || 1;
    const vx = (dx / d) * speed, vz = (dz / d) * speed;
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    this.fig.update(now, dt, this.pos.x, this.pos.z, vx, vz);
    this.placeEyes();
    if (now > this.stepAt) {
      this.stepAt = now + 330;
      this.audio.step(this.tmp.set(this.pos.x, 0.1, this.pos.z), true);
    }
    // the lamps die around you while it is coming
    if (Math.random() < dt * 0.6) this.world.blackout(eye, 3, now);
  }

  private appear(now: number): boolean {
    const p = this.player;
    const eye = p.yawObj.position;
    // the far end of what you can see ahead, or of the street behind if ahead is short
    for (const turn of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
      const dir = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw + turn);
      let dist = 0;
      while (dist < 26 && !isSolidAt(eye.x + dir.x * (dist + 0.6), eye.z + dir.z * (dist + 0.6))) dist += 0.5;
      if (dist < 16) continue;
      this.pos.set(eye.x + dir.x * (dist - 1), 0, eye.z + dir.z * (dist - 1));
      this.state = 'watching';
      this.since = now;
      this.unseenFor = 0;
      this.lit = 0;
      this.fade = 0;
      this.fig.setOpacity(0);
      this.face(eye);
      this.fig.update(now, 0, this.pos.x, this.pos.z, 0, 0);
      this.scene.add(this.fig.root);
      this.audio.playAt('voice_whisper_0' + (1 + Math.floor(Math.random() * 9)) + '.mp3', this.pos, 0.6, 2);
      return true;
    }
    return false;
  }

  private hunt(now: number) {
    this.state = 'hunting';
    this.since = now;
    this.lit = 0;
    this.world.blackout(this.player.yawObj.position, 6, now);
    void this.audio.play('flashlight_flicker.mp3', 0.9, 0.8);
    void this.audio.play('static_burst.mp3', 0.35);
    this.player.shake = 0.8;
    this.hint('hunt', 'IT IS COMING. HOLD YOUR TORCH ON IT, OR RUN (SHIFT) AND LOSE IT.');
  }

  private vanish(now: number, awayMs: number) {
    if (this.state === 'away') return;
    this.state = 'leaving';
    this.nextAt = now + awayMs;
  }

  private hint(key: string, text: string) {
    if (this.hinted.has(key)) return;
    this.hinted.add(key);
    this.onHint?.(text);
  }

  private face(eye: THREE.Vector3) {
    this.fig.heading = Math.atan2(this.pos.x - eye.x, this.pos.z - eye.z);
  }

  /**
   * Walks it `frac` of the way to you along the streets, but never nearer than four cells (12 m).
   * Returns false when it is already that close, which is when it stops creeping and hunts.
   */
  private advance(eye: THREE.Vector3, frac: number): boolean {
    const f = fieldTo([Math.floor(eye.x / CELL), Math.floor(eye.z / CELL)]);
    let cx = Math.floor(this.pos.x / CELL), cy = Math.floor(this.pos.z / CELL);
    const d0 = f[cy * GRID + cx];
    if (d0 < 0 || d0 <= 4) return false;
    const steps = Math.min(d0 - 4, Math.max(1, Math.round(d0 * frac)));
    for (let k = 0; k < steps; k++) {
      const d = f[cy * GRID + cx];
      const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [cx + dx, cy + dy]).find(([x, y]) => f[y * GRID + x] === d - 1);
      if (!next) break;
      [cx, cy] = next;
    }
    this.pos.set((cx + 0.5) * CELL, 0, (cy + 0.5) * CELL);
    this.distance = Math.hypot(this.pos.x - eye.x, this.pos.z - eye.z);
    this.face(eye);
    return true;
  }

  private finishLeaving() {
    this.scene.remove(this.fig.root);
    this.state = 'away';
    this.distance = Infinity;
  }

  /** where to run next: straight at you if it can see you, else down the streets toward you */
  private nextStep(eye: THREE.Vector3): [number, number] {
    if (this.clearLine(this.pos, eye)) return [eye.x, eye.z];
    const f = fieldTo([Math.floor(eye.x / CELL), Math.floor(eye.z / CELL)]);
    const cx = Math.floor(this.pos.x / CELL), cy = Math.floor(this.pos.z / CELL);
    const d = f[cy * GRID + cx];
    const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [cx + dx, cy + dy]).find(([x, y]) => d > 0 && f[y * GRID + x] === d - 1);
    return next ? [(next[0] + 0.5) * CELL, (next[1] + 0.5) * CELL] : [eye.x, eye.z];
  }

  private clearLine(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    for (let t = 0.4; t < L; t += 0.4) if (isSolidAt(a.x + ((b.x - a.x) * t) / L, a.z + ((b.z - a.z) * t) / L)) return false;
    return true;
  }

  private inView(): boolean {
    const cam = this.player.camera;
    cam.updateWorldMatrix(true, false);
    this.tmp.set(this.pos.x, 1.5, this.pos.z).project(cam);
    if (this.tmp.z > 1 || Math.abs(this.tmp.x) > 0.95 || Math.abs(this.tmp.y) > 0.95) return false;
    return this.clearLine(this.player.yawObj.position, this.pos);
  }

  private beamDot(): number {
    const cam = this.player.camera;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    return this.tmp.set(this.pos.x - eye.x, 1.3 - eye.y, this.pos.z - eye.z).normalize().dot(look);
  }
}
