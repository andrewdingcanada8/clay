// Symmetry copies and the document as built.
//
// An object can be mirrored across a plane or repeated round an axis. The plane
// (or axis) goes through a reference object's centre along one of its local axes
// (a revolve's own axis is Y), or through the world origin. Copies are made when
// the scene is built, so they follow every edit of the original; their ids are
// `${original}~s${k}`, which picking maps back to the original (parts.placedId).
//
// A mirror is a reflection, which an object transform (rotation and scale) can't
// hold: the copy gets the reflected rotation times a flip of the object's own Z
// axis, and the flip goes into its parameters. Every primitive is symmetric under
// that flip except in what its parameters say: box faces ±Z swap, prism side k
// becomes side 1 − k, a sweep's path (or lift) coordinate along Z changes sign.

import { type PinHole, type SceneDoc, type SceneObject, type Symmetry, cloneDoc } from './document';
import { type Vec3, eulerXYZ } from './math';
import { flattenLayers } from './layers';
import { PART_SEP, eulerFromMatrix, expandParts, placedId } from './parts';

/** The document as built and drawn: the layer tree flattened into units (engine/layers;
 *  documents from before layers: parts expanded and symmetry copies added), and each
 *  object's edge rounding resolved (the larger of its own and its unit's). `notes`
 *  collects where the build approximates the layer tree. */
export function expandDoc(doc: SceneDoc, notes?: string[]): SceneDoc {
  if (Array.isArray(doc.root)) return resolveRound(flattenLayers(doc, notes));
  const parts = expandParts(doc);
  const hasSym = doc.objects.some((o) => o.sym && !o.hidden);
  const hasRound = parts.groups.some((g) => (g.round ?? 0) > 0);
  if (!hasSym && !hasRound) return parts;
  const out = parts === doc ? cloneDoc(doc) : parts;
  if (hasSym) addSymmetry(out, doc);
  return hasRound ? resolveRound(out) : out;
}

function resolveRound(out: SceneDoc): SceneDoc {
  if (out.groups.some((g) => (g.round ?? 0) > 0)) {
    const gr = new Map(out.groups.map((g) => [g.id, g.round ?? 0]));
    out.objects = out.objects.map((o) => {
      const r = Math.max(o.params.round ?? 0, gr.get(o.groupId) ?? 0);
      return r > 0 ? { ...o, params: { ...o.params, round: r } } : o;
    });
  }
  return out;
}

/** World centre and unit axis of a symmetry (its reference object's, or the world's). */
export function symFrame(doc: SceneDoc, sym: Symmetry): { c: Vec3; a: Vec3 } {
  const e: Vec3 = sym.axis === 'x' ? [1, 0, 0] : sym.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const ref = sym.ref ? doc.objects.find((o) => o.id === sym.ref) : null;
  if (!ref) return { c: [0, 0, 0], a: e };
  const R = eulerXYZ(...ref.transform.rotation);
  const a: Vec3 = [R[0] * e[0] + R[1] * e[1] + R[2] * e[2], R[3] * e[0] + R[4] * e[1] + R[5] * e[2], R[6] * e[0] + R[7] * e[1] + R[8] * e[2]];
  return { c: [...ref.transform.position] as Vec3, a };
}

/** Reflection across the plane through the origin square to unit axis a (row-major). */
export function reflection(a: Vec3): Float64Array {
  return new Float64Array([1 - 2 * a[0] * a[0], -2 * a[0] * a[1], -2 * a[0] * a[2], -2 * a[1] * a[0], 1 - 2 * a[1] * a[1], -2 * a[1] * a[2], -2 * a[2] * a[0], -2 * a[2] * a[1], 1 - 2 * a[2] * a[2]]);
}

/** Rotation by `ang` radians about unit axis a (row-major). */
export function axisAngle(a: Vec3, ang: number): Float64Array {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c, [x, y, z] = a;
  return new Float64Array([
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ]);
}

const mul = (A: Float64Array, B: Float64Array) => {
  const m = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
  return m;
};
const apply = (M: Float64Array, v: Vec3): Vec3 => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];

/** `o` moved by the linear map L about centre c; `flip` = L reflects (see the header). */
export function moved(o: SceneObject, L: Float64Array, c: Vec3, flip: boolean, id: string): SceneObject {
  const t = o.transform;
  let R = mul(L, eulerXYZ(...t.rotation));
  if (flip) R = R.map((v, i) => (i % 3 === 2 ? -v : v)); // times diag(1, 1, -1)
  const p = apply(L, [t.position[0] - c[0], t.position[1] - c[1], t.position[2] - c[2]]);
  const copy: SceneObject = JSON.parse(JSON.stringify(o));
  copy.id = id;
  copy.sym = undefined;
  copy.transform = { position: [p[0] + c[0], p[1] + c[1], p[2] + c[2]], rotation: eulerFromMatrix(R), scale: [...t.scale] as Vec3 };
  if (flip) flipZ(copy);
  return copy;
}

/** Mirror an object's own shape in its local Z (see the header). */
function flipZ(o: SceneObject) {
  const swap: Record<string, string> = { pz: 'nz', nz: 'pz' };
  if (o.type === 'box') o.holes = o.holes.map((f) => swap[f] ?? f);
  if (o.type === 'prism') {
    const n = Math.max(3, Math.round(o.params.n ?? 6));
    o.holes = o.holes.map((f) => (f.startsWith('side') ? `side${(((1 - Number(f.slice(4))) % n) + n) % n}` : f));
  }
  if (o.type === 'sweep') {
    const p = o.params;
    // plane xy: Z is the lift; xz: Z is the path's second coordinate; yz: its first
    if ((p.plane ?? 'xy') === 'xy') p.lift = (p.lift ?? []).map((q) => ({ ...q, y: -q.y }));
    else if (p.plane === 'xz') p.path = (p.path ?? []).map((q) => ({ ...q, y: -q.y }));
    else p.path = (p.path ?? []).map((q) => ({ ...q, r: -q.r }));
  }
}

function addSymmetry(out: SceneDoc, src: SceneDoc) {
  const syms = new Map(src.objects.filter((o) => o.sym && !o.hidden).map((o) => [o.id, o.sym!]));
  const extra: SceneObject[] = [];
  const pins: PinHole[] = [];
  for (const o of out.objects) {
    const sym = syms.get(placedId(o.id));
    if (!sym) continue;
    const { c, a } = symFrame(src, sym);
    const maps: { L: Float64Array; flip: boolean }[] = [];
    if (sym.kind === 'mirror') {
      maps.push({ L: reflection(a), flip: true });
    } else {
      const n = Math.max(2, Math.min(64, Math.round(sym.count)));
      for (let k = 1; k < n; k++) maps.push({ L: axisAngle(a, (2 * Math.PI * k) / n), flip: false });
    }
    maps.forEach(({ L, flip }, k) => {
      const id = `${o.id}${PART_SEP}s${k + 1}`;
      extra.push(moved(o, L, c, flip, id));
      for (const pin of out.pins.filter((q) => q.objectId === o.id)) {
        const f = flip ? -1 : 1;
        pins.push({ ...pin, id: `${pin.id}${PART_SEP}s${k + 1}`, objectId: id, point: [pin.point[0], pin.point[1], pin.point[2] * f], normal: [pin.normal[0], pin.normal[1], pin.normal[2] * f] });
      }
    });
  }
  out.objects.push(...extra);
  out.pins.push(...pins);
}
