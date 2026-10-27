import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  if (mode === 'single') {
    // One self-contained HTML (worker + wasm inlined) for publishing as an Artifact.
    return {
      plugins: [viteSingleFile()],
      build: { outDir: 'dist-single', assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 100_000 },
      worker: { format: 'es' },
    };
  }
  return {
    build: {
      rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), bench: resolve(import.meta.dirname, 'bench.html') } },
      chunkSizeWarningLimit: 100_000,
    },
    worker: { format: 'es' },
  };
});
