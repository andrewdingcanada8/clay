// Kernel A — signed distance fields.
//
// Pipeline (all values are continuous signed distances, never inside/outside bits):
//   1. F_join(p) = max(min(join SDFs), -min(cut SDFs)), F_solid(p) = min(solid SDFs).
//   2. Sparse grid: 8^3-cell blocks; a block is skipped only when the surface
//      provably cannot pass through it (conservative SDF bound vs block radius).
//   3. Exact inner distance: zero crossings of F_join on grid edges become surface
//      seeds (crossings on hole faces are dropped); d(p) = distance to nearest seed.
//   4. S(p) = max(min(max(F_join, d - t), F_solid), -pins)  — wall = within t of a
//      non-hole surface, inside the form. Too-thin regions simply stay solid.
//   5. Dual contouring with a QEF per cell (sharp edges), quads -> triangles.

import type { Quality, SceneDoc } from './document';
import { type BuildResult, Timer } from './kernel';
import { type AABB, type Vec3, emptyAABB, growAABB } from './math';
import { edgeStats } from './meshCheck';
import { type CompiledObject, classifyPoint, compileScene, normalToWorld, sdfWorld, toWorld } from './primitives';

const B = 8; // cells per block edge
const B1 = B + 1;

interface Pin {
  ax: number; ay: number; az: number; // outside end
  bx: number; by: number; bz: number; // inside end
  r: number;
}

interface Block {
  bi: number; bj: number; bk: number;
  values: Float32Array; // (B+1)^3 corner samples of S
  fjoin: Float32Array; // (B+1)^3 corner samples of F_join (for seeds)
  vidx: Int32Array; // B^3 vertex index per cell (-1 = none)
  joins: CompiledObject[];
  cuts: CompiledObject[];
  solids: CompiledObject[];
  pins: Pin[];
  nearest?: Int32Array; // (B+1)^3 nearest-seed index per corner
}

const QUALITY_CELLS: Record<Quality, number> = { draft: 56, normal: 120, fine: 200 };
const QUALITY_WALL_CELLS: Record<Quality, number> = { draft: 2, normal: 2.5, fine: 3.5 };
const QUALITY_BUDGET: Record<Quality, number> = { draft: 600_000, normal: 4_000_000, fine: 12_000_000 };

function aabbDist(b: AABB, x: number, y: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.hypot(dx, dy, dz);
}

