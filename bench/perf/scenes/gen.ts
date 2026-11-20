// Benchmark scenes for the SDF view (bench/perf/README.md). Built from the engine's own
// document helpers so they stay valid documents. Run: npm run perf:scenes
// Scenes are for the graphics engine, not for looks: each one leans on something
// that costs (sweeps, blends, shells, cuts, masks, symmetry, many pieces).
import fs from 'node:fs';
import path from 'node:path';
import { type Group, type PrimitiveParams, type SceneDoc, type SceneObject, emptyDoc, makeObject, newGroup } from '../../../src/engine/document';
import type { ProfilePoint } from '../../../src/engine/profile';

type V3 = [number, number, number];
const T = (p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]) => ({ position: p, rotation: r, scale: s });
const P = (r: number, y: number, smooth?: number): ProfilePoint => (smooth === undefined ? { r, y } : { r, y, smooth });

let seq = 0;
const id = (p: string) => `${p}${(++seq).toString(36)}`;

/** A small builder over the layer tree: groups hold children bottom to top. */
class Doc {
  d: SceneDoc = emptyDoc();
  constructor() { this.d.groups = []; this.d.objects = []; this.d.root = []; }
  group(parent: string | null, name: string, extra: Partial<Group> = {}): string {
    const g = newGroup(id('g'), name, { shell: false, ...extra });
    this.d.groups.push(g);
    this.attach(parent, g.id);
    return g.id;
  }
  obj(parent: string | null, type: SceneObject['type'], opts: Partial<SceneObject> & { params?: PrimitiveParams } = {}): string {
    const o = makeObject(type, { ...opts, id: id('o') });
    if (opts.params) o.params = { ...o.params, ...opts.params };
    o.groupId = parent ?? '';
    this.d.objects.push(o);
    this.attach(parent, o.id);
    return o.id;
  }
  private attach(parent: string | null, cid: string) {
    if (!parent) this.d.root!.push(cid);
    else this.d.groups.find((g) => g.id === parent)!.children!.push(cid);
  }
}

const VASE: ProfilePoint[] = [P(6, -12, 0), P(9, -7), P(8.5, 0), P(4.5, 7), P(6, 12, 0)];
// a rib running down the outside of VASE (x = radius, y = height), slightly proud of it
const RIB: ProfilePoint[] = [P(6.4, -11.4, 0), P(9.5, -7), P(9, 0), P(5, 7), P(6.3, 11.2, 0)];

