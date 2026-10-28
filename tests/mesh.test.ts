import { describe, it, expect } from 'vitest';
import { buildMeshKernel } from '../src/engine/meshKernel';
import { examples } from '../src/examples';
import { makeObject, emptyDoc } from '../src/engine/document';

describe('mesh kernel', () => {
  for (const ex of examples()) {
    it(ex.id, { timeout: 120000 }, async () => {
      const r = await buildMeshKernel({ ...ex.doc, kernel: 'mesh' }, 'normal');
      console.log(ex.id, r.stats.totalMs, r.stats.triangles, r.stats.boundaryEdges, r.stats.warnings.join('|'));
      expect(r.stats.triangles).toBeGreaterThan(0);
      expect(r.stats.boundaryEdges).toBe(0);
    });
  }
});

describe('mesh kernel openings', () => {
  it('two adjacent open faces leave no ridge between them', async () => {
    const box = makeObject('box', { params: { x: 6, y: 6, z: 6 }, mode: 'shell', holes: ['py', 'px'] });
    const d = { ...emptyDoc(), objects: [box], kernel: 'mesh' as const };
    d.groups = d.groups.map((g) => ({ ...g, thickness: 0.5 }));
    const r = await buildMeshKernel(d, 'normal');
    expect(r.stats.boundaryEdges).toBe(0);
    // the wall strip along the +x/+y edge (x, y in (2.5, 3], away from the z walls) must be gone
    const P = r.positions, I = r.indices;
    for (let k = 0; k < I.length; k += 3) {
      const c = [0, 1, 2].map((a) => (P[3 * I[k] + a] + P[3 * I[k + 1] + a] + P[3 * I[k + 2] + a]) / 3);
      expect(c[0] > 2.6 && c[1] > 2.6 && Math.abs(c[2]) < 2.4).toBe(false);
    }
  });
});

describe('mesh kernel cuts', () => {
  it('subtract keeps a wall; a cutout opens the hollow', async () => {
    for (const openCut of [false, true]) {
      const sphere = makeObject('sphere', { params: { r: 3 }, mode: 'shell' });
      const box = makeObject('box', { params: { x: 4, y: 8, z: 8 }, mode: 'subtract' });
      box.transform.position = [3, 0, 0];
      if (openCut) box.mode = 'cutout';
      const d = { ...emptyDoc(), objects: [sphere, box], kernel: 'mesh' as const };
      d.groups = d.groups.map((g) => ({ ...g, thickness: 0.4 }));
      const r = await buildMeshKernel(d, 'normal');
      expect(r.stats.boundaryEdges).toBe(0);
      // a closed cut: the cavity's face along the cut lies a wall in, at x = 0.6;
      // an open cut: the cavity runs out to the cut plane, x = 1
      const P = r.positions, I = r.indices;
      let inner = 0;
      for (let k = 0; k < I.length; k += 3) {
        const c = [0, 1, 2].map((a) => (P[3 * I[k] + a] + P[3 * I[k + 1] + a] + P[3 * I[k + 2] + a]) / 3);
        if (Math.abs(c[0] - 0.6) < 0.02 && Math.hypot(c[1], c[2]) < 2) inner++;
      }
      if (openCut) expect(inner).toBe(0);
      else expect(inner).toBeGreaterThan(0);
    }
  });
});
