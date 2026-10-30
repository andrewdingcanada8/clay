// The layer tree, and how it is built.
//
// A piece is a tree of layers, like a paint program's: objects, and groups of
// layers. Each group lists its children bottom to top (`doc.root` lists the top
// level), and every layer has an op that says how it joins the layers below it in
// its group: Add, Subtract (carved before its group is hollowed, so the cut gets a
// wall) or Cutout (cut from the finished group, walls and all). A group can move,
// turn and scale its contents (uniformly), mirror or repeat them, and carry effects:
// Shell (hollow it as one body), Blend and Round.
//
// The kernels build flat units (engine/scene CompiledGroup): one body of Add
// objects, less its cuts, hollowed or not. flattenLayers turns the tree into those:
//  - a group with an effect (Shell, Blend or Round) is a unit of its own; the
//    groups and objects inside it join it, and so do the cuts above it in its
//    parents, as cutouts of the finished unit when it is hollow;
//  - elsewhere a group only places its contents. A cut takes everything below it in
//    its group, so each Add object gets the cuts above it, and Add objects with the
//    same cuts make one unit (a union of cut bodies is the cut union: exact);
//  - inside a unit the cuts take the whole unit (the kernels hollow a body less its
//    cuts), so an Add above a cut there is cut too; and a unit inside a unit is
//    built as a body of its own. Both are reported as notes.
// Symmetry copies (an object's or a group's) are made here too; their ids are the
// original's plus `~s${k}`, which picking maps back (parts.placedId).

import {
  DEFAULT_WALL, type Group, type LayerOp, type PartDef, type PinHole, type SceneDoc, type SceneObject, type Symmetry,
  type Transform, cloneDoc, identityTransform, isCut, newGroup, newId,
} from './document';
import { type Vec3, eulerXYZ } from './math';
import { PART_SEP, composeTransform, eulerFromMatrix, partScale } from './parts';
import { axisAngle, moved, reflection } from './symmetry';

export type Layer = { kind: 'object'; o: SceneObject } | { kind: 'group'; g: Group };

export const isTree = (d: SceneDoc) => Array.isArray(d.root);

/** Child ids of a group ('' = the top level), bottom to top. */
export function childIds(doc: SceneDoc, gid: string): string[] {
  return gid ? doc.groups.find((g) => g.id === gid)?.children ?? [] : doc.root ?? [];
}

export function layerOf(doc: SceneDoc, id: string): Layer | null {
  const o = doc.objects.find((x) => x.id === id);
  if (o) return { kind: 'object', o };
  const g = doc.groups.find((x) => x.id === id);
  return g ? { kind: 'group', g } : null;
}

/** The group a layer sits in ('' = the top level; null = not in the tree). */
export function parentOf(doc: SceneDoc, id: string): string | null {
  if (doc.root?.includes(id)) return '';
  return doc.groups.find((g) => g.children?.includes(id))?.id ?? null;
}

/** A layer's ancestors, innermost first (not including '' the top level). */
export function ancestors(doc: SceneDoc, id: string): string[] {
  const out: string[] = [];
  for (let p = parentOf(doc, id); p; p = parentOf(doc, p)) { if (out.includes(p)) break; out.push(p); }
  return out;
}

export const layerOp = (l: Layer): LayerOp => (l.kind === 'object' ? (isCut(l.o.mode) ? l.o.mode as LayerOp : 'add') : l.g.op ?? 'add');

/**
 * Make the tree consistent: every object and group listed exactly once, under a
 * parent that exists, with no cycles; objects' groupId is their parent. Anything
 * not listed joins the top of its group (an object: the group its groupId names).
 */
export function repairTree(doc: SceneDoc): void {
  doc.root ??= [];
  const objs = new Map(doc.objects.map((o) => [o.id, o]));
  const groups = new Map(doc.groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const visit = (list: string[], parent: string): string[] => {
    const out: string[] = [];
    for (const id of list) {
      if (seen.has(id) || (!objs.has(id) && !groups.has(id))) continue;
      seen.add(id);
      out.push(id);
      const o = objs.get(id);
      if (o) o.groupId = parent;
      const g = groups.get(id);
      if (g) g.children = visit(g.children ?? [], g.id);
    }
    return out;
  };
  doc.root = visit(doc.root, '');
  for (const g of doc.groups) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    g.children = visit(g.children ?? [], g.id);
    doc.root.push(g.id);
  }
  for (const o of doc.objects) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const g = groups.get(o.groupId);
    if (g && seen.has(g.id)) { g.children!.push(o.id); } else { o.groupId = ''; doc.root.push(o.id); }
  }
}

