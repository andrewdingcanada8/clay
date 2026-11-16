/**
 * A running log of what the app (mostly the 3D view) did, for debugging on a phone:
 * the last few hundred events of this session, kept in this browser and written to
 * the artifact's database (collection `debugLog`, one document per session) where it
 * has one. Writes are batched; a GPU loss, an error or the page going away writes at
 * once, so the events right before a crash survive it.
 */
type Db = { collection(p: string): { doc(id: string): { set(d: unknown): Promise<unknown> } } };

const MAX = 300;
const t0 = Date.now();
const session = `s${t0.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const entries: Record<string, unknown>[] = [];
const head: Record<string, unknown> = { startedAt: t0, ua: navigator.userAgent, dpr: window.devicePixelRatio };
let db: Db | null | undefined;
let timer = 0, dirty = false;

const round = (v: unknown): unknown => (typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(2) : v);

/** Add an event (kept short: numbers rounded, strings cut to 400 characters). */
export function dlog(ev: string, data: Record<string, unknown> = {}, urgent = false): void {
  const e: Record<string, unknown> = { t: Date.now() - t0, ev };
  for (const [k, v] of Object.entries(data)) e[k] = typeof v === 'string' ? v.slice(0, 400) : Array.isArray(v) ? v.map(round) : round(v);
  entries.push(e);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  dirty = true;
  if (urgent) void flush();
  else if (!timer) timer = window.setTimeout(() => void flush(), 4000);
}

/** Facts about the session that go at the top of its document (GPU, piece, ...). */
export function dlogInfo(info: Record<string, unknown>): void {
  Object.assign(head, info);
  dirty = true;
}

async function flush(): Promise<void> {
  clearTimeout(timer); timer = 0;
  if (!dirty) return;
  dirty = false;
  const body = { ...head, session, updatedAt: Date.now(), entries: entries.slice() };
  try { localStorage.setItem('clay.debugLog', JSON.stringify(body)); } catch { /* storage unavailable */ }
  try {
    if (db === undefined) {
      const claude = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
      db = claude?.use ? ((await claude.use('db')) as Db | null) : null;
    }
    await db?.collection('debugLog').doc(session).set(body);
  } catch { db = db ?? null; }
}

// errors anywhere, and console errors and warnings (three.js reports shader trouble there)
window.addEventListener('error', (e) => dlog('error', { msg: e.message, at: `${e.filename?.split('/').pop()}:${e.lineno}` }, true));
window.addEventListener('unhandledrejection', (e) => dlog('rejection', { msg: String((e.reason as Error)?.message ?? e.reason) }, true));
for (const level of ['error', 'warn'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { dlog(`console.${level}`, { msg: args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ') }); } catch { /* unloggable */ }
    orig(...args);
  };
}
document.addEventListener('visibilitychange', () => dlog('visibility', { state: document.visibilityState }, document.visibilityState === 'hidden'));
window.addEventListener('pagehide', () => { dlog('pagehide'); void flush(); });
dlog('start', { session });
