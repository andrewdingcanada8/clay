// Revolve profiles: control points in the (r, y) half-plane, bottom to top.
//
// Each point has an edge value t in [0, 1] that sets its Bézier handles:
//   t = 0    zero-length handles                  -> sharp corner
//   t ~ 0.5  short handles, half-way to the chord -> reads as a radius
//   t = 1    handles along the neighbour chord    -> one flowing curve
//
// Rim and foot styles are applied on top of the user's points (they replace the
// last / first point when sampling), so switching style never edits the points.

export interface ProfilePoint {
  r: number;
  y: number;
  /** Edge value 0 (sharp) .. 1 (smooth). */
  t?: number;
  /** Legacy: sharp corner (t = 0). */
  corner?: boolean;
  /** Face id of the span leaving this point (set by rim/foot decoration). */
  face?: string;
}

export type RimStyle = 'plain' | 'lip' | 'flared' | 'rolled' | 'inturned';
export type FootStyle = 'flat' | 'square' | 'ring' | 'recessed' | 'tucked' | 'concave';

export const RIM_STYLES: [RimStyle, string][] = [
  ['plain', 'Plain'], ['lip', 'Lip'], ['flared', 'Flared'], ['rolled', 'Rolled'], ['inturned', 'Inturned'],
];
export const FOOT_STYLES: [FootStyle, string][] = [
  ['flat', 'Flat'], ['square', 'Square'], ['ring', 'Ring'], ['recessed', 'Recessed'], ['tucked', 'Tucked'], ['concave', 'Concave'],
];

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

const SAMPLES_PER_SPAN = 14;
const HANDLE_K = 0.38;

export const edgeOf = (p: ProfilePoint) => Math.min(1, Math.max(0, p.t ?? (p.corner ? 0 : 1)));

type V = { x: number; y: number };
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const mag = (v: V) => Math.hypot(v.x, v.y) || 1e-9;
const unit = (v: V): V => { const l = mag(v); return { x: v.x / l, y: v.y / l }; };
const mix = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Cubic Bézier segments through the points, handles set by each point's edge value. */
export function bezierSegments(points: ProfilePoint[]): { a: V; c1: V; c2: V; b: V }[] {
  const P = points.map((p) => ({ x: p.r, y: p.y }));
  const T = P.map((p, i) => {
    const prev = P[i - 1], next = P[i + 1];
    const t = edgeOf(points[i]);
    const vIn = prev ? unit(sub(p, prev)) : null;
    const vOut = next ? unit(sub(next, p)) : null;
    const chord = prev && next ? unit(sub(next, prev)) : (vIn ?? vOut)!;
    return {
      dIn: vIn ? unit(mix(vIn, chord, t)) : chord,
      dOut: vOut ? unit(mix(vOut, chord, t)) : chord,
      lIn: prev ? t * HANDLE_K * mag(sub(p, prev)) : 0,
      lOut: next ? t * HANDLE_K * mag(sub(next, p)) : 0,
    };
  });
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    out.push({
      a, b,
      c1: { x: a.x + T[i].dOut.x * T[i].lOut, y: a.y + T[i].dOut.y * T[i].lOut },
      c2: { x: b.x - T[i + 1].dIn.x * T[i + 1].lIn, y: b.y - T[i + 1].dIn.y * T[i + 1].lIn },
    });
  }
  return out;
}

export function bezierAt(s: { a: V; c1: V; c2: V; b: V }, t: number): V {
  const u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return { x: k0 * s.a.x + k1 * s.c1.x + k2 * s.c2.x + k3 * s.b.x, y: k0 * s.a.y + k1 * s.c1.y + k2 * s.c2.y + k3 * s.b.y };
}

