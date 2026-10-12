// Verifies the optimized assets load in three.js (the version the web app uses).
// usage (from tools/assets): node verify-three.mjs ../../web/node_modules/three ../../web/public/assets
// Loads every GLB in manifest.json with GLTFLoader + MeshoptDecoder (image decoding stubbed for Node)
// and checks the bounding box against the manifest size.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [threeDir, assetsDir] = process.argv.slice(2);
const THREE = await import(pathToFileURL(path.join(threeDir, 'build/three.module.js')));
const { GLTFLoader } = await import(pathToFileURL(path.join(threeDir, 'examples/jsm/loaders/GLTFLoader.js')));
const { MeshoptDecoder } = await import(pathToFileURL(path.join(threeDir, 'examples/jsm/libs/meshopt_decoder.module.js')));
globalThis.self = globalThis;
globalThis.createImageBitmap = () => {};
globalThis.Image = class { set src(v) { setTimeout(() => { this.height = 1; this.onload?.(); }); } }; // WebP support probe
let images = 0;
THREE.ImageBitmapLoader.prototype.load = function (url, onLoad) { images++; setTimeout(() => onLoad({ width: 1, height: 1, close() {} })); return {}; };
const manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8'));
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let fail = 0;
for (const [id, m] of Object.entries(manifest.models)) {
  const buf = fs.readFileSync(path.join(assetsDir, m.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  images = 0;
  try {
    const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));
    let meshes = 0, tris = 0; const mats = new Set();
    gltf.scene.traverse((o) => { if (o.isMesh) { meshes++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; [].concat(o.material).forEach((x) => mats.add(x.type)); } });
    const box = new THREE.Box3().setFromObject(gltf.scene, true); const s = box.getSize(new THREE.Vector3());
    const d = Math.max(Math.abs(s.x - m.size[0]), Math.abs(s.y - m.size[1]), Math.abs(s.z - m.size[2]));
    console.log(`${d < 0.03 ? 'OK ' : 'BBOX?'} ${id.padEnd(28)} meshes=${meshes} tris=${tris} images=${images} size=${[s.x, s.y, s.z].map((v) => v.toFixed(2)).join('x')} mats=${[...mats].join('/')}`);
    if (d >= 0.03) fail++;
  } catch (e) { fail++; console.log(`FAIL ${id}: ${e.message}`); }
}
console.log(fail ? `${fail} problems` : 'all models loaded in three.js');
