// Groups and the shared scene field.
//
// For each group g:
//   G_g   = min(shell SDFs, solid SDFs)                 the group's material
//   C_g   = max(F_shell, t - D)                         its cavity: inside the shell
//                                                        objects and deeper than t from
//                                                        their non-opening surface
//   Cut_g = min(C_g, subtract SDFs, pin cylinders)      everything carved from the group
//   S_g   = max(G_g, -Cut_g)
// and the scene is S = min over groups. Groups never cut each other.
//
// D is the depth below the group's shell surface, ignoring faces marked as openings.
// The exact D comes from a precomputed grid (cavity.ts); without one, an analytic
// approximation (deepest depth inside any single shell object) is used.

import type { SceneDoc } from './document';
import { type AABB, type Vec3, emptyAABB, growAABB } from './math';
import { type CompiledObject, compileObject, normalToWorld, sdfWorld, toLocal, toWorld } from './primitives';

export interface CompiledPin {
  ax: number; ay: number; az: number; // outside end
  bx: number; by: number; bz: number; // inside end
  r: number;
}

export interface CompiledGroup {
  index: number;
  id: string;
  name: string;
  t: number;
  /** Shelling applies (global switch on and the group has shell objects). */
  hollow: boolean;
  shells: CompiledObject[];
  solids: CompiledObject[];
  subs: CompiledObject[];
  pins: CompiledPin[];
  holes: Set<string>; // `${objectId}|${faceId}`
  /** Bounds of the group's material (shell + solid objects). */
  bounds: AABB;
  shellBounds: AABB;
}

export function compileGroups(doc: SceneDoc): CompiledGroup[] {
  const objs = doc.objects.filter((o) => !o.hidden).map(compileObject);
  const byId = new Map(objs.map((o) => [o.obj.id, o]));
  const groups: CompiledGroup[] = doc.groups.map((g, index) => ({
    index, id: g.id, name: g.name, t: Math.max(0.01, g.thickness), hollow: false,
    shells: [], solids: [], subs: [], pins: [], holes: new Set(), bounds: emptyAABB(), shellBounds: emptyAABB(),
  }));
  const gById = new Map(groups.map((g) => [g.id, g]));
  for (const o of objs) {
    const g = gById.get(o.obj.groupId) ?? groups[0];
    if (!g) continue;
    (o.obj.mode === 'shell' ? g.shells : o.obj.mode === 'solid' ? g.solids : g.subs).push(o);
    if (o.obj.mode === 'shell') for (const f of o.obj.holes) g.holes.add(`${o.obj.id}|${f}`);
  }
  for (const g of groups) {
    g.hollow = doc.shell.enabled && g.shells.length > 0;
    for (const o of [...g.shells, ...g.solids]) {
      growAABB(g.bounds, ...o.worldBounds.min); growAABB(g.bounds, ...o.worldBounds.max);
    }
    for (const o of g.shells) {
      growAABB(g.shellBounds, ...o.worldBounds.min); growAABB(g.shellBounds, ...o.worldBounds.max);
    }
  }
  for (const pin of doc.pins) {
    const o = byId.get(pin.objectId);
    if (!o) continue;
    const g = gById.get(o.obj.groupId) ?? groups[0];
    const c: Vec3 = [0, 0, 0];
    toWorld(o, pin.point[0], pin.point[1], pin.point[2], c);
    const n = normalToWorld(o, pin.normal[0], pin.normal[1], pin.normal[2]);
    const out = Math.max(0.5, pin.radius);
    const depth = (g.hollow ? g.t : pin.radius * 4) * 1.6 + 0.05;
    g.pins.push({
      ax: c[0] + n[0] * out, ay: c[1] + n[1] * out, az: c[2] + n[2] * out,
      bx: c[0] - n[0] * depth, by: c[1] - n[1] * depth, bz: c[2] - n[2] * depth,
      r: pin.radius,
    });
  }
  return groups.filter((g) => g.shells.length + g.solids.length > 0);
}

