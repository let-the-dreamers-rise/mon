import * as THREE from 'three';
import { formatEther } from 'viem';
import { NET, type Hex } from '../config';
import type { Audio } from './audio';
import { Figure } from './figures';
import type { Fx } from './fx';
import type { Player } from './player';
import { CELL, isSolidAt, type World } from './world';

interface Phantom {
  fig: Figure;
  until: number;
  lit: number;
  walk: THREE.Vector3 | null;
}

/**
 * Sanity and everything that comes with losing it: figures that are not there, footsteps that
 * stop when you stop, swaps that never happened, and voices that know the other players' names.
 */
export class Psych {
  sanity = 1;
  fear = 0;
  private phantoms: Phantom[] = [];
  private nextPhantom = 0;
  private nextFakeSteps = 0;
  private fakeStepQueue: number[] = [];
  private nextFakeShift = 0;
  private nextName = 0;
  private titleRestore = 0;
  private baseTitle = document.title;
  names: string[] = [];
  onFakeShift?: () => void;

  constructor(private scene: THREE.Scene, private player: Player, private world: World, private audio: Audio, private fx: Fx) {}

  hit(amount: number) {
    this.sanity = Math.max(0, this.sanity - amount);
  }

  update(now: number, dt: number, nearestFigure: number, hollow: boolean, calm = false) {
    const p = this.player;
    const eye = p.yawObj.position;
    const ambient = this.world.ambientAt(eye);
    const torch = p.flashlightOn && p.battery > 0.05;
    let delta = 0;
    if (ambient < 0.15 && !torch) delta -= 0.035;
    else if (ambient < 0.15) delta -= 0.006;
    else delta += 0.012;
    if (nearestFigure < 7) delta -= 0.025 * (1 - nearestFigure / 7);
    if (hollow) delta = 0.02; // the Hollow is never afraid
    this.sanity = THREE.MathUtils.clamp(this.sanity + delta * dt, 0, 1);
    const targetFear = THREE.MathUtils.clamp((nearestFigure < 12 ? 1 - nearestFigure / 12 : 0) * 0.9 + (1 - this.sanity) * 0.4 + (p.sprinting ? 0.15 : 0), 0, 1);
    this.fear += (targetFear - this.fear) * Math.min(1, dt * 1.5);
    const insanity = 1 - this.sanity;
    this.fx.sanity = this.sanity;
    this.audio.setFear(hollow ? 0 : this.fear, hollow ? 0.2 : insanity);
    const behind = new THREE.Vector3(0, 0, 1.1).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw).add(eye);
    this.audio.maybeWhisper(now, insanity, behind);

    if (hollow || calm) {
      this.clearPhantoms();
      return;
    }

    // --- phantoms: identical figures that cannot touch you
    if (insanity > 0.35 && now > this.nextPhantom && this.phantoms.length < 2) {
      this.nextPhantom = now + 7000 + Math.random() * 14000 * (1.3 - insanity);
      this.spawnPhantom(now);
    }
    this.phantoms = this.phantoms.filter((ph) => {
      const pos = ph.fig.root.position;
      const d = pos.distanceTo(new THREE.Vector3(eye.x, 0, eye.z));
      // is it inside the torch beam?
      const toIt = new THREE.Vector3(pos.x - eye.x, 1.4 - eye.y, pos.z - eye.z).normalize();
      const look = new THREE.Vector3(0, 0, -1).applyQuaternion(p.camera.getWorldQuaternion(new THREE.Quaternion()));
      if (torch && toIt.dot(look) > 0.93 && d < 14) ph.lit += dt;
      let vx = 0;
      let vz = 0;
      if (ph.walk) {
        vx = ph.walk.x;
        vz = ph.walk.z;
        const nx = pos.x + vx * dt;
        const nz = pos.z + vz * dt;
        if (isSolidAt(nx, nz)) ph.walk = null;
      }
      ph.fig.update(now, dt, pos.x + vx * dt, pos.z + vz * dt, vx, vz);
      if (!ph.walk) ph.fig.heading = Math.atan2(eye.x - pos.x, eye.z - pos.z) + Math.PI;
      const gone = now > ph.until || d < 3.5 || ph.lit > 0.45;
      if (gone) {
        this.scene.remove(ph.fig.root);
        if (d < 3.5) this.audio.play('static_burst.mp3', 0.5);
      }
      return !gone;
    });

