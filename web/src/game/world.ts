import * as THREE from 'three';
import { CELL_CM, GRID } from '../config';
import map from '../map.json';
import { applyPbr, ModelInstances } from './assets';
import { carpet, ceiling, label, litWindow, roughness, wallpaper } from './textures';

export const CELL = CELL_CM / 100; // 3 m
export const HEIGHT = 3; // interior ceiling height

const rows: string[] = (map as unknown as { rows: string[] }).rows;
const solidWords = map.walls.map((w) => BigInt(w));
export function isSolidCell(cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return true;
  const bit = cy * GRID + cx;
  return ((solidWords[bit >> 8] >> BigInt(bit & 255)) & 1n) === 1n;
}
export function isSolidAt(x: number, z: number): boolean {
  return isSolidCell(Math.floor(x / CELL), Math.floor(z / CELL));
}
export const tileAt = (cx: number, cy: number) => (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID ? '#' : rows[cy][cx]);
const INDOOR = new Set(['A', 'H', 'S', '0', '1', '2']);
export const isIndoor = (x: number, z: number) => INDOOR.has(tileAt(Math.floor(x / CELL), Math.floor(z / CELL)));
export const cellCenter = ([cx, cy]: number[]) => new THREE.Vector3((cx + 0.5) * CELL, 0, (cy + 0.5) * CELL);

/** yaw (radians, three.js convention) looking down the longest open run from a cell */
export function openYaw(cell: number[]): number {
  const [x, y] = cell;
  let best = 0, bestRun = -1;
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    let run = 0;
    while (run < 20 && !isSolidCell(x + dx * (run + 1), y + dy * (run + 1))) run++;
    if (run > bestRun) {
      bestRun = run;
      best = Math.atan2(-dx, -dy);
    }
  }
  return best;
}

/** which named place a point is in, for the HUD */
export function placeAt(x: number, z: number): string {
  const cx = Math.floor(x / CELL), cy = Math.floor(z / CELL);
  const t = tileAt(cx, cy);
  for (const s of map.shops) if (t === s.floor) return s.name;
  for (const l of map.landmarks) if (t === l.floor) return l.name;
  if (t === 'p' || t === 'T') return 'THE PARK';
  if (cy >= 30 && cy <= 32) return 'MAIN STREET';
  if (cx >= 30 && cx <= 32) return 'HALDEN AVENUE';
  return 'HALDEN';
}

/** anything that glows: lamps, panels, signs, fuse lamps, the gate, flares. A small pool of real
 *  lights is assigned each frame to the sources that matter most to the viewer. */