export function pinSDF(p: CompiledPin, x: number, y: number, z: number): number {
  // capped cylinder between a and b (iq)
  const bax = p.bx - p.ax, bay = p.by - p.ay, baz = p.bz - p.az;
  const pax = x - p.ax, pay = y - p.ay, paz = z - p.az;
  const baba = bax * bax + bay * bay + baz * baz;
  const paba = pax * bax + pay * bay + paz * baz;
  const cx = pax * baba - bax * paba, cy = pay * baba - bay * paba, cz = paz * baba - baz * paba;
  const xx = Math.hypot(cx, cy, cz) - p.r * baba;
  const yy = Math.abs(paba - baba * 0.5) - baba * 0.5;
  const x2 = xx * xx, y2 = yy * yy * baba;
  const d = Math.max(xx, yy) < 0 ? -Math.min(x2, y2) : (xx > 0 ? x2 : 0) + (yy > 0 ? y2 : 0);
  return (Math.sign(d) * Math.sqrt(Math.abs(d))) / baba;
}

export function shellSDF(g: CompiledGroup, x: number, y: number, z: number): number {
  let f = Infinity;
  for (const o of g.shells) { const d = sdfWorld(o, x, y, z); if (d < f) f = d; }
  return f;
}

const tmp: Vec3 = [0, 0, 0];

function segDist(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay;
  const ee = ex * ex + ey * ey;
  const t = ee > 0 ? Math.min(1, Math.max(0, (wx * ex + wy * ey) / ee)) : 0;
  return Math.hypot(wx - ex * t, wy - ey * t);
}

/**
 * Depth (world cm) below one object's surface, ignoring its faces that are openings.
 * Infinity when every face is an opening; <= 0 outside the object.
 */
export function holeDepth(c: CompiledObject, holes: Set<string>, x: number, y: number, z: number): number {
  const sdf = sdfWorld(c, x, y, z);
  if (sdf > 0) return -sdf;
  const id = c.obj.id;
  const isHole = (f: string) => holes.has(`${id}|${f}`);
  const p = c.obj.params;
  toLocal(c, x, y, z, tmp);
  const [lx, ly, lz] = tmp;
  const [sx, sy, sz] = c.scale;
  switch (c.obj.type) {
    case 'sphere': case 'torus': case 'capsule':
      return isHole('surface') ? Infinity : -sdf;
    case 'box': {
      const h: Vec3 = [p.x! / 2, p.y! / 2, p.z! / 2];
      const s: Vec3 = [sx, sy, sz];
      const names = [['px', 'nx'], ['py', 'ny'], ['pz', 'nz']];
      let d = Infinity;
      for (let a = 0; a < 3; a++) {
        const v = tmp[a];
        if (!isHole(names[a][0])) d = Math.min(d, (h[a] - v) * s[a]);
        if (!isHole(names[a][1])) d = Math.min(d, (h[a] + v) * s[a]);
      }
      return d;
    }
    case 'prism': {
      const n = Math.max(3, Math.round(p.n!)), hh = p.h! / 2;
      const ap = p.r! * Math.cos(Math.PI / n);
      const sxz = Math.min(sx, sz);
      let d = Infinity;
      if (!isHole('top')) d = Math.min(d, (hh - ly) * sy);
      if (!isHole('bottom')) d = Math.min(d, (hh + ly) * sy);
      for (let i = 0; i < n; i++) {
        if (isHole(`side${i}`)) continue;
        const a = (2 * Math.PI * (i - 0.5)) / n;
        d = Math.min(d, (ap - (lx * Math.cos(a) + lz * Math.sin(a))) * sxz);
      }
      return d;
    }
    default: {
      // revolve family: distance to allowed profile segments in the (r, y) plane
      const prof = c.profile!;
      const rr = Math.hypot(lx, lz);
      let d = Infinity;
      for (let i = 0; i < prof.n; i++) {
        const f = prof.segFace[i];
        if (f === 'axis' || isHole(f)) continue;
        const j = (i + 1) % prof.n;
        d = Math.min(d, segDist(prof.pts[2 * i], prof.pts[2 * i + 1], prof.pts[2 * j], prof.pts[2 * j + 1], rr, ly));
      }
      return d * c.minScale;
    }
  }
}