    // --- footsteps that follow you and stop when you stop
    if (insanity > 0.5 && p.moving && now > this.nextFakeSteps) {
      this.nextFakeSteps = now + 15000 + Math.random() * 15000;
      for (let i = 0; i < 5; i++) this.fakeStepQueue.push(now + 600 + i * 640);
    }
    if (this.fakeStepQueue.length && now >= this.fakeStepQueue[0]) {
      this.fakeStepQueue.shift();
      if (p.moving) {
        const b2 = new THREE.Vector3(0.3, 0, 3.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw).add(eye);
        b2.y = 0.1;
        this.audio.step(b2, false);
      } else this.fakeStepQueue.length = 0;
    }

    // --- a swap that never happened
    if (insanity > 0.72 && now > this.nextFakeShift) {
      this.nextFakeShift = now + 40000 + Math.random() * 40000;
      this.fx.swap();
      this.audio.play('glitch_shift.mp3', 0.8, 0.92);
      this.onFakeShift?.();
    }

    // --- the voice knows who else is here
    if (insanity > 0.45 && this.names.length && now > this.nextName) {
      this.nextName = now + 35000 + Math.random() * 30000;
      const name = this.names[Math.floor(Math.random() * this.names.length)];
      const lines = [`${name} is behind you`, `${name} is not ${name} anymore`, `${name}... is wearing you`, `don't let ${name} touch you`];
      this.audio.speak(lines[Math.floor(Math.random() * lines.length)]);
    }

    // --- the tab itself starts to talk
    if (insanity > 0.6 && now > this.titleRestore + 30000 && Math.random() < dt * 0.05) {
      document.title = ['it\'s behind you', 'turn around', 'whose hands are those', 'you are not you'][Math.floor(Math.random() * 4)];
      this.titleRestore = now + 4000;
    }
    if (this.titleRestore && now > this.titleRestore) {
      document.title = this.baseTitle;
      this.titleRestore = 0;
    }
  }

  private spawnPhantom(now: number) {
    const p = this.player;
    const eye = p.yawObj.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
    // walk the corridor ahead until a wall; stand near the far end of what you can see
    let dist = 0;
    while (dist < 16 && !isSolidAt(eye.x + fwd.x * (dist + 0.6), eye.z + fwd.z * (dist + 0.6))) dist += 0.5;
    if (dist < 7) return;
    const at = eye.clone().addScaledVector(fwd, dist - 1.2);
    const fig = new Figure(Math.floor(Math.random() * 8), this.names[Math.floor(Math.random() * Math.max(1, this.names.length))] ?? '', false);
    fig.root.position.set(at.x, 0, at.z);
    fig.setTorch(Math.random() < 0.5);
    const crossing = Math.random() < 0.5;
    let walk: THREE.Vector3 | null = null;
    if (crossing) {
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(Math.random() < 0.5 ? 1.6 : -1.6);
      if (!isSolidAt(at.x + side.x * 0.8, at.z + side.z * 0.8)) walk = side;
    }
    this.scene.add(fig.root);
    this.phantoms.push({ fig, until: now + 3500 + Math.random() * 4000, lit: 0, walk });
  }

  clearPhantoms() {
    for (const ph of this.phantoms) this.scene.remove(ph.fig.root);
    this.phantoms = [];
  }

  /** the fourth wall: read the player's real, public onchain history */
  static async intro(address: Hex | null): Promise<string> {
    if (!address) return 'This body has no history. Soon, neither will you.';
    try {
      const rpc = NET.historyRpc;
      if (!rpc) throw new Error('no history rpc');
      const call = async (method: string, params: unknown[]) => {
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        return (await r.json()).result as string;
      };
      const [count, bal] = await Promise.all([call('eth_getTransactionCount', [address, 'latest']), call('eth_getBalance', [address, 'latest'])]);
      const n = parseInt(count, 16);
      const mon = Number(formatEther(BigInt(bal))).toFixed(2);
      if (n > 0) return `${address.slice(0, 6)}… we have watched all ${n} of your transactions. You hold ${mon} MON. We know what you are.`;
      return `${address.slice(0, 6)}… not a single transaction. You have been hiding. Not anymore.`;
    } catch {
      return `${address.slice(0, 6)}… we remember you.`;
    }
  }
}

export const cellSize = CELL;