// ---------- migration from flat groups (and placed parts)

/**
 * A document in the layer tree. Documents from before layers had flat groups (each
 * a hollowed body; order didn't matter) and parts placed whole; each group becomes
 * a top-level group with its Add objects below its cuts, and each placed part an
 * editable group with the part's contents.
 */
export function toLayers(doc: SceneDoc): SceneDoc {
  if (isTree(doc)) { repairTree(doc); return doc; }
  const out = cloneDoc(doc);
  const defs = new Map<string, PartDef>();
  const addDefs = (list?: PartDef[]) => { for (const d of list ?? []) { if (!defs.has(d.id)) defs.set(d.id, d); addDefs(d.parts); } };
  addDefs(doc.parts);
  out.objects = [];
  out.pins = [];
  out.groups = [];
  out.root = [];
  const order = (objs: SceneObject[]) => [...objs.filter((o) => !isCut(o.mode)), ...objs.filter((o) => o.mode === 'subtract'), ...objs.filter((o) => o.mode === 'cutout')];
  const keepPins = (from: PinHole[], ids: Map<string, string>) => {
    for (const p of from) { const oid = ids.get(p.objectId); if (oid) out.pins.push({ ...p, id: ids.get(`pin:${p.id}`) ?? p.id, objectId: oid }); }
  };

  /** A placed part, as a group under `parent` (ids: the placed id + `_` + the inner id). */
  const placePart = (o: SceneObject, parent: string, depth: number): string | null => {
    const def = defs.get(o.params.part ?? '');
    if (!def || depth > 4) return null;
    const s = partScale(o.transform);
    const g = newGroup(o.id, o.name, {
      op: isCut(o.mode) ? o.mode as LayerOp : 'add', shell: def.hollow && def.objects.some((x) => x.mode === 'shell'),
      thickness: def.thickness * s, blend: (def.blend ?? 0) * s, hidden: o.hidden, sym: o.sym,
      transform: { position: [...o.transform.position] as Vec3, rotation: [...o.transform.rotation] as Vec3, scale: [s, s, s] },
    });
    out.groups.push(g);
    const ids = new Map<string, string>();
    for (const inner of order(def.objects)) {
      const id = `${o.id}_${inner.id}`;
      ids.set(inner.id, id);
      if (inner.type === 'part') { if (placePart({ ...inner, id }, g.id, depth + 1)) g.children!.push(id); continue; }
      const c: SceneObject = JSON.parse(JSON.stringify(inner));
      c.id = id;
      c.groupId = g.id;
      if (!def.hollow && c.mode === 'shell') c.mode = 'solid';
      out.objects.push(c);
      g.children!.push(id);
    }
    for (const p of def.pins) ids.set(`pin:${p.id}`, `${o.id}_${p.id}`);
    keepPins(def.pins, ids);
    return g.id;
  };

  for (const og of doc.groups) {
    const members = doc.objects.filter((o) => o.groupId === og.id);
    const g = newGroup(og.id, og.name, { thickness: og.thickness, blend: og.blend, round: og.round, shell: members.some((o) => o.mode === 'shell') });
    out.groups.push(g);
    out.root.push(g.id);
    for (const o of order(members)) {
      if (o.type === 'part') { if (placePart(o, g.id, 0)) g.children!.push(o.id); continue; }
      out.objects.push({ ...o, groupId: g.id });
      g.children!.push(o.id);
    }
  }
  keepPins(doc.pins, new Map(out.objects.map((o) => [o.id, o.id])));
  delete out.parts;
  repairTree(out);
  return out;
}

// ---------- world placement

