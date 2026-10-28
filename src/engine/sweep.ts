// Sweeps: a 2D section carried along a path. The path is drawn on a plane (open or
// closed), may go round a closed loop several times ("turns"), and may be lifted off
// the plane along its normal by a graph over the distance travelled (a coil is a
// circle lifted steadily). The section stays perpendicular to the path and doesn't
// twist: frames are rotation-minimizing, and on a closed loop the small leftover
// twist is spread evenly round the loop.

import type { PrimitiveParams } from './document';
import { polygonSDF } from './math';
import { type ProfilePoint, sampleCurve } from './profile';

export const SWEEP_SAMPLES = 20; // path samples per drawn span
export const MAX_PATH_POINTS = 256;
export const MAX_SECTION_POINTS = 128;

export interface SweepPath {
  /** Path points, tangents, normals and binormals (xyz each), cumulative length. */
  P: Float64Array;
  T: Float64Array;
  N: Float64Array;
  B: Float64Array;
  s: Float64Array;
  n: number;
  /** The path returns to its start (no end caps). */
  loop: boolean;
  length: number;
}

export interface SweepSection {
  kind: 'circle' | 'square' | 'custom';
  /** half sizes */
  hw: number;
  hd: number;
  /** custom: closed polygon (u, v pairs), fitted to the size */
  poly: Float64Array;
  polyN: number;
}

/** Values of a graph y(x) for x in [0, 1], drawn as points (r = x). */
export function graphSampler(points: ProfilePoint[] | undefined): (x: number) => number {
  if (!points || points.length < 2) return () => 0;
  const { xy } = sampleCurve(points, 16, { clampR: false });
  return (x: number) => {
    if (x <= xy[0]) return xy[1];
    for (let i = 2; i < xy.length; i += 2) {
      if (xy[i] >= x) {
        const x0 = xy[i - 2], x1 = xy[i];
        const t = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
        return xy[i - 1] + (xy[i + 1] - xy[i - 1]) * t;
      }
    }
    return xy[xy.length - 1];
  };
}

