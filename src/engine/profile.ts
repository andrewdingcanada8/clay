// Revolve profiles: control points in the (r, y) half-plane, interpolated with a
// centripetal Catmull–Rom spline. Points flagged `corner` break the spline so the
// curve has a sharp kink there (useful for lips, rims and foot rings).

export interface ProfilePoint {
  r: number;
  y: number;
  corner?: boolean;
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
export function sampleCurve(points: ProfilePoint[], samplesPerSpan = SAMPLES_PER_SPAN): { xy: number[]; span: number[] } {
  const xy: number[] = [];
  const span: number[] = [];
  const n = points.length;
  if (n === 0) return { xy, span };
  xy.push(Math.max(0, points[0].r), points[0].y);
  for (let i = 0; i < n - 1; i++) {
    const p1 = points[i], p2 = points[i + 1];
    // Neighbours for tangents; a corner (or the ends) mirrors the segment so the
    // tangent there is taken from this span only.
    const p0 = i === 0 || p1.corner ? { r: 2 * p1.r - p2.r, y: 2 * p1.y - p2.y } : points[i - 1];
    const p3 = i + 2 >= n || p2.corner ? { r: 2 * p2.r - p1.r, y: 2 * p2.y - p1.y } : points[i + 2];
    const straight = Math.hypot(p2.r - p1.r, p2.y - p1.y) < 1e-9;
    const S = straight ? 1 : samplesPerSpan;
    for (let s = 1; s <= S; s++) {
      const [r, y] = s === S ? [p2.r, p2.y] : catmullRom(p0, p1, p2, p3, s / S);
      xy.push(Math.max(0, r), y);
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
