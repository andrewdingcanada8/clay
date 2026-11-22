// Session recorder (Diagnostics -> Record): a timeline of what the user did and what the
// view did, precise enough to replay in the test browser (scripts drive the same camera
// states and document changes at the same times):
//   - the document when recording starts (full), then each change: only the objects
//     that changed (or the whole document when anything else changed), with whether
//     it was mid-drag (interactive);
//   - the camera (position + target) on every frame it moved;
//   - per frame: the time since the last frame and the view's state (regime, bake);
//   - marks: "this is where it went wrong" (+ a note), with the camera at that moment.
// Saved to the artifact's database as it goes (collection recordings/<id>/chunks), so a
// session cut short by a GPU reset is still there.
import type { SceneDoc } from '../engine/document';

type Db = { collection(p: string): { doc(id: string): { set(d: unknown): Promise<unknown> } } };
type Cam = { pos: [number, number, number]; target: [number, number, number] };
export type RecEvent =
  | { t: number; k: 'cam'; pos: number[]; target: number[] }
  | { t: number; k: 'doc'; interactive: boolean; objects?: unknown[]; removed?: string[]; full?: SceneDoc }
  | { t: number; k: 'frame'; dt: number; state: string }
  | { t: number; k: 'mark'; note: string; cam: Cam; state: string }
  | { t: number; k: 'event'; ev: string; data?: unknown };

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const FLUSH_MS = 3000;

export class Recorder {
  readonly id = `r${Date.now().toString(36)}`;
  private t0 = performance.now();
  private events: RecEvent[] = [];
  private chunk = 0;
  private lastCam = '';
  private lastFrame = 0;
  private objs = new Map<string, string>();
  private rest = '';
  private lastInteractive = false;
  private timer = 0;
  private db: Db | null | undefined;
  marks = 0;
  stopped = false;

  constructor(private meta: Record<string, unknown>, doc: SceneDoc, cam: Cam) {
    this.remember(doc);
    this.meta = { ...meta, startedAt: Date.now(), doc0: doc, cam0: cam };
    void this.saveMeta({ ...this.meta, status: 'recording' });
    this.timer = window.setInterval(() => void this.flush(), FLUSH_MS);
  }

  private now() { return Math.round(performance.now() - this.t0); }
  private remember(doc: SceneDoc) {
    this.objs = new Map(doc.objects.map((o) => [o.id, JSON.stringify(o)]));
    this.rest = JSON.stringify({ ...doc, objects: [] });
  }

  /** Each frame of the view's loop: camera if it moved, frame time, state. */
  frame(now: number, cam: Cam, state: string) {
    if (this.stopped) return;
    const t = this.now();
    const key = cam.pos.map(r4).join(',') + '|' + cam.target.map(r4).join(',');
    if (key !== this.lastCam) { this.lastCam = key; this.events.push({ t, k: 'cam', pos: cam.pos.map(r4), target: cam.target.map(r4) }); }
    if (this.lastFrame) this.events.push({ t, k: 'frame', dt: Math.round(now - this.lastFrame), state });
    this.lastFrame = now;
  }

  /** The document as just set on the view (interactive: mid-drag). */
  doc(doc: SceneDoc, interactive: boolean) {
    if (this.stopped) return;
    const t = this.now();
    const rest = JSON.stringify({ ...doc, objects: [] });
    if (rest !== this.rest) { this.events.push({ t, k: 'doc', interactive, full: JSON.parse(JSON.stringify(doc)) }); this.remember(doc); return; }
    const changed: unknown[] = [], ids = new Set<string>();
    for (const o of doc.objects) {
      ids.add(o.id);
      const s = JSON.stringify(o);
      if (this.objs.get(o.id) !== s) { changed.push(JSON.parse(s)); this.objs.set(o.id, s); }
    }
    const removed = [...this.objs.keys()].filter((id) => !ids.has(id));
    for (const id of removed) this.objs.delete(id);
    // (a release re-sends the same document at rest: recorded too, so the replay leaves the drag)
    if (changed.length || removed.length || interactive !== this.lastInteractive) this.events.push({ t, k: 'doc', interactive, objects: changed, removed: removed.length ? removed : undefined });
    this.lastInteractive = interactive;
  }

  mark(note: string, cam: Cam, state: string) {
    this.marks++;
    this.events.push({ t: this.now(), k: 'mark', note, cam, state });
    void this.flush();
  }

  event(ev: string, data?: unknown) { if (!this.stopped) { this.events.push({ t: this.now(), k: 'event', ev, data }); if (ev === 'lost') void this.flush(); } }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.flush();
    await this.saveMeta({ ...this.meta, status: 'stopped', endedAt: Date.now(), durationMs: this.now(), chunks: this.chunk, marks: this.marks });
  }

  get elapsedMs() { return this.now(); }

  private async getDb() {
    if (this.db === undefined) {
      try {
        const claude = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
        this.db = claude?.use ? ((await claude.use('db')) as Db | null) : null;
      } catch { this.db = null; }
    }
    return this.db;
  }
  private async saveMeta(m: Record<string, unknown>) {
    try { await (await this.getDb())?.collection('recordings').doc(this.id).set(m); } catch { /* offline */ }
    try { localStorage.setItem(`clay.rec.${this.id}`, JSON.stringify(m).slice(0, 200000)); } catch { /* storage full */ }
  }
  private async flush() {
    if (!this.events.length) return;
    const ev = this.events; this.events = [];
    const n = this.chunk++;
    const db = await this.getDb();
    try { await db?.collection(`recordings/${this.id}/chunks`).doc(`c${String(n).padStart(4, '0')}`).set({ n, events: ev }); } catch { /* offline */ }
    // (no database, e.g. the test browser: the chunks stay in this browser)
    if (!db) try { const k = `clay.rec.${this.id}.events`; localStorage.setItem(k, JSON.stringify([...JSON.parse(localStorage.getItem(k) ?? '[]'), ...ev]).slice(0, 4_000_000)); } catch { /* storage full */ }
  }
}