/** Where a layer's contents sit: its parents' placements composed (uniform scale). */
export function worldTransform(doc: SceneDoc, id: string): Transform {
  let t: Transform = identityTransform();
  for (const gid of [...ancestors(doc, id)].reverse()) {
    const g = doc.groups.find((x) => x.id === gid);
    if (g?.transform) t = composeTransform(t, g.transform);
  }
  const l = layerOf(doc, id);
  const own = l?.kind === 'object' ? l.o.transform : l?.g.transform;
  return own ? composeTransform(t, own) : t;
}

/** The transform within parent group `gid` that places a layer at world transform `w`. */
export function localTransform(doc: SceneDoc, gid: string, w: Transform): Transform {
  const p = gid ? worldTransform(doc, gid) : identityTransform();
  const s = partScale(p) || 1;
  const R = eulerXYZ(...p.rotation);
  const d: Vec3 = [w.position[0] - p.position[0], w.position[1] - p.position[1], w.position[2] - p.position[2]];
  // R^T d / s, and R^T times the world rotation
  const pos: Vec3 = [(R[0] * d[0] + R[3] * d[1] + R[6] * d[2]) / s, (R[1] * d[0] + R[4] * d[1] + R[7] * d[2]) / s, (R[2] * d[0] + R[5] * d[1] + R[8] * d[2]) / s];
  const W = eulerXYZ(...w.rotation);
  const M = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[3 * i + j] = R[i] * W[j] + R[3 + i] * W[3 + j] + R[6 + i] * W[6 + j];
  return { position: pos, rotation: eulerFromMatrix(M), scale: [w.scale[0] / s, w.scale[1] / s, w.scale[2] / s] };
}

// ---------- building: the tree as flat units

interface SymMap { L: Float64Array; c: Vec3; flip: boolean }
interface Placed { obj: SceneObject; flips: number }
interface Cut { obj: SceneObject; kind: 'subtract' | 'cutout' }
interface Unit { g: Group; hollow: boolean; objects: SceneObject[]; cutIds: Set<string>; hasAdd: boolean; noted: boolean }
/** xf: the enclosing groups' placement; maps: the enclosing group copies' moves, innermost first. */
interface Ctx { xf: Transform; maps: SymMap[]; suffix: string; unit: Unit | null; cuts: Cut[] }

/** The copies a symmetry makes (none for the original), about its frame in `frames`. */
function symMaps(sym: Symmetry | undefined, frame: (sym: Symmetry) => { c: Vec3; a: Vec3 }): SymMap[] {
  if (!sym) return [];
  const { c, a } = frame(sym);
  if (sym.kind === 'mirror') return [{ L: reflection(a), c, flip: true }];
  const n = Math.max(2, Math.min(64, Math.round(sym.count)));
  const out: SymMap[] = [];
  for (let k = 1; k < n; k++) out.push({ L: axisAngle(a, (2 * Math.PI * k) / n), c, flip: false });
  return out;
}

/**
 * The document as the kernels build it: flat units (groups) of world-placed
 * objects, with symmetry copies made and cuts given to the units they cut.
 * `notes` collects where the build approximates the tree (see the header).
 */
