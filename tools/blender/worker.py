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
    --blend PATH      also save the generated scene as a .blend
    --no-export       skip the glTF export / verification

Modelling approach: every body part is a signed distance field (numpy) built from smooth-blended
anatomical primitives. Each field is polygonised (surface nets), retopologised to clean quads with
QuadriFlow, then snapped back onto the exact field. Clothing details are thin shells conformed to
the suit field. Coordinates while building: Blender Z-up, the character faces +Y and its right
hand is +X, so after the +Y-up glTF conversion it faces -Z with feet on y = 0.
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
    set_active(ob)
    res = bpy.ops.object.quadriflow_remesh(mode='FACES', target_faces=faces, seed=7,
                                           use_mesh_symmetry=False, use_preserve_sharp=False,
                                           use_preserve_boundary=False, smooth_normals=False)
    if 'FINISHED' not in res:
        raise RuntimeError('quadriflow failed for ' + name)
    V = snap(f, mesh_arrays(ob), iters=6)
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


def solidify(ob, thickness, offset=-1.0, rim=True):
    m = ob.modifiers.new('solid', 'SOLIDIFY')
    m.thickness = thickness
    m.offset = offset
    m.use_even_offset = True
    m.use_rim = rim
    m.use_quality_normals = True
    apply_modifiers(ob)


def apply_modifiers(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)


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
HEAD_C = _v((0, 0.008, 1.672))                         # centre of the skull
NECK_AXIS = _v((0, -0.026, 0))


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
            (sd_ellipsoid(m((0.062, 0.045, 1.312)), (0.074, 0.056, 0.062)), 0.045),          # chest
            (sd_ellipsoid(m((0.07, -0.068, 1.33)), (0.08, 0.055, 0.095)), 0.045),            # scapula
            (sd_round_cone(m((0.035, -0.03, 1.462)), m((0.16, -0.028, 1.425)), 0.045, 0.042), 0.04),  # trapezius
            (sd_ellipsoid(m(S + (0.014, 0.0, -0.012)), (0.058, 0.064, 0.058)), 0.03),       # deltoid
            (sd_ellipsoid(m((0.064, -0.052, 0.935)), (0.08, 0.068, 0.09)), 0.035),           # seat
        ]
    torso = U((sd_ellipsoid((0, -0.012, 1.283), (0.147, 0.106, 0.172)), 0),
              (sd_ellipsoid((0, 0.0, 1.135), (0.138, 0.098, 0.13)), 0.07),
              (sd_ellipsoid((0, -0.008, 0.99), (0.16, 0.11, 0.112)), 0.06),
              (sd_ellipsoid((0, -0.066, 1.468), (0.066, 0.042, 0.052)), 0.04),       # base of the neck (C7)
              *parts)
    # neck opening: the head's neck passes through a hole in the suit, hidden by the collar
    hole = sd_limb((0, NECK_AXIS[1], 1.385), (0, NECK_AXIS[1], 1.75), 0.068, 0.068)
    torso = SUB(torso, hole, 0.006)
    limbs = []
    for sx in (1, -1):
        m = (lambda p: p) if sx == 1 else mirror
        d = m(D_FORE)
        arm = U(sd_round_cone(m(S), m(E), 0.057, 0.049),
                (sd_round_cone(m(E), m(cuff_end), 0.049, 0.041), 0.012))
        arm = INTER(arm, sd_plane(m(cuff_end), d), 0.004)
        leg = U(sd_round_cone(m(J['hip'] + (0, -0.004, 0.035)), m(J['knee']), 0.095, 0.066),
                (sd_round_cone(m(J['knee']), m((0.104, -0.02, 0.2)), 0.066, 0.058), 0.015),
                (sd_ellipsoid(m((0.104, -0.018, 0.262)), (0.071, 0.073, 0.032)), 0.02))  # blousing over boot
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