/** Map plane coordinates (a, b) and lift h to 3D. */
export function planePoint(plane: PrimitiveParams['plane'], a: number, b: number, h: number): [number, number, number] {
  switch (plane) {
    case 'xz': return [a, h, b];
    case 'yz': return [h, b, a];
    default: return [a, b, h];
  }
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function buildSweepPath(p: PrimitiveParams): SweepPath {
  const pts = p.path ?? [];
  const closed = !!p.closed && pts.length > 2;
  const { xy } = sampleCurve(pts, SWEEP_SAMPLES, { closed, clampR: false });
  let ring: number[][] = [];
  for (let i = 0; i < xy.length; i += 2) ring.push([xy[i], xy[i + 1]]);
  // a closed loop goes round `turns` times
  const turns = closed ? Math.max(1, Math.round(p.turns ?? 1)) : 1;
  let flat: number[][] = [];
  for (let k = 0; k < turns; k++) flat = flat.concat(ring);
  if (closed) flat.push(ring[0]); // end where it started (on the plane)
  // keep within the texture budget
  if (flat.length > MAX_PATH_POINTS) {
    const step = (flat.length - 1) / (MAX_PATH_POINTS - 1);
    flat = Array.from({ length: MAX_PATH_POINTS }, (_, i) => flat[Math.min(flat.length - 1, Math.round(i * step))]);
  }
  ring = [];
  // planar arc length, for the lift graph
  const sp = [0];
  for (let i = 1; i < flat.length; i++) sp.push(sp[i - 1] + Math.hypot(flat[i][0] - flat[i - 1][0], flat[i][1] - flat[i - 1][1]));
  const L2 = sp[sp.length - 1] || 1;
  const lift = graphSampler(p.lift);
  let P3 = flat.map((q, i) => planePoint(p.plane, q[0], q[1], lift(sp[i] / L2)));
  // drop repeated points (zero-length segments)
  P3 = P3.filter((q, i) => i === 0 || Math.hypot(...sub(q, P3[i - 1]) as [number, number, number]) > 1e-6);
  const n = P3.length;
  const loop = closed && n > 2 && Math.hypot(...sub(P3[0], P3[n - 1]) as [number, number, number]) < 1e-6;
  // tangents: average of the neighbouring segment directions (wrapping on a loop)
  const T: number[][] = P3.map((_, i) => {
    const prev = i > 0 ? P3[i - 1] : loop ? P3[n - 2] : null;
    const next = i < n - 1 ? P3[i + 1] : loop ? P3[1] : null;
    const a = prev ? norm3(sub(P3[i], prev)) : null, b = next ? norm3(sub(next, P3[i])) : null;
    return norm3(a && b ? [a[0] + b[0], a[1] + b[1], a[2] + b[2]] : (a ?? b ?? [1, 0, 0]));
  });
  // rotation-minimizing frames (double reflection), starting from the plane normal
  const up = planePoint(p.plane, 0, 0, 1);
  let N0 = sub(up, T[0].map((t) => t * dot3(up, T[0])));
  if (Math.hypot(N0[0], N0[1], N0[2]) < 1e-6) N0 = Math.abs(T[0][0]) < 0.9 ? cross3(T[0], [1, 0, 0]) : cross3(T[0], [0, 1, 0]);
  const N: number[][] = [norm3(N0)];
  for (let i = 0; i < n - 1; i++) {
    const v1 = sub(P3[i + 1], P3[i]);
    const c1 = dot3(v1, v1) || 1;
    const rL = sub(N[i], v1.map((x) => (2 / c1) * dot3(v1, N[i]) * x));
    const tL = sub(T[i], v1.map((x) => (2 / c1) * dot3(v1, T[i]) * x));
    const v2 = sub(T[i + 1], tL);
    const c2 = dot3(v2, v2);
    N.push(norm3(c2 > 1e-12 ? sub(rL, v2.map((x) => (2 / c2) * dot3(v2, rL) * x)) : rL));
  }
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(...sub(P3[i], P3[i - 1]) as [number, number, number]));
  const length = s[n - 1];
  if (loop) {
    // spread the leftover twist evenly so the section meets itself
    const Bn = cross3(T[n - 1], N[n - 1]);
    const ang = Math.atan2(dot3(N[0], Bn), dot3(N[0], N[n - 1]));
    for (let i = 0; i < n; i++) {
      const a = (ang * s[i]) / (length || 1), c = Math.cos(a), si = Math.sin(a);
      const B = cross3(T[i], N[i]);
      N[i] = norm3([N[i][0] * c + B[0] * si, N[i][1] * c + B[1] * si, N[i][2] * c + B[2] * si]);
    }
    N[n - 1] = N[0];
  }
  const out = (rows: number[][]) => Float64Array.from(rows.flat());
  return { P: out(P3), T: out(T), N: out(N), B: out(T.map((t, i) => norm3(cross3(t, N[i])))), s: Float64Array.from(s), n, loop, length };
}

export function buildSweepSection(p: PrimitiveParams): SweepSection {
  const kind = p.section ?? 'circle';
  const hw = Math.max(0.01, (p.w ?? 2) / 2), hd = Math.max(0.01, (kind === 'circle' ? p.w ?? 2 : p.d ?? p.w ?? 2) / 2);
  let poly = new Float64Array(0);
  if (kind === 'custom') {
    const { xy } = sampleCurve(p.shape ?? [], 12, { closed: true, clampR: false });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < xy.length; i += 2) { x0 = Math.min(x0, xy[i]); x1 = Math.max(x1, xy[i]); y0 = Math.min(y0, xy[i + 1]); y1 = Math.max(y1, xy[i + 1]); }
    const m = Math.min(MAX_SECTION_POINTS, xy.length / 2);
    const step = xy.length / 2 / m;
    poly = new Float64Array(2 * m);
    for (let k = 0; k < m; k++) {
      const i = Math.floor(k * step);
      poly[2 * k] = ((xy[2 * i] - (x0 + x1) / 2) / ((x1 - x0) || 1)) * 2 * hw;
      poly[2 * k + 1] = ((xy[2 * i + 1] - (y0 + y1) / 2) / ((y1 - y0) || 1)) * 2 * hd;
    }
  }
  return { kind, hw, hd, poly, polyN: poly.length / 2 };
}

