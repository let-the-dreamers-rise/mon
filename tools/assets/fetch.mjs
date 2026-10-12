#!/usr/bin/env node
/**
 * HOLLOW asset pipeline — downloads CC0 assets from Poly Haven and writes
 * web-ready versions to web/public/assets/:
 *
 *   textures/<slot>_{diff,nor,rough}.jpg   1k PBR maps (normal = OpenGL / +Y convention)
 *   hdri/night_1k.hdr                      1k equirect night sky
 *   models/<id>.glb                        weld/dedup/prune(+simplify), WebP textures,
 *                                          EXT_meshopt_compression + KHR_mesh_quantization
 *   manifest.json, CREDITS.md
 *
 * Usage (from tools/assets, after `npm ci`):
 *   node fetch.mjs [--dl <download cache dir>] [--out <assets dir>]
 *                  [--only textures,hdri,models,meta] [--ids id1,id2]
 *   --ids limits textures (slot or Poly Haven id) / models (id); manifest entries of others are kept.
 * Verify afterwards:  node verify-three.mjs ../../web/node_modules/three ../../web/public/assets
 *                     npx gltf-transform validate ../../web/public/assets/models/<id>.glb
 *
 * Raw downloads are cached in --dl (default: $TMPDIR/hollow-assets-dl), one
 * subfolder per asset. Downloads use `curl` so HTTPS_PROXY / system CAs apply.
 * Everything Poly Haven publishes is CC0; authors are credited in CREDITS.md.
 *
 * three.js loading note: models need MeshoptDecoder
 *   import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
 *   gltfLoader.setMeshoptDecoder(MeshoptDecoder);
 * All models are Y-up, metres (Poly Haven assets are real-world scale).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, simplify, flatten, join, meshopt, textureCompress,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.polyhaven.com';

// ---------------------------------------------------------------- selection

/** Texture slots -> Poly Haven texture id. repeatMeters = metres covered by one tile
 *  (Poly Haven's published real-world dimensions for the scan). */
export const TEXTURES = {
  asphalt:   { id: 'asphalt_02',           note: 'grey cracked road asphalt; for the rain look darken albedo and scale roughness down (~0.3-0.5x)' },
  sidewalk:  { id: 'concrete_pavement_02', note: 'large concrete sidewalk slabs' },
  brick:     { id: 'brick_wall_10',        note: 'dark weathered brick facade' },
  concrete:  { id: 'concrete_wall_006',    note: 'stained, chipped concrete wall (facades, subway station)' },
  plaster:   { id: 'painted_plaster_wall', note: 'weathered painted plaster wall (hospital)' },
  tiles:     { id: 'worn_tile_floor',      note: 'old dirty square floor tiles (hospital / station)' },
  carpet:    { id: 'dirty_carpet',         note: 'dirty faded carpet (office); small tile, repeat often' },
  // wallpaper: skipped — Poly Haven has no patterned yellow wallpaper (closest, decrepit_wallpaper, is plain
  // beige stained plaster-like); the game uses its procedural backrooms wallpaper.
  metal:     { id: 'rusty_metal_sheet',    note: 'flat rusty steel sheet (gates, shutters, doors); metalness ~0.6-1' },
  wood:      { id: 'weathered_planks',     note: 'worn grey-brown planks (fences, shop floors)' },
  ground:    { id: 'mud_forest',           note: 'dark wet mud with leaf litter (park / cemetery)' },
};

export const HDRI = { id: 'kloppenheim_04', note: 'overcast misty night field, sodium light-pollution glow on the horizon' };

/**
 * Models. Options:
 *   tex       max texture size (px) for every texture of the model
 *   simplify  meshopt simplifier error (fraction of mesh extent); omit = keep full geometry
 *   kit       modular set: keep named nodes separate (pick parts by node name)
 *   lockBorder  lock open mesh borders when simplifying
 *   parts     keep named nodes separate (movable parts: doors, drawers, lids, clock hands...)
 *   keep/drop regex on top-level node names (Poly Haven often ships 2 showcase variants side by side)
 *   anchor    after keep/drop, shift the model in X/Z so this node's origin becomes the model origin
 *   center    shift the model in X/Z so its bounding-box centre is at the origin
 *   pivots    move part origins to hinge lines (see setPivots); mask = regex of materials to make alpha-tested
 *   groups    [groupName, nodePrefix, originNode]: re-parent prefix* nodes under a new group node whose
 *             origin is originNode's translation, and join them into one mesh (assembled presets)
 * Everything else is merged into as few meshes as possible (flatten + join).
 */
