// Kernel B — boundary-representation meshes with exact booleans (manifold-3d).
//
// Shelling on meshes, two methods:
//   offset    — each primitive's inward offset is built exactly from its 2D
//               profile (2D erosion via Clipper, then revolve/extrude). Cavity =
//               union of those offsets. Exact for single primitives; at junctions
//               between joined primitives the wall comes out slightly thicker,
//               because a union of offsets is smaller than the offset of a union.
//   minkowski — cavity = exact erosion of the whole joined form by a ball
//               (Manifold minkowskiDifference). Exact everywhere, but slow.
// Openings: for each hole face (planar faces only), the cavity next to that face is
// extruded straight out through the face (hull of a thin slab), then subtracted.

import Module from 'manifold-3d';
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Quality, SceneDoc } from './document';
import { type BuildResult, Timer } from './kernel';
import type { Vec3 } from './math';
import { edgeStats } from './meshCheck';
import { type CompiledObject, compileScene, normalToWorld, revolveOutline, toWorld } from './primitives';

let wasmPromise: Promise<ManifoldToplevel> | null = null;
let wasmUrl: string | undefined;

/** Browser builds pass the bundled .wasm URL (Node resolves it on its own). */
export function setManifoldWasmUrl(url: string): void {
  wasmUrl = url;
}

export function getManifold(): Promise<ManifoldToplevel> {
  if (!wasmPromise) {
    wasmPromise = (Module as unknown as (o?: object) => Promise<ManifoldToplevel>)(
      wasmUrl ? { locateFile: () => wasmUrl } : undefined,
    ).then((w) => {
      w.setup();
      return w;
    });
  }
  return wasmPromise;
}

const SEGMENTS: Record<Quality, number> = { draft: 32, normal: 72, fine: 128 };

function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

function ccw(pts: [number, number][]): [number, number][] {
  return signedArea(pts) < 0 ? [...pts].reverse() : pts;
}

