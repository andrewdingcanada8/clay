// Primitive definitions shared by both kernels: analytic SDFs (SDF kernel), 2D
// profile descriptions (mesh kernel builds solids from these), face lookup and bounds.

import type { PrimitiveType, SceneObject } from './document';
import { type AABB, type Vec3, clamp, emptyAABB, eulerXYZ, growAABB, mulMat3TVec, mulMat3Vec, polygonSDF } from './math';
import { type SampledProfile, sampleProfile } from './profile';
import type { ProfileTable } from './profileTable';
import { type SweepPath, type SweepSection, buildSweepPath, buildSweepSection, sweepLocate, sweepSDF } from './sweep';

export interface FaceInfo {
  id: string;
  label: string;
  /** For planar faces: outward normal and a point on the plane, in parameter space. */
  plane?: { n: Vec3; p: Vec3 };
}

export interface CompiledObject {
  obj: SceneObject;
  rot: Float64Array;
  pos: Vec3;
  scale: Vec3;
  minScale: number;
  /** Signed distance in parameter space. */
  sdfLocal(x: number, y: number, z: number): number;
  faceAtLocal(x: number, y: number, z: number): string;
  faces: FaceInfo[];
  localBounds: AABB;
  worldBounds: AABB;
  /** Revolve-family primitives: closed (r,y) profile polygon (axis segment included). */
  profile?: SampledProfile;
  /** Extrusion-family primitives: convex polygon in the XZ plane + height along Y. */
  extrusion?: { poly: Float64Array; h: number };
  /** Prism: regular n-gon frustum (bottom/top circumradius). */
  frustum?: { n: number; r1: number; r2: number; h: number };
  /** Sweep: the path with its frames, and the section. */
  sweep?: { path: SweepPath; sec: SweepSection };
  /** Cached revolve depth tables, by opening faces (see scene.holeDepth). */
  depthTables?: Map<string, ProfileTable>;
  /** Cached bounding sphere (see scene.boundSphere). */
  bsphere?: [number, number, number, number];
}

const tmp: Vec3 = [0, 0, 0];

export function toLocal(c: CompiledObject, x: number, y: number, z: number, out: Vec3): Vec3 {
  mulMat3TVec(c.rot, x - c.pos[0], y - c.pos[1], z - c.pos[2], out);
  out[0] /= c.scale[0];
  out[1] /= c.scale[1];
  out[2] /= c.scale[2];
  return out;
}

export function toWorld(c: CompiledObject, x: number, y: number, z: number, out: Vec3): Vec3 {
  mulMat3Vec(c.rot, x * c.scale[0], y * c.scale[1], z * c.scale[2], out);
  out[0] += c.pos[0];
  out[1] += c.pos[1];
  out[2] += c.pos[2];
  return out;
}

/** Transform a parameter-space normal to world space (inverse-transpose of R*S). */
export function normalToWorld(c: CompiledObject, nx: number, ny: number, nz: number): Vec3 {
  const out: Vec3 = [0, 0, 0];
  mulMat3Vec(c.rot, nx / c.scale[0], ny / c.scale[1], nz / c.scale[2], out);
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

/** Conservative world-space signed distance (exact for uniform scale). */
export function sdfWorld(c: CompiledObject, x: number, y: number, z: number): number {
  toLocal(c, x, y, z, tmp);
  return c.sdfLocal(tmp[0], tmp[1], tmp[2]) * c.minScale;
}

export function faceAtWorld(c: CompiledObject, x: number, y: number, z: number): string {
  toLocal(c, x, y, z, tmp);
  return c.faceAtLocal(tmp[0], tmp[1], tmp[2]);
}

function regularPolygon(n: number, r: number): Float64Array {
  const pts = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts[2 * i] = r * Math.cos(a);
    pts[2 * i + 1] = r * Math.sin(a);
  }
  return pts;
}

