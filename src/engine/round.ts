// Compound rounding: a group's finished body (its Add objects less its Subtract
// ones) rounded as a whole, every edge, convex and concave, by radius r.
//
// Rounding a shape by r is an opening (erode by r, then dilate by r: convex edges
// and corners become round) followed by a closing (the same on the space outside:
// concave edges and grooves get a fillet). Plain openings erase any part thinner
// than 2r and closings fill any gap narrower than 2r, so here the radius adapts:
// at each place it is at most 0.95 of the local half-thickness (of the clay, or of
// the gap), the radius of the largest ball inside that covers the place. A slab
// thinner than 2r is rounded into a bullnose; a handle's hole stays open.
//
// Each step is a level of a distance field, measured from seeds on that level
// (grid edge crossings with a normal; a seed stands for a small tangent disc of
// its surface, as in the cavity grid), propagated through a band round the body to
// every texel's nearest seed:
//   D0: distance to the sharp body (signed: negative inside)
//   opened = balls of radius l round {D0 <= -l}, l = min(r, 0.95 x thickness)
//   D2: distance to the opened body
//   closed = the same on the outside of D2
//   D4: distance to the closed body: the rounded body's field
//
// The grid stores the rounded field minus the sharp one, which the shader and the
// CPU field add to the sharp body. Outside the band it stores -r: the rounded
// body's distance is at least the sharp body's minus r there (a closing only adds
// material within r of the body), so the field stays a lower bound.

import type { Quality } from './document';
import { type CompiledGroup, type RoundGrid, bodySDF } from './scene';

const BUDGET: Record<Quality, number> = { draft: 150_000, normal: 800_000, fine: 2_500_000 };
const B = 8;

export interface Lattice { origin: [number, number, number]; h: number; dims: [number, number, number] }

/** The lattice a group's rounding (and then its cavity) is computed on. */
export function roundLattice(g: CompiledGroup, quality: Quality): Lattice {
  const b = g.bounds, r = g.round;
  const ext = [0, 1, 2].map((a) => b.max[a] - b.min[a]);
  let h = Math.cbrt((ext[0] + 4 * r) * (ext[1] + 4 * r) * (ext[2] + 4 * r) / BUDGET[quality]);
  h = Math.max(h, Math.max(...ext) / 400);
  const pad = 2 * r + 5 * h;
  const origin: [number, number, number] = [b.min[0] - pad, b.min[1] - pad, b.min[2] - pad];
  const dims = [0, 1, 2].map((a) => Math.max(2, Math.ceil((ext[a] + 2 * pad) / h) + 1)) as [number, number, number];
  return { origin, h, dims };
}

