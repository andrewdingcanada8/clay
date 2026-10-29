// Revolve profiles: control points in the (r, y) half-plane, interpolated with a
// centripetal Catmull–Rom spline. Each point has a smoothness from 0 (sharp kink,
// useful for lips, rims and foot rings) to 1 (fully smooth).

export interface ProfilePoint {
  r: number;
  y: number;
  /** 0 = sharp corner, 1 = smooth (default). */
  smooth?: number;
  /** legacy: same as smooth = 0 */
  corner?: boolean;
}

export function smoothOf(p: ProfilePoint): number {
  return p.smooth ?? (p.corner ? 0 : 1);
}

export interface SampledProfile {
  /** Closed polygon (r, y): sampled curve then the axis closing points. */
  pts: Float64Array;
  n: number;
  /** Face id for each polygon segment (segment i goes from point i to i+1). */
  segFace: string[];
  /** Index of the segment lying on the axis (excluded from distance). */
  axisSeg: number;
  faces: string[];
  rMax: number;
  yMin: number;
  yMax: number;
}

const SAMPLES_PER_SPAN = 12;

function catmullRom(
  p0: ProfilePoint, p1: ProfilePoint, p2: ProfilePoint, p3: ProfilePoint, t: number,
): [number, number] {
  // Centripetal parameterization (alpha = 0.5) avoids cusps and self-loops.
  const d = (a: ProfilePoint, b: ProfilePoint) => Math.max(1e-6, Math.pow(Math.hypot(b.r - a.r, b.y - a.y), 0.5));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => {
    const w = (u - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const P0: [number, number] = [p0.r, p0.y], P1: [number, number] = [p1.r, p1.y];
  const P2: [number, number] = [p2.r, p2.y], P3: [number, number] = [p3.r, p3.y];
  const A1 = lerp(P0, P1, t0, t1), A2 = lerp(P1, P2, t1, t2), A3 = lerp(P2, P3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

/** Sample the profile curve. Returns points plus the control-span index of each segment. */
/**
 * Sample the curve. Returns points plus the control-span index of each segment.
 * `closed`: the curve wraps from the last point back to the first (the start point
 * is not repeated at the end). `clampR`: keep r >= 0 (revolve profiles).
 */
export function sampleCurve(points: ProfilePoint[], samplesPerSpan = SAMPLES_PER_SPAN, opts: { closed?: boolean; clampR?: boolean } = {}): { xy: number[]; span: number[] } {
  const closed = !!opts.closed && points.length > 2, clampR = opts.clampR ?? true;
  const xy: number[] = [];
  const span: number[] = [];
  const n = points.length;
  if (n === 0) return { xy, span };
  const R = (r: number) => (clampR ? Math.max(0, r) : r);
  const at = (i: number) => (closed ? points[((i % n) + n) % n] : points[i]);
  xy.push(R(points[0].r), points[0].y);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p1 = at(i), p2 = at(i + 1);
    // Neighbours for tangents. A sharp point (or an end) mirrors the segment so the
    // tangent there comes from this span only; partial smoothness blends the mirrored
    // phantom toward the real neighbour, turning the kink gradually into a curve.
    const m0 = { r: 2 * p1.r - p2.r, y: 2 * p1.y - p2.y }, m3 = { r: 2 * p2.r - p1.r, y: 2 * p2.y - p1.y };
    const mix = (m: ProfilePoint, q: ProfilePoint | undefined, k: number): ProfilePoint =>
      q ? { r: m.r + (q.r - m.r) * k, y: m.y + (q.y - m.y) * k } : m;
    const p0 = mix(m0, at(i - 1), smoothOf(p1));
    const p3 = mix(m3, at(i + 2), smoothOf(p2));
    const straight = Math.hypot(p2.r - p1.r, p2.y - p1.y) < 1e-9;
    const S = straight ? 1 : samplesPerSpan;
    for (let s = 1; s <= S; s++) {
      if (closed && i === spans - 1 && s === S) break; // back at the start
      const [r, y] = s === S ? [p2.r, p2.y] : catmullRom(p0, p1, p2, p3, s / S);
      xy.push(R(r), y);
      span.push(i);
    }
  }
  return { xy, span };
}

export function sampleProfile(points: ProfilePoint[], samplesPerSpan = SAMPLES_PER_SPAN): SampledProfile {
  const { xy, span } = sampleCurve(points, samplesPerSpan);
  const curveN = xy.length / 2;
  const out: number[] = [];
  const segFace: string[] = [];
  const faces = new Set<string>();
  const EPS = 1e-6;
  // bottom axis point -> first curve point is the 'bottom' cap
  const r0 = xy[0], y0 = xy[1];
  const rn = xy[2 * curveN - 2], yn = xy[2 * curveN - 1];
  if (r0 > EPS) {
    out.push(0, y0);
    segFace.push('bottom');
    faces.add('bottom');
  }
  for (let i = 0; i < curveN; i++) {
    out.push(xy[2 * i], xy[2 * i + 1]);
    if (i < curveN - 1) {
      const f = `span${span[i]}`;
      segFace.push(f);
      faces.add(f);
    }
  }
  let axisSeg: number;
  if (rn > EPS) {
    segFace.push('top');
    faces.add('top');
    out.push(0, yn);
  }
  // closing segment (last point -> first point) runs along the axis
  segFace.push('axis');
  axisSeg = segFace.length - 1;
  const pts = new Float64Array(out);
  let rMax = 0, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    rMax = Math.max(rMax, pts[i]);
    yMin = Math.min(yMin, pts[i + 1]);
    yMax = Math.max(yMax, pts[i + 1]);
  }
  // Keep a stable, human-ordered face list: bottom, spans..., top
  const ordered = ['bottom', ...Array.from({ length: Math.max(0, points.length - 1) }, (_, i) => `span${i}`), 'top']
    .filter((f) => faces.has(f));
  return { pts, n: pts.length / 2, segFace, axisSeg, faces: ordered, rMax, yMin, yMax };
}

/**
 * Round the corners of a closed polygon (x, y pairs): every corner turning more
 * than `minTurnDeg` (outward or inward) becomes an arc of radius r, tangent to the
 * segments either side of it. The polyline is cut back along the path, so a corner
 * between a straight run and a sampled curve rounds too. Each arc is limited to
 * half the path to the neighbouring sharp corners (so arcs never overlap); it is
 * then smaller than r.
 */
export function filletPolygon(xy: number[], r: number, minTurnDeg = 10): number[] {
  const n = xy.length / 2;
  if (r <= 0 || n < 3) return xy.slice();
  const P = (i: number) => [xy[2 * (((i % n) + n) % n)], xy[2 * (((i % n) + n) % n) + 1]];
  const segLen = (i: number) => { const a = P(i), b = P(i + 1); return Math.hypot(b[0] - a[0], b[1] - a[1]); };
  const dirOf = (i: number) => { const a = P(i), b = P(i + 1), l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  // sharp corners and their turn angles
  const turn: number[] = [];
  const sharp: number[] = [];
  for (let i = 0; i < n; i++) {
    const e1 = dirOf(i - 1), e2 = dirOf(i);
    const a = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1])));
    turn.push(a);
    if (a > (minTurnDeg * Math.PI) / 180) sharp.push(i);
  }
  if (!sharp.length) return xy.slice();
  // cumulative path length at each vertex
  const s = [0];
  for (let i = 0; i < n; i++) s.push(s[i] + segLen(i));
  const total = s[n];
  const along = (from: number, to: number) => ((s[to] - s[from]) % total + total) % total || total;
  // how far each corner is cut back
  const cut = new Map<number, number>();
  sharp.forEach((v, k) => {
    const prev = sharp[(k - 1 + sharp.length) % sharp.length], next = sharp[(k + 1) % sharp.length];
    const room = Math.min(sharp.length > 1 ? along(prev, v) / 2 : total / 3, sharp.length > 1 ? along(v, next) / 2 : total / 3);
    const a = Math.min(turn[v], (170 * Math.PI) / 180);
    cut.set(v, Math.min(r * Math.tan(a / 2), room * 0.999));
  });
  const out: number[] = [];
  // the point at path distance `d` back from (sgn -1) or on from (+1) vertex v
  const walk = (v: number, d: number, sgn: number) => {
    let i = v;
    for (let guard = 0; guard < n; guard++) {
      const j = sgn > 0 ? i : i - 1; // segment walked over
      const L = segLen(j);
      if (d <= L) {
        const a = P(i), b = P(i + sgn), t = d / (L || 1);
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], v: i };
      }
      d -= L; i += sgn;
    }
    return { p: P(i), v: i };
  };
  // which vertices fall inside a cut-back zone (skipped)
  const skip = new Uint8Array(n);
  const starts: Map<number, number[]> = new Map();
  for (const v of sharp) {
    const d = cut.get(v)!;
    const A = walk(v, d, -1), B = walk(v, d, 1);
    // vertices strictly between A and B (other than v) are dropped
    for (let i = A.v; ((i - v) % n + n) % n !== 0; i++) skip[((i % n) + n) % n] = 1;
    for (let i = v + 1; ((i - B.v - 1) % n + n) % n !== 0 && i - v < n; i++) skip[i % n] = 1;
    skip[v] = 1;
    // the arc through the corner, tangent at A and B to the incoming/outgoing directions there
    // A lies on the segment ending at vertex A.v, B on the one starting at B.v
    const e1 = dirOf(A.v - 1), e2 = dirOf(B.v);
    const pA = A.p, pB = B.p;
    const sgn = Math.sign(e1[0] * e2[1] - e1[1] * e2[0]) || 1;
    const th = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1])));
    const steps = Math.max(2, Math.ceil(th / (Math.PI / 16)));
    const arc: number[] = [];
    // quadratic-to-circle: centre where the normals at A and B meet
    const nA = [-e1[1] * sgn, e1[0] * sgn], nB = [-e2[1] * sgn, e2[0] * sgn];
    const den = nA[0] * nB[1] - nA[1] * nB[0];
    if (Math.abs(den) < 1e-9) { arc.push(...pA, ...pB); }
    else {
      const dx = pB[0] - pA[0], dy = pB[1] - pA[1];
      const ta = (dx * nB[1] - dy * nB[0]) / den;
      const C = [pA[0] + nA[0] * ta, pA[1] + nA[1] * ta];
      const a0 = Math.atan2(pA[1] - C[1], pA[0] - C[0]);
      let a1 = Math.atan2(pB[1] - C[1], pB[0] - C[0]);
      while (sgn > 0 && a1 < a0) a1 += 2 * Math.PI;
      while (sgn < 0 && a1 > a0) a1 -= 2 * Math.PI;
      const ra = Math.hypot(pA[0] - C[0], pA[1] - C[1]), rb = Math.hypot(pB[0] - C[0], pB[1] - C[1]);
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, a = a0 + (a1 - a0) * t, rr = ra + (rb - ra) * t;
        arc.push(C[0] + rr * Math.cos(a), C[1] + rr * Math.sin(a));
      }
    }
    starts.set(v, arc);
  }
  for (let i = 0; i < n; i++) {
    const arc = starts.get(i);
    if (arc) out.push(...arc);
    else if (!skip[i]) out.push(...P(i));
  }
  return out;
}