/** Signed distance to the section in its own plane (u along N, v along B). */
export function sectionSDF(sec: SweepSection, u: number, v: number): number {
  if (sec.kind === 'circle') return Math.sqrt(u * u + v * v) - sec.hw;
  if (sec.kind === 'square') {
    const dx = Math.abs(u) - sec.hw, dy = Math.abs(v) - sec.hd;
    const mx = Math.max(dx, 0), my = Math.max(dy, 0);
    return Math.sqrt(mx * mx + my * my) + Math.min(Math.max(dx, dy), 0);
  }
  return polygonSDF(sec.poly, sec.polyN, u, v).d;
}

/** How the sweep ends (open paths) and turns sharp corners, as with a stroke. */
export interface SweepStyle {
  /** round: the section spun about the bend's axis; miter: both sides run on to
   *  the bisecting plane (turns sharper than 120° are rounded instead). */
  join: 'round' | 'miter';
  /** flat: cut square to the path; round: the section spun about its out-of-plane
   *  axis; square: the path runs on by half the section's width. */
  cap: 'flat' | 'round' | 'square';
}

export function sweepStyle(p: PrimitiveParams): SweepStyle {
  return { join: p.join ?? 'round', cap: p.cap ?? 'flat' };
}

/** Miters for turns up to this (cosine of the turn angle, 120°); sharper ones are rounded. */
export const MITER_MIN_COS = -0.5;

/** A distance and an outside-distance past a cut, combined (like a capped extrusion). */
const capped = (d2: number, e: number) => { const a = Math.max(d2, 0), b = Math.max(e, 0); return Math.min(Math.max(d2, e), 0) + Math.sqrt(a * a + b * b); };
/** The same for a cut between two pieces of the sweep: inside it doesn't bound the
 *  depth (the neighbouring piece carries on), so depth inside stays the depth below
 *  the swept surface, never the distance to an internal seam. */
const seam = (d2: number, e: number) => (e > 0 ? capped(d2, e) : d2);

/** Largest distance of the section outline from the path. */
export function sectionRadius(sec: SweepSection): number {
  return sec.kind === 'circle' ? sec.hw : Math.hypot(sec.hw, sec.hd);
}

/** Turns gentler than this (4°) get no revolved corner piece: the notch left on the
 *  outside of a turn of angle θ is only R·θ²/8 deep (0.002 cm on a 2 cm section). */
export const CORNER_MIN_COS = Math.cos((4 * Math.PI) / 180);

/**
 * Signed distance to the swept solid, as the union of exact pieces: each path
 * segment's prism (its ends cut flat, on the bisecting plane at a miter, or run on
 * at a square cap), the section spun about the bend's axis at round corners, and
 * about its out-of-plane axis at round caps. `open` ends run on without end (the
 * hollow passes out through them). `part` says which bit of surface is nearest.
 */
/**
 * Per-path geometry for sweepEval, computed once per path and join style: segment
 * directions and lengths, section frames square to each segment at both ends, the
 * plane between neighbouring pieces at each vertex, and each round corner's axes.
 */
export interface SweepGeo {
  segs: number;
  D: Float64Array; // segment direction (3 per segment)
  L: Float64Array;
  Na: Float64Array; // section normal at the segment's start and end, square to it
  Nb: Float64Array;
  /** plane between the pieces at vertex i (3 per vertex): the bisector at a miter,
   *  else 0 (the seam is square to each segment) */
  M: Float64Array;
  miter: Uint8Array;
  /** the path turns more than 4° at vertex i: neighbouring pieces are evaluated too */
  sharp: Uint8Array;
  /** round corner at vertex i: bend axis (3), outward direction (3), the incoming
   *  segment's frame (N 3, B 3), and whether there is a corner at all */
  J: Float64Array;
  hasJ: Uint8Array;
}
const geoCache = new WeakMap<SweepPath, Map<string, SweepGeo>>();

