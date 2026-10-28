// Parts: a saved group placed in a piece like a primitive. A placed part is
// finished geometry, which is exactly what a group is (groups never cut each
// other), so for building and drawing each placed part expands into its own group
// of transformed objects. Placed as "Cut", its outer envelope (its Shell and Solid
// objects) is carved from the group it sits in.
//
// Parts scale uniformly: a non-uniform scale of a rotated object is a shear, which
// an object transform can't hold.

import { type PartDef, type SceneDoc, type SceneObject, type Transform, cloneDoc, newId } from './document';
import { DEG, type Vec3, eulerXYZ, mulMat3Vec } from './math';

/** Separates a placed part's id from its inner object ids in expanded ids. */
export const PART_SEP = '~';

/** The placed object (top level) an expanded object id came from. */
export function placedId(id: string): string {
  const i = id.indexOf(PART_SEP);
  return i < 0 ? id : id.slice(0, i);
}

/** Uniform scale of a placed part (the mean of its three scale values). */
export function partScale(t: Transform): number {
  return (Math.abs(t.scale[0]) + Math.abs(t.scale[1]) + Math.abs(t.scale[2])) / 3;
}

function mulMat3(a: Float64Array, b: Float64Array): Float64Array {
  const m = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return m;
}

/** Euler XYZ degrees (three.js order) of a rotation matrix, row-major. */
export function eulerFromMatrix(m: Float64Array): Vec3 {
  const y = Math.asin(Math.max(-1, Math.min(1, m[2])));
  let x: number, z: number;
  if (Math.abs(m[2]) < 0.9999999) { x = Math.atan2(-m[5], m[8]); z = Math.atan2(-m[1], m[0]); }
  else { x = Math.atan2(m[7], m[4]); z = 0; }
  return [x / DEG, y / DEG, z / DEG];
}

/** The transform of an object placed in part space, once the part is placed by `outer`. */
export function composeTransform(outer: Transform, inner: Transform): Transform {
  const s = partScale(outer);
  const Ro = eulerXYZ(...outer.rotation);
  const R = mulMat3(Ro, eulerXYZ(...inner.rotation));
  const p: Vec3 = [0, 0, 0];
  mulMat3Vec(Ro, inner.position[0] * s, inner.position[1] * s, inner.position[2] * s, p);
  return {
    position: [p[0] + outer.position[0], p[1] + outer.position[1], p[2] + outer.position[2]],
    rotation: eulerFromMatrix(R),
    scale: [inner.scale[0] * s, inner.scale[1] * s, inner.scale[2] * s],
  };
}

/**
 * The document as built and drawn: every placed part replaced by a group of its
 * objects (or, for a Cut, by subtract objects in its own group). Inner ids are
 * `${placed id}~${inner id}`; nested parts expand the same way.
 */
export function expandParts(doc: SceneDoc): SceneDoc {
  if (!doc.objects.some((o) => o.type === 'part')) return doc;
  const out = cloneDoc(doc);
  out.objects = [];
  out.pins = doc.pins.filter((p) => doc.objects.find((o) => o.id === p.objectId)?.type !== 'part');
  const defs = new Map<string, PartDef>();
  const addDefs = (list?: PartDef[]) => { for (const d of list ?? []) { if (!defs.has(d.id)) defs.set(d.id, d); addDefs(d.parts); } };
  addDefs(doc.parts);

  const place = (o: SceneObject, depth: number) => {
    if (o.type !== 'part') { out.objects.push(o); return; }
    const def = defs.get(o.params.part ?? '');
    if (!def || o.hidden || depth > 4) return;
    if (o.mode === 'subtract') {
      // carve the part's outer envelope from the group it was placed in
      for (const inner of def.objects) {
        if (inner.mode === 'subtract' || inner.type === 'part' || inner.hidden) continue;
        const c: SceneObject = JSON.parse(JSON.stringify(inner));
        out.objects.push({ ...c, id: `${o.id}${PART_SEP}${inner.id}`, mode: 'subtract', groupId: o.groupId, holes: [], transform: composeTransform(o.transform, inner.transform) });
      }
      return;
    }
    const gid = `${o.id}${PART_SEP}g`;
    const s = partScale(o.transform); // the wall and blend scale with the part
    out.groups.push({ id: gid, name: o.name, thickness: def.thickness * s, blend: (def.blend ?? 0) * s });
    for (const inner of def.objects) {
      const c: SceneObject = JSON.parse(JSON.stringify(inner));
      c.id = `${o.id}${PART_SEP}${inner.id}`;
      c.groupId = gid;
      c.transform = composeTransform(o.transform, inner.transform);
      if (!def.hollow && c.mode === 'shell') c.mode = 'solid';
      if (c.type === 'part') { place(c, depth + 1); continue; }
      out.objects.push(c);
    }
    for (const pin of def.pins) {
      out.pins.push({ ...pin, id: `${o.id}${PART_SEP}${pin.id}`, objectId: `${o.id}${PART_SEP}${pin.objectId}`, radius: pin.radius * s });
    }
  };
  for (const o of doc.objects) place(o, 0);
  return out;
}

/**
 * Save group `groupId` of `doc` as a part. Objects move into part space: centred
 * on the group's footprint, standing on the ground (y = 0 at its lowest point).
 */
export function makePartDef(doc: SceneDoc, groupId: string, name: string, bounds: { min: Vec3; max: Vec3 }): PartDef {
  const g = doc.groups.find((x) => x.id === groupId)!;
  const objects = doc.objects.filter((o) => o.groupId === groupId);
  const ids = new Set(objects.map((o) => o.id));
  const off: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, bounds.min[1], (bounds.min[2] + bounds.max[2]) / 2];
  const usedDefs = new Set(objects.filter((o) => o.type === 'part').map((o) => o.params.part));
  return {
    id: newId('part'),
    name,
    thickness: g.thickness,
    blend: g.blend ?? 0,
    hollow: doc.shell.enabled,
    objects: objects.map((o) => {
      const c: SceneObject = JSON.parse(JSON.stringify(o));
      c.transform.position = [o.transform.position[0] - off[0], o.transform.position[1] - off[1], o.transform.position[2] - off[2]];
      c.groupId = 'g';
      return c;
    }),
    pins: doc.pins.filter((p) => ids.has(p.objectId)).map((p) => JSON.parse(JSON.stringify(p))),
    parts: (doc.parts ?? []).filter((d) => usedDefs.has(d.id)),
  };
}
