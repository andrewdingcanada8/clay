import { describe, expect, it } from 'vitest';
import { defaultCoil, defaultSweep, emptyDoc, makeObject } from '../src/engine/document';
import { type SweepStyle, buildSweepPath, buildSweepSection, sectionRing, sweepEval, sweepMesh } from '../src/engine/sweep';
import type { PrimitiveParams } from '../src/engine/document';

const flatRound: SweepStyle = { join: 'round', cap: 'flat' };
const sweepSDF = (path: ReturnType<typeof buildSweepPath>, sec: ReturnType<typeof buildSweepSection>, x: number, y: number, z: number, style = flatRound) => sweepEval(path, sec, style, x, y, z).d;
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

  // an L: from (0,-5) up to a sharp corner at (0,0), then right to (5,0); round section r = 1
  const L = (style: Partial<PrimitiveParams> = {}): PrimitiveParams => ({ ...straight, w: 2, path: [{ r: 0, y: -5, corner: true }, { r: 0, y: 0, corner: true }, { r: 5, y: 0, corner: true }], ...style });
  const at = (p: PrimitiveParams, x: number, y: number, z = 0) => {
    const path = buildSweepPath(p), sec = buildSweepSection(p);
    return sweepEval(path, sec, { join: p.join ?? 'round', cap: p.cap ?? 'flat' }, x, y, z).d;
  };

  it('a sharp corner does not run on past the bend', () => {
    // straight on past the corner (up) and back past it (left): outside the tube
    expect(at(L(), 0, 3)).toBeCloseTo(2, 3);
    expect(at(L(), -3, 0)).toBeCloseTo(2, 3);
    expect(at(L(), 0.5, -2)).toBeCloseTo(-0.5, 3); // inside the first leg
  });

  it('round corners are a quarter torus; miters are sharp', () => {
    const d = 1.5 / Math.SQRT2; // 1.5 out from the corner, diagonally up-left
    expect(at(L(), -d, d)).toBeCloseTo(0.5, 3);
    expect(at(L({ join: 'miter' }), -0.9, 0.9)).toBeLessThan(0); // inside the miter's square corner
    expect(at(L({ join: 'round' }), -0.9, 0.9)).toBeGreaterThan(0);
  });

  it('round caps are the section spun; square caps run on by half the width', () => {
    expect(at(L({ cap: 'round' }), 0, -6.5)).toBeCloseTo(0.5, 3); // hemisphere of radius 1 past (0,-5)
    expect(at(L({ cap: 'round' }), 0.6, -5.6)).toBeLessThan(0);
    expect(at(L({ cap: 'flat' }), 0, -5.5)).toBeCloseTo(0.5, 3);
    expect(at(L({ cap: 'square' }), 0, -5.5)).toBeCloseTo(-0.5, 3);
    expect(at(L({ cap: 'square' }), 0, -6.5)).toBeCloseTo(0.5, 3);
  });
});