export function flattenLayers(src: SceneDoc, notes: string[] = []): SceneDoc {
  const doc = cloneDoc(src);
  repairTree(doc);
  const out: SceneDoc = { ...doc, groups: [], objects: [], pins: [], root: undefined, parts: undefined };
  const objs = new Map(doc.objects.map((o) => [o.id, o]));
  const groups = new Map(doc.groups.map((g) => [g.id, g]));
  const pinsOf = new Map<string, PinHole[]>();
  for (const p of doc.pins) pinsOf.set(p.objectId, [...pinsOf.get(p.objectId) ?? [], p]);
  const note = (s: string) => { if (!notes.includes(s)) notes.push(s); };

  // a symmetry's frame: its reference object's world centre and axis (before copies), or the world's
  const frame = (sym: Symmetry) => {
    const e: Vec3 = sym.axis === 'x' ? [1, 0, 0] : sym.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    if (!sym.ref || !layerOf(doc, sym.ref)) return { c: [0, 0, 0] as Vec3, a: e };
    const t = worldTransform(doc, sym.ref);
    const R = eulerXYZ(...t.rotation);
    return { c: [...t.position] as Vec3, a: [R[0] * e[0] + R[1] * e[1] + R[2] * e[2], R[3] * e[0] + R[4] * e[1] + R[5] * e[2], R[6] * e[0] + R[7] * e[1] + R[8] * e[2]] as Vec3 };
  };

  /** An object placed in the world: itself and its own symmetry copies, moved as its group copy is. */
  const place = (o: SceneObject, ctx: Ctx): Placed[] => {
    const base: SceneObject = { ...JSON.parse(JSON.stringify(o)), id: o.id + ctx.suffix, sym: undefined, transform: composeTransform(ctx.xf, o.transform) };
    const list: Placed[] = [{ obj: base, flips: 0 }];
    symMaps(o.sym, frame).forEach((m, k) => list.push({ obj: moved(base, m.L, m.c, m.flip, `${base.id}${PART_SEP}s${k + 1}`), flips: m.flip ? 1 : 0 }));
    return list.map((p) => ctx.maps.reduce((q, m) => ({ obj: moved(q.obj, m.L, m.c, m.flip, q.obj.id), flips: q.flips + (m.flip ? 1 : 0) }), p));
  };

  const addPins = (o: SceneObject, placed: Placed[]) => {
    for (const p of placed) {
      for (const pin of pinsOf.get(o.id) ?? []) {
        const f = p.flips % 2 ? -1 : 1;
        out.pins.push({ ...pin, id: pin.id + p.obj.id.slice(o.id.length), objectId: p.obj.id,
          point: [pin.point[0], pin.point[1], pin.point[2] * f], normal: [pin.normal[0], pin.normal[1], pin.normal[2] * f] });
      }
    }
  };

  const units: Unit[] = [];
  /** units inside units: a note only if the outer one has a body of its own */
  const nested: [Unit, string][] = [];
  const baseUnits = new Map<string, Unit>();
  const newUnit = (g: Group, hollow: boolean): Unit => {
    const u: Unit = { g, hollow, objects: [], cutIds: new Set(), hasAdd: false, noted: false };
    units.push(u);
    return u;
  };
  /** Give unit u these cuts (once each). */
  const cutUnit = (u: Unit, cuts: Cut[], kind?: 'subtract' | 'cutout') => {
    for (const c of cuts) {
      if (u.cutIds.has(c.obj.id)) continue;
      u.cutIds.add(c.obj.id);
      u.objects.push({ ...c.obj, id: `${c.obj.id}${PART_SEP}u${units.indexOf(u)}`, mode: kind ?? c.kind, groupId: u.g.id, holes: kind === 'cutout' ? [] : c.obj.holes });
    }
  };
  /** The top-level unit for Add objects with exactly these cuts. */
  const baseUnit = (cuts: Cut[]): Unit => {
    const key = cuts.map((c) => c.obj.id).sort().join(',');
    let u = baseUnits.get(key);
    if (!u) {
      u = newUnit({ id: key ? `base${PART_SEP}${baseUnits.size}` : 'base', name: 'Ungrouped', thickness: DEFAULT_WALL }, false);
      baseUnits.set(key, u);
      cutUnit(u, cuts, 'subtract');
    }
    return u;
  };

  /** The Add objects inside a group, placed (a cut group's outline). */
  const outline = (ids: string[], ctx: Ctx, acc: Placed[]) => {
    for (const id of ids) {
      const o = objs.get(id), g = groups.get(id);
      if (o && !o.hidden) { if (isCut(o.mode)) note('A cut group cuts with its Add layers only'); else acc.push(...place(o, ctx)); }
      if (g && !g.hidden) forCopies(g, ctx, (c) => outline(g.children ?? [], c, acc));
    }
  };

  /** Run `f` once per symmetry copy of group g, with g's placement. */
  const forCopies = (g: Group, ctx: Ctx, f: (c: Ctx, k: number) => void) => {
    const xf = g.transform ? composeTransform(ctx.xf, g.transform) : ctx.xf;
    const maps = symMaps(g.sym, frame);
    f({ ...ctx, xf }, 0);
    // a copy: placed the same, then moved by its map (before the enclosing group copies' moves)
    maps.forEach((m, k) => f({ ...ctx, xf, maps: [m, ...ctx.maps], suffix: `${ctx.suffix}${PART_SEP}s${k + 1}` }, k + 1));
  };

  const walk = (ids: string[], ctx: Ctx) => {
    const above: Cut[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const o = objs.get(id);
      if (o) {
        if (o.hidden || o.type === 'part') continue;
        const placed = place(o, ctx);
        if (isCut(o.mode)) {
          const cuts = placed.map((p) => ({ obj: p.obj, kind: o.mode as 'subtract' | 'cutout' }));
          if (ctx.unit) {
            cutUnit(ctx.unit, cuts);
            if (ctx.unit.hasAdd && !ctx.unit.noted) { ctx.unit.noted = true; note(`In "${ctx.unit.g.name}", a cut also takes the layers above it`); }
          }
          above.push(...cuts);
        } else {
          const u = ctx.unit ?? baseUnit([...ctx.cuts, ...above]);
          u.hasAdd = true;
          for (const p of [...placed].reverse()) u.objects.push({ ...p.obj, groupId: u.g.id, mode: u.hollow && o.mode === 'shell' ? 'shell' : 'solid' });
          addPins(o, placed);
        }
        continue;
      }
      const g = groups.get(id);
      if (!g || g.hidden) continue;
      const op = g.op ?? 'add';
      if (op !== 'add') {
        forCopies(g, ctx, (c) => {
          const acc: Placed[] = [];
          outline(g.children ?? [], c, acc);
          const cuts = acc.map((p) => ({ obj: p.obj, kind: op }));
          if (ctx.unit) cutUnit(ctx.unit, cuts);
          above.push(...cuts);
        });
        continue;
      }
      const effects = !!g.shell || (g.blend ?? 0) > 0 || (g.round ?? 0) > 0
        || (g.shell === undefined && childIds(doc, g.id).some((c) => objs.get(c)?.mode === 'shell'));
      forCopies(g, ctx, (c) => {
        if (!effects) { walk(g.children ?? [], { ...c, cuts: [...ctx.cuts, ...above] }); return; }
        if (ctx.unit) nested.push([ctx.unit, `"${g.name}" is built as a body of its own inside "${ctx.unit.g.name}"`]);
        const hollow = g.shell ?? childIds(doc, g.id).some((x) => objs.get(x)?.mode === 'shell');
        const u = newUnit({ id: g.id + c.suffix, name: g.name, thickness: g.thickness, blend: g.blend, round: g.round }, hollow);
        const inherited = [...ctx.cuts, ...above];
        cutUnit(u, inherited, hollow ? 'cutout' : 'subtract');
        walk(g.children ?? [], { ...c, unit: u, cuts: inherited.map((x) => ({ ...x, kind: hollow ? 'cutout' : x.kind })) });
      });
    }
  };

  walk(doc.root ?? [], { xf: identityTransform(), maps: [], suffix: '', unit: null, cuts: [] });
  for (const [u, s] of nested) if (u.hasAdd) note(s);
  // (the walk runs top to bottom; units go out bottom first, in layer order)
  for (const u of [...units].reverse()) {
    if (!u.hasAdd) continue;
    out.groups.push(u.g);
    out.objects.push(...[...u.objects].reverse());
  }
  // a unit's id names its objects' group: keep only units that have a body
  const kept = new Set(out.groups.map((g) => g.id));
  out.objects = out.objects.filter((o) => kept.has(o.groupId));
  const objIds = new Set(out.objects.map((o) => o.id));
  out.pins = out.pins.filter((p) => objIds.has(p.objectId));
  if (out.groups.length > 8) note('More than 8 bodies: the SDF view draws the first 8');
  return out;
}