function pinSDF(p: Pin, x: number, y: number, z: number): number {
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

export function buildSDF(doc: SceneDoc, quality: Quality): BuildResult {
  const timer = new Timer();
  const tune = globalThis as { __dcExpand?: number; __dcLambda?: number };
  const DC_EXPAND = tune.__dcExpand ?? 0.5;
  const DC_LAMBDA = tune.__dcLambda ?? 0.05;
  const warnings: string[] = [];
  const objs = compileScene(doc.objects);
  const joins = objs.filter((o) => o.obj.mode === 'join');
  const cuts = objs.filter((o) => o.obj.mode === 'cut');
  const solids = objs.filter((o) => o.obj.mode === 'solid');
  const shell = doc.shell.enabled;
  const t = Math.max(0.01, doc.shell.thickness);
  const exact = doc.sdfExactDistance;

  const empty = (): BuildResult => ({
    positions: new Float32Array(0), indices: new Uint32Array(0),
    stats: { kernel: 'sdf', triangles: 0, vertices: 0, boundaryEdges: 0, nonManifoldEdges: 0, warnings, timings: timer.timings, totalMs: timer.total() },
  });
  if (joins.length + solids.length === 0) return empty();

  // Pins: capped cylinders through the wall, placed in their object's frame.
  const byId = new Map(objs.map((o) => [o.obj.id, o]));
  const pins: Pin[] = [];
  for (const pin of doc.pins) {
    const o = byId.get(pin.objectId);
    if (!o) continue;
    const c: Vec3 = [0, 0, 0];
    toWorld(o, pin.point[0], pin.point[1], pin.point[2], c);
    const n = normalToWorld(o, pin.normal[0], pin.normal[1], pin.normal[2]);
    const out = Math.max(0.5, pin.radius);
    const depth = (shell ? t : pin.radius * 4) * 1.6 + 0.05;
    pins.push({
      ax: c[0] + n[0] * out, ay: c[1] + n[1] * out, az: c[2] + n[2] * out,
      bx: c[0] - n[0] * depth, by: c[1] - n[1] * depth, bz: c[2] - n[2] * depth,
      r: pin.radius,
    });
  }

  // Bounds and resolution
  const bounds = emptyAABB();
  for (const o of [...joins, ...solids]) {
    growAABB(bounds, o.worldBounds.min[0], o.worldBounds.min[1], o.worldBounds.min[2]);
    growAABB(bounds, o.worldBounds.max[0], o.worldBounds.max[1], o.worldBounds.max[2]);
  }
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  let h = size / QUALITY_CELLS[quality];
  if (shell) h = Math.min(h, t / QUALITY_WALL_CELLS[quality]);
  h = Math.max(h, size / 2000);

  const margin = () => 2 * h;
  let blocks: Map<number, Block>;
  let dims: [number, number, number];
  let origin: Vec3;
  const KB = 2048;
  const bkey = (bi: number, bj: number, bk: number) => bi + KB * (bj + KB * bk);

  // Block activation; coarsen h if over the cell budget.
  const signOf = new Map<number, number>(); // inactive block sign (default +1)
  for (let attempt = 0; ; attempt++) {
    const pad = 3 * h;
    // Irrational sub-cell offset: keeps axis-aligned faces off the grid planes, where
    // exact zeros would collapse dual-contouring vertices onto each other.
    const jit = h * 0.3183;
    origin = [bounds.min[0] - pad - jit, bounds.min[1] - pad - jit * 1.17, bounds.min[2] - pad - jit * 0.71];
    dims = [0, 1, 2].map((a) => Math.ceil((bounds.max[a] - bounds.min[a] + 2 * pad) / h / B)) as [number, number, number];
    blocks = new Map();
    signOf.clear();
    const R = (B * h * Math.sqrt(3)) / 2;
    const near = R + (shell ? t : 0) + 3 * h;
    for (let bk = 0; bk < dims[2]; bk++) {
      for (let bj = 0; bj < dims[1]; bj++) {
        for (let bi = 0; bi < dims[0]; bi++) {
          const cx = origin[0] + (bi + 0.5) * B * h, cy = origin[1] + (bj + 0.5) * B * h, cz = origin[2] + (bk + 0.5) * B * h;
          const bj_ = joins.filter((o) => aabbDist(o.worldBounds, cx, cy, cz) <= near);
          const bc_ = cuts.filter((o) => aabbDist(o.worldBounds, cx, cy, cz) <= near);
          const bs_ = solids.filter((o) => aabbDist(o.worldBounds, cx, cy, cz) <= near);
          const bp_ = pins.filter((p) => pinSDF(p, cx, cy, cz) <= R);
          let f = Infinity;
          for (const o of bj_) f = Math.min(f, sdfWorld(o, cx, cy, cz));
          for (const o of bc_) f = Math.max(f, -sdfWorld(o, cx, cy, cz));
          let fs = Infinity;
          for (const o of bs_) fs = Math.min(fs, sdfWorld(o, cx, cy, cz));
          const joinActive = shell ? f <= R && f >= -(t + R + margin()) : Math.abs(f) <= R;
          const solidActive = Math.abs(fs) <= R;
          const pinActive = bp_.length > 0 && (f <= R || fs <= R);
          const key = bkey(bi, bj, bk);
          if (joinActive || solidActive || pinActive) {
            blocks.set(key, {
              bi, bj, bk, values: new Float32Array(B1 * B1 * B1), fjoin: new Float32Array(B1 * B1 * B1),
              vidx: new Int32Array(B * B * B).fill(-1), joins: bj_, cuts: bc_, solids: bs_, pins: bp_,
            });
          } else {
            // Constant sign: inside a solid add (and not drilled) or inside an unshelled form.
            const inPin = pins.some((p) => pinSDF(p, cx, cy, cz) < -R);
            const filled = fs < -R || (!shell && f < -R);
            if (filled && !inPin) signOf.set(key, -1);
          }
        }
      }
    }
    const cells = blocks.size * B * B * B;
    if (cells <= QUALITY_BUDGET[quality] || attempt >= 6) break;
    h *= Math.cbrt(cells / QUALITY_BUDGET[quality]) * 1.05;
  }
  if (shell && t < 2 * h) {
    warnings.push(`Wall ${t.toFixed(2)} cm is under 2 cells (cell ${h.toFixed(3)} cm): raise quality or thicken the wall.`);
  }
  timer.lap('activate');

  const blockList = [...blocks!.values()];

  // Pass 1: F_join at every corner of active blocks.
  for (const b of blockList) {
    const ox = origin![0] + b.bi * B * h, oy = origin![1] + b.bj * B * h, oz = origin![2] + b.bk * B * h;
    let idx = 0;
    for (let k = 0; k <= B; k++) {
      const z = oz + k * h;
      for (let j = 0; j <= B; j++) {
        const y = oy + j * h;
        for (let i = 0; i <= B; i++) {
          const x = ox + i * h;
          let f = Infinity;
          for (const o of b.joins) { const d = sdfWorld(o, x, y, z); if (d < f) f = d; }
          for (const o of b.cuts) { const d = -sdfWorld(o, x, y, z); if (d > f) f = d; }
          b.fjoin[idx++] = f;
        }
      }
    }
  }
  timer.lap('sampleF');

  // Seeds: zero crossings of F_join, minus those on hole faces.
  const holeSet = new Set<string>();
  for (const o of joins) for (const f of o.obj.holes) holeSet.add(`${o.obj.id}|${f}`);
  const seedArr: number[] = [];
  const seedEdgeArr: number[] = [];
  const seedNrmArr: number[] = [];
  let droppedSeeds = 0;
  if (shell && exact) {
    const classifyObjs = [...joins, ...cuts];
    for (const b of blockList) {
      const ox = origin![0] + b.bi * B * h, oy = origin![1] + b.bj * B * h, oz = origin![2] + b.bk * B * h;
      const F = b.fjoin;
      for (let k = 0; k <= B; k++) {
        for (let j = 0; j <= B; j++) {
          for (let i = 0; i <= B; i++) {
            const a = i + B1 * (j + B1 * k);
            const fa = F[a];
            for (let ax = 0; ax < 3; ax++) {
              if ((ax === 0 && i === B) || (ax === 1 && j === B) || (ax === 2 && k === B)) continue;
              const bIdx = a + (ax === 0 ? 1 : ax === 1 ? B1 : B1 * B1);
              const fb = F[bIdx];
              if ((fa < 0) === (fb < 0)) continue;
              const s = fa / (fa - fb);
              const x = ox + (i + (ax === 0 ? s : 0)) * h;
              const y = oy + (j + (ax === 1 ? s : 0)) * h;
              const z = oz + (k + (ax === 2 ? s : 0)) * h;
              if (holeSet.size) {
                const c = classifyPoint(classifyObjs, x, y, z, ['join', 'cut']);
                if (c && c.obj.obj.mode === 'join' && holeSet.has(`${c.obj.obj.id}|${c.face}`)) { droppedSeeds++; continue; }
              }
              seedArr.push(x, y, z);
              // outward surface normal at the seed (central differences of F_join)
              const e = h * 0.1;
              const fj = (qx: number, qy: number, qz: number) => {
                let f = Infinity;
                for (const o of b.joins) { const d = sdfWorld(o, qx, qy, qz); if (d < f) f = d; }
                for (const o of b.cuts) { const d = -sdfWorld(o, qx, qy, qz); if (d > f) f = d; }
                return f;
              };
              let gx = fj(x + e, y, z) - fj(x - e, y, z), gy = fj(x, y + e, z) - fj(x, y - e, z), gz = fj(x, y, z + e) - fj(x, y, z - e);
              const gl = Math.hypot(gx, gy, gz) || 1;
              gx /= gl; gy /= gl; gz /= gl;
              seedNrmArr.push(gx, gy, gz);
              seedEdgeArr.push(b.bi * B + i, b.bj * B + j, b.bk * B + k, ax);
            }
          }
        }
      }
    }
  }
  const seeds = new Float64Array(seedArr);
  const nSeeds = seeds.length / 3;
  const seedEdge = new Int32Array(seedEdgeArr);
  const seedNrm = new Float64Array(seedNrmArr);
  timer.lap('seeds');

  // Closest-seed propagation over band corners (a vector distance transform):
  // each corner keeps the index of its nearest seed; neighbours exchange
  // candidates until nothing changes. ~7 distance checks per corner per sweep.
  const qR = t + 2 * h;
  const cornerIndex = (gi: number, gj: number, gk: number): [Block | undefined, number] => {
    const bi = Math.floor(gi / B), bj = Math.floor(gj / B), bk = Math.floor(gk / B);
    const blk = blocks!.get(bkey(bi, bj, bk));
    return [blk, (gi - bi * B) + B1 * ((gj - bj * B) + B1 * (gk - bk * B))];
  };
  if (shell && exact && nSeeds) {
    for (const b of blockList) b.nearest = new Int32Array(B1 * B1 * B1).fill(-1);
    const offer = (b: Block, idx: number, s: number, x: number, y: number, z: number): boolean => {
      const cur = b.nearest![idx];
      if (cur === s) return false;
      const dx = seeds[3 * s] - x, dy = seeds[3 * s + 1] - y, dz = seeds[3 * s + 2] - z;
      const dn = dx * dx + dy * dy + dz * dz;
      if (dn > qR * qR) return false;
      if (cur >= 0) {
        const ex = seeds[3 * cur] - x, ey = seeds[3 * cur + 1] - y, ez = seeds[3 * cur + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= dn) return false;
      }
      b.nearest![idx] = s;
      return true;
    };
    // initialise the two corners of every seed's edge
    for (let s = 0; s < nSeeds; s++) {
      const gi = seedEdge[4 * s], gj = seedEdge[4 * s + 1], gk = seedEdge[4 * s + 2], ax = seedEdge[4 * s + 3];
      for (let e = 0; e < 2; e++) {
        const ci = gi + (e && ax === 0 ? 1 : 0), cj = gj + (e && ax === 1 ? 1 : 0), ck = gk + (e && ax === 2 ? 1 : 0);
        const [blk, idx] = cornerIndex(ci, cj, ck);
        if (blk) offer(blk, idx, s, origin![0] + ci * h, origin![1] + cj * h, origin![2] + ck * h);
      }
    }
    const lo = -(t + margin()) - h, hi = margin() + h;
    for (let iter = 0; iter < 64; iter++) {
      let changed = 0;
      const fwd = iter % 2 === 0;
      for (let bn = 0; bn < blockList.length; bn++) {
        const b = blockList[fwd ? bn : blockList.length - 1 - bn];
        const N = b.nearest!;
        const F = b.fjoin;
        const gi0 = b.bi * B, gj0 = b.bj * B, gk0 = b.bk * B;
        for (let kk = 0; kk <= B; kk++) for (let jj = 0; jj <= B; jj++) for (let ii = 0; ii <= B; ii++) {
          const i = fwd ? ii : B - ii, j = fwd ? jj : B - jj, k = fwd ? kk : B - kk;
          const idx = i + B1 * (j + B1 * k);
          const f = F[idx];
          if (f < lo || f > hi) continue;
          const x = origin![0] + (gi0 + i) * h, y = origin![1] + (gj0 + j) * h, z = origin![2] + (gk0 + k) * h;
          for (let nb = 0; nb < 6; nb++) {
            const di = nb === 0 ? -1 : nb === 1 ? 1 : 0, dj = nb === 2 ? -1 : nb === 3 ? 1 : 0, dk = nb === 4 ? -1 : nb === 5 ? 1 : 0;
            const ni = i + di, nj = j + dj, nk = k + dk;
            let s: number;
            if (ni >= 0 && ni <= B && nj >= 0 && nj <= B && nk >= 0 && nk <= B) s = N[ni + B1 * (nj + B1 * nk)];
            else {
              const [blk, nidx] = cornerIndex(gi0 + ni, gj0 + nj, gk0 + nk);
              s = blk ? blk.nearest![nidx] : -1;
            }
            if (s >= 0 && offer(b, idx, s, x, y, z)) changed++;
          }
        }
      }
      if (!changed) break;
    }
  }
  timer.lap('propagate');

  // Distance to the nearest seed among a candidate set (the current cell's corners).
  let lastSeed = -1;
  const cand = new Int32Array(8);
  let candN = 0;
  const setCellCandidates = (b: Block, i: number, j: number, k: number) => {
    candN = 0;
    if (!b.nearest) return;
    for (let c = 0; c < 8; c++) {
      const s = b.nearest[(i + (c & 1)) + B1 * ((j + ((c >> 1) & 1)) + B1 * (k + ((c >> 2) & 1)))];
      if (s >= 0) cand[candN++] = s;
    }
  };
  // Each seed stands for a small tangent disc of the surface (radius rho), so the
  // inner offset of a smooth surface is smooth rather than scalloped between seeds.
  const rho = 0.75 * h;
  let qx = 0, qy = 0, qz = 0; // closest point on the winning disc (for gradients)
  const seedDist = (x: number, y: number, z: number): number => {
    let best = qR;
    lastSeed = -1;
    for (let q = 0; q < candN; q++) {
      const s = cand[q];
      const sx = seeds[3 * s], sy = seeds[3 * s + 1], sz = seeds[3 * s + 2];
      const nx = seedNrm[3 * s], ny = seedNrm[3 * s + 1], nz = seedNrm[3 * s + 2];
      const vx = x - sx, vy = y - sy, vz = z - sz;
      const vn = vx * nx + vy * ny + vz * nz;
      let lx = vx - vn * nx, ly = vy - vn * ny, lz = vz - vn * nz;
      const lat = Math.hypot(lx, ly, lz);
      const ex = Math.max(0, lat - rho);
      const d = Math.sqrt(vn * vn + ex * ex);
      if (d < best) {
        best = d;
        lastSeed = s;
        const k = lat > 0 ? Math.min(lat, rho) / lat : 0;
        lx *= k; ly *= k; lz *= k;
        qx = sx + lx; qy = sy + ly; qz = sz + lz;
      }
    }
    return best;
  };

  // Full field S, with the "active piece" recorded for gradients.
  // kind: 0 = F_join (analytic), 1 = seed distance, 2 = solid, 3 = pin
  let kind = 0;
  const evalFJoin = (b: Block, x: number, y: number, z: number) => {
    let f = Infinity;
    for (const o of b.joins) { const d = sdfWorld(o, x, y, z); if (d < f) f = d; }
    for (const o of b.cuts) { const d = -sdfWorld(o, x, y, z); if (d > f) f = d; }
    return f;
  };
  const evalSolid = (b: Block, x: number, y: number, z: number) => {
    let f = Infinity;
    for (const o of b.solids) { const d = sdfWorld(o, x, y, z); if (d < f) f = d; }
    return f;
  };
  const evalPin = (b: Block, x: number, y: number, z: number) => {
    let f = Infinity;
    for (const p of b.pins) { const d = pinSDF(p, x, y, z); if (d < f) f = d; }
    return f;
  };
  const combine = (b: Block, f: number, x: number, y: number, z: number): number => {
    let s: number;
    kind = 0;
    if (shell) {
      if (f > margin()) s = f;
      else if (f < -(t + margin())) { s = -f - t; kind = 1; lastSeed = -1; }
      else {
        const d = exact ? seedDist(x, y, z) : -f;
        if (d - t > f) { s = d - t; kind = 1; if (!exact) lastSeed = -1; } else s = f;
      }
    } else s = f;
    if (b.solids.length) {
      const fs = evalSolid(b, x, y, z);
      if (fs < s) { s = fs; kind = 2; }
    }
    if (b.pins.length) {
      const fp = -evalPin(b, x, y, z);
      if (fp > s) { s = fp; kind = 3; }
    }
    return s;
  };
  const evalS = (b: Block, x: number, y: number, z: number) => combine(b, evalFJoin(b, x, y, z), x, y, z);

  // Pass 2: S at corners.
  let active = 0;
  for (const b of blockList) {
    const ox = origin![0] + b.bi * B * h, oy = origin![1] + b.bj * B * h, oz = origin![2] + b.bk * B * h;
    let idx = 0;
    for (let k = 0; k <= B; k++) {
      for (let j = 0; j <= B; j++) {
        for (let i = 0; i <= B; i++) {
          candN = 0;
          if (b.nearest && b.nearest[idx] >= 0) cand[candN++] = b.nearest[idx];
          b.values[idx] = combine(b, b.fjoin[idx], ox + i * h, oy + j * h, oz + k * h);
          idx++;
        }
      }
    }
    active += B * B * B;
  }
  // Corners on a block's max faces are shared with the next block. Make every copy
  // agree with the owning block so both sides see the same sign (no seams).
  for (const b of blockList) {
    const gi0 = b.bi * B, gj0 = b.bj * B, gk0 = b.bk * B;
    for (let k = 0; k <= B; k++) for (let j = 0; j <= B; j++) for (let i = 0; i <= B; i++) {
      if (i < B && j < B && k < B) continue;
      const [owner, oidx] = cornerIndex(gi0 + i, gj0 + j, gk0 + k);
      if (owner && owner !== b) {
        const idx = i + B1 * (j + B1 * k);
        b.values[idx] = owner.values[oidx];
        if (b.nearest && owner.nearest) b.nearest[idx] = owner.nearest[oidx];
      }
    }
  }
  timer.lap('sampleS');

  // Gradient of S at a point, from whichever piece is active there.
  const grad = (b: Block, x: number, y: number, z: number, out: Vec3): void => {
    evalS(b, x, y, z);
    const e = h * 0.05;
    if (kind === 1 && lastSeed >= 0) {
      out[0] = x - qx; out[1] = y - qy; out[2] = z - qz;
    } else {
      const fn = kind === 0 ? evalFJoin : kind === 2 ? evalSolid : kind === 3 ? (bb: Block, a: number, c: number, d: number) => -evalPin(bb, a, c, d)
        : (bb: Block, a: number, c: number, d: number) => -evalFJoin(bb, a, c, d);
      out[0] = fn(b, x + e, y, z) - fn(b, x - e, y, z);
      out[1] = fn(b, x, y + e, z) - fn(b, x, y - e, z);
      out[2] = fn(b, x, y, z + e) - fn(b, x, y, z - e);
    }
    const l = Math.hypot(out[0], out[1], out[2]);
    if (l > 0) { out[0] /= l; out[1] /= l; out[2] /= l; }
  };

  // Dual contouring: one vertex per sign-changing cell.
  const verts: number[] = [];
  const EDGES: [number, number][] = [];
  const corner = (c: number): [number, number, number] => [c & 1, (c >> 1) & 1, (c >> 2) & 1];
  for (let a = 0; a < 8; a++) for (let bb = a + 1; bb < 8; bb++) {
    const ca = corner(a), cb = corner(bb);
    if (Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2]) === 1) EDGES.push([a, bb]);
  }
  const g: Vec3 = [0, 0, 0];
  const cv = new Float64Array(8);
  const px: number[] = [], py: number[] = [], pz: number[] = [], nx: number[] = [], ny: number[] = [], nz: number[] = [];
  for (const b of blockList) {
    const ox = origin![0] + b.bi * B * h, oy = origin![1] + b.bj * B * h, oz = origin![2] + b.bk * B * h;
    const V = b.values;
    for (let k = 0; k < B; k++) for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) {
        const v = V[(i + (c & 1)) + B1 * ((j + ((c >> 1) & 1)) + B1 * (k + ((c >> 2) & 1)))];
        cv[c] = v;
        if (v < 0) mask |= 1 << c;
      }
      if (mask === 0 || mask === 255) continue;
      setCellCandidates(b, i, j, k);
      px.length = py.length = pz.length = nx.length = ny.length = nz.length = 0;
      let mx = 0, my = 0, mz = 0;
      for (const [ea, eb] of EDGES) {
        const va = cv[ea], vb = cv[eb];
        if ((va < 0) === (vb < 0)) continue;
        const s = va / (va - vb);
        const ca = corner(ea), cb = corner(eb);
        const x = ox + (i + ca[0] + (cb[0] - ca[0]) * s) * h;
        const y = oy + (j + ca[1] + (cb[1] - ca[1]) * s) * h;
        const z = oz + (k + ca[2] + (cb[2] - ca[2]) * s) * h;
        grad(b, x, y, z, g);
        px.push(x); py.push(y); pz.push(z); nx.push(g[0]); ny.push(g[1]); nz.push(g[2]);
        mx += x; my += y; mz += z;
      }
      const m = px.length;
      mx /= m; my /= m; mz /= m;
      // QEF: minimise sum (n_i . (v - p_i))^2 + lambda |v - mass|^2
      let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (let q = 0; q < m; q++) {
        const ux = nx[q], uy = ny[q], uz = nz[q];
        const dd = ux * (px[q] - mx) + uy * (py[q] - my) + uz * (pz[q] - mz);
        a00 += ux * ux; a01 += ux * uy; a02 += ux * uz; a11 += uy * uy; a12 += uy * uz; a22 += uz * uz;
        b0 += ux * dd; b1 += uy * dd; b2 += uz * dd;
      }
      const lam = DC_LAMBDA * m;
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
      // Accept the QEF solution if it stays near its cell; otherwise fall back to
      // the mass point (clamping to the cell would turn a feature into a staircase).
      const x0 = ox + i * h, y0 = oy + j * h, z0 = oz + k * h;
      const ex = DC_EXPAND * h;
      if (vx < x0 - ex || vx > x0 + h + ex || vy < y0 - ex || vy > y0 + h + ex || vz < z0 - ex || vz > z0 + h + ex) {
        vx = mx; vy = my; vz = mz;
      }
      b.vidx[i + B * (j + B * k)] = verts.length / 3;
      verts.push(vx, vy, vz);
    }
  }
  timer.lap('vertices');

  // Quads around every sign-changing edge owned by a block.
  const tris: number[] = [];
  let missing = 0;
  const cellVert = (gi: number, gj: number, gk: number): number => {
    const bi = Math.floor(gi / B), bj = Math.floor(gj / B), bk = Math.floor(gk / B);
    const blk = blocks!.get(bkey(bi, bj, bk));
    if (!blk) return -1;
    return blk.vidx[(gi - bi * B) + B * ((gj - bj * B) + B * (gk - bk * B))];
  };
  const pos = (v: number, a: number) => verts[3 * v + a];
  const dist2 = (u: number, w: number) => {
    const dx = pos(u, 0) - pos(w, 0), dy = pos(u, 1) - pos(w, 1), dz = pos(u, 2) - pos(w, 2);
    return dx * dx + dy * dy + dz * dz;
  };
  const emitQuad = (q0: number, q1: number, q2: number, q3: number, flip: boolean) => {
    if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) { missing++; return; }
    if (flip) { const tmp = q1; q1 = q3; q3 = tmp; }
    if (dist2(q0, q2) <= dist2(q1, q3)) tris.push(q0, q1, q2, q0, q2, q3);
    else tris.push(q0, q1, q3, q1, q2, q3);
  };
  for (const b of blockList) {
    const V = b.values;
    const gi0 = b.bi * B, gj0 = b.bj * B, gk0 = b.bk * B;
    for (let k = 0; k < B; k++) for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      const v0 = V[i + B1 * (j + B1 * k)];
      const inside = v0 < 0;
      const gi = gi0 + i, gj = gj0 + j, gk = gk0 + k;
      // x edge
      if ((V[i + 1 + B1 * (j + B1 * k)] < 0) !== inside) {
        emitQuad(cellVert(gi, gj - 1, gk - 1), cellVert(gi, gj, gk - 1), cellVert(gi, gj, gk), cellVert(gi, gj - 1, gk), !inside);
      }
      // y edge
      if ((V[i + B1 * (j + 1 + B1 * k)] < 0) !== inside) {
        emitQuad(cellVert(gi - 1, gj, gk - 1), cellVert(gi - 1, gj, gk), cellVert(gi, gj, gk), cellVert(gi, gj, gk - 1), !inside);
      }
      // z edge
      if ((V[i + B1 * (j + B1 * (k + 1))] < 0) !== inside) {
        emitQuad(cellVert(gi - 1, gj - 1, gk), cellVert(gi, gj - 1, gk), cellVert(gi, gj, gk), cellVert(gi - 1, gj, gk), !inside);
      }
    }
  }
  timer.lap('faces');

  const positions = new Float32Array(verts);
  const indices = new Uint32Array(tris);
  const es = edgeStats(indices, positions.length / 3);
  if (missing) warnings.push(`${missing} quads skipped at block borders (bug)`);
  if (droppedSeeds && !nSeeds) warnings.push('Every surface is an opening: nothing left to shell.');
  timer.lap('check');
  void signOf;
  return {
    positions, indices,
    stats: {
      kernel: 'sdf', triangles: indices.length / 3, vertices: positions.length / 3,
      boundaryEdges: es.boundary, nonManifoldEdges: es.nonManifold,
      cellSize: h, activeCells: active, warnings, timings: timer.timings, totalMs: timer.total(),
    },
  };
}
