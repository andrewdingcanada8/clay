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
    // (a group's Round is now compound: it rounds the body as a whole, by design)
    for (const ex of examples().filter((e) => !e.doc.groups.some((g) => (g.round ?? 0) > 0))) {
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

  it('a cut above a hollow group cuts its walls too (no wall round the cut)', () => {
    const d = emptyDoc();
    const body = makeObject('box', box(0, 0, 0, 8));
    d.objects.push(body);
    d.groups[0].children = [body.id];
    const cut = makeObject('box', { ...box(4, 0, 0, 4), mode: 'subtract', groupId: '' });
    d.objects.push(cut);
    d.root!.push(cut.id);
    const g = compileGroups(expandDoc(d));
    const f = (x: number) => evalScene(g, approxDepth, x, 0, 0);
    expect(f(2.3)).toBeGreaterThan(0); // just inside the cut: empty, no wall
    expect(f(-3.8)).toBeLessThan(0); // the far wall
    expect(f(0)).toBeGreaterThan(0); // the hollow
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

describe('exact layer order', () => {
  // the user's goop: a box, a sphere carved from it, a smaller sphere added back on top, blended
  const goop = (blend: number) => {
    const d = emptyDoc();
    const g = d.groups[0];
    g.shell = false;
    g.blend = blend;
    const b = makeObject('box', { params: { x: 16, y: 16, z: 16 } });
    const s1 = makeObject('sphere', { mode: 'subtract', params: { r: 10.4 } });
    const s2 = makeObject('sphere', { params: { r: 6 }, transform: { position: [0, 0, 1.5], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    d.objects.push(b, s1, s2);
    g.children = [b.id, s1.id, s2.id];
    return compileGroups(expandDoc(d));
  };
  it('an Add above a Subtract is not cut by it', () => {
    const g = goop(0);
    const f = (x: number, y: number, z: number) => evalScene(g, approxDepth, x, y, z);
    expect(f(0, 0, 1.5)).toBeCloseTo(-6, 3); // the top sphere, whole
    expect(f(0, 0, -8)).toBeGreaterThan(0); // between it and the box: carved
    expect(f(7.9, 7.9, 7.9)).toBeLessThan(0); // the box's corner survives
  });
  it('Blend makes the cut smooth too', () => {
    const sharp = goop(0), soft = goop(3);
    // on the cut's rim, where the sphere leaves the box's face: a fillet takes material off
    const p: [number, number, number] = [0, 6.4, 8];
    expect(evalScene(soft, approxDepth, ...p)).toBeGreaterThan(evalScene(sharp, approxDepth, ...p));
  });
  it('inside a hollow group order holds, and the hollow follows the result', async () => {
    const d = emptyDoc();
    const g = d.groups[0];
    const b = makeObject('box', { params: { x: 10, y: 10, z: 10 } });
    const cut = makeObject('box', { mode: 'subtract', params: { x: 4, y: 20, z: 4 } });
    const plug = makeObject('cylinder', { params: { r: 1, h: 10 } });
    d.objects.push(b, cut, plug);
    g.children = [b.id, cut.id, plug.id];
    const groups = compileGroups(expandDoc(d));
    expect(groups[0].complex).toBe(true);
    const { cavityGrids, depthFromGrids } = await import('../src/engine/sdfKernel');
    const grids: ReturnType<typeof cavityGrids> = [];
    cavityGrids(groups, 'normal').forEach((c, i) => { grids[groups[i].index] = c; });
    const depth = depthFromGrids(grids);
    const f = (x: number, y: number, z: number) => evalScene(groups, depth, x, y, z);
    expect(f(0, 0, 0)).toBeGreaterThan(0); // the plug is hollow too
    expect(f(0.8, 0, 0)).toBeLessThan(0); // its wall
    expect(f(1.6, 0, 0)).toBeGreaterThan(0); // the cut around it
  });
  it('cutouts and pins migrate to cuts and Hole layers', () => {
    const old = emptyDoc();
    old.root = undefined;
    const body = makeObject('sphere', { id: 'body', params: { r: 5 }, groupId: old.groups[0].id });
    const co = makeObject('box', { id: 'co', mode: 'cutout', params: { x: 2, y: 2, z: 2 }, transform: { position: [0, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, groupId: old.groups[0].id });
    old.objects.push(body, co);
    old.pins.push({ id: 'p1', objectId: 'body', point: [5, 0, 0], normal: [1, 0, 0], radius: 0.5 });
    const t = toLayers(old);
    expect(t.objects.find((o) => o.id === 'co')!.mode).toBe('subtract');
    expect(t.pins.length).toBe(0);
    const hole = t.objects.find((o) => o.name === 'Hole')!;
    expect(hole.mode).toBe('subtract');
    // both sit above the hollow group, not inside it
    expect(t.groups.find((g) => g.id === old.groups[0].id)!.children).toEqual(['body']);
    const groups = compileGroups(expandDoc(t));
    const f = (x: number, y: number, z: number) => evalScene(groups, approxDepth, x, y, z);
    expect(f(4.8, 0, 0)).toBeGreaterThan(0); // the hole goes through the wall
    expect(f(0, 4.8, 0)).toBeGreaterThan(0); // so does the cut
    expect(f(0, -4.8, 0)).toBeLessThan(0); // the wall elsewhere
  });
});

describe('blended nested group in a hollow body', () => {
  it('a thin wall stays whole where a blended neck joins the body', async () => {
    const d = emptyDoc();
    const g1 = d.groups[0];
    g1.thickness = 0.13;
    const sphere = makeObject('sphere', { params: { r: 9 } });
    const neck = makeObject('cylinder', { params: { r: 2, h: 5.2 }, holes: ['top'], transform: { position: [0, 10.13, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    const g2 = newGroup('g2', 'Group 2', { shell: false, blend: 1.6, children: [sphere.id, neck.id] });
    sphere.groupId = neck.groupId = 'g2';
    d.objects.push(sphere, neck);
    d.groups.push(g2);
    g1.children = ['g2'];
    const groups = compileGroups(expandDoc(d));
    const body = groups.find((g) => g.hollow)!;
    expect(body.k).toBeCloseTo(1.6, 6);
    const { cavityGrids, depthFromGrids } = await import('../src/engine/sdfKernel');
    const grids: ReturnType<typeof cavityGrids> = [];
    cavityGrids(groups, 'normal').forEach((c, i) => { grids[groups[i].index] = c; });
    const depth = depthFromGrids(grids);
    const f = (x: number, y: number, z: number) => evalScene(groups, depth, x, y, z);
    // walk the outer surface across the joint; just inside it must be clay
    for (let y = 7.5; y <= 10; y += 0.1) {
      let x = 6;
      for (let it = 0; it < 60; it++) { const v = f(x, y, 0); if (Math.abs(v) < 1e-3) break; x -= v; }
      // x is on the outer surface (or on the cut through it); step 0.05 inward along -x
      const inside = f(x - 0.05, y, 0);
      expect(inside, `y ${y.toFixed(1)}`).toBeLessThan(0);
    }
  }, 60000);
});

describe('a group blended into its parent', () => {
  it("its objects reach as far as the parent's blend (culling, bounds)", () => {
    const d = emptyDoc();
    const g1 = d.groups[0];
    const ball = makeObject('sphere', { params: { r: 8 } });
    ball.groupId = g1.id;
    g1.children = [ball.id];
    const disc = makeObject('cylinder', { params: { r: 10, h: 2 }, transform: { position: [0, -8, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    const g2 = newGroup('g2', 'Group 2', { shell: false, children: [disc.id] });
    disc.groupId = 'g2';
    const g3 = newGroup('g3', 'Group 3', { shell: false, blend: 8, children: [g1.id, 'g2'] });
    d.objects.push(ball, disc);
    d.groups.push(g2, g3);
    d.root = ['g3'];
    const groups = compileGroups(expandDoc(d));
    const discBody = groups.find((g) => g.shells.some((o) => o.obj.id === disc.id) || g.solids.some((o) => o.obj.id === disc.id))!;
    const ballBody = groups.find((g) => g.shells.some((o) => o.obj.id === ball.id))!;
    expect(discBody.reach).toBe(8);
    expect(ballBody.reach).toBe(8);
    expect(ballBody.k).toBe(0); // its own hollow isn't smoothed by the outer blend
    expect(discBody.bounds.max[0]).toBeGreaterThanOrEqual(10 + 2 - 1e-9);
    // the fillet past the disc's box is in the field
    expect(evalScene(groups, approxDepth, 10.3, -7.5, 0)).toBeLessThan(0);
  });
});

describe('holes', () => {
  it('a hole goes through the wall it is drilled into and nothing behind it', async () => {
    const { addHole } = await import('../src/engine/layers');
    const { wallReach } = await import('../src/engine/scene');
    const { cavityGrids, depthFromGrids } = await import('../src/engine/sdfKernel');
    // a thin flat vessel: 1 cm deep, 0.2 cm walls, so the far wall is close behind
    const d = emptyDoc();
    d.groups[0].thickness = 0.2;
    const slab = makeObject('box', { params: { x: 10, y: 10, z: 1 } });
    d.objects.push(slab);
    d.groups[0].children = [slab.id];
    const build = () => {
      const groups = compileGroups(expandDoc(d));
      const grids: ReturnType<typeof cavityGrids> = [];
      cavityGrids(groups, 'normal').forEach((c, i) => { grids[groups[i].index] = c; });
      return { groups, depth: depthFromGrids(grids) };
    };
    let { groups, depth } = build();
    const reach = wallReach(groups, depth, [0, 0, 0.5], [0, 0, 1], 1, 3 * 0.2 + 2 + 1)!;
    expect(reach).toBeGreaterThan(0.15);
    expect(reach).toBeLessThan(0.4); // stops at the hollow, short of the far wall (0.8 in)
    addHole(d, slab.id, [0, 0, 0.5], [0, 0, 1], 1, reach + 0.07);
    ({ groups, depth } = build());
    const f = (x: number, y: number, z: number) => evalScene(groups, depth, x, y, z);
    expect(f(0, 0, 0.4)).toBeGreaterThan(0); // the front wall is drilled through
    expect(f(0.5, 0.5, 0.4)).toBeGreaterThan(0);
    expect(f(0, 0, -0.4)).toBeLessThan(0); // the back wall is untouched
    expect(f(0, 3, 0.4)).toBeLessThan(0); // the front wall beside the hole too
  }, 120000);
});

describe('a layer added above a cut in a hollow group', () => {
  it('is hollowed and opens, though it lies inside the cut below it', async () => {
    const { cavityGrids, depthFromGrids } = await import('../src/engine/sdfKernel');
    const d = emptyDoc();
    const g = d.groups[0];
    g.thickness = 0.5;
    const body = makeObject('box', { params: { x: 10, y: 10, z: 10 } });
    const cut = makeObject('box', { mode: 'subtract', params: { x: 6, y: 20, z: 6 }, transform: { position: [7, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    // a spout reaching out through the cut's volume, open at its end
    const spout = makeObject('cylinder', { params: { r: 1.5, h: 8 }, holes: ['top'], transform: { position: [7, 0, 0], rotation: [0, 0, -90], scale: [1, 1, 1] } });
    d.objects.push(body, cut, spout);
    g.children = [body.id, cut.id, spout.id];
    const groups = compileGroups(expandDoc(d));
    expect(groups[0].cutsBound).toBe(false);
    const grids: ReturnType<typeof cavityGrids> = [];
    cavityGrids(groups, 'normal').forEach((c, i) => { grids[groups[i].index] = c; });
    const depth = depthFromGrids(grids);
    const f = (x: number, y: number, z: number) => evalScene(groups, depth, x, y, z);
    expect(f(7, 0, 0)).toBeGreaterThan(0); // inside the spout: hollow
    expect(f(7, 1.3, 0)).toBeLessThan(0); // its wall
    expect(f(10.9, 0, 0)).toBeGreaterThan(0); // its end is open
  }, 120000);
});

describe('mask layers', () => {
  const ball = (r: number, x = 0, y = 0, z = 0, extra: Record<string, unknown> = {}) =>
    makeObject('sphere', { params: { r }, transform: { position: [x, y, z], rotation: [0, 0, 0], scale: [1, 1, 1] }, ...extra });
  const solidGroup = () => { const d = emptyDoc(); d.groups[0].shell = false; return d; };

  it('an object mask keeps only what is below it inside its shape, and adds nothing', () => {
    const d = solidGroup();
    const body = makeObject('box', box(0, 0, 0, 4));
    const mask = ball(1.5, 1.5, 0, 0, { mode: 'mask' });
    d.objects.push(body, mask);
    d.groups[0].children = [body.id, mask.id];
    const x = flattenLayers(d);
    expect(x.program!.find((p) => p[0] === 'o' && p[1] === mask.id)![2]).toBe(4);
    const g = compileGroups(x);
    const f = (px: number, py: number, pz: number) => evalScene(g, approxDepth, px, py, pz);
    expect(f(1.5, 0, 0)).toBeLessThan(0); // in both
    expect(f(-1.5, 0, 0)).toBeGreaterThan(0); // in the box, outside the mask
    expect(f(2.6, 0, 0)).toBeGreaterThan(0); // in the mask, outside the box
    expect(f(1.5, 1.6, 0)).toBeGreaterThan(0); // in the box, just outside the ball
    expect(f(1.5, 0, 0)).toBeCloseTo(-Math.min(0.5, 1.5), 6); // the box's +x face is nearest
  });

  it('layers above a mask are not masked', () => {
    const d = solidGroup();
    const body = makeObject('box', box(0, 0, 0, 4));
    const mask = ball(1, 1.5, 0, 0, { mode: 'mask' });
    const top = ball(0.5, -1.5, 0, 0);
    d.objects.push(body, mask, top);
    d.groups[0].children = [body.id, mask.id, top.id];
    const g = compileGroups(flattenLayers(d));
    expect(evalScene(g, approxDepth, -1.5, 0, 0)).toBeLessThan(0); // the top ball stays
    expect(evalScene(g, approxDepth, -1.5, 1.5, 0)).toBeGreaterThan(0); // the box there is masked away
  });

  it('a group can be a mask: its layers make the shape (not hollowed, not drawn)', () => {
    const d = solidGroup();
    const body = makeObject('box', box(0, 0, 0, 8));
    const a = ball(1, -2, 0, 0), b = ball(1, 2, 0, 0);
    const mg = newGroup('mg', 'Mask', { op: 'mask', shell: true, children: [a.id, b.id] });
    d.objects.push(body, a, b);
    d.groups.push(mg);
    d.groups[0].children = [body.id, 'mg'];
    const x = flattenLayers(d);
    expect(x.groups.some((u) => u.id === 'mg')).toBe(false); // no hollow body
    expect(x.objects.filter((o) => o.id === a.id || o.id === b.id).every((o) => o.mode === 'mask')).toBe(true);
    const g = compileGroups(x);
    const f = (px: number, py: number, pz: number) => evalScene(g, approxDepth, px, py, pz);
    expect(f(-2, 0, 0)).toBeLessThan(0);
    expect(f(2, 0, 0)).toBeLessThan(0);
    expect(f(0, 0, 0)).toBeGreaterThan(0); // between the balls: masked away
    expect(f(0, 3, 0)).toBeGreaterThan(0);
  });

  it('a mask inside a hollow group: the walls follow it', async () => {
    const d = emptyDoc();
    d.groups[0].thickness = 0.5;
    const body = makeObject('box', box(0, 0, 0, 8));
    const mask = ball(3.5, 2, 0, 0, { mode: 'mask' });
    d.objects.push(body, mask);
    d.groups[0].children = [body.id, mask.id];
    const groups = compileGroups(flattenLayers(d));
    const unit = groups.find((u) => u.hollow)!;
    expect(unit.complex).toBe(true);
    const { cavityGrids, depthFromGrids } = await import('../src/engine/sdfKernel');
    const grids: ReturnType<typeof cavityGrids> = [];
    cavityGrids(groups, 'normal').forEach((c, i) => { grids[groups[i].index] = c; });
    const depth = depthFromGrids(grids);
    const f = (px: number, py: number, pz: number) => evalScene(groups, depth, px, py, pz);
    // along -x: the mask's surface is at x = -1.5; a wall inside it, then the hollow
    expect(f(-1.6, 0, 0)).toBeGreaterThan(0); // masked away
    expect(f(-1.25, 0, 0)).toBeLessThan(0); // the wall along the mask
    expect(f(0.5, 0, 0)).toBeGreaterThan(0); // the hollow
    expect(f(3.75, 0, 0)).toBeLessThan(0); // the box's own wall
  }, 60000);

  it('a mask above a hollow group trims the finished walls (opens it)', async () => {
    const d = emptyDoc();
    d.groups[0].thickness = 0.5;
    const body = makeObject('box', box(0, 0, 0, 8));
    d.objects.push(body);
    d.groups[0].children = [body.id];
    const mask = ball(3.5, 2, 0, 0, { mode: 'mask', groupId: '' });
    d.objects.push(mask);
    d.root = [d.groups[0].id, mask.id];
    const groups = compileGroups(flattenLayers(d));
    const { cavityGrids, depthFromGrids } = await import('../src/engine/sdfKernel');
    const grids: ReturnType<typeof cavityGrids> = [];
    cavityGrids(groups, 'normal').forEach((c, i) => { grids[groups[i].index] = c; });
    const depth = depthFromGrids(grids);
    const f = (px: number, py: number, pz: number) => evalScene(groups, depth, px, py, pz);
    expect(f(-1.25, 0, 0)).toBeGreaterThan(0); // no wall at the mask's surface: the hollow is open there
    expect(f(3.75, 0, 0)).toBeLessThan(0); // the box's wall inside the mask stays
    expect(f(2, 0, 0)).toBeGreaterThan(0); // the hollow
    expect(f(2, 3.75, 0)).toBeGreaterThan(0); // the top wall, outside the mask
  }, 60000);
});
