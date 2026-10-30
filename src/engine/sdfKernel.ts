// Kernel A — signed distance fields, meshed.
//
// The app displays the SDF kernel by raymarching the field directly on the GPU
// (no triangles). This mesher turns the very same field into triangles for
// measurement (benchmarks: open/non-manifold edges) and later for export.
//
// Field: scene.ts (groups, roles, cavity). Cavity depth: cavity.ts.
// Meshing: sparse 8^3 blocks (skipped only when the surface provably cannot pass
// through them), dual contouring with a QEF per cell to keep sharp edges.

import { buildCavityGrid, type CavityGrid, cavityDepth } from './cavity';
import type { Quality, SceneDoc } from './document';
import { type BuildResult, Timer } from './kernel';
import type { Vec3 } from './math';
import { edgeStats } from './meshCheck';
import { type CompiledGroup, approxDepth, compileGroups, evalScene, needsCavityGrid, sceneBounds } from './scene';

const B = 8;
const B1 = B + 1;
/** Thinnest wall, in grid cells, that meshes without tearing. */
const MIN_WALL_CELLS = 2.4;
const QUALITY_CELLS: Record<Quality, number> = { draft: 70, normal: 140, fine: 220 };
const QUALITY_BUDGET: Record<Quality, number> = { draft: 800_000, normal: 4_000_000, fine: 12_000_000 };

interface Block { bi: number; bj: number; bk: number; values: Float32Array; vidx: Int32Array }

export function cavityGrids(groups: CompiledGroup[], quality: Quality): (CavityGrid | null)[] {
  return groups.map((g) => (needsCavityGrid(g) ? buildCavityGrid(g, quality) : null));
}

export function depthFromGrids(grids: (CavityGrid | null)[]) {
  return (g: CompiledGroup, x: number, y: number, z: number) => {
    const c = grids[g.index];
    // no grid: the analytic depth is exact for this group (see needsCavityGrid)
    return c ? cavityDepth(c, g, x, y, z) : g.hollow ? approxDepth(g, x, y, z) : -Infinity;
  };
}