export const MODELS = {
  // --- requested
  street_lamp_01:            { tex: 1024, note: 'ornate cast-iron street lamp post, 3.9 m, origin at base; Main Street / park. Bulb material street_lamp_01_bulb is warm-emissive, glass is blended; add a PointLight/SpotLight ~3.5 m up' },
  street_lamp_02:            { tex: 512, note: 'wall-mounted cast-iron lantern on a bracket: origin at the wall mount, wall plane z=0, lantern projects +Z (bulb material street_lamp_02_bulb is warm-emissive); building facades, station entrance' },
  fire_hydrant:              { tex: 512, simplify: 0.001, keep: /_aged$/, anchor: 'fire_hydrant_aged', note: 'weathered red cast-iron fire hydrant (aged variant), origin at base; sidewalks' },
  covered_car:               { tex: 1024, note: 'car hidden under a dusty fabric cover (4.4 m long, along Z), origin at ground; streets, parking lots' },
  modular_chainlink_fence:   { tex: 512, kit: true, simplify: 0.001, mask: /wire/, note: 'chain-link fence kit (~2.5 m tall): ~1 m panel (modular_chainlink_fence), ~2 m panel (modular_chainlink_fence_double), posts, corners, brackets, gate (door_frame/door_gate/door_latch). Kit pieces are laid out side by side - reset each part position when instancing. Wire material is alpha-tested (MASK, double-sided)' },
  modular_electricity_poles: { tex: 512, kit: true, simplify: 0.006,
    keep: /^(preset_0[123]_|pole(_large|_small)?$|connection_large_01$|connection_small_01$|transformer_01$|insulators_large$)/,
    groups: [['preset_01', 'preset_01_', 'preset_01_pole'], ['preset_02', 'preset_02_', 'preset_02_pole'], ['preset_03', 'preset_03_', 'preset_03_pole']],
    note: 'wooden utility pole kit. preset_01/02/03 = fully assembled ~6 m poles (one mesh each, group origin at pole base) - use these along streets; loose pieces kept for custom variants: pole, pole_large, pole_small (bare), connection_large_01 / connection_small_01 (crossarms with insulators), insulators_large, transformer_01 - laid out side by side, reset position when instancing (other tiny loose bolts/rings dropped)' },
  wheelchair_01:             { tex: 1024, simplify: 0.001, note: 'old hospital wheelchair, origin at ground; hospital corridors' },
  old_bed_frame:             { tex: 1024, simplify: 0.001, note: 'rusty iron hospital bed frame with spring base (2 m, along Z), origin at ground; hospital wards' },
  cardboard_box_01:          { tex: 256, note: 'taped cardboard box, origin at base; offices, shops, alleys' },
  barrel_03:                 { tex: 256, note: 'blue steel 200 L drum; alleys, industrial areas' },
  wooden_crate_01:           { tex: 512, parts: true, note: 'old wooden chest-crate; nodes: wooden_crate_01 (box), _lid, _latch (lid can be opened); storage rooms' },
  plastic_crate_01:          { tex: 256, note: 'red plastic milk crate; shops, alleys' },
  painted_wooden_bench:      { tex: 512, note: 'painted wooden bench with backrest; station platforms, hospital waiting room' },
  industrial_wall_lamp:      { tex: 256, note: 'caged bulkhead wall lamp with frosted glass (emissive map); back on wall plane z=0, faces +Z; subway, back alleys, stairwells' },
  hanging_industrial_lamp:   { tex: 256, note: 'enamel industrial pendant lamp on a chain (emissive map); origin at the ceiling mount, hangs down 1.34 m; warehouses, station' },
  tool_cart:                 { tex: 512, note: 'green metal trolley cart with drawers; hospital, workshop' },
  // --- extras that fit HALDEN
  metal_trash_can:           { tex: 512, parts: true, keep: /_rust/, anchor: 'metal_trash_can_rust', note: 'rusty galvanised trash can; lid (metal_trash_can_rust_lid) lies leaning beside it; sidewalks, alleys' },
  trashbag:                  { tex: 256, note: 'black garbage bag; sidewalks, alleys' },
  water_manhole_cover:       { tex: 512, parts: true, note: 'cast-iron "WATER" manhole cover (node water_manhole_cover, liftable) + frame; 7 cm thick, y=0 ~ road surface; roads' },
  utility_box_01:            { tex: 512, note: 'grey electrical utility cabinet with DANGER sticker; sidewalks' },
  concrete_road_barrier:     { tex: 512, simplify: 0.001, note: 'concrete road barrier block with black/white stripes; roadblocks, closed streets' },
  rollershutter_door:        { tex: 512, drop: /graffiti/, note: 'closed roller shutter for a shop door (1.1 x 2.4 m incl. housing; wall plane z=0, faces +Z); Main Street shop fronts' },
  rollershutter_window_01:   { tex: 512, drop: /graffiti/, note: 'closed roller shutter for a shop window (2.1 x 1.85 m incl. housing; wall plane z=0, faces +Z); Main Street shop fronts' },
  modular_fire_escape:       { tex: 512, kit: true, note: 'black steel fire escape kit: platform_bottom/middle, platform_railing, railing_bottom/middle, stairs, ladder_bottom; pieces are stacked as an assembled example (~9.8 m); brick facades' },
  security_light:            { tex: 256, note: 'wall-mounted dome yard / security light (bulb material warm-emissive); wall plane ~z=0, projects +Z; warehouses, parking lots' },
  mounted_fluorescent_lights:{ tex: 256, parts: true, note: 'ceiling fluorescent tube fixtures (0.91 m), 7 variants = nodes mounted_fluorescent_lights_a.._g laid 0.1 m apart along Z (reset position when instancing); ceiling at y=0, tube material emissive; office (backrooms), hospital, station' },
  caged_hanging_light:       { tex: 256, note: 'caged fluorescent fixture hanging 0.75 m on two wires (emissive map), ceiling at y=0; subway, industrial rooms' },
  metal_office_desk:         { tex: 512, parts: true, note: 'grey steel office desk; drawers (_drawer_01.._06) and trays are separate nodes (slide along Z); office / backrooms' },
  worn_metal_rack:           { tex: 512, note: 'worn metal shelving rack; shops, storage, hospital supply room' },
  WetFloorSign_01:           { tex: 256, note: 'yellow "CAUTION WET FLOOR" A-frame sign; hospital, station, office' },
  power_box_01:              { tex: 512, parts: true, note: 'wall fuse / breaker box (back on the wall plane, faces +Z); door node power_box_01_door is open ~90 deg, its origin is on the hinge (x=-0.16) - rotate around Y; power puzzles, basements' },
  Television_01:             { tex: 256, note: 'old CRT television; apartments, waiting rooms (screen could take a static video texture)' },
  CashRegister_01:           { tex: 256, parts: true, note: 'vintage mechanical cash register; drawer node CashRegister_011_drawer is pulled out ~0.19 m along +Z (slide back to close); shop counters' },
  wall_clock:                { tex: 256, parts: true, note: 'round office wall clock (back at z=0, faces +Z); hands are separate nodes wall_clock_hours_hand / _minute_hand / _second_hand pivoting at the origin - rotate around Z; office, hospital, station' },
  vintage_crutches_01:       { tex: 256, note: 'pair of old wooden crutches; hospital' },
  SchoolChair_01:            { tex: 256, note: 'plastic-shell steel chair; hospital waiting room, office' },
  security_camera_01:        { tex: 256, note: 'wall-mounted CCTV camera; station, shops, hospital' },
  large_iron_gate:           { tex: 512, parts: true,
    pivots: { large_iron_gate_left_door: ['min', null, 'center'], large_iron_gate_right_door: ['max', null, 'center'] },
    note: 'double wrought-iron gate ~3 x 2.9 m (closed, in the XY plane); door nodes large_iron_gate_left_door / _right_door have their origin on the hinge line (x = -/+1.43) - rotate around Y to open; also _bolt and large_iron_gate (top bar); cemetery / park entrance' },
  gothic_statue:             { tex: 1024, simplify: 0.001, center: true, note: 'weathered stone statue of a robed figure on a base (re-centred in X/Z); cemetery centrepiece' },
  tree_stump_01:             { tex: 512, simplify: 0.002, note: 'mossy tree stump with roots; park, cemetery' },
  street_rat:                { tex: 256, simplify: 0.0005, note: 'rat (static mesh, no rig); authored small (15 cm nose-to-tail) - scale x2-2.5 for an adult rat; alleys, subway, ambient scares' },
};

