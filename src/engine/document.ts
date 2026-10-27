// The parametric scene document. It is plain JSON: every edit produces a new
// document and the kernels rebuild from scratch, so any object can be edited later
// without undo/redo.

import type { ProfilePoint } from './profile';
import type { Vec3 } from './math';

export type PrimitiveType = 'sphere' | 'box' | 'cylinder' | 'cone' | 'torus' | 'capsule' | 'prism' | 'revolve';

/** join: part of the shelled form. solid: added after shelling. cut: carved out before shelling. */
export type ObjectMode = 'join' | 'solid' | 'cut';

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
  points?: ProfilePoint[]; // revolve
}

export interface SceneObject {
  id: string;
  name: string;
  type: PrimitiveType;
  params: PrimitiveParams;
  transform: Transform;
  mode: ObjectMode;
  /** Face ids of this object that become openings when shelled. */
  holes: string[];
  hidden?: boolean;
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
  version: 1;
  objects: SceneObject[];
  pins: PinHole[];
  shell: { enabled: boolean; thickness: number };
  kernel: KernelName;
  /** SDF kernel: exact (redistanced) wall thickness vs raw min() field. */
  sdfExactDistance: boolean;
  /** Mesh kernel: 'offset' = exact per-primitive offsets, 'minkowski' = exact erosion of the union (slow). */
  meshMethod: 'offset' | 'minkowski';
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
    case 'sphere': return { r: 3 };
    case 'box': return { x: 5, y: 5, z: 5 };
    case 'cylinder': return { r: 2.5, h: 6 };
    case 'cone': return { r: 3, h: 6 };
    case 'torus': return { R: 3, r: 1 };
    case 'capsule': return { r: 1.5, h: 4 };
    case 'prism': return { n: 6, r: 3, h: 5 };
    case 'revolve': return { points: defaultVaseProfile() };
  }
}

export function defaultVaseProfile(): ProfilePoint[] {
  return [
    { r: 2.5, y: -5, corner: true },
    { r: 3.6, y: -3 },
    { r: 3.4, y: 0 },
    { r: 1.8, y: 2.8 },
    { r: 2.4, y: 5, corner: true },
  ];
}

export const TYPE_LABEL: Record<PrimitiveType, string> = {
  sphere: 'Sphere', box: 'Box', cylinder: 'Cylinder', cone: 'Cone', torus: 'Torus',
  capsule: 'Capsule', prism: 'Prism', revolve: 'Revolve',
};

export function makeObject(type: PrimitiveType, opts: Partial<SceneObject> = {}): SceneObject {
  return {
    id: newId(),
    name: TYPE_LABEL[type],
    type,
    params: defaultParams(type),
    transform: identityTransform(),
    mode: 'join',
    holes: [],
    ...opts,
  };
}

export function emptyDoc(): SceneDoc {
  return {
    version: 1,
    objects: [],
    pins: [],
    shell: { enabled: true, thickness: 0.4 },
    kernel: 'sdf',
    sdfExactDistance: true,
    meshMethod: 'offset',
  };
}

export function cloneDoc(d: SceneDoc): SceneDoc {
  return JSON.parse(JSON.stringify(d));
}

/** Fill in fields added after a document was saved. */
export function normalizeDoc(d: Partial<SceneDoc>): SceneDoc {
  const base = emptyDoc();
  return {
    ...base,
    ...d,
    shell: { ...base.shell, ...(d.shell ?? {}) },
    objects: (d.objects ?? []).map((o) => ({ ...makeObject(o.type), ...o, holes: o.holes ?? [] })),
    pins: d.pins ?? [],
  } as SceneDoc;
}
