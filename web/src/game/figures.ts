import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGltf } from './assets';
import { label } from './textures';

interface Rig {
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  idle: THREE.AnimationAction;
  walk: THREE.AnimationAction;
  run: THREE.AnimationAction;
  twitch: THREE.AnimationAction;
  look: THREE.AnimationAction;
  reach: THREE.AnimationAction;
  torch: THREE.Object3D | null;
}

let additiveCache: { twitch: THREE.AnimationClip; look: THREE.AnimationClip } | null = null;

/** jumpsuit colours: each body is a worker of the Archive */
export const SUITS = [0x40536a, 0x6a4a3a, 0x3f5e48, 0x5f5a3a, 0x5a3f5f, 0x3a5f5f, 0x6a3a3a, 0x4a4a4a];
export const SKINS = [0xc9b39a, 0x8d6748, 0xe0c8b0, 0x6b4a33, 0xb08c6c, 0xd4b496, 0x9a7356, 0xc2a07e];

/**
 * A faceless worker in a jumpsuit holding a torch. Every figure — the living, the Hollow,
 * and the things that are not really there — uses this same body. Nothing gives them away.
 */
export class Figure {
  readonly root = new THREE.Group();
  private torso: THREE.Mesh;
  private head: THREE.Group;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private legL: THREE.Group;
  private legR: THREE.Group;
  readonly beam: THREE.Mesh;
  readonly torch: THREE.SpotLight | null;
  private phase = Math.random() * 10;
  private twitchAt = 0;
  private twitch = 0;
  heading = 0;
  speed = 0;
  opacity = 1;
  private rig: Rig | null = null;
  private procedural: THREE.Object3D[] = [];

