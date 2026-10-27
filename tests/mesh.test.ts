import { describe, it, expect } from 'vitest';
import { buildMeshKernel } from '../src/engine/meshKernel';
import { examples } from '../src/examples';

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
