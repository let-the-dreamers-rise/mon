"""
HOLLOW -- "worker" character generator.

Builds the anonymous Archive worker (mesh, materials, rig, skin weights, animation clips)
entirely from code and exports web/public/assets/models/worker.glb.

Run headless with Blender 4.2 LTS:

    blender -b --factory-startup -P tools/blender/worker.py -- [options]

Options (after the "--"):
    --out PATH        output .glb (default: <repo>/web/public/assets/models/worker.glb)
    --renders DIR     write preview PNGs (front, 3/4, walk, reach) rendered with Eevee
    --quick           previews with Workbench instead of Eevee (fast, for iteration)
    --views a,b,...   preview list; entries may be view:Clip:frame (e.g. side:Run:5)
    --blend PATH      also save the generated scene as a .blend
    --no-export       skip the glTF export / verification
    --no-fabric       no suit fabric normal map

Modelling approach: every body part is a signed distance field (numpy) built from smooth-blended
anatomical primitives. Each field is polygonised (surface nets), retopologised to clean quads with
QuadriFlow, then snapped back onto the exact field (whose gradient also becomes the custom normals).
Clothing details are thin shells conformed to the suit field. Coordinates while building: Blender
Z-up, the character faces +Y and its right hand is +X, so after the +Y-up glTF conversion it faces
-Z with feet on y = 0. Rig: 51 bones, bone-heat weights + fixes. Clips are procedural (FK + analytic
two-bone IK with planted feet) and sampled at 30 fps.
"""
import bpy
import bmesh
import sys
import os
import math
import time
import argparse
import numpy as np
from mathutils import Vector, Matrix, Quaternion, kdtree

T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--out', default=os.path.join(REPO, 'web', 'public', 'assets', 'models', 'worker.glb'))
ap.add_argument('--renders', default=None)
ap.add_argument('--quick', action='store_true')
ap.add_argument('--blend', default=None)
ap.add_argument('--no-export', action='store_true')
ap.add_argument('--no-fabric', action='store_true')
ap.add_argument('--views', default='front,threequarter,walk,reach')
ARGS = ap.parse_args(argv)


def log(*a):
    print('[worker %6.1fs]' % (time.time() - T0), *a, flush=True)


# ----------------------------------------------------------------------------------------------
# 1. Signed distance field toolkit (vectorised numpy, float64, points are (N, 3) arrays)
# ----------------------------------------------------------------------------------------------
def _v(x):
    return np.asarray(x, np.float64)


def _norm(a):
    return np.sqrt((a * a).sum(-1))


def sd_sphere(c, r):
    c = _v(c)
    return lambda P: _norm(P - c) - r


def sd_ellipsoid(c, r, R=None):
    """Approximate ellipsoid distance (Quilez). R: 3x3 whose columns are the local axes."""
    c, r = _v(c), _v(r)
    R = None if R is None else _v(R)

    def f(P):
        q = P - c
        if R is not None:
            q = q @ R
        k0 = _norm(q / r)
        k1 = _norm(q / (r * r))
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-12)
    return f


def sd_box(c, b, rad, R=None):
    c, b = _v(c), _v(b)
    R = None if R is None else _v(R)

    def f(P):
        q = P - c
        if R is not None:
            q = q @ R
        q = np.abs(q) - (b - rad)
        return _norm(np.maximum(q, 0.0)) + np.minimum(q.max(1), 0.0) - rad
    return f


def sd_round_cone(a, b, r1, r2):
    """Capsule with different radii at its ends (Quilez sdRoundCone, arbitrary end points)."""
    a, b = _v(a), _v(b)
    ba = b - a
    l2 = float(ba @ ba)
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2

    def f(P):
        pa = P - a
        y = pa @ ba
        z = y - l2
        xv = pa * l2 - y[:, None] * ba
        x2 = (xv * xv).sum(1)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        d1 = np.sqrt(x2 + z2) * il2 - r2
        d2 = np.sqrt(x2 + y2) * il2 - r1
        d3 = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + y * rr) * il2 - r1
        return np.where(np.sign(z) * a2 * z2 > k, d1, np.where(np.sign(y) * a2 * y2 < k, d2, d3))
    return f


def sd_limb(a, b, r1, r2, squash=1.0, side=None):
    """Round cone with an elliptical cross-section: radius along `side` is scaled by `squash`."""
    a, b = _v(a), _v(b)
    if squash == 1.0:
        return sd_round_cone(a, b, r1, r2)
    ax = (b - a) / np.linalg.norm(b - a)
    s = _v(side)
    s = s - ax * (s @ ax)
    s /= np.linalg.norm(s)
    base = sd_round_cone(a, b, r1, r2)

    def f(P):
        q = P - a
        t = q @ s
        Q = P + np.outer(t * (1.0 / squash - 1.0), s)  # stretch along `side` -> thinner shape
        return base(Q) * squash ** 0.5
    return f


def sd_torus(c, axis, R, r):
    c, axis = _v(c), _v(axis) / np.linalg.norm(axis)

    def f(P):
        q = P - c
        h = q @ axis
        rad = _norm(q - np.outer(h, axis))
        return np.sqrt((rad - R) ** 2 + h * h) - r
    return f


def sd_plane(p0, n):
    """Half space: negative on the side opposite to n."""
    p0, n = _v(p0), _v(n) / np.linalg.norm(n)
    return lambda P: (P - p0) @ n


def _smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def U(*items, k=0.0):
    """Smooth union. items: sdf functions or (sdf, k) pairs (k = blend radius for that item)."""
    fs = [(it, k) if callable(it) else it for it in items]

    def f(P):
        d = fs[0][0](P)
        for g, kk in fs[1:]:
            d = _smin(d, g(P), kk)
        return d
    return f


def SUB(a, b, k=0.0):
    """Smooth subtraction a - b."""
    return lambda P: -_smin(-a(P), b(P), k)


def INTER(a, b, k=0.0):
    return lambda P: -_smin(-a(P), -b(P), k)


def OFFSET(a, fn):
    """Displace a field by a small function of position (positive = carve in)."""
    return lambda P: a(P) + fn(P)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def grad(f, P, eps=2e-4):
    g = np.empty_like(P)
    for i in range(3):
        e = np.zeros(3)
        e[i] = eps
        g[:, i] = (f(P + e) - f(P - e)) / (2 * eps)
    return g


def snap(f, P, offset=0.0, iters=6):
    """Newton-project points onto the level set f = offset."""
    P = np.array(P, np.float64)
    for _ in range(iters):
        d = f(P) - offset
        g = grad(f, P)
        P -= (d / np.maximum((g * g).sum(1), 1e-10))[:, None] * g
    return P


def normals(f, P):
    g = grad(f, P)
    return g / np.maximum(_norm(g), 1e-12)[:, None]


def ray_surface(f, origins, dirs, tmax=0.5, iters=40):
    """Bisection along rays from inside points (f<0) to the first exit through f=0."""
    o, d = _v(origins), _v(dirs)
    d = d / _norm(d)[:, None]
    # march coarsely to find the first outside sample
    n = 200
    ts = np.linspace(0, tmax, n)
    lo = np.zeros(len(o))
    hi = np.full(len(o), tmax)
    found = np.zeros(len(o), bool)
    prev = np.zeros(len(o))
    for t in ts[1:]:
        val = f(o + d * t)
        new = (~found) & (val > 0)
        lo[new] = prev[new]
        hi[new] = t
        found |= new
        prev[:] = t
        if found.all():
            break
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        inside = f(o + d * mid[:, None]) < 0
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    return o + d * (0.5 * (lo + hi))[:, None]


# ----------------------------------------------------------------------------------------------
# 2. Meshing: surface nets on a narrow band, QuadriFlow retopology, snap + relax onto the field
# ----------------------------------------------------------------------------------------------
def surface_nets(f, lo, hi, h, coarse=4):
    lo, hi = _v(lo), _v(hi)
    nc = np.ceil((hi - lo) / (h * coarse)).astype(int) + 1
    n = (nc - 1) * coarse + 1
    H = h * coarse
    # coarse field -> sign everywhere; exact evaluation only near the surface
    cx = [lo[i] + H * np.arange(nc[i]) for i in range(3)]
    CX, CY, CZ = np.meshgrid(*cx, indexing='ij')
    Fc = f(np.stack([CX, CY, CZ], -1).reshape(-1, 3)).reshape(nc)
    near = [np.minimum(np.round(np.arange(n[i]) / coarse).astype(int), nc[i] - 1) for i in range(3)]
    F = Fc[np.ix_(*near)]
    band = np.abs(F) < 2.0 * H
    idx = np.nonzero(band)
    pts = np.stack([lo[i] + h * idx[i] for i in range(3)], -1)
    vals = np.empty(len(pts))
    CH = 1_500_000
    for s in range(0, len(pts), CH):
        vals[s:s + CH] = f(pts[s:s + CH])
    F[idx] = vals
    for ax in range(3):
        for end in (0, -1):
            face = np.take(F, end, axis=ax)
            if (face < 0).any():
                raise RuntimeError('surface crosses the sampling box (axis %d, side %d)' % (ax, end))
    nx, ny, nz = n
    ncell = (nx - 1) * (ny - 1) * (nz - 1)
    acc = np.zeros((ncell, 3))
    cnt = np.zeros(ncell)

    def cid(c):
        return (c[:, 0] * (ny - 1) + c[:, 1]) * (nz - 1) + c[:, 2]
    quads = []
    for ax in range(3):
        s0 = [slice(None)] * 3
        s1 = [slice(None)] * 3
        s0[ax] = slice(0, -1)
        s1[ax] = slice(1, None)
        f0 = F[tuple(s0)]
        f1 = F[tuple(s1)]
        m = (f0 < 0) != (f1 < 0)
        e = np.argwhere(m)
        a0 = f0[m]
        a1 = f1[m]
        t = a0 / (a0 - a1)
        p = lo + e * h
        p[:, ax] += t * h
        o = [d for d in range(3) if d != ax]
        cells = []
        for d1, d2 in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
            c = e.copy()
            c[:, o[0]] += d1
            c[:, o[1]] += d2
            cells.append(c)
        valid = np.ones(len(e), bool)
        for c in cells:
            ok = np.all((c >= 0) & (c < n - 1), axis=1)
            valid &= ok
            ci = cid(c[ok])
            for d in range(3):
                acc[:, d] += np.bincount(ci, weights=p[ok, d], minlength=ncell)
            cnt += np.bincount(ci, minlength=ncell)
        q = np.stack([cid(c[valid]) for c in cells], 1)
        flip = ~(a0[valid] < 0)
        if ax == 1:
            flip = ~flip
        q[flip] = q[flip][:, ::-1]
        quads.append(q)
    quads = np.concatenate(quads)
    used = np.unique(quads)
    remap = -np.ones(ncell, np.int64)
    remap[used] = np.arange(len(used))
    V = acc[used] / cnt[used, None]
    return V, remap[quads]


def mesh_from_numpy(name, V, faces, mat_index=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in np.asarray(V, float)], [], [tuple(int(i) for i in fc) for fc in faces])
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_arrays(ob):
    me = ob.data
    V = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', V)
    return V.reshape(-1, 3)


def set_coords(ob, V):
    ob.data.vertices.foreach_set('co', np.asarray(V, np.float64).ravel())
    ob.data.update()


def edges_array(ob):
    E = np.empty(len(ob.data.edges) * 2, np.int64)
    ob.data.edges.foreach_get('vertices', E)
    return E.reshape(-1, 2)


def set_active(ob):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)


def relax_on_field(ob, f, iters=3, lam=0.5):
    V = mesh_arrays(ob)
    E = edges_array(ob)
    n = len(V)
    for _ in range(iters):
        S = np.zeros_like(V)
        C = np.zeros(n)
        np.add.at(S, E[:, 0], V[E[:, 1]])
        np.add.at(S, E[:, 1], V[E[:, 0]])
        np.add.at(C, E[:, 0], 1)
        np.add.at(C, E[:, 1], 1)
        avg = S / np.maximum(C, 1)[:, None]
        N = normals(f, V)
        dv = avg - V
        dv -= (dv * N).sum(1)[:, None] * N
        V = snap(f, V + lam * dv, iters=3)
    set_coords(ob, V)


def remesh_sdf(name, f, lo, hi, h, faces, relax=3):
    t = time.time()
    V, Q = surface_nets(f, lo, hi, h)
    V = snap(f, V, iters=3)
    ob = mesh_from_numpy(name, V, Q)
    # voxel remesh guarantees a closed 2-manifold (QuadriFlow refuses anything else)
    m = ob.modifiers.new('vox', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = h
    m.adaptivity = 0.0
    apply_modifiers(ob)
    n0 = len(ob.data.polygons)
    # QuadriFlow rejects edges shorter than 1e-4 units, so work at 100x scale
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=h * 0.02)
    bm.to_mesh(ob.data)
    bm.free()
    set_coords(ob, mesh_arrays(ob) * 100.0)
    set_active(ob)
    for seed in (7, 13, 29, 3):
        bpy.ops.object.quadriflow_remesh(mode='FACES', target_faces=faces, seed=seed,
                                         use_mesh_symmetry=False, use_preserve_sharp=False,
                                         use_preserve_boundary=False, smooth_normals=False)
        if len(ob.data.polygons) < 0.5 * n0:
            break
        log('  quadriflow retry', name, seed)
    else:
        raise RuntimeError('quadriflow failed for ' + name)
    V = snap(f, mesh_arrays(ob) / 100.0, iters=6)
    set_coords(ob, V)
    if relax:
        relax_on_field(ob, f, iters=relax)
    log('  %s: nets %d -> quads %d (%.1fs)' % (name, len(Q), len(ob.data.polygons), time.time() - t))
    return ob