// ---------------------------------------------------------------- utils

function parseArgs(argv) {
  const a = { dl: process.env.HOLLOW_ASSET_CACHE || path.join(os.tmpdir(), 'hollow-assets-dl'),
    out: path.resolve(HERE, '../../web/public/assets'), only: null, ids: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dl') a.dl = path.resolve(argv[++i]);
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--only') a.only = new Set(argv[++i].split(','));
    else if (k === '--ids') a.ids = new Set(argv[++i].split(','));
    else throw new Error(`unknown arg ${k}`);
  }
  return a;
}

async function curl(url, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  await execFileP('curl', ['-sS', '--fail', '-L', '--retry', '4', '--retry-delay', '2',
    '-A', 'hollow-asset-pipeline/1.0', '-o', tmp, url], { maxBuffer: 1 << 20 });
  await fs.rename(tmp, dest);
}

async function download(url, dest, expectSize) {
  if (existsSync(dest)) {
    const st = await fs.stat(dest);
    if (!expectSize || st.size === expectSize) return dest;
  }
  await curl(url, dest);
  if (expectSize) {
    const st = await fs.stat(dest);
    if (st.size !== expectSize) throw new Error(`size mismatch for ${url}: ${st.size} != ${expectSize}`);
  }
  return dest;
}

async function apiJson(dl, rel, cacheName) {
  const p = path.join(dl, 'api', cacheName);
  if (!existsSync(p)) await curl(`${API}/${rel}`, p);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

const fileSize = async (p) => (await fs.stat(p)).size;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- textures

async function doTextures(args, info) {
  const outDir = path.join(args.out, 'textures');
  await fs.mkdir(outDir, { recursive: true });
  const result = {};
  for (const [slot, cfg] of Object.entries(TEXTURES)) {
    if (args.ids && !args.ids.has(slot) && !args.ids.has(cfg.id)) continue;
    const meta = info.textures[cfg.id];
    if (!meta) throw new Error(`texture ${cfg.id} not found on Poly Haven`);
    const files = await apiJson(args.dl, `files/${cfg.id}`, `files_${cfg.id}.json`);
    const pick = (key) => {
      const f = files[key]?.['1k']?.jpg;
      if (!f) throw new Error(`${cfg.id}: no 1k jpg for ${key}`);
      return f;
    };
    const src = { diff: pick('Diffuse'), nor: pick('nor_gl'), rough: pick('Rough') };
    const dir = path.join(args.dl, 'textures', cfg.id);
    const out = {};
    for (const [map, f] of Object.entries(src)) {
      const raw = await download(f.url, path.join(dir, path.basename(f.url)), f.size);
      const dest = path.join(outDir, `${slot}_${map}.jpg`);
      let img = sharp(raw).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true });
      if (map === 'diff') img = img.jpeg({ quality: 82, mozjpeg: true });
      // normals: keep full chroma resolution (X/Y live in R/G)
      if (map === 'nor') img = img.jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' });
      if (map === 'rough') img = img.toColourspace('b-w').jpeg({ quality: 80, mozjpeg: true });
      await img.toFile(dest);
      out[map] = `textures/${slot}_${map}.jpg`;
      console.log(`  ${slot}_${map}.jpg  ${kb(await fileSize(dest))}`);
    }
    const dims = meta.dimensions || [2000, 2000];
    result[slot] = {
      ...out, source: cfg.id,
      repeatMeters: r2(Math.max(dims[0], dims[1]) / 1000),
      note: cfg.note,
    };
  }
  return result;
}

