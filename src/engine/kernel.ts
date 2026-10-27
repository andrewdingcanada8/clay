// Common kernel interface. Both kernels take the same document and return an
// indexed triangle mesh plus diagnostics.

import type { Quality, SceneDoc } from './document';

export interface BuildStats {
  kernel: string;
  triangles: number;
  vertices: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  /** SDF kernel: grid cell size (cm). */
  cellSize?: number;
  activeCells?: number;
  warnings: string[];
  timings: Record<string, number>;
  totalMs: number;
}

export interface BuildResult {
  positions: Float32Array;
  indices: Uint32Array;
  stats: BuildStats;
}

export interface BuildRequest {
  doc: SceneDoc;
  quality: Quality;
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class Timer {
  timings: Record<string, number> = {};
  private t0 = now();
  private last = this.t0;
  lap(name: string): void {
    const t = now();
    this.timings[name] = Math.round((t - this.last) * 10) / 10;
    this.last = t;
  }
  total(): number {
    return Math.round((now() - this.t0) * 10) / 10;
  }
}