export function sweepGeo(path: SweepPath, join: SweepStyle['join']): SweepGeo {
  let byJoin = geoCache.get(path);
  if (!byJoin) geoCache.set(path, (byJoin = new Map()));
  const hit = byJoin.get(join);
  if (hit) return hit;
  const { P, N, n, loop } = path;
  const segs = n - 1;
  const D = new Float64Array(3 * segs), L = new Float64Array(segs), Na = new Float64Array(3 * segs), Nb = new Float64Array(3 * segs);
  const square = (Nv: number[], d: number[]) => norm3(sub(Nv, d.map((c) => c * dot3(Nv, d))));
  for (let i = 0; i < segs; i++) {
    const e = [P[3 * i + 3] - P[3 * i], P[3 * i + 4] - P[3 * i + 1], P[3 * i + 5] - P[3 * i + 2]];
    L[i] = Math.hypot(e[0], e[1], e[2]);
    const d = norm3(e);
    D.set(d, 3 * i);
    Na.set(square([N[3 * i], N[3 * i + 1], N[3 * i + 2]], d), 3 * i);
    Nb.set(square([N[3 * i + 3], N[3 * i + 4], N[3 * i + 5]], d), 3 * i);
  }
  const M = new Float64Array(3 * n), miter = new Uint8Array(n), sharp = new Uint8Array(n), J = new Float64Array(12 * n), hasJ = new Uint8Array(n);
  const dir = (i: number) => [D[3 * i], D[3 * i + 1], D[3 * i + 2]];
  for (let j = 0; j < n; j++) {
    // the segments meeting at vertex j
    const a = j > 0 ? j - 1 : loop ? segs - 1 : -1, b = j < segs ? j : loop ? 0 : -1;
    if (a < 0 || b < 0) continue;
    const dA = dir(a), dB = dir(b), c = dot3(dA, dB);
    sharp[j] = c < CORNER_MIN_COS ? 1 : 0;
    if (join === 'miter' && c >= MITER_MIN_COS) { miter[j] = 1; M.set(norm3([dA[0] + dB[0], dA[1] + dB[1], dA[2] + dB[2]]), 3 * j); continue; }
    if (c >= CORNER_MIN_COS) continue;
    const ax = norm3(cross3(dA, dB));
    const k = norm3(sub(dB, dA.map((v) => v * c)));
    const Nn = [Nb[3 * a], Nb[3 * a + 1], Nb[3 * a + 2]]; // the incoming segment's frame at its end
    const Bn = cross3(dA, Nn);
    J.set([...ax, -k[0], -k[1], -k[2], ...Nn, ...Bn], 12 * j);
    hasJ[j] = 1;
  }
  const g = { segs, D, L, Na, Nb, M, miter, sharp, J, hasJ };
  byJoin.set(join, g);
  return g;
}

/** sqrt of a sum of squares (Math.hypot is slow in hot loops) */
const hyp = (a: number, b: number, c = 0) => Math.sqrt(a * a + b * b + c * c);

/**
 * Signed distance to the swept solid, as a union of exact pieces: each path
 * segment's prism (its ends cut flat, on the bisecting plane at a miter, or run on
 * at a square cap), the section spun about the bend's axis at round corners, and
 * about its out-of-plane axis at round caps. Only the pieces that can be nearest are
 * evaluated: the segment nearest by its centre line, and where it meets a sharp
 * corner (over 4°) the piece beyond and the corner piece; along a smooth path one
 * piece is exact enough (the gap left outside a gentle turn is ~R·θ²/8 deep).
 * Seams between pieces don't bound the depth inside. `open` ends run on without
 * end (the hollow passes out through them). `part` says which bit of surface is
 * nearest. The shader (raymarch.ts, sdSweep) mirrors this.
 */
