// Groups and the shared scene field.
//
// For each group g:
//   G_g   = min(shell SDFs, solid SDFs)                 the group's material (a smooth
//                                                        min with radius k when the
//                                                        group blends)
//   C_g   = max(F_shell, t - D)                         its cavity: inside the shell
//                                                        objects and deeper than t from
//                                                        their non-opening surface
//   Cut_g = min(C_g, subtract SDFs, pin cylinders)      everything carved from the group
//   S_g   = max(G_g, -Cut_g)
// and the scene is S = min over groups. Groups never cut each other.
//
// D is the depth below the group's shell surface, ignoring faces marked as openings.
// The analytic per-object depth A (deepest depth inside any single shell object) is
// exact except near joins, blends and openings shared between objects; there a
// precomputed grid (cavity.ts) gives D. hybridDepth uses A wherever the grid agrees
// with it, so walls away from joins are as exact as the outer surface.

import type { SceneDoc } from './document';
import { type AABB, type Vec3, emptyAABB, growAABB } from './math';
import { buildProfileTable, tableDepth, tableProfile } from './profileTable';
import { type CompiledObject, compileObject, normalToWorld, prismFrustum, sdfWorld, toLocal, toWorld } from './primitives';

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
  /** Smooth-union radius (0 = sharp min). */
  k: number;
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
    index, id: g.id, name: g.name, t: Math.max(0.01, g.thickness), k: Math.max(0, g.blend ?? 0), hollow: false,
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
    // a smooth union bulges at most k/4 past the plain union
    if (g.k > 0) for (const b of [g.bounds, g.shellBounds]) for (let a = 0; a < 3; a++) { b.min[a] -= g.k / 4; b.max[a] += g.k / 4; }
  }
  for (const pin of doc.pins) {
    const o = byId.get(pin.objectId);
    if (!o) continue;
    const g = gById.get(o.obj.groupId) ?? groups[0];
    const c: Vec3 = [0, 0, 0];
    toWorld(o, pin.point[0], pin.point[1], pin.point[2], c);
    const n = normalToWorld(o, pin.normal[0], pin.normal[1], pin.normal[2]);
    const out = Math.max(0.5, pin.radius);
    const depth = pinDepth(g.hollow ? g.t : null, pin.radius);
    g.pins.push({
      ax: c[0] + n[0] * out, ay: c[1] + n[1] * out, az: c[2] + n[2] * out,
      bx: c[0] - n[0] * depth, by: c[1] - n[1] * depth, bz: c[2] - n[2] * depth,
      r: pin.radius,
    });
  }
  return groups.filter((g) => g.shells.length + g.solids.length > 0);
}

/**
 * How far a pin hole drills inward from the tapped point. On a curved surface the
 * wall at the rim of the hole lies deeper than at its centre (by up to the hole's
 * radius), so the drill goes that much further to clear the wall all the way round.
 */
export function pinDepth(wall: number | null, radius: number): number {
  return wall !== null ? 1.5 * wall + 1.2 * radius + 0.05 : 4 * radius;
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

/** Polynomial smooth min (iq); k = 0 is the plain min. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function shellSDF(g: CompiledGroup, x: number, y: number, z: number): number {
  let f = Infinity;
  for (const o of g.shells) f = smin(f, sdfWorld(o, x, y, z), g.k);
  return f;
}

const tmp: Vec3 = [0, 0, 0];

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
      const fr = prismFrustum(n, p.r!, p.r2 ?? p.r!, p.h!);
      const sxz = Math.min(sx, sz);
      let d = Infinity;
      if (!isHole('top')) d = Math.min(d, (hh - ly) * sy);
      if (!isHole('bottom')) d = Math.min(d, (hh + ly) * sy);
      for (let i = 0; i < n; i++) if (!isHole(`side${i}`)) d = Math.min(d, fr.sideDepth(i, lx, ly, lz) * sxz);
      return d;
    }
    default: {
      // revolve family: depth below the allowed profile segments, from the same
      // table the shader samples
      const key = c.profile!.faces.filter(isHole).join(',');
      const tables = c.depthTables ??= new Map();
      let t = tables.get(key);
      if (!t) { t = buildProfileTable(tableProfile(c.obj.type, p.points, c.profile!), isHole); tables.set(key, t); }
      return tableDepth(t, Math.hypot(lx, lz), ly) * c.minScale;
    }
  }
}

/** Analytic stand-in for D: deepest hole-aware depth inside any single shell object. */
export function approxDepth(g: CompiledGroup, x: number, y: number, z: number): number {
  let d = -Infinity;
  for (const o of g.shells) d = Math.max(d, holeDepth(o, g.holes, x, y, z));
  return d;
}

/** Bounding sphere of an object (centre, radius); the shader uses the same one. */
export function boundSphere(o: CompiledObject): [number, number, number, number] {
  const b = o.worldBounds;
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2,
    Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 + 0.01];
}

/**
 * The analytic base depth A, clamped to ±clampV, computed exactly as the shader
 * does. The cavity grid stores the correction D − A, so D = A + C: exact
 * wherever a single object's surface is nearest (C = 0), and the grid only has to
 * carry the smooth correction near joins, blends and shared openings.
 */
export function baseDepth(g: CompiledGroup, x: number, y: number, z: number, clampV: number, h: number): number {
  // Smooth max: where the deepest object switches, A gets a crease the trilinear
  // correction can't follow; rounding it (over two texels, plus the blend radius in
  // blended groups) keeps D = A + C smooth.
  const k = 2 * h + g.k;
  // The two deepest terms only (as the shader; see there for the skip test).
  const lb = -shellSDF(g, x, y, z) - 0.25 * g.k * (g.shells.length - 1);
  let t1 = -Infinity, t2 = -Infinity;
  for (const o of g.shells) {
    if (!o.obj.holes.length) {
      const [cx, cy, cz, r] = o.bsphere ??= boundSphere(o);
      if (r - Math.hypot(x - cx, y - cy, z - cz) < Math.max(lb, t1) - k) continue;
    }
    const v = holeDepth(o, g.holes, x, y, z);
    if (v > t1) { t2 = t1; t1 = v; } else if (v > t2) t2 = v;
  }
  const d = t2 === -Infinity ? t1 : -smin(-t1, -t2, k);
  return Math.max(-clampV, Math.min(clampV, d));
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
    for (const o of g.shells) fs = smin(fs, sdfWorld(o, x, y, z), g.k);
    for (const o of g.solids) fo = smin(fo, sdfWorld(o, x, y, z), g.k);
    const G = smin(fs, fo, g.k);
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
