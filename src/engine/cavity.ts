// Exact cavity depth for each hollow group, sampled on a coarse grid.
//
// D(p) = distance from p to the group's shell surface, ignoring faces marked as
// openings, signed positive inside. It is smooth (a distance function), so a
// trilinearly interpolated grid reproduces the inner wall {D = t} accurately even
// when the wall is much thinner than a grid cell: across the outer surface D is
// linear, and a linear function interpolates exactly.
//
// Method: zero crossings of the shell field on grid edges are projected onto the
// surface (seeds, with normals); seeds on opening faces are dropped; every band
// texel then finds its nearest seed by propagation (a vector distance transform),
// and measures the distance to that seed's small tangent disc.

import type { Quality } from './document';
import { type CompiledGroup, baseDepth, shapeSDF, shellSDF } from './scene';
import { type CompiledObject, faceAtWorld, normalToWorld, sdfWorld, toWorld } from './primitives';

export interface CavityGrid {
  groupIndex: number;
  origin: [number, number, number];
  h: number;
  dims: [number, number, number];
  /** Per texel (x fastest): signed depth D minus the analytic base depth A
   *  (scene.baseDepth). D = A + C, clamped to [-clampV, clampV]. */
  data: Float32Array;
  clampV: number;
  /** Walls up to this thickness are represented exactly (grid can be reused). */
  tMax: number;
}

const BUDGET: Record<Quality, number> = { draft: 120_000, normal: 700_000, fine: 2_500_000 };
const B = 8; // block size for culling

