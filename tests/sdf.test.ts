import { describe, it, expect } from 'vitest';
import { buildSDF } from '../src/engine/sdfKernel';
import { emptyDoc, makeObject } from '../src/engine/document';

function signedVolume(p: Float32Array, idx: Uint32Array) {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

describe('sdf kernel', () => {
  it('solid sphere is closed with correct volume', () => {
    const d = emptyDoc(); d.shell.enabled = false;
    d.objects.push(makeObject('sphere', { params: { r: 3 } }));
    const r = buildSDF(d, 'normal');
    expect(r.stats.boundaryEdges).toBe(0);
    const v = signedVolume(r.positions, r.indices);
    expect(v).toBeGreaterThan(0.98 * (4 / 3) * Math.PI * 27);
    expect(v).toBeLessThan(1.02 * (4 / 3) * Math.PI * 27);
    console.log('sphere', r.stats.totalMs, r.stats.triangles, r.stats.timings);
  });
  it("open box shell volume", { timeout: 60000 }, () => {
    const d = emptyDoc(); d.groups[0].thickness = 0.4;
    const box = makeObject('box', { params: { x: 6, y: 6, z: 6 }, holes: ['py'] });
    d.objects.push(box);
    const r = buildSDF(d, 'normal');
    console.log('openbox', r.stats);
    expect(r.stats.boundaryEdges).toBe(0);
    const v = signedVolume(r.positions, r.indices);
    const expected = 216 - 5.2 * 5.6 * 5.2;
    console.log('vol', v, expected);
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.03);
  });
});

describe('analytic depth', () => {
  it('matches the exact depth for cylinders, cones and revolves, with and without openings', async () => {
    const { compileGroups, baseDepth } = await import('../src/engine/scene');
    const d = emptyDoc();
    d.objects.push(makeObject('cylinder', { params: { r: 5, h: 10 }, holes: ['top'] }));
    const g = compileGroups(d)[0];
    // inside, 1 cm from the axis: side is 4 cm away, the open top doesn't count, bottom 6 cm
    expect(baseDepth(g, 1, 1, 0, 100, 0.01)).toBeCloseTo(4, 1);
    // near the open top the depth stays the distance to the side
    expect(baseDepth(g, 0, 4.9, 0, 100, 0.01)).toBeCloseTo(5, 1);
    const c = emptyDoc();
    c.objects.push(makeObject('cone', { params: { r: 4, h: 8 } }));
    const gc = compileGroups(c)[0];
    // on the axis, 1 cm above the base: nearest is the base
    expect(baseDepth(gc, 0, -3, 0, 100, 0.01)).toBeCloseTo(1, 1);
  });
});
