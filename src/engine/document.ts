// The parametric scene document. It is plain JSON: every edit produces a new
// document and the kernels rebuild from scratch, so any object can be edited later
// without undo/redo.

import type { ProfilePoint } from './profile';
import type { Vec3 } from './math';

export type PrimitiveType = 'sphere' | 'box' | 'cylinder' | 'cone' | 'torus' | 'capsule' | 'prism' | 'revolve' | 'sweep' | 'part';

/**
 * Role of an object within its group:
 *  shell    — forms the hollow body; the group's cavity is grown inward from the
 *             outer surface of all shell objects together.
 *  solid    — never hollowed itself, but still cut by its group's cavity.
 */
/** subtract: carved from the shell shape before hollowing (the cut gets a wall);
 *  cutout: carved from the finished piece, walls and all (opens into the hollow). */
export type ObjectMode = 'shell' | 'solid' | 'subtract' | 'cutout';
export const isCut = (m: ObjectMode) => m === 'subtract' || m === 'cutout';

/** How a layer joins the layers below it in its group (bottom to top, as in a
 *  paint program's layers): added, carved out before its group is hollowed (the cut
 *  gets a wall), or cut out of the finished group, walls and all. */
export type LayerOp = 'add' | 'subtract' | 'cutout';

/**
 * A group of layers. In a document as authored, groups form the layer tree: each
 * lists its children (object and group ids, bottom to top) and has its own op,
 * transform, mirror and effects; `doc.root` lists the top level. In a document as
 * built (see engine/layers), groups are flat units the kernels hollow one by one.
 */
export interface Group {
  id: string;
  name: string;
  /** Child layer ids, bottom to top (authored documents). */
  children?: string[];
  op?: LayerOp;
  /** Hollow this group as one body (authored documents; built units hollow if they have Shell objects). */
  shell?: boolean;
  /** Placement of the group's contents (uniform scale). */
  transform?: Transform;
  sym?: Symmetry;
  hidden?: boolean;
  /** Folded in the Layers list. */
  collapsed?: boolean;
  /** Built units from the layer tree: Round rounds the finished body as a whole
   *  (engine/round), not each object and the rims of its cuts. */
  compound?: boolean;
  /** Wall thickness (cm) for this group's shell. */
  thickness: number;
  /** Smooth-union radius (cm) between the group's shell and solid objects; 0 = sharp. SDF only. */
  blend?: number;
  /** Rounds every edge of the group's objects (cm), and the rims of its cuts (SDF). */
  round?: number;
}

export interface Transform {
  position: Vec3;
  /** Euler degrees, three.js XYZ order. */
  rotation: Vec3;
  scale: Vec3;
}

export interface PrimitiveParams {
  r?: number; // sphere, cylinder, cone, capsule, prism (circumradius)
  x?: number; // box full sizes
  y?: number;
  z?: number;
  h?: number; // cylinder, cone, capsule (straight part), prism
  R?: number; // torus major radius (tube radius = r)
  n?: number; // prism sides
  r2?: number; // prism top circumradius (0 = point)
  points?: ProfilePoint[]; // revolve
  part?: string; // part: id of a PartDef in doc.parts
  // sweep: a section swept along a path drawn on a plane
  plane?: 'xy' | 'xz' | 'yz';
  /** Path points in the plane (r = first plane axis, y = second). */
  path?: ProfilePoint[];
  closed?: boolean;
  /** Closed paths: times around (a coil when the lift rises). */
  turns?: number;
  /** Lift off the plane along its normal: r = position along the path 0..1, y = cm. */
  lift?: ProfilePoint[];
  section?: 'circle' | 'square' | 'custom';
  /** Section width and height (circle: w is the diameter). */
  w?: number;
  d?: number;
  /** Custom section outline (closed); fitted to w × d. */
  shape?: ProfilePoint[];
  /** Rounds the object's edges and corners (cm; boxes, cylinders, cones, prisms,
   *  revolves, sweep sections). The group's rounding applies too (the larger wins). */
  round?: number;
  /** Sweeps: how sharp corners turn and open ends finish (see sweep.SweepStyle). */
  join?: 'round' | 'miter';
  cap?: 'flat' | 'round' | 'square';
}

export interface SceneObject {
  id: string;
  name: string;
  type: PrimitiveType;
  params: PrimitiveParams;
  transform: Transform;
  mode: ObjectMode;
  groupId: string;
  /** Face ids of this object that become openings when shelled. */
  holes: string[];
  /** Copies made when the scene is built: mirrored across a plane, or repeated round
   *  an axis, through the reference object's centre (none: the world origin) along
   *  its local axis. Copies follow every edit of the original. */
  sym?: Symmetry;
  hidden?: boolean;
}