// 2D outlines (r, y) for revolve-family primitives. Curved outlines are sampled
// finely; the SDF kernel uses the analytic SDF instead where one exists.
function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, segs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Closed (r,y) outline for revolve-family primitives (used by the mesh kernel). */
export function revolveOutline(type: PrimitiveType, p: SceneObject['params'], segs: number): number[] | null {
  switch (type) {
    case 'sphere': return [0, -p.r!, ...arcPts(0, 0, p.r!, -Math.PI / 2, Math.PI / 2, segs), 0, p.r!];
    case 'cylinder': return [0, -p.h! / 2, p.r!, -p.h! / 2, p.r!, p.h! / 2, 0, p.h! / 2];
    case 'cone': return [0, -p.h! / 2, p.r!, -p.h! / 2, 0, p.h! / 2];
    case 'capsule': {
      const a = arcPts(0, -p.h! / 2, p.r!, -Math.PI / 2, 0, Math.ceil(segs / 2));
      const b = arcPts(0, p.h! / 2, p.r!, 0, Math.PI / 2, Math.ceil(segs / 2));
      return [...a, ...b];
    }
    case 'torus': return arcPts(p.R!, 0, p.r!, -Math.PI, Math.PI, segs * 2).slice(0, -2);
    default: return null;
  }
}

/** Plane geometry of a regular n-gon frustum along Y (sides numbered as faces side0..). */
export function prismFrustum(n: number, r1: number, r2: number, h: number) {
  const hh = h / 2, c = Math.cos(Math.PI / n);
  const ap1 = r1 * c, ap2 = r2 * c;
  const L = Math.hypot(h, ap1 - ap2) || 1;
  const an = Math.PI / n;
  // signed distance to the side plane whose outward normal has angle 'a' in XZ
  const planeAt = (u: number, y: number) => ((u - ap1) * h + (y + hh) * (ap1 - ap2)) / L;
  const sideDist = (x: number, y: number, z: number) => {
    const a = Math.atan2(z, x);
    // side normals point at angles (2k+1)*an; b = angle from the nearest one
    const b = (((a % (2 * an)) + 2 * an) % (2 * an)) - an;
    return planeAt(Math.hypot(x, z) * Math.cos(b), y);
  };
  return {
    sideDist,
    sdf: (x: number, y: number, z: number) => Math.max(sideDist(x, y, z), y - hh, -y - hh),
    sideIndex: (x: number, z: number) => {
      const a = Math.atan2(z, x);
      return ((Math.round(a / (2 * an) - 0.5 + 1) % n) + n) % n;
    },
    /** depth inside, to side i only */
    sideDepth: (i: number, x: number, y: number, z: number) => {
      const a = (2 * Math.PI * (i - 0.5)) / n;
      return -planeAt(x * Math.cos(a) + z * Math.sin(a), y);
    },
    sidePlane: (i: number): { n: Vec3; p: Vec3 } => {
      const a = (2 * Math.PI * (i - 0.5)) / n;
      const ny = (ap1 - ap2) / L, nr = h / L;
      const apm = (ap1 + ap2) / 2;
      return { n: [Math.cos(a) * nr, ny, Math.sin(a) * nr], p: [Math.cos(a) * apm, 0, Math.sin(a) * apm] };
    },
  };
}

function extrudeSDF(d2: number, y: number, hh: number): number {
  const wx = d2, wy = Math.abs(y) - hh;
  const ox = Math.max(wx, 0), oy = Math.max(wy, 0);
  return Math.min(Math.max(wx, wy), 0) + Math.hypot(ox, oy);
}