// ---------- editing the tree

/** Remove a layer from wherever it is listed. */
export function detach(doc: SceneDoc, id: string): void {
  doc.root = (doc.root ?? []).filter((x) => x !== id);
  for (const g of doc.groups) if (g.children?.includes(id)) g.children = g.children.filter((x) => x !== id);
}

/** Put a layer into group gid ('' = top level) at index (default: the top). */
export function attach(doc: SceneDoc, id: string, gid: string, index?: number): void {
  detach(doc, id);
  const list = gid ? doc.groups.find((g) => g.id === gid)!.children ??= [] : doc.root ??= [];
  list.splice(index ?? list.length, 0, id);
  const o = doc.objects.find((x) => x.id === id);
  if (o) o.groupId = gid;
}

/** All ids in a layer's subtree (the layer included). */
export function subtree(doc: SceneDoc, id: string): string[] {
  const out = [id];
  const g = doc.groups.find((x) => x.id === id);
  for (const c of g?.children ?? []) out.push(...subtree(doc, c));
  return out;
}

/** Delete a layer and everything in it (and their pins). */
export function deleteLayer(doc: SceneDoc, id: string): void {
  const ids = new Set(subtree(doc, id));
  detach(doc, id);
  doc.objects = doc.objects.filter((o) => !ids.has(o.id));
  doc.groups = doc.groups.filter((g) => !ids.has(g.id));
  doc.pins = doc.pins.filter((p) => !ids.has(p.objectId));
  for (const o of doc.objects) if (o.sym?.ref && ids.has(o.sym.ref)) o.sym.ref = null;
  for (const g of doc.groups) if (g.sym?.ref && ids.has(g.sym.ref)) g.sym.ref = null;
}

