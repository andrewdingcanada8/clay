// Benchmark scenes. Also offered in the app's Examples menu.
// Units are centimetres. `probes` are points inside the hollow used by the
// benchmark's interior 360° camera.

import { type ObjectMode, type PrimitiveType, type SceneDoc, type SceneObject, emptyDoc, makeObject } from './engine/document';
import type { Vec3 } from './engine/math';
import type { ProfilePoint } from './engine/profile';

export interface Example {
  id: string;
  title: string;
  notes: string;
  doc: SceneDoc;
  probes: Vec3[];
}

function obj(type: PrimitiveType, params: SceneObject['params'], o: {
  pos?: Vec3; rot?: Vec3; scale?: Vec3; mode?: ObjectMode; holes?: string[]; name?: string; id?: string;
} = {}): SceneObject {
  const so = makeObject(type, { params, mode: o.mode ?? 'join', holes: o.holes ?? [] });
  so.transform = { position: o.pos ?? [0, 0, 0], rotation: o.rot ?? [0, 0, 0], scale: o.scale ?? [1, 1, 1] };
  if (o.name) so.name = o.name;
  so.id = o.id ?? so.id;
  return so;
}

function doc(objects: SceneObject[], thickness: number, extra: Partial<SceneDoc> = {}): SceneDoc {
  return { ...emptyDoc(), objects, shell: { enabled: true, thickness }, ...extra };
}

const vase: ProfilePoint[] = [
  { r: 2.2, y: -6, corner: true },
  { r: 3.8, y: -3.5 },
  { r: 3.6, y: -0.5 },
  { r: 1.7, y: 3 },
  { r: 1.6, y: 4.6 },
  { r: 2.4, y: 6, corner: true },
];

const cup: ProfilePoint[] = [
  { r: 2.6, y: -4, corner: true },
  { r: 3.1, y: -2 },
  { r: 3.5, y: 1.5 },
  { r: 3.7, y: 4, corner: true },
];

const bowl: ProfilePoint[] = [
  { r: 2.0, y: -2.6, corner: true },
  { r: 4.2, y: -1.6 },
  { r: 5.6, y: 0.4 },
  { r: 6.2, y: 2.2, corner: true },
];

function chain(count: number, r: number, spacing: number, thickness: number, pinIds: boolean): SceneDoc {
  const objects: SceneObject[] = [];
  for (let i = 0; i < count; i++) {
    const a = i * 0.45;
    objects.push(obj('sphere', { r }, {
      pos: [(i - (count - 1) / 2) * spacing * 0.8, Math.sin(a) * 2.2, Math.cos(a * 0.7) * 1.5],
      id: `s${i}`, name: `Sphere ${i + 1}`,
    }));
  }
  const d = doc(objects, thickness);
  if (pinIds) {
    d.pins = [
      { id: 'p0', objectId: 's0', point: [-r, 0, 0], normal: [-1, 0, 0], radius: 0.35 },
      { id: 'p1', objectId: `s${count - 1}`, point: [r, 0, 0], normal: [1, 0, 0], radius: 0.35 },
      { id: 'p2', objectId: `s${Math.floor(count / 2)}`, point: [0, r, 0], normal: [0, 1, 0], radius: 0.25 },
    ];
  }
  return d;
}

function chainProbes(d: SceneDoc): Vec3[] {
  const ps = d.objects.map((o) => o.transform.position);
  return [ps[0], ps[Math.floor(ps.length / 2)], ps[ps.length - 1]];
}