export function compileObject(obj: SceneObject): CompiledObject {
  const t = obj.transform;
  const rot = eulerXYZ(t.rotation[0], t.rotation[1], t.rotation[2]);
  const scale: Vec3 = [
    Math.max(1e-4, Math.abs(t.scale[0])), Math.max(1e-4, Math.abs(t.scale[1])), Math.max(1e-4, Math.abs(t.scale[2])),
  ];
  const p = obj.params;
  let sdfLocal: CompiledObject['sdfLocal'];
  let faceAtLocal: CompiledObject['faceAtLocal'];
  let faces: FaceInfo[];
  const lb = emptyAABB();
  let profile: SampledProfile | undefined;
  let extrusion: CompiledObject['extrusion'];
  let frustum: CompiledObject['frustum'];
  let sweep: CompiledObject['sweep'];

  switch (obj.type) {
    case 'sphere': {
      const r = p.r!;
      sdfLocal = (x, y, z) => Math.hypot(x, y, z) - r;
      faceAtLocal = () => 'surface';
      faces = [{ id: 'surface', label: 'Surface' }];
      growAABB(lb, -r, -r, -r); growAABB(lb, r, r, r);
      break;
    }
    case 'box': {
      const hx = p.x! / 2, hy = p.y! / 2, hz = p.z! / 2;
      sdfLocal = (x, y, z) => {
        const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
      };
      faceAtLocal = (x, y, z) => {
        // Face whose plane is nearest, measured in world units so stretched boxes behave.
        const dx = Math.abs(hx - Math.abs(x)) * scale[0];
        const dy = Math.abs(hy - Math.abs(y)) * scale[1];
        const dz = Math.abs(hz - Math.abs(z)) * scale[2];
        if (dx <= dy && dx <= dz) return x >= 0 ? 'px' : 'nx';
        if (dy <= dz) return y >= 0 ? 'py' : 'ny';
        return z >= 0 ? 'pz' : 'nz';
      };
      faces = [
        { id: 'py', label: 'Top (+Y)', plane: { n: [0, 1, 0], p: [0, hy, 0] } },
        { id: 'ny', label: 'Bottom (−Y)', plane: { n: [0, -1, 0], p: [0, -hy, 0] } },
        { id: 'px', label: 'Right (+X)', plane: { n: [1, 0, 0], p: [hx, 0, 0] } },
        { id: 'nx', label: 'Left (−X)', plane: { n: [-1, 0, 0], p: [-hx, 0, 0] } },
        { id: 'pz', label: 'Front (+Z)', plane: { n: [0, 0, 1], p: [0, 0, hz] } },
        { id: 'nz', label: 'Back (−Z)', plane: { n: [0, 0, -1], p: [0, 0, -hz] } },
      ];
      extrusion = { poly: new Float64Array([-hx, -hz, hx, -hz, hx, hz, -hx, hz]), h: p.y! };
      growAABB(lb, -hx, -hy, -hz); growAABB(lb, hx, hy, hz);
      break;
    }
    case 'cylinder': {
      const r = p.r!, hh = p.h! / 2;
      sdfLocal = (x, y, z) => extrudeSDF(Math.hypot(x, z) - r, y, hh);
      faceAtLocal = (x, y, z) => {
        const side = Math.abs(r - Math.hypot(x, z)) * Math.min(scale[0], scale[2]);
        const top = Math.abs(hh - y) * scale[1], bot = Math.abs(hh + y) * scale[1];
        if (side <= top && side <= bot) return 'side';
        return top < bot ? 'top' : 'bottom';
      };
      faces = [
        { id: 'top', label: 'Top', plane: { n: [0, 1, 0], p: [0, hh, 0] } },
        { id: 'bottom', label: 'Bottom', plane: { n: [0, -1, 0], p: [0, -hh, 0] } },
        { id: 'side', label: 'Side' },
      ];
      profile = sampleRevolve(revolveOutline('cylinder', p, 1)!, ['bottom', 'side', 'top']);
      growAABB(lb, -r, -hh, -r); growAABB(lb, r, hh, r);
      break;
    }
    case 'cone': {
      const r = p.r!, h = p.h!, hh = h / 2;
      const outline = new Float64Array([0, -hh, r, -hh, 0, hh]);
      sdfLocal = (x, y, z) => polygonSDF(outline, 3, Math.hypot(x, z), y, 2).d;
      faceAtLocal = (x, y, z) => (polygonSDF(outline, 3, Math.hypot(x, z), y, 2).seg === 0 ? 'base' : 'side');
      faces = [
        { id: 'base', label: 'Base', plane: { n: [0, -1, 0], p: [0, -hh, 0] } },
        { id: 'side', label: 'Side' },
      ];
      profile = sampleRevolve([0, -hh, r, -hh, 0, hh], ['base', 'side']);
      growAABB(lb, -r, -hh, -r); growAABB(lb, r, hh, r);
      break;
    }
    case 'torus': {
      const R = p.R!, r = p.r!;
      sdfLocal = (x, y, z) => Math.hypot(Math.hypot(x, z) - R, y) - r;
      faceAtLocal = () => 'surface';
      faces = [{ id: 'surface', label: 'Surface' }];
      growAABB(lb, -R - r, -r, -R - r); growAABB(lb, R + r, r, R + r);
      break;
    }
    case 'capsule': {
      const r = p.r!, hh = p.h! / 2;
      sdfLocal = (x, y, z) => Math.hypot(x, y - clamp(y, -hh, hh), z) - r;
      faceAtLocal = () => 'surface';
      faces = [{ id: 'surface', label: 'Surface' }];
      growAABB(lb, -r, -hh - r, -r); growAABB(lb, r, hh + r, r);
      break;
    }
    case 'prism': {
      // Regular n-gon frustum: bottom circumradius r, top circumradius r2 (0 = point,
      // larger = flared). A convex polytope, so its SDF is the max of its planes
      // (exact inside and on the surface; a lower bound outside near edges).
      const n = Math.max(3, Math.round(p.n!)), r = p.r!, r2 = p.r2 ?? p.r!, hh = p.h! / 2;
      const fr = prismFrustum(n, r, r2, p.h!);
      sdfLocal = (x, y, z) => fr.sdf(x, y, z);
      faceAtLocal = (x, y, z) => {
        const sxz = Math.min(scale[0], scale[2]);
        const side = Math.abs(fr.sideDist(x, y, z)) * sxz;
        const top = Math.abs(hh - y) * scale[1], bot = Math.abs(hh + y) * scale[1];
        const hasTop = r2 > 1e-6, hasBot = r > 1e-6;
        if ((!hasTop || side <= top) && (!hasBot || side <= bot)) return `side${fr.sideIndex(x, z)}`;
        if (!hasBot) return 'top';
        if (!hasTop) return 'bottom';
        return top < bot ? 'top' : 'bottom';
      };
      faces = [
        ...(r2 > 1e-6 ? [{ id: 'top', label: 'Top', plane: { n: [0, 1, 0] as Vec3, p: [0, hh, 0] as Vec3 } }] : []),
        ...(r > 1e-6 ? [{ id: 'bottom', label: 'Bottom', plane: { n: [0, -1, 0] as Vec3, p: [0, -hh, 0] as Vec3 } }] : []),
      ];
      for (let i = 0; i < n; i++) faces.push({ id: `side${i}`, label: `Side ${i + 1}`, plane: fr.sidePlane(i) });
      frustum = { n, r1: r, r2, h: p.h! };
      const rm = Math.max(r, r2);
      growAABB(lb, -rm, -hh, -rm); growAABB(lb, rm, hh, rm);
      break;
    }
    case 'revolve': {
      const prof = sampleProfile(p.points ?? []);
      profile = prof;
      const pts = prof.pts, n = prof.n, skip = prof.axisSeg;
      sdfLocal = (x, y, z) => polygonSDF(pts, n, Math.hypot(x, z), y, skip).d;
      faceAtLocal = (x, y, z) => prof.segFace[polygonSDF(pts, n, Math.hypot(x, z), y, skip).seg] ?? 'span0';
      faces = prof.faces.map((f) => {
        if (f === 'top') return { id: f, label: 'Top cap', plane: { n: [0, 1, 0] as Vec3, p: [0, prof.yMax, 0] as Vec3 } };
        if (f === 'bottom') return { id: f, label: 'Bottom cap', plane: { n: [0, -1, 0] as Vec3, p: [0, prof.yMin, 0] as Vec3 } };
        return { id: f, label: `Span ${Number(f.slice(4)) + 1}` };
      });
      // Caps are planar only when the profile's end segment is horizontal.
      for (const f of faces) {
        if (f.id === 'top') f.plane!.p[1] = pts[2 * (n - 1) + 1];
        if (f.id === 'bottom') f.plane!.p[1] = pts[1];
      }
      growAABB(lb, -prof.rMax, prof.yMin, -prof.rMax); growAABB(lb, prof.rMax, prof.yMax, prof.rMax);
      break;
    }
    case 'sweep': {
      const path = buildSweepPath(p), sec = buildSweepSection(p);
      sweep = { path, sec };
      sdfLocal = (x, y, z) => sweepSDF(path, sec, x, y, z);
      faceAtLocal = (x, y, z) => {
        const { d2, cap, along } = sweepLocate(path, sec, x, y, z);
        if (path.loop || cap < d2 - 1e-9) return 'surface';
        return along < path.length / 2 ? 'start' : 'end';
      };
      faces = [{ id: 'surface', label: 'Surface' }];
      if (!path.loop) {
        const n = path.n - 1;
        faces.push(
          { id: 'start', label: 'Start end', plane: { n: [-path.T[0], -path.T[1], -path.T[2]], p: [path.P[0], path.P[1], path.P[2]] } },
          { id: 'end', label: 'Finish end', plane: { n: [path.T[3 * n], path.T[3 * n + 1], path.T[3 * n + 2]], p: [path.P[3 * n], path.P[3 * n + 1], path.P[3 * n + 2]] } },
        );
      }
      const r = Math.hypot(sec.hw, sec.hd);
      for (let i = 0; i < path.n; i++) { growAABB(lb, path.P[3 * i] - r, path.P[3 * i + 1] - r, path.P[3 * i + 2] - r); growAABB(lb, path.P[3 * i] + r, path.P[3 * i + 1] + r, path.P[3 * i + 2] + r); }
      break;
    }
    case 'part': throw new Error('placed parts are expanded before compiling');
  }

  const c: CompiledObject = {
    obj, rot, pos: [...t.position] as Vec3, scale, minScale: Math.min(scale[0], scale[1], scale[2]),
    sdfLocal: sdfLocal!, faceAtLocal: faceAtLocal!, faces: faces!, localBounds: lb, worldBounds: emptyAABB(),
    profile, extrusion, frustum, sweep,
  };
  const w: Vec3 = [0, 0, 0];
  for (let i = 0; i < 8; i++) {
    toWorld(c, i & 1 ? lb.max[0] : lb.min[0], i & 2 ? lb.max[1] : lb.min[1], i & 4 ? lb.max[2] : lb.min[2], w);
    growAABB(c.worldBounds, w[0], w[1], w[2]);
  }
  return c;
}