  constructor(body: number, name: string, withLight: boolean) {
    const suit = new THREE.MeshStandardMaterial({ color: SUITS[body % 8], roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: SKINS[body % 8], roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.2, metalness: 0.3 });

    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.55, 6, 12), suit);
    this.torso.position.y = 1.18;
    this.torso.castShadow = true;

    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.135, 18, 14), skin);
    skull.scale.set(0.92, 1.12, 1);
    // no face. just a smooth dark band where the eyes should be
    const band = new THREE.Mesh(new THREE.SphereGeometry(0.138, 18, 6, -0.9, 1.8, 1.25, 0.32), dark);
    band.scale.set(0.92, 1.12, 1);
    band.rotation.y = Math.PI;
    this.head.add(skull, band);
    this.head.position.y = 1.72;
    skull.castShadow = true;

    const limb = (len: number, r: number, mat: THREE.Material) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat);
      m.position.y = -len / 2 - r;
      m.castShadow = true;
      g.add(m);
      return g;
    };
    this.armL = limb(0.55, 0.06, suit);
    this.armR = limb(0.55, 0.06, suit);
    this.armL.position.set(-0.27, 1.5, 0);
    this.armR.position.set(0.27, 1.5, 0);
    this.legL = limb(0.72, 0.085, suit);
    this.legR = limb(0.72, 0.085, suit);
    this.legL.position.set(-0.11, 0.88, 0);
    this.legR.position.set(0.11, 0.88, 0);

    // name tag on the chest: the name of the body's owner, not of whoever wears it
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.06), new THREE.MeshStandardMaterial({ map: label(name || '??????'), roughness: 0.7 }));
    tag.position.set(0.09, 1.38, -0.215);
    tag.rotation.y = Math.PI;

    // torch beam (fake volumetric cone) — every figure carries one
    const beamGeo = new THREE.ConeGeometry(0.7, 4.5, 20, 1, true);
    beamGeo.translate(0, -2.25, 0);
    beamGeo.rotateX(-Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff1d6,
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.position.set(0.25, 1.2, -0.25);
    this.beam.rotation.y = Math.PI;
    // real torch light comes from a shared pool (see Game) so the light count never changes
    this.torch = null;
    void withLight;

    this.root.add(this.torso, this.head, this.armL, this.armR, this.legL, this.legR, tag, this.beam);
    this.procedural = [this.torso, this.head, this.armL, this.armR, this.legL, this.legR, tag];
    void this.upgrade(body, name);
  }

  /** swap the stand-in mannequin for the rigged Blender worker once it has loaded */
  private async upgrade(body: number, name: string) {
    const g = await loadGltf('models/worker.glb');
    if (!g) return;
    const model = SkeletonUtils.clone(g.scene);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const out = mats.map((m) => {
        const mat = m as THREE.MeshStandardMaterial;
        if (mat.name === 'Suit') {
          const c = mat.clone();
          c.color.set(SUITS[body % 8]);
          return c;
        }
        if (mat.name === 'Skin') {
          const c = mat.clone();
          c.color.set(0xd8d2c8); // every face is the same: pale, smooth, nothing there
          return c;
        }
        if (mat.name === 'Tag') {
          const c = mat.clone();
          const t = label(name || '??????');
          t.flipY = false;
          c.map = t;
          c.color.set(0xffffff);
          return c;
        }
        return mat;
      });
      mesh.material = Array.isArray(mesh.material) ? out : out[0];
    });
    const mixer = new THREE.AnimationMixer(model);
    const clip = (n: string) => g.animations.find((a) => a.name === n)!;
    if (!additiveCache) {
      additiveCache = {
        twitch: THREE.AnimationUtils.makeClipAdditive(clip('Twitch').clone()),
        look: THREE.AnimationUtils.makeClipAdditive(clip('Look').clone()),
      };
    }
    const act = (c: THREE.AnimationClip, loop = true) => {
      const a = mixer.clipAction(c);
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      return a;
    };
    const idle = act(clip('Idle'));
    const walk = act(clip('Walk'));
    const run = act(clip('Run'));
    const twitch = act(additiveCache.twitch, false);
    twitch.blendMode = THREE.AdditiveAnimationBlendMode;
    const look = act(additiveCache.look, false);
    look.blendMode = THREE.AdditiveAnimationBlendMode;
    const reach = act(clip('Reach'), false);
    for (const a of [idle, walk, run]) {
      a.play();
      a.setEffectiveWeight(0);
      a.time = Math.random() * a.getClip().duration;
    }
    idle.setEffectiveWeight(1);
    const torch = model.getObjectByName('Torch') ?? null;
    if (torch) {
      // the light shaft comes out of the real torch lens
      this.root.remove(this.beam);
      torch.add(this.beam);
      this.beam.position.set(0, 0, -0.09);
      this.beam.rotation.set(0, Math.PI, 0);
      this.beam.scale.setScalar(1 / Math.max(0.001, torch.getWorldScale(new THREE.Vector3()).x));
    }
    for (const o of this.procedural) o.visible = false;
    this.root.add(model);
    this.rig = { model, mixer, idle, walk, run, twitch, look, reach, torch };
  }

  /** the lunge that turns you */
  reach() {
    const r = this.rig;
    if (!r) return;
    r.reach.reset().setEffectiveWeight(1).fadeIn(0.05).play();
    for (const a of [r.idle, r.walk, r.run]) a.setEffectiveWeight(0);
  }

  /** where the torch light should come from, and where it points */
  torchRay(pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    const t = this.rig?.torch;
    if (!t) return false;
    t.getWorldPosition(pos);
    dir.set(0, 0, -1).applyQuaternion(t.getWorldQuaternion(new THREE.Quaternion()));
    return true;
  }

  setTorch(on: boolean) {
    this.beam.visible = on;
    if (this.torch) this.torch.intensity = on ? 14 : 0;
  }

  /** x,z in metres; vx,vz per second */
  update(now: number, dt: number, x: number, z: number, vx: number, vz: number) {
    this.root.position.set(x, 0, z);
    const sp = Math.hypot(vx, vz);
    this.speed += (sp - this.speed) * Math.min(1, dt * 6);
    if (sp > 0.15) {
      const target = Math.atan2(-vx, -vz);
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dt * 7);
    }
    this.root.rotation.y = this.heading;
    if (this.rig) {
      this.animateRig(now, dt);
      return;
    }
    this.phase += dt * (2 + this.speed * 2.4);
    const swing = Math.min(this.speed / 2.5, 1.4) * 0.65;
    this.legL.rotation.x = Math.sin(this.phase) * swing;
    this.legR.rotation.x = -Math.sin(this.phase) * swing;
    this.armL.rotation.x = -Math.sin(this.phase) * swing * 0.8;
    this.armR.rotation.x = -0.9 + Math.sin(this.phase) * swing * 0.2; // holding the torch up
    this.root.position.y = Math.abs(Math.sin(this.phase)) * 0.04 * Math.min(this.speed, 2);
    this.torso.rotation.x = Math.min(this.speed / 4.5, 1) * 0.18;

    // the uncanny part: an occasional too-sharp head twitch, the same for everyone
    if (now > this.twitchAt) {
      this.twitchAt = now + 3000 + Math.random() * 9000;
      this.twitch = (Math.random() - 0.5) * 1.6;
    }
    this.twitch *= Math.exp(-dt * 3);
    this.head.rotation.z = this.twitch * 0.5;
    this.head.rotation.y = this.twitch;
  }

  private animateRig(now: number, dt: number) {
    const r = this.rig!;
    const v = this.speed;
    const walkW = THREE.MathUtils.clamp((v - 0.15) / 0.6, 0, 1) * (1 - THREE.MathUtils.clamp((v - 2.4) / 1.2, 0, 1));
    const runW = THREE.MathUtils.clamp((v - 2.4) / 1.2, 0, 1);
    const idleW = 1 - Math.max(walkW, runW);
    if (!r.reach.isRunning()) {
      r.idle.setEffectiveWeight(idleW);
      r.walk.setEffectiveWeight(walkW);
      r.run.setEffectiveWeight(runW);
    }
    r.walk.timeScale = THREE.MathUtils.clamp(v / 1.4, 0.6, 1.8);
    r.run.timeScale = THREE.MathUtils.clamp(v / 4.3, 0.7, 1.4);
    // the uncanny part: a too-sharp twitch or a slow look, the same for every figure
    if (now > this.twitchAt) {
      this.twitchAt = now + 4000 + Math.random() * 10000;
      (Math.random() < 0.6 ? r.twitch : r.look).reset().setEffectiveWeight(1).play();
    }
    r.mixer.update(dt);
  }

  setOpacity(o: number) {
    if (o === this.opacity) return;
    this.opacity = o;
    this.root.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.Material | undefined;
      if (m && 'opacity' in m && c !== this.beam) {
        m.transparent = o < 1;
        (m as THREE.MeshStandardMaterial).opacity = o;
      }
    });
  }
}