// ---------------------------------------------------------------- hdri

async function doHdri(args) {
  const files = await apiJson(args.dl, `files/${HDRI.id}`, `files_${HDRI.id}.json`);
  const f = files.hdri['1k'].hdr;
  const raw = await download(f.url, path.join(args.dl, 'hdri', HDRI.id, path.basename(f.url)), f.size);
  const dest = path.join(args.out, 'hdri', 'night_1k.hdr');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(raw, dest);
  console.log(`  hdri/night_1k.hdr  ${kb(await fileSize(dest))}  (${HDRI.id})`);
  return 'hdri/night_1k.hdr';
}

// ---------------------------------------------------------------- models

function makeIO() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/** Make variant `name` the default material set and drop KHR_materials_variants. */
function applyVariant(doc, name) {
  const ext = doc.getRoot().listExtensionsUsed().find((e) => e.extensionName === 'KHR_materials_variants');
  if (!ext) return;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mm = prim.getExtension('KHR_materials_variants');
      if (!mm) continue;
      if (name) {
        for (const mapping of mm.listMappings()) {
          if (mapping.listVariants().some((v) => v.getName() === name)) prim.setMaterial(mapping.getMaterial());
        }
      }
      prim.setExtension('KHR_materials_variants', null);
    }
  }
  ext.dispose();
}