export interface Symmetry {
  kind: 'mirror' | 'radial';
  /** reference object id (its centre and axes); null = the world origin and axes */
  ref: string | null;
  axis: 'x' | 'y' | 'z';
  /** radial: copies in all, the original included */
  count: number;
}

export interface PinHole {
  id: string;
  objectId: string;
  /** Point and outward normal in the object's local (unscaled-parameter) frame. */
  point: Vec3;
  normal: Vec3;
  radius: number;
}

export type KernelName = 'sdf' | 'mesh';
export type Quality = 'draft' | 'normal' | 'fine';

export interface SceneDoc {
  version: 2;
  groups: Group[];
  objects: SceneObject[];
  pins: PinHole[];
  /** Global shelling switch; thickness is per group. */
  shell: { enabled: boolean };
  kernel: KernelName;
  /** SDF kernel: exact (redistanced) wall thickness vs raw min() field. */
  sdfExactDistance: boolean;
  /** Mesh kernel: 'offset' = exact per-primitive offsets, 'minkowski' = exact erosion of the union (slow). */
  meshMethod: 'offset' | 'minkowski';
  /** Definitions of the parts placed in this piece (documents before layers). */
  parts?: PartDef[];
  /** The layer tree's top level, bottom to top (authored documents; built ones have none). */
  root?: string[];
  /** Built documents: the layer tree as a program over the objects (engine/scene ProgIns). */
  program?: ProgIns[];
}

/**
 * One step of a built document's program, run with a stack of (body, shell
 * surface) pairs: ['o', object id, flags (1 subtract, 2 solid), blend] folds an
 * object into the group on top; ['('] starts a group; [')', flags (1 subtract),
 * hollowed body's group id or '', blend] ends one, hollowing it if it names a body,
 * and folds it into its parent.
 */
export type ProgIns = ['o', string, number, number] | ['('] | [')', number, string, number];

/**
 * A saved group (before layers: a group placed whole, like a primitive). Saved
 * parts are now `layers`: a group's subtree, inserted into a piece as an editable copy.
 */
export interface PartDef {
  id: string;
  name: string;
  thickness: number;
  blend?: number;
  /** Whether its Shell objects are hollowed (the piece's switch when it was saved). */
  hollow: boolean;
  /** Objects in part space: the part sits on the ground at the origin. */
  objects: SceneObject[];
  pins: PinHole[];
  /** Parts placed inside this part. */
  parts?: PartDef[];
  thumb?: string;
  /** The saved group and everything in it: root = [that group's id]. */
  layers?: { groups: Group[]; objects: SceneObject[]; pins: PinHole[]; root: string[] };
}

