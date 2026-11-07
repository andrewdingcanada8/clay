import { describe, it, expect } from 'vitest';
import { graphSampler } from '../src/engine/sweep';

describe('sweep lift graph', () => {
  it('follows the curve as drawn (x in cm along the path, not 0..1)', () => {
    // a steep start, a smooth bend, then a long gentle climb (a coil tight at the top)
    const pts = [{ corner: true, r: 0, y: 0.2 }, { r: 0.18, y: 19.6 }, { corner: true, r: 1, y: 30.4 }];
    const lift = graphSampler(pts, 219);
    // near the start it climbs along the line to the bend, not straight up
    expect(lift(0.04)).toBeLessThan(8);
    expect(lift(0.04)).toBeGreaterThan(2);
    expect(lift(0.18)).toBeCloseTo(19.6, 0);
    // never dips or overshoots
    let prev = -Infinity;
    for (let u = 0; u <= 1; u += 0.01) { const v = lift(u); expect(v).toBeGreaterThanOrEqual(prev - 1e-9); prev = v; }
    expect(lift(1)).toBeCloseTo(30.4, 6);
  });
});
