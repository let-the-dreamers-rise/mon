// usage: node inspect-nodes.mjs <file.glb> — prints top-level nodes with triangle counts and bounds
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
const tris = (node) => {
  let n = 0;
  node.traverse((c) => { const m = c.getMesh(); if (m) for (const p of m.listPrimitives()) n += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3; });
  return n;
};
for (const node of scene.listChildren()) {
  const b = getBounds(node);
  const sz = b.max.map((v, i) => (v - b.min[i]).toFixed(2));
  console.log(`${node.getName().padEnd(44)} tris ${String(tris(node)).padStart(7)}  t=[${node.getTranslation().map((v) => v.toFixed(2))}]  size=[${sz}]  min=[${b.min.map((v) => v.toFixed(3))}] max=[${b.max.map((v) => v.toFixed(3))}]`);
}
const mats = doc.getRoot().listMaterials().map((m) => `${m.getName()}(${m.getAlphaMode()}${m.getEmissiveTexture() ? ',emissive' : ''})`);
console.log('materials:', mats.join(', '));
console.log('extensions:', doc.getRoot().listExtensionsUsed().map((e) => e.extensionName).join(', '));
