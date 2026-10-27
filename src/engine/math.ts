// Small allocation-light vector / matrix helpers used by both kernels.
// Matrices are 3x3 row-major in a Float64Array(9).

export type Vec3 = [number, number, number];

export const DEG = Math.PI / 180;

export function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

/** Rotation matrix for Euler angles (degrees) in three.js 'XYZ' order: R = Rx * Ry * Rz. */
export function eulerXYZ(rx: number, ry: number, rz: number): Float64Array {
  const a = Math.cos(rx * DEG), b = Math.sin(rx * DEG);
  const c = Math.cos(ry * DEG), d = Math.sin(ry * DEG);
  const e = Math.cos(rz * DEG), f = Math.sin(rz * DEG);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return new Float64Array([
    c * e, -c * f, d,
    af + be * d, ae - bf * d, -b * c,
    bf - ae * d, be + af * d, a * c,
  ]);
}

export function mulMat3Vec(m: Float64Array, x: number, y: number, z: number, out: Vec3): Vec3 {
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

/** Multiply by the transpose (the inverse for a rotation matrix). */
export function mulMat3TVec(m: Float64Array, x: number, y: number, z: number, out: Vec3): Vec3 {
  out[0] = m[0] * x + m[3] * y + m[6] * z;
  out[1] = m[1] * x + m[4] * y + m[7] * z;
  out[2] = m[2] * x + m[5] * y + m[8] * z;
  return out;
}

export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function normalize(v: Vec3): Vec3 {
  const l = len3(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export function emptyAABB(): AABB {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function growAABB(b: AABB, x: number, y: number, z: number): void {
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
}

/** Signed distance and nearest-segment index for a closed 2D polygon (exact, iq style). */
export function polygonSDF(
  pts: Float64Array, // x0,y0,x1,y1,...
  n: number,
  px: number,
  py: number,
  skip: number = -1, // segment index excluded from the distance (still used for sign)
): { d: number; seg: number } {
  let best = Infinity;
  let seg = -1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = pts[2 * j], ay = pts[2 * j + 1];
    const bx = pts[2 * i], by = pts[2 * i + 1];
    const ex = bx - ax, ey = by - ay;
    const wx = px - ax, wy = py - ay;
    if (j !== skip) {
      const ee = ex * ex + ey * ey;
      const t = ee > 0 ? clamp((wx * ex + wy * ey) / ee, 0, 1) : 0;
      const dx = wx - ex * t, dy = wy - ey * t;
      const dd = dx * dx + dy * dy;
      if (dd < best) {
        best = dd;
        seg = j;
      }
    }
    if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  const d = Math.sqrt(best);
  return { d: inside ? -d : d, seg };
}