def grid_faces(nu, nv, closed_u=False, closed_v=False):
    F = []
    for i in range(nu if closed_u else nu - 1):
        for j in range(nv if closed_v else nv - 1):
            a = i * nv + j
            b = ((i + 1) % nu) * nv + j
            c = ((i + 1) % nu) * nv + (j + 1) % nv
            d = i * nv + (j + 1) % nv
            F.append((a, b, c, d))
    return F


def solidify(ob, thickness, offset=-1.0, rim=True, rim_only=False):
    m = ob.modifiers.new('solid', 'SOLIDIFY')
    m.thickness = thickness
    m.offset = offset
    m.use_even_offset = True
    m.use_rim = rim
    m.use_rim_only = rim_only
    m.use_quality_normals = True
    apply_modifiers(ob)


def apply_modifiers(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)


def field_normals(ob, f, M=None, flip_x=False):
    """Store the exact field gradient as custom normals: perfectly smooth shading at any density."""
    V = mesh_arrays(ob)
    P = V if M is None else M(V)
    N = normals(f, P)
    if flip_x:
        N[:, 0] *= -1
    return N


def set_normals(ob, N):
    ob.data.polygons.foreach_set('use_smooth', [True] * len(ob.data.polygons))
    ob.data.normals_split_custom_set_from_vertices([tuple(n) for n in N])
    ob.data.update()


def shade(ob, smooth=True, sharp_angle=None):
    me = ob.data
    me.polygons.foreach_set('use_smooth', [smooth] * len(me.polygons))
    if sharp_angle is not None:
        me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    me.update()


# ----------------------------------------------------------------------------------------------
# 3. Proportions (metres). Character height 1.78 incl. boot soles; arms and neck ~5 % long.
# ----------------------------------------------------------------------------------------------
def nrm(v):
    v = _v(v)
    return v / np.linalg.norm(v)


def rot_about(v, axis, deg):
    q = Quaternion(Vector(nrm(axis)), math.radians(deg))
    return np.array(q @ Vector(v))


J = {}
J['hips'] = _v((0, 0.0, 0.985))
J['spine'] = _v((0, 0.0, 1.085))
J['chest'] = _v((0, -0.008, 1.225))
J['neck'] = _v((0, -0.025, 1.44))
J['head'] = _v((0, -0.012, 1.595))
J['head_top'] = _v((0, -0.012, 1.78))
J['clav'] = _v((0.022, 0.012, 1.412))
J['shoulder'] = _v((0.182, -0.02, 1.415))
J['hip'] = _v((0.092, 0.0, 0.935))
J['knee'] = _v((0.098, 0.018, 0.515))
J['ankle'] = _v((0.104, -0.025, 0.098))
J['ball'] = _v((0.113, 0.118, 0.028))
J['toe'] = _v((0.12, 0.205, 0.028))
UPPER_ARM, FOREARM = 0.345, 0.28
D_UP = nrm((0.70, 0.07, -0.71))                       # A-pose, 45 deg down
_f = nrm(_v((0, 1, 0)) - D_UP * D_UP[1])
D_FORE = nrm(math.cos(math.radians(12)) * D_UP + math.sin(math.radians(12)) * _f)
J['elbow'] = J['shoulder'] + UPPER_ARM * D_UP
J['wrist'] = J['elbow'] + FOREARM * D_FORE
# hand frame: u = along fingers, v = thumb side, w = back of the hand (palm faces -w)
H_U = D_FORE
_n = nrm(_v((0, 0, -1)) - H_U * (-H_U[2]))            # palm normal (down / inwards)
H_V = nrm(np.cross(H_U, _n))
H_W = np.cross(H_U, H_V)
H_M = np.stack([H_U, H_V, H_W], 1)                    # canonical hand coords -> world (right hand)
HEAD_C = _v((0, 0.006, 1.666))                         # between the ear canals
TAG_SIZE = (0.11, 0.0275)                              # 4:1 like the game's 256x64 label
TAG_CENTER = (-0.084, 1.302)
NECK_AXIS = _v((0, -0.028, 0))


def mirror(p):
    p = _v(p).copy()
    p[..., 0] *= -1
    return p


def hand_to_world(Pc):
    return J['wrist'] + _v(Pc) @ H_M.T


# finger chains in canonical hand coords: knuckle, spread (deg), rest curl per joint, lengths, radii
FINGERS = {
    'Index': ((0.093, 0.0285, 0.001), 7.0, (6, 9, 6), (0.047, 0.028, 0.023), (0.0089, 0.0084, 0.0077, 0.0067)),
    'Middle': ((0.097, 0.0075, 0.002), 1.0, (7, 10, 7), (0.052, 0.032, 0.024), (0.0093, 0.0088, 0.0080, 0.0070)),
    'Ring': ((0.092, -0.0125, 0.000), -5.0, (8, 11, 7), (0.048, 0.030, 0.023), (0.0088, 0.0083, 0.0076, 0.0066)),
    'Pinky': ((0.082, -0.0315, -0.003), -12.0, (10, 12, 8), (0.037, 0.023, 0.021), (0.0077, 0.0072, 0.0066, 0.0058)),
}
THUMB = [(0.016, 0.022, -0.007), (0.046, 0.052, -0.018), (0.073, 0.069, -0.024), (0.098, 0.079, -0.027)]
THUMB_R = (0.0135, 0.0110, 0.0098, 0.0084)


def finger_joints(name):
    k, spread, curl, lens, _ = FINGERS[name]
    s = math.radians(spread)
    d = _v((math.cos(s), math.sin(s), 0.0))
    axis = _v((-math.sin(s), math.cos(s), 0.0))
    pts = [_v(k)]
    acc = 0.0
    for c, L in zip(curl, lens):
        acc += c
        dd = rot_about(d, axis, acc)
        pts.append(pts[-1] + dd * L)
    return pts, axis


# ----------------------------------------------------------------------------------------------
# 4. Body part fields
# ----------------------------------------------------------------------------------------------
def suit_field():
    S, E, W = J['shoulder'], J['elbow'], J['wrist']
    cuff_end = W - 0.018 * D_FORE
    parts = []
    for sx in (1, -1):
        m = (lambda p: p) if sx == 1 else mirror
        parts += [
            (sd_ellipsoid(m((0.07, -0.068, 1.33)), (0.08, 0.055, 0.095)), 0.045),            # scapula
            (sd_round_cone(m((0.035, -0.03, 1.462)), m((0.16, -0.028, 1.425)), 0.045, 0.042), 0.04),  # trapezius
            (sd_ellipsoid(m(S + (0.014, 0.0, -0.012)), (0.058, 0.064, 0.058)), 0.03),       # deltoid
            (sd_ellipsoid(m((0.06, -0.05, 0.94)), (0.072, 0.064, 0.085)), 0.035),           # seat
        ]
    torso = U((sd_ellipsoid((0, -0.012, 1.283), (0.147, 0.106, 0.172)), 0),
              (sd_ellipsoid((0, 0.0, 1.135), (0.138, 0.098, 0.13)), 0.07),
              (sd_ellipsoid((0, -0.008, 0.99), (0.15, 0.108, 0.112)), 0.06),
              (sd_ellipsoid((0, -0.07, 1.46), (0.07, 0.048, 0.06)), 0.04),           # base of the neck (C7)
              (sd_ellipsoid((0, 0.022, 1.325), (0.132, 0.068, 0.075)), 0.05),        # broad upper chest
              *parts)
    # neck opening: the head's neck passes through a hole in the suit, hidden by the collar
    hole = sd_round_cone((0, NECK_AXIS[1], 1.45), (0, NECK_AXIS[1], 1.75), 0.071, 0.071)
    torso = SUB(torso, hole, 0.006)
    limbs = []
    for sx in (1, -1):
        m = (lambda p: p) if sx == 1 else mirror
        d = m(D_FORE)
        arm = U(sd_round_cone(m(S), m(E), 0.057, 0.049),
                (sd_round_cone(m(E), m(cuff_end), 0.049, 0.0385), 0.012))
        arm = INTER(arm, sd_plane(m(cuff_end), d), 0.004)
        leg = U(sd_round_cone(m(J['hip'] + (0, -0.004, 0.03)), m(J['knee']), 0.088, 0.064),
                (sd_round_cone(m(J['knee']), m((0.104, -0.02, 0.22)), 0.064, 0.05), 0.015),
                (sd_ellipsoid(m((0.104, -0.019, 0.236)), (0.074, 0.076, 0.027)), 0.02))  # blousing over boot
        limbs += [(arm, 0.035), (leg, 0.045)]
    body = U(torso, *limbs)

    def drape(P):
        x, y, z = P[:, 0], P[:, 1], P[:, 2]
        out = np.zeros(len(P))
        # trouser legs: soft vertical drape folds, stronger towards the ankle
        leg = smoothstep(0.92, 0.80, z) * smoothstep(0.17, 0.3, z)
        ang = np.arctan2(y + 0.01, np.abs(x) - 0.1)
        out += 0.0022 * leg * np.sin(ang * 5 + z * 9.0) * (1.2 - z)
        # bunching behind the knee and above the boots
        kb = np.exp(-((z - 0.5) / 0.05) ** 2) * smoothstep(0.0, -0.06, y)
        out += 0.0025 * kb * np.sin(z * 120.0)
        bt = np.exp(-((z - 0.3) / 0.04) ** 2)
        out += 0.0015 * bt * np.sin(z * 150.0 + ang * 2)
        # waist: fabric blousing above the belt
        wb = np.exp(-((z - 1.1) / 0.03) ** 2)
        out -= 0.004 * wb
        out += 0.0016 * wb * np.sin(np.arctan2(y, x) * 9)
        # back of the shoulders / armpit drape
        arm_r = np.abs(x)
        sl = smoothstep(0.24, 0.36, arm_r) * (1 - smoothstep(0.5, 0.6, arm_r))
        out += 0.0016 * sl * np.sin(arm_r * 70.0 + z * 20)
        return out
    return OFFSET(body, drape)


VISOR_Z = 0.004          # band centre above HEAD_C
VISOR_HALF = 0.0175      # half height of the band
VISOR_PHI = 84.0         # band spans +-84 deg around the head


def head_field():
    """Faceless head + neck. Origin HEAD_C = midpoint between the ear canals.
    Returns (skin field with a shallow groove under the visor band, field without the groove)."""
    C = HEAD_C

    def at(o):
        return C + _v(o)
    parts = [
        (sd_ellipsoid(at((0, -0.008, 0.03)), (0.0755, 0.099, 0.088)), 0),                  # cranium
        (sd_ellipsoid(at((0, 0.034, -0.036)), (0.06, 0.055, 0.056)), 0.035),              # face block
        (sd_ellipsoid(at((0, 0.064, -0.06)), (0.036, 0.022, 0.028)), 0.025),               # tooth arch
        (sd_ellipsoid(at((0, 0.07, -0.097)), (0.022, 0.016, 0.0175)), 0.02),              # chin
        (sd_ellipsoid(at((0, 0.079, 0.028)), (0.055, 0.0165, 0.0125)), 0.02),              # brow
        (sd_round_cone((0, -0.033, 1.385), at((0, -0.024, -0.068)), 0.0635, 0.0575), 0.02),  # neck
    ]
    for sx in (1, -1):
        m = (lambda p: p) if sx == 1 else mirror
        parts += [
            (sd_round_cone(m(at((0.058, -0.012, -0.014))), m(at((0.054, -0.004, -0.07))), 0.0125, 0.0135), 0.022),  # ramus
            (sd_round_cone(m(at((0.054, -0.004, -0.07))), m(at((0.024, 0.064, -0.1))), 0.0135, 0.014), 0.022),   # jaw
            (sd_ellipsoid(m(at((0.047, 0.053, -0.012))), (0.023, 0.021, 0.0135)), 0.016),                      # cheekbone
            (sd_ellipsoid(m(at((0.05, 0.018, -0.05))), (0.017, 0.03, 0.03)), 0.03),                           # cheek
            (sd_round_cone(m(at((0.048, -0.032, -0.052))), m((0.016, 0.014, 1.47)), 0.0118, 0.011), 0.02),    # neck muscle
            (sd_ellipsoid(m(at((0.0745, -0.014, -0.004))), (0.0095, 0.019, 0.028),
                          Matrix.Rotation(math.radians(-14), 3, 'X').transposed()), 0.006),               # ear
        ]
    head = U(*parts)
    head = INTER(head, sd_plane((0, 0, 1.385), (0, 0, -1)), 0.004)

    def groove(P):
        dz = np.abs(P[:, 2] - (C[2] + VISOR_Z))
        phi = np.degrees(np.abs(np.arctan2(P[:, 0], P[:, 1] - (C[1] - 0.004))))
        front = (P[:, 1] > C[1] - 0.03)
        # deep in the middle (robust against chordal error), nearly flush at the band's edges
        return 0.0024 * smoothstep(VISOR_HALF + 0.003, VISOR_HALF - 0.006, dz) * \
            smoothstep(VISOR_PHI + 3, VISOR_PHI - 8, phi) * front
    return OFFSET(head, groove), head