export function examples(): Example[] {
  const list: Example[] = [];

  list.push({
    id: 'open-box', title: 'Open box', notes: 'Cube with its top face removed, 0.4 cm walls.',
    doc: doc([obj('box', { x: 6, y: 6, z: 6 }, { holes: ['py'] })], 0.4), probes: [[0, -1, 0]],
  });

  list.push({
    id: 'sphere-cube', title: 'Sphere + cube', notes: 'Union; the cube\'s +X face is the opening but part of it is buried inside the sphere, so only the exposed part opens.',
    doc: doc([
      obj('sphere', { r: 3.2 }, { pos: [-1.2, 0, 0] }),
      obj('box', { x: 4.4, y: 4.4, z: 4.4 }, { pos: [2.2, 0.6, 0], holes: ['px'] }),
    ], 0.4),
    probes: [[-1.2, 0, 0], [2.2, 0.6, 0]],
  });

  {
    const d = chain(30, 1.0, 1.75, 0.3, true);
    list.push({ id: 'chain-30', title: '30-sphere chain', notes: '30 joined spheres, one connected hollow, 3 pin holes.', doc: d, probes: chainProbes(d) });
  }

  list.push({
    id: 'vase', title: 'Spline vase', notes: 'Revolved spline profile, top cap removed.',
    doc: doc([obj('revolve', { points: vase }, { holes: ['top'] })], 0.35), probes: [[0, -3, 0], [0, 2, 0]],
  });

  list.push({
    id: 'bowl', title: 'Bowl', notes: 'Wide revolved bowl with a foot, open top.',
    doc: doc([obj('revolve', { points: bowl }, { holes: ['top'] })], 0.4), probes: [[0, -1, 0]],
  });

  {
    const d = doc([obj('cylinder', { r: 3, h: 7 }, { holes: ['top'], id: 'cyl' })], 0.4);
    d.pins = [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i / 6) * Math.PI * 2;
      return { id: `pin${i}`, objectId: 'cyl', point: [3 * Math.cos(a), (i % 2) * 2 - 1, 3 * Math.sin(a)] as Vec3, normal: [Math.cos(a), 0, Math.sin(a)] as Vec3, radius: 0.3 + 0.1 * (i % 3) };
    });
    list.push({ id: 'cylinder-pins', title: 'Cylinder with pin holes', notes: 'Open-top cylinder with six pin holes on the curved side.', doc: d, probes: [[0, -1.5, 0]] });
  }

  list.push({
    id: 'cup-stick', title: 'Cup with a stick', notes: 'Joined stick through a cup: the stick is shelled with the cup into one hollow.',
    doc: doc([
      obj('revolve', { points: cup }, { holes: ['top'] }),
      obj('cylinder', { r: 0.6, h: 11 }, { rot: [0, 0, 90], pos: [0, -0.5, 0] }),
    ], 0.3),
    probes: [[0, -2.5, 1.5]],
  });

  list.push({
    id: 'vase-sticks', title: 'Vase with crossing sticks', notes: 'Three joined sticks crossing a vase.',
    doc: doc([
      obj('revolve', { points: vase }, { holes: ['top'] }),
      obj('cylinder', { r: 0.5, h: 11 }, { rot: [0, 0, 90], pos: [0, -2.5, 0] }),
      obj('cylinder', { r: 0.5, h: 11 }, { rot: [90, 0, 0], pos: [0, -1.5, 0] }),
      obj('cylinder', { r: 0.45, h: 9 }, { rot: [0, 45, 70], pos: [0, 1.0, 0] }),
    ], 0.3),
    probes: [[1.6, -4.2, 1.6]],
  });

  list.push({
    id: 'vase-solid-sticks', title: 'Vase with solid sticks', notes: 'Same vase; the sticks are "solid" objects added after shelling.',
    doc: doc([
      obj('revolve', { points: vase }, { holes: ['top'] }),
      obj('cylinder', { r: 0.5, h: 11 }, { rot: [0, 0, 90], pos: [0, -2.5, 0], mode: 'solid' }),
      obj('cylinder', { r: 0.5, h: 11 }, { rot: [90, 0, 0], pos: [0, -1.5, 0], mode: 'solid' }),
    ], 0.3),
    probes: [[1.6, -4.2, 1.6]],
  });

  {
    const d = doc([obj('torus', { R: 3.5, r: 1.4 }, { id: 'tor' })], 0.3);
    d.pins = [{ id: 'tp', objectId: 'tor', point: [3.5, 1.4, 0], normal: [0, 1, 0], radius: 0.4 }];
    list.push({ id: 'torus', title: 'Torus with pin hole', notes: 'Hollow ring with one pin hole on top.', doc: d, probes: [[-3.5, 0, 0]] });
  }

  {
    const objects: SceneObject[] = [];
    for (let i = -1; i <= 1; i++) {
      objects.push(obj('box', { x: 9, y: 1.2, z: 1.2 }, { pos: [0, i * 3, i * 1.5] }));
      objects.push(obj('box', { x: 1.2, y: 9, z: 1.2 }, { pos: [i * 3, 0, -i * 1.5] }));
      objects.push(obj('box', { x: 1.2, y: 1.2, z: 6 }, { pos: [i * 3, -i * 3, 0] }));
    }
    objects[0].holes = ['nx'];
    list.push({ id: 'lattice', title: 'Box lattice', notes: 'Architectural lattice of 9 overlapping beams, one beam end open.', doc: doc(objects, 0.25), probes: [[0, -3, -1.5]] });
  }

  list.push({
    id: 'vase-thin', title: 'Thin vase 0.2 cm', notes: 'Extreme: 0.2 cm wall.',
    doc: doc([obj('revolve', { points: vase }, { holes: ['top'] })], 0.2), probes: [[0, -3, 0], [0, 2, 0]],
  });

  {
    const d = chain(12, 1.0, 1.75, 0.2, false);
    d.objects[0].holes = ['surface'];
    list.push({ id: 'chain-thin', title: 'Thin chain 0.2 cm', notes: 'Extreme: 12 spheres at 0.2 cm; the first sphere\'s whole surface is an opening.', doc: d, probes: chainProbes(d).slice(1) });
  }

  list.push({
    id: 'transformed', title: 'Rotated + stretched', notes: 'Non-uniformly scaled, rotated box joined with a stretched sphere; the rotated box face is the opening.',
    doc: doc([
      obj('box', { x: 4, y: 4, z: 4 }, { rot: [25, 35, 10], scale: [1.6, 0.8, 1.1], holes: ['py'] }),
      obj('sphere', { r: 2.2 }, { pos: [2.5, -1.5, 0.5], scale: [1, 1.5, 0.8] }),
    ], 0.35),
    probes: [[0, 0, 0], [2.5, -1.5, 0.5]],
  });

  list.push({
    id: 'rotated-box', title: 'Rotated open box', notes: 'Uniform-scale cube rotated off the grid axes, one face open: rim edges must stay straight.',
    doc: doc([obj('box', { x: 6, y: 6, z: 6 }, { rot: [20, 30, 12], holes: ['py'] })], 0.35), probes: [[0, -0.5, 0]],
  });

  list.push({
    id: 'tower', title: 'Prism tower', notes: 'Hexagonal prism stack with a cone roof, open bottom.',
    doc: doc([
      obj('prism', { n: 6, r: 3, h: 4 }, { pos: [0, -3, 0], holes: ['bottom'] }),
      obj('prism', { n: 6, r: 2.3, h: 4 }, { pos: [0, 0.8, 0], rot: [0, 30, 0] }),
      obj('cone', { r: 3, h: 3.5 }, { pos: [0, 4.4, 0] }),
    ], 0.3),
    probes: [[0, -2, 0], [0, 1.5, 0]],
  });

  list.push({
    id: 'thick-wall', title: 'Wall thicker than cavity', notes: 'A 1.2 cm wall: the thin capsule arm is too narrow for a cavity and stays solid; the big sphere is hollow.',
    doc: doc([
      obj('sphere', { r: 3.2 }),
      obj('capsule', { r: 0.9, h: 6 }, { rot: [0, 0, 90], pos: [5, 0, 0] }),
      obj('box', { x: 3, y: 3, z: 3 }, { pos: [0, 3.3, 0], holes: ['py'] }),
    ], 1.2),
    probes: [[0, -0.5, 0]],
  });

  list.push({
    id: 'cut-sphere', title: 'Sphere with a cut', notes: 'Sphere with a box carved out (cut mode) before shelling; the cut face follows the shell.',
    doc: doc([
      obj('sphere', { r: 3.5 }, { holes: [] }),
      obj('box', { x: 4, y: 4, z: 4 }, { pos: [2.6, 2.6, 0], rot: [0, 0, 15], mode: 'cut' }),
      obj('cylinder', { r: 1.2, h: 2 }, { pos: [0, -3.6, 0], holes: ['bottom'] }),
    ], 0.35),
    probes: [[-1, -1, 0]],
  });

  return list;
}
