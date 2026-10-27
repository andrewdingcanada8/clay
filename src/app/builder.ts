// Runs heavy work in a Web Worker: meshes for the mesh kernel, cavity-depth grids
// for the SDF kernel. The newest request of a kind replaces any older one still
// running (the worker is restarted), so dragging never queues stale work. Falls
// back to the main thread if workers are unavailable.

import { manifoldWasmUrl } from '../browserSetup';
import type { CavityGrid } from '../engine/cavity';
import type { Quality, SceneDoc } from '../engine/document';
import type { BuildResult } from '../engine/kernel';
import BuildWorker from '../worker?worker&inline';

type Kind = 'mesh' | 'cavity';
interface Job { id: number; kind: Kind; doc: SceneDoc; quality: Quality; groups?: number[]; tag?: unknown }

export class Builder {
  private worker: Worker | null = null;
  private useWorker = true;
  private seq = 0;
  private running: Job | null = null;
  private queued: Job | null = null;
  private timer = 0;
  onMesh: (r: BuildResult, quality: Quality) => void = () => {};
  onGrids: (grids: CavityGrid[], tag: unknown, ms: number) => void = () => {};
  onError: (msg: string) => void = () => {};
  onBusy: (busy: boolean) => void = () => {};

  private spawn(): Worker | null {
    if (!this.useWorker) return null;
    try {
      const w = new BuildWorker();
      w.onmessage = (e) => this.handle(e.data);
      w.onerror = (e) => {
        console.warn('worker error, falling back to main thread', e.message);
        this.useWorker = false;
        this.worker = null;
        const job = this.running;
        this.running = null;
        if (job) this.start(job);
      };
      return w;
    } catch {
      this.useWorker = false;
      return null;
    }
  }

  private handle(data: { id: number; kind: Kind; result?: BuildResult; grids?: CavityGrid[]; ms?: number; error?: string }) {
    const job = this.running;
    if (!job || data.id !== job.id) return;
    this.running = null;
    if (data.error) this.onError(data.error);
    else if (data.kind === 'mesh' && data.result) this.onMesh(data.result, job.quality);
    else if (data.kind === 'cavity' && data.grids) this.onGrids(data.grids, job.tag, data.ms ?? 0);
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      this.start(q);
    } else this.onBusy(false);
  }

  private async runMain(job: Job) {
    try {
      if (job.kind === 'mesh') {
        const { buildMesh } = await import('../engine/build');
        this.handle({ id: job.id, kind: 'mesh', result: await buildMesh(job.doc, job.quality) });
      } else {
        const { compileGroups } = await import('../engine/scene');
        const { buildCavityGrid } = await import('../engine/cavity');
        const t0 = performance.now();
        const want = new Set(job.groups ?? []);
        const grids = compileGroups(job.doc).filter((g) => g.hollow && (!job.groups || want.has(g.index))).map((g) => buildCavityGrid(g, job.quality));
        this.handle({ id: job.id, kind: 'cavity', grids, ms: performance.now() - t0 });
      }
    } catch (err) {
      this.handle({ id: job.id, kind: job.kind, error: String(err) });
    }
  }

  private start(job: Job) {
    if (this.running && this.worker) {
      // a newer job supersedes the running one
      this.worker.terminate();
      this.worker = null;
    }
    this.running = job;
    this.onBusy(true);
    if (!this.worker) this.worker = this.spawn();
    if (this.worker) this.worker.postMessage({ id: job.id, kind: job.kind, doc: job.doc, quality: job.quality, groups: job.groups, wasmUrl: manifoldWasmUrl });
    else setTimeout(() => this.runMain(job), 0);
  }

  /**
   * Request work. `delay` debounces rapid edits; a job already running is allowed
   * to finish when `wait` is set (its result is still useful), otherwise replaced.
   */
  request(kind: Kind, doc: SceneDoc, quality: Quality, opts: { delay?: number; groups?: number[]; tag?: unknown; wait?: boolean } = {}) {
    clearTimeout(this.timer);
    const job: Job = { id: ++this.seq, kind, doc, quality, groups: opts.groups, tag: opts.tag };
    const go = () => {
      if (this.running && opts.wait) this.queued = job;
      else this.start(job);
    };
    if (opts.delay) this.timer = window.setTimeout(go, opts.delay);
    else go();
  }

  cancel() {
    clearTimeout(this.timer);
    this.queued = null;
  }
}