export function sweepEval(
  path: SweepPath, sec: SweepSection, style: SweepStyle, x: number, y: number, z: number,
  open: { start?: boolean; end?: boolean } = {},
): { d: number; part: 'surface' | 'start' | 'end' } {
  const { P, n, loop } = path;
  const { segs, D, L, Na, Nb, M, miter, sharp, J, hasJ } = sweepGeo(path, style.join);
  const R = sectionRadius(sec), ext = style.cap === 'square' ? sec.hd : 0, roundCap = style.cap === 'round';
  let best = Infinity, part: 'surface' | 'start' | 'end' = 'surface';
  // the prism of segment i, cut at its ends
  const piece = (i: number) => {
    const wx = x - P[3 * i], wy = y - P[3 * i + 1], wz = z - P[3 * i + 2];
    const dx = D[3 * i], dy = D[3 * i + 1], dz = D[3 * i + 2];
    const xa = wx * dx + wy * dy + wz * dz, Li = L[i];
    const t = Li > 0 ? Math.max(0, Math.min(1, xa / Li)) : 0;
    let nx = Na[3 * i] + (Nb[3 * i] - Na[3 * i]) * t, ny = Na[3 * i + 1] + (Nb[3 * i + 1] - Na[3 * i + 1]) * t, nz = Na[3 * i + 2] + (Nb[3 * i + 2] - Na[3 * i + 2]) * t;
    const nl = hyp(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const bx = dy * nz - dz * ny, by = dz * nx - dx * nz, bz = dx * ny - dy * nx;
    const d2 = sectionSDF(sec, wx * nx + wy * ny + wz * nz, wx * bx + wy * by + wz * bz);
    // the path's own ends (flat or square caps) are real surface for every piece,
    // measured along the path so a path curling back isn't cut by its end plane
    let eReal = -1e9, eSeam = -1e9, endPart: 'start' | 'end' = 'start';
    if (!loop && !roundCap) {
      const along = path.s[i] + xa;
      if (!open.start) eReal = -along - ext;
      if (!open.end && along - path.length - ext > eReal) { eReal = along - path.length - ext; endPart = 'end'; }
    }
    // seams with the neighbouring pieces at sharp corners (always evaluated with
    // them), and round caps; through gentle turns a piece just runs on
    if (!loop && i === 0) { if (!open.start && roundCap) eSeam = -xa; }
    else if (sharp[i]) eSeam = miter[i] ? -(wx * M[3 * i] + wy * M[3 * i + 1] + wz * M[3 * i + 2]) : -xa;
    if (!loop && i === segs - 1) { if (!open.end && roundCap) eSeam = Math.max(eSeam, xa - Li); }
    else if (sharp[i + 1]) {
      const j = i + 1, vx = x - P[3 * j], vy = y - P[3 * j + 1], vz = z - P[3 * j + 2];
      eSeam = Math.max(eSeam, miter[j] ? vx * M[3 * j] + vy * M[3 * j + 1] + vz * M[3 * j + 2] : xa - Li);
    }
    const v = eSeam > 0 ? capped(d2, Math.max(eReal, eSeam)) : capped(d2, eReal);
    if (v < best) { best = v; part = eReal > d2 && eReal >= eSeam ? endPart : 'surface'; }
  };
  // the round corner at vertex j: the section spun about the bend's axis, in the wedge outside it
  const corner = (j: number) => {
    if (!hasJ[j]) return;
    const wx = x - P[3 * j], wy = y - P[3 * j + 1], wz = z - P[3 * j + 2], o = 12 * j;
    const yb = wx * J[o] + wy * J[o + 1] + wz * J[o + 2];
    const rho = hyp(wx - J[o] * yb, wy - J[o + 1] * yb, wz - J[o + 2] * yb);
    const cN = J[o + 3] * J[o + 6] + J[o + 4] * J[o + 7] + J[o + 5] * J[o + 8], aN = J[o] * J[o + 6] + J[o + 1] * J[o + 7] + J[o + 2] * J[o + 8];
    const cB = J[o + 3] * J[o + 9] + J[o + 4] * J[o + 10] + J[o + 5] * J[o + 11], aB = J[o] * J[o + 9] + J[o + 1] * J[o + 10] + J[o + 2] * J[o + 11];
    const a = j > 0 ? j - 1 : segs - 1, b = j < segs ? j : 0;
    const wedge = Math.max(-(wx * D[3 * a] + wy * D[3 * a + 1] + wz * D[3 * a + 2]), wx * D[3 * b] + wy * D[3 * b + 1] + wz * D[3 * b + 2]);
    const v = seam(sectionSDF(sec, rho * cN + yb * aN, rho * cB + yb * aB), wedge);
    if (v < best) { best = v; part = 'surface'; }
  };
  // the segment nearest by its centre line
  let bi = 0, bd = Infinity;
  for (let i = 0; i < segs; i++) {
    const wx = x - P[3 * i], wy = y - P[3 * i + 1], wz = z - P[3 * i + 2];
    const t = Math.max(0, Math.min(L[i], wx * D[3 * i] + wy * D[3 * i + 1] + wz * D[3 * i + 2]));
    const ex = wx - D[3 * i] * t, ey = wy - D[3 * i + 1] * t, ez = wz - D[3 * i + 2] * t;
    const dd = ex * ex + ey * ey + ez * ez;
    if (dd < bd) { bd = dd; bi = i; }
  }
  piece(bi);
  if (sharp[bi] && (bi > 0 || loop)) { piece(bi > 0 ? bi - 1 : segs - 1); corner(bi); }
  if (sharp[bi + 1] && (bi + 1 < segs || loop)) { piece(bi + 1 < segs ? bi + 1 : 0); corner(bi + 1); }
  // round caps: the section spun about its out-of-plane axis past each closed end
  if (!loop && roundCap) {
    for (let e = 0; e < 2; e++) {
      if (e === 0 ? open.start || bi !== 0 : open.end || bi !== segs - 1) continue;
      const j = e === 0 ? 0 : n - 1, seg = e === 0 ? 0 : segs - 1, sg = e === 0 ? -1 : 1;
      const wx = x - P[3 * j], wy = y - P[3 * j + 1], wz = z - P[3 * j + 2];
      const dx = D[3 * seg] * sg, dy = D[3 * seg + 1] * sg, dz = D[3 * seg + 2] * sg;
      const F = e === 0 ? Na : Nb, nx = F[3 * seg], ny = F[3 * seg + 1], nz = F[3 * seg + 2];
      const bx = dy * nz - dz * ny, by = dz * nx - dx * nz, bz = dx * ny - dy * nx;
      const al = wx * dx + wy * dy + wz * dz, u = wx * nx + wy * ny + wz * nz, rho = hyp(wx * bx + wy * by + wz * bz, al);
      const v = seam(Math.min(sectionSDF(sec, u, rho), sectionSDF(sec, u, -rho)), -al);
      if (v < best) { best = v; part = e === 0 ? 'start' : 'end'; }
    }
  }
  void R;
  return { d: best, part };
}

/** Section outline as a ring of (u, v) points, counter-clockwise. */
export function sectionRing(sec: SweepSection, segs = 32): number[] {
  if (sec.kind === 'circle') return Array.from({ length: segs }, (_, k) => [sec.hw * Math.cos((2 * Math.PI * k) / segs), sec.hw * Math.sin((2 * Math.PI * k) / segs)]).flat();
  if (sec.kind === 'square') return [-sec.hw, -sec.hd, sec.hw, -sec.hd, sec.hw, sec.hd, -sec.hw, sec.hd];
  const r = Array.from(sec.poly);
  let a = 0;
  for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  if (a < 0) { const out: number[] = []; for (let i = r.length / 2 - 1; i >= 0; i--) out.push(r[2 * i], r[2 * i + 1]); return out; }
  return r;
}

/** Triangulate a simple polygon (ear clipping); indices into the ring. */
function earClip(ring: number[]): number[] {
  const n = ring.length / 2;
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const x = (i: number) => ring[2 * i], y = (i: number) => ring[2 * i + 1];
  const cross = (a: number, b: number, c: number) => (x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a));
  const inTri = (p: number, a: number, b: number, c: number) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inTri(p, a, b, c))) continue;
      out.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate: fan the rest
  }
  for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0], idx[k], idx[k + 1]);
  return out;
}

