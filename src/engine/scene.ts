// Groups and the shared scene field.
//
// For each group g:
//   Sub_g = min(subtract and cutout SDFs)
//   F_g   = max(min(shell SDFs), -Sub_g)                the shell shape (a smooth min
//                                                        with radius k when the group
//                                                        blends)
//   G_g   = max(min(shell SDFs, solid SDFs), -Sub_g)    the group's material
//   C_g   = max(F_g, t - D)                             its cavity: inside the shell
//                                                        shape and deeper than t from
//                                                        its non-opening surface
//   S_g   = max(G_g, -min(C_g, pin cylinders))
// and the scene is S = min over groups. Groups never cut each other.
//
// D is the depth below the shell shape's surface, ignoring faces marked as openings.
// The cut surface of a subtract object is part of that surface (so it gets a wall);
// a cutout's isn't (it acts as an opening, so it cuts through the finished wall).
// Inside F, depth below it is exactly min(depth below the shell union, distance
// into each subtract object).
// The analytic per-object depth A (deepest depth inside any single shell object) is
// exact except near joins, blends and openings shared between objects; there a
// precomputed grid (cavity.ts) gives D. hybridDepth uses A wherever the grid agrees
// with it, so walls away from joins are as exact as the outer surface.

import { type ProgIns, type SceneDoc, isCut } from './document';
import { type AABB, type Vec3, emptyAABB, growAABB } from './math';
import { buildProfileTable, tableDepth, tableProfile } from './profileTable';
import { sweepEval } from './sweep';
import { type CompiledObject, compileObject, normalToWorld, prismFrustum, sdfWorld, toLocal, toWorld } from './primitives';

export interface CompiledPin {
  ax: number; ay: number; az: number; // outside end
  bx: number; by: number; bz: number; // inside end
  r: number;
}

/** A compound rounding: on a lattice, the rounded body's field minus the sharp one's. */
export interface RoundGrid {
  origin: [number, number, number];
  h: number;
  dims: [number, number, number];
  data: Float32Array;
  /** Outside the band the correction is -r: still a lower bound on the distance. */
  r: number;
}

