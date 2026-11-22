// Replays a session recorded on a device (Diagnostics -> Record session; src/app/recorder.ts)
// in the test browser: the recording's first document and camera, then every camera state
// and document change at its recorded time, through the app's own loop. A screenshot is
// taken at each mark, and the app's debug log (bakes, exact frames, GPU allocations) is
// written next to them, so what the view did at each moment can be compared with the
// device's log.
// Input: a JSON file { meta, events } — meta is the recordings/<id> document, events the
// chunks' events concatenated in order (fetch them from the artifact database).
// Usage: node bench/perf/replay.mjs <recording.json> [--dist dir] [--out dir] [--speed 1]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const recFile = args[0];
const dist = path.resolve(opt('--dist', path.join(root, 'dist-single')));
const out = path.resolve(opt('--out', path.join(root, 'bench/perf/results', `replay-${path.basename(recFile, '.json')}`)));
const speed = +opt('--speed', 1);
fs.mkdirSync(out, { recursive: true });
const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
const events = [...rec.events].sort((a, b) => a.t - b.t);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`file://${dist}/index.html`);
await page.waitForFunction(() => window.__clay?.openDoc, null, { timeout: 300000 });
await page.evaluate(({ doc, cam }) => { window.__clay.openDoc(doc); if (cam) window.__clay.view.setCameraState(cam); }, { doc: rec.meta.doc0, cam: rec.meta.cam0 });
await page.waitForTimeout(500);

// the document as the recording goes (object changes are applied to the last one)
let doc = JSON.parse(JSON.stringify(rec.meta.doc0));
const t0 = Date.now();
let marks = 0;
for (const e of events) {
  const due = t0 + e.t / speed;
  const wait = due - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  if (e.k === 'cam') await page.evaluate((c) => window.__clay.view.setCameraState(c), { pos: e.pos, target: e.target });
  else if (e.k === 'doc') {
    if (e.full) doc = e.full;
    else {
      const byId = new Map(doc.objects.map((o) => [o.id, o]));
      for (const o of e.objects ?? []) byId.set(o.id, o);
      for (const id of e.removed ?? []) byId.delete(id);
      // (keep the original order; new objects at the end)
      const order = doc.objects.map((o) => o.id).filter((id) => byId.has(id));
      for (const id of byId.keys()) if (!order.includes(id)) order.push(id);
      doc = { ...doc, objects: order.map((id) => byId.get(id)) };
    }
    await page.evaluate(({ d, i }) => window.__clay.applyDoc(d, i), { d: doc, i: e.interactive });
  } else if (e.k === 'mark') {
    marks++;
    const state = await page.evaluate(() => window.__clay.view.stateLabel());
    await page.screenshot({ path: path.join(out, `mark-${marks}.png`) });
    console.log(`mark ${marks} at ${(e.t / 1000).toFixed(1)} s: "${e.note}" (device: ${e.state}; replay: ${state})`);
  } else if (e.k === 'event') console.log(`event at ${(e.t / 1000).toFixed(1)} s: ${e.ev}`);
}
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(out, 'end.png') });
const log = await page.evaluate(() => JSON.parse(localStorage.getItem('clay.debugLog') || '{}').entries ?? []);
fs.writeFileSync(path.join(out, 'replay-log.json'), JSON.stringify({ errors, log }, null, 1));
const frames = events.filter((e) => e.k === 'frame');
console.log(`replayed ${events.length} events (${frames.length} device frames, ${marks} marks) in ${((Date.now() - t0) / 1000).toFixed(1)} s · ${errors.length} errors · ${out}`);
await browser.close();
