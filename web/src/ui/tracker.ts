import { GRID } from '../config';
import map from '../map.json';
import { CELL, isSolidCell } from '../game/world';

/**
 * The bodycam's tracker: which way to walk, through the streets rather than through walls. Each
 * target keeps a distance field over the map's cells (steps to the target), and the arrow points a
 * couple of cells down that field.
 */
export interface Target {
  name: string;
  what: string;
  cell: number[];
}

const fields = new Map<number, Int16Array>();
/** steps from every open cell to `cell` (-1 where there is no way) */
export function fieldTo(cell: number[]): Int16Array {
  const key = cell[1] * GRID + cell[0];
  let f = fields.get(key);
  if (f) return f;
  f = new Int16Array(GRID * GRID).fill(-1);
  const queue = [key];
  f[key] = 0;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    const x = i % GRID, y = Math.floor(i / GRID);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (isSolidCell(nx, ny)) continue;
      const j = ny * GRID + nx;
      if (f[j] >= 0) continue;
      f[j] = f[i] + 1;
      queue.push(j);
    }
  }
  if (fields.size > 24) fields.delete(fields.keys().next().value as number);
  fields.set(key, f);
  return f;
}

export const FUSES: Target[] = map.fuseCells.map((cell, i) => ({ name: map.fuseNames[i], what: 'FUSE BOX', cell }));
export const GATE: Target = { name: 'THE BRIDGE GATE', what: 'WAY OUT', cell: map.exitCell };

/** metres to walk from (x, z) to a target, or Infinity if there is no way */
export function walkMetres(t: Target, x: number, z: number): number {
  const f = fieldTo(t.cell);
  const d = f[Math.floor(z / CELL) * GRID + Math.floor(x / CELL)];
  return d < 0 ? Infinity : d * CELL;
}

/** the nearest of some targets, by walking distance */
export function nearest(ts: Target[], x: number, z: number): Target | null {
  let best: Target | null = null, bestD = Infinity;
  for (const t of ts) {
    const d = walkMetres(t, x, z);
    if (d < bestD) (best = t), (bestD = d);
  }
  return best;
}

/**
 * Bearing to follow, relative to where the camera faces (radians, clockwise, 0 = straight ahead),
 * and the walking distance in metres.
 */
export function steer(t: Target, x: number, z: number, yaw: number): { bearing: number; metres: number } | null {
  const f = fieldTo(t.cell);
  let cx = Math.floor(x / CELL), cy = Math.floor(z / CELL);
  const d0 = f[cy * GRID + cx];
  if (d0 < 0) return null;
  // two cells down the field, so the arrow turns before the corner rather than at it
  for (let k = 0; k < 2; k++) {
    const d = f[cy * GRID + cx];
    if (d <= 0) break;
    let next: number[] | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      if (f[ny * GRID + nx] === d - 1) {
        next = [nx, ny];
        break;
      }
    }
    if (!next) break;
    [cx, cy] = next;
  }
  const ax = (cx + 0.5) * CELL - x, az = (cy + 0.5) * CELL - z;
  const at = d0 === 0 ? [(t.cell[0] + 0.5) * CELL - x, (t.cell[1] + 0.5) * CELL - z] : [ax, az];
  // camera forward is (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw)
  const fwd = -at[0] * Math.sin(yaw) - at[1] * Math.cos(yaw);
  const right = at[0] * Math.cos(yaw) - at[1] * Math.sin(yaw);
  return { bearing: Math.atan2(right, fwd), metres: d0 === 0 ? Math.hypot(at[0], at[1]) : d0 * CELL };
}

/** a tracker pointed at a moving point (a body), by way of the cell it is in */
export function bodyTarget(name: string, xm: number, zm: number): Target {
  return { name, what: '', cell: [Math.floor(xm / CELL), Math.floor(zm / CELL)] };
}