interface Source {
  pos: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  distance: number;
  mode: 'on' | 'flicker' | 'dead';
  phase: number;
  level: number;
  outdoor: boolean;
  /** index into an instanced emitter (lamp heads / panels) whose colour shows the level */
  emitter?: { mesh: THREE.InstancedMesh; index: number; base: THREE.Color };
  cone?: { mesh: THREE.InstancedMesh; index: number };
  sign?: THREE.MeshStandardMaterial;
  until?: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** builds one merged quad geometry for a set of cells, UVs in world metres / repeat */
function floorGeometry(cells: [number, number][], y: number, repeat: number, facing: 1 | -1 = 1) {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  let v = 0;
  for (const [cx, cy] of cells) {
    const x0 = cx * CELL, z0 = cy * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
    const quad = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    for (const [x, z] of quad) {
      pos.push(x, y, z);
      uv.push(x / repeat, z / repeat);
      nrm.push(0, facing, 0);
    }
    if (facing === 1) idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    else idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/** a box whose UVs are in metres / repeat on every face, so textures keep their real scale */
function boxUV(w: number, h: number, d: number, rep: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // face order: +x, -x, +y, -y, +z, -z (4 vertices each)
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, (uv.getX(i) * dims[f][0]) / rep, (uv.getY(i) * dims[f][1]) / rep);
  }
  return g;
}

function std(color: number, rough = 0.9, metal = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

/** Halden at night: wet streets, dead windows, sodium lamps, and the buildings you have to enter. */
export class World {
  readonly group = new THREE.Group();
  private sources: Source[] = [];
  private pool: THREE.PointLight[] = [];
  private blockPulse = 0;
  private darkUntil = 0;
  private darkCenter = new THREE.Vector3();
  private rain!: THREE.LineSegments;
  private rainPos!: Float32Array;
  private lightning: THREE.DirectionalLight;
  private boltAt = 0;
  private nextFlash = 20000;
  private windowsLit!: THREE.InstancedMesh;
  private litPhase: number[] = [];
  fuseBoxes: { group: THREE.Group; lamp: THREE.MeshStandardMaterial; source: Source }[] = [];
  exitDoor!: THREE.Group;
  exitSign!: THREE.MeshStandardMaterial;
  private exitSource!: Source;
  private exitOpen = 0;
  private flares: { mesh: THREE.Mesh; source: Source }[] = [];
  private flashes: { light: THREE.PointLight; t: number }[] = [];
  private propObjs: THREE.Object3D[] = [];
  private lampMatrices: THREE.Matrix4[] = [];
  private standInLamps: THREE.Object3D[] = [];
  onThunder?: () => void;

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
    this.lightning = new THREE.DirectionalLight(0xbcd2ff, 0);
    this.lightning.position.set(60, 120, 40);
    scene.add(this.lightning);
    this.buildGround();
    this.buildWalls();
    this.buildBuildings();
    this.buildLights();
    this.buildSigns();
    this.buildNature();
    this.buildObjectives();
    this.buildRain();
    void this.buildProps();
    for (let i = 0; i < 10; i++) {
      const l = new THREE.PointLight(0xffa04a, 0, 15, 1.5);
      this.group.add(l);
      this.pool.push(l);
    }
  }

  // ------------------------------------------------------------------ ground
  private buildGround() {
    const groups: Record<string, [number, number][]> = {};
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const t = rows[y][x];
      const k = t === '.' || t === 'a' || t === 'G' ? 'road' : t === ',' ? 'walk' : t === 'p' || t === 'T' ? 'park' : INDOOR.has(t) ? t : t === 'F' ? 'road' : null;
      if (!k) continue;
      (groups[k] ??= []).push([x, y]);
    }
    const asphalt = std(0x262628, 0.42, 0.05);
    asphalt.map = roughness(1);
    void applyPbr(asphalt, 'asphalt', { tint: 0x6a6a6e, roughnessScale: 0.55 });
    const walk = std(0x4a4842, 0.8);
    void applyPbr(walk, 'sidewalk', { tint: 0x9a968c, roughnessScale: 0.75 });
    const park = std(0x1f2416, 1);
    void applyPbr(park, 'ground', { tint: 0x8a8a7a });
    const archive = new THREE.MeshStandardMaterial({ map: carpet(), roughness: 1 });
    void applyPbr(archive, 'carpet', { tint: 0xb8a070 });
    const hospital = std(0xb9c2b4, 0.45);
    void applyPbr(hospital, 'tiles', { tint: 0xc8d4c6, roughnessScale: 0.5 });
    const station = std(0x5b5a55, 0.6);
    void applyPbr(station, 'tiles', { tint: 0x8a8880, roughnessScale: 0.6 });
    const shop = std(0x6b5f4f, 0.6);
    void applyPbr(shop, 'wood', { tint: 0xaaa090, roughnessScale: 0.7 });
    const mats: Record<string, [THREE.Material, number, number]> = {
      road: [asphalt, 3, 0],
      walk: [walk, 1.8, 0.12],
      park: [park, 2.35, 0.02],
      A: [archive, 1.2, 0.01],
      H: [hospital, 2, 0.01],
      S: [station, 2, 0.01],
      '0': [shop, 2, 0.01],
      '1': [hospital, 2, 0.01],
      '2': [shop, 2, 0.01],
    };
    for (const [k, cells] of Object.entries(groups)) {
      const [mat, rep, y] = mats[k];
      const mesh = new THREE.Mesh(floorGeometry(cells, y, rep), mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    // curbs along the sidewalks
    const curbGeo = new THREE.BoxGeometry(CELL, 0.14, 0.18);
    const curbs: THREE.Matrix4[] = [];
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      if (rows[y][x] !== ',') continue;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        if (tileAt(x + dx, y + dy) !== '.') continue;
        const m = new THREE.Matrix4();
        const c = cellCenter([x, y]);
        m.makeRotationY(dx !== 0 ? Math.PI / 2 : 0);
        m.setPosition(c.x + (dx * CELL) / 2, 0.07, c.z + (dy * CELL) / 2);
        curbs.push(m);
      }
    }
    const curb = new THREE.InstancedMesh(curbGeo, std(0x6a675e, 0.85), curbs.length);
    curbs.forEach((m, i) => curb.setMatrixAt(i, m));
    curb.receiveShadow = true;
    this.group.add(curb);

    // indoor ceilings
    const indoor: [number, number][] = [];
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (INDOOR.has(rows[y][x])) indoor.push([x, y]);
    const ceil = new THREE.Mesh(floorGeometry(indoor, HEIGHT, 1.2, -1), new THREE.MeshStandardMaterial({ map: ceiling(), roughness: 0.95 }));
    (ceil.material as THREE.MeshStandardMaterial).map!.repeat.set(1, 1);
    this.group.add(ceil);

    // the river
    const water = new THREE.Mesh(new THREE.PlaneGeometry(6 * CELL + 80, GRID * CELL + 80), new THREE.MeshStandardMaterial({ color: 0x03070a, roughness: 0.04, metalness: 0.9 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(58 * CELL + 3 * CELL + 40, -0.6, (GRID * CELL) / 2);
    this.group.add(water);
  }

  // ------------------------------------------------------------------ walls of landmarks & shops
  private regionOf(cx: number, cy: number) {
    for (const l of map.landmarks) {
      const [x0, y0, x1, y1] = l.rect;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) return { kind: l.floor, perimeter: cx === x0 || cx === x1 || cy === y0 || cy === y1 };
    }
    for (const s of map.shops) {
      const [x0, y0, x1, y1] = s.rect;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) return { kind: 'shop', perimeter: cx === x0 || cx === x1 || cy === y0 || cy === y1 };
    }
    return null;
  }

  private buildWalls() {
    const wallpaperMat = new THREE.MeshStandardMaterial({ map: wallpaper(), roughness: 0.92 });
    const plaster = std(0xb8c0b0, 0.85);
    void applyPbr(plaster, 'plaster', { tint: 0xc8d2c0 });
    const concrete = std(0x6a6862, 0.9);
    void applyPbr(concrete, 'concrete', { tint: 0x9a968c });
    const brick = std(0x5a3a2c, 0.9);
    void applyPbr(brick, 'brick', { tint: 0x9a8a80 });
    const kinds: Record<string, { mat: THREE.Material; height: number; outer: THREE.Material; outerH: number }> = {
      A: { mat: wallpaperMat, height: HEIGHT, outer: concrete, outerH: 13 },
      H: { mat: plaster, height: HEIGHT, outer: concrete, outerH: 16 },
      S: { mat: concrete, height: HEIGHT, outer: concrete, outerH: 6 },
      shop: { mat: plaster, height: HEIGHT, outer: brick, outerH: 7 },
    };
    const buckets = new Map<string, THREE.Matrix4[]>();
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      if (rows[y][x] !== 'W') continue;
      const r = this.regionOf(x, y);
      if (!r) continue;
      const k = kinds[r.kind];
      const key = `${r.kind}:${r.perimeter ? 'o' : 'i'}`;
      const h = r.perimeter ? k.outerH : k.height;
      const m = new THREE.Matrix4().compose(new THREE.Vector3((x + 0.5) * CELL, h / 2, (y + 0.5) * CELL), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(m);
    }
    for (const [key, ms] of buckets) {
      const [kind, side] = key.split(':');
      const k = kinds[kind];
      const h = side === 'o' ? k.outerH : k.height;
      const geo = boxUV(CELL, h, CELL, 2);
      ms.forEach((m) => m.scale(new THREE.Vector3(1, 1 / h, 1)));
      const mesh = new THREE.InstancedMesh(geo, side === 'o' ? k.outer : k.mat, ms.length);
      ms.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    // perimeter fence
    const wire = document.createElement('canvas');
    wire.width = wire.height = 64;
    const g = wire.getContext('2d')!;
    g.strokeStyle = 'rgba(160,165,160,0.9)';
    g.lineWidth = 2;
    for (let i = -64; i < 128; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke();
      g.beginPath(); g.moveTo(i + 64, 0); g.lineTo(i, 64); g.stroke();
    }
    const wireTex = new THREE.CanvasTexture(wire);
    wireTex.wrapS = wireTex.wrapT = THREE.RepeatWrapping;
    wireTex.repeat.set(3, 2.5);
    const fenceMat = new THREE.MeshStandardMaterial({ map: wireTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5 });
    const fenceGeo = new THREE.PlaneGeometry(CELL, 3.2);
    const fences: THREE.Matrix4[] = [];
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      if (rows[y][x] !== 'F') continue;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        if (isSolidCell(x + dx, y + dy)) continue;
        const c = cellCenter([x, y]);
        const m = new THREE.Matrix4().makeRotationY(dx !== 0 ? Math.PI / 2 : 0);
        m.setPosition(c.x + (dx * CELL) / 2, 1.6, c.z + (dy * CELL) / 2);
        fences.push(m);
      }
    }
    const fence = new THREE.InstancedMesh(fenceGeo, fenceMat, fences.length);
    fences.forEach((m, i) => fence.setMatrixAt(i, m));
    this.group.add(fence);
  }