const sceneOf = (doc) => doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];

function filterNodes(doc, keep, drop) {
  for (const node of sceneOf(doc).listChildren()) {
    const n = node.getName();
    if ((keep && !keep.test(n)) || (drop && drop.test(n))) node.dispose();
  }
}

/** Shift top-level nodes in X/Z so `anchorName`'s origin becomes the model origin. */
function anchorModel(doc, anchorName) {
  const scene = sceneOf(doc);
  const anchor = scene.listChildren().find((n) => n.getName() === anchorName);
  if (!anchor) throw new Error(`anchor node ${anchorName} not found`);
  const [ax, , az] = anchor.getTranslation();
  for (const node of scene.listChildren()) {
    const [x, y, z] = node.getTranslation();
    node.setTranslation([x - ax, y, z - az]);
  }
}

/** Re-parent nodes named prefix* under a new group node placed at originNode's translation. */
function groupNodes(doc, groups) {
  const scene = sceneOf(doc);
  const groupSet = new Set();
  for (const [name, prefix, originName] of groups) {
    const members = scene.listChildren().filter((n) => n.getName().startsWith(prefix));
    const origin = members.find((n) => n.getName() === originName);
    if (!origin) throw new Error(`group origin ${originName} not found`);
    const [ox, oy, oz] = origin.getTranslation();
    const group = doc.createNode(name).setTranslation([ox, oy, oz]);
    scene.addChild(group);
    for (const m of members) {
      const [x, y, z] = m.getTranslation();
      scene.removeChild(m);
      m.setTranslation([x - ox, y - oy, z - oz]);
      group.addChild(m);
    }
    groupSet.add(group);
  }
  return groupSet;
}

/**
 * three.js cost control: KHR_materials_transmission forces an extra full-scene transmission pass,
 * and specular/ior force MeshPhysicalMaterial. Replace transmission with plain alpha blending and
 * drop specular/ior (Blender-export defaults), so every material maps to MeshStandardMaterial.
 */