export function buildCavityGrid(g: CompiledGroup, quality: Quality): CavityGrid {
  const t = g.t;
  const sb = g.shellBounds;
  const ext = [0, 1, 2].map((a) => sb.max[a] - sb.min[a]);
  // texel size from the budget, then pad around the shells
  let h = Math.cbrt((ext[0] + 2) * (ext[1] + 2) * (ext[2] + 2) / BUDGET[quality]);
  h = Math.max(h, Math.max(...ext) / 400);
  const pad = 2 * h + 0.01;
  const origin: [number, number, number] = [sb.min[0] - pad, sb.min[1] - pad, sb.min[2] - pad];
  const dims = [0, 1, 2].map((a) => Math.max(2, Math.ceil((ext[a] + 2 * pad) / h) + 1)) as [number, number, number];
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  // Depth band covers walls up to ~1.6x the current one, so a thickness slider
  // can move without a rebuild.
  const tMax = 1.6 * t + 2 * h;
  const clampV = tMax + 2 * h;
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const posX = (i: number) => origin[0] + i * h, posY = (j: number) => origin[1] + j * h, posZ = (k: number) => origin[2] + k * h;

  // 1. Shell field on band texels (block culling keeps this cheap).
  const F = new Float32Array(N).fill(NaN);
  const R = (B * h * Math.sqrt(3)) / 2;
  const lo = -clampV, hi = 3 * h;
  for (let bk = 0; bk * B < nz; bk++) for (let bj = 0; bj * B < ny; bj++) for (let bi = 0; bi * B < nx; bi++) {
    const i1 = Math.min(nx, (bi + 1) * B + 1), j1 = Math.min(ny, (bj + 1) * B + 1), k1 = Math.min(nz, (bk + 1) * B + 1);
    const cx = posX((bi * B + i1 - 1) / 2), cy = posY((bj * B + j1 - 1) / 2), cz = posZ((bk * B + k1 - 1) / 2);
    const fc = shapeSDF(g, cx, cy, cz);
    if (fc > hi + R || fc < lo - R) {
      // whole block outside the band: mark with the clamped value (filled later)
      const v = fc > 0 ? -clampV : clampV;
      for (let k = bk * B; k < k1; k++) for (let j = bj * B; j < j1; j++) for (let i = bi * B; i < i1; i++) {
        const q = idx(i, j, k);
        if (Number.isNaN(F[q])) F[q] = fc > 0 ? Infinity : -Infinity;
      }
      void v;
      continue;
    }
    for (let k = bk * B; k < k1; k++) for (let j = bj * B; j < j1; j++) for (let i = bi * B; i < i1; i++) {
      const q = idx(i, j, k);
      if (Number.isNaN(F[q]) || !Number.isFinite(F[q])) F[q] = shapeSDF(g, posX(i), posY(j), posZ(k));
    }
  }

  // 2. Seeds on edges with a sign change, projected onto the surface.
  const sObj: number[] = [];
  const sx: number[] = [], sy: number[] = [], sz: number[] = [], snx: number[] = [], sny: number[] = [], snz: number[] = [];
  const nearest = new Int32Array(N).fill(-1);
  const e = h * 0.05;
  const grad = (x: number, y: number, z: number): [number, number, number] => {
    const gx = shapeSDF(g, x + e, y, z) - shapeSDF(g, x - e, y, z);
    const gy = shapeSDF(g, x, y + e, z) - shapeSDF(g, x, y - e, z);
    const gz = shapeSDF(g, x, y, z + e) - shapeSDF(g, x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  };
  const seedAt = (q0: number, q1: number, x: number, y: number, z: number) => {
    // Newton steps onto the exact surface (one is exact for true distance fields;
    // blended fields aren't, so iterate until the point sits on the surface)
    let n = grad(x, y, z);
    for (let it = 0; it < 4; it++) {
      const f = shapeSDF(g, x, y, z);
      x -= n[0] * f; y -= n[1] * f; z -= n[2] * f;
      n = grad(x, y, z);
      if (Math.abs(f) < 1e-4 * h || g.k <= 0) break;
    }
    // which shell object (or cut, index >= shells.length) this bit of surface belongs to
    let best = 0, bd = Infinity;
    g.shells.forEach((o, i) => { const d = Math.abs(sdfWorld(o, x, y, z)); if (d < bd) { bd = d; best = i; } });
    g.subs.forEach((o, i) => { const d = Math.abs(sdfWorld(o, x, y, z)); if (d < bd) { bd = d; best = g.shells.length + i; } });
    if (best >= g.shells.length) { if (g.subs[best - g.shells.length].obj.mode === 'cutout') return; }
    else if (g.holes.size && isOpening(g.shells[best], x, y, z, n)) return;
    const s = sx.length;
    sObj.push(best);
    sx.push(x); sy.push(y); sz.push(z); snx.push(n[0]); sny.push(n[1]); snz.push(n[2]);
    for (const q of [q0, q1]) {
      const cur = nearest[q];
      if (cur < 0 || dist2(q, s) < dist2(q, cur)) nearest[q] = s;
    }
  };
  // Is this surface point (unit normal n) part of an opening of object o? Without a
  // blend the surface is the objects' own, and the nearest face decides. A blend
  // shifts the surface off the objects and rounds their edges, so the nearest face
  // is ambiguous at a rim; there a point also belongs to an open planar face when it
  // faces the same way, lies near that face's plane, and is over the face.
  const slack = h + g.k / 4;
  const isOpening = (o: CompiledObject, x: number, y: number, z: number, n: number[]) => {
    const id = o.obj.id;
    const near = faceAtWorld(o, x, y, z);
    if (g.k <= 0) return g.holes.has(`${id}|${near}`);
    for (const f of o.faces) {
      if (!g.holes.has(`${id}|${f.id}`)) continue;
      if (!f.plane) { if (f.id === near) return true; continue; }
      const wn = normalToWorld(o, ...f.plane.n);
      const wp: [number, number, number] = [0, 0, 0];
      toWorld(o, f.plane.p[0], f.plane.p[1], f.plane.p[2], wp);
      const off = (x - wp[0]) * wn[0] + (y - wp[1]) * wn[1] + (z - wp[2]) * wn[2];
      // ...and, slid onto the face's plane, lands on the face itself: a gently
      // sloping surface next to an opening (a pot's shoulder below its open top)
      // faces the same way and lies near the plane too, but beyond the face
      if (n[0] * wn[0] + n[1] * wn[1] + n[2] * wn[2] > 0.7 && Math.abs(off) < slack
        && faceAtWorld(o, x - wn[0] * off, y - wn[1] * off, z - wn[2] * off) === f.id) return true;
    }
    return false;
  };
  const qx = (q: number) => posX(q % nx), qy = (q: number) => posY(Math.floor(q / nx) % ny), qz = (q: number) => posZ(Math.floor(q / (nx * ny)));
  const dist2 = (q: number, s: number) => {
    const dx = qx(q) - sx[s], dy = qy(q) - sy[s], dz = qz(q) - sz[s];
    return dx * dx + dy * dy + dz * dz;
  };
  const band: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = idx(i, j, k);
    const fa = F[q];
    if (!Number.isFinite(fa)) continue;
    if (fa >= lo - h && fa <= hi + h) band.push(q);
    const nb = [i + 1 < nx ? idx(i + 1, j, k) : -1, j + 1 < ny ? idx(i, j + 1, k) : -1, k + 1 < nz ? idx(i, j, k + 1) : -1];
    for (let a = 0; a < 3; a++) {
      const r = nb[a];
      if (r < 0) continue;
      const fb = F[r];
      if (!Number.isFinite(fb) || (fa < 0) === (fb < 0)) continue;
      const u = fa / (fa - fb);
      seedAt(q, r, posX(i + (a === 0 ? u : 0)), posY(j + (a === 1 ? u : 0)), posZ(k + (a === 2 ? u : 0)));
    }
  }

  // 3. Propagate nearest seeds through the band (alternating sweep order).
  const offs = [1, -1, nx, -nx, nx * ny, -nx * ny];
  for (let iter = 0; iter < 80; iter++) {
    let changed = 0;
    const fwd = iter % 2 === 0;
    for (let b = 0; b < band.length; b++) {
      const q = band[fwd ? b : band.length - 1 - b];
      let cur = nearest[q];
      let cd = cur >= 0 ? dist2(q, cur) : Infinity;
      for (const o of offs) {
        const r = q + o;
        if (r < 0 || r >= N) continue;
        const s = nearest[r];
        if (s < 0 || s === cur) continue;
        const d = dist2(q, s);
        if (d < cd) { cd = d; cur = s; changed++; }
      }
      nearest[q] = cur;
    }
    if (!changed) break;
  }

  // 4. Signed depth. Outside texels near an opening keep a positive value, so the
  //    interpolated cavity never grows a skin across the opening.
  const rho = 0.75 * h;
  const top = { i: -1, gap: 0 };
  const data = new Float32Array(N);
  for (let q = 0; q < N; q++) {
    const f = F[q];
    // Far from the surface: a correction big enough that A + C lands beyond ±clampV
    // whatever A is (A itself is clamped to ±clampV).
    if (!Number.isFinite(f) || Number.isNaN(f)) { data[q] = f < 0 ? 2 * clampV : -2 * clampV; continue; }
    const s = nearest[q];
    let d = clampV;
    if (s >= 0) {
      const vx = qx(q) - sx[s], vy = qy(q) - sy[s], vz = qz(q) - sz[s];
      const vn = vx * snx[s] + vy * sny[s] + vz * snz[s];
      const lx = vx - vn * snx[s], ly = vy - vn * sny[s], lz = vz - vn * snz[s];
      const lat = Math.hypot(lx, ly, lz);
      // The seed stands for a small tangent disc of its surface. Next to a joint
      // the disc must not reach into the part of the surface buried inside another
      // shell object or carved away by a cut (nor, for a cut's seed, out of the
      // shells), or the wall gets pulled in along the joint.
      let r = rho;
      if (lat > 1e-9 && g.shells.length + g.subs.length > 1) {
        const k = Math.min(lat, rho) / lat;
        const fx = sx[s] + lx * k, fy = sy[s] + ly * k, fz = sz[s] + lz * k;
        if (sObj[s] >= g.shells.length) {
          if (shellSDF(g, fx, fy, fz) > 0.02 * h) r = 0;
        } else {
          for (let oi = 0; oi < g.shells.length; oi++) {
            if (oi === sObj[s]) continue;
            if (sdfWorld(g.shells[oi], fx, fy, fz) < -0.02 * h) { r = 0; break; }
          }
        }
        if (r > 0) for (let oi = 0; oi < g.subs.length; oi++) {
          if (g.shells.length + oi === sObj[s]) continue;
          if (sdfWorld(g.subs[oi], fx, fy, fz) < -0.02 * h) { r = 0; break; }
        }
      }
      d = Math.min(clampV, Math.hypot(vn, Math.max(0, lat - r)));
    }
    const D = f <= 0 ? d : d > f + 0.5 * h ? d : -Math.min(f, clampV);
    // store the correction to the analytic depth (see scene.baseDepth)
    const A = baseDepth(g, qx(q), qy(q), qz(q), clampV, h, top);
    // Where the nearest surface is the deepest object's own, clear of any other
    // (beyond the smoothing radius), the analytic depth is exact: no correction.
    // The seeds' small discs would only add noise there (they reach a little past
    // the edge of an opening), which shows as a wavy rim where a shallow shoulder
    // meets the opening.
    data[q] = s >= 0 && sObj[s] === top.i && top.gap > Math.max(2 * h, g.k) + h ? 0 : D - A;
  }
  return { groupIndex: g.index, origin, h, dims, data, clampV, tMax };
}