export function buildRoundGrid(g: CompiledGroup, quality: Quality, lat = roundLattice(g, quality)): RoundGrid {
  const r = g.round;
  const { origin, h, dims } = lat;
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const posX = (i: number) => origin[0] + i * h, posY = (j: number) => origin[1] + j * h, posZ = (k: number) => origin[2] + k * h;
  const qi = (q: number) => q % nx, qj = (q: number) => Math.floor(q / nx) % ny, qk = (q: number) => Math.floor(q / (nx * ny));
  const saved = g.roundGrid;
  g.roundGrid = undefined; // the sharp body

  // 1. The sharp body's field in the band (blocks the band can't reach are skipped).
  // (an opening reaches r inside, a closing r outside, and their thickness balls r further)
  const band = 2 * r + 4 * h;
  const G0 = new Float32Array(N).fill(NaN);
  const R = (B * h * Math.sqrt(3)) / 2;
  for (let bk = 0; bk * B < nz; bk++) for (let bj = 0; bj * B < ny; bj++) for (let bi = 0; bi * B < nx; bi++) {
    const i1 = Math.min(nx, (bi + 1) * B + 1), j1 = Math.min(ny, (bj + 1) * B + 1), k1 = Math.min(nz, (bk + 1) * B + 1);
    const fc = bodySDF(g, posX((bi * B + i1 - 1) / 2), posY((bj * B + j1 - 1) / 2), posZ((bk * B + k1 - 1) / 2));
    const skip = Math.abs(fc) > band + R;
    for (let k = bk * B; k < k1; k++) for (let j = bj * B; j < j1; j++) for (let i = bi * B; i < i1; i++) {
      const q = idx(i, j, k);
      if (!Number.isNaN(G0[q]) && Number.isFinite(G0[q])) continue;
      G0[q] = skip ? (fc > 0 ? Infinity : -Infinity) : bodySDF(g, posX(i), posY(j), posZ(k));
    }
  }
  const inBand = new Uint8Array(N);
  const list: number[] = [];
  for (let q = 0; q < N; q++) if (Math.abs(G0[q]) <= band) { inBand[q] = 1; list.push(q); }

  // texel positions, once (band texels only)
  const X = new Float32Array(N), Y = new Float32Array(N), Z = new Float32Array(N);
  for (const q of list) { X[q] = posX(qi(q)); Y[q] = posY(qj(q)); Z[q] = posZ(qk(q)); }
  const qx = (q: number) => X[q], qy = (q: number) => Y[q], qz = (q: number) => Z[q];
  const offs = [1, -1, nx, -nx, nx * ny, -nx * ny];
  /**
   * Spread values through the band from the `start` texels: whenever `better(t, q)`
   * lets texel t take its neighbour q's value, t is queued to pass it on in turn.
   */
  const queue = new Int32Array(N + 1);
  const queued = new Uint8Array(N);
  const spread = (start: Iterable<number>, better: (t: number, q: number) => boolean) => {
    let head = 0, tail = 0, n = 0;
    const push = (t: number) => { if (!queued[t]) { queued[t] = 1; queue[tail] = t; tail = tail === N ? 0 : tail + 1; n++; } };
    for (const q of start) push(q);
    while (n) {
      const q = queue[head]; head = head === N ? 0 : head + 1; n--;
      queued[q] = 0;
      for (const o of offs) {
        const t = q + o;
        if (t >= 0 && t < N && inBand[t] && better(t, q)) push(t);
      }
    }
  };

  /**
   * Distance to the surface {V = L} (L per texel), signed positive where V > L, at
   * the band texels, less the radius `rad` carried by the nearest seed (0: a plain
   * distance). With `exact`, the crossings are projected onto the sharp body.
   */
  const level = (V: Float32Array, L: Float32Array | null, rad: Float32Array | null, exact: boolean): Float32Array => {
    const lv = (q: number) => (L ? L[q] : 0);
    const sx: number[] = [], sy: number[] = [], sz: number[] = [], snx: number[] = [], sny: number[] = [], snz: number[] = [], sr: number[] = [];
    const nearest = new Int32Array(N).fill(-1);
    const d2 = (q: number, s: number) => {
      const dx = qx(q) - sx[s], dy = qy(q) - sy[s], dz = qz(q) - sz[s];
      return dx * dx + dy * dy + dz * dz;
    };
    // the field's gradient at a texel (central differences within the band)
    const gradAt = (q: number, out: number[]) => {
      const i = qi(q), j = qj(q), k = qk(q);
      const at = (a: number, b: number) => (a >= 0 && b >= 0 && inBand[a] && inBand[b] ? (V[a] - lv(a) - V[b] + lv(b)) / 2 : 0);
      out[0] = at(i + 1 < nx ? q + 1 : -1, i > 0 ? q - 1 : -1);
      out[1] = at(j + 1 < ny ? q + nx : -1, j > 0 ? q - nx : -1);
      out[2] = at(k + 1 < nz ? q + nx * ny : -1, k > 0 ? q - nx * ny : -1);
    };
    const ga = [0, 0, 0], gb = [0, 0, 0];
    const e = h * 0.05;
    const bgrad = (x: number, y: number, z: number) => {
      const gx = bodySDF(g, x + e, y, z) - bodySDF(g, x - e, y, z), gy = bodySDF(g, x, y + e, z) - bodySDF(g, x, y - e, z), gz = bodySDF(g, x, y, z + e) - bodySDF(g, x, y, z - e);
      const l = Math.hypot(gx, gy, gz) || 1;
      return [gx / l, gy / l, gz / l];
    };
    for (const q of list) {
      const i = qi(q), j = qj(q), k = qk(q);
      const fa = V[q] - lv(q);
      const nb = [i + 1 < nx ? q + 1 : -1, j + 1 < ny ? q + nx : -1, k + 1 < nz ? q + nx * ny : -1];
      for (let a = 0; a < 3; a++) {
        const p = nb[a];
        if (p < 0 || !inBand[p]) continue;
        const fb = V[p] - lv(p);
        if ((fa < 0) === (fb < 0)) continue;
        const u = fa / (fa - fb);
        let x = posX(i + (a === 0 ? u : 0)), y = posY(j + (a === 1 ? u : 0)), z = posZ(k + (a === 2 ? u : 0));
        let n: number[];
        if (exact) {
          // Newton steps onto the sharp body's surface
          n = bgrad(x, y, z);
          for (let it = 0; it < 4; it++) {
            const f = bodySDF(g, x, y, z);
            x -= n[0] * f; y -= n[1] * f; z -= n[2] * f;
            n = bgrad(x, y, z);
            if (Math.abs(f) < 1e-4 * h) break;
          }
        } else {
          gradAt(q, ga); gradAt(p, gb);
          n = [ga[0] * (1 - u) + gb[0] * u, ga[1] * (1 - u) + gb[1] * u, ga[2] * (1 - u) + gb[2] * u];
          const l = Math.hypot(n[0], n[1], n[2]) || 1;
          n = [n[0] / l, n[1] / l, n[2] / l];
        }
        const s = sx.length;
        sx.push(x); sy.push(y); sz.push(z); snx.push(n[0]); sny.push(n[1]); snz.push(n[2]);
        sr.push(rad ? rad[q] * (1 - u) + rad[p] * u : 0);
        for (const t of [q, p]) if (nearest[t] < 0 || d2(t, s) < d2(t, nearest[t])) nearest[t] = s;
      }
    }
    // the nearest seed to each band texel; with radii, the ball reaching furthest
    const reach = (q: number, s: number) => Math.sqrt(d2(q, s)) - sr[s];
    const seeded: number[] = [];
    for (const q of list) if (nearest[q] >= 0) seeded.push(q);
    spread(seeded, (t, q) => {
      const s = nearest[q], cur = nearest[t];
      if (s < 0 || s === cur) return false;
      if (cur >= 0 && (rad ? reach(t, s) >= reach(t, cur) : d2(t, s) >= d2(t, cur))) return false;
      nearest[t] = s;
      return true;
    });
    const rho = 0.75 * h;
    const out = new Float32Array(N).fill(NaN);
    for (const q of list) {
      const s = nearest[q];
      const sign = V[q] - lv(q) >= 0 ? 1 : -1;
      if (s < 0) { out[q] = sign * 2 * band; continue; }
      const vx = qx(q) - sx[s], vy = qy(q) - sy[s], vz = qz(q) - sz[s];
      const vn = vx * snx[s] + vy * sny[s] + vz * snz[s];
      const lat = Math.hypot(vx - vn * snx[s], vy - vn * sny[s], vz - vn * snz[s]);
      out[q] = sign * Math.hypot(vn, Math.max(0, lat - rho)) - sr[s];
    }
    return out;
  };

  /**
   * The local half-thickness of {V < 0}: at each texel inside, the radius of the
   * largest ball inside it that comes within r of the texel (texels deeper than the
   * band count as deep as the band). Within r, so a sharp corner, covered only by
   * small balls, still counts as part of the thick body it is a corner of; a slab
   * thinner than 2r has no ball bigger than its half-thickness. Propagated: a texel
   * takes a neighbour's ball if that one reaches it and is bigger.
   */
  const thickness = (V: Float32Array): Float32Array => {
    // (only up to r matters: the radius is at most r)
    const cap = r / 0.95;
    const depth = (q: number) => (inBand[q] ? Math.min(cap, -V[q]) : cap);
    const cen = new Int32Array(N).fill(-1);
    const inside: number[] = [];
    for (const q of list) if (V[q] < 0) { cen[q] = q; inside.push(q); }
    spread(inside, (t, q) => {
      const c = cen[q], cur = cen[t];
      if (c < 0 || cur < 0 || c === cur || depth(c) <= depth(cur)) return false;
      const dx = qx(t) - qx(c), dy = qy(t) - qy(c), dz = qz(t) - qz(c);
      const reachC = depth(c) + r;
      if (dx * dx + dy * dy + dz * dz > reachC * reachC) return false;
      cen[t] = c;
      return true;
    });
    const M = new Float32Array(N).fill(cap);
    for (const q of list) if (cen[q] >= 0) M[q] = depth(cen[q]);
    return M;
  };

  /** Open {V < 0} (V a distance, negative inside) with the local radius: a field for the opened shape. */
  const open = (V: Float32Array): Float32Array => {
    const M = thickness(V);
    const l = new Float32Array(N), L = new Float32Array(N);
    for (const q of list) { l[q] = Math.min(r, 0.95 * M[q]); L[q] = -l[q]; }
    // balls of radius l round the eroded shape {V <= -l}
    return level(V, L, l, false);
  };

  const D0 = level(G0, null, null, true);
  const D2 = level(open(D0), null, null, false);
  // closing: the opening of the outside
  const neg = (A: Float32Array) => { const o = new Float32Array(N); for (let q = 0; q < N; q++) o[q] = -A[q]; return o; };
  const D4 = level(neg(open(neg(D2))), null, null, false);
  const data = new Float32Array(N).fill(-r);
  for (const q of list) {
    const v = D4[q] - G0[q];
    if (Number.isFinite(v)) data[q] = Math.max(-band, Math.min(band, v));
  }
  g.roundGrid = saved;
  return { origin, h, dims, data, r };
}
