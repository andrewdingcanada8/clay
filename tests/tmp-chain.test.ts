import { it } from 'vitest';
import { examples } from '../src/examples';
import { compileGroups } from '../src/engine/scene';
import { buildCavityGrid } from '../src/engine/cavity';
import { buildSDF } from '../src/engine/sdfKernel';
it('chain timing', { timeout: 600000 }, () => {
  const ex = examples().find((e) => e.id === 'chain-30')!;
  let t = performance.now();
  const gs = compileGroups(ex.doc);
  const grids = gs.map((g) => buildCavityGrid(g, 'normal'));
  console.log('cavity', performance.now() - t, grids[0].dims, grids[0].h);
  t = performance.now();
  const r = buildSDF(ex.doc, 'normal', grids);
  console.log('mesher', performance.now() - t, r.stats.timings, r.stats.triangles);
});