/** Where a ring sits: its centre and section axes, optionally slid along `d` onto
 *  the plane through `V` with normal `m` (a miter between two segments). */
interface Station { p: number[]; n: number[]; b: number[]; miter?: { d: number[]; m: number[]; V: number[] } }

/** Closed triangle mesh of a ring carried through stations; flat caps unless `loop`. */
function tubeMesh(st: Station[], ring: number[], loop: boolean): { positions: Float32Array; indices: Uint32Array } {
  const m = ring.length / 2, K = st.length;
  const pos = new Float32Array(K * m * 3);
  st.forEach((e, i) => {
    for (let k = 0; k < m; k++) {
      const u = ring[2 * k], v = ring[2 * k + 1];
      let q = [0, 1, 2].map((a) => e.p[a] + e.n[a] * u + e.b[a] * v);
      if (e.miter) {
        const { d, m: mm, V } = e.miter;
        const t = -dot3(sub(q, V), mm) / (dot3(d, mm) || 1);
        q = q.map((c, a) => c + d[a] * t);
      }
      pos.set(q, 3 * (i * m + k));
    }
  });
  const tri: number[] = [];
  for (let i = 0; i < (loop ? K : K - 1); i++) {
    const i2 = (i + 1) % K;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const a = i * m + k, b = i * m + k2, c = i2 * m + k2, d = i2 * m + k;
      tri.push(a, b, c, a, c, d);
    }
  }
  if (!loop) {
    const cap = earClip(ring);
    for (let j = 0; j < cap.length; j += 3) {
      tri.push(cap[j + 2], cap[j + 1], cap[j]); // start faces backwards
      tri.push((K - 1) * m + cap[j], (K - 1) * m + cap[j + 1], (K - 1) * m + cap[j + 2]);
    }
  }
  // make the triangles face outwards
  let vol = 0;
  for (let j = 0; j < tri.length; j += 3) {
    const [a, b, c] = [tri[j], tri[j + 1], tri[j + 2]].map((q) => [pos[3 * q], pos[3 * q + 1], pos[3 * q + 2]]);
    vol += dot3(a, cross3(b, c));
  }
  if (vol < 0) for (let j = 0; j < tri.length; j += 3) { const t = tri[j]; tri[j] = tri[j + 2]; tri[j + 2] = t; }
  return { positions: pos, indices: Uint32Array.from(tri) };
}

