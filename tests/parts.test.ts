import { describe, expect, it } from 'vitest';
import { emptyDoc, makeObject } from '../src/engine/document';
import { DEG } from '../src/engine/math';
import { composeTransform, expandParts, makePartDef } from '../src/engine/parts';
import { compileObject, toWorld } from '../src/engine/primitives';
import type { Vec3 } from '../src/engine/math';
import { compileGroups } from '../src/engine/scene';

const rot = (r: Vec3, v: Vec3): Vec3 => {
  // three.js XYZ euler: R = Rx * Ry * Rz
  const [a, b, c] = r.map((x) => x * DEG);
  let [x, y, z] = v;
  [x, y] = [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c)];
  [x, z] = [x * Math.cos(b) + z * Math.sin(b), -x * Math.sin(b) + z * Math.cos(b)];
  [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  return [x, y, z];
};

describe('parts', () => {
  it('composes a placement with an inner transform', () => {
    const inner = { position: [1, 2, -3] as Vec3, rotation: [20, -35, 50] as Vec3, scale: [1, 2, 0.5] as Vec3 };
    const outer = { position: [4, -1, 2] as Vec3, rotation: [-15, 60, 10] as Vec3, scale: [1.5, 1.5, 1.5] as Vec3 };
    const o = makeObject('box', { transform: composeTransform(outer, inner) });
    const c = compileObject(o);
    for (const q of [[1, 0, 0], [0.3, -2, 1.1], [-1, 1, 1]] as Vec3[]) {
      const got: Vec3 = [0, 0, 0];
      toWorld(c, q[0], q[1], q[2], got);
      // inner (part space), then the placement
      const pi = rot(inner.rotation, [q[0] * inner.scale[0], q[1] * inner.scale[1], q[2] * inner.scale[2]]).map((v, i) => v + inner.position[i]) as Vec3;
      const want = rot(outer.rotation, pi.map((v) => v * 1.5) as Vec3).map((v, i) => v + outer.position[i]);
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 6);
    }
  });

  it('expands a placed part into its own group, keeping its subtractions inside', () => {
    const src = emptyDoc();
    src.objects.push(makeObject('cylinder', { params: { r: 4, h: 6 }, holes: ['top'] }));
    src.objects.push(makeObject('box', { params: { x: 20, y: 1, z: 1 }, mode: 'subtract' }));
    const g = compileGroups(src)[0];
    const def = makePartDef(src, src.groups[0].id, 'Cup', g.bounds);
    expect(def.objects[0].transform.position[1]).toBeCloseTo(3, 6); // stands on the ground

    const d = emptyDoc();
    d.parts = [def];
    d.objects.push(makeObject('sphere', { params: { r: 5 } }));
    d.objects.push(makeObject('part', { params: { part: def.id }, mode: 'solid', transform: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] } }));
    const x = expandParts(d);
    expect(x.groups.length).toBe(2);
    const own = x.objects.filter((o) => o.groupId === x.groups[1].id);
    expect(own.map((o) => o.mode).sort()).toEqual(['shell', 'subtract']);
    expect(x.groups[1].thickness).toBeCloseTo(2 * def.thickness, 6);
    // the sphere's group gets nothing from the part
    expect(x.objects.filter((o) => o.groupId === x.groups[0].id).length).toBe(1);

    // placed as a Cut: its envelope carves its own group, its inner subtraction is dropped
    d.objects[1].mode = 'subtract';
    const y = expandParts(d);
    expect(y.groups.length).toBe(1);
    expect(y.objects.filter((o) => o.mode === 'subtract').length).toBe(1);
  });
});