export async function buildMeshKernel(doc: SceneDoc, quality: Quality): Promise<BuildResult> {
  const timer = new Timer();
  const wasm = await getManifold();
  timer.lap('wasm');
  const { Manifold, CrossSection } = wasm;
  const warnings: string[] = [];
  const trash: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };
  const segs = SEGMENTS[quality];
  const shell = doc.shell.enabled;
  const t = Math.max(0.01, doc.shell.thickness);
  const objs = compileScene(doc.objects);

  // Placement without scale (scale is baked into the profiles where exact).
  const placeMat = (c: CompiledObject, sx = 1, sy = 1, sz = 1): number[] => {
    const r = c.rot;
    // column-major 4x4 of R * S + T
    return [
      r[0] * sx, r[3] * sx, r[6] * sx, 0,
      r[1] * sy, r[4] * sy, r[7] * sy, 0,
      r[2] * sz, r[5] * sz, r[8] * sz, 0,
      c.pos[0], c.pos[1], c.pos[2], 1,
    ];
  };
  const toY = (m: Manifold) => keep(m.rotate([-90, 0, 0])); // Z-up (Manifold) -> Y-up

  interface Built { solid: Manifold; cavity: (delta: number) => Manifold | null; approx: boolean }

  // Revolve family: (r,y) outline, mirrored across the axis for offsetting.
  const revolveFrom = (c: CompiledObject, outline: number[]): Built => {
    const [sx, sy, sz] = c.scale;
    const uniformXZ = Math.abs(sx - sz) < 1e-6;
    const kr = uniformXZ ? sx : 1, ky = uniformXZ ? sy : 1;
    const pts: [number, number][] = [];
    for (let i = 0; i < outline.length; i += 2) pts.push([Math.max(0, outline[i]) * kr, outline[i + 1] * ky]);
    const half = keep(new CrossSection([ccw(pts)], 'Positive'));
    const mirrored = keep(half.mirror([1, 0]));
    const full = keep(half.add(mirrored));
    const bb = full.bounds();
    const rightHalf = (cs: CrossSection) => keep(cs.intersect(keep(CrossSection.square([bb.max[0] + 10 * t + 10, (bb.max[1] - bb.min[1]) + 20 * t + 20]).translate([0, bb.min[1] - 10 * t - 10]))));
    const mat = uniformXZ ? placeMat(c) : placeMat(c, sx, sy, sz);
    const make = (cs: CrossSection) => {
      if (cs.isEmpty()) return null;
      const m = toY(keep(cs.revolve(segs)));
      return keep(m.transform(mat as never));
    };
    const scaleT = uniformXZ ? 1 : 1 / Math.sqrt(sx * sz);
    return {
      solid: make(rightHalf(full))!,
      cavity: (delta) => make(rightHalf(keep(full.offset(delta * scaleT, 'Round', 2, segs)))),
      approx: !uniformXZ,
    };
  };

  // Extrusion family: convex polygon in XZ extruded along Y.
  const extrudeFrom = (c: CompiledObject, poly: Float64Array, h: number): Built => {
    const [sx, sy, sz] = c.scale;
    const pts: [number, number][] = [];
    for (let i = 0; i < poly.length; i += 2) pts.push([poly[i] * sx, -poly[i + 1] * sz]);
    const cs = keep(new CrossSection([ccw(pts)], 'Positive'));
    const H = h * sy;
    const make = (sec: CrossSection, height: number) => {
      if (sec.isEmpty() || height <= 0) return null;
      const m = toY(keep(keep(sec.extrude(height)).translate([0, 0, -height / 2])));
      return keep(m.transform(placeMat(c) as never));
    };
    return {
      solid: make(cs, H)!,
      cavity: (delta) => make(keep(cs.offset(delta, delta < 0 ? 'Miter' : 'Round', 4, segs)), H + 2 * delta),
      approx: false,
    };
  };

  const build = (c: CompiledObject): Built => {
    if (c.extrusion) return extrudeFrom(c, c.extrusion.poly, c.extrusion.h);
    const outline = c.obj.type === 'revolve'
      ? Array.from(c.profile!.pts)
      : revolveOutline(c.obj.type, c.obj.params, segs)!;
    return revolveFrom(c, outline);
  };

  const built = new Map<string, Built>();
  for (const c of objs) built.set(c.obj.id, build(c));
  timer.lap('primitives');

  const of = (mode: string) => objs.filter((c) => c.obj.mode === mode);
  const union = (ms: (Manifold | null)[]): Manifold | null => {
    const list = ms.filter((m): m is Manifold => !!m && !m.isEmpty());
    if (!list.length) return null;
    return list.length === 1 ? list[0] : keep(Manifold.union(list));
  };
  const joins = of('join'), cuts = of('cut'), solids = of('solid');
  let form = union(joins.map((c) => built.get(c.obj.id)!.solid));
  const cutU = union(cuts.map((c) => built.get(c.obj.id)!.solid));
  if (form && cutU) form = keep(form.subtract(cutU));
  timer.lap('union');

  let result: Manifold | null = form;
  if (form && shell) {
    let cavity: Manifold | null;
    if (doc.meshMethod === 'minkowski') {
      const ball = keep(Manifold.sphere(t, Math.max(12, Math.round(segs / 3))));
      cavity = keep(form.minkowskiDifference(ball));
    } else {
      cavity = union(joins.map((c) => built.get(c.obj.id)!.cavity(-t)));
      const dil = union(cuts.map((c) => built.get(c.obj.id)!.cavity(t)));
      if (cavity && dil) cavity = keep(cavity.subtract(dil));
    }
    timer.lap('cavity');
    for (const c of joins) if (built.get(c.obj.id)!.approx) warnings.push(`${c.obj.name}: X/Z scale differs, wall thickness approximate`);

    // Openings: extrude the cavity next to each hole face straight out through it.
    const exts: Manifold[] = [];
    if (cavity && !cavity.isEmpty()) {
      for (const c of joins) {
        for (const fid of c.obj.holes) {
          const face = c.faces.find((f) => f.id === fid);
          if (!face?.plane) {
            warnings.push(`${c.obj.name}: opening on curved face "${fid}" not supported by the mesh kernel`);
            continue;
          }
          const n = normalToWorld(c, ...face.plane.n);
          const p: Vec3 = [0, 0, 0];
          toWorld(c, face.plane.p[0], face.plane.p[1], face.plane.p[2], p);
          const delta = 0.3 * t + 0.02;
          const own = doc.meshMethod === 'minkowski'
            ? keep(cavity.intersect(built.get(c.obj.id)!.solid))
            : built.get(c.obj.id)!.cavity(-t);
          if (!own) continue;
          const slab = keep(own.trimByPlane(n, n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - t - delta));
          if (slab.isEmpty()) continue;
          const d = 2 * (t + delta);
          exts.push(keep(Manifold.hull([slab, keep(slab.translate([n[0] * d, n[1] * d, n[2] * d]))])));
        }
      }
    }
    const hollow = union([cavity, ...exts]);
    if (hollow) result = keep(form.subtract(hollow));
    timer.lap('shell');
  }

  // Solid additions, then pin holes through everything.
  const solidU = union(solids.map((c) => built.get(c.obj.id)!.solid));
  if (solidU) result = result ? keep(result.add(solidU)) : solidU;
  const byId = new Map(objs.map((o) => [o.obj.id, o]));
  const pins: Manifold[] = [];
  for (const pin of doc.pins) {
    const o = byId.get(pin.objectId);
    if (!o) continue;
    const c: Vec3 = [0, 0, 0];
    toWorld(o, pin.point[0], pin.point[1], pin.point[2], c);
    const n = normalToWorld(o, pin.normal[0], pin.normal[1], pin.normal[2]);
    const out = Math.max(0.5, pin.radius);
    const depth = (shell ? t : pin.radius * 4) * 1.6 + 0.05;
    const len = out + depth;
    // cylinder along +Z from 0..len, then align +Z with -n and start outside
    const cyl = keep(Manifold.cylinder(len, pin.radius, pin.radius, Math.max(16, Math.round(segs / 2))));
    const z: Vec3 = [-n[0], -n[1], -n[2]];
    const a: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const xv = norm(cross(a, z));
    const yv = cross(z, xv);
    const start: Vec3 = [c[0] + n[0] * out, c[1] + n[1] * out, c[2] + n[2] * out];
    pins.push(keep(cyl.transform([...xv, 0, ...yv, 0, ...z, 0, ...start, 1] as never)));
  }
  const pinU = union(pins);
  if (result && pinU) result = keep(result.subtract(pinU));
  timer.lap('finish');

  let positions = new Float32Array(0);
  let indices = new Uint32Array(0);
  if (result && !result.isEmpty()) {
    const mesh = result.getMesh();
    const np = mesh.numProp;
    positions = new Float32Array(mesh.numVert * 3);
    for (let i = 0; i < mesh.numVert; i++) {
      positions[3 * i] = mesh.vertProperties[np * i];
      positions[3 * i + 1] = mesh.vertProperties[np * i + 1];
      positions[3 * i + 2] = mesh.vertProperties[np * i + 2];
    }
    indices = new Uint32Array(mesh.triVerts);
  }
  for (const m of trash) {
    try { m.delete(); } catch { /* already freed */ }
  }
  timer.lap('extract');
  const es = edgeStats(indices, positions.length / 3);
  return {
    positions, indices,
    stats: {
      kernel: `mesh/${doc.meshMethod}`, triangles: indices.length / 3, vertices: positions.length / 3,
      boundaryEdges: es.boundary, nonManifoldEdges: es.nonManifold, warnings, timings: timer.timings, totalMs: timer.total(),
    },
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