/** Analytic stand-in for D: deepest hole-aware depth inside any single shell object. */
export function approxDepth(g: CompiledGroup, x: number, y: number, z: number): number {
  let d = -Infinity;
  for (const o of g.shells) d = Math.max(d, holeDepth(o, g.holes, x, y, z));
  return d;
}

/**
 * The cavity reaches this far past the shell surface. Across an opening the field
 * would otherwise touch zero exactly on the face plane: a skin of zero thickness.
 */
export const OPENING_EPS = 0.06;

export type DepthFn = (g: CompiledGroup, x: number, y: number, z: number) => number;

/** Which piece of the field is active at the last evaluated point (for gradients). */
export const last = { group: -1, kind: 'none' as 'material' | 'cavity' | 'sub' | 'pin' | 'none' };

/** Scene field S(p) (negative = clay). */
export function evalScene(groups: CompiledGroup[], depth: DepthFn, x: number, y: number, z: number, cull = Infinity): number {
  let s = Infinity;
  for (const g of groups) {
    const b = g.bounds;
    // cheap reject: farther from the group's box than the current best
    const dx = Math.max(b.min[0] - x, 0, x - b.max[0]), dy = Math.max(b.min[1] - y, 0, y - b.max[1]), dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
    const boxD = Math.hypot(dx, dy, dz);
    if (boxD > Math.min(s, cull)) continue;
    let fs = Infinity, fo = Infinity;
    for (const o of g.shells) { const d = sdfWorld(o, x, y, z); if (d < fs) fs = d; }
    for (const o of g.solids) { const d = sdfWorld(o, x, y, z); if (d < fo) fo = d; }
    const G = Math.min(fs, fo);
    let cut = Infinity, kind: typeof last.kind = 'material';
    if (g.hollow && fs < OPENING_EPS) {
      const c = Math.max(fs - OPENING_EPS, g.t - depth(g, x, y, z));
      if (c < cut) { cut = c; kind = 'cavity'; }
    }
    for (const o of g.subs) { const d = sdfWorld(o, x, y, z); if (d < cut) { cut = d; kind = 'sub'; } }
    for (const p of g.pins) { const d = pinSDF(p, x, y, z); if (d < cut) { cut = d; kind = 'pin'; } }
    let sg = G;
    if (-cut > G) sg = -cut;
    else kind = 'material';
    if (sg < s) { s = sg; last.group = g.index; last.kind = kind; }
  }
  return s;
}

export function sceneBounds(groups: CompiledGroup[]): AABB {
  const b = emptyAABB();
  for (const g of groups) { growAABB(b, ...g.bounds.min); growAABB(b, ...g.bounds.max); }
  return b;
}

/** Sphere-trace the scene field along a ray (CPU). Returns hit distance or -1. */
export function traceScene(
  groups: CompiledGroup[], depth: DepthFn, ro: Vec3, rd: Vec3, tMin: number, tMax: number,
  clip?: { n: Vec3; c: number },
): { t: number; p: Vec3; n: Vec3 } | null {
  const S = (x: number, y: number, z: number) => {
    let s = evalScene(groups, depth, x, y, z);
    if (clip) s = Math.max(s, -(clip.n[0] * x + clip.n[1] * y + clip.n[2] * z + clip.c));
    return s;
  };
  let t = tMin;
  for (let i = 0; i < 600 && t < tMax; i++) {
    const x = ro[0] + rd[0] * t, y = ro[1] + rd[1] * t, z = ro[2] + rd[2] * t;
    const d = S(x, y, z);
    if (d < 0.002) {
      const e = 0.01;
      const n: Vec3 = [S(x + e, y, z) - S(x - e, y, z), S(x, y + e, z) - S(x, y - e, z), S(x, y, z + e) - S(x, y, z - e)];
      const l = Math.hypot(...n) || 1;
      return { t, p: [x, y, z], n: [n[0] / l, n[1] / l, n[2] / l] };
    }
    t += Math.max(d * 0.9, 0.001);
  }
  return null;
}