/** The composite piece: a bit of everything the renderer has to handle. */
function piece(b: Doc, parent: string | null, at: V3, ribs = 12): string {
  const root = b.group(parent, 'Piece', { transform: T(at) });
  // hollow body: open-top revolve, radial ribs, a torus collar, a hexagonal foot, blended
  const body = b.group(root, 'Body', { shell: true, thickness: 0.6, blend: 0.8 });
  const rev = b.obj(body, 'revolve', { params: { points: VASE }, holes: ['top'] });
  b.obj(body, 'sweep', { mode: 'solid', params: { plane: 'xy', path: RIB, section: 'circle', w: 1.4, d: 1.4, cap: 'round' }, sym: { kind: 'radial', ref: rev, axis: 'y', count: ribs } });
  b.obj(body, 'torus', { params: { R: 5.2, r: 0.9 }, transform: T([0, 6.5, 0]) });
  b.obj(body, 'prism', { params: { n: 6, r: 6.6, r2: 6.2, h: 1.6 }, transform: T([0, -12.4, 0]) });
  // a window cut inside the hollow group, and a knob added above the cut
  b.obj(body, 'box', { mode: 'subtract', params: { x: 3, y: 4, z: 6 }, transform: T([0, -1, 8.5]) });
  b.obj(body, 'sphere', { params: { r: 1.4 }, transform: T([0, -1, 9.2]) });
  // spout: its own hollow group, a cone plus a custom-section sweep with lift
  const spout = b.group(body, 'Spout', { shell: true, thickness: 0.5, blend: 0.6 });
  b.obj(spout, 'cone', { params: { r: 2.2, h: 7 }, transform: T([-9, 3, 0], [0, 0, 55]) });
  b.obj(spout, 'sweep', {
    params: {
      plane: 'xy', path: [P(-8, 5, 0), P(-11, 7), P(-14, 10, 0)], section: 'custom', w: 2.2, d: 1.6,
      shape: [P(-1, -1, 0), P(1, -1, 0), P(0.8, 0.6), P(0, 1.1), P(-0.8, 0.6)], lift: [P(0, 0), P(0.5, 0.8), P(1, 0)], join: 'miter',
    },
  });
  // a drilled hole through the wall (a cut above the hollow group) and a handle
  b.obj(root, 'cylinder', { mode: 'subtract', params: { r: 0.9, h: 6 }, transform: T([7.5, 3, 0], [0, 0, 90]) });
  b.obj(root, 'sweep', { mode: 'shell', params: { plane: 'xy', path: [P(8, 6, 0), P(12, 5), P(13, 0), P(11, -5), P(8.5, -6, 0)], section: 'circle', w: 1.8, d: 1.8 } });
  // tabs: a group repeated 3 times round Y holding a plate, a box cut mirrored across
  // X, and another cut (symmetry inside symmetry)
  const tabs = b.group(root, 'Tabs', { shell: true, thickness: 0.5, sym: { kind: 'radial', ref: rev, axis: 'y', count: 3 }, transform: T([0, -9.5, 0]) });
  b.obj(tabs, 'revolve', { params: { points: [P(8, -0.6, 0), P(11.5, -0.4), P(11.5, 0.4), P(8, 0.6, 0)] } });
  b.obj(tabs, 'box', { mode: 'subtract', params: { x: 16, y: 6, z: 26 }, transform: T([12.5, 0, 0]), sym: { kind: 'mirror', ref: null, axis: 'x', count: 2 } });
  b.obj(tabs, 'box', { mode: 'subtract', params: { x: 16, y: 6, z: 16 }, transform: T([0, 0, 5]) });
  // a mask over the whole piece: keeps what's below inside a big rounded box
  const mask = b.group(root, 'Mask', { op: 'mask' });
  b.obj(mask, 'box', { params: { x: 40, y: 27, z: 40 }, transform: T([0, 0.5, 0]) });
  return root;
}

/** A small second piece: a cup with a handle. */
function cup(b: Doc, parent: string | null, at: V3) {
  const g = b.group(parent, 'Cup', { shell: true, thickness: 0.5, blend: 0.5, transform: T(at) });
  b.obj(g, 'revolve', { params: { points: [P(3.5, -5, 0), P(5, -3), P(5.2, 4), P(5.4, 5, 0)] }, holes: ['top'] });
  b.obj(g, 'sweep', { mode: 'solid', params: { plane: 'xy', path: [P(5, 3, 0), P(8, 2), P(8, -2), P(5, -3, 0)], section: 'circle', w: 1.2, d: 1.2 } });
}

interface Scene { name: string; group: 'headline' | 'stress' | 'scaling'; note: string; doc: SceneDoc; view?: { dir?: V3; zoom?: number } }
const scenes: Scene[] = [];
const add = (name: string, group: Scene['group'], note: string, build: (b: Doc) => void, view?: Scene['view']) => {
  seq = 0;
  const b = new Doc();
  build(b);
  b.d.kernel = 'sdf';
  scenes.push({ name, group, note, doc: b.d, view });
};

add('composite', 'headline', 'Everything at once: hollow revolve with radial ribs, blends, a torus, a prism foot, a cut inside a hollow group with an add above it, a nested hollow spout with a custom-section lifted sweep, a drilled hole, a handle, tabs with symmetry inside symmetry, a mask, and a second piece.',
  (b) => { piece(b, null, [0, 0, 0]); cup(b, null, [24, -7, 0]); });

for (const n of [8, 16, 32, 64]) add(`sweeps-${n}`, 'scaling', `${n} radial sweep ribs on a hollow revolve`, (b) => {
  const g = b.group(null, 'Body', { shell: true, thickness: 0.6, blend: 0.6 });
  const rev = b.obj(g, 'revolve', { params: { points: VASE }, holes: ['top'] });
  b.obj(g, 'sweep', { mode: 'solid', params: { plane: 'xy', path: RIB, section: 'circle', w: 1.2, d: 1.2 }, sym: { kind: 'radial', ref: rev, axis: 'y', count: n } });
});

for (const n of [1, 4, 9]) add(`pieces-${n}`, 'scaling', `${n} copies of the composite piece in a grid`, (b) => {
  const k = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) piece(b, null, [(i % k) * 34, 0, Math.floor(i / k) * 34], 8);
});