/**
 * A revolve profile with its corners rounded (radius r): mirrored across the axis
 * so corners on the axis (a cone's tip) round symmetrically, filleted, then the
 * right half again. Each new segment keeps the face of the original segment
 * nearest its middle (so openings stay where they were).
 */
export function roundProfile(prof: SampledProfile, r: number): SampledProfile {
  if (r <= 0) return prof;
  const { pts, n, axisSeg } = prof;
  // the profile from one axis end to the other (dropping the axis segment)
  const half: number[] = [];
  for (let k = 0; k < n; k++) { const i = (axisSeg + 1 + k) % n; half.push(pts[2 * i], pts[2 * i + 1]); }
  const m = half.length / 2;
  const full = half.slice();
  for (let i = m - 2; i >= 1; i--) full.push(-half[2 * i], half[2 * i + 1]);
  const rounded = filletPolygon(full, r);
  // back to the right half: walk the rounded loop, keep x >= 0, with crossings on the axis
  const q = rounded.length / 2, out: number[] = [];
  let start = 0;
  for (let i = 0; i < q; i++) if (rounded[2 * i] < 0 && rounded[2 * ((i + 1) % q)] >= 0) { start = (i + 1) % q; break; }
  const prevI = (start - 1 + q) % q;
  {
    const ax = rounded[2 * prevI], ay = rounded[2 * prevI + 1], bx = rounded[2 * start], by = rounded[2 * start + 1];
    const t = ax === bx ? 0 : -ax / (bx - ax);
    out.push(0, ay + (by - ay) * t);
  }
  for (let k = 0; k < q; k++) {
    const i = (start + k) % q, j = (i + 1) % q;
    const x = rounded[2 * i], y = rounded[2 * i + 1];
    if (x < 0) break;
    if (x > 1e-9) out.push(x, y);
    if (rounded[2 * j] < 0) {
      const bx = rounded[2 * j], by = rounded[2 * j + 1];
      const t = x === bx ? 0 : x / (x - bx);
      out.push(0, y + (by - y) * t);
      break;
    }
  }
  const N = out.length / 2;
  if (N < 3) return prof;
  // faces: the original segment nearest each new segment's midpoint
  const segFace: string[] = [];
  for (let i = 0; i < N - 1; i++) {
    const mx = (out[2 * i] + out[2 * i + 2]) / 2, my = (out[2 * i + 1] + out[2 * i + 3]) / 2;
    let best = Infinity, f = prof.faces[0] ?? 'span0';
    for (let s = 0; s < n; s++) {
      if (s === axisSeg) continue;
      const t2 = (s + 1) % n, ax = pts[2 * s], ay = pts[2 * s + 1], ex = pts[2 * t2] - ax, ey = pts[2 * t2 + 1] - ay;
      const tt = Math.max(0, Math.min(1, ((mx - ax) * ex + (my - ay) * ey) / (ex * ex + ey * ey || 1)));
      const d = Math.hypot(mx - ax - ex * tt, my - ay - ey * tt);
      if (d < best) { best = d; f = prof.segFace[s]; }
    }
    segFace.push(f);
  }
  segFace.push('axis');
  let rMax = 0, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < N; i++) { rMax = Math.max(rMax, out[2 * i]); yMin = Math.min(yMin, out[2 * i + 1]); yMax = Math.max(yMax, out[2 * i + 1]); }
  return { pts: Float64Array.from(out), n: N, segFace, axisSeg: N - 1, faces: prof.faces, rMax, yMin, yMax };
}
