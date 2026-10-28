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
  if (sec.kind === 'circle') return Math.hypot(u, v) - sec.hw;
  if (sec.kind === 'square') {
    const dx = Math.abs(u) - sec.hw, dy = Math.abs(v) - sec.hd;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  }
  return polygonSDF(sec.poly, sec.polyN, u, v).d;
}

export interface SweepSample {
  /** section distance, distance past the caps (negative inside), along-path position */
  d2: number;
  cap: number;
  along: number;
}

/** Locate a point against the swept path: nearest segment, then section coordinates. */
export function sweepLocate(path: SweepPath, sec: SweepSection, x: number, y: number, z: number): SweepSample {
  const { P, N, B, s, n } = path;
  let best = Infinity, bi = 0, bt = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = P[3 * i], ay = P[3 * i + 1], az = P[3 * i + 2];
    const ex = P[3 * i + 3] - ax, ey = P[3 * i + 4] - ay, ez = P[3 * i + 5] - az;
    const ee = ex * ex + ey * ey + ez * ez || 1;
    let t = ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / ee;
    const tc = Math.max(0, Math.min(1, t));
    const dx = x - ax - ex * tc, dy = y - ay - ey * tc, dz = z - az - ez * tc;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < best) {
      best = dd; bi = i;
      // only the path's ends extend past their segment (that's where the caps are)
      if (!(i === 0 && t < 0 && !path.loop) && !(i === n - 2 && t > 1 && !path.loop)) t = tc;
      bt = t;
    }
  }
  const i = bi, t = bt;
  const lerp = (A: Float64Array, k: number) => A[3 * i + k] + (A[3 * i + 3 + k] - A[3 * i + k]) * Math.max(0, Math.min(1, t));
  const px = P[3 * i] + (P[3 * i + 3] - P[3 * i]) * t, py = P[3 * i + 1] + (P[3 * i + 4] - P[3 * i + 1]) * t, pz = P[3 * i + 2] + (P[3 * i + 5] - P[3 * i + 2]) * t;
  const nx = lerp(N, 0), ny = lerp(N, 1), nz = lerp(N, 2);
  const bx = lerp(B, 0), by = lerp(B, 1), bz = lerp(B, 2);
  const nl = Math.hypot(nx, ny, nz) || 1, bl = Math.hypot(bx, by, bz) || 1;
  const wx = x - px, wy = y - py, wz = z - pz;
  const u = (wx * nx + wy * ny + wz * nz) / nl, v = (wx * bx + wy * by + wz * bz) / bl;
  const along = s[i] + (s[i + 1] - s[i]) * t;
  const cap = path.loop ? -1e9 : Math.max(-along, along - path.length);
  return { d2: sectionSDF(sec, u, v), cap, along };
}

/** Signed distance to the swept solid. */
export function sweepSDF(path: SweepPath, sec: SweepSection, x: number, y: number, z: number): number {
  const { d2, cap } = sweepLocate(path, sec, x, y, z);
  return Math.min(Math.max(d2, cap), 0) + Math.hypot(Math.max(d2, 0), Math.max(cap, 0));
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

/**
 * Closed triangle mesh of the ring swept along the path (sweep-local space).
 * `trim` pulls the open ends in by that distance (start, end), `extend` pushes
 * them out (used for hollows and their openings).
 */
export function sweepMesh(path: SweepPath, ring: number[], trim: number | [number, number] = 0, extend: { start?: number; end?: number } = {}): { positions: Float32Array; indices: Uint32Array } {
  const [trim0, trim1] = typeof trim === 'number' ? [trim, trim] : trim;
  const m = ring.length / 2;
  // stations along the path: [s, P, N, B]
  type St = { p: number[]; n: number[]; b: number[] };
  const at = (i: number): St => ({ p: [path.P[3 * i], path.P[3 * i + 1], path.P[3 * i + 2]], n: [path.N[3 * i], path.N[3 * i + 1], path.N[3 * i + 2]], b: [path.B[3 * i], path.B[3 * i + 1], path.B[3 * i + 2]] });
  const interp = (s: number): St => {
    let i = 0;
    while (i < path.n - 2 && path.s[i + 1] < s) i++;
    const t = (s - path.s[i]) / ((path.s[i + 1] - path.s[i]) || 1);
    const A = at(i), B = at(i + 1);
    const l = (u: number[], v: number[]) => u.map((x, k) => x + (v[k] - x) * t);
    return { p: l(A.p, B.p), n: norm3(l(A.n, B.n)), b: norm3(l(A.b, B.b)) };
  };
  let st: St[];
  if (path.loop) st = Array.from({ length: path.n - 1 }, (_, i) => at(i));
  else {
    const s0 = trim0, s1 = path.length - trim1;
    if (s1 <= s0) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
    st = [interp(s0)];
    for (let i = 0; i < path.n; i++) if (path.s[i] > s0 + 1e-6 && path.s[i] < s1 - 1e-6) st.push(at(i));
    st.push(interp(s1));
    const push = (e: St, dir: number[], d: number) => ({ ...e, p: e.p.map((x, k) => x + dir[k] * d) });
    if (extend.start) { const T0 = norm3(sub(st[1].p, st[0].p)); st[0] = push(st[0], T0, -extend.start); }
    if (extend.end) { const k = st.length - 1, T1 = norm3(sub(st[k].p, st[k - 1].p)); st[k] = push(st[k], T1, extend.end); }
  }
  const K = st.length;
  const pos = new Float32Array(K * m * 3);
  st.forEach((e, i) => {
    for (let k = 0; k < m; k++) {
      const u = ring[2 * k], v = ring[2 * k + 1];
      for (let a = 0; a < 3; a++) pos[3 * (i * m + k) + a] = e.p[a] + e.n[a] * u + e.b[a] * v;
    }
  });
  const tri: number[] = [];
  const rings = path.loop ? K : K - 1;
  for (let i = 0; i < rings; i++) {
    const i2 = (i + 1) % K;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const a = i * m + k, b = i * m + k2, c = i2 * m + k2, d = i2 * m + k;
      tri.push(a, b, c, a, c, d);
    }
  }
  if (!path.loop) {
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