/** Trilinear sample of a cavity grid (texel centres at origin + i*h). */
export function sampleCavity(c: CavityGrid, x: number, y: number, z: number): number {
  const fx = (x - c.origin[0]) / c.h, fy = (y - c.origin[1]) / c.h, fz = (z - c.origin[2]) / c.h;
  const [nx, ny, nz] = c.dims;
  if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return -2 * c.clampV;
  const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), k = Math.min(nz - 2, Math.floor(fz));
  const u = fx - i, v = fy - j, w = fz - k;
  const D = c.data;
  const q = i + nx * (j + ny * k);
  const sxy = nx * ny;
  const c00 = D[q] * (1 - u) + D[q + 1] * u;
  const c10 = D[q + nx] * (1 - u) + D[q + nx + 1] * u;
  const c01 = D[q + sxy] * (1 - u) + D[q + sxy + 1] * u;
  const c11 = D[q + sxy + nx] * (1 - u) + D[q + sxy + nx + 1] * u;
  return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
}

/** Cavity depth at a point: analytic base depth plus the grid's correction. */
export function cavityDepth(c: CavityGrid, g: CompiledGroup, x: number, y: number, z: number): number {
  const d = baseDepth(g, x, y, z, c.clampV, c.h) + sampleCavity(c, x, y, z);
  return Math.max(-c.clampV, Math.min(c.clampV, d));
}