function cheapenMaterials(doc) {
  for (const mat of doc.getRoot().listMaterials()) {
    const tr = mat.getExtension('KHR_materials_transmission');
    if (tr) {
      const t = tr.getTransmissionFactor();
      mat.setExtension('KHR_materials_transmission', null);
      if (t > 0) {
        const [r, g, b, a] = mat.getBaseColorFactor();
        mat.setAlphaMode('BLEND').setBaseColorFactor([r, g, b, Math.min(a, 1 - 0.75 * t)]);
      }
    }
    mat.setExtension('KHR_materials_specular', null);
    mat.setExtension('KHR_materials_ior', null);
  }
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (['KHR_materials_transmission', 'KHR_materials_specular', 'KHR_materials_ior'].includes(ext.extensionName)) ext.dispose();
  }
}

/** Give unlit "*_bulb" materials a warm emissive colour (sodium/incandescent); tune emissiveIntensity in-game. */
function warmBulbs(doc) {
  for (const mat of doc.getRoot().listMaterials()) {
    if (!/_bulb$/.test(mat.getName())) continue;
    if (mat.getEmissiveTexture() || mat.getEmissiveFactor().some((v) => v > 0)) continue;
    mat.setEmissiveFactor([1.0, 0.72, 0.38]);
  }
}

/** Alpha-tested cut-out instead of blending (no sorting problems, writes depth) — for wire meshes etc. */
function maskMaterials(doc, re) {
  for (const mat of doc.getRoot().listMaterials()) {
    if (re.test(mat.getName())) mat.setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true);
  }
}

/**
 * Move a top-level node's origin to a pivot (e.g. a door hinge) without moving its geometry:
 * spec per axis = 'min' | 'max' | 'center' of the node's bounds, a number, or null (keep).
 * The mesh goes into a child "<name>_mesh" carrying the inverse offset.
 */
function setPivots(doc, pivots) {
  const scene = sceneOf(doc);
  for (const [name, spec] of Object.entries(pivots)) {
    const node = scene.listChildren().find((n) => n.getName() === name);
    if (!node) throw new Error(`pivot node ${name} not found`);
    const r = node.getRotation(), sc = node.getScale();
    if (r[3] !== 1 || sc.some((v) => v !== 1)) throw new Error(`pivot node ${name} has rotation/scale`);
    const b = getBounds(node);
    const t = node.getTranslation();
    const pv = spec.map((v, i) => v === 'min' ? b.min[i] : v === 'max' ? b.max[i]
      : v === 'center' ? (b.min[i] + b.max[i]) / 2 : typeof v === 'number' ? v : t[i]);
    const mesh = node.getMesh();
    node.setMesh(null).setTranslation(pv);
    node.addChild(doc.createNode(`${name}_mesh`).setMesh(mesh).setTranslation(t.map((v, i) => v - pv[i])));
  }
}

