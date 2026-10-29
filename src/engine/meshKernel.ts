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
import { type Quality, type SceneDoc, isCut } from './document';
import { type BuildResult, Timer } from './kernel';
import type { Vec3 } from './math';
import { edgeStats } from './meshCheck';
import { type CompiledObject, compileScene, normalToWorld, revolveOutline, toWorld } from './primitives';
import { type SweepSpin, sectionRing, sweepParts } from './sweep';
import { pinDepth } from './scene';

let wasmPromise: Promise<ManifoldToplevel> | null = null;
let wasmUrl: string | undefined;

/** Browser builds pass the bundled .wasm URL (Node resolves it on its own). */
export function setManifoldWasmUrl(url: string): void {
  wasmUrl = url;
}

export function getManifold(): Promise<ManifoldToplevel> {
  if (!wasmPromise) {
    // A data: URL (single-file build) is decoded here rather than fetched, since
    // strict content policies can block fetch() of data: URLs.
    let opts: object | undefined;
    if (wasmUrl?.startsWith('data:')) {
      const b64 = wasmUrl.slice(wasmUrl.indexOf(',') + 1);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      opts = { wasmBinary: bytes.buffer };
    } else if (wasmUrl) opts = { locateFile: () => wasmUrl };
    wasmPromise = (Module as unknown as (o?: object) => Promise<ManifoldToplevel>)(opts).then((w) => {
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
    const M = 50; // generous margin for offsets
    const rightHalf = (cs: CrossSection) => keep(cs.intersect(keep(CrossSection.square([bb.max[0] + M, (bb.max[1] - bb.min[1]) + 2 * M]).translate([0, bb.min[1] - M]))));
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
    const sharp = (delta: number) => make(keep(cs.offset(delta, delta < 0 ? 'Miter' : 'Round', 4, segs)), H + 2 * delta);
    // rounded edges: the box shrunk by r, grown back by a ball (its hollow: by a
    // ball of r - t, or just shrunk by t once the wall is thicker than r)
    const r = c.round * c.minScale;
    if (r > 0) {
      const core = sharp(-r);
      return {
        solid: core ? rounded(core, r)! : make(cs, H)!,
        cavity: (delta) => (core && r + delta > 0.01 ? rounded(core, r + delta) : sharp(delta)),
        approx: false,
      };
    }
    return { solid: make(cs, H)!, cavity: sharp, approx: false };
  };
  // a convex solid grown by a ball of radius r (rounded edges and corners)
  const rounded = (m: Manifold, r: number) => keep(m.minkowskiSum(keep(Manifold.sphere(r, Math.max(12, Math.round(segs / 2))))));

  // Prism: regular n-gon frustum. Its inward offset is again a frustum (each plane
  // moved in by t), computed exactly in world units.
  const frustumFrom = (c: CompiledObject, f: NonNullable<CompiledObject['frustum']>): Built => {
    const [sx, sy, sz] = c.scale;
    const uniformXZ = Math.abs(sx - sz) < 1e-6;
    const k = uniformXZ ? sx : Math.sqrt(sx * sz);
    const mat = uniformXZ ? placeMat(c) : placeMat(c, sx / k, 1, sz / k);
    const cosA = Math.cos(Math.PI / f.n);
    const make = (R1: number, R2: number, yb: number, yt: number) => {
      const H = yt - yb;
      if (H <= 1e-6 || Math.max(R1, R2) <= 1e-6) return null;
      const big = Math.max(R1, R2), small = Math.min(R1, R2);
      const pts: [number, number][] = [];
      for (let i = 0; i < f.n; i++) {
        const a = (2 * Math.PI * i) / f.n;
        pts.push([big * Math.cos(a), -big * Math.sin(a)]);
      }
      const cs = keep(new CrossSection([ccw(pts)], 'Positive'));
      let m = keep(keep(cs.extrude(H, 0, 0, [small / big, small / big])).translate([0, 0, -H / 2]));
      if (R1 < R2) m = keep(m.mirror([0, 0, 1])); // wide end on top
      m = keep(toY(m).translate([0, (yb + yt) / 2, 0]));
      return keep(m.transform(mat as never));
    };
    const R1 = f.r1 * k, R2 = f.r2 * k, H = f.h * sy;
    const inward = (delta: number) => {
        const t = -delta; // inward offset
        const A1 = R1 * cosA, A2 = R2 * cosA, L = Math.hypot(H, A1 - A2);
        const u = (y: number) => A1 + ((A2 - A1) * (y + H / 2)) / H - (t * L) / H;
        let yb = -H / 2 + t, yt = H / 2 - t;
        if (yt <= yb) return null;
        let ab = u(yb), at = u(yt);
        if (ab <= 0 && at <= 0) return null;
        // clip at the apex where the offset sides meet
        if (ab < 0 || at < 0) {
          const y0 = -H / 2 + (((t * L) / H - A1) * H) / (A2 - A1);
          if (ab < 0) { yb = y0; ab = 0; } else { yt = y0; at = 0; }
        }
        return make(ab / cosA, at / cosA, yb, yt);
    };
    // rounded edges: shrunk by r, grown back by a ball (as the box)
    const r = c.round * Math.min(k, sy);
    const core = r > 0 ? inward(-r) : null;
    return {
      solid: core ? rounded(core, r) : make(R1, R2, -H / 2, H / 2)!,
      approx: !uniformXZ,
      cavity: (delta) => (core && r + delta > 0.01 ? rounded(core, r + delta) : inward(delta)),
    };
  };

  const union = (ms: (Manifold | null)[]): Manifold | null => {
    const list = ms.filter((m): m is Manifold => !!m && !m.isEmpty());
    if (!list.length) return null;
    return list.length === 1 ? list[0] : keep(Manifold.union(list));
  };

  // Sweep: the section ring swept along the path (tube runs, plus revolved pieces at
  // round corners and caps); the hollow is the same with the section offset inward
  // and the ends pulled in by the wall.
  const sweepFrom = (c: CompiledObject): Built => {
    const { path, sec, style } = c.sweep!;
    const [sx, sy, sz] = c.scale;
    const uniform = Math.abs(sx - sy) < 1e-6 && Math.abs(sx - sz) < 1e-6;
    const k = uniform ? sx : Math.cbrt(sx * sy * sz);
    const mat = placeMat(c, sx, sy, sz);
    const make = (mesh: { positions: Float32Array; indices: Uint32Array }) => {
      if (!mesh.indices.length) return null;
      const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
      m.merge();
      return keep(keep(new Manifold(m)).transform(mat as never));
    };
    // a revolved piece: the ring (u, v) mapped into the plane of `out` and `axis`,
    // revolved about `axis` through V, and kept on the given sides
    const spinOf = (sp: SweepSpin, ring2: number[]) => {
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const pts: [number, number][] = [];
      for (let i = 0; i < ring2.length; i += 2) {
        const u = ring2[i], v = ring2[i + 1];
        pts.push([u * dot(sp.n, sp.out) + v * dot(sp.b, sp.out), u * dot(sp.n, sp.axis) + v * dot(sp.b, sp.axis)]);
      }
      let cs = keep(new CrossSection([ccw(pts)], 'Positive'));
      if (sp.mirror) cs = keep(cs.add(keep(cs.mirror([1, 0]))));
      const y = cross(sp.axis as Vec3, sp.out as Vec3);
      let m = keep(keep(cs.revolve(segs)).transform([...sp.out, 0, ...y, 0, ...sp.axis, 0, ...sp.V, 1] as never));
      for (const k of sp.keep) m = keep(m.trimByPlane(k as Vec3, dot(k, sp.V)));
      return m.isEmpty() ? null : keep(m.transform(mat as never));
    };
    const solidOf = (ring2: number[], ends: Parameters<typeof sweepParts>[3]) => {
      const { runs, spins } = sweepParts(path, ring2, style, ends);
      return union([...runs.map(make), ...spins.map((sp) => spinOf(sp, ring2))]);
    };
    const ring = sectionRing(sec, segs);
    const pairs: [number, number][] = [];
    for (let i = 0; i < ring.length; i += 2) pairs.push([ring[i], ring[i + 1]]);
    const roundCap = style.cap === 'round', ext = style.cap === 'square' ? sec.hd : 0;
    return {
      solid: solidOf(ring, { start: ext, end: ext, roundStart: roundCap, roundEnd: roundCap })!,
      approx: !uniform,
      cavity: (delta) => {
        const t = -delta / k; // inward, in sweep units
        const inner = keep(keep(new CrossSection([pairs], 'Positive')).offset(-t, 'Round', 2, segs));
        if (inner.isEmpty()) return null;
        const polys = inner.toPolygons();
        let big = polys[0], area = 0;
        for (const q of polys) { const a = Math.abs(signedArea(q as [number, number][])); if (a > area) { area = a; big = q; } }
        // an open end: the hollow runs straight out through it; a round cap's hollow
        // is the inner section spun the same way; otherwise it stops a wall short
        const open = (f: string) => c.obj.holes.includes(f);
        const out = 2 * t + 0.5;
        const end = (f: string) => (open(f) ? out : roundCap ? 0 : ext - t);
        return solidOf((ccw(big as [number, number][]) as [number, number][]).flat(),
          { start: end('start'), end: end('end'), roundStart: roundCap && !open('start'), roundEnd: roundCap && !open('end') });
      },
    };
  };

  const build = (c: CompiledObject): Built => {
    if (c.sweep) return sweepFrom(c);
    if (c.frustum) return frustumFrom(c, c.frustum);
    if (c.extrusion) return extrudeFrom(c, c.extrusion.poly, c.extrusion.h);
    // revolves and rounded cylinders and cones: the (rounded) profile itself
    const outline = c.obj.type === 'revolve' || c.round > 0
      ? Array.from(c.profile!.pts)
      : revolveOutline(c.obj.type, c.obj.params, segs)!;
    return revolveFrom(c, outline);
  };

  const built = new Map<string, Built>();
  for (const c of objs) built.set(c.obj.id, build(c));
  timer.lap('primitives');


  const byId = new Map(objs.map((o) => [o.obj.id, o]));
  const pinCylinder = (pin: SceneDoc['pins'][number], t: number, hollow: boolean): Manifold | null => {
    const o = byId.get(pin.objectId);
    if (!o) return null;
    const c: Vec3 = [0, 0, 0];
    toWorld(o, pin.point[0], pin.point[1], pin.point[2], c);
    const n = normalToWorld(o, pin.normal[0], pin.normal[1], pin.normal[2]);
    const out = Math.max(0.5, pin.radius);
    const depth = pinDepth(hollow ? t : null, pin.radius);
    // cylinder along +Z from 0..len, then align +Z with -n and start outside
    const cyl = keep(Manifold.cylinder(out + depth, pin.radius, pin.radius, Math.max(16, Math.round(segs / 2))));
    const z: Vec3 = [-n[0], -n[1], -n[2]];
    const a: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const xv = norm(cross(a, z));
    const yv = cross(z, xv);
    const start: Vec3 = [c[0] + n[0] * out, c[1] + n[1] * out, c[2] + n[2] * out];
    return keep(cyl.transform([...xv, 0, ...yv, 0, ...z, 0, ...start, 1] as never));
  };

  // Each group: (shell ∪ solid) − (cavity ∪ subtract ∪ pins), the cavity hollowed from
  // (shell − closed cuts). Groups never cut each other.
  const groupResults: Manifold[] = [];
  for (const g of doc.groups) {
    const members = objs.filter((c) => c.obj.groupId === g.id);
    const shells = members.filter((c) => c.obj.mode === 'shell');
    const solids = members.filter((c) => c.obj.mode === 'solid');
    const subs = members.filter((c) => isCut(c.obj.mode));
    const t = Math.max(0.01, g.thickness);
    if ((g.blend ?? 0) > 0) warnings.push(`${g.name}: smooth blend needs the SDF kernel; shown as a sharp union`);
    if ((g.round ?? 0) > 0 && subs.length) warnings.push(`${g.name}: rounded cut rims need the SDF kernel; shown sharp`);
    const shellU = union(shells.map((c) => built.get(c.obj.id)!.solid));
    const material = union([shellU, ...solids.map((c) => built.get(c.obj.id)!.solid)]);
    if (!material) continue;
    const cuts: (Manifold | null)[] = subs.map((c) => built.get(c.obj.id)!.solid);
    const hollow = shell && !!shellU;
    if (hollow && shellU) {
      // Subtract objects are carved before hollowing: they keep a wall of thickness t
      // around them, so the cavity stays that far away. Cutouts cut through it all.
      const ball = keep(Manifold.sphere(t, Math.max(12, Math.round(segs / 3))));
      const closed = union(subs.filter((c) => c.obj.mode === 'subtract').map((c) => built.get(c.obj.id)!.solid));
      let cavity: Manifold | null;
      if (doc.meshMethod === 'minkowski') {
        cavity = keep((closed ? keep(shellU.subtract(closed)) : shellU).minkowskiDifference(ball));
      } else {
        cavity = union(shells.map((c) => built.get(c.obj.id)!.cavity(-t)));
      }
      const cavCuts: (Manifold | null)[] = [];
      for (const c of shells) if (built.get(c.obj.id)!.approx) warnings.push(`${c.obj.name}: X/Z scale differs, wall thickness approximate`);
      // Openings: extrude the cavity next to each hole face straight out through it.
      if (cavity && !cavity.isEmpty()) {
        for (const c of shells) {
          // world normals of this object's flat openings
          const openN: Vec3[] = [];
          for (const fid of c.obj.holes) {
            if (c.sweep && (fid === 'start' || fid === 'end')) continue;
            const pl = c.faces.find((f) => f.id === fid)?.plane;
            if (pl) openN.push(normalToWorld(c, ...pl.n));
          }
          for (const fid of c.obj.holes) {
            if (c.sweep && (fid === 'start' || fid === 'end')) continue; // the sweep's hollow opens its own ends
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
            // Sweep out through this face, and also toward neighbouring open faces so
            // the strip of wall where two openings meet goes too (no ridge at the corner).
            const dirs = [n, ...openN.filter((m) => m !== n && Math.abs(m[0] - n[0]) + Math.abs(m[1] - n[1]) + Math.abs(m[2] - n[2]) > 1e-6
              && m[0] * n[0] + m[1] * n[1] + m[2] * n[2] > -0.5)].slice(0, 4);
            const moved: Manifold[] = [slab];
            for (let mask = 1; mask < 1 << dirs.length; mask++) {
              const v: Vec3 = [0, 0, 0];
              dirs.forEach((m, i) => { if (mask & (1 << i)) { v[0] += m[0] * d; v[1] += m[1] * d; v[2] += m[2] * d; } });
              moved.push(keep(slab.translate(v)));
            }
            cavCuts.push(keep(Manifold.hull(moved)));
          }
        }
      }
      cavCuts.push(cavity);
      let cav = union(cavCuts);
      if (cav && closed && doc.meshMethod !== 'minkowski') cav = keep(cav.subtract(keep(closed.minkowskiSum(ball))));
      cuts.push(cav);
    }
    const memberIds = new Set(members.map((c) => c.obj.id));
    for (const pin of doc.pins) if (memberIds.has(pin.objectId)) cuts.push(pinCylinder(pin, t, hollow));
    const cutU = union(cuts);
    groupResults.push(cutU ? keep(material.subtract(cutU)) : material);
  }
  timer.lap('groups');
  const result = union(groupResults);
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