/** Sample the profile curve. Returns points plus the source point index of each segment. */
export function sampleCurve(points: ProfilePoint[], samplesPerSpan = SAMPLES_PER_SPAN): { xy: number[]; span: number[] } {
  const xy: number[] = [];
  const span: number[] = [];
  if (!points.length) return { xy, span };
  xy.push(Math.max(0, points[0].r), points[0].y);
  bezierSegments(points).forEach((s, i) => {
    const straight = edgeOf(points[i]) < 1e-3 && edgeOf(points[i + 1]) < 1e-3;
    const S = straight ? 1 : samplesPerSpan;
    for (let k = 1; k <= S; k++) {
      const q = k === S ? s.b : bezierAt(s, k / S);
      xy.push(Math.max(0, q.x), q.y);
      span.push(i);
    }
  });
  return { xy, span };
}

/** Apply rim and foot styles: returns the points actually revolved (with face tags). */
export function decorate(points: ProfilePoint[], rim: RimStyle = 'plain', foot: FootStyle = 'flat'): ProfilePoint[] {
  if (points.length < 2) return points;
  const n = points.length;
  const user = points.map((p, i) => ({ ...p, face: p.face ?? `span${i}` }));
  const top = user[n - 1], bot = user[0];
  const k = Math.max(1, Math.abs(top.y - bot.y)) / 112; // style sizes are relative to the pot's height
  const r = top.r, yt = top.y;
  const R = (rr: number, y: number, t: number, face = 'rim'): ProfilePoint => ({ r: rr, y, t, face });
  let rimPts: ProfilePoint[];
  switch (rim) {
    case 'lip': rimPts = [R(r * 0.96, yt - 10 * k, 0.9), R(r * 1.15, yt, 0.35)]; break;
    case 'flared': rimPts = [R(r * 0.9, yt - 14 * k, 0.95), R(r * 1.45, yt, 0.3)]; break;
    case 'rolled': rimPts = [R(r * 0.99, yt - 11 * k, 0.9), R(r * 1.17, yt - 5 * k, 1), R(r * 1.04, yt, 0.9)]; break;
    case 'inturned': rimPts = [R(r * 1.06, yt - 13 * k, 0.95), R(r * 1.1, yt - 2 * k, 1), R(r * 0.74, yt - 7 * k, 0.8)]; break;
    default: rimPts = [top];
  }
  const fr = bot.r, yb = bot.y;
  const F = (rr: number, y: number, t: number, face = 'foot'): ProfilePoint => ({ r: rr, y, t, face });
  const U = (rr: number, y: number, t: number) => F(rr, y, t, 'bottom'); // underside
  let footPts: ProfilePoint[];
  switch (foot) {
    case 'square': footPts = [F(fr, yb, 0.05), F(fr, yb + 13 * k, 0.1)]; break;
    case 'ring': footPts = [F(fr * 0.7, yb, 0.05), F(fr * 0.68, yb + 17 * k, 0.15), F(fr, yb + 22 * k, 0.8)]; break;
    case 'recessed': footPts = [U(0, yb + 6 * k, 0), U(fr * 0.6, yb + 6 * k, 0), F(fr * 0.72, yb, 0), F(fr, yb, 0.05), F(fr, yb + 10 * k, 0.25)]; break;
    case 'tucked': footPts = [U(0, yb + 6 * k, 0), U(fr * 0.5, yb + 6 * k, 0), F(fr * 0.6, yb, 0), F(fr * 0.68, yb, 0.05), F(fr * 0.66, yb + 9 * k, 0.25), F(fr, yb + 22 * k, 0.95)]; break;
    case 'concave': footPts = [U(0, yb + 8 * k, 1), U(fr * 0.55, yb + 4 * k, 1), F(fr * 0.92, yb, 0.3), F(fr, yb + 9 * k, 0.6)]; break;
    default: footPts = [bot];
  }
  // the span leaving the last foot point is the user's first span
  footPts[footPts.length - 1] = { ...footPts[footPts.length - 1], face: user[0].face };
  return [...footPts, ...user.slice(1, n - 1), ...rimPts];
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
      const f = points[span[i]].face ?? `span${span[i]}`;
      segFace.push(f);
      faces.add(f);
    }
  }
  if (rn > EPS) {
    segFace.push('top');
    faces.add('top');
    out.push(0, yn);
  }
  // closing segment (last point -> first point) runs along the axis
  segFace.push('axis');
  const axisSeg = segFace.length - 1;
  const pts = new Float64Array(out);
  let rMax = 0, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    rMax = Math.max(rMax, pts[i]);
    yMin = Math.min(yMin, pts[i + 1]);
    yMax = Math.max(yMax, pts[i + 1]);
  }
  // stable, human-ordered face list: bottom, foot, spans..., rim, top
  const spanIds = [...faces].filter((f) => f.startsWith('span')).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  const ordered = ['bottom', 'foot', ...spanIds, 'rim', 'top'].filter((f) => faces.has(f));
  return { pts, n: pts.length / 2, segFace, axisSeg, faces: ordered, rMax, yMin, yMax };
}

