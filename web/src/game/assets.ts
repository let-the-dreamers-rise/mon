import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BASE = `${import.meta.env.BASE_URL}assets/`;

interface Manifest {
  textures?: Record<string, { diff: string; nor: string; rough: string; repeatMeters?: number }>;
  hdri?: string;
  models?: Record<string, { file: string; size?: number[] }>;
}

let manifest: Manifest | null = null;
const texLoader = new THREE.TextureLoader();
const gltf = new GLTFLoader();
gltf.setMeshoptDecoder(MeshoptDecoder);
const modelCache = new Map<string, Promise<THREE.Group | null>>();

export async function loadManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  try {
    const r = await fetch(BASE + 'manifest.json');
    manifest = r.ok ? await r.json() : {};
  } catch {
    manifest = {};
  }
  return manifest!;
}

function tex(path: string, srgb: boolean): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    texLoader.load(
      BASE + path,
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        resolve(t);
      },
      undefined,
      () => resolve(null),
    );
  });
}

/** Upgrade a material in place with a photo-scanned PBR set, if the asset pack has it. */
export async function applyPbr(mat: THREE.MeshStandardMaterial, slot: string, opts: { tint?: number; roughnessScale?: number; normalScale?: number } = {}) {
  const m = await loadManifest();
  const set = m.textures?.[slot];
  if (!set) return false;
  const [d, n, r] = await Promise.all([tex(set.diff, true), tex(set.nor, false), tex(set.rough, false)]);
  if (!d) return false;
  mat.map = d;
  if (n) {
    mat.normalMap = n;
    mat.normalScale.setScalar(opts.normalScale ?? 1);
  }
  if (r) mat.roughnessMap = r;
  mat.roughness = opts.roughnessScale ?? 1;
  if (opts.tint !== undefined) mat.color.set(opts.tint);
  mat.needsUpdate = true;
  return true;
}

export async function loadEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const m = await loadManifest();
  if (!m.hdri) return;
  try {
    const hdr = await new RGBELoader().loadAsync(BASE + m.hdri);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    scene.environmentIntensity = 0.12;
    hdr.dispose();
    pmrem.dispose();
  } catch {
    /* fine without it */
  }
}

/** A Poly Haven model, normalised so it sits on the ground and casts shadows. */
export function loadModel(id: string): Promise<THREE.Group | null> {
  let p = modelCache.get(id);
  if (!p) {
    p = (async () => {
      const m = await loadManifest();
      const entry = m.models?.[id];
      if (!entry) return null;
      try {
        const g = await gltf.loadAsync(BASE + entry.file);
        const root = g.scene;
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
        const box = new THREE.Box3().setFromObject(root);
        root.position.y -= box.min.y;
        const wrap = new THREE.Group();
        wrap.add(root);
        return wrap;
      } catch {
        return null;
      }
    })();
    modelCache.set(id, p);
  }
  return p;
}

/** the full glTF (scene + animations), cached */
const gltfCache = new Map<string, Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] } | null>>();
export function loadGltf(path: string) {
  let p = gltfCache.get(path);
  if (!p) {
    p = gltf.loadAsync(BASE + path).then(
      (g) => ({ scene: g.scene, animations: g.animations }),
      () => null,
    );
    gltfCache.set(path, p);
  }
  return p;
}

export async function hasModel(id: string) {
  const m = await loadManifest();
  return !!m.models?.[id];
}

/**
 * Many copies of one model, drawn as InstancedMeshes. Only the `maxVisible` copies nearest the
 * viewer are drawn (the fog hides the rest), so a town full of props stays cheap.
 */
export class ModelInstances {
  readonly group = new THREE.Group();
  private parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }[] = [];
  private positions: THREE.Vector3[];
  private lastPick = 0;
  private tmp = new THREE.Matrix4();

  private constructor(private matrices: THREE.Matrix4[], private maxVisible: number) {
    this.positions = matrices.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
  }

  static async create(id: string, matrices: THREE.Matrix4[], maxVisible = 24, shadows = true): Promise<ModelInstances | null> {
    const model = await loadModel(id);
    if (!model || !matrices.length) return null;
    const inst = new ModelInstances(matrices, Math.min(maxVisible, matrices.length));
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mesh = new THREE.InstancedMesh(m.geometry, m.material, inst.maxVisible);
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      inst.parts.push({ mesh, local: m.matrixWorld.clone() });
      inst.group.add(mesh);
    });
    return inst;
  }

  update(now: number, viewer: THREE.Vector3) {
    if (now - this.lastPick < 350) return;
    this.lastPick = now;
    const order = this.positions
      .map((p, i) => ({ i, d: (p.x - viewer.x) ** 2 + (p.z - viewer.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.maxVisible);
    for (const part of this.parts) {
      order.forEach(({ i }, k) => {
        this.tmp.multiplyMatrices(this.matrices[i], part.local);
        part.mesh.setMatrixAt(k, this.tmp);
      });
      part.mesh.count = order.length;
      part.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
