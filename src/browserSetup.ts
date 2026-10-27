// Browser-only: tell the mesh kernel where Vite put the Manifold .wasm (inlined as
// a data: URL in the single-file build).
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { setManifoldWasmUrl } from './engine/meshKernel';

export const manifoldWasmUrl = new URL(wasmUrl, document.baseURI).href;
setManifoldWasmUrl(manifoldWasmUrl);
