# tools/blender — procedural character for HOLLOW

`worker.py` generates `web/public/assets/models/worker.glb`: the anonymous Archive worker that every
figure in the game wears (the living, the Hollow and the hallucinations). Everything is built from code:
the mesh, materials, rig, skin weights, animation clips and export. Nothing is hand-edited, so the
asset can be regenerated exactly.

## Run it

You need Blender **4.2 LTS**. Other versions may work, but the exporter options are pinned to 4.2.

```sh
# one-off: fetch Blender 4.2 LTS (Linux x64, about 350 MB)
curl -LO https://download.blender.org/release/Blender4.2/blender-4.2.3-linux-x64.tar.xz
tar -xf blender-4.2.3-linux-x64.tar.xz

# build + export + verify (about 1 minute on 4 cores)
blender-4.2.3-linux-x64/blender -b --factory-startup -P tools/blender/worker.py

# also render the four Eevee previews (front, 3/4, a Walk frame, a Reach frame)
blender-4.2.3-linux-x64/blender -b --factory-startup -P tools/blender/worker.py -- --renders /tmp/worker-previews
```

Options (put them after `--`):

| option | meaning |
| --- | --- |
| `--out PATH` | output `.glb` (default `web/public/assets/models/worker.glb`) |
| `--renders DIR` | write preview PNGs, 800×800, rendered with Eevee |
| `--views a,b,…` | which previews to render. The defaults are `front,threequarter,walk,reach`. You can also write `view:Clip:frame`, e.g. `side:Run:5` |
| `--quick` | render the previews with Workbench instead of Eevee. This is much faster when you are iterating on shapes |
| `--blend PATH` | also save the generated scene as a `.blend` |
| `--no-fabric` | leave out the 256 px suit fabric normal map |
| `--no-export` | skip the glTF export and the verification step |

On a machine without a GPU, Eevee needs EGL. On Ubuntu, install it with
`apt-get install libegl1 libegl-mesa0 libgbm1`. Eevee then renders in software, at about 30 seconds per
preview. `--quick` does not need Eevee.

## How the mesh is made

1. **Signed distance fields** (numpy). Each part is a smooth blend of anatomical primitives: ellipsoids,
   round cones and tori, combined with smooth union and subtraction. The parts are the suit (torso,
   sleeves, trousers, drape folds and the blousing over the boots), the faceless head and neck, the hand
   (palm, three-segment fingers, thumb) and the boot upper.
2. **Surface nets → voxel remesh → QuadriFlow.** The field is polygonised, cleaned into a closed
   2-manifold, then retopologised into all-quad meshes with a fixed triangle budget. QuadriFlow rejects
   edges shorter than 1e-4 units, so the remesh runs at 100× scale.
3. **Snap + relax.** Every vertex is Newton-projected back onto the exact field, then smoothed along the
   surface. This gives clean, evenly spaced quads that subdivide well. The exported normals are the field's
   analytic gradient (custom split normals), so shading is smooth at any density, with no faceting on the
   head.
4. **Clothing details** are thin shells conformed to the suit field:
   - the turn-down collar (a stand plus a fall that lies on the shoulders)
   - the zip placket, the zip and its pull
   - the left chest pocket with its flap, and the name tag
   - knee pads, the belt and buckle, and the sleeve cuffs
   - the visor band, which sits in a shallow groove in the skull so its edges stay clean
   - the boot soles, which are crisp extruded outlines with a separate heel block
5. **Rig.** A humanoid armature with 51 bones, including three bones per finger. Skin weights:
   - the suit, head and hands use Blender's automatic (bone-heat) weights, followed by targeted fixes:
     no cross-side leakage, sleeves only on the arm chain, the trousers in the boots follow the shin, the
     buried neck follows the chest, the skull goes to `Head`, and each finger keeps only its own chain;
   - the boots get exact procedural foot, toe and shin weights;
   - the clothing details copy the weights of the surface they sit on.
6. **Animation** is procedural:
   - FK on world-space deltas, analytic two-bone IK for the arms and legs, and a heel/ball foot-roll model;
   - Walk and Run plant their feet against the ground speed, so there is no foot sliding;
   - the hip height comes from leg reach, which produces the natural bob;
   - the torch hand is aimed so the beam points forward;
   - every clip is sampled at 30 fps into its own action.

## Asset facts (consumed by `web/src/game`)

- **Units and orientation:** metres, +Y up, the figure faces **−Z**, feet on y = 0, height 1.78 m.
  The bind pose is an A-pose. Nothing is baked into the root transform.
- **Clips** (glTF animations, 30 fps, all bones keyed):

  | clip | length | playback |
  | --- | --- | --- |
  | `Idle` | 3.0 s | loop |
  | `Walk` | 1.1 s | loop, authored for 1.4 m/s |
  | `Run` | 0.7 s | loop, authored for 4.3 m/s |
  | `Twitch` | 0.6 s | play once |
  | `Reach` | 0.8 s | play once |
  | `Look` | 1.2 s | play once |

  `Hips` never travels horizontally beyond a ±1 cm zero-mean sway; the game moves the object. The
  one-shot clips start and end exactly on Idle's first frame, so cross-fades are seamless. `Twitch` and
  `Look` only move the upper body relative to that pose. To layer them over Walk or Run, use
  `THREE.AnimationUtils.makeClipAdditive(clip)` and `AdditiveAnimationBlendMode`.
- **Bones:**
  - spine: `Hips` (root), `Spine`, `Chest`, `Neck`, `Head`
  - arms: `Shoulder_*`, `UpperArm_*`, `LowerArm_*`, `Hand_*`
  - fingers: `Thumb1-3_*`, `Index1-3_*`, `Middle1-3_*`, `Ring1-3_*`, `Pinky1-3_*`
  - legs: `UpperLeg_*`, `LowerLeg_*`, `Foot_*`, `Toes_*`

  `_R` is the figure's right (+X); `_L` is its left. The names contain no dots, so three.js's
  `PropertyBinding.sanitizeNodeName` leaves them unchanged.
- **Materials** (recolour them per body):
  - `Suit`: mid grey, roughness 0.85
  - `Skin`: pale, roughness 0.55
  - `Visor`: near-black, roughness 0.15, metallic 0.3
  - `Boots`: dark, roughness 0.6. The belt and zip use it too.
  - `Tag`: off-white
  - `Metal`: the torch body and the belt buckle
  - `Lens`: emissive warm white, via `KHR_materials_emissive_strength`

  The only texture is a tileable 256 px twill normal map on `Suit` (154 KB PNG, generated procedurally),
  box-projected at 5.5 cm per repeat. Recolouring `material.color` keeps it.
- **Name tag:** on the left chest, 0.11 × 0.0275 m (4:1, the same as the 256×64 label canvas). Its
  UVs run 0..1 across the tag face in glTF convention: u goes left to right as seen from the front, and
  v = 0 is the top edge. When you assign a `CanvasTexture`, set `texture.flipY = false` as for any glTF
  texture, or the text will be upside down.
- **Torch:**
  - a separate mesh node `Torch`, a child of the `Hand_R` joint, so it follows every clip;
  - the beam points along the node's local **−Z**, and the lens face is at local (0, 0, −0.093);
  - to light it, attach a `SpotLight` to the `Torch` node and put its target at local (0, 0, −1).