def head_field():
    C = HEAD_C
    def at(o):
        return C + _v(o)
    parts = [
        (sd_ellipsoid(at((0, -0.012, 0.012)), (0.0765, 0.098, 0.097)), 0),                 # cranium
        (sd_ellipsoid(at((0, 0.046, -0.038)), (0.058, 0.056, 0.07)), 0.03),                # face mass
        (sd_sphere(at((0, 0.083, -0.106)), 0.019), 0.03),                                   # chin
        (sd_ellipsoid(at((0, 0.088, 0.03)), (0.058, 0.017, 0.014)), 0.022),                # brow
        (sd_round_cone((0, -0.03, 1.39), at((0, -0.022, -0.07)), 0.0595, 0.0535), 0.04),  # neck
    ]
    for sx in (1, -1):
        m = (lambda p: p) if sx == 1 else mirror
        parts += [
            (sd_round_cone(m(at((0.059, -0.012, -0.022))), m(at((0.054, -0.004, -0.083))), 0.012, 0.013), 0.025),  # ramus
            (sd_round_cone(m(at((0.054, -0.004, -0.083))), m(at((0.014, 0.078, -0.108))), 0.013, 0.014), 0.025),  # jaw
            (sd_ellipsoid(m(at((0.05, 0.066, -0.014))), (0.02, 0.018, 0.0135)), 0.016),                       # cheekbone
            (sd_round_cone(m(at((0.052, -0.03, -0.062))), m((0.016, 0.016, 1.47)), 0.012, 0.0105), 0.022),     # neck muscle
            (sd_ellipsoid(m(at((0.0745, -0.014, -0.006))), (0.0085, 0.02, 0.029),
                          Matrix.Rotation(math.radians(-14), 3, 'X').transposed()), 0.008),               # ear
        ]
    head = U(*parts)
    for sx in (1, -1):
        m = (lambda p: p) if sx == 1 else mirror
        head = SUB(head, sd_ellipsoid(m(at((0.031, 0.104, 0.006))), (0.02, 0.014, 0.0125)), 0.012)   # sockets
        head = SUB(head, sd_sphere(m(at((0.078, 0.05, 0.03))), 0.016), 0.02)                         # temples
    head = INTER(head, sd_plane((0, 0, 1.385), (0, 0, -1)), 0.004)
    return head