let idCounter = 0;
export function newId(prefix = 'o'): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function identityTransform(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

export function defaultParams(type: PrimitiveType): PrimitiveParams {
  switch (type) {
    // Hand-scale defaults (cm): a typical adult hand is ~19 cm long, 9 cm wide.
    case 'sphere': return { r: 9 };
    case 'box': return { x: 16, y: 16, z: 16 };
    case 'cylinder': return { r: 8, h: 18 };
    case 'cone': return { r: 9, h: 18 };
    case 'torus': return { R: 9, r: 3 };
    case 'capsule': return { r: 4.5, h: 12 };
    case 'prism': return { n: 6, r: 9, r2: 9, h: 15 };
    case 'revolve': return { points: defaultVaseProfile() };
    case 'sweep': return defaultSweep();
    case 'part': return {};
  }
}

/** A C-shaped handle, drawn upright (XY plane), round section. */
export function defaultSweep(): PrimitiveParams {
  return {
    plane: 'xy',
    path: [{ r: -1, y: -6, corner: true }, { r: 4, y: -5 }, { r: 6, y: 0 }, { r: 4, y: 5 }, { r: -1, y: 6, corner: true }],
    closed: false,
    turns: 1,
    lift: [{ r: 0, y: 0 }, { r: 1, y: 0 }],
    section: 'circle',
    w: 2.4,
    d: 2.4,
    shape: [{ r: -1, y: -1 }, { r: 1, y: -1 }, { r: 0.6, y: 1 }, { r: -0.6, y: 1 }],
  };
}

/** A circle drawn with eight points (a spline through them is very nearly round). */
export function circlePath(r: number, n = 8): ProfilePoint[] {
  return Array.from({ length: n }, (_, i) => ({ r: +(r * Math.cos((2 * Math.PI * i) / n)).toFixed(3), y: +(r * Math.sin((2 * Math.PI * i) / n)).toFixed(3) }));
}

/** A coil: a circle drawn on the ground, lifted steadily over three turns. */
export function defaultCoil(): PrimitiveParams {
  return {
    ...defaultSweep(),
    plane: 'xz',
    path: circlePath(7),
    closed: true,
    turns: 3,
    lift: [{ r: 0, y: -7, corner: true }, { r: 1, y: 7, corner: true }],
    w: 2.2,
    d: 2.2,
  };
}

export function defaultVaseProfile(): ProfilePoint[] {
  return [
    { r: 6, y: -12, corner: true },
    { r: 9, y: -7 },
    { r: 8.5, y: 0 },
    { r: 4.5, y: 7 },
    { r: 6, y: 12, corner: true },
  ];
}

/** Uniformly scale a document's geometry (not its wall thickness). */
export function scaleDoc(d: SceneDoc, k: number): SceneDoc {
  for (const o of d.objects) {
    const p = o.params as Record<string, unknown>;
    for (const key of ['r', 'r2', 'x', 'y', 'z', 'h', 'R', 'w', 'd', 'round']) if (typeof p[key] === 'number') p[key] = (p[key] as number) * k;
    if (o.params.points) o.params.points = o.params.points.map((q) => ({ ...q, r: q.r * k, y: q.y * k }));
    if (o.params.path) o.params.path = o.params.path.map((q) => ({ ...q, r: q.r * k, y: q.y * k }));
    if (o.params.lift) o.params.lift = o.params.lift.map((q) => ({ ...q, y: q.y * k }));
    o.transform.position = o.transform.position.map((v) => v * k) as Vec3;
  }
  for (const pin of d.pins) {
    pin.point = pin.point.map((v) => v * k) as Vec3;
    pin.radius *= k;
  }
  for (const g of d.groups) if (g.blend) g.blend *= k;
  for (const g of d.groups) if (g.round) g.round *= k;
  return d;
}

export const TYPE_LABEL: Record<PrimitiveType, string> = {
  sphere: 'Sphere', box: 'Box', cylinder: 'Cylinder', cone: 'Cone', torus: 'Torus',
  capsule: 'Capsule', prism: 'Prism', revolve: 'Revolve', sweep: 'Sweep', part: 'Part',
};

export function makeObject(type: PrimitiveType, opts: Partial<SceneObject> = {}): SceneObject {
  return {
    id: newId(),
    name: TYPE_LABEL[type],
    type,
    params: defaultParams(type),
    transform: identityTransform(),
    mode: 'shell',
    groupId: DEFAULT_GROUP,
    holes: [],
    ...opts,
  };
}

export const DEFAULT_GROUP = 'g1';
export const DEFAULT_WALL = 0.6;

export function emptyDoc(): SceneDoc {
  return {
    version: 2,
    groups: [newGroup(DEFAULT_GROUP, 'Group 1')],
    objects: [],
    pins: [],
    shell: { enabled: true },
    kernel: 'sdf',
    sdfExactDistance: true,
    meshMethod: 'offset',
    root: [DEFAULT_GROUP],
  };
}

/** A new, empty layer group: hollowed, with the default wall. */
export function newGroup(id: string, name: string, extra: Partial<Group> = {}): Group {
  return { id, name, thickness: DEFAULT_WALL, children: [], op: 'add', shell: true, transform: identityTransform(), ...extra };
}

export function cloneDoc(d: SceneDoc): SceneDoc {
  return JSON.parse(JSON.stringify(d));
}

/** Fill in fields added after a document was saved, and migrate v1 documents. */
export function normalizeDoc(d: Partial<SceneDoc> & { shell?: { enabled?: boolean; thickness?: number } }): SceneDoc {
  const base = emptyDoc();
  const legacyWall = d.shell?.thickness;
  const tree = Array.isArray(d.root);
  const groups = tree ? d.groups ?? [] : d.groups?.length ? d.groups : [{ id: DEFAULT_GROUP, name: 'Group 1', thickness: legacyWall ?? DEFAULT_WALL }];
  const groupIds = new Set(groups.map((g) => g.id));
  const modeMap: Record<string, ObjectMode> = { join: 'shell', cut: 'subtract', solid: 'solid', shell: 'shell', subtract: 'subtract', cutout: 'cutout' };
  return {
    ...base,
    ...d,
    version: 2,
    groups,
    shell: { enabled: d.shell?.enabled ?? true },
    objects: (d.objects ?? []).map((o) => ({
      ...makeObject(o.type),
      ...o,
      // (an 'open cut' subtract was briefly a flag; it is the cutout role)
      mode: (o as { openCut?: boolean }).openCut ? 'cutout' : modeMap[o.mode as string] ?? 'shell',
      // (in the layer tree '' is the top level)
      groupId: o.groupId && groupIds.has(o.groupId) ? o.groupId : tree ? '' : groups[0].id,
      holes: o.holes ?? [],
    })),
    pins: d.pins ?? [],
    root: tree ? d.root : undefined,
  } as SceneDoc;
}
