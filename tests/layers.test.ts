import { describe, it, expect } from 'vitest';
import { cloneDoc, emptyDoc, makeObject, newGroup, normalizeDoc, type SceneDoc } from '../src/engine/document';
import { examples } from '../src/examples';
import { flattenLayers, toLayers, groupLayers, ungroup, worldTransform } from '../src/engine/layers';
import { expandDoc } from '../src/engine/symmetry';
import { approxDepth, compileGroups, evalScene } from '../src/engine/scene';
import { sceneBounds } from '../src/engine/scene';

/** The built field at n pseudo-random points in the scene's box. */
function samples(d: SceneDoc, n = 200): number[] {
  const groups = compileGroups(expandDoc(d));
  const b = sceneBounds(groups);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = b.min[0] + (b.max[0] - b.min[0]) * rnd(), y = b.min[1] + (b.max[1] - b.min[1]) * rnd(), z = b.min[2] + (b.max[2] - b.min[2]) * rnd();
    out.push(evalScene(groups, approxDepth, x, y, z));
  }
  return out;
}

const box = (x: number, y = 0, z = 0, s = 4) => ({ params: { x: s, y: s, z: s }, transform: { position: [x, y, z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } });

describe('layer tree', () => {
  it('migrating a flat document builds the same field (every example)', () => {
    for (const ex of examples()) {
      const flat = normalizeDoc(cloneDoc(ex.doc));
      flat.root = undefined;
      const a = samples(flat);
      const b = samples(toLayers(cloneDoc(flat)));
      for (let i = 0; i < a.length; i++) expect(b[i], `${ex.id} sample ${i}`).toBeCloseTo(a[i], 6);
    }
  }, 60000);

  it('a cut takes only the layers below it', () => {
    const d = emptyDoc();
    d.groups[0].shell = false;
    const lower = makeObject('box', box(0));
    const cut = makeObject('box', { ...box(0, 0, 0, 2), mode: 'subtract' });
    const upper = makeObject('box', box(0, 0, 0, 1));
    d.objects.push(lower, cut, upper);
    d.groups[0].children = [lower.id, cut.id, upper.id];
    const x = flattenLayers(d);
    const g = compileGroups(x);
    // the centre: carved from the lower box, filled again by the upper one
    expect(evalScene(g, approxDepth, 0, 0, 0)).toBeLessThan(0);
    // inside the cut, outside the upper box: empty
    expect(evalScene(g, approxDepth, 0.8, 0, 0)).toBeGreaterThan(0);
    expect(evalScene(g, approxDepth, 1.5, 0, 0)).toBeLessThan(0);
  });

  it('a hollow group inside a cut group gets the cut as a cutout', () => {
    const d = emptyDoc();
    const body = makeObject('box', box(0, 0, 0, 8));
    d.objects.push(body);
    d.groups[0].children = [body.id];
    const cut = makeObject('box', { ...box(4, 0, 0, 4), mode: 'subtract', groupId: '' });
    d.objects.push(cut);
    d.root!.push(cut.id);
    const x = flattenLayers(d);
    expect(x.groups.length).toBe(1);
    expect(x.objects.filter((o) => o.mode === 'cutout').length).toBe(1);
  });

  it('mirrors inside groups (and of whole groups) are built', () => {
    const d = emptyDoc();
    const a = makeObject('sphere', { params: { r: 1 }, transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, sym: { kind: 'mirror', ref: null, axis: 'x', count: 2 } });
    const inner = newGroup('gi', 'Inner', { shell: false, children: [a.id], sym: { kind: 'mirror', ref: null, axis: 'z', count: 2 }, transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    a.groupId = 'gi';
    d.objects.push(a);
    d.groups.push(inner);
    d.groups[0].children = ['gi'];
    const x = flattenLayers(d);
    const pos = x.objects.map((o) => o.transform.position.map((v) => Math.round(v)).join(',')).sort();
    expect(pos).toEqual(['-3,0,-5', '-3,0,5', '3,0,-5', '3,0,5']);
  });

  it('migrated parts become editable groups, and their mirrors are kept', () => {
    const def = {
      id: 'pdef', name: 'Dumbbell', thickness: 0.5, hollow: true, pins: [],
      objects: [
        makeObject('box', { id: 'b', groupId: 'g' }),
        makeObject('sphere', { id: 's', groupId: 'g', params: { r: 2 }, transform: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, sym: { kind: 'mirror', ref: 'b', axis: 'x', count: 2 } }),
      ],
    };
    const old = emptyDoc();
    old.root = undefined;
    old.parts = [def];
    old.objects.push(makeObject('part', { id: 'placed', params: { part: 'pdef' }, mode: 'solid', groupId: old.groups[0].id }));
    const d = toLayers(old);
    expect(d.groups.find((g) => g.id === 'placed')?.children).toEqual(['placed_b', 'placed_s']);
    const x = flattenLayers(d);
    expect(x.objects.filter((o) => o.type === 'sphere').length).toBe(2);
  });

  it('grouping and ungrouping keep layers in place', () => {
    const d = emptyDoc();
    const a = makeObject('box', box(5, 1, 0));
    d.objects.push(a);
    d.groups[0].children = [a.id];
    d.groups[0].transform = { position: [0, 2, 0], rotation: [0, 90, 0], scale: [2, 2, 2] };
    const before = worldTransform(d, a.id).position;
    const g = groupLayers(d, [a.id], 'G');
    d.groups.find((x) => x.id === g)!.transform = { position: [1, 0, 0], rotation: [0, 0, 30], scale: [1, 1, 1] };
    // moving the new group moves its contents; reset it and the box is where it was
    d.groups.find((x) => x.id === g)!.transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    ungroup(d, g);
    worldTransform(d, a.id).position.forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
  });
});