export interface CompiledGroup {
  index: number;
  id: string;
  name: string;
  t: number;
  /** Smooth-union radius (0 = sharp min). */
  k: number;
  /** Edge rounding radius. */
  round: number;
  /** Round the finished body as a whole (a grid, engine/round) rather than each
   *  object and the rims of its cuts. */
  compound: boolean;
  /** Smooth-max radius of the cut rims: the rounding, unless it is compound. */
  rim: number;
  /** Compound rounding, once built: the correction to the sharp body's field. */
  roundGrid?: RoundGrid;
  /** The document's program (shared by its groups), and where this body's group
   *  starts and ends in it (its '(' and ')'; -1: not hollowed there). */
  prog: CompiledIns[];
  open: number;
  close: number;
  /** Its layers don't simply add up less their cuts (nested groups, a layer above a
   *  cut, smooth cuts): the analytic depth needs the grid's correction. */
  complex: boolean;
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

/** A program step with its objects and bodies resolved (see document.ProgIns). */
export interface CompiledIns { op: 0 | 1 | 2; o: CompiledObject | null; sub: boolean; solid: boolean; k: number; g: CompiledGroup | null }

/** The program of a document from before layers: each group a hollowed body of
 *  its objects, cutouts and pins cut after hollowing. */
export function legacyProgram(doc: SceneDoc): ProgIns[] {
  const p: ProgIns[] = [];
  for (const g of doc.groups) {
    const m = doc.objects.filter((o) => o.groupId === g.id && !o.hidden && o.type !== 'part');
    const k = Math.max(0, g.blend ?? 0);
    p.push(['('], ['(']);
    for (const o of m) if (!isCut(o.mode)) p.push(['o', o.id, o.mode === 'solid' ? 2 : 0, k]);
    for (const o of m) if (o.mode === 'subtract') p.push(['o', o.id, 1, g.round ?? 0]);
    p.push([')', 0, g.id, 0]);
    for (const o of m) if (o.mode === 'cutout') p.push(['o', o.id, 1, g.round ?? 0]);
    p.push([')', 0, '', 0]);
  }
  return p;
}

export function compileGroups(doc: SceneDoc): CompiledGroup[] {
  const objs = doc.objects.filter((o) => !o.hidden && o.type !== 'part').map(compileObject);
  const byId = new Map(objs.map((o) => [o.obj.id, o]));
  const groups: CompiledGroup[] = doc.groups.map((g, index) => ({
    index, id: g.id, name: g.name, t: Math.max(0.01, g.thickness), k: Math.max(0, g.blend ?? 0), round: Math.max(0, g.round ?? 0), hollow: false,
    compound: !!g.compound && (g.round ?? 0) > 0, rim: g.compound ? 0 : Math.max(0, g.round ?? 0),
    shells: [], solids: [], subs: [], pins: [], holes: new Set(), bounds: emptyAABB(), shellBounds: emptyAABB(),
    prog: [], open: -1, close: -1, complex: false,
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
  const kept = groups.filter((g) => g.shells.length + g.solids.length > 0);
  // the program, with its objects and bodies resolved
  const prog: CompiledIns[] = [];
  const opens: number[] = [];
  for (const ins of doc.program ?? legacyProgram(doc)) {
    if (ins[0] === 'o') {
      const o = byId.get(ins[1]);
      if (o) prog.push({ op: 0, o, sub: (ins[2] & 1) === 1, solid: (ins[2] & 2) === 2, k: ins[3], g: null });
    } else if (ins[0] === '(') { opens.push(prog.length); prog.push({ op: 1, o: null, sub: false, solid: false, k: 0, g: null }); }
    else {
      const g = gById.get(ins[2]) ?? null;
      const open = opens.pop() ?? 0;
      const live = g && kept.includes(g) ? g : null;
      if (live) { live.open = open; live.close = prog.length; }
      prog.push({ op: 2, o: null, sub: (ins[1] & 1) === 1, solid: false, k: ins[3], g: live });
    }
  }
  for (const g of kept) {
    g.prog = prog;
    if (g.open < 0) continue;
    let cut = false;
    for (let i = g.open + 1; i < g.close; i++) {
      const n = prog[i];
      if (n.op !== 0) { g.complex = true; break; }
      if (n.sub) { cut = true; if (n.k > 0) g.complex = true; } else if (cut) g.complex = true;
    }
  }
  return kept;
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

/** Smooth max (the rim of a cut rounded by k); k = 0 is the plain max. */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** The shell shape: the body's layers folded, less its Solid ones (the surface its
 *  hollow grows in from). */
export function shapeSDF(g: CompiledGroup, x: number, y: number, z: number): number {
  if (g.open < 0) return shellSDF(g, x, y, z);
  runProgram(g.prog, g.open + 1, g.close, null, x, y, z);
  return stF[0] + roundCorrection(g, x, y, z);
}

// the program's stack: per open group, the body so far, its shell surface, which
// piece of the field is active (0 material, 1 cavity, 2 pin) and in which body
const stG = new Float64Array(64), stF = new Float64Array(64), stK = new Int32Array(64), stU = new Int32Array(64);

/**
 * Run program steps [start, end) at a point: the fold ends in stG[0] (the field)
 * and stF[0] (its shell surface). A group that ends naming a hollow body is
 * hollowed there: its depth below that surface (depth()) carves everything deeper
 * than the wall, Solid layers included; and its pins drill through.
 */
function runProgram(prog: CompiledIns[], start: number, end: number, depth: DepthFn | null, x: number, y: number, z: number): void {
  let sp = 0;
  stG[0] = Infinity; stF[0] = Infinity; stK[0] = 0; stU[0] = -1;
  for (let i = start; i < end; i++) {
    const n = prog[i];
    if (n.op === 0) {
      const d = sdfWorld(n.o!, x, y, z);
      if (n.sub) { stG[sp] = smax(stG[sp], -d, n.k); stF[sp] = smax(stF[sp], -d, n.k); }
      else { stG[sp] = smin(stG[sp], d, n.k); if (!n.solid) stF[sp] = smin(stF[sp], d, n.k); }
    } else if (n.op === 1) {
      sp++;
      stG[sp] = Infinity; stF[sp] = Infinity; stK[sp] = 0; stU[sp] = -1;
    } else {
      let gv = stG[sp], kind = stK[sp], unit = stU[sp];
      const fv = stF[sp], g = n.g;
      if (g && depth) {
        let cut = Infinity, ck = 0;
        if (g.hollow && fv < OPENING_EPS) { cut = Math.max(fv - OPENING_EPS, g.t - depth(g, x, y, z)); ck = 1; }
        for (const p of g.pins) { const d = pinSDF(p, x, y, z); if (d < cut) { cut = d; ck = 2; } }
        if (-cut > gv) { gv = -cut; kind = ck; unit = g.index; } else if (kind === 0) unit = g.index;
      }
      sp--;
      if (n.sub) { stG[sp] = smax(stG[sp], -gv, n.k); stF[sp] = smax(stF[sp], -gv, n.k); }
      else {
        if (gv < stG[sp]) { stK[sp] = kind; stU[sp] = unit; }
        stG[sp] = smin(stG[sp], gv, n.k);
        stF[sp] = smin(stF[sp], gv, n.k);
      }
    }
  }
}

/** The sharp body a compound rounding rounds: Shell and Solid objects less the Subtract ones. */
export function bodySDF(g: CompiledGroup, x: number, y: number, z: number): number {
  let u = Infinity, sub = Infinity;
  for (const o of g.shells) u = smin(u, sdfWorld(o, x, y, z), g.k);
  for (const o of g.solids) u = smin(u, sdfWorld(o, x, y, z), g.k);
  for (const o of g.subs) if (o.obj.mode !== 'cutout') sub = Math.min(sub, sdfWorld(o, x, y, z));
  return smax(u, -sub, g.rim);
}

/** Compound rounding: what to add to the sharp field here (0 without a grid). */
export function roundCorrection(g: CompiledGroup, x: number, y: number, z: number): number {
  const c = g.roundGrid;
  if (!c) return 0;
  const fx = (x - c.origin[0]) / c.h, fy = (y - c.origin[1]) / c.h, fz = (z - c.origin[2]) / c.h;
  const [nx, ny, nz] = c.dims;
  if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return -c.r;
  const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), k = Math.min(nz - 2, Math.floor(fz));
  const u = fx - i, v = fy - j, w = fz - k;
  const D = c.data, q = i + nx * (j + ny * k), sxy = nx * ny;
  const c00 = D[q] * (1 - u) + D[q + 1] * u, c10 = D[q + nx] * (1 - u) + D[q + nx + 1] * u;
  const c01 = D[q + sxy] * (1 - u) + D[q + sxy + 1] * u, c11 = D[q + sxy + nx] * (1 - u) + D[q + sxy + nx + 1] * u;
  return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
}

const tmp: Vec3 = [0, 0, 0];

/**
 * Depth (world cm) below one object's surface, ignoring its faces that are openings.
 * Infinity when every face is an opening; <= 0 outside the object.
 */
export function holeDepth(c: CompiledObject, holes: Set<string>, x: number, y: number, z: number, tau = 0.02): number {
  const sdf = sdfWorld(c, x, y, z);
  if (!c.obj.holes.length) return -sdf;
  // Through an opening the depth carries on as if the face weren't there (as the
  // grid stores it), so there is no jump at the face; elsewhere outside, -sdf.
  const hd = openDepth(c, holes, x, y, z, sdf);
  return sdf <= 0 || hd > sdf + tau ? hd : -sdf;
}

/** Distance below the object's non-opening faces (also evaluated outside it). */
function openDepth(c: CompiledObject, holes: Set<string>, x: number, y: number, z: number, sdf: number): number {
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
    case 'sweep': {
      // depth below the sweep with its open ends running on (the shader does the same)
      const { path, sec, style } = c.sweep!;
      if (isHole('surface')) return Infinity;
      return -sweepEval(path, sec, style, lx, ly, lz, { start: isHole('start'), end: isHole('end') }).d * c.minScale;
    }
    default: {
      // revolve family: depth below the allowed profile segments, from the same
      // table the shader samples
      const key = c.profile!.faces.filter(isHole).join(',') + `|${c.round}`;
      const tables = c.depthTables ??= new Map();
      let t = tables.get(key);
      if (!t) { t = buildProfileTable(tableProfile(c.obj.type, p.points, c.profile!, c.round), isHole); tables.set(key, t); }
      return tableDepth(t, Math.hypot(lx, lz), ly) * c.minScale;
    }
  }
}

/** Analytic stand-in for D: deepest hole-aware depth inside any single shell object. */
export function approxDepth(g: CompiledGroup, x: number, y: number, z: number): number {
  let d = -Infinity;
  for (const o of g.shells) d = Math.max(d, holeDepth(o, g.holes, x, y, z));
  for (const o of g.subs) if (o.obj.mode === 'subtract') d = Math.min(d, sdfWorld(o, x, y, z));
  return d;
}

/**
 * Whether a hollow group needs a cavity grid. The analytic depth A is exact
 * wherever one object's surface is nearest, so a group with a single shell object
 * (a blend has nothing to blend it with) and no rounded cut rims has it exact everywhere (cuts bound it exactly
 * too: see baseDepth). There the grid would only add its small interpolation noise,
 * which shows where the cavity meets an opening at a grazing angle (a wide pot's
 * shallow shoulder running into its open top).
 */
export function needsCavityGrid(g: CompiledGroup): boolean {
  return g.hollow && (g.shells.length > 1 || g.complex || (g.rim > 0 && g.subs.length > 0) || g.compound);
}

/** Whether a group's grid also carries a compound rounding (engine/round). */
export function needsRoundGrid(g: CompiledGroup): boolean {
  return g.compound;
}

/** Whether a group gets a grid at all (cavity depth, compound rounding or both). */
export function needsUnitGrid(g: CompiledGroup): boolean {
  return needsCavityGrid(g) || needsRoundGrid(g);
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
export function baseDepth(g: CompiledGroup, x: number, y: number, z: number, clampV: number, h: number, top?: { i: number; gap: number }): number {
  // Smooth max: where the deepest object switches, A gets a crease the trilinear
  // correction can't follow; rounding it over two texels keeps D = A + C smooth.
  // In a blended group the radius is the blend's: a smooth min of the objects'
  // distances (the blended surface) is exactly the smooth max of their depths, and
  // these depths already run on through openings, so A is right next to them too.
  const k = Math.max(2 * h, g.k);
  // The two deepest terms only (as the shader; see there for the skip test).
  const fs = shellSDF(g, x, y, z);
  const lb = -fs - 0.25 * g.k * (g.shells.length - 1);
  let t1 = -Infinity, t2 = -Infinity, i1 = -1;
  g.shells.forEach((o, i) => {
    if (!o.obj.holes.length) {
      const [cx, cy, cz, r] = o.bsphere ??= boundSphere(o);
      if (r - Math.hypot(x - cx, y - cy, z - cz) < Math.max(lb, t1) - k) return;
    }
    const v = holeDepth(o, g.holes, x, y, z, 0.5 * h);
    if (v > t1) { t2 = t1; t1 = v; i1 = i; } else if (v > t2) t2 = v;
  });
  // which object is deepest, and by how much (for the grid: see cavity.ts)
  if (top) { top.i = i1; top.gap = t1 - t2; }
  let d = t2 === -Infinity ? t1 : -smin(-t1, -t2, k);
  // a closed cut's surface bounds the depth too
  for (const o of g.subs) if (o.obj.mode === 'subtract') d = Math.min(d, sdfWorld(o, x, y, z));
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
export function evalScene(groups: CompiledGroup[], depth: DepthFn, x: number, y: number, z: number, _cull = Infinity): number {
  const prog = groups[0]?.prog;
  if (!prog) return Infinity;
  runProgram(prog, 0, prog.length, depth, x, y, z);
  last.group = stU[0];
  last.kind = stK[0] === 1 ? 'cavity' : stK[0] === 2 ? 'pin' : 'material';
  return stG[0];
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
