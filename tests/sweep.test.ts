import { describe, expect, it } from 'vitest';
import { defaultCoil, defaultSweep, emptyDoc, makeObject } from '../src/engine/document';
import { buildSweepPath, buildSweepSection, sectionRing, sweepMesh, sweepSDF } from '../src/engine/sweep';
import { compileObject } from '../src/engine/primitives';
import { buildSDF } from '../src/engine/sdfKernel';

const straight = { ...defaultSweep(), plane: 'xy' as const, path: [{ r: 0, y: -5 }, { r: 0, y: 5 }], section: 'circle' as const, w: 4 };

describe('sweep', () => {
  it('a straight round sweep is a capped cylinder', () => {
    const path = buildSweepPath(straight), sec = buildSweepSection(straight);
    expect(path.length).toBeCloseTo(10, 6);
    expect(sweepSDF(path, sec, 0, 0, 0)).toBeCloseTo(-2, 6);
    expect(sweepSDF(path, sec, 3, 0, 0)).toBeCloseTo(1, 6);
    expect(sweepSDF(path, sec, 0, 7, 0)).toBeCloseTo(2, 6); // past the end cap
    expect(sweepSDF(path, sec, 0, 4, 0)).toBeCloseTo(-1, 6); // nearest is the cap
  });

  it('a closed circular path with a round section is a torus', () => {
    const R = 6, r = 1.5;
    const p = { ...defaultSweep(), plane: 'xz' as const, closed: true, turns: 1, lift: [{ r: 0, y: 0 }, { r: 1, y: 0 }],
      path: Array.from({ length: 8 }, (_, i) => ({ r: R * Math.cos((i / 8) * 2 * Math.PI), y: R * Math.sin((i / 8) * 2 * Math.PI) })), section: 'circle' as const, w: 2 * r };
    const path = buildSweepPath(p), sec = buildSweepSection(p);
    expect(path.loop).toBe(true);
    for (const [x, y, z] of [[R, 0, 0], [0, 0.5, R], [-R - 1, 0, 0.3]]) {
      const torus = Math.hypot(Math.hypot(x, z) - R, y) - r;
      expect(Math.abs(sweepSDF(path, sec, x, y, z) - torus)).toBeLessThan(0.08); // spline circle vs true circle
    }
  });

  it('a coil rises and goes round several times; its mesh is closed', () => {
    const p = defaultCoil();
    const path = buildSweepPath(p);
    expect(path.loop).toBe(false); // the lift opens the loop
    expect(path.P[1]).toBeCloseTo(-7, 3);
    expect(path.P[3 * (path.n - 1) + 1]).toBeCloseTo(7, 3);
    expect(path.length).toBeGreaterThan(3 * 2 * Math.PI * 6.5);
    const m = sweepMesh(path, sectionRing(buildSweepSection(p), 16));
    const edges = new Map<string, number>();
    for (let i = 0; i < m.indices.length; i += 3) for (let k = 0; k < 3; k++) {
      const a = m.indices[i + k], b = m.indices[i + (k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    expect([...edges.values()].every((c) => c === 2)).toBe(true);
  });

  it('hollows in the SDF kernel with closed walls', () => {
    const d = emptyDoc();
    d.objects.push(makeObject('sweep', { params: { ...straight, w: 6 }, holes: ['end'] }));
    const r = buildSDF(d, 'draft');
    expect(r.stats.boundaryEdges).toBe(0);
    expect(r.indices.length).toBeGreaterThan(0);
    expect(compileObject(d.objects[0]).faces.map((f) => f.id)).toEqual(['surface', 'start', 'end']);
  });
});