export function buildSDF(doc: SceneDoc, quality: Quality, grids?: (CavityGrid | null)[]): BuildResult {
  const timer = new Timer();
  const warnings: string[] = [];
  const groups = compileGroups(doc);
  const stats = (positions: Float32Array, indices: Uint32Array, h = 0, cells = 0): BuildResult => {
    const es = edgeStats(indices, positions.length / 3);
    return {
      positions, indices,
      stats: {
        kernel: 'sdf', triangles: indices.length / 3, vertices: positions.length / 3, boundaryEdges: es.boundary,
        nonManifoldEdges: es.nonManifold, cellSize: h || undefined, activeCells: cells, warnings, timings: timer.timings, totalMs: timer.total(),
      },
    };
  };
  if (!groups.length) return stats(new Float32Array(0), new Uint32Array(0));

  const bounds = sceneBounds(groups);
  const size = Math.max(...[0, 1, 2].map((a) => bounds.max[a] - bounds.min[a]));
  let h = size / QUALITY_CELLS[quality];
  for (const g of groups) if (g.hollow) h = Math.min(h, g.t / 2.5);
  h = Math.max(h, size / 2000);

  // cavity depth grids (exact wall), computed once
  const gridIndex: (CavityGrid | null)[] = [];
  const cg = grids ?? cavityGrids(groups, quality === 'draft' ? 'draft' : quality);
  groups.forEach((g, i) => { gridIndex[g.index] = cg[i] ?? null; });
  const depth = depthFromGrids(gridIndex);
  timer.lap('cavity');

  // Block activation; coarsen if over budget, and never let a wall drop under
  // MIN_WALL_CELLS (it would tear): draw the thinnest clean wall and say so.
  const KB = 4096;
  const bkey = (bi: number, bj: number, bk: number) => bi + KB * (bj + KB * bk);
  let blocks = new Map<number, Block>();
  let origin: Vec3 = [0, 0, 0];
  for (let attempt = 0; ; attempt++) {
    const pad = 3 * h;
    const jit = h * 0.3183; // keeps flat faces off grid planes
    origin = [bounds.min[0] - pad - jit, bounds.min[1] - pad - jit * 1.17, bounds.min[2] - pad - jit * 0.71];
    const dims = [0, 1, 2].map((a) => Math.ceil((bounds.max[a] - bounds.min[a] + 2 * pad) / h / B));
    blocks = new Map();
    const R = ((B * h * Math.sqrt(3)) / 2) * 1.15;
    for (let bk = 0; bk < dims[2]; bk++) for (let bj = 0; bj < dims[1]; bj++) for (let bi = 0; bi < dims[0]; bi++) {
      const cx = origin[0] + (bi + 0.5) * B * h, cy = origin[1] + (bj + 0.5) * B * h, cz = origin[2] + (bk + 0.5) * B * h;
      const s = evalScene(groups, depth, cx, cy, cz, 2 * R);
      if (Math.abs(s) <= R) {
        blocks.set(bkey(bi, bj, bk), { bi, bj, bk, values: new Float32Array(B1 * B1 * B1), vidx: new Int32Array(B * B * B).fill(-1) });
      }
    }
    const cells = blocks.size * B * B * B;
    if (cells > QUALITY_BUDGET[quality] && attempt < 6) {
      h *= Math.sqrt(cells / QUALITY_BUDGET[quality]) * 1.03;
      continue;
    }
    break;
  }
  const thin = groups.filter((g) => g.hollow && g.t < MIN_WALL_CELLS * h);
  if (thin.length) {
    for (const g of thin) {
      warnings.push(`Mesh wall for ${g.name} drawn at ${(MIN_WALL_CELLS * h).toFixed(2)} cm, not ${g.t.toFixed(2)} cm (grid too coarse at this size).`);
      g.t = MIN_WALL_CELLS * h;
    }
  }
  timer.lap('activate');
  const blockList = [...blocks.values()];
  const S = (x: number, y: number, z: number) => evalScene(groups, depth, x, y, z);

  for (const b of blockList) {
    const ox = origin[0] + b.bi * B * h, oy = origin[1] + b.bj * B * h, oz = origin[2] + b.bk * B * h;
    let q = 0;
    for (let k = 0; k <= B; k++) for (let j = 0; j <= B; j++) for (let i = 0; i <= B; i++) b.values[q++] = S(ox + i * h, oy + j * h, oz + k * h);
  }
  // shared corners: copy from the owning block so both sides agree on the sign
  for (const b of blockList) {
    for (let k = 0; k <= B; k++) for (let j = 0; j <= B; j++) for (let i = 0; i <= B; i++) {
      if (i < B && j < B && k < B) continue;
      const gi = b.bi * B + i, gj = b.bj * B + j, gk = b.bk * B + k;
      const ob = blocks.get(bkey(Math.floor(gi / B), Math.floor(gj / B), Math.floor(gk / B)));
      if (ob && ob !== b) b.values[i + B1 * (j + B1 * k)] = ob.values[(gi - ob.bi * B) + B1 * ((gj - ob.bj * B) + B1 * (gk - ob.bk * B))];
    }
  }
  timer.lap('sample');

  // Dual contouring
  const verts: number[] = [];
  const EDGES: [number, number][] = [];
  const corner = (c: number): [number, number, number] => [c & 1, (c >> 1) & 1, (c >> 2) & 1];
  for (let a = 0; a < 8; a++) for (let bb = a + 1; bb < 8; bb++) {
    const ca = corner(a), cb = corner(bb);
    if (Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2]) === 1) EDGES.push([a, bb]);
  }
  const e = h * 0.05;
  const cv = new Float64Array(8);
  const P: number[] = [], Nn: number[] = [];
  for (const b of blockList) {
    const ox = origin[0] + b.bi * B * h, oy = origin[1] + b.bj * B * h, oz = origin[2] + b.bk * B * h;
    const V = b.values;
    for (let k = 0; k < B; k++) for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) {
        const v = V[(i + (c & 1)) + B1 * ((j + ((c >> 1) & 1)) + B1 * (k + ((c >> 2) & 1)))];
        cv[c] = v;
        if (v < 0) mask |= 1 << c;
      }
      if (mask === 0 || mask === 255) continue;
      P.length = 0; Nn.length = 0;
      let mx = 0, my = 0, mz = 0;
      for (const [ea, eb] of EDGES) {
        const va = cv[ea], vb = cv[eb];
        if ((va < 0) === (vb < 0)) continue;
        const s = va / (va - vb);
        const ca = corner(ea), cb = corner(eb);
        const x = ox + (i + ca[0] + (cb[0] - ca[0]) * s) * h;
        const y = oy + (j + ca[1] + (cb[1] - ca[1]) * s) * h;
        const z = oz + (k + ca[2] + (cb[2] - ca[2]) * s) * h;
        let gx = S(x + e, y, z) - S(x - e, y, z), gy = S(x, y + e, z) - S(x, y - e, z), gz = S(x, y, z + e) - S(x, y, z - e);
        const l = Math.hypot(gx, gy, gz) || 1;
        gx /= l; gy /= l; gz /= l;
        P.push(x, y, z); Nn.push(gx, gy, gz);
        mx += x; my += y; mz += z;
      }
      const m = P.length / 3;
      mx /= m; my /= m; mz /= m;
      let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (let q = 0; q < m; q++) {
        const ux = Nn[3 * q], uy = Nn[3 * q + 1], uz = Nn[3 * q + 2];
        const dd = ux * (P[3 * q] - mx) + uy * (P[3 * q + 1] - my) + uz * (P[3 * q + 2] - mz);
        a00 += ux * ux; a01 += ux * uy; a02 += ux * uz; a11 += uy * uy; a12 += uy * uz; a22 += uz * uz;
        b0 += ux * dd; b1 += uy * dd; b2 += uz * dd;
      }
      const lam = 0.05 * m;
      a00 += lam; a11 += lam; a22 += lam;
      const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
      const det = a00 * c00 + a01 * c01 + a02 * c02;
      let vx = mx, vy = my, vz = mz;
      if (Math.abs(det) > 1e-12) {
        const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
        vx = mx + (c00 * b0 + c01 * b1 + c02 * b2) / det;
        vy = my + (c01 * b0 + c11 * b1 + c12 * b2) / det;
        vz = mz + (c02 * b0 + c12 * b1 + c22 * b2) / det;
      }
      const x0 = ox + i * h, y0 = oy + j * h, z0 = oz + k * h, ex = 0.5 * h;
      if (vx < x0 - ex || vx > x0 + h + ex || vy < y0 - ex || vy > y0 + h + ex || vz < z0 - ex || vz > z0 + h + ex) {
        vx = mx; vy = my; vz = mz;
      }
      b.vidx[i + B * (j + B * k)] = verts.length / 3;
      verts.push(vx, vy, vz);
    }
  }
  timer.lap('vertices');

  const tris: number[] = [];
  let missing = 0;
  const cellVert = (gi: number, gj: number, gk: number): number => {
    const bi = Math.floor(gi / B), bj = Math.floor(gj / B), bk = Math.floor(gk / B);
    const blk = blocks.get(bkey(bi, bj, bk));
    return blk ? blk.vidx[(gi - bi * B) + B * ((gj - bj * B) + B * (gk - bk * B))] : -1;
  };
  const d2 = (u: number, w: number) => {
    const dx = verts[3 * u] - verts[3 * w], dy = verts[3 * u + 1] - verts[3 * w + 1], dz = verts[3 * u + 2] - verts[3 * w + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  const quad = (q0: number, q1: number, q2: number, q3: number, flip: boolean) => {
    if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) { missing++; return; }
    if (flip) { const t = q1; q1 = q3; q3 = t; }
    if (d2(q0, q2) <= d2(q1, q3)) tris.push(q0, q1, q2, q0, q2, q3);
    else tris.push(q0, q1, q3, q1, q2, q3);
  };
  for (const b of blockList) {
    const V = b.values;
    const gi0 = b.bi * B, gj0 = b.bj * B, gk0 = b.bk * B;
    for (let k = 0; k < B; k++) for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      const inside = V[i + B1 * (j + B1 * k)] < 0;
      const gi = gi0 + i, gj = gj0 + j, gk = gk0 + k;
      if ((V[i + 1 + B1 * (j + B1 * k)] < 0) !== inside) quad(cellVert(gi, gj - 1, gk - 1), cellVert(gi, gj, gk - 1), cellVert(gi, gj, gk), cellVert(gi, gj - 1, gk), !inside);
      if ((V[i + B1 * (j + 1 + B1 * k)] < 0) !== inside) quad(cellVert(gi - 1, gj, gk - 1), cellVert(gi - 1, gj, gk), cellVert(gi, gj, gk), cellVert(gi, gj, gk - 1), !inside);
      if ((V[i + B1 * (j + B1 * (k + 1))] < 0) !== inside) quad(cellVert(gi - 1, gj - 1, gk), cellVert(gi, gj - 1, gk), cellVert(gi, gj, gk), cellVert(gi - 1, gj, gk), !inside);
    }
  }
  timer.lap('faces');
  if (missing) warnings.push(`${missing} quads skipped at block borders`);
  return stats(new Float32Array(verts), new Uint32Array(tris), h, blockList.length * B * B * B);
}
