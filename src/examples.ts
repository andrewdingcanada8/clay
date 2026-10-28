// Benchmark scenes. Also offered in the app's Examples menu.
// Units are centimetres. `probes` are points inside the hollow used by the
// benchmark's interior 360° camera.

import { type ObjectMode, type PrimitiveType, type SceneDoc, type SceneObject, circlePath, defaultCoil, defaultSweep, emptyDoc, makeObject, scaleDoc } from './engine/document';
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
  pos?: Vec3; rot?: Vec3; scale?: Vec3; mode?: ObjectMode; holes?: string[]; name?: string; id?: string; group?: string;
} = {}): SceneObject {
  const so = makeObject(type, { params, mode: o.mode ?? 'shell', holes: o.holes ?? [] });
  if (o.group) so.groupId = o.group;
  so.transform = { position: o.pos ?? [0, 0, 0], rotation: o.rot ?? [0, 0, 0], scale: o.scale ?? [1, 1, 1] };
  if (o.name) so.name = o.name;
  so.id = o.id ?? so.id;
  return so;
}

function doc(objects: SceneObject[], thickness: number, extra: Partial<SceneDoc> = {}): SceneDoc {
  const d = { ...emptyDoc(), objects, ...extra };
  d.groups = d.groups.map((g) => ({ ...g, thickness }));
  return d;
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
    id: 'open-box', title: 'Open box', notes: 'Cube with its top face removed, 0.8 cm walls.',
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
    id: 'vase-solid-sticks', title: 'Vase with solid sticks', notes: 'Same vase; the sticks are Solid: never hollowed, but cut where they pass through the vase\'s cavity.',
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
    id: 'thick-wall', title: 'Wall thicker than cavity', notes: 'A 2.5 cm wall: the thin capsule arm is too narrow for a cavity and stays solid; the big sphere is hollow.',
    doc: doc([
      obj('sphere', { r: 3.2 }),
      obj('capsule', { r: 0.9, h: 6 }, { rot: [0, 0, 90], pos: [5, 0, 0] }),
      obj('box', { x: 3, y: 3, z: 3 }, { pos: [0, 3.3, 0], holes: ['py'] }),
    ], 1.2),
    probes: [[0, -0.5, 0]],
  });

  list.push({
    id: 'cut-sphere', title: 'Sphere with a cut', notes: 'Sphere with a Subtract box carved before hollowing: the notch gets its own wall, like the rest of the surface.',
    doc: doc([
      obj('sphere', { r: 3.5 }, { holes: [] }),
      obj('box', { x: 4, y: 4, z: 4 }, { pos: [2.6, 2.6, 0], rot: [0, 0, 15], mode: 'subtract' }),
      obj('cylinder', { r: 1.2, h: 2 }, { pos: [0, -3.6, 0], holes: ['bottom'] }),
    ], 0.35),
    probes: [[-1, -1, 0]],
  });

  // Recreates a scene from a screenshot of an earlier tool: mug + solid handle +
  // joined stick, at a normal wall and at an extreme 0.08 cm wall.
  const mugProfile: ProfilePoint[] = [
    { r: 3.2, y: -4.5, corner: true },
    { r: 3.6, y: -2 },
    { r: 3.8, y: 2 },
    { r: 4.0, y: 4.5, corner: true },
  ];
  const mug = (t: number) => doc([
    obj('revolve', { points: mugProfile }, { holes: ['top'], name: 'Vessel' }),
    obj('torus', { R: 2.2, r: 0.7 }, { pos: [4.3, 0, 0], rot: [90, 0, 0], mode: 'solid', name: 'Solid handle' }),
    obj('cylinder', { r: 1.1, h: 14 }, { pos: [-1.2, 2, 0], rot: [0, 0, -12], name: 'Stick' }),
  ], t);
  list.push({
    id: 'mug-stick', title: 'Mug, handle, stick', notes: 'Hollow mug with a Solid torus handle and a Shell stick through it, 0.6 cm wall.',
    doc: mug(0.25), probes: [[1, -3, 1.5]],
  });
  list.push({
    id: 'mug-thin', title: 'Mug at 0.08 cm', notes: 'Same mug with an extreme 0.08 cm wall: rims must stay clean, no pinholes.',
    doc: mug(0.08), probes: [[1, -3, 1.5]],
  });

  {
    // Two groups: a cup on a saucer. The saucer's Subtract groove overlaps the cup
    // but cannot cut it, because subtractions stay inside their own group.
    const d = doc([
      obj('revolve', { points: cup }, { holes: ['top'], name: 'Cup', pos: [0, 4.3, 0] }),
      obj('cylinder', { r: 5.5, h: 0.8 }, { name: 'Saucer', group: 'g2', mode: 'solid' }),
      obj('torus', { R: 2.8, r: 0.45 }, { name: 'Groove', group: 'g2', mode: 'subtract', pos: [0, 0.45, 0] }),
    ], 0.3);
    d.groups.push({ id: 'g2', name: 'Saucer', thickness: 0.3 });
    list.push({
      id: 'two-groups', title: 'Cup on a saucer (2 groups)', notes: 'Group 1: hollow cup. Group 2: solid saucer with a Subtract groove that overlaps the cup but does not cut it.',
      doc: d, probes: [[0, 3, 1]],
    });
  }

  {
    // Large pin holes on a tightly curved wall: the drill must clear the wall at
    // the rim of the hole, which lies deeper than at its centre.
    const d = doc([obj('cylinder', { r: 3.2, h: 8 }, { holes: ['top'], id: 'bigcyl' })], 0.25);
    d.pins = [
      { id: 'bp1', objectId: 'bigcyl', point: [0, 1, 3.2], normal: [0, 0, 1], radius: 1.2 },
      { id: 'bp2', objectId: 'bigcyl', point: [3.2, -1.5, 0], normal: [1, 0, 0], radius: 0.8 },
    ];
    list.push({ id: 'big-pins', title: 'Big holes on a curve', notes: 'Pin holes almost as wide as the cylinder is round: the hole must cut cleanly all the way round.', doc: d, probes: [[0, -2, 0]] });
  }

  list.push({
    id: 'frustums', title: 'Tapered prisms', notes: 'A hexagonal pyramid (top radius 0) on a flared square prism (top wider than bottom), hollow, open at the bottom.',
    doc: doc([
      obj('prism', { n: 4, r: 2.4, r2: 3.6, h: 3 }, { pos: [0, -1.5, 0], holes: ['bottom'] }),
      obj('prism', { n: 6, r: 2.8, r2: 0, h: 4 }, { pos: [0, 2, 0] }),
    ], 0.25),
    probes: [[0, -1, 0]],
  });

  // Cases where the SDF kernel gets it right and the fast mesh offset can't.
  {
    // Two spheres that only just overlap. Each one hollowed on its own leaves its
    // cavity short of the other's, so the mesh offset keeps a sealed double wall
    // across the join; the true inward offset of the union is one connected cavity.
    const d = doc([
      obj('sphere', { r: 3.6 }, { pos: [-3.44, 0, 0], id: 'kl', name: 'Left' }),
      obj('sphere', { r: 3.6 }, { pos: [3.44, 0, 0], id: 'kr', name: 'Right' }),
    ], 0.3);
    d.pins = [{ id: 'kp', objectId: 'kl', point: [0, 3.6, 0], normal: [0, 1, 0], radius: 0.6 }];
    list.push({
      id: 'sdf-narrow-join', title: 'SDF vs Mesh: narrow join', notes: 'Two barely touching spheres. Mesh hollows each separately and leaves a sealed wall across the join; SDF makes one connected cavity. Use a Z section.',
      doc: d, probes: [[-1.5, 0, 0]],
    });
  }
  list.push({
    id: 'sdf-pebble', title: 'SDF vs Mesh: stretched pebble', notes: 'A sphere scaled 1.6 × 0.7 × 1. Mesh offsets the round sphere and stretches it, so walls vary from thin to thick; SDF keeps them even. Use a Z section.',
    doc: doc([obj('sphere', { r: 3.6 }, { scale: [1.6, 0.7, 1], name: 'Pebble' })], 0.3),
    probes: [[0, 0, 0]],
  });
  {
    const d = doc([
      obj('sphere', { r: 3 }, { pos: [0, -1, 0], name: 'Body' }),
      obj('sphere', { r: 2 }, { pos: [0, 3, 0.3], name: 'Head' }),
      obj('capsule', { r: 0.9, h: 3 }, { pos: [2.6, 0.2, 0], rot: [0, 0, -55], name: 'Arm' }),
      obj('capsule', { r: 0.9, h: 3 }, { pos: [-2.6, 0.2, 0], rot: [0, 0, 55], name: 'Arm' }),
      obj('cylinder', { r: 1.2, h: 2 }, { pos: [0, 4.6, 0.3], holes: ['top'], name: 'Neck' }),
    ], 0.3);
    d.groups[0].blend = 1.6;
    list.push({
      id: 'sdf-blend', title: 'SDF vs Mesh: smooth blend', notes: 'Spheres, capsules and an open neck melted together with a smooth blend (Shell tab → Blend). Only the SDF kernel can blend; Mesh shows a sharp union.',
      doc: d, probes: [[0, -1, 0]],
    });
  }

  list.push({
    id: 'teapot', title: 'Large teapot, cut lid opening', notes: 'A ~60 cm teapot with an almost flat top, a round Cutout lid opening, a Shell spout and a Solid handle. The rim of the opening must stay round.',
    doc: doc([
      obj('revolve', { points: [
        { r: 6, y: -8, corner: true }, { r: 11, y: -4 }, { r: 12, y: 1 }, { r: 9.5, y: 6 }, { r: 0.01, y: 7.8, corner: true },
      ] }, { name: 'Body' }),
      obj('cylinder', { r: 4.2, h: 4 }, { pos: [0, 8, 0], mode: 'cutout', name: 'Lid opening' }),
      obj('capsule', { r: 1.6, h: 8 }, { pos: [-12, 5, 0], rot: [0, 0, 45], holes: [], name: 'Spout' }),
      obj('torus', { R: 4, r: 0.9 }, { pos: [12, 1.5, 0], rot: [90, 0, 0], mode: 'solid', name: 'Handle' }),
    ], 0.4),
    probes: [[0, 0, 0]],
  });

  // Sweeps
  {
    const handle = { ...defaultSweep(), plane: 'xy' as const, path: [{ r: 0, y: 2.6, corner: true }, { r: 1.8, y: 2.2 }, { r: 2.4, y: 0.3 }, { r: 1.6, y: -1.6 }, { r: 0, y: -2.2, corner: true }], section: 'circle' as const, w: 0.9, d: 0.9 };
    list.push({
      id: 'sweep-mug', title: 'Mug with a swept handle', notes: 'Revolved mug; the handle is a Solid sweep drawn upright on the XY plane.',
      doc: doc([
        obj('revolve', { points: cup }, { holes: ['top'], name: 'Mug' }),
        obj('sweep', handle, { pos: [3.1, 0.6, 0], mode: 'solid', name: 'Handle' }),
      ], 0.3),
      probes: [[0, -2, 0]],
    });
  }
  list.push({
    id: 'coil', title: 'Hollow coil', notes: 'A circle drawn on the ground, lifted over four turns: a coiled tube, hollowed, open at both ends.',
    doc: doc([obj('sweep', { ...defaultCoil(), path: circlePath(3), turns: 4, lift: [{ r: 0, y: -3, corner: true }, { r: 1, y: 3, corner: true }], w: 1.4, d: 1.4 }, { holes: ['start', 'end'], name: 'Coil' })], 0.25),
    probes: [],
  });
  list.push({
    id: 'sweep-frame', title: 'Square ring, drawn section', notes: 'A closed rounded-square path on the ground with a square section, next to the same path with a drawn tear-drop section.',
    doc: doc([
      obj('sweep', { ...defaultSweep(), plane: 'xz', closed: true, path: [{ r: 3, y: 3, smooth: 0.3 }, { r: -3, y: 3, smooth: 0.3 }, { r: -3, y: -3, smooth: 0.3 }, { r: 3, y: -3, smooth: 0.3 }], section: 'square', w: 1.2, d: 1.6 }, { name: 'Square ring', pos: [-4, 0, 0] }),
      obj('sweep', { ...defaultSweep(), plane: 'xz', closed: true, path: [{ r: 2.5, y: 2.5, smooth: 0.3 }, { r: -2.5, y: 2.5, smooth: 0.3 }, { r: -2.5, y: -2.5, smooth: 0.3 }, { r: 2.5, y: -2.5, smooth: 0.3 }], section: 'custom', w: 1.4, d: 1.8, shape: [{ r: 0, y: 1, corner: true }, { r: 0.8, y: -0.3 }, { r: 0, y: -1 }, { r: -0.8, y: -0.3 }] }, { name: 'Tear-drop ring', pos: [4.5, 0, 0] }),
    ], 0.25),
    probes: [],
  });
  {
    // sharp L-shaped paths: corners and ends in each style
    const L = [{ r: 0, y: -3, corner: true }, { r: 0, y: 1.5, corner: true }, { r: 3, y: 1.5, corner: true }];
    list.push({
      id: 'sweep-corners', title: 'Sweep corners and ends', notes: 'Sharp L-shaped sweeps. Left: round corner, round ends (hollow). Middle: miter corner, square ends, square section (hollow). Right: round corner, flat ends, solid.',
      doc: doc([
        obj('sweep', { ...defaultSweep(), path: L, section: 'circle', w: 1.6, join: 'round', cap: 'round' }, { name: 'Round', pos: [-6, 0, 0] }),
        obj('sweep', { ...defaultSweep(), path: L, section: 'square', w: 1.6, d: 1.6, join: 'miter', cap: 'square' }, { name: 'Miter', pos: [-1, 0, 0] }),
        obj('sweep', { ...defaultSweep(), path: L, section: 'square', w: 1.2, d: 1.6, join: 'round', cap: 'flat' }, { name: 'Solid', pos: [4, 0, 0], mode: 'solid' }),
      ], 0.25),
      probes: [],
    });
  }

  // Scenes are authored small, then scaled to hand size (a vase ~19 cm across).
  // Walls are set per scene in real clay terms; the thin cases stay extreme.
  for (const e of list) {
    scaleDoc(e.doc, SIZE);
    e.probes = e.probes.map((p) => p.map((v) => v * SIZE) as Vec3);
    const w = WALLS[e.id];
    if (w) e.doc.groups = e.doc.groups.map((g) => ({ ...g, thickness: w }));
  }
  return list;
}

/** Geometry scale applied to every scene. */
export const SIZE = 2.5;

const WALLS: Record<string, number> = {
  'open-box': 0.8, 'sphere-cube': 0.8, 'chain-30': 0.6, vase: 0.7, bowl: 0.8, 'cylinder-pins': 0.7,
  'cup-stick': 0.6, 'vase-sticks': 0.6, 'vase-solid-sticks': 0.6, torus: 0.6, lattice: 0.5,
  'vase-thin': 0.2, 'chain-thin': 0.2, transformed: 0.7, 'rotated-box': 0.7, tower: 0.6,
  'thick-wall': 2.5, 'cut-sphere': 0.7, 'mug-stick': 0.6, 'mug-thin': 0.08, 'two-groups': 0.6, 'big-pins': 0.6, frustums: 0.6,
  'sdf-narrow-join': 0.8, 'sdf-pebble': 0.8, 'sdf-blend': 0.6, teapot: 1.0, 'sweep-mug': 0.6, coil: 0.5, 'sweep-frame': 0.5, 'sweep-corners': 0.5,
};