/** A copy of a layer's subtree with fresh ids (and its pins), not yet in any group. Returns the copy's id. */
export function copyLayer(from: SceneDoc, id: string, into: SceneDoc): string {
  const ids = subtree(from, id);
  const fresh = new Map(ids.map((x) => [x, newId(from.groups.some((g) => g.id === x) ? 'g' : 'o')]));
  const ref = (r: string | null) => (r && fresh.get(r)) ?? r;
  for (const x of ids) {
    const o = from.objects.find((y) => y.id === x);
    if (o) { const c: SceneObject = JSON.parse(JSON.stringify(o)); c.id = fresh.get(x)!; if (c.sym) c.sym.ref = ref(c.sym.ref); into.objects.push(c); }
    const g = from.groups.find((y) => y.id === x);
    if (g) {
      const c: Group = JSON.parse(JSON.stringify(g));
      c.id = fresh.get(x)!;
      c.children = (g.children ?? []).map((k) => fresh.get(k) ?? k);
      if (c.sym) c.sym.ref = ref(c.sym.ref);
      for (const k of c.children) { const o = into.objects.find((y) => y.id === k); if (o) o.groupId = c.id; }
      into.groups.push(c);
    }
  }
  for (const c of into.objects) if (fresh.has(c.groupId)) c.groupId = fresh.get(c.groupId)!;
  for (const p of from.pins) if (fresh.has(p.objectId)) into.pins.push({ ...JSON.parse(JSON.stringify(p)), id: newId('p'), objectId: fresh.get(p.objectId)! });
  return fresh.get(id)!;
}

/** Wrap layers (siblings or not) in a new group placed where the first of them was. */
export function groupLayers(doc: SceneDoc, ids: string[], name: string): string {
  const first = ids[0];
  const parent = parentOf(doc, first) ?? '';
  const index = childIds(doc, parent).indexOf(first);
  const g = newGroup(newId('g'), name, { shell: false });
  doc.groups.push(g);
  attach(doc, g.id, parent, Math.max(0, index));
  // keep each layer where it is in the world
  for (const id of ids) {
    const w = worldTransform(doc, id);
    attach(doc, id, g.id);
    const l = layerOf(doc, id)!;
    const t = localTransform(doc, g.id, w);
    if (l.kind === 'object') l.o.transform = t;
    else l.g.transform = { ...t, scale: [partScale(t), partScale(t), partScale(t)] };
  }
  return g.id;
}

/** Replace a group by its children, which keep their place in the world. */
export function ungroup(doc: SceneDoc, gid: string): void {
  const g = doc.groups.find((x) => x.id === gid);
  if (!g) return;
  const parent = parentOf(doc, gid) ?? '';
  let index = childIds(doc, parent).indexOf(gid);
  for (const id of [...(g.children ?? [])]) {
    const w = worldTransform(doc, id);
    attach(doc, id, parent, index++);
    const l = layerOf(doc, id)!;
    const t = localTransform(doc, parent, w);
    if (l.kind === 'object') l.o.transform = t;
    else l.g.transform = { ...t, scale: [partScale(t), partScale(t), partScale(t)] };
  }
  detach(doc, gid);
  doc.groups = doc.groups.filter((x) => x.id !== gid);
}