async function doModels(args, info) {
  const outDir = path.join(args.out, 'models');
  await fs.mkdir(outDir, { recursive: true });
  const io = makeIO();
  await MeshoptEncoder.ready; await MeshoptDecoder.ready; await MeshoptSimplifier.ready;
  const result = {};
  for (const [id, cfg] of Object.entries(MODELS)) {
    if (args.ids && !args.ids.has(id)) continue;
    if (!info.models[id]) throw new Error(`model ${id} not found on Poly Haven`);
    const files = await apiJson(args.dl, `files/${id}`, `files_${id}.json`);
    const g = files.gltf?.['1k']?.gltf;
    if (!g) throw new Error(`${id}: no 1k glTF`);
    const dir = path.join(args.dl, 'models', id);
    const gltfPath = await download(g.url, path.join(dir, path.basename(g.url)), g.size);
    for (const [rel, f] of Object.entries(g.include)) {
      const dest = path.join(dir, rel);
      if (!dest.startsWith(dir + path.sep)) throw new Error(`bad include path ${rel}`);
      await download(f.url, dest, f.size);
    }

    const doc = await io.read(gltfPath);
    const statsIn = countTris(doc);
    if (cfg.variant !== undefined || hasVariants(doc)) applyVariant(doc, cfg.variant ?? null);
    if (cfg.keep || cfg.drop) filterNodes(doc, cfg.keep, cfg.drop);
    if (cfg.anchor) anchorModel(doc, cfg.anchor);
    const groupSet = cfg.groups ? groupNodes(doc, cfg.groups) : null;
    cheapenMaterials(doc);
    warmBulbs(doc);
    if (cfg.mask) maskMaterials(doc, cfg.mask);
    if (cfg.pivots) setPivots(doc, cfg.pivots);

    const keepParts = cfg.kit || cfg.parts;
    const steps = [dedup(), prune(), weld()];
    if (cfg.simplify) steps.push(simplify({ simplifier: MeshoptSimplifier, error: cfg.simplify, lockBorder: !!cfg.lockBorder }));
    if (!keepParts) steps.push(flatten(), join({ keepNamed: false }));
    if (groupSet) steps.push(join({ keepNamed: false, filter: (n) => groupSet.has(n.getParentNode()) }));
    steps.push(
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [cfg.tex, cfg.tex], slots: /^normalTexture$/, quality: 90 }),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [cfg.tex, cfg.tex], slots: /^(?!normalTexture$).*/, quality: 80 }),
      dedup(), prune(),
    );
    await doc.transform(...steps);

    // name the single joined mesh node of each group after the group
    if (groupSet) for (const grp of groupSet) {
      const kids = grp.listChildren();
      if (kids.length === 1) kids[0].setName(`${grp.getName()}_mesh`);
    }
    // name a lone root node after the asset (flatten/join keeps an arbitrary source name)
    const scene = sceneOf(doc);
    if (!keepParts && scene.listChildren().length === 1) scene.listChildren()[0].setName(id);
    if (cfg.center) {
      const c = getBounds(scene);
      const cx = (c.min[0] + c.max[0]) / 2, cz = (c.min[2] + c.max[2]) / 2;
      for (const node of scene.listChildren()) {
        const [x, y, z] = node.getTranslation();
        node.setTranslation([x - cx, y, z - cz]);
      }
    }
    // Mesh quantization folds a dequantization offset/scale into the transform of the node that
    // holds the mesh. Move every top-level mesh into a child "<name>_mesh" so the named top-level
    // nodes keep their authored transforms (pivots for doors/drawers, kit layout positions).
    for (const node of scene.listChildren()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      node.setMesh(null).addChild(doc.createNode(`${node.getName()}_mesh`).setMesh(mesh));
    }
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

    const b = getBounds(scene);
    const size = [0, 1, 2].map((i) => r2(b.max[i] - b.min[i]));
    const dest = path.join(outDir, `${id}.glb`);
    await io.write(dest, doc);
    const bytes = await fileSize(dest);
    const statsOut = countTris(doc);
    const entry = { file: `models/${id}.glb`, size, min: b.min.map(r2), up: '+Y', note: cfg.note };
    if (keepParts) entry.parts = scene.listChildren().map((n) => n.getName()).filter(Boolean);
    result[id] = entry;
    console.log(`  ${id}.glb  ${kb(bytes)}  tris ${statsIn} -> ${statsOut}  size ${size.join(' x ')} m  nodes ${scene.listChildren().length}`);
  }
  return result;
}

function hasVariants(doc) {
  return doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === 'KHR_materials_variants');
}

function countTris(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    n += Math.floor((idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3);
  }
  return n;
}

// ---------------------------------------------------------------- meta

