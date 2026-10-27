// Build worker: runs either kernel off the main thread. The page passes the
// absolute .wasm URL because an inline (blob:) worker cannot resolve relative ones.
import { buildMesh } from './engine/build';
import type { Quality, SceneDoc } from './engine/document';
import { setManifoldWasmUrl } from './engine/meshKernel';

self.onmessage = async (e: MessageEvent<{ id: number; doc: SceneDoc; quality: Quality; wasmUrl: string }>) => {
  const { id, doc, quality, wasmUrl } = e.data;
  setManifoldWasmUrl(wasmUrl);
  try {
    const r = await buildMesh(doc, quality);
    (self as unknown as Worker).postMessage({ id, result: r }, [r.positions.buffer, r.indices.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.stack ?? err) });
  }
};
