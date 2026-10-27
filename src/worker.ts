// Build worker: meshes (mesh kernel) or cavity-depth grids (SDF kernel), off the
// main thread. The page passes the absolute .wasm URL because an inline (blob:)
// worker cannot resolve relative ones.
import { buildCavityGrid } from './engine/cavity';
import { buildMesh } from './engine/build';
import type { Quality, SceneDoc } from './engine/document';
import { setManifoldWasmUrl } from './engine/meshKernel';
import { compileGroups } from './engine/scene';

interface Req { id: number; kind: 'mesh' | 'cavity'; doc: SceneDoc; quality: Quality; wasmUrl: string; groups?: number[] }

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, kind, doc, quality, wasmUrl } = e.data;
  setManifoldWasmUrl(wasmUrl);
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    if (kind === 'cavity') {
      const t0 = performance.now();
      const groups = compileGroups(doc);
      const want = new Set(e.data.groups ?? groups.map((g) => g.index));
      const grids = groups.filter((g) => g.hollow && want.has(g.index)).map((g) => buildCavityGrid(g, quality));
      post({ id, kind, grids, ms: performance.now() - t0 }, grids.map((g) => g.data.buffer));
    } else {
      const r = await buildMesh(doc, quality);
      post({ id, kind, result: r }, [r.positions.buffer, r.indices.buffer]);
    }
  } catch (err) {
    post({ id, kind, error: String((err as Error)?.stack ?? err) });
  }
};