/** A revolved piece: the section (u along n, v along b) spun about `axis` through
 *  `V`, kept where w·keep[i] >= 0 for each plane (w = point − V). */
export interface SweepSpin { V: number[]; axis: number[]; out: number[]; n: number[]; b: number[]; keep: number[][]; mirror: boolean }

/** Corners turning more than this are joined by a revolved piece in the mesh (the
 *  tube is mitred through gentler ones, where round and miter differ by < 1%). */
const MESH_CORNER_COS = Math.cos((12 * Math.PI) / 180);

/**
 * The swept solid as mesh pieces to union: tube runs (split at sharp round
 * corners, mitred elsewhere), and revolved pieces for round corners and caps.
 * `ends` moves the open path's ends out (+) or in (−) along the path; `round`
 * adds a round cap at that end.
 */
export function sweepParts(
  path: SweepPath, ring: number[], style: SweepStyle,
  ends: { start: number; end: number; roundStart: boolean; roundEnd: boolean },
): { runs: { positions: Float32Array; indices: Uint32Array }[]; spins: SweepSpin[] } {
  const g = sweepGeo(path, style.join);
  const { P, n, loop } = path;
  const { segs, D, Na, Nb } = g;
  const pt = (i: number) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  const v3 = (A: Float64Array, i: number) => [A[3 * i], A[3 * i + 1], A[3 * i + 2]];
  const verts = loop ? n - 1 : n; // a loop's last point is its first
  const segIn = (j: number) => (j > 0 ? j - 1 : loop ? segs - 1 : -1), segOut = (j: number) => (j < segs ? j : loop ? 0 : -1);
  // the tube splits at sharp corners: a revolved piece joins round ones, and the
  // two runs meet on the bisecting plane at a miter
  const turnCos = (j: number) => { const a = segIn(j), b = segOut(j); return a < 0 || b < 0 ? 1 : dot3(v3(D, a), v3(D, b)); };
  const split = (j: number) => turnCos(j) < MESH_CORNER_COS;
  const isMiter = (j: number) => style.join === 'miter' && turnCos(j) >= MITER_MIN_COS;
  // a ring at vertex j slid onto the bisecting plane, along the segment arriving
  // (or, `leaving`, the one leaving)
  const across = (j: number, leaving = false): Station => {
    const a = segIn(j), b = segOut(j), dA = v3(D, a), dB = v3(D, b);
    const d = leaving ? dB : dA, N = leaving ? v3(Na, b) : v3(Nb, a);
    return { p: pt(j), n: N, b: cross3(d, N), miter: { d, m: norm3([dA[0] + dB[0], dA[1] + dB[1], dA[2] + dB[2]]), V: pt(j) } };
  };
  // how far before a miter the inner side of the ring reaches back: rings closer
  // than this would fold over the bisecting plane, so they're left out
  let R = 0;
  for (let i = 0; i < ring.length; i += 2) R = Math.max(R, Math.hypot(ring[i], ring[i + 1]));
  const miterReach = (j: number) => { const c = turnCos(j); return R * Math.sqrt(Math.max(0, (1 - c) / (1 + c))) * 1.05; };
  const square = (j: number, seg: number, atEnd: boolean, shift = 0): Station => {
    const d = v3(D, seg), N = v3(atEnd ? Nb : Na, seg);
    return { p: pt(j).map((c, a) => c + d[a] * shift), n: N, b: cross3(d, N) };
  };
  const runs: { positions: Float32Array; indices: Uint32Array }[] = [];
  const spins: SweepSpin[] = [];
  const splits = Array.from({ length: verts }, (_, j) => j).filter(split);
  if (loop && !splits.length) {
    runs.push(tubeMesh(Array.from({ length: verts }, (_, j) => across(j)), ring, true));
  } else {
    // runs from split to split (a loop wraps round), or from end to end
    const starts = loop ? splits : [0, ...splits];
    for (let r = 0; r < starts.length; r++) {
      const j0 = starts[r];
      const j1 = loop ? splits[(r + 1) % splits.length] : r + 1 < starts.length ? starts[r + 1] : n - 1;
      const st: Station[] = [];
      const m0 = !(!loop && j0 === 0) && isMiter(j0), m1 = !(!loop && j1 === n - 1) && isMiter(j1);
      if (!loop && j0 === 0) st.push(square(0, 0, false, -ends.start));
      else st.push(m0 ? across(j0, true) : square(j0, segOut(j0), false));
      const s0 = path.s[j0], s1 = j1 === 0 && loop ? path.length : path.s[j1];
      const r0 = m0 ? miterReach(j0) : 0, r1 = m1 ? miterReach(j1) : 0;
      for (let j = (j0 + 1) % verts, guard = 0; j !== j1 && guard < verts; j = (j + 1) % verts, guard++) {
        const sj = path.s[j] < s0 ? path.s[j] + path.length : path.s[j];
        if (sj - s0 < r0 || s1 + (s1 < s0 ? path.length : 0) - sj < r1) continue;
        st.push(across(j));
      }
      if (!loop && j1 === n - 1) st.push(square(n - 1, segs - 1, true, ends.end));
      else st.push(m1 ? across(j1) : square(j1, segIn(j1), true));
      runs.push(tubeMesh(st, ring, false));
    }
    for (const j of splits) {
      if (isMiter(j)) continue;
      const a = segIn(j), b = segOut(j), dA = v3(D, a), dB = v3(D, b), c = dot3(dA, dB);
      const k = norm3(sub(dB, dA.map((v) => v * c)));
      const N = v3(Nb, a);
      spins.push({ V: pt(j), axis: norm3(cross3(dA, dB)), out: [-k[0], -k[1], -k[2]], n: N, b: cross3(dA, N), keep: [dA, dB.map((v) => -v)], mirror: false });
    }
  }
  // round caps: the section spun about its out-of-plane axis past each end
  if (!loop) {
    for (const [on, j, seg, sgn, F] of [[ends.roundStart, 0, 0, -1, Na], [ends.roundEnd, n - 1, segs - 1, 1, Nb]] as const) {
      if (!on) continue;
      const d = v3(D, seg).map((v) => v * sgn), N = v3(F, seg);
      const B = cross3(v3(D, seg), N);
      spins.push({ V: pt(j), axis: N, out: B, n: N, b: B, keep: [d], mirror: true });
    }
  }
  return { runs, spins };
}

/**
 * Closed triangle mesh of the ring swept along the path (sweep-local space), mitred
 * through every corner (a quick preview; the kernels use sweepParts).
 */
export function sweepMesh(path: SweepPath, ring: number[]): { positions: Float32Array; indices: Uint32Array } {
  const { runs } = sweepParts(path, ring, { join: 'miter', cap: 'flat' }, { start: 0, end: 0, roundStart: false, roundEnd: false });
  if (runs.length === 1) return runs[0];
  // a mitre limit split the tube: show the runs together
  let nv = 0;
  const pos: number[] = [], idx: number[] = [];
  for (const r of runs) { pos.push(...r.positions); idx.push(...Array.from(r.indices, (i) => i + nv)); nv += r.positions.length / 3; }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