// ------------------------------------------------------------- starting shapes
// From the earlier pottery MVP (profile units: y grows downward, foot at 132,
// rim at 20). Converted to cm at hand size: 0.2 cm per unit, centred on y = 0.
const TOP_Y = 20, BOT_Y = 132, UNIT = 0.2;
const shape = (name: string, raw: [number, number][], ts: number[]) => ({
  name,
  points: raw.map(([x, y], i) => ({ r: +(x * UNIT).toFixed(2), y: +(((BOT_Y + TOP_Y) / 2 - y) * UNIT).toFixed(2), t: ts[i] })),
});
export const PROFILE_PRESETS: { name: string; points: ProfilePoint[] }[] = [
  shape('Straight', [[25, BOT_Y], [27, 76], [26, TOP_Y]], [0.2, 0.5, 0.2]),
  shape('Bulbous', [[18, BOT_Y], [47, 84], [26, TOP_Y]], [0.4, 0.95, 0.6]),
  shape('Flared', [[16, BOT_Y], [33, 76], [54, TOP_Y]], [0.35, 0.9, 0.4]),
  shape('Waisted', [[31, BOT_Y], [18, 80], [41, TOP_Y]], [0.4, 1, 0.5]),
  shape('Long neck', [[21, BOT_Y], [45, 92], [13, 52], [19, TOP_Y]], [0.4, 0.9, 0.9, 0.5]),
  shape('Egg', [[14, BOT_Y], [45, 78], [19, TOP_Y]], [0.5, 1, 0.8]),
  shape('Tulip', [[17, BOT_Y], [25, 92], [49, TOP_Y]], [0.4, 0.9, 0.5]),
  shape('Barrel', [[29, BOT_Y], [46, 76], [31, TOP_Y]], [0.25, 0.8, 0.3]),
  shape('Conical bowl', [[11, BOT_Y], [31, 76], [51, TOP_Y]], [0.15, 0.1, 0.15]),
  shape('Baluster', [[20, BOT_Y], [50, 96], [24, 56], [37, TOP_Y]], [0.4, 0.95, 0.95, 0.5]),
  shape('Bud', [[16, BOT_Y], [41, 70], [11, TOP_Y]], [0.45, 1, 0.6]),
  shape('Column', [[33, BOT_Y], [30, 76], [33, TOP_Y]], [0.1, 0.6, 0.1]),
  shape('Gourd', [[27, BOT_Y], [45, 104], [21, 62], [31, TOP_Y]], [0.3, 0.85, 0.85, 0.4]),
  shape('Wide mouth', [[22, BOT_Y], [49, 70], [57, TOP_Y]], [0.4, 0.95, 0.4]),
];

const MIDDLES = ['Belly', 'Waist', 'Shoulder', 'Neck'];
export const pointName = (i: number, n: number) => (i === 0 ? 'Foot' : i === n - 1 ? 'Rim' : MIDDLES[Math.min(i - 1, 3)]);
