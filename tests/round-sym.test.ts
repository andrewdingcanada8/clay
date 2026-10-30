import { describe, it, expect } from 'vitest';
import { emptyDoc, makeObject } from '../src/engine/document';
import { compileObject } from '../src/engine/primitives';
import { expandDoc } from '../src/engine/symmetry';
import { buildMeshKernel } from '../src/engine/meshKernel';

describe('rounded edges', () => {
  it('a rounded box is the shrunk box grown back by r', () => {
    const c = compileObject(makeObject('box', { params: { x: 4, y: 4, z: 4, round: 1 } }));
    // corner region: centre of the corner ball at (1,1,1); the surface is 1 away from it
    const k = 1 + 1 / Math.sqrt(3);
    expect(c.sdfLocal(k, k, k)).toBeCloseTo(0, 6);
    expect(c.sdfLocal(2, 0, 0)).toBeCloseTo(0, 6); // faces stay where they were
    expect(c.sdfLocal(1.95, 1.95, 1.95)).toBeGreaterThan(0); // the sharp corner is gone
  });
  it('rounded cylinders, cones, revolves and prisms lose their sharp corners', () => {
    const cyl = compileObject(makeObject('cylinder', { params: { r: 2, h: 4, round: 0.5 } }));
    expect(cyl.sdfLocal(1.98, 1.98, 0)).toBeGreaterThan(0);
    expect(cyl.sdfLocal(2, 0, 0)).toBeCloseTo(0, 6);
    const prism = compileObject(makeObject('prism', { params: { n: 6, r: 3, r2: 3, h: 4, round: 0.5 } }));
    expect(prism.sdfLocal(0, 1.98, 3 * Math.cos(Math.PI / 6) - 0.02)).toBeGreaterThan(0);
    expect(prism.sdfLocal(0, 0, 3 * Math.cos(Math.PI / 6))).toBeCloseTo(0, 3);
  });
  it('group rounding reaches every object; meshes stay closed', async () => {
    // (a flat document from before layers: its group Round rounds each object)
    const d = { ...emptyDoc(), root: undefined };
    d.groups[0].round = 0.4;
    d.objects.push(makeObject('box', { params: { x: 4, y: 4, z: 4 }, holes: ['py'] }));
    d.objects.push(makeObject('cylinder', { params: { r: 1.5, h: 6 }, transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }));
    d.objects.push(makeObject('prism', { params: { n: 5, r: 2, r2: 1.5, h: 3 }, transform: { position: [-3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }));
    const x = expandDoc(d);
    expect(x.objects.every((o) => o.params.round === 0.4)).toBe(true);
    const r = await buildMeshKernel({ ...x, kernel: 'mesh' }, 'normal');
    expect(r.stats.triangles).toBeGreaterThan(0);
    expect(r.stats.boundaryEdges).toBe(0);
  });
});

describe('symmetry', () => {
  it('mirrors across a plane through the reference, and repeats round an axis', () => {
    const d = emptyDoc();
    const vase = makeObject('revolve');
    vase.transform.position = [1, 0, 0];
    const h = makeObject('box', { params: { x: 1, y: 2, z: 3 }, holes: ['pz'] });
    h.transform = { position: [4, 1, 0], rotation: [0, 30, 0], scale: [1, 1, 1] };
    h.sym = { kind: 'mirror', ref: vase.id, axis: 'x', count: 2 };
    d.objects.push(vase, h);
    const m = expandDoc(d).objects.filter((o) => o.id.startsWith(h.id));
    expect(m.length).toBe(2);
    expect(m[1].transform.position[0]).toBeCloseTo(-2, 6); // 4 mirrored about x = 1
    expect(m[1].holes).toEqual(['nz']);
    // the mirrored copy's shape is the mirror image: a point and its mirror match
    const a = compileObject(m[0]), b = compileObject(m[1]);
    for (const [x, y, z] of [[4.3, 1.2, 0.8], [3.6, 0.5, -1.2], [4.9, 1.9, 0.1]]) {
      const w = a.sdfLocal(...(local(a, x, y, z)));
      const v = b.sdfLocal(...(local(b, 2 - x, y, z)));
      expect(v).toBeCloseTo(w, 6);
    }
    h.sym = { kind: 'radial', ref: vase.id, axis: 'y', count: 4 };
    const r = expandDoc(d).objects.filter((o) => o.id.startsWith(h.id));
    expect(r.length).toBe(4);
    // a quarter turn about the vase's axis (x = 1, z = 0): (4, 1, 0) -> (1, 1, -3)
    expect(r[1].transform.position[0]).toBeCloseTo(1, 6);
    expect(Math.abs(r[1].transform.position[2])).toBeCloseTo(3, 6);
  });
});

function local(c: ReturnType<typeof compileObject>, x: number, y: number, z: number): [number, number, number] {
  const dx = x - c.pos[0], dy = y - c.pos[1], dz = z - c.pos[2], R = c.rot;
  return [(R[0] * dx + R[3] * dy + R[6] * dz) / c.scale[0], (R[1] * dx + R[4] * dy + R[7] * dz) / c.scale[1], (R[2] * dx + R[5] * dy + R[8] * dz) / c.scale[2]];
}