/** Wrap a plain outline (no axis points) as a SampledProfile with given per-segment faces. */
function sampleRevolve(outline: number[], segFaces: string[]): SampledProfile {
  const pts = new Float64Array(outline);
  const n = pts.length / 2;
  const segFace = [...segFaces];
  while (segFace.length < n - 1) segFace.push(segFaces[segFaces.length - 1]);
  segFace.length = n - 1;
  segFace.push('axis');
  let rMax = 0, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    rMax = Math.max(rMax, pts[2 * i]);
    yMin = Math.min(yMin, pts[2 * i + 1]);
    yMax = Math.max(yMax, pts[2 * i + 1]);
  }
  return { pts, n, segFace, axisSeg: n - 1, faces: [...new Set(segFaces)], rMax, yMin, yMax };
}

export function compileScene(objects: SceneObject[]): CompiledObject[] {
  // placed parts are expanded before building (engine/parts); nothing to compile here
  return objects.filter((o) => !o.hidden && o.type !== 'part').map(compileObject);
}

/** Which object/face of a scene a world-space surface point belongs to (nearest |sdf|). */
export function classifyPoint(
  objs: CompiledObject[], x: number, y: number, z: number, modes: SceneObject['mode'][] = ['shell', 'solid', 'subtract', 'cutout'],
): { obj: CompiledObject; face: string; dist: number } | null {
  let best: CompiledObject | null = null;
  let bd = Infinity;
  for (const c of objs) {
    if (!modes.includes(c.obj.mode)) continue;
    const d = Math.abs(sdfWorld(c, x, y, z));
    if (d < bd) { bd = d; best = c; }
  }
  if (!best) return null;
  return { obj: best, face: faceAtWorld(best, x, y, z), dist: bd };
}
