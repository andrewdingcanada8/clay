// Revolve profiles as 2D tables over the (r, y) half-plane: signed distance to the
// profile and depth below its non-opening segments. The GPU samples them as
// textures; the CPU samples the same tables, so both see the same analytic depth.

import { polygonSDF } from './math';
import { type ProfilePoint, type SampledProfile, sampleProfile } from './profile';

export const PROFILE_RES: [number, number] = [160, 320];
/** Curve samples per profile span: the inner wall is an offset of this polyline, and
 *  coarse segments would show as flat bands inside a large pot. */
export const PROFILE_SAMPLES = 64;

export interface ProfileTable {
  W: number;
  H: number;
  sd: Float32Array;
  dh: Float32Array;
  /** (r, y) of the first and last texel centres. */
  min: [number, number];
  max: [number, number];
}

/** Profile to tabulate: revolves are resampled finely; cylinders and cones already
 *  have an exact polygon. */
export function tableProfile(type: string, points: ProfilePoint[] | undefined, compiled: SampledProfile): SampledProfile {
  return type === 'revolve' ? sampleProfile(points ?? [], PROFILE_SAMPLES) : compiled;
}

export function buildProfileTable(prof: SampledProfile, isHole: (face: string) => boolean): ProfileTable {
  const m = Math.max(1, 0.15 * Math.max(prof.rMax, prof.yMax - prof.yMin));
  const lo: [number, number] = [0, prof.yMin - m], hi: [number, number] = [prof.rMax + m, prof.yMax + m];
  const [W, H] = PROFILE_RES;
  const sd = new Float32Array(W * H), dh = new Float32Array(W * H);
  const segs: number[] = [];
  for (let s = 0; s < prof.n; s++) {
    const f = prof.segFace[s];
    if (f !== 'axis' && !isHole(f)) segs.push(s);
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const r = lo[0] + ((i + 0.5) / W) * (hi[0] - lo[0]);
    const y = lo[1] + ((j + 0.5) / H) * (hi[1] - lo[1]);
    let d = 6e4;
    for (const s of segs) {
      const t2 = (s + 1) % prof.n;
      const ax = prof.pts[2 * s], ay = prof.pts[2 * s + 1], bx = prof.pts[2 * t2], by = prof.pts[2 * t2 + 1];
      const ex = bx - ax, ey = by - ay, wx = r - ax, wy = y - ay;
      const tt = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
      d = Math.min(d, Math.hypot(wx - ex * tt, wy - ey * tt));
    }
    sd[i + W * j] = polygonSDF(prof.pts, prof.n, r, y, prof.axisSeg).d;
    dh[i + W * j] = d;
  }
  const hx = (hi[0] - lo[0]) / W / 2, hy = (hi[1] - lo[1]) / H / 2;
  return { W, H, sd, dh, min: [lo[0] + hx, lo[1] + hy], max: [hi[0] - hx, hi[1] - hy] };
}

/** Bilinear depth lookup, clamped to the table (as the shader's channel 1). */
export function tableDepth(t: ProfileTable, r: number, y: number): number {
  const fx = Math.min(1, Math.max(0, (r - t.min[0]) / (t.max[0] - t.min[0]))) * (t.W - 1);
  const fy = Math.min(1, Math.max(0, (y - t.min[1]) / (t.max[1] - t.min[1]))) * (t.H - 1);
  const i = Math.min(t.W - 2, Math.floor(fx)), j = Math.min(t.H - 2, Math.floor(fy));
  const u = fx - i, v = fy - j, q = i + t.W * j, D = t.dh;
  return (D[q] * (1 - u) + D[q + 1] * u) * (1 - v) + (D[q + t.W] * (1 - u) + D[q + t.W + 1] * u) * v;
}
