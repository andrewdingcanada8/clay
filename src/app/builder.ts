// Schedules kernel builds in a Web Worker. A newer request terminates a build that
// is still running, so dragging a slider never queues stale work. Falls back to the
// main thread if workers are unavailable (e.g. a sandbox that blocks blob: workers).

import type { Quality, SceneDoc } from '../engine/document';
import type { BuildResult } from '../engine/kernel';
import BuildWorker from '../worker?worker&inline';
import { manifoldWasmUrl } from '../browserSetup';

type Listener = (r: BuildResult, quality: Quality) => void;

export class Builder {
  private worker: Worker | null = null;
  private busy = false;
  private seq = 0;
  private useWorker = true;
  private timers: number[] = [];
  onResult: Listener = () => {};
  onError: (msg: string) => void = () => {};
  onBusy: (busy: boolean, quality: Quality) => void = () => {};

  private spawn(): Worker | null {
    if (!this.useWorker) return null;
    try {
      const w = new BuildWorker();
      w.onmessage = (e) => this.handle(e.data);
      w.onerror = (e) => {
        // Worker failed to start (CSP etc.): fall back to the main thread.
        console.warn('worker error, falling back to main thread', e.message, e.filename, e.lineno);
        this.useWorker = false;
        this.worker = null;
        if (this.pending) this.runMain(this.pending.doc, this.pending.quality, this.pending.id);
      };
      return w;
    } catch {
      this.useWorker = false;
      return null;
    }
  }

  private pending: { id: number; doc: SceneDoc; quality: Quality } | null = null;

  private handle(data: { id: number; result?: BuildResult; error?: string }) {
    if (!this.pending || data.id !== this.pending.id) return;
    const q = this.pending.quality;
    this.pending = null;
    this.busy = false;
    this.onBusy(false, q);
    if (data.error) this.onError(data.error);
    else if (data.result) this.onResult(data.result, q);
    if (q === 'draft') this.drainDraft();
  }

  private async runMain(doc: SceneDoc, quality: Quality, id: number) {
    const { buildMesh } = await import('../engine/build');
    try {
      const r = await buildMesh(doc, quality);
      this.handle({ id, result: r });
    } catch (err) {
      this.handle({ id, error: String(err) });
    }
  }

  build(doc: SceneDoc, quality: Quality) {
    const id = ++this.seq;
    if (this.busy && this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending = { id, doc, quality };
    this.busy = true;
    this.onBusy(true, quality);
    if (!this.worker) this.worker = this.spawn();
    if (this.worker) this.worker.postMessage({ id, doc, quality, wasmUrl: manifoldWasmUrl });
    else setTimeout(() => this.runMain(doc, quality, id), 0);
  }

  private draftDoc: SceneDoc | null = null;

  /** Throttled drafts while the user drags, then the requested quality once input settles. */
  schedule(doc: SceneDoc, quality: Quality, interactive: boolean) {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const fast = doc.kernel === 'mesh' || quality === 'draft';
    if (interactive && !fast) {
      if (this.busy && this.pending?.quality === 'draft') this.draftDoc = doc; // after current draft
      else this.build(doc, 'draft');
      this.timers.push(window.setTimeout(() => { this.draftDoc = null; this.build(doc, quality); }, 450));
    } else {
      this.draftDoc = null;
      this.timers.push(window.setTimeout(() => this.build(doc, quality), interactive ? 16 : 0));
    }
  }

  /** Called after a draft result lands: start the next queued draft, if any. */
  protected drainDraft() {
    if (this.draftDoc) {
      const d = this.draftDoc;
      this.draftDoc = null;
      this.build(d, 'draft');
    }
  }
}