def hand_field():
    """Right hand in canonical coordinates (u fingers, v thumb, w back of hand)."""
    parts = [
        (sd_limb((-0.075, 0, 0.0), (0.004, 0, -0.001), 0.0285, 0.0275, squash=0.7, side=(0, 0, 1)), 0),  # wrist
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
        circles = [((0.0, -0.052), 0.043), ((0.004, 0.055), 0.047), ((0.006, 0.122), 0.054), ((-0.002, 0.172), 0.045)]
        d = None
        for (cx, cy), r in circles:
            dd = np.sqrt((q[:, 0] - cx) ** 2 + (q[:, 1] - cy) ** 2) - (r + grow)
            d = dd if d is None else _smin(d, dd, 0.035)
        return d, q

    def sole(P):
        d2, q = outline2d(P)
        top = np.where(q[:, 1] < 0.0, 0.036, 0.026)
        top = 0.026 + 0.01 * smoothstep(0.02, -0.02, q[:, 1])
        dz = np.maximum(-q[:, 2], q[:, 2] - top)
        w = np.stack([np.maximum(d2 + 0.004, 0), np.maximum(dz + 0.004, 0)], 1)
        return _norm(w) + np.minimum(np.maximum(d2 + 0.004, dz + 0.004), 0) - 0.004

    upper = U(sd_ellipsoid(L((0, -0.036, 0.068)), (0.047, 0.056, 0.062)),
              (sd_round_cone(L((0, 0.0, 0.074)), L((0.004, 0.128, 0.052)), 0.05, 0.041), 0.03),
              (sd_ellipsoid(L((0.001, 0.152, 0.047)), (0.05, 0.058, 0.031)), 0.02),            # toe cap
              (sd_round_cone(L((0, -0.022, 0.09)), L((0, -0.014, 0.236)), 0.055, 0.058), 0.03),  # shaft
              (sd_ellipsoid(L((0, 0.032, 0.15)), (0.032, 0.02, 0.075)), 0.012),                # tongue
              (sd_torus(L((0, -0.014, 0.236)), (0, 0, 1), 0.056, 0.0085), 0.006))               # padded top
    upper = INTER(upper, sd_plane((0, 0, 0.012), (0, 0, -1)), 0.004)
    return U(sole, (upper, 0.004))


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


def patch(name, f, xs, zs, off_top, thick, mat, uv=False, inset_edge=0.0, y_start=-0.06):
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
    if uv:
        # u runs across the tag as seen from the front (viewer's left -> right = +X -> -X), v bottom -> top
        lay = me.uv_layers.new(name='UVMap')
        xs_n = (np.asarray(xs) - xs[0]) / (xs[-1] - xs[0])
        zs_n = (np.asarray(zs) - zs[0]) / (zs[-1] - zs[0])
        for poly in me.polygons:
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                i, j = divmod(vi, nv)
                u = xs_n[i] if xs[0] > xs[-1] else 1 - xs_n[i]
                lay.data[li].uv = (u, zs_n[j])
    solidify(ob, thick, offset=-1.0)
    assign(ob, mat)
    shade(ob, True, 35)
    return ob


def band_ring(name, f, z0, z1, off, thick, mat, center=(0, -0.005), segs=44):
    th = np.linspace(0, 2 * np.pi, segs, endpoint=False)
    pts = []
    for z in (z0, (z0 + z1) / 2, z1):
        o = np.stack([np.full(segs, center[0]), np.full(segs, center[1]), np.full(segs, z)], 1)
        d = np.stack([np.sin(th), np.cos(th), np.zeros(segs)], 1)
        pts.append(ray_surface(f, o, d, tmax=0.35))
    S = np.stack(pts, 1)  # segs x 3 x 3
    P = S.reshape(-1, 3)
    N = normals(f, P)
    N[:, 2] *= 0.3
    N /= _norm(N)[:, None]
    V = P + N * off
    ob = mesh_from_numpy(name, V, grid_faces(segs, 3, closed_u=True))
    me = ob.data
    if me.polygons[0].normal.dot(Vector(P[0] - (0, -0.005, P[0][2]))) < 0:
        me.flip_normals()
    solidify(ob, thick, offset=-1.0)
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
    phis = np.linspace(-(math.pi - 0.36), math.pi - 0.36, 40)    # 0 = back of the neck
    nphi = len(phis)
    Rs = 0.0715
    R = np.stack([np.sin(phis), -np.cos(phis), np.zeros(nphi)], 1)
    O = np.stack([R[:, 0] * Rs, ax[1] + R[:, 1] * Rs, np.full(nphi, 1.33)], 1)
    top_surf = ray_surface(f, O, np.tile((0, 0, 1.0), (nphi, 1)), tmax=0.3)
    rows = []
    for i, phi in enumerate(phis):
        r = R[i]
        front = (1 - math.cos(phi)) / 2
        zb = top_surf[i, 2]
        hs = 0.031 - 0.009 * front
        base = _v((r[0] * Rs, ax[1] + r[1] * Rs, zb - 0.007))
        top = _v((r[0] * (Rs + 0.002), ax[1] + r[1] * (Rs + 0.002), zb + hs))
        fold = _v((r[0] * (Rs + 0.009), ax[1] + r[1] * (Rs + 0.009), zb + hs + 0.003))
        L = 0.044 + 0.048 * front ** 3.0
        e = nrm(r * math.cos(math.radians(50)) - _v((0, 0, 1)) * math.sin(math.radians(50)))
        fall = [fold + e * L * t for t in np.linspace(0.2, 1.0, 5)]
        rows.append([base, (base + top) / 2, top, fold] + fall)
    V = np.array(rows).reshape(-1, 3)
    nv = len(rows[0])
    idx = np.array([i * nv + j for i in range(nphi) for j in range(5, nv)])
    V[idx] = snap(f, V[idx], offset=0.0045)
    j4 = np.array([i * nv + 4 for i in range(nphi)])
    V[j4] = 0.5 * (V[j4 - 1] + V[j4 + 1]) + 0.003 * normals(f, V[j4])
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
    C = HEAD_C
    phis = np.radians(np.linspace(-84, 84, 32))
    zc = C[2] - 0.004
    zs = np.linspace(-0.0175, 0.0175, 7)
    O, D = [], []
    for z in zs:
        for p in phis:
            O.append((0, C[1] - 0.005, zc + z))
            D.append((math.sin(p), math.cos(p), 0))
    S = ray_surface(fh, np.array(O), np.array(D), tmax=0.2)
    N = normals(fh, S)
    nz, nphi = len(zs), len(phis)
    I, Jj = np.meshgrid(np.arange(nz), np.arange(nphi), indexing='ij')
    ez = np.abs(zs[I] / zs[-1])
    ep = np.abs(phis[Jj] / phis[-1])
    e = np.maximum(ez, ep).ravel()
    off = 0.0011 - 0.0018 * (e > 0.999) - 0.0004 * (e ** 6)
    V = S + N * off[:, None]
    F = []
    for i in range(nz - 1):
        for j in range(nphi - 1):
            a = i * nphi + j
            F.append((a, a + 1, a + 1 + nphi, a + nphi))
    ob = mesh_from_numpy('Visor', V, F)
    me = ob.data
    if me.polygons[len(F) // 2].normal.y < 0:
        me.flip_normals()
    assign(ob, 'Visor')
    shade(ob, True)
    return ob


def build_cuff(side):
    m = (lambda p: p) if side == 1 else mirror
    d = m(D_FORE)
    W = m(J['wrist'])
    ref = nrm(np.cross(d, (0, 0, 1)))
    ref2 = np.cross(d, ref)
    th = np.linspace(0, 2 * np.pi, 22, endpoint=False)
    prof = [(-0.062, 0.0425), (-0.052, 0.0462), (-0.03, 0.0468), (-0.014, 0.0462), (-0.006, 0.0445)]
    V = []
    for t in th:
        rd = math.cos(t) * ref + math.sin(t) * ref2 * 0.86
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


def build_suit_details(fs):
    objs = []
    objs.append(build_collar(fs))
    # zipper placket down the front, a dark zip line, and the pull
    zs = np.linspace(1.395, 0.9, 30)
    objs.append(patch('Placket', fs, np.linspace(0.017, -0.017, 3), zs, 0.0026, 0.0036, 'Suit', y_start=-0.03))
    objs.append(patch('Zip', fs, np.linspace(0.0035, -0.0035, 2), np.linspace(1.392, 0.92, 26), 0.0034, 0.0016,
                      'Boots', y_start=-0.03))
    zp = front_points(fs, [0.0], [1.37])[0, 0]
    nz = normals(fs, zp[None])[0]
    objs.append(box_obj('ZipPull', (0.0055, 0.0028, 0.017), 'Metal',
                        frame_matrix(zp + nz * 0.0055 + (0, 0, -0.004), (1, 0, 0), tuple(nz), (0, 0, 1)), 0.0012, 1))
    # left chest pocket with flap, name tag above it (character's left = -X)
    objs.append(patch('Pocket', fs, np.linspace(-0.035, -0.152, 5), np.linspace(1.19, 1.305, 6), 0.0032, 0.0042,
                      'Suit', inset_edge=0.0008))
    objs.append(patch('Flap', fs, np.linspace(-0.032, -0.155, 5), np.linspace(1.272, 1.312, 3), 0.0068, 0.0032,
                      'Suit', inset_edge=0.0012))
    tag_w, tag_h = 0.122, 0.0305
    cx, cz = -0.094, 1.333
    objs.append(patch('Tag', fs, np.linspace(cx + tag_w / 2, cx - tag_w / 2, 5), np.linspace(cz - tag_h / 2, cz + tag_h / 2, 2),
                      0.0034, 0.0022, 'Tag', uv=True))
    # knee pads
    for sx in (1, -1):
        objs.append(patch('Knee', fs, np.linspace(sx * 0.15, sx * 0.05, 4), np.linspace(0.47, 0.6, 4), 0.003, 0.004,
                          'Suit', inset_edge=0.001, y_start=-0.0))
    # belt + buckle
    belt, S = band_ring('Belt', fs, 1.035, 1.077, 0.0055, 0.0065, 'Boots')
    objs.append(belt)
    front = S[0, 1]
    nb = normals(fs, front[None])[0]
    nb[2] = 0
    nb = nrm(nb)
    objs.append(box_obj('Buckle', (0.062, 0.008, 0.046), 'Metal',
                        frame_matrix(front + nb * 0.0115, (1, 0, 0), tuple(nb), (0, 0, 1)), 0.003, 2))
    for side in (1, -1):
        objs.append(build_cuff(side))
    return objs


def build_torch():
    """Hand torch along local +Y (beam direction). Origin at the grip centre."""
    bm = bmesh.new()
    seg = 18
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
    suit = remesh_sdf('Suit', fs, (-0.78, -0.2, 0.14), (0.78, 0.26, 1.52), 0.0045, 2350)
    assign(suit, 'Suit')
    shade(suit)
    fh = head_field()
    head = remesh_sdf('Head', fh, (-0.11, -0.13, 1.37), (0.11, 0.14, 1.8), 0.0016, 950)
    assign(head, 'Skin')
    shade(head)
    visor = build_visor(fh)
    fhand = hand_field()
    hand = remesh_sdf('HandR', fhand, (-0.09, -0.06, -0.06), (0.22, 0.11, 0.04), 0.0011, 520, relax=2)
    V = mesh_arrays(hand)
    set_coords(hand, hand_to_world(V))
    handL = hand.copy()
    handL.data = hand.data.copy()
    handL.name = 'HandL'
    bpy.context.scene.collection.objects.link(handL)
    set_coords(handL, mirror(mesh_arrays(handL)))
    handL.data.flip_normals()
    for h in (hand, handL):
        assign(h, 'Skin')
        shade(h)
    fb = boot_field()
    boot = remesh_sdf('BootR', fb, (0.0, -0.15, -0.01), (0.22, 0.25, 0.27), 0.002, 340, relax=1)
    bootL = boot.copy()
    bootL.data = boot.data.copy()
    bootL.name = 'BootL'
    bpy.context.scene.collection.objects.link(bootL)
    set_coords(bootL, mirror(mesh_arrays(bootL)))
    bootL.data.flip_normals()
    for b in (boot, bootL):
        assign(b, 'Boots')
        shade(b)
    details = build_suit_details(fs)
    torch = build_torch()
    return dict(suit=suit, head=head, visor=visor, hands=(hand, handL), boots=(boot, bootL),
                details=details, torch=torch, fields=dict(suit=fs, head=fh))


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
        ee.taa_render_samples = 24
        try:
            ee.use_shadows = True
            ee.use_raytracing = False
        except Exception:
            pass
        world = sc.world or bpy.data.worlds.new('W')
        sc.world = world
        world.use_nodes = True
        bg = world.node_tree.nodes['Background']
        bg.inputs['Color'].default_value = (0.012, 0.014, 0.014, 1)
        bg.inputs['Strength'].default_value = 1.0
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
        sc.view_settings.exposure = 0.0
        # floor
        if 'Floor' not in bpy.data.objects:
            bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
            fl = bpy.context.active_object
            fl.name = 'Floor'
            fm = make_material('FloorMat', (0.06, 0.065, 0.065), 0.9)
            fl.data.materials.append(fm)

        def area(name, loc, target, energy, size, color):
            ld = bpy.data.lights.new(name, 'AREA')
            ld.energy = energy
            ld.size = size
            ld.color = color
            lo = bpy.data.objects.new(name, ld)
            sc.collection.objects.link(lo)
            lo.location = loc
            d = Vector(target) - Vector(loc)
            lo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
            return lo
        if 'Key' not in bpy.data.objects:
            area('Key', (-1.6, 2.4, 2.4), (0, 0, 1.2), 70, 1.6, (0.85, 0.9, 1.0))
            area('Rim', (1.4, -2.2, 2.2), (0, 0, 1.3), 260, 0.9, (0.7, 0.8, 1.0))
            area('Rim2', (-1.5, -2.0, 1.6), (0, 0, 1.2), 120, 0.8, (0.75, 0.85, 1.0))
            area('Fill', (2.5, 2.0, 0.8), (0, 0, 1.0), 12, 2.0, (1.0, 0.85, 0.7))


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
    'front': ((0.0, 4.6, 1.0), (0, 0, 0.92), 50),
    'threequarter': ((2.9, 3.4, 1.45), (0, 0, 0.95), 50),
    'side': ((4.5, 0.0, 1.0), (0, 0, 0.92), 50),
    'back': ((0.6, -4.5, 1.2), (0, 0, 0.92), 50),
    'head': ((0.25, 0.75, 1.7), (0, 0.02, 1.64), 70),
    'headside': ((0.75, 0.2, 1.68), (0, 0.0, 1.64), 70),
    'hand': ((0.9, 0.7, 1.0), (0.55, 0.15, 0.95), 70),
    'torso': ((0.5, 1.6, 1.35), (0, 0.0, 1.22), 60),
    'boots': ((0.7, 0.9, 0.3), (0, 0.05, 0.12), 60),
    'walk': ((3.6, 2.6, 1.2), (0, 0, 0.92), 50),
    'reach': ((2.6, 3.6, 1.4), (0, 0.15, 1.05), 50),
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
def main():
    # empty scene
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    build_materials()
    G = build_geometry()
    tris = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    log('total triangles (all meshes): %d' % tris)
    torch = G['torch']
    torch.location = (0.55, 0.3, 0.9)
    if ARGS.renders:
        os.makedirs(ARGS.renders, exist_ok=True)
        setup_render(ARGS.quick)
        for v in ARGS.views.split(','):
            render_view(v, os.path.join(ARGS.renders, v + '.png'))
    if ARGS.blend:
        bpy.ops.wm.save_as_mainfile(filepath=ARGS.blend)


main()