def hand_field():
    """Right hand in canonical coordinates (u fingers, v thumb, w back of hand)."""
    parts = [
        (sd_limb((-0.052, 0, 0.0), (0.004, 0, -0.001), 0.0285, 0.0275, squash=0.7, side=(0, 0, 1)), 0),  # wrist
        (sd_box((0.049, -0.001, -0.0015), (0.046, 0.0395, 0.0118), 0.0095), 0.012),                       # palm
        (sd_ellipsoid((0.05, -0.002, 0.003), (0.05, 0.038, 0.011)), 0.01),                                 # back
        (sd_ellipsoid((0.036, -0.03, -0.006), (0.036, 0.013, 0.011)), 0.01),                               # hypothenar
    ]
    for name in FINGERS:
        pts, _ = finger_joints(name)
        rad = FINGERS[name][4]
        chain = U(*[(sd_round_cone(pts[i], pts[i + 1], rad[i], rad[i + 1]), 0.003) for i in range(3)])
        parts.append((chain, 0.009))
        parts.append((sd_sphere(_v(pts[0]) + (0, 0, 0.0035), rad[0] * 0.85), 0.006))  # knuckle
    th = U(*[(sd_round_cone(THUMB[i], THUMB[i + 1], THUMB_R[i], THUMB_R[i + 1]), 0.004) for i in range(3)])
    parts.append((th, 0.012))
    parts.append((sd_ellipsoid((0.03, 0.03, -0.012), (0.03, 0.017, 0.012)), 0.012))   # thenar pad
    return U(*parts)


BOOT_YAW = math.radians(6)


def boot_field():
    """Right boot in world coords."""
    a = J['ankle']
    o = _v((a[0], a[1], 0.0))
    f = _v((math.sin(BOOT_YAW), math.cos(BOOT_YAW), 0))
    s = _v((math.cos(BOOT_YAW), -math.sin(BOOT_YAW), 0))
    R = np.stack([s, f, (0, 0, 1)], 1)

    def L(p):
        return o + R @ _v(p)

    def outline2d(P, grow=0.0):
        q = (P - o) @ R
        circles = [((0.0, -0.05), 0.042), ((0.004, 0.055), 0.046), ((0.006, 0.12), 0.052), ((-0.002, 0.168), 0.043)]
        d = None
        for (cx, cy), r in circles:
            dd = np.sqrt((q[:, 0] - cx) ** 2 + (q[:, 1] - cy) ** 2) - (r + grow)
            d = dd if d is None else _smin(d, dd, 0.035)
        return d, q

    def lift(q):
        return 0.009 * smoothstep(0.11, 0.215, q[:, 1])

    def upper_box(P):
        d2, q = outline2d(P, grow=-0.006)
        z = q[:, 2] - lift(q)
        fy = q[:, 1]
        h = 0.058 - 0.012 * smoothstep(0.1, 0.21, fy) + 0.05 * smoothstep(0.075, -0.01, fy)
        h = h - 9.0 * (q[:, 0] - 0.003) ** 2
        dz = z - h
        return -_smin(-d2, -dz, 0.012)

    upper = U(upper_box,
              (sd_ellipsoid(L((0.001, 0.146, 0.044)), (0.044, 0.056, 0.022)), 0.016),           # toe cap
              (sd_round_cone(L((0, -0.024, 0.09)), L((0, -0.016, 0.22)), 0.054, 0.056), 0.03),  # shaft
              (sd_ellipsoid(L((0, 0.03, 0.14)), (0.03, 0.02, 0.07)), 0.012),                # tongue
              (sd_torus(L((0, -0.016, 0.221)), (0, 0, 1), 0.054, 0.0085), 0.006))             # padded top
    upper = INTER(upper, sd_plane((0, 0, 0.024), (0, 0, -1)), 0.002)
    upper = INTER(upper, sd_plane((0, 0, 0.228), (0, 0, 1)), 0.003)
    return upper, outline2d, (o, R), lift


def build_sole(outline2d, frame, lift):
    """Chunky tread sole with a separate heel block: a crisp extruded outline (right foot)."""
    o, R = frame
    n = 28
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
    c2 = _v((0.002, 0.06))
    pts = []
    for a in ang:
        d = _v((math.cos(a), math.sin(a)))
        lo, hi = 0.0, 0.25
        for _ in range(40):
            mid = (lo + hi) / 2
            q = c2 + d * mid
            P = (o + R @ _v((q[0], q[1], 0.0)))[None]
            if outline2d(P)[0][0] < 0:
                lo = mid
            else:
                hi = mid
        pts.append(c2 + d * lo)
    pts = np.array(pts)
    fy = pts[:, 1]
    arch = 0.009 * smoothstep(-0.03, -0.012, fy) * smoothstep(0.07, 0.048, fy)
    lf = 0.009 * smoothstep(0.11, 0.215, fy)
    top = 0.027 + 0.008 * smoothstep(0.02, -0.025, fy)
    rings = [(0.0, arch, 0.0025), (0.0, arch + 0.0035, 0.0), (0.0, top - 0.003, 0.0), (0.003, top, -0.002)]
    V = []
    for inset, zs, _ in rings:
        for i in range(n):
            p2 = pts[i] - (pts[i] - c2) / np.linalg.norm(pts[i] - c2) * (inset + 0.0)
            z = (zs[i] if np.ndim(zs) else zs) + lf[i]
            V.append(o + R @ _v((p2[0], p2[1], z)))
    # first ring slightly inset (bevelled bottom edge)
    for i in range(n):
        d = (pts[i] - c2) / np.linalg.norm(pts[i] - c2)
        p2 = pts[i] - d * 0.0025
        V[i] = o + R @ _v((p2[0], p2[1], arch[i] + lf[i]))
    F = []
    for r in range(len(rings) - 1):
        for i in range(n):
            a, b = r * n + i, r * n + (i + 1) % n
            F.append((a, b, b + n, a + n))
    F.append(tuple(range(n - 1, -1, -1)))              # bottom
    F.append(tuple((len(rings) - 1) * n + i for i in range(n)))   # top
    ob = mesh_from_numpy('SoleR', np.array(V), F)
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.to_mesh(me)
    bm.free()
    assign(ob, 'Boots')
    shade(ob, True, 35)
    return ob


# ----------------------------------------------------------------------------------------------
# 5. Materials
# ----------------------------------------------------------------------------------------------
def srgb(c):
    c = _v(c)
    return tuple(np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)) + (1.0,)


