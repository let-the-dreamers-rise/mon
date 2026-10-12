import * as THREE from 'three';
import { label } from './textures';

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