  // ------------------------------------------------------------------ city blocks
  private buildBuildings() {
    const brick = std(0x4a3228, 0.92);
    void applyPbr(brick, 'brick', { tint: 0x8a7a72 });
    const concrete = std(0x55534e, 0.92);
    void applyPbr(concrete, 'concrete', { tint: 0x8a867c });
    const winDark: THREE.Matrix4[] = [];
    const winLit: THREE.Matrix4[] = [];
    let s = 4242;
    const r = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    for (const b of map.buildings as { x: number; y: number; w: number; h: number; floors: number; style: string; litChance: number }[]) {
      const W = b.w * CELL, D = b.h * CELL, H = b.floors * 3.3 + 1;
      const mesh = new THREE.Mesh(boxUV(W, H, D, b.style === 'brick' ? 1.9 : 2), b.style === 'brick' ? brick : concrete);
      mesh.position.set(b.x * CELL + W / 2, H / 2, b.y * CELL + D / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      // windows on faces that look onto open ground
      const faces: [number, number, number, number][] = [];
      for (let k = 0; k < b.w; k++) {
        if (!isSolidCell(b.x + k, b.y - 1)) faces.push([b.x + k, b.y, 0, -1]);
        if (!isSolidCell(b.x + k, b.y + b.h)) faces.push([b.x + k, b.y + b.h - 1, 0, 1]);
      }
      for (let k = 0; k < b.h; k++) {
        if (!isSolidCell(b.x - 1, b.y + k)) faces.push([b.x, b.y + k, -1, 0]);
        if (!isSolidCell(b.x + b.w, b.y + k)) faces.push([b.x + b.w - 1, b.y + k, 1, 0]);
      }
      for (const [cx, cy, dx, dy] of faces) {
        for (let f = 0; f < b.floors; f++) {
          const c = cellCenter([cx, cy]);
          const pos = new THREE.Vector3(c.x + (dx * CELL) / 2 + dx * 0.03, 1.9 + f * 3.3, c.z + (dy * CELL) / 2 + dy * 0.03);
          const m = new THREE.Matrix4().makeRotationY(dx !== 0 ? (dx > 0 ? Math.PI / 2 : -Math.PI / 2) : dy > 0 ? 0 : Math.PI);
          m.setPosition(pos);
          (f > 0 && r() < b.litChance ? winLit : winDark).push(m);
        }
      }
    }
    const winGeo = new THREE.PlaneGeometry(1.3, 1.6);
    const dark = new THREE.InstancedMesh(winGeo, new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.06, metalness: 0.95 }), winDark.length);
    winDark.forEach((m, i) => dark.setMatrixAt(i, m));
    this.group.add(dark);
    this.windowsLit = new THREE.InstancedMesh(winGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, map: litWindow() }), winLit.length);
    this.windowsLit.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(winLit.length * 3), 3);
    winLit.forEach((m, i) => {
      this.windowsLit.setMatrixAt(i, m);
      this.litPhase.push(r() * 100);
    });
    this.group.add(this.windowsLit);
  }

  // ------------------------------------------------------------------ lamps & panels
  private addSource(src: Omit<Source, 'level' | 'phase'> & { phase?: number }) {
    const full: Source = { level: 1, phase: Math.random() * 100, ...src };
    this.sources.push(full);
    return full;
  }

  private buildLights() {
    const lamps = [...(map.lamps as { cell: number[]; state: 'on' | 'flicker' | 'dead' }[])];
    for (let x = 36; x <= 55; x += 5) lamps.push({ cell: [x, 51], state: x % 2 ? 'flicker' : 'on' });
    for (let y = 44; y <= 60; y += 5) lamps.push({ cell: [44, y], state: y === 54 ? 'dead' : 'on' });
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 3.9, 8);
    poleGeo.translate(0, 1.95, 0);
    const armGeo = new THREE.BoxGeometry(0.06, 0.06, 0.3);
    const headGeo = new THREE.BoxGeometry(0.16, 0.22, 0.16);
    const coneGeo = new THREE.ConeGeometry(2.1, 3.5, 24, 6, true);
    coneGeo.translate(0, -1.75, 0);
    {
      // light shaft fades from the lamp down to nothing at the ground
      const pos = coneGeo.attributes.position;
      const cols = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v++) {
        const t = Math.min(1, -pos.getY(v) / 3.5);
        const k = Math.pow(1 - t, 2.2) * 0.9 + 0.02;
        cols.set([k, k, k], v * 3);
      }
      coneGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    const poleMat = std(0x1c1d1f, 0.5, 0.7);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length);
    const arms = new THREE.InstancedMesh(armGeo, poleMat, lamps.length);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), lamps.length);
    const cones = new THREE.InstancedMesh(coneGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: true }), lamps.length);
    heads.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lamps.length * 3), 3);
    cones.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lamps.length * 3), 3);
    poles.castShadow = true;
    const sodium = new THREE.Color(0xffa04a);
    lamps.forEach((lamp, i) => {
      const [cx, cy] = lamp.cell;
      let ox = 0, oz = 0;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (isSolidCell(cx + dx, cy + dy)) { ox = dx * 1.2; oz = dy * 1.2; break; }
      const c = cellCenter([cx, cy]);
      const base = new THREE.Vector3(c.x + ox, 0, c.z + oz);
      this.lampMatrices.push(new THREE.Matrix4().compose(base, new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * 6.28), new THREE.Vector3(1, 1, 1)));
      const dir = new THREE.Vector3(-ox, 0, -oz).normalize();
      if (dir.lengthSq() === 0) dir.set(1, 0, 0);
      const yaw = Math.atan2(dir.x, dir.z);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
      poles.setMatrixAt(i, new THREE.Matrix4().compose(base, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      arms.setMatrixAt(i, new THREE.Matrix4().compose(base.clone().setY(3.75), q, new THREE.Vector3(1, 1, 1)));
      const headPos = base.clone().setY(3.55);
      heads.setMatrixAt(i, new THREE.Matrix4().compose(headPos, q, new THREE.Vector3(1, 1, 1)));
      cones.setMatrixAt(i, new THREE.Matrix4().compose(headPos, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
      this.addSource({
        pos: headPos.clone().setY(3.3), color: sodium.clone(), intensity: 18, distance: 14, mode: lamp.state, outdoor: true,
        emitter: { mesh: heads, index: i, base: new THREE.Color(0xffb060).multiplyScalar(3) }, cone: { mesh: cones, index: i },
      });
    });
    this.group.add(poles, arms, heads, cones);
    this.standInLamps.push(poles, arms);

    // indoor fluorescent panels, one instanced emitter
    const cells: { x: number; y: number; t: string }[] = [];
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const t = rows[y][x];
      if (INDOOR.has(t) && (x + 2 * y) % 3 === 0) cells.push({ x, y, t });
    }
    const panelGeo = new THREE.PlaneGeometry(1.2, 0.6);
    panelGeo.rotateX(Math.PI / 2);
    const panels = new THREE.InstancedMesh(panelGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), cells.length);
    panels.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);
    let s = 99;
    const r = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    cells.forEach(({ x, y, t }, i) => {
      const pos = new THREE.Vector3((x + 0.5) * CELL, HEIGHT - 0.02, (y + 0.5) * CELL);
      panels.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z));
      const color = new THREE.Color(t === 'H' ? 0xe6fff0 : t === 'S' ? 0xcfe0ff : 0xfff3d0);
      const roll = r();
      const mode = roll < (t === 'S' ? 0.4 : 0.22) ? 'dead' : roll < 0.38 ? 'flicker' : 'on';
      this.addSource({
        pos: pos.clone().setY(HEIGHT - 0.3), color, intensity: 6, distance: 10, mode, outdoor: false,
        emitter: { mesh: panels, index: i, base: color.clone().multiplyScalar(2.4) },
      });
    });
    this.group.add(panels);
  }

  private buildSigns() {
    const place = (text: string, door: number[], color: string, fg: string, w = 4.2) => {
      const [cx, cy] = door;
      let dir = new THREE.Vector3(0, 0, 1);
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const t = tileAt(cx + dx, cy + dy);
        if (t === '.' || t === ',' || t === 'a') { dir = new THREE.Vector3(dx, 0, dy); break; }
      }
      const tex = label(text, { w: 512, h: 96, bg: '#060606', fg: color, font: 'bold 54px "Courier New", monospace' });
      const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.6 });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.19), mat);
      const c = cellCenter(door);
      sign.position.set(c.x + dir.x * 1.6, 3.6, c.z + dir.z * 1.6);
      sign.lookAt(sign.position.clone().add(dir));
      this.group.add(sign);
      this.addSource({ pos: sign.position.clone().addScaledVector(dir, 0.8), color: new THREE.Color(fg), intensity: 5, distance: 8, mode: 'flicker', outdoor: true, sign: mat });
    };
    const shopColors = [['#7dff9a', '#3cff7a'], ['#7ad7ff', '#2bb8ff'], ['#ff9ad0', '#ff3fa0']];
    map.shops.forEach((s, i) => place(s.name, s.door, shopColors[i][0], shopColors[i][1]));
    const lmColors = [['#ffe9a0', '#ffd060'], ['#d8fff0', '#9affd8'], ['#ffd0a0', '#ff9a40']];
    map.landmarks.forEach((l, i) => place(l.name, l.door, lmColors[i][0], lmColors[i][1], 6));
  }

  // ------------------------------------------------------------------ trees, headstones, cars
  private buildNature() {
    const bark = std(0x1a1512, 0.95);
    const variants: THREE.BufferGeometry[] = [];
    for (let v = 0; v < 3; v++) {
      const parts: THREE.BufferGeometry[] = [];
      const trunk = new THREE.CylinderGeometry(0.12, 0.28, 5 + v, 7);
      trunk.translate(0, (5 + v) / 2, 0);
      parts.push(trunk);
      for (let b = 0; b < 5; b++) {
        const len = 1.4 + Math.random() * 1.8;
        const br = new THREE.CylinderGeometry(0.03, 0.08, len, 5);
        br.translate(0, len / 2, 0);
        br.rotateZ(0.6 + Math.random() * 0.7);
        br.rotateY(Math.random() * Math.PI * 2);
        br.translate(0, 2.5 + Math.random() * 2.5, 0);
        parts.push(br);
      }
      variants.push(mergeGeometries(parts));
    }
    const trees: THREE.Matrix4[][] = [[], [], []];
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      if (rows[y][x] !== 'T') continue;
      const c = cellCenter([x, y]);
      const m = new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * 6.28), new THREE.Vector3(1, 0.9 + Math.random() * 0.4, 1));
      trees[(x + y) % 3].push(m);
    }
    trees.forEach((ms, v) => {
      const mesh = new THREE.InstancedMesh(variants[v], bark, ms.length);
      ms.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = true;
      this.group.add(mesh);
    });
  }

  private instances: ModelInstances[] = [];

  private async buildProps() {
    const stone = std(0x55554f, 0.95);
    void applyPbr(stone, 'concrete', { tint: 0x8a8a84 });
    const head = new THREE.BoxGeometry(0.7, 1.1, 0.18);
    head.translate(0, 0.55, 0);
    const props = map.props as { kind: string; cell: number[]; rot: number }[];
    const stones = props.filter((p) => p.kind === 'headstone');
    const hs = new THREE.InstancedMesh(head, stone, stones.length);
    stones.forEach((p, i) => {
      const c = cellCenter(p.cell);
      hs.setMatrixAt(i, new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromAxisAngle(UP, p.rot), new THREE.Vector3(1, 0.8 + (i % 3) * 0.15, 1)));
    });
    hs.castShadow = true;
    this.group.add(hs);

    let seed = 777;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const place: Record<string, THREE.Matrix4[]> = {};
    const put = (id: string, x: number, z: number, yaw: number, scale = 1, y = 0) => {
      (place[id] ??= []).push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(scale, scale, scale)));
    };
    /** a point hugging the nearest wall of an open cell, facing out of it */
    const nearWall = (cx: number, cy: number, inset = 0.45): [number, number, number] | null => {
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        if (!isSolidCell(cx + dx, cy + dy)) continue;
        const c = cellCenter([cx, cy]);
        return [c.x + dx * (CELL / 2 - inset), c.z + dy * (CELL / 2 - inset), Math.atan2(-dx, -dy)];
      }
      return null;
    };

    // the generator's props
    const modelFor: Record<string, string[]> = {
      car: ['covered_car'], hydrant: ['fire_hydrant'], barrel: ['barrel_03'], crate: ['wooden_crate_01', 'plastic_crate_01'],
      boxes: ['cardboard_box_01'], cone: ['concrete_road_barrier'], bed: ['old_bed_frame'], wheelchair: ['wheelchair_01'],
    };
    for (const p of props) {
      if (p.kind === 'headstone') continue;
      const ids = modelFor[p.kind];
      if (!ids) continue;
      const c = cellCenter(p.cell);
      const id = ids[Math.floor(rnd() * ids.length)];
      if (p.kind === 'car' || p.kind === 'bed' || p.kind === 'wheelchair') put(id, c.x + (rnd() - 0.5) * 0.8, c.z + (rnd() - 0.5) * 0.8, p.rot);
      else {
        const w = nearWall(p.cell[0], p.cell[1], 0.5);
        if (w) put(id, w[0], w[1], w[2] + (rnd() - 0.5) * 0.6);
      }
    }

    // dressing the town
    for (let y = 1; y < GRID - 1; y++) for (let x = 1; x < GRID - 1; x++) {
      const t = rows[y][x];
      const c = cellCenter([x, y]);
      const h = (x * 73856093) ^ (y * 19349663);
      const roll = ((h >>> 0) % 1000) / 1000;
      if (t === '.' && roll < 0.025) put('water_manhole_cover', c.x + (rnd() - 0.5), c.z + (rnd() - 0.5), rnd() * 6.28, 1, 0.005);
      if (t === ',' || t === 'a') {
        const w = nearWall(x, y, 0.45);
        if (w && roll < 0.05) put('metal_trash_can', w[0], w[1], w[2]);
        else if (w && roll < 0.11) put('trashbag', w[0] + (rnd() - 0.5), w[1] + (rnd() - 0.5), rnd() * 6.28, 1 + rnd() * 0.3);
        else if (w && roll < 0.13) put('utility_box_01', w[0], w[1], w[2]);
      }
      if (t === 'A') {
        const w = nearWall(x, y, 0.55);
        if (w && roll < 0.05) put('metal_office_desk', w[0], w[1], w[2]);
        else if (w && roll < 0.08) put('worn_metal_rack', w[0], w[1], w[2]);
        else if (roll < 0.1) put('SchoolChair_01', c.x + (rnd() - 0.5), c.z + (rnd() - 0.5), rnd() * 6.28);
        else if (w && roll < 0.11) put('Television_01', w[0], w[1], w[2]);
      }
      if (t === 'H') {
        const w = nearWall(x, y, 0.4);
        if (roll < 0.03) put('WetFloorSign_01', c.x + (rnd() - 0.5), c.z + (rnd() - 0.5), rnd() * 6.28);
        else if (w && roll < 0.05) put('vintage_crutches_01', w[0], w[1], w[2] + 0.3);
        else if (w && roll < 0.07) put('tool_cart', w[0], w[1], w[2]);
      }
      if (t === 'S') {
        const w = nearWall(x, y, 0.5);
        if (w && roll < 0.05) put('painted_wooden_bench', w[0], w[1], w[2]);
        else if (w && roll < 0.08) put('metal_trash_can', w[0], w[1], w[2]);
        else if (roll < 0.1) put('concrete_road_barrier', c.x, c.z, Math.floor(rnd() * 4) * 1.57);
      }
      if ((t === 'p' || t === 'T') && roll < 0.04 && t === 'p') put('tree_stump_01', c.x + (rnd() - 0.5), c.z + (rnd() - 0.5), rnd() * 6.28, 0.8 + rnd() * 0.4);
      if ((t === '0' || t === '2') && roll < 0.25) {
        const w = nearWall(x, y, 0.4);
        if (w) put('worn_metal_rack', w[0], w[1], w[2]);
      }
    }
    // a cash register on each shop counter, a camera watching every door
    for (const sh of map.shops) {
      const c = cellCenter(sh.counter);
      put('CashRegister_01', c.x, c.z, 0, 1, 0.9);
      put('metal_office_desk', c.x, c.z, 0, 0.9);
    }
    for (const d of [...map.shops.map((s) => s.door), ...map.landmarks.map((l) => l.door)]) {
      const [cx, cy] = d;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const tt = tileAt(cx + dx, cy + dy);
        if (tt !== '.' && tt !== ',' && tt !== 'a') continue;
        const c = cellCenter(d);
        put('security_camera_01', c.x + dx * 1.45 + dy * 1.2, c.z + dy * 1.45 + dx * 1.2, Math.atan2(dx, dy), 1.4, 3.3);
        break;
      }
    }
    // the park: a statue at the crossing of the paths, an iron gate at the way in
    put('gothic_statue', 44.5 * CELL + 1.5, 51.5 * CELL, -Math.PI / 2, 1.3);
    put('large_iron_gate', 39.5 * CELL + 1.5, 42.5 * CELL, 0, 1);
    for (let k = 0; k < 6; k++) put('painted_wooden_bench', (36 + k * 3.5) * CELL, 51.5 * CELL - 1.8, 0);

    const budget: Record<string, number> = { covered_car: 10, water_manhole_cover: 12, trashbag: 20, metal_trash_can: 14, SchoolChair_01: 16, worn_metal_rack: 16 };
    for (const [id, ms] of Object.entries(place)) {
      const inst = await ModelInstances.create(id, ms, budget[id] ?? 12, id !== 'water_manhole_cover' && id !== 'trashbag');
      if (inst) {
        this.group.add(inst.group);
        this.instances.push(inst);
      } else if (id === 'covered_car') {
        // fallback cars if the model is missing
        for (const m of ms) {
          const car = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 4.3), std(0x1e2a33, 0.25, 0.6));
          car.applyMatrix4(m);
          car.position.y = 0.6;
          this.group.add(car);
        }
      }
    }

    // real street lamps replace the stand-in poles once the model is here
    const lamps = await ModelInstances.create('street_lamp_01', this.lampMatrices, 18);
    if (lamps) {
      // the model's bulbs always glow; per-lamp emitters (dead / flickering) show through the glass instead
      lamps.group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && /bulb/i.test(m.name)) m.emissiveIntensity = 0;
      });
      this.group.add(lamps.group);
      this.instances.push(lamps);
      for (const m of this.standInLamps) m.visible = false;
    }
  }

  // ------------------------------------------------------------------ fuse boxes, the bridge gate
  private buildObjectives() {
    map.fuseCells.forEach((cell) => {
      const g = new THREE.Group();
      g.position.copy(cellCenter(cell));
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.28), std(0x4a4f4a, 0.45, 0.65));
      box.position.y = 1.3;
      box.castShadow = true;
      const lampMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a10, emissiveIntensity: 3 });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), lampMat);
      lamp.position.set(0, 1.6, 0.16);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.13), new THREE.MeshBasicMaterial({ map: label('FUSE', { bg: '#d9c34a' }) }));
      sign.position.set(0, 1.12, 0.15);
      g.add(box, lamp, sign);
      g.rotation.y = this.faceOpen(cell);
      this.group.add(g);
      const source = this.addSource({ pos: g.localToWorld(new THREE.Vector3(0, 1.6, 0.6)), color: new THREE.Color(0xff3010), intensity: 3, distance: 6, mode: 'on', outdoor: false });
      this.fuseBoxes.push({ group: g, lamp: lampMat, source });
    });

    // the bridge gate: electrified, red until the town has power
    const [gx, gy] = map.exitCell;
    const c = cellCenter([gx, gy]);
    this.exitDoor = new THREE.Group();
    const bars = std(0x2a2c2e, 0.4, 0.85);
    void applyPbr(bars, 'metal', { tint: 0x8a8a8a, roughnessScale: 0.6 });
    for (let k = -4; k <= 4; k++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 4.2, 0.08), bars);
      bar.position.set(0, 2.1, k * 1.05);
      bar.castShadow = true;
      this.exitDoor.add(bar);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 9), bars);
    rail.position.y = 3.9;
    const rail2 = rail.clone();
    rail2.position.y = 0.4;
    this.exitDoor.add(rail, rail2);
    this.exitDoor.position.set(c.x + 1.2, 0, c.z);
    this.exitSign = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a0a, emissiveIntensity: 3, map: label('NO POWER', { bg: '#ff2a1a', fg: '#2a0000' }) });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), this.exitSign);
    sign.position.set(c.x + 1.1, 4.6, c.z);
    sign.rotation.y = -Math.PI / 2;
    this.exitSource = this.addSource({ pos: new THREE.Vector3(c.x - 1, 4.8, c.z), color: new THREE.Color(0xff2010), intensity: 14, distance: 20, mode: 'on', outdoor: true });
    // the bridge beyond, disappearing into the fog
    const deck = new THREE.Mesh(new THREE.BoxGeometry(60, 0.4, 8), std(0x2a2a2a, 0.8));
    void applyPbr(deck.material as THREE.MeshStandardMaterial, 'asphalt', { tint: 0x5a5a5e, roughnessScale: 0.5 });
    deck.position.set(c.x + 31.5, -0.15, c.z);
    deck.receiveShadow = true;
    this.group.add(this.exitDoor, sign, deck);
  }

  private faceOpen(cell: number[]): number {
    const [x, y] = cell;
    const dirs: [number, number, number][] = [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]];
    let best = 0, bestRun = -1;
    for (const [dx, dy, angle] of dirs) {
      let run = 0;
      while (run < 6 && !isSolidCell(x + dx * (run + 1), y + dy * (run + 1))) run++;
      if (run > bestRun) { bestRun = run; best = angle; }
    }
    return best;
  }

  // ------------------------------------------------------------------ rain
  private buildRain() {
    const N = 2600;
    this.rainPos = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 40, y = Math.random() * 18, z = (Math.random() - 0.5) * 40;
      this.rainPos.set([x, y, z, x + 0.02, y + 0.55, z + 0.02], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fb2c4, transparent: true, opacity: 0.32, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  // ------------------------------------------------------------------ runtime
  pulse(strength = 1) {
    this.blockPulse = Math.max(this.blockPulse, 0.3 * strength);
  }

  blackout(at: THREE.Vector3, seconds: number, now: number) {
    this.darkUntil = now + seconds * 1000;
    this.darkCenter.copy(at);
  }

  setFuse(i: number, done: boolean) {
    const f = this.fuseBoxes[i];
    if (!f) return;
    f.lamp.emissive.set(done ? 0x30ff60 : 0xff2a10);
    f.source.color.set(done ? 0x30ff60 : 0xff3010);
  }

  setExitOpen(open: boolean) {
    this.exitOpen = open ? 1 : 0;
    this.exitSign.emissive.set(open ? 0x40ff70 : 0xff1a0a);
    this.exitSign.map = label(open ? 'GATE OPEN' : 'NO POWER', { bg: open ? '#30ff60' : '#ff2a1a', fg: '#002a00' });
    this.exitSource.color.set(open ? 0x50ff80 : 0xff2010);
  }

  flare(at: THREE.Vector3, now: number) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.8, 0.5), toneMapped: false }));
    mesh.position.copy(at).setY(0.1);
    mesh.rotation.z = Math.PI / 2.4;
    this.group.add(mesh);
    const source = this.addSource({ pos: at.clone().setY(0.5), color: new THREE.Color(0xff2a1a), intensity: 14, distance: 16, mode: 'on', outdoor: true, until: now + 25000 });
    this.flares.push({ mesh, source });
  }

  /** a camera flash somebody fired */
  flashAt(at: THREE.Vector3) {
    const light = this.pool[this.pool.length - 1];
    this.flashes.push({ light, t: 0 });
    light.position.copy(at);
  }

  update(now: number, dt: number, viewer: THREE.Vector3, chaos: number) {
    this.blockPulse = Math.max(0, this.blockPulse - dt * 4);
    const dark = now < this.darkUntil;
    const col = new THREE.Color();
    const touched = new Set<THREE.InstancedMesh>();
    for (const l of this.sources) {
      let level = 1;
      if (l.until !== undefined) level = now < l.until ? 0.85 + Math.random() * 0.3 : 0;
      else if (l.mode === 'dead') level = 0;
      else if (l.mode === 'flicker') {
        const t = now / 1000 + l.phase;
        level = l.sign ? (Math.sin(t * 17) > 0.93 ? 0.1 : 1) : Math.sin(t * 13) > 0.6 || Math.sin(t * 3.1 + l.phase) > 0.85 ? 0.04 : 1;
      }
      if (chaos > 0 && Math.random() < chaos * 0.015) level *= 0.1;
      if (dark && l.pos.distanceTo(this.darkCenter) < 22) level = 0;
      if (!l.until) level *= 1 - this.blockPulse;
      if (Math.abs(level - l.level) > 0.01 || !touched.size) {
        if (l.emitter) {
          col.copy(l.emitter.base).multiplyScalar(Math.max(level, 0.02));
          l.emitter.mesh.setColorAt(l.emitter.index, col);
          touched.add(l.emitter.mesh);
        }
        if (l.cone) {
          col.setRGB(0.05, 0.032, 0.018).multiplyScalar(level);
          l.cone.mesh.setColorAt(l.cone.index, col);
          touched.add(l.cone.mesh);
        }
        if (l.sign) l.sign.emissiveIntensity = 1.6 * level;
      }
      l.level = level;
    }
    for (const m of touched) if (m.instanceColor) m.instanceColor.needsUpdate = true;

    // the pool of real lights goes to the sources that matter most here
    const scored = this.sources
      .filter((l) => l.level > 0.02 && Math.abs(l.pos.x - viewer.x) < 30 && Math.abs(l.pos.z - viewer.z) < 30)
      .map((l) => ({ l, score: (l.intensity * l.level) / (1 + l.pos.distanceToSquared(viewer)) }))
      .sort((a, b) => b.score - a.score);
    const usable = this.flashes.length ? this.pool.length - 1 : this.pool.length;
    for (let i = 0; i < usable; i++) {
      const p = this.pool[i];
      const e = scored[i]?.l;
      if (!e) {
        p.intensity = 0;
        continue;
      }
      p.position.copy(e.pos);
      p.color.copy(e.color);
      p.distance = e.distance;
      p.intensity = e.intensity * e.level;
    }
    this.flashes = this.flashes.filter((f) => {
      f.t += dt;
      f.light.color.set(0xf4f8ff);
      f.light.distance = 14;
      f.light.intensity = 40 * Math.max(0, 1 - f.t / 0.15);
      return f.t < 0.15;
    });

    // lit windows flicker like TVs behind curtains
    for (let i = 0; i < this.litPhase.length; i++) {
      const t = now / 1000 + this.litPhase[i];
      const v = 0.3 + 0.12 * Math.sin(t * 0.7) + (Math.sin(t * 9.1) > 0.97 ? -0.2 : 0);
      col.setRGB(1.0 * v, 0.7 * v, 0.4 * v);
      this.windowsLit.setColorAt(i, col);
    }
    if (this.windowsLit.instanceColor) this.windowsLit.instanceColor.needsUpdate = true;

    // rain follows the camera, hidden indoors
    const indoors = isIndoor(viewer.x, viewer.z);
    this.rain.visible = !indoors;
    if (!indoors) {
      const p = this.rainPos;
      const fall = dt * 16;
      for (let i = 0; i < p.length; i += 6) {
        p[i + 1] -= fall;
        p[i + 4] -= fall;
        if (p[i + 1] < 0) {
          const x = viewer.x + (Math.random() - 0.5) * 40, z = viewer.z + (Math.random() - 0.5) * 40, y = 14 + Math.random() * 6;
          p[i] = x; p[i + 1] = y; p[i + 2] = z;
          p[i + 3] = x + 0.03; p[i + 4] = y + 0.55; p[i + 5] = z + 0.03;
        }
      }
      (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // lightning
    if (now > this.nextFlash) {
      this.nextFlash = now + 25000 + Math.random() * 50000;
      this.boltAt = now;
      setTimeout(() => this.onThunder?.(), 600 + Math.random() * 1600);
    }
    const since = now - this.boltAt;
    this.lightning.intensity = since < 450 ? (Math.sin(since / 30) > 0 ? 2.4 : 0.6) * (1 - since / 450) * (indoors ? 0.15 : 1) : 0;

    if (this.exitOpen) this.exitDoor.position.y = Math.min(this.exitDoor.position.y + dt * 0.8, 4.5);
    for (const inst of this.instances) inst.update(now, viewer);
    // cheap distance culling for props (fog hides them anyway)
    for (const o of this.propObjs) o.visible = Math.abs(o.position.x - viewer.x) < 45 && Math.abs(o.position.z - viewer.z) < 45;
    this.flares = this.flares.filter((f) => {
      if (f.source.until! > now) return true;
      this.group.remove(f.mesh);
      this.sources.splice(this.sources.indexOf(f.source), 1);
      return false;
    });
  }

  ambientAt(pos: THREE.Vector3): number {
    let best = 0;
    for (const l of this.sources) {
      if (l.level <= 0.02 || l.sign) continue;
      const d2 = (l.pos.x - pos.x) ** 2 + (l.pos.z - pos.z) ** 2;
      const r2 = l.outdoor ? 64 : 36;
      if (d2 < r2) best = Math.max(best, l.level * (1 - d2 / r2));
    }
    return best;
  }
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  let offset = 0;
  for (const p of parts) {
    const g = p.index ? p : p;
    const P = g.attributes.position.array as ArrayLike<number>;
    const N = g.attributes.normal.array as ArrayLike<number>;
    for (let i = 0; i < P.length; i++) pos.push(P[i]);
    for (let i = 0; i < N.length; i++) nrm.push(N[i]);
    const I = g.index!.array;
    for (let i = 0; i < I.length; i++) idx.push(I[i] + offset);
    offset += P.length / 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setIndex(idx);
  return out;
}