def make_material(name, color, rough, metal=0.0, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = srgb(color)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emission is not None:
        p.inputs['Emission Color'].default_value = srgb(emission)
        p.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = srgb(color)
    m.roughness = rough
    m.metallic = metal
    m.use_backface_culling = True          # closed meshes -> glTF doubleSided: false
    return m


MATS = {}


def build_materials():
    MATS['Suit'] = make_material('Suit', (0.47, 0.47, 0.46), 0.85)
    MATS['Skin'] = make_material('Skin', (0.86, 0.80, 0.75), 0.55)
    MATS['Visor'] = make_material('Visor', (0.03, 0.03, 0.035), 0.15, 0.3)
    MATS['Boots'] = make_material('Boots', (0.13, 0.12, 0.11), 0.6)
    MATS['Tag'] = make_material('Tag', (0.88, 0.86, 0.79), 0.7)
    MATS['Metal'] = make_material('Metal', (0.2, 0.2, 0.21), 0.38, 0.85)
    MATS['Lens'] = make_material('Lens', (1.0, 0.97, 0.9), 0.1, 0.0, emission=(1.0, 0.9, 0.74), strength=6.0)


def assign(ob, matname):
    ob.data.materials.clear()
    ob.data.materials.append(MATS[matname])


# ----------------------------------------------------------------------------------------------
# 6. Clothing details: shells conformed to the suit field
# ----------------------------------------------------------------------------------------------
def front_points(f, xs, zs, y_start=-0.06):
    """Surface points hit by rays travelling +Y from inside the body."""
    X, Z = np.meshgrid(xs, zs, indexing='ij')
    o = np.stack([X.ravel(), np.full(X.size, y_start), Z.ravel()], 1)
    d = np.tile((0, 1.0, 0), (len(o), 1))
    return ray_surface(f, o, d, tmax=0.4).reshape(len(xs), len(zs), 3)


def patch(name, f, xs, zs, off_top, thick, mat, inset_edge=0.0, y_start=-0.06):
    S = front_points(f, xs, zs, y_start)
    nu, nv = S.shape[:2]
    P = S.reshape(-1, 3)
    N = normals(f, P)
    off = np.full(len(P), off_top)
    if inset_edge:
        I, Jj = np.meshgrid(np.arange(nu), np.arange(nv), indexing='ij')
        edge = (I == 0) | (I == nu - 1) | (Jj == 0) | (Jj == nv - 1)
        off = off - inset_edge * edge.ravel()
    V = P + N * off[:, None]
    ob = mesh_from_numpy(name, V, grid_faces(nu, nv))
    # make the faces point outwards (+Y)
    me = ob.data
    if me.polygons[0].normal.y < 0:
        me.flip_normals()
    solidify(ob, thick, offset=-1.0, rim_only=True)
    assign(ob, mat)
    shade(ob, True, 35)
    return ob


def band_ring(name, f, z0, z1, off, thick, mat, center=(0, -0.005), segs=32):
    th = np.linspace(0, 2 * np.pi, segs, endpoint=False)
    pts = []
    for z in (z0, z1):
        o = np.stack([np.full(segs, center[0]), np.full(segs, center[1]), np.full(segs, z)], 1)
        d = np.stack([np.sin(th), np.cos(th), np.zeros(segs)], 1)
        pts.append(ray_surface(f, o, d, tmax=0.35))
    S = np.stack(pts, 1)  # segs x 3 x 3
    P = S.reshape(-1, 3)
    N = normals(f, P)
    N[:, 2] *= 0.3
    N /= _norm(N)[:, None]
    V = P + N * off
    ob = mesh_from_numpy(name, V, grid_faces(segs, 2, closed_u=True))
    me = ob.data
    if me.polygons[0].normal.dot(Vector(P[0] - (0, -0.005, P[0][2]))) < 0:
        me.flip_normals()
    solidify(ob, thick, offset=-1.0, rim_only=True)
    assign(ob, mat)
    shade(ob, True, 40)
    return ob, S


def box_obj(name, size, mat, M, bevel=0.002, segs=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if bevel:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segs, affect='EDGES', profile=0.5)
    bm.transform(M)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    assign(ob, mat)
    shade(ob, True, 40)
    return ob


def frame_matrix(origin, x, y, z):
    M = Matrix.Identity(4)
    for i in range(3):
        M[i][0], M[i][1], M[i][2], M[i][3] = x[i], y[i], z[i], origin[i]
    return M


def build_collar(f):
    """Turn-down work collar: a stand around the neck plus a fall that lies on the shoulders."""
    ax = NECK_AXIS
    phis = np.linspace(-(math.pi - 0.3), math.pi - 0.3, 26)      # 0 = back of the neck
    nphi = len(phis)
    Rs = 0.0745
    R = np.stack([np.sin(phis), -np.cos(phis), np.zeros(nphi)], 1)
    O = np.stack([R[:, 0] * Rs, ax[1] + R[:, 1] * Rs, np.full(nphi, 1.7)], 1)
    top_surf = ray_surface(lambda P: -f(P), O, np.tile((0, 0, -1.0), (nphi, 1)), tmax=0.45)
    rows = []
    for i, phi in enumerate(phis):
        r = R[i]
        front = (1 - math.cos(phi)) / 2
        zb = top_surf[i, 2]
        hs = 0.03 - 0.01 * front

        def P(rad, z):
            return _v((r[0] * rad, ax[1] + r[1] * rad, z))
        prof = [P(Rs, zb - 0.007), P(Rs, zb + hs * 0.5), P(Rs + 0.001, zb + hs), P(Rs + 0.0048, zb + hs + 0.0034),
                P(Rs + 0.0085, zb + hs - 0.001), P(Rs + 0.0095, zb + hs * 0.45), P(Rs + 0.011, zb + 0.001)]
        L2 = 0.016 + 0.052 * front ** 3.0
        e = nrm(r * math.cos(math.radians(35)) - _v((0, 0, 1)) * math.sin(math.radians(35)))
        prof += [prof[-1] + e * L2 * t for t in (0.5, 1.0)]
        rows.append(prof)
    V = np.array(rows).reshape(-1, 3)
    nv = len(rows[0])
    idx = np.array([i * nv + j for i in range(nphi) for j in range(6, nv)])
    V[idx] = snap(f, V[idx], offset=0.0042)
    ob = mesh_from_numpy('Collar', V, grid_faces(nphi, nv))
    me = ob.data
    p = me.polygons[(nphi // 2) * (nv - 1)]       # a stand face at the back
    c = Vector(p.center)
    if p.normal.dot(c - Vector((0, ax[1], c.z))) < 0:
        me.flip_normals()
    solidify(ob, 0.0028, offset=-1.0)
    assign(ob, 'Suit')
    shade(ob, True, 50)
    return ob


def build_visor(fh):
    """Glossy band fused across the eyes: sits in a shallow groove, walls sink into the skin."""
    C = HEAD_C
    phis = np.radians(np.linspace(-VISOR_PHI, VISOR_PHI, 26))
    zs = np.linspace(-VISOR_HALF, VISOR_HALF, 5)
    O, D = [], []
    for z in zs:
        for p in phis:
            O.append((0, C[1] - 0.004, C[2] + VISOR_Z + z))
            D.append((math.sin(p), math.cos(p), 0))
    S = ray_surface(fh, np.array(O), np.array(D), tmax=0.2)
    N = normals(fh, S)
    nz, nphi = len(zs), len(phis)
    V = S + N * 0.0009
    F = []
    for i in range(nz - 1):
        for j in range(nphi - 1):
            a = i * nphi + j
            F.append((a, a + 1, a + 1 + nphi, a + nphi))
    ob = mesh_from_numpy('Visor', V, F)
    me = ob.data
    if me.polygons[len(F) // 2].normal.y < 0:
        me.flip_normals()
    solidify(ob, 0.0034, offset=-1.0, rim_only=True)
    assign(ob, 'Visor')
    shade(ob, True, 60)
    return ob


def build_cuff(side):
    m = (lambda p: p) if side == 1 else mirror
    d = m(D_FORE)
    W = m(J['wrist'])
    ref = nrm(np.cross(d, (0, 0, 1)))
    ref2 = np.cross(d, ref)
    th = np.linspace(0, 2 * np.pi, 18, endpoint=False)
    prof = [(-0.064, 0.0455), (-0.05, 0.0482), (-0.022, 0.0484), (-0.006, 0.0462)]
    V = []
    for t in th:
        rd = math.cos(t) * ref + math.sin(t) * ref2 * 0.94
        for a, r in prof:
            V.append(W + d * a + rd * r)
    ob = mesh_from_numpy('Cuff', np.array(V), grid_faces(len(th), len(prof), closed_u=True))
    me = ob.data
    p = me.polygons[0]
    axis_pt = W + d * float(np.dot(_v(p.center) - W, d))
    if p.normal.dot(Vector(_v(p.center) - axis_pt)) < 0:
        me.flip_normals()
    solidify(ob, 0.0045, offset=-1.0)
    assign(ob, 'Suit')
    shade(ob, True, 50)
    return ob


def build_tag(f, cx, cz, w, h):
    """Flat name-tag card on the left chest. UVs span 0..1 over its face (glTF: v = 0 at the top)."""
    C = front_points(f, [cx], [cz], y_start=0.0)[0, 0]
    n = normals(f, C[None])[0]
    tx = nrm(_v((-1.0, 0, 0)) - n * (-n[0]))          # across the tag, towards the figure's left
    tz = nrm(np.cross(n, tx)) * -1                      # up the tag
    if tz[2] < 0:
        tz = -tz
    corners = []
    for j, v in enumerate((-0.5, 0.5)):
        for i, u in enumerate((-0.5, 0.0, 0.5)):
            corners.append(C + tx * (u * w) + tz * (v * h))
    corners = np.array(corners)
    lift = max(0.0, -float(f(corners).min())) + 0.0026
    V = corners + n * lift
    F = [(0, 1, 4, 3), (1, 2, 5, 4)]
    ob = mesh_from_numpy('Tag', V, F)
    me = ob.data
    if me.polygons[0].normal.dot(Vector(n)) < 0:
        me.flip_normals()
    lay = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            j, i = divmod(vi, 3)
            lay.data[li].uv = (i / 2.0, float(j))     # Blender v = 1 at the top -> glTF v = 0 at the top
    solidify(ob, lift + 0.004, offset=-1.0, rim_only=True)
    assign(ob, 'Tag')
    shade(ob, True, 35)
    return ob


def build_suit_details(fs):
    objs = []
    objs.append(build_collar(fs))
    # zipper placket down the front, a dark zip line, and the pull
    objs.append(patch('Placket', fs, np.linspace(0.017, -0.017, 2), np.linspace(1.398, 0.9, 22), 0.0026, 0.005,
                      'Suit', y_start=-0.03))
    objs.append(patch('Zip', fs, np.linspace(0.0035, -0.0035, 2), np.linspace(1.392, 0.92, 16), 0.0034, 0.004,
                      'Boots', y_start=-0.03))
    zp = front_points(fs, [0.0], [1.372], y_start=-0.03)[0, 0]
    nz = normals(fs, zp[None])[0]
    objs.append(box_obj('ZipPull', (0.0055, 0.0028, 0.017), 'Metal',
                        frame_matrix(zp + nz * 0.0055 + (0, 0, -0.004), (1, 0, 0), tuple(nz), (0, 0, 1)), 0.0012, 1))
    # left chest pocket with flap (character's left = -X), name tag sewn above it
    objs.append(patch('Pocket', fs, np.linspace(-0.038, -0.128, 3), np.linspace(1.165, 1.27, 4), 0.0032, 0.006,
                      'Suit', inset_edge=0.0008, y_start=0.0))
    objs.append(patch('Flap', fs, np.linspace(-0.035, -0.131, 3), np.linspace(1.236, 1.274, 2), 0.0068, 0.009,
                      'Suit', inset_edge=0.0012, y_start=0.0))
    tag_w, tag_h = TAG_SIZE
    cx, cz = TAG_CENTER
    objs.append(build_tag(fs, cx, cz, tag_w, tag_h))
    # knee pads
    for sx in (1, -1):
        kp = patch('Knee', fs, np.linspace(sx * 0.14, sx * 0.058, 3), np.linspace(0.48, 0.585, 3), 0.0028, 0.007,
                   'Suit', inset_edge=0.0012, y_start=0.0)
        shade(kp, True, 75)
        objs.append(kp)
    # belt + buckle
    belt, S = band_ring('Belt', fs, 1.035, 1.077, 0.0055, 0.009, 'Boots')
    objs.append(belt)
    front = S[0, 1]
    nb = normals(fs, front[None])[0]
    nb[2] = 0
    nb = nrm(nb)
    objs.append(box_obj('Buckle', (0.062, 0.008, 0.046), 'Metal',
                        frame_matrix(front + nb * 0.0115, (1, 0, 0), tuple(nb), (0, 0, 1)), 0.0025, 1))
    for side in (1, -1):
        objs.append(build_cuff(side))
    return objs


def build_torch():
    """Hand torch along local +Y (beam direction). Origin at the grip centre."""
    bm = bmesh.new()
    seg = 12
    # (y, radius) profile from tail to head
    prof = [(-0.088, 0.0), (-0.088, 0.0125), (-0.084, 0.0155), (-0.02, 0.0155), (-0.016, 0.0165), (0.012, 0.0165),
            (0.016, 0.0155), (0.046, 0.0158), (0.074, 0.0222), (0.092, 0.0228), (0.094, 0.0212), (0.0925, 0.019)]
    rings = []
    for y, r in prof:
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring.append(bm.verts.new((r * math.cos(a), y, r * math.sin(a))))
        rings.append(ring)
    faces_body = []
    for k in range(len(rings) - 1):
        for i in range(seg):
            a, b = rings[k][i], rings[k][(i + 1) % seg]
            c, d = rings[k + 1][(i + 1) % seg], rings[k + 1][i]
            if len({a, b, c, d}) == 4:
                faces_body.append(bm.faces.new((a, d, c, b)))
    lens = bm.faces.new([rings[-1][i] for i in range(seg)])
    bm.verts.ensure_lookup_table()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for fc in bm.faces:
        fc.material_index = 0
    lens.material_index = 1
    lens.normal_update()
    me = bpy.data.meshes.new('Torch')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('Torch', me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(MATS['Metal'])
    me.materials.append(MATS['Lens'])
    shade(ob, True, 40)
    return ob


# ----------------------------------------------------------------------------------------------
# 7. Build all geometry
# ----------------------------------------------------------------------------------------------
QUICK = ARGS.quick


def build_geometry():
    log('building fields + meshes')
    fs = suit_field()
    suit = remesh_sdf('Suit', fs, (-0.8, -0.22, 0.1), (0.8, 0.27, 1.58), 0.0045, 1760)
    assign(suit, 'Suit')
    set_normals(suit, field_normals(suit, fs))
    fh, fh_base = head_field()
    head = remesh_sdf('Head', fh, (-0.11, -0.13, 1.37), (0.11, 0.14, 1.8), 0.0016, 1120)
    assign(head, 'Skin')
    set_normals(head, field_normals(head, fh_base))   # shade as if the visor groove were not there
    visor = build_visor(fh_base)
    fhand = hand_field()
    hand = remesh_sdf('HandR', fhand, (-0.09, -0.06, -0.06), (0.225, 0.11, 0.045), 0.0011, 500, relax=2)
    Nc = field_normals(hand, fhand)
    set_coords(hand, hand_to_world(mesh_arrays(hand)))
    Nw = Nc @ H_M.T
    handL = hand.copy()
    handL.data = hand.data.copy()
    handL.name = 'HandL'
    bpy.context.scene.collection.objects.link(handL)
    set_coords(handL, mirror(mesh_arrays(handL)))
    handL.data.flip_normals()
    for h, N in ((hand, Nw), (handL, mirror(Nw))):
        assign(h, 'Skin')
        set_normals(h, N)
    fb, outline2d, frame, lift = boot_field()
    boot = remesh_sdf('BootR', fb, (0.0, -0.15, 0.0), (0.22, 0.25, 0.3), 0.002, 240, relax=1)
    n_upper = len(boot.data.vertices)
    sole = build_sole(outline2d, frame, lift)
    set_active(boot)
    sole.select_set(True)
    bpy.ops.object.join()                      # upper vertices first, then the sole
    bootL = boot.copy()
    bootL.data = boot.data.copy()
    bootL.name = 'BootL'
    bpy.context.scene.collection.objects.link(bootL)
    set_coords(bootL, mirror(mesh_arrays(bootL)))
    bootL.data.flip_normals()
    # upper: exact field normals (mirrored field for the left boot); sole: its own crisp corner normals
    for b, f in ((boot, fb), (bootL, lambda P: fb(mirror(P)))):
        assign(b, 'Boots')
        me = b.data
        Ng = normals(f, mesh_arrays(b))
        lv = np.empty(len(me.loops), np.int64)
        me.loops.foreach_get('vertex_index', lv)
        corner = np.array([n.vector[:] for n in me.corner_normals])
        out = np.where((lv < n_upper)[:, None], Ng[lv], corner)
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        me.normals_split_custom_set([tuple(n) for n in out])
        me.update()
    details = build_suit_details(fs)
    torch = build_torch()
    return dict(suit=suit, head=head, visor=visor, hands=(hand, handL), boots=(boot, bootL),
                details=details, torch=torch, fields=dict(suit=fs, head=fh, hand=fhand, boot=fb))


# ----------------------------------------------------------------------------------------------
# Preview rendering
# ----------------------------------------------------------------------------------------------
def setup_render(quick):
    sc = bpy.context.scene
    sc.render.resolution_x = sc.render.resolution_y = 800
    sc.render.film_transparent = False
    if quick:
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh = sc.display.shading
        sh.light = 'STUDIO'
        sh.color_type = 'MATERIAL'
        sh.show_cavity = True
        sh.show_specular_highlight = True
        sc.display.render_aa = '8'
        world = bpy.data.worlds.new('W') if not sc.world else sc.world
        sc.world = world
        world.color = (0.05, 0.055, 0.055)
    else:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
        ee = sc.eevee
        ee.taa_render_samples = 32
        for k, v in (('use_shadows', True), ('use_raytracing', False), ('shadow_ray_count', 3),
                     ('shadow_step_count', 12), ('use_soft_shadows', True)):
            if hasattr(ee, k):
                setattr(ee, k, v)
        world = sc.world or bpy.data.worlds.new('W')
        sc.world = world
        world.use_nodes = True
        bg = world.node_tree.nodes['Background']
        bg.inputs['Color'].default_value = (0.004, 0.005, 0.005, 1)
        bg.inputs['Strength'].default_value = 1.0
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
        sc.view_settings.exposure = 0.3
        if 'Floor' not in bpy.data.objects:
            bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
            fl = bpy.context.active_object
            fl.name = 'Floor'
            fl.data.materials.append(make_material('FloorMat', (0.035, 0.038, 0.038), 0.8))

        def light(name, kind, loc, target, energy, size, color):
            ld = bpy.data.lights.new(name, kind)
            ld.energy = energy
            ld.color = color
            if kind == 'AREA':
                ld.size = size
            else:
                ld.shadow_soft_size = size
            if hasattr(ld, 'shadow_filter_radius'):
                ld.shadow_filter_radius = 3.0
            lo = bpy.data.objects.new(name, ld)
            sc.collection.objects.link(lo)
            lo.location = loc
            d = Vector(target) - Vector(loc)
            lo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
            return lo
        if 'Key' not in bpy.data.objects:
            light('Key', 'AREA', (-1.8, 2.6, 2.8), (0, 0, 1.2), 40, 2.5, (0.8, 0.88, 1.0))     # dim, cool
            light('Rim', 'AREA', (1.3, -2.3, 2.3), (0, 0, 1.3), 300, 1.4, (0.65, 0.78, 1.0))   # rim lights
            light('Rim2', 'AREA', (-1.6, -2.0, 1.7), (0, 0, 1.2), 170, 1.2, (0.7, 0.82, 1.0))
            light('Fill', 'AREA', (2.6, 2.2, 0.6), (0, 0, 1.0), 6, 2.0, (1.0, 0.85, 0.7))
            torch = bpy.data.objects.get('Torch')
            if torch is not None:                                                         # the beam
                sd = bpy.data.lights.new('Beam', 'SPOT')
                sd.energy = 220
                sd.color = (1.0, 0.88, 0.7)
                sd.spot_size = math.radians(55)
                sd.spot_blend = 0.6
                sd.shadow_soft_size = 0.01
                so = bpy.data.objects.new('Beam', sd)
                sc.collection.objects.link(so)
                so.parent = torch
                so.location = (0, 0.1, 0)
                so.rotation_euler = (math.pi / 2, 0, 0)


def camera(name, loc, target, lens=50):
    sc = bpy.context.scene
    cd = bpy.data.cameras.get(name) or bpy.data.cameras.new(name)
    cd.lens = lens
    co = bpy.data.objects.get(name)
    if co is None:
        co = bpy.data.objects.new(name, cd)
        sc.collection.objects.link(co)
    co.location = loc
    d = Vector(target) - Vector(loc)
    co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = co
    return co


VIEWS = {
    'front': ((0.0, 3.1, 1.0), (0, 0, 0.9), 50),
    'threequarter': ((2.0, 2.4, 1.35), (0, 0, 0.92), 50),
    'side': ((3.1, 0.0, 1.0), (0, 0, 0.9), 50),
    'back': ((0.4, -3.1, 1.1), (0, 0, 0.9), 50),
    'head': ((0.25, 0.75, 1.7), (0, 0.02, 1.64), 70),
    'headside': ((0.75, 0.2, 1.68), (0, 0.0, 1.64), 70),
    'headfront': ((0.0, 0.8, 1.67), (0, 0.0, 1.62), 70),
    'hand': ((0.9, 0.7, 1.0), (0.55, 0.15, 0.95), 70),
    'torso': ((0.5, 1.6, 1.35), (0, 0.0, 1.22), 60),
    'collar': ((0.35, 0.9, 1.6), (0, 0.0, 1.42), 60),
    'backneck': ((0.3, -0.9, 1.6), (0, 0.0, 1.45), 60),
    'boots': ((0.7, 0.9, 0.3), (0, 0.05, 0.12), 60),
    'walk': ((2.6, 1.9, 1.15), (0, 0, 0.9), 50),
    'grip': ((0.55, 0.85, 1.3), (0.1, 0.36, 1.1), 70),
    'gripside': ((0.75, 0.3, 1.05), (0.1, 0.36, 1.1), 70),
    'feet': ((1.2, 1.3, 0.35), (0, 0.1, 0.15), 50),
    'shoulder': ((0.9, 0.6, 1.5), (0.15, 0.0, 1.3), 60),
    'hips': ((0.9, 1.1, 0.9), (0.0, 0.0, 0.85), 55),
    'tag': ((-0.25, 0.75, 1.38), (-0.08, 0.05, 1.28), 70),
    'reach': ((1.9, 2.6, 1.35), (0, 0.15, 1.0), 50),
}


def render_view(view, path, frame=None):
    loc, tgt, lens = VIEWS[view]
    camera('Cam_' + view, loc, tgt, lens)
    sc = bpy.context.scene
    if frame is not None:
        sc.frame_set(frame)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    log('  rendered', path)


# ----------------------------------------------------------------------------------------------
# 8. Armature (humanoid hierarchy, names are three.js-safe: no dots)
# ----------------------------------------------------------------------------------------------
SIDES = (('R', 1), ('L', -1))
FPS = 30


def side_map(sx):
    return (lambda p: _v(p)) if sx == 1 else mirror


def bone_specs():
    B = []

    def add(name, head, tail, parent, connect=False, zref=(0, 1, 0)):
        B.append((name, _v(head), _v(tail), parent, connect, _v(zref)))
    add('Hips', J['hips'], J['spine'], None)
    add('Spine', J['spine'], J['chest'], 'Hips', True)
    add('Chest', J['chest'], J['neck'], 'Spine', True)
    add('Neck', J['neck'], J['head'], 'Chest', True)
    add('Head', J['head'], J['head_top'], 'Neck', True)
    for sd, sx in SIDES:
        m = side_map(sx)
        add('Shoulder_' + sd, m(J['clav']), m(J['shoulder']), 'Chest', False, (0, 0, 1))
        add('UpperArm_' + sd, m(J['shoulder']), m(J['elbow']), 'Shoulder_' + sd, True, m(H_W))
        add('LowerArm_' + sd, m(J['elbow']), m(J['wrist']), 'UpperArm_' + sd, True, m(H_W))
        add('Hand_' + sd, m(J['wrist']), m(hand_to_world(FINGERS['Middle'][0])), 'LowerArm_' + sd, True, m(H_W))
        th = hand_to_world(np.array(THUMB))
        for i in range(3):
            add('Thumb%d_%s' % (i + 1, sd), m(th[i]), m(th[i + 1]),
                'Hand_' + sd if i == 0 else 'Thumb%d_%s' % (i, sd), i > 0, m(H_W))
        for fname in FINGERS:
            pts, _ = finger_joints(fname)
            W = hand_to_world(np.array(pts))
            for i in range(3):
                add('%s%d_%s' % (fname, i + 1, sd), m(W[i]), m(W[i + 1]),
                    'Hand_' + sd if i == 0 else '%s%d_%s' % (fname, i, sd), i > 0, m(H_W))
        add('UpperLeg_' + sd, m(J['hip']), m(J['knee']), 'Hips', False, (0, 1, 0))
        add('LowerLeg_' + sd, m(J['knee']), m(J['ankle']), 'UpperLeg_' + sd, True, (0, 1, 0))
        add('Foot_' + sd, m(J['ankle']), m(J['ball']), 'LowerLeg_' + sd, True, (0, 0, 1))
        add('Toes_' + sd, m(J['ball']), m(J['toe']), 'Foot_' + sd, True, (0, 0, 1))
    return B


BONES = [b[0] for b in bone_specs()]
BI = {n: i for i, n in enumerate(BONES)}


def build_armature():
    ad = bpy.data.armatures.new('WorkerRig')
    ad.display_type = 'STICK'
    ob = bpy.data.objects.new('Worker', ad)
    bpy.context.scene.collection.objects.link(ob)
    set_active(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, h, t, parent, connect, zref in bone_specs():
        eb = ad.edit_bones.new(name)
        eb.head = Vector(h)
        eb.tail = Vector(t)
        eb.align_roll(Vector(zref))
        if parent:
            eb.parent = ad.edit_bones[parent]
            eb.use_connect = connect
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return ob


# ----------------------------------------------------------------------------------------------
# 9. Skin weights: bone-heat (automatic weights) per part, then targeted fixes
# ----------------------------------------------------------------------------------------------
def get_W(ob):
    W = np.zeros((len(ob.data.vertices), len(BONES)))
    gmap = {g.index: BI.get(g.name) for g in ob.vertex_groups}
    for v in ob.data.vertices:
        for g in v.groups:
            j = gmap.get(g.group)
            if j is not None:
                W[v.index, j] = g.weight
    return W


def limit_normalize(W, k=4):
    W = np.where(W < 1e-3, 0.0, W)
    if W.shape[1] > k:
        thr = -np.sort(-W, axis=1)[:, k - 1:k]
        W = np.where(W >= thr, W, 0.0)
        # ties could leave >k; keep the first k
        over = (W > 0).sum(1) > k
        for i in np.nonzero(over)[0]:
            keep = np.argsort(-W[i])[:k]
            row = np.zeros_like(W[i])
            row[keep] = W[i, keep]
            W[i] = row
    s = W.sum(1, keepdims=True)
    return W / np.maximum(s, 1e-9)


def set_W(ob, W):
    W = limit_normalize(W)
    ob.vertex_groups.clear()
    for j, name in enumerate(BONES):
        g = ob.vertex_groups.new(name=name)
        for i in np.nonzero(W[:, j] > 0)[0]:
            g.add([int(i)], float(W[i, j]), 'REPLACE')


def bone_segments(arm):
    H = np.array([b.head_local[:] for b in arm.data.bones])
    T = np.array([b.tail_local[:] for b in arm.data.bones])
    names = [b.name for b in arm.data.bones]
    order = [names.index(n) for n in BONES]
    return H[order], T[order]


def seg_dist(V, H, T):
    d = T - H
    L2 = np.maximum((d * d).sum(1), 1e-12)
    t = np.clip(((V[:, None, :] - H[None]) * d[None]).sum(2) / L2[None], 0, 1)
    P = H[None] + t[..., None] * d[None]
    return _norm(V[:, None, :] - P)


def mask_bones(pred):
    return np.array([bool(pred(n)) for n in BONES])


def auto_weights(ob, arm):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    ob.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    W = get_W(ob)
    ob.parent = None
    ob.modifiers.clear()
    return W


def fill_missing(W, V, H, T, allowed):
    """Vertices without weights get the nearest allowed bone."""
    bad = W[:, allowed].sum(1) < 1e-3
    if bad.any():
        D = seg_dist(V[bad], H, T)
        D[:, ~allowed] = 1e9
        W[bad] = 0
        W[np.nonzero(bad)[0], D.argmin(1)] = 1.0
    return W, int(bad.sum())


def skin(G, arm):
    log('skinning')
    H, T = bone_segments(arm)
    side_of = np.array([1 if n.endswith('_R') else (-1 if n.endswith('_L') else 0) for n in BONES])
    fingers = mask_bones(lambda n: any(n.startswith(f) for f in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')))

    # --- suit: torso, sleeves, trousers
    suit = G['suit']
    V = mesh_arrays(suit)
    W = auto_weights(suit, arm)
    allowed = ~fingers & ~mask_bones(lambda n: n in ('Head',) or n.startswith(('Hand_', 'Toes_', 'Foot_')))
    W[:, ~allowed] = 0
    x = V[:, 0]
    W[np.ix_(x > 0.035, side_of == -1)] = 0      # no left bones on the right half and vice versa
    W[np.ix_(x < -0.035, side_of == 1)] = 0
    # trousers inside / above the boots follow the shin only
    for sd, sx in SIDES:
        low = (V[:, 2] < 0.34) & (x * sx > 0)
        W[low] = 0
        W[low, BI['LowerLeg_' + sd]] = 1.0
        # sleeves: below the elbow nothing but the arm chain
        far = (x * sx > 0.33)
        keep = mask_bones(lambda n: n in ('UpperArm_' + sd, 'LowerArm_' + sd))
        W[np.ix_(far, ~keep)] = 0
    W, nfix = fill_missing(W, V, H, T, allowed)
    set_W(suit, W)
    log('  suit: %d verts, %d filled' % (len(V), nfix))

    # --- head + neck
    head = G['head']
    V = mesh_arrays(head)
    W = auto_weights(head, arm)
    allowed = mask_bones(lambda n: n in ('Head', 'Neck', 'Chest'))
    W[:, ~allowed] = 0
    z = V[:, 2]
    low = smoothstep(1.47, 1.43, z)            # buried in the collar: stay with the chest
    W = W * (1 - low)[:, None]
    W[:, BI['Chest']] += low
    skull = smoothstep(1.575, 1.62, z) * (V[:, 1] > -0.2)
    W = W * (1 - skull)[:, None]
    W[:, BI['Head']] += skull
    W, nfix = fill_missing(W, V, H, T, allowed)
    set_W(head, W)

    # --- hands
    for hand, sd in zip(G['hands'], ('R', 'L')):
        V = mesh_arrays(hand)
        W = auto_weights(hand, arm)
        allowed = mask_bones(lambda n: n.endswith('_' + sd) and (n.startswith(('Hand_', 'LowerArm_')) or
                                                                  any(n.startswith(f) for f in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'))))
        W[:, ~allowed] = 0
        # each finger vertex keeps only its own chain (+ the hand near the knuckle)
        D = seg_dist(V, H, T)
        chains = {}
        for f in ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky'):
            idx = [BI['%s%d_%s' % (f, i, sd)] for i in (1, 2, 3)]
            chains[f] = idx
        fd = np.stack([D[:, c].min(1) for c in chains.values()], 1)
        near = fd.argmin(1)
        names = list(chains)
        for k, f in enumerate(names):
            sel = (near == k) & (fd[:, k] < 0.016)
            others = [j for kk, ff in enumerate(names) if kk != k for j in chains[ff]]
            W[np.ix_(sel, others)] = 0
        # wrist inside the sleeve rides with the forearm
        wr = arm.data.bones['Hand_' + sd].head_local
        dirf = Vector(arm.data.bones['LowerArm_' + sd].tail_local - arm.data.bones['LowerArm_' + sd].head_local).normalized()
        along = (V - np.array(wr[:])) @ np.array(dirf[:])
        fa = smoothstep(-0.005, -0.03, along)
        W = W * (1 - fa)[:, None]
        W[:, BI['LowerArm_' + sd]] += fa
        W, nfix = fill_missing(W, V, H, T, allowed)
        set_W(hand, W)

    # --- boots: rigid foot / toe / shaft split (procedural, exact)
    for boot, (sd, sx) in zip(G['boots'], SIDES):
        V = mesh_arrays(boot)
        an = side_map(sx)(J['ankle'])
        ball = side_map(sx)(J['ball'])
        fwd = _v((sx * math.sin(BOOT_YAW), math.cos(BOOT_YAW), 0))
        f = (V - ball) @ fwd
        shin = smoothstep(an[2] - 0.005, an[2] + 0.06, V[:, 2])
        toe = (1 - shin) * smoothstep(-0.012, 0.012, f)
        W = np.zeros((len(V), len(BONES)))
        W[:, BI['LowerLeg_' + sd]] = shin
        W[:, BI['Toes_' + sd]] = toe
        W[:, BI['Foot_' + sd]] = 1 - shin - toe
        set_W(boot, W)

    # --- details: copy weights from the closest surface they sit on
    def transfer(dst, src, srcW, k=6):
        Vs = mesh_arrays(src)
        kd = kdtree.KDTree(len(Vs))
        for i, v in enumerate(Vs):
            kd.insert(v, i)
        kd.balance()
        Vd = mesh_arrays(dst)
        W = np.zeros((len(Vd), len(BONES)))
        for i, v in enumerate(Vd):
            hits = kd.find_n(v, k)
            ws = np.array([1.0 / max(h[2], 1e-4) ** 2 for h in hits])
            ids = [h[1] for h in hits]
            W[i] = (srcW[ids] * ws[:, None]).sum(0) / ws.sum()
        set_W(dst, W)
    suitW = get_W(suit)
    for d in G['details']:
        transfer(d, suit, suitW)
    transfer(G['visor'], head, get_W(head))


def join_parts(G, arm):
    parts = [G['suit'], G['head'], G['visor'], *G['hands'], *G['boots'], *G['details']]
    for o in parts:
        if not o.data.uv_layers:
            lay = o.data.uv_layers.new(name='UVMap')
            lay.data.foreach_set('uv', np.zeros(len(lay.data) * 2))   # constant UVs: no seams, no splits
        o.parent = None
        o.modifiers.clear()
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = G['suit']
    bpy.ops.object.join()
    body = G['suit']
    body.name = 'WorkerMesh'
    body.data.name = 'WorkerMesh'
    # one material slot per material, fixed order
    body.parent = arm
    mod = body.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return body


FABRIC_TILE = 0.055        # metres of suit per repeat of the 256 px fabric normal map


def fabric_normal_image(size=256, seed=3):
    """Tileable twill weave normal map (numpy -> PNG packed into the .blend, embedded in the .glb)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size] / size
    n = 28                                         # threads per tile
    u, v = x * n, y * n
    rib = np.sin(2 * np.pi * (u + v) / 2.0)        # diagonal twill ribs
    cross = np.cos(2 * np.pi * u) * np.cos(2 * np.pi * v)
    noise = rng.standard_normal((size, size))
    for _ in range(3):                             # periodic blur keeps it tileable
        noise = (noise + np.roll(noise, 1, 0) + np.roll(noise, -1, 0) + np.roll(noise, 1, 1) + np.roll(noise, -1, 1)) / 5
    slub = np.cos(2 * np.pi * (y * 3 + 0.3 * np.sin(2 * np.pi * x * 2)))   # faint uneven yarn
    h = 0.55 * rib + 0.3 * cross + 2.2 * noise + 0.12 * slub
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    k = 0.9
    N = np.stack([-gx * k, -gy * k, np.ones_like(h)], -1)
    N /= np.linalg.norm(N, axis=-1, keepdims=True)
    rgba = np.concatenate([N * 0.5 + 0.5, np.ones((size, size, 1))], -1)
    img = bpy.data.images.new('SuitFabric_N', size, size, alpha=False)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.file_format = 'PNG'
    img.pack()
    return img


def apply_fabric(body):
    """Box-projected UVs (in fabric tiles) on every Suit face + a tangent-space normal map on Suit."""
    me = body.data
    suit_idx = [i for i, m in enumerate(me.materials) if m and m.name == 'Suit'][0]
    lay = me.uv_layers['UVMap']
    V = mesh_arrays(body)
    nl = len(me.loops)
    lv = np.empty(nl, np.int64)
    me.loops.foreach_get('vertex_index', lv)
    np_ = len(me.polygons)
    ls = np.empty(np_, np.int64)
    lt = np.empty(np_, np.int64)
    mi = np.empty(np_, np.int64)
    fn = np.empty(np_ * 3)
    me.polygons.foreach_get('loop_start', ls)
    me.polygons.foreach_get('loop_total', lt)
    me.polygons.foreach_get('material_index', mi)
    me.polygons.foreach_get('normal', fn)
    fn = fn.reshape(-1, 3)
    uv = np.empty(nl * 2)
    lay.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    poly_of_loop = np.repeat(np.arange(np_), lt)
    ax = np.abs(fn).argmax(1)[poly_of_loop]
    P = V[lv] / FABRIC_TILE
    proj = np.where(ax[:, None] == 0, P[:, [1, 2]], np.where(ax[:, None] == 1, P[:, [0, 2]], P[:, [0, 1]]))
    sel = mi[poly_of_loop] == suit_idx
    uv[sel] = proj[sel]
    lay.data.foreach_set('uv', uv.ravel())
    mat = MATS['Suit']
    nt = mat.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = fabric_normal_image()
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nmap.inputs['Strength'].default_value = 0.6
    nmap.uv_map = 'UVMap'
    nt.links.new(tex.outputs['Color'], nmap.inputs['Color'])
    nt.links.new(nmap.outputs['Normal'], nt.nodes['Principled BSDF'].inputs['Normal'])


def attach_torch(torch, arm):
    """Torch rides on Hand_R; beam = torch local +Y (glTF: local -Z)."""
    torch.parent = arm
    torch.parent_type = 'BONE'
    torch.parent_bone = 'Hand_R'
    bpy.context.view_layer.update()
    c = hand_to_world(TORCH_GRIP)
    a = nrm(H_M @ TORCH_AXIS)
    up = nrm(H_M @ (0, 0, 1.0))
    up = nrm(up - a * (up @ a))
    x = np.cross(a, up)
    M = frame_matrix(c, x, a, up)
    torch.matrix_world = M


TORCH_GRIP = _v((0.058, 0.004, -0.031))                  # canonical hand coords (inside the fist)
TORCH_AXIS = nrm((0.59, 0.81, 0.0))                       # diagonal across the palm, lens past the thumb


# ----------------------------------------------------------------------------------------------
# 10. Procedural posing: world-delta FK, analytic two-bone IK, foot roll
# ----------------------------------------------------------------------------------------------
def qrot(axis, deg):
    return Quaternion(Vector(nrm(axis)), math.radians(deg))


def qside(sd, axis_r, deg):
    """A rotation authored for the right side; mirrored (axis reflected, angle negated) for the left."""
    if sd == 'R':
        return qrot(axis_r, deg)
    return qrot(mirror(axis_r), -deg)


def qeuler(pitch=0.0, yaw=0.0, roll=0.0):
    """pitch about +X (positive tilts an upright bone backwards), yaw about +Z (positive turns left),
    roll about +Y (positive tilts the top towards +X)."""
    return qrot((0, 0, 1), yaw) @ qrot((1, 0, 0), pitch) @ qrot((0, 1, 0), roll)


def aim_quat(d0, r0, d1, r1):
    def basis(d, r):
        d = Vector(d).normalized()
        r = Vector(r)
        r = (r - d * r.dot(d)).normalized()
        return Matrix((d, r, d.cross(r))).transposed()
    return (basis(d1, r1) @ basis(d0, r0).transposed()).to_quaternion()


class Rig:
    def __init__(self, arm):
        self.arm = arm
        self.b = {n: arm.data.bones[n] for n in BONES}
        self.R = {n: self.b[n].matrix_local.to_quaternion() for n in BONES}
        self.h = {n: Vector(self.b[n].head_local) for n in BONES}
        self.t = {n: Vector(self.b[n].tail_local) for n in BONES}
        self.p = {n: (self.b[n].parent.name if self.b[n].parent else None) for n in BONES}
        self.L = {n: (self.t[n] - self.h[n]).length for n in BONES}


class Pose:
    def __init__(self, rig):
        self.rig = rig
        self.D = {}
        self.root = Vector((0, 0, 0))
        self._Q = {}
        self._P = {}

    def _clear(self):
        self._Q.clear()
        self._P.clear()

    def Q(self, n):
        if n not in self._Q:
            par = self.rig.p[n]
            q = self.D.get(n, Quaternion())
            self._Q[n] = (self.Q(par) @ q) if par else q.copy()
        return self._Q[n]

    def pos(self, n):
        if n not in self._P:
            par = self.rig.p[n]
            if par is None:
                self._P[n] = self.rig.h[n] + self.root
            else:
                self._P[n] = self.pos(par) + self.Q(par) @ (self.rig.h[n] - self.rig.h[par])
        return self._P[n]

    def tail(self, n):
        return self.pos(n) + self.Q(n) @ (self.rig.t[n] - self.rig.h[n])

    def local(self, n, q):
        self.D[n] = q
        self._clear()

    def world(self, n, q):
        par = self.rig.p[n]
        self.D[n] = (self.Q(par).inverted() @ q) if par else q
        self._clear()

    def basis_quats(self):
        out = {}
        for n in BONES:
            R = self.rig.R[n]
            out[n] = R.inverted() @ self.D.get(n, Quaternion()) @ R
        return out

    def root_basis_loc(self):
        return self.rig.R['Hips'].inverted() @ self.root


def two_bone(root, target, l1, l2, pole):
    d = target - root
    dist = min(max(d.length, 1e-4), (l1 + l2) * 0.9995)
    dn = d.normalized()
    a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    pp = Vector(pole) - dn * Vector(pole).dot(dn)
    if pp.length < 1e-6:
        pp = Vector((0, 1, 0)) - dn * dn.y
    pp.normalize()
    mid = root + dn * a + pp * h
    return mid, root + dn * dist, pp


def solve_chain(pose, upper, lower, target, pole, rest_pole):
    rig = pose.rig
    root = pose.pos(upper)
    mid, end, pp = two_bone(root, Vector(target), rig.L[upper], rig.L[lower], pole)
    d0 = rig.t[upper] - rig.h[upper]
    q_up = aim_quat(d0, Vector(rest_pole), mid - root, pp)
    pose.world(upper, q_up)
    carried = q_up @ (rig.t[lower] - rig.h[lower])
    q_lo = carried.rotation_difference(end - mid) @ q_up
    pose.world(lower, q_lo)
    return q_lo


REST_KNEE_POLE = Vector((0, 1, 0))


def rest_elbow_pole(sd):
    m = side_map(1 if sd == 'R' else -1)
    up, fo = m(D_UP), m(D_FORE)
    ant = fo - up * (fo @ up)
    return Vector(-nrm(ant))


def foot_ankle(sd, flat_ankle, pitch):
    """Ankle position for a foot whose flat-foot ankle would be at `flat_ankle`, rolled by `pitch`
    (deg, + = toes up, pivots on the heel; - = heel up, pivots on the ball)."""
    m = side_map(1 if sd == 'R' else -1)
    A0 = Vector(m(J['ankle']))
    piv = Vector(m((J['ankle'][0], J['ankle'][1] - 0.078, 0.0))) if pitch > 0 else Vector(m((J['ball'][0], J['ball'][1], 0.0)))
    pivot = Vector(flat_ankle) + (piv - A0)
    return pivot + qrot((1, 0, 0), pitch) @ (A0 - piv)


def place_leg(pose, sd, flat_ankle, pitch, toe_extra=0.0, pole=None, reach=0.999):
    rig = pose.rig
    up, lo = 'UpperLeg_' + sd, 'LowerLeg_' + sd
    hip = pose.pos(up)
    L = (rig.L[up] + rig.L[lo]) * reach
    ank = foot_ankle(sd, flat_ankle, pitch)
    # out of reach: roll onto the ball (heel rises) until the ankle is reachable
    if (ank - hip).length > L and pitch <= 0:
        lo_p, hi_p = -75.0, pitch
        for _ in range(30):
            mid = (lo_p + hi_p) / 2
            if (foot_ankle(sd, flat_ankle, mid) - hip).length > L:
                hi_p = mid
            else:
                lo_p = mid
        pitch = lo_p
        ank = foot_ankle(sd, flat_ankle, pitch)
    sx = 1 if sd == 'R' else -1
    pole = pole if pole is not None else Vector((0.12 * sx, 1, 0))
    solve_chain(pose, up, lo, ank, pole, REST_KNEE_POLE)
    pose.world('Foot_' + sd, qrot((1, 0, 0), pitch))
    pose.world('Toes_' + sd, qrot((1, 0, 0), max(pitch, 0.0) + toe_extra))
    return pitch


def place_arm(pose, sd, wrist, pole, twist=0.0):
    up, lo = 'UpperArm_' + sd, 'LowerArm_' + sd
    q_lo = solve_chain(pose, up, lo, wrist, pole, rest_elbow_pole(sd))
    if twist:
        ax = pose.tail(lo) - pose.pos(lo)
        sx = 1 if sd == 'R' else -1
        pose.world(lo, Quaternion(ax.normalized(), math.radians(twist * sx)) @ q_lo)


def aim_torch(pose, direction):
    """Rotate Hand_R (wrist) so the torch points along `direction`, keeping the hand's roll."""
    a_rest = Vector(H_M @ TORCH_AXIS)
    w_rest = Vector(H_W)
    qf = pose.Q('LowerArm_R')
    carried_w = qf @ w_rest
    pose.world('Hand_R', aim_quat(a_rest, w_rest, Vector(direction), carried_w))


def set_fingers(pose, sd, curls, spread=0.0, thumb=(0, 0, 0), thumb_opp=0.0):
    """curls: {finger: (mcp, pip, dip)} in degrees (flexion towards the palm)."""
    for fname, (k, spr, rest, lens, rad) in FINGERS.items():
        s = math.radians(spr)
        lat = H_M @ _v((-math.sin(s), math.cos(s), 0.0))
        c = curls.get(fname, (0, 0, 0))
        sp = spread * (spr / 12.0)
        for i in range(3):
            q = qside(sd, lat, c[i])
            if i == 0 and sp:
                q = qside(sd, H_W, sp) @ q
            pose.local('%s%d_%s' % (fname, i + 1, sd), q)
    # thumb: opposition swings it under the palm, then flexion of each segment
    tdir = nrm(_v(THUMB[1]) - _v(THUMB[0]))
    t_lat = H_M @ nrm(np.cross((0, 0, 1), tdir))
    pose.local('Thumb1_' + sd, qside(sd, H_M @ _v((1, 0, 0)), -thumb_opp) @ qside(sd, t_lat, thumb[0]))
    pose.local('Thumb2_' + sd, qside(sd, t_lat, thumb[1]))
    pose.local('Thumb3_' + sd, qside(sd, t_lat, thumb[2]))


GRIP = {'Index': (52, 78, 42), 'Middle': (60, 82, 42), 'Ring': (66, 82, 40), 'Pinky': (72, 78, 38)}
GRIP_THUMB = dict(thumb=(18, 32, 26), thumb_opp=34)
RELAX = {'Index': (14, 24, 12), 'Middle': (18, 30, 14), 'Ring': (22, 32, 15), 'Pinky': (26, 32, 15)}
CLAW = {'Index': (-8, 38, 34), 'Middle': (-6, 40, 36), 'Ring': (-4, 42, 36), 'Pinky': (0, 44, 36)}


def lerp(a, b, t):
    return a + (b - a) * t


def vlerp(a, b, t):
    return Vector(a).lerp(Vector(b), t)


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * t * (t * (t * 6 - 15) + 10)


def env(t, t0, t1, t2, t3):
    """0 before t0, rises to 1 at t1, holds, falls to 0 at t3."""
    if t <= t0 or t >= t3:
        return 0.0
    if t < t1:
        return ease((t - t0) / (t1 - t0))
    if t <= t2:
        return 1.0
    return 1.0 - ease((t - t2) / (t3 - t2))


# base standing posture parameters (everything an action may override)
def base_params():
    return dict(
        root=Vector((0, 0, -0.016)),
        hips=(-2.0, 0.0, 0.0), spine=(-2.0, 0.0, 0.0), chest=(-3.5, 0.0, 0.0),
        neck=(-13.0, 0.0, 0.0), head=(10.0, 0.0, 0.0),
        shoulder_R=(5.0, 2.0), shoulder_L=(5.0, 2.5),       # (protraction, depression) deg
        wrist_R=Vector((-0.05, 0.38, -0.165)), pole_R=Vector((0.6, -0.55, -0.6)),
        torch=Vector((-0.07, 1.0, -0.2)),
        wrist_L=Vector((-0.035, 0.065, -0.585)), pole_L=Vector((-0.35, -1.0, 0.0)),
        twist_L=-10.0, hand_L=(8.0, -6.0),                   # wrist flexion, ulnar deviation
        fingers_R=GRIP, thumb_R=GRIP_THUMB, fingers_L=RELAX, spread_L=0.0,
        thumb_L=dict(thumb=(12, 16, 10), thumb_opp=14),
        foot_R=(Vector(side_map(1)(J['ankle'])), 0.0), foot_L=(Vector(side_map(-1)(J['ankle'])), 0.0),
    )


def build_pose(rig, P):
    pose = Pose(rig)
    pose.root = Vector(P['root'])
    pose.local('Hips', qeuler(*P['hips']))
    pose.local('Spine', qeuler(*P['spine']))
    pose.local('Chest', qeuler(*P['chest']))
    pose.local('Neck', qeuler(*P['neck']))
    pose.local('Head', qeuler(*P['head']))
    for sd in ('R', 'L'):
        pro, dep = P['shoulder_' + sd]
        pose.local('Shoulder_' + sd, qside(sd, (0, 0, 1), pro) @ qside(sd, (0, 1, 0), dep))
    # arms
    place_arm(pose, 'R', pose.pos('UpperArm_R') + Vector(P['wrist_R']), P['pole_R'], P.get('twist_R', 0.0))
    aim_torch(pose, P['torch'])
    place_arm(pose, 'L', pose.pos('UpperArm_L') + Vector(P['wrist_L']), P['pole_L'], P.get('twist_L', 0.0))
    fl, dv = P['hand_L']
    pose.local('Hand_L', qside('L', H_V, fl) @ qside('L', H_W, dv))
    set_fingers(pose, 'R', P['fingers_R'], 0.0, **P['thumb_R'])
    set_fingers(pose, 'L', P['fingers_L'], P['spread_L'], **P['thumb_L'])
    # legs
    for sd in ('R', 'L'):
        fa, pitch = P['foot_' + sd][:2]
        extra = P['foot_' + sd][2] if len(P['foot_' + sd]) > 2 else 0.0
        place_leg(pose, sd, fa, pitch, extra)
    return pose


# ----------------------------------------------------------------------------------------------
# 11. Animation clips (30 fps). Hips never travel horizontally beyond a small zero-mean sway.
# ----------------------------------------------------------------------------------------------
def add_euler(a, d):
    return tuple(x + y for x, y in zip(a, d))


def idle_params(t):
    P = base_params()
    w = 2 * math.pi * t / 3.0
    b, sh = math.sin(w), math.sin(w)
    P['chest'] = add_euler(P['chest'], (1.4 * b, 0.0, 1.4 * sh))
    P['spine'] = add_euler(P['spine'], (0.4 * b, 0.0, 0.6 * sh))
    P['neck'] = add_euler(P['neck'], (-0.8 * b, 1.2 * math.sin(2 * w), -0.6 * sh))
    P['head'] = add_euler(P['head'], (-0.5 * b + 0.8 * math.sin(2 * w), 1.6 * math.sin(w), -0.4 * sh))
    P['hips'] = add_euler(P['hips'], (0.0, 0.8 * math.sin(w), -2.0 * sh))
    P['root'] = P['root'] + Vector((0.011 * sh, 0.0, -0.004 * math.sin(w) ** 2))
    for sd in ('R', 'L'):
        pro, dep = P['shoulder_' + sd]
        P['shoulder_' + sd] = (pro, dep - 1.3 * b)
    P['wrist_R'] = P['wrist_R'] + Vector((0.004 * math.sin(2 * w), 0.003 * math.sin(w), 0.005 * math.sin(3 * w)))
    P['torch'] = P['torch'] + Vector((0.025 * math.sin(2 * w), 0.0, 0.015 * math.sin(w)))
    P['wrist_L'] = P['wrist_L'] + Vector((0.0, 0.006 * math.sin(w), 0.004 * b))
    return P


def hermite(p0, p1, m0, m1, t):
    t2, t3 = t * t, t * t * t
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1


def catmull(pts, t):
    """Uniform Catmull-Rom through pts (list of Vectors) for t in [0,1]."""
    n = len(pts) - 1
    x = min(max(t, 0.0), 1.0) * n
    i = min(int(x), n - 1)
    u = x - i
    p0 = pts[max(i - 1, 0)]
    p1, p2 = pts[i], pts[i + 1]
    p3 = pts[min(i + 2, n)]
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)


def flat_for(sd, ankle, pitch):
    """Inverse of foot_ankle: the flat-foot ankle that puts the real ankle at `ankle` for `pitch`."""
    A0 = Vector(side_map(1 if sd == 'R' else -1)(J['ankle']))
    return Vector(ankle) - (foot_ankle(sd, A0, pitch) - A0)


def foot_clear(sd, flat, pitch, clearance):
    """Lift a swinging foot so its toe tip and heel stay above the floor."""
    m = side_map(1 if sd == 'R' else -1)
    A0 = Vector(m(J['ankle']))
    ank = foot_ankle(sd, flat, pitch)
    q = qrot((1, 0, 0), pitch)
    pts = [Vector(m(J['toe'])) + Vector((0, 0.01, -0.028)), Vector(m((J['ankle'][0], J['ankle'][1] - 0.078, 0.0)))]
    low = min((ank + q @ (p - A0)).z for p in pts)
    if low < clearance:
        flat = flat + Vector((0, 0, clearance - low))
    return flat


def gait_feet(t, T, speed, duty, F_hs, hs_pitch, to_pitch, swing_fn):
    """Returns {side: (flat_ankle, pitch, toe_extra, in_stance)} for a cycle with the right heel strike at 0."""
    out = {}
    Ts = duty * T
    travel = speed * Ts
    F_to = F_hs - travel
    for sd, off in (('R', 0.0), ('L', 0.5)):
        A0 = Vector(side_map(1 if sd == 'R' else -1)(J['ankle']))
        ph = (t / T + off) % 1.0
        if ph < duty:
            s = ph / duty
            F = F_hs - travel * s
            pitch = hs_pitch * (1 - ease(s / 0.14)) if s < 0.14 else 0.0
            if s > 0.62:
                pitch = to_pitch * ease((s - 0.62) / 0.38) ** 1.4
            out[sd] = (A0 + Vector((0, F, 0)), pitch, 0.0, True)
        else:
            w = (ph - duty) / (1 - duty)
            a_to = foot_ankle(sd, A0 + Vector((0, F_to, 0)), to_pitch)
            a_hs = foot_ankle(sd, A0 + Vector((0, F_hs, 0)), hs_pitch)
            ank, pitch = swing_fn(sd, w, a_to, a_hs, (1 - duty) * T)
            flat = flat_for(sd, ank, pitch)
            flat = foot_clear(sd, flat, pitch, 0.012 + 0.02 * math.sin(math.pi * w))
            out[sd] = (flat, pitch, 0.0, False)
    return out


def hip_heights(rig, params_fn, feet_fn, nfr, T, nominal, reach=0.982):
    """Highest hip height each frame that keeps every planted foot reachable, smoothed over the loop."""
    zs = []
    for f in range(nfr):
        t = f / FPS
        P = params_fn(t)
        pose = Pose(rig)
        pose.root = Vector((P['root'].x, P['root'].y, 0.0))
        pose.local('Hips', qeuler(*P['hips']))
        zmax = nominal
        for sd, (flat, pitch, _, planted) in feet_fn(t).items():
            if not planted:
                continue
            hip = pose.pos('UpperLeg_' + sd)
            ank = foot_ankle(sd, flat, max(pitch, 0.0))
            L = (rig.L['UpperLeg_' + sd] + rig.L['LowerLeg_' + sd]) * reach
            dxy2 = (ank.x - hip.x) ** 2 + (ank.y - hip.y) ** 2
            zmax = min(zmax, ank.z + math.sqrt(max(L * L - dxy2, 0.0)) - (hip.z - pose.root.z))
        zs.append(zmax)
    zs = np.array(zs)
    k = np.array([1, 2, 3, 2, 1], float)
    k /= k.sum()
    sm = sum(np.roll(zs, i - 2) * k[i] for i in range(5))
    return np.minimum(sm, zs + 0.004) - 0.002


def walk_setup(rig):
    T, speed, duty = 1.1, 1.4, 0.62

    def swing(sd, w, a_to, a_hs, Tsw):
        m = -0.35 * speed * Tsw
        y = hermite(a_to.y, a_hs.y, m, m, w)
        z = lerp(a_to.z, a_hs.z, w) + 0.05 * math.sin(math.pi * min(w * 1.15, 1.0)) ** 1.2
        x = lerp(a_to.x, a_hs.x, w)
        pitch = lerp(-36.0, 16.0, ease(min(1.0, w * 1.35)))
        return Vector((x, y, z)), pitch

    feet = lambda t: gait_feet(t, T, speed, duty, 0.415, 16.0, -36.0, swing)

    def upper(t):
        P = base_params()
        ph = 2 * math.pi * t / T
        c, s2 = math.cos(ph), math.sin(ph)
        P['hips'] = (-3.0, 5.0 * c, -3.0 * s2)
        P['spine'] = (-1.5, -2.0 * c, 1.4 * s2)
        P['chest'] = (-3.0, -3.5 * c, 1.2 * s2)
        P['neck'] = (-12.0, -0.5 * c, -0.8 * s2)
        P['head'] = (8.5 + 1.5 * math.sin(2 * ph), 1.0 * c, -0.6 * s2)
        P['root'] = Vector((0.011 * s2, 0.0, 0.0))
        P['wrist_L'] = P['wrist_L'] + Vector((0.012, 0.21 * c, 0.035 * max(c, 0) ** 2 + 0.015 * c))
        P['pole_L'] = Vector((-0.3, -1.0, -0.15))
        P['hand_L'] = (8.0 + 6.0 * c, -6.0)
        P['wrist_R'] = P['wrist_R'] + Vector((0.0, -0.035 * c, 0.012 * math.cos(2 * ph)))
        P['torch'] = P['torch'] + Vector((0.04 * c, 0.0, 0.025 * math.cos(2 * ph)))
        return P
    nfr = int(round(T * FPS))
    nominal = -0.012
    zs = hip_heights(rig, upper, feet, nfr, T, nominal)

    def params(t):
        P = upper(t)
        f = int(round(t * FPS)) % nfr
        P['root'] = Vector((P['root'].x, P['root'].y, float(zs[f])))
        for sd, (flat, pitch, extra, planted) in feet(t).items():
            P['foot_' + sd] = (flat, pitch, extra)
        return P
    return params, nfr


def run_setup(rig):
    T, speed, duty = 0.7, 4.3, 0.31

    def swing(sd, w, a_to, a_hs, Tsw):
        A0 = Vector(side_map(1 if sd == 'R' else -1)(J['ankle']))
        pts = [a_to, A0 + Vector((0, -0.48, 0.25)), A0 + Vector((0, -0.12, 0.36)),
               A0 + Vector((0, 0.24, 0.2)), a_hs]
        ank = catmull(pts, w)
        pitch = float(np.interp(w, [0, 0.25, 0.5, 0.75, 1.0], [-48, -62, -35, -4, 4]))
        return ank, pitch

    feet = lambda t: gait_feet(t, T, speed, duty, 0.28, 4.0, -46.0, swing)

    def params(t):
        P = base_params()
        ph = 2 * math.pi * t / T
        c, s2 = math.cos(ph), math.sin(ph)
        mid = 2 * math.pi * (t / T - duty / 2)
        P['root'] = Vector((0.008 * s2, 0.0, -0.075 + 0.05 * math.sin(mid) ** 2))
        P['hips'] = (-9.0, 7.0 * c, -3.0 * s2)
        P['spine'] = (-5.0, -3.0 * c, 1.0 * s2)
        P['chest'] = (-3.5, -5.0 * c, 1.0 * s2)
        P['neck'] = (-4.0, -1.0 * c, 0.0)
        P['head'] = (13.0, 2.0 * c, -0.5 * s2)
        P['shoulder_L'] = (4.0, 1.0)
        P['wrist_L'] = Vector((0.02, 0.13 + 0.2 * c, -0.37 + 0.07 * c))
        P['pole_L'] = Vector((-0.25, -1.0, -0.3))
        P['hand_L'] = (6.0, -4.0)
        P['fingers_L'] = {k: (v[0] + 18, v[1] + 25, v[2] + 15) for k, v in RELAX.items()}
        P['wrist_R'] = Vector((-0.05, 0.3 - 0.07 * c, -0.27 + 0.03 * c))
        P['torch'] = Vector((-0.05 + 0.05 * c, 1.0, -0.12 + 0.04 * math.cos(2 * ph)))
        for sd, (flat, pitch, extra, planted) in feet(t).items():
            P['foot_' + sd] = (flat, pitch, extra)
        return P
    return params, int(round(T * FPS))


def twitch_params(t):
    P = base_params()
    snap_in = 1 - (1 - min(t / 0.055, 1.0)) ** 3
    e = snap_in if t < 0.055 else env(t, -1, 0.0, 0.24, 0.58)
    if t >= 0.58:
        e = 0.0
    jit = math.sin(2 * math.pi * 19 * t) * env(t, 0.02, 0.07, 0.2, 0.34)
    jolt = env(t, 0.0, 0.04, 0.06, 0.2)
    P['head'] = add_euler(P['head'], (-6 * e, -14 * e + 4.5 * jit, 34 * e + 2.5 * jit))
    P['neck'] = add_euler(P['neck'], (-4 * e, -3 * e, 12 * e))
    P['chest'] = add_euler(P['chest'], (3.5 * jolt, 1.5 * e, -3 * e))
    P['shoulder_R'] = (5.0 + 6 * e, 2.0 - 17 * e)
    P['shoulder_L'] = (5.0, 2.5 + 5 * e)
    P['wrist_R'] = P['wrist_R'] + Vector((0.01 * e, 0.0, 0.035 * e + 0.006 * jit))
    P['torch'] = P['torch'] + Vector((0.12 * e, 0.0, 0.1 * e))
    P['fingers_L'] = {k: (v[0] + 30 * e, v[1] + 35 * e, v[2] + 20 * e) for k, v in RELAX.items()}
    return P


def look_params(t):
    P = base_params()
    e = env(t, 0.0, 0.5, 0.68, 1.2)
    P['head'] = add_euler(P['head'], (3 * e, 42 * e, -5 * e))
    P['neck'] = add_euler(P['neck'], (0.0, 22 * e, -1 * e))
    P['chest'] = add_euler(P['chest'], (0.0, 6 * e, 0.0))
    return P


def reach_params(t):
    P = base_params()
    a = env(t, 0.0, 0.09, 0.09, 0.2)                 # anticipation: draw back
    e = env(t, 0.07, 0.28, 0.48, 0.8)                # lunge, hold, recover
    tr = math.sin(2 * math.pi * 14 * t) * env(t, 0.26, 0.3, 0.44, 0.5)   # strained tremor at full reach
    P['root'] = P['root'] + Vector((0.0, 0.0, -0.085 * e))
    P['hips'] = add_euler(P['hips'], (-14 * e, -4 * e, 0.0))
    P['spine'] = add_euler(P['spine'], (-12 * e + 2 * a, 0.0, 0.0))
    P['chest'] = add_euler(P['chest'], (-10 * e + 5 * a, 3 * e, 0.0))
    P['neck'] = add_euler(P['neck'], (-10 * e - 4 * a, 0.0, 0.0))
    P['head'] = add_euler(P['head'], (24 * e + 1.5 * tr, 0.0, 0.0))
    P['shoulder_R'] = (5.0 + 20 * e, 2.0 - 8 * e)
    P['shoulder_L'] = (5.0 + 20 * e, 2.5 - 8 * e)
    P['wrist_R'] = vlerp(P['wrist_R'], (-0.06, 0.6, 0.0), e) + Vector((0, -0.07 * a, 0.03 * a + 0.004 * tr))
    P['wrist_L'] = vlerp(P['wrist_L'], (0.06, 0.6, 0.02), e) + Vector((0, -0.07 * a, 0.03 * a - 0.004 * tr))
    P['pole_R'] = vlerp(P['pole_R'], (0.7, -0.2, -1.0), e)
    P['pole_L'] = vlerp(P['pole_L'], (-0.7, -0.2, -1.0), e)
    P['twist_L'] = lerp(-10.0, -70.0, e)
    P['hand_L'] = (lerp(8.0, -24.0, e), -6.0)
    P['torch'] = vlerp(P['torch'], (0.0, 1.0, -0.1), e)
    P['fingers_L'] = {k: tuple(lerp(RELAX[k][i], CLAW[k][i], e) for i in range(3)) for k in RELAX}
    P['spread_L'] = 16 * e
    P['thumb_L'] = dict(thumb=(12 - 14 * e, 16 + 6 * e, 10 + 10 * e), thumb_opp=14 - 4 * e)
    # the left foot steps into the lunge and back again; the right heel peels up
    A0 = Vector(side_map(-1)(J['ankle']))
    step = ease((t - 0.07) / 0.2) if t < 0.48 else 1 - ease((t - 0.5) / 0.28)
    lift = 0.05 * math.sin(math.pi * min(max((t - 0.07) / 0.2, 0), 1)) + \
        0.04 * math.sin(math.pi * min(max((t - 0.5) / 0.28, 0), 1))
    P['foot_L'] = (A0 + Vector((0.0, 0.28 * step, lift)), 0.0)
    return P


def bake_action(rig, name, params_fn, nfr, loop):
    """Sample the procedural clip every frame into a Blender action (frames 0..nfr)."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    qs = {n: [] for n in BONES}
    locs = []
    for f in range(nfr + 1):
        t = (f % nfr if loop else f) / FPS
        pose = build_pose(rig, params_fn(t))
        B = pose.basis_quats()
        for n in BONES:
            q = B[n].normalized()
            if qs[n] and qs[n][-1].dot(q) < 0:
                q = -q
            qs[n].append(q)
        locs.append(pose.root_basis_loc())
    frames = np.arange(nfr + 1, dtype=float)
    for n in BONES:
        path = 'pose.bones["%s"].rotation_quaternion' % n
        arr = np.array([q[:] for q in qs[n]])
        for i in range(4):
            fc = act.fcurves.new(path, index=i, action_group=n)
            fc.keyframe_points.add(nfr + 1)
            co = np.empty(2 * (nfr + 1))
            co[0::2] = frames
            co[1::2] = arr[:, i]
            fc.keyframe_points.foreach_set('co', co)
            fc.update()
    arr = np.array([v[:] for v in locs])
    for i in range(3):
        fc = act.fcurves.new('pose.bones["Hips"].location', index=i, action_group='Hips')
        fc.keyframe_points.add(nfr + 1)
        co = np.empty(2 * (nfr + 1))
        co[0::2] = frames
        co[1::2] = arr[:, i]
        fc.keyframe_points.foreach_set('co', co)
        fc.update()
    for fc in act.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
    act.use_frame_range = True
    act.frame_start = 0
    act.frame_end = nfr
    act.use_cyclic = loop
    return act


CLIPS = {}


def build_actions(arm):
    log('baking actions')
    rig = Rig(arm)
    walk, nw = walk_setup(rig)
    run, nr = run_setup(rig)
    spec = [('Idle', idle_params, 90, True), ('Walk', walk, nw, True), ('Run', run, nr, True),
            ('Twitch', twitch_params, 18, False), ('Reach', reach_params, 24, False), ('Look', look_params, 36, False)]
    arm.animation_data_create()
    for name, fn, nfr, loop in spec:
        act = bake_action(rig, name, fn, nfr, loop)
        CLIPS[name] = (act, nfr, loop)
        tr = arm.animation_data.nla_tracks.new()
        tr.name = name
        tr.strips.new(name, 0, act)
        tr.mute = True
        log('  %-6s %3d frames  %.2fs  %s' % (name, nfr, nfr / FPS, 'loop' if loop else 'once'))
    # one-shots must start and end exactly on the Idle base pose (seamless cross-fades)
    def frame_q(act, fr):
        out = []
        for n in BONES:
            path = 'pose.bones["%s"].rotation_quaternion' % n
            out.append(Quaternion([act.fcurves.find(path, index=i).evaluate(fr) for i in range(4)]))
        return out
    base = frame_q(CLIPS['Idle'][0], 0)
    for name in ('Twitch', 'Reach', 'Look'):
        act, nfr, _ = CLIPS[name]
        for fr in (0, nfr):
            err = max(math.degrees(a.rotation_difference(b).angle) for a, b in zip(base, frame_q(act, fr)))
            assert err < 0.05, (name, fr, err)
    arm.animation_data.action = CLIPS['Idle'][0]


def use_clip(arm, name, frame):
    arm.animation_data.action = CLIPS[name][0]
    bpy.context.scene.frame_set(frame)


# ----------------------------------------------------------------------------------------------
# 12. Export + verification
# ----------------------------------------------------------------------------------------------
def export_glb(path, arm, body, torch):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in (arm, body, torch):
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    arm.animation_data.action = None
    for tr in arm.animation_data.nla_tracks:
        tr.mute = True
    bpy.context.scene.frame_set(0)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
        export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
        export_vertex_color='NONE', export_cameras=False, export_lights=False, export_extras=False,
        export_skins=True, export_all_influences=False, export_def_bones=False, export_leaf_bone=False,
        export_morph=False, export_animations=True, export_animation_mode='ACTIONS',
        export_anim_single_armature=True, export_force_sampling=True, export_frame_step=1,
        export_optimize_animation_size=True, export_reset_pose_bones=True,
        export_rest_position_armature=True, export_anim_slide_to_zero=True,
        export_draco_mesh_compression_enable=False, export_image_format='AUTO')
    log('exported %s (%.1f KB)' % (path, os.path.getsize(path) / 1024))


def read_glb_json(path):
    import json
    import struct
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546C67 and version == 2
    clen, ctype = struct.unpack_from('<II', data, 12)
    return json.loads(data[20:20 + clen].decode('utf-8'))


def verify_glb(path):
    """Check the file itself (clip names/durations, skin, materials, torch node), then re-import it
    into an empty Blender scene and confirm the skin actually deforms under every clip."""
    gl = read_glb_json(path)
    rep = {}
    acc = gl['accessors']
    rep['clips'] = {a['name']: round(max(acc[s['input']]['max'][0] for s in a['samplers']), 3) for a in gl['animations']}
    rep['materials'] = [m['name'] for m in gl['materials']]
    rep['double_sided'] = [m['name'] for m in gl['materials'] if m.get('doubleSided')]
    skin = gl['skins'][0]
    rep['joints'] = len(skin['joints'])
    nodes = gl['nodes']
    torch = next(i for i, n in enumerate(nodes) if n.get('name') == 'Torch')
    parent = next(n['name'] for n in nodes if torch in n.get('children', []))
    rep['torch_parent'] = parent
    rep['tris'] = sum(acc[p['indices']]['count'] // 3 for m in gl['meshes'] for p in m['primitives'])
    rep['vertices'] = sum(acc[p['attributes']['POSITION']]['count'] for m in gl['meshes'] for p in m['primitives'])
    # re-import
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    body = next(o for o in bpy.data.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers))
    rest = np.array([(body.matrix_world @ v.co)[:] for v in body.data.vertices])
    rep['bind_pose_bbox_blender'] = [round(float(x), 3) for x in rest.min(0).tolist() + rest.max(0).tolist()]
    sc = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    moved, floor = {}, {}
    for act in bpy.data.actions:
        arm.animation_data.action = act
        fr0, fr1 = act.frame_range
        ds, fl = [], []
        for k in range(5):
            sc.frame_set(int(round(fr0 + (fr1 - fr0) * k / 4)))
            dg.update()
            ev = body.evaluated_get(dg)
            me = ev.to_mesh()
            P = np.array([(ev.matrix_world @ v.co)[:] for v in me.vertices])
            ev.to_mesh_clear()
            ds.append(np.abs(P - rest).max())
            fl.append(P[:, 2].min())
        moved[act.name] = round(float(max(ds)), 3)
        floor[act.name] = round(float(min(fl)), 3)
    rep['max_skin_displacement_m'] = moved
    rep['lowest_vertex_z'] = floor
    return rep


# ----------------------------------------------------------------------------------------------
# 13. Main
# ----------------------------------------------------------------------------------------------
def count_tris(objs):
    n = 0
    for o in objs:
        o.data.calc_loop_triangles()
        n += len(o.data.loop_triangles)
    return n


def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 0, 90
    build_materials()
    G = build_geometry()
    arm = build_armature()
    skin(G, arm)
    body = join_parts(G, arm)
    attach_torch(G['torch'], arm)
    if not ARGS.no_fabric:
        apply_fabric(body)
    tris = count_tris([body, G['torch']])
    if tris > 12000:
        log('WARNING: %d triangles is over the 12k budget' % tris)
    log('triangles: body %d + torch %d = %d' % (count_tris([body]), count_tris([G['torch']]), tris))
    build_actions(arm)
    if ARGS.renders:
        os.makedirs(ARGS.renders, exist_ok=True)
        setup_render(ARGS.quick)
        shots = {'front': ('Idle', 0), 'threequarter': ('Idle', 0), 'walk': ('Walk', 7), 'reach': ('Reach', 10)}
        for v in ARGS.views.split(','):
            clip, fr = shots.get(v, ('Idle', 0))
            fname = v
            if ':' in v:
                v, clip, fr = v.split(':')
                fr = int(fr)
                fname = '%s_%s%02d' % (v, clip.lower(), fr)
            use_clip(arm, clip, fr)
            render_view(v, os.path.join(ARGS.renders, fname + '.png'))
    if ARGS.blend:
        bpy.ops.wm.save_as_mainfile(filepath=ARGS.blend)
    if not ARGS.no_export:
        export_glb(ARGS.out, arm, body, G['torch'])
        rep = verify_glb(ARGS.out)
        for k, v in rep.items():
            log('verify', k, v)
    log('done')


main()