add('blend-heavy', 'stress', '12 spheres, capsules and tori in one group with a big blend', (b) => {
  const g = b.group(null, 'Goop', { shell: false, blend: 3 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, r = 5 + (i % 3) * 2;
    const type = (['sphere', 'capsule', 'torus'] as const)[i % 3];
    b.obj(g, type, { params: type === 'sphere' ? { r: 3 } : type === 'capsule' ? { r: 1.5, h: 6 } : { R: 3, r: 1 }, transform: T([r * Math.cos(a), (i % 4) * 2 - 3, r * Math.sin(a)], [i * 20, i * 35, 0]) });
  }
});

add('shell-heavy', 'stress', 'Nested hollow groups with openings, and cuts above them', (b) => {
  const outer = b.group(null, 'Outer', { shell: true, thickness: 0.6, blend: 1 });
  b.obj(outer, 'revolve', { params: { points: VASE }, holes: ['top'] });
  b.obj(outer, 'box', { params: { x: 14, y: 6, z: 6 }, transform: T([0, -4, 0]), holes: ['px', 'nx'] });
  for (let i = 0; i < 3; i++) {
    const inner = b.group(outer, `Inner ${i}`, { shell: true, thickness: 0.4, blend: 0.6, transform: T([0, 2 + i * 4, 0], [0, i * 60, 0]) });
    b.obj(inner, 'cylinder', { params: { r: 2, h: 10 }, transform: T([0, 0, 0], [90, 0, 0]), holes: ['top', 'bottom'] });
    b.obj(inner, 'sphere', { params: { r: 2.5 } });
  }
  b.obj(null, 'box', { mode: 'subtract', params: { x: 30, y: 30, z: 30 }, transform: T([0, 0, -15]) });
  b.obj(null, 'sphere', { params: { r: 2 }, transform: T([0, 0, 0]) });
});

add('csg-chain', 'stress', '30 alternating add and cut steps along a bar', (b) => {
  const g = b.group(null, 'Chain', { shell: false, blend: 0.4 });
  b.obj(g, 'box', { params: { x: 40, y: 6, z: 6 } });
  for (let i = 0; i < 30; i++) b.obj(g, 'sphere', { mode: i % 2 ? 'subtract' : 'shell', params: { r: 2.2 + (i % 3) * 0.4 }, transform: T([-19 + i * 1.3, (i % 2 ? 2.5 : -2.5), (i % 4) - 1.5]) });
});

add('custom-section', 'stress', 'Sweeps with polygon sections, miters and sharp corners', (b) => {
  const g = b.group(null, 'Sweeps', { shell: false, blend: 0.5 });
  for (let i = 0; i < 6; i++) b.obj(g, 'sweep', {
    params: {
      plane: 'xz', path: [P(-8, -8, 0), P(8, -8, 0), P(8, 8, 0), P(-8, 8, 0)], closed: true, section: 'custom', w: 2, d: 2, join: 'miter',
      shape: [P(-1, -1, 0), P(1, -1, 0), P(1, 0.2, 0), P(0, 1, 0), P(-1, 0.2, 0)], lift: [P(0, 0), P(1, 6)],
    },
    transform: T([0, i * 3 - 8, 0], [0, i * 15, 0]),
  });
});

add('grazing', 'stress', 'Thin walls and flat faces seen edge-on (long marches)', (b) => {
  const g = b.group(null, 'Plates', { shell: true, thickness: 0.3 });
  for (let i = 0; i < 5; i++) b.obj(g, 'box', { params: { x: 30, y: 0.8, z: 30 }, transform: T([0, i * 2.5, 0]), holes: ['py'] });
}, { dir: [1, 0.06, 0.25] });

add('close-up', 'stress', 'The composite piece filling the screen', (b) => { piece(b, null, [0, 0, 0]); }, { zoom: 0.45 });

const out = process.argv[2] ?? 'bench/perf/scenes';
for (const s of scenes) fs.writeFileSync(path.join(out, `${s.name}.json`), JSON.stringify(s, null, 1));
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(scenes.map((s) => ({ name: s.name, group: s.group, note: s.note })), null, 1));
console.log(scenes.map((s) => `${s.name}: ${s.doc.objects.length} objects`).join('\n'));