async function writeMeta(args, info, parts) {
  const manifestPath = path.join(args.out, 'manifest.json');
  let manifest = { textures: {}, hdri: 'hdri/night_1k.hdr', models: {} };
  if (existsSync(manifestPath)) manifest = { ...manifest, ...JSON.parse(await fs.readFile(manifestPath, 'utf8')) };
  if (parts.textures) manifest.textures = { ...manifest.textures, ...parts.textures };
  if (parts.hdri) manifest.hdri = parts.hdri;
  if (parts.models) manifest.models = { ...manifest.models, ...parts.models };
  manifest.hdriSource = HDRI.id;
  manifest.license = 'CC0 (Poly Haven) - see CREDITS.md';
  manifest.notes = {
    normals: 'OpenGL convention (+Y), matches three.js default',
    models: 'glTF Y-up, metres; EXT_meshopt_compression + KHR_mesh_quantization -> GLTFLoader.setMeshoptDecoder(MeshoptDecoder); textures are WebP (EXT_texture_webp)',
    min: 'bounding-box minimum corner in model space (y ~ 0 means origin at the base)',
  };
  // stable key order
  const textures = Object.fromEntries(Object.keys(TEXTURES).filter((k) => manifest.textures[k])
    .map((k) => [k, { ...manifest.textures[k], note: TEXTURES[k].note }]));
  const texturesSkipped = { wallpaper: 'no Poly Haven texture resembles old patterned yellow wallpaper - use the procedural one' };
  const ordered = { textures, texturesSkipped, hdri: manifest.hdri, hdriSource: manifest.hdriSource, hdriNote: HDRI.note,
    models: Object.fromEntries(Object.keys(MODELS).filter((k) => manifest.models[k])
      .map((k) => [k, { ...manifest.models[k], note: MODELS[k].note }])),
    license: manifest.license, notes: manifest.notes };
  const json = JSON.stringify(ordered, null, 2)
    .replace(/\[\s+([-\d.e,\s]+?)\s+\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`) // inline number arrays
    .replace(/\[\s+("[^\]]*?")\s+\]/g, (_, inner) => `[${inner.split(/",\s+"/).join('", "')}]`); // inline string arrays
  await fs.writeFile(manifestPath, json + '\n');

  const authors = (m) => Object.keys(m.authors || {}).join(', ') || 'Poly Haven';
  const lines = [
    '# Asset credits',
    '',
    'All third-party art assets in this folder come from [Poly Haven](https://polyhaven.com) and are released under',
    '**CC0 1.0 Universal (public domain)** — no attribution required, credited here anyway with thanks.',
    'Files were downscaled / re-encoded / mesh-optimized by `tools/assets/fetch.mjs`.',
    '',
    '## Textures',
    '',
    '| Slot | Poly Haven asset | Author(s) | License |',
    '|---|---|---|---|',
    ...Object.entries(TEXTURES).map(([slot, c]) =>
      `| ${slot} | [${info.textures[c.id].name}](https://polyhaven.com/a/${c.id}) (\`${c.id}\`) | ${authors(info.textures[c.id])} | CC0 |`),
    '',
    '## HDRI',
    '',
    '| File | Poly Haven asset | Author(s) | License |',
    '|---|---|---|---|',
    `| hdri/night_1k.hdr | [${info.hdris[HDRI.id].name}](https://polyhaven.com/a/${HDRI.id}) (\`${HDRI.id}\`) | ${authors(info.hdris[HDRI.id])} | CC0 |`,
    '',
    '## Models',
    '',
    '| File | Poly Haven asset | Author(s) | License |',
    '|---|---|---|---|',
    ...Object.keys(MODELS).map((id) =>
      `| models/${id}.glb | [${info.models[id].name}](https://polyhaven.com/a/${id}) (\`${id}\`) | ${authors(info.models[id])} | CC0 |`),
    '',
  ];
  await fs.writeFile(path.join(args.out, 'CREDITS.md'), lines.join('\n'));
  console.log('  manifest.json + CREDITS.md written');
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv);
  await fs.mkdir(args.dl, { recursive: true });
  await fs.mkdir(args.out, { recursive: true });
  const info = {
    textures: await apiJson(args.dl, 'assets?t=textures', 'assets_textures.json'),
    hdris: await apiJson(args.dl, 'assets?t=hdris', 'assets_hdris.json'),
    models: await apiJson(args.dl, 'assets?t=models', 'assets_models.json'),
  };
  const run = (k) => !args.only || args.only.has(k);
  const parts = {};
  if (run('textures')) { console.log('textures:'); parts.textures = await doTextures(args, info); }
  if (run('hdri')) { console.log('hdri:'); parts.hdri = await doHdri(args); }
  if (run('models')) { console.log('models:'); parts.models = await doModels(args, info); }
  if (run('meta') || run('textures') || run('models') || run('hdri')) await writeMeta(args, info, parts);
}

main().catch((e) => { console.error(e); process.exit(1); });
