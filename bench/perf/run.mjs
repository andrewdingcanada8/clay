// SDF view performance harness (bench/perf/README.md). The frozen evaluator of the
// hill climb: experiments change the renderer, never this file (a change here is its
// own commit and re-baselines every series).
//
// For each scene: open it in the built app (dist-single, or --dist), wait until its
// builds settle, frame it the same way every time, then
//   time  — `--frames` frames round a fixed orbit through Viewport.benchFrame (exactly
//           what the view shows, drawn whole and waited on): the settled frame (the
//           headline) and the moving frame, at pixel ratio 1 on a 400×760 page
//   cost  — one frame in the shader's cost view: map() calls and object evaluations
//           per covered pixel (the two drivers of sphere tracing, kept apart)
//   still — the frame from the first orbit angle, on black, without helpers (PNG),
//           for the image check against the reference build (compare.py)
// Usage: node bench/perf/run.mjs [--dist dir] [--label name] [--frames 8] [--scenes a,b|--group headline]
//        [--out bench/perf/results] [--runs 1]
// Software GL (SwiftShader) here: compare runs with each other, not with a phone.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const dist = path.resolve(opt('--dist', path.join(root, 'dist-single')));
const label = opt('--label', 'run');
const frames = +opt('--frames', 8), runs = +opt('--runs', 1);
const outDir = path.resolve(opt('--out', path.join(root, 'bench/perf/results')));
const sceneDir = path.join(root, 'bench/perf/scenes');
const index = JSON.parse(fs.readFileSync(path.join(sceneDir, 'index.json'), 'utf8'));
const group = opt('--group', null);
const names = opt('--scenes', null)?.split(',') ?? index.filter((s) => !group || s.group === group).map((s) => s.name);
let git = '';
try { git = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() + (execSync('git status --porcelain src', { cwd: root }).toString().trim() ? '+dirty' : ''); } catch { /* not a checkout */ }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(outDir, `${stamp}-${label}`);
fs.mkdirSync(runDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 760 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
await page.goto(`file://${dist}/index.html`, { waitUntil: 'commit', timeout: 120000 });
await page.waitForFunction(() => window.__clay?.openDoc, null, { timeout: 300000 });

// CPU used outside this benchmark (its node process and the browser's processes) while
// a scene is timed: busy jiffies of the whole machine minus our own. Significant
// foreign load means the timings are contaminated (another build or agent ran).
const HZ = 100;
const ourPids = () => {
  // this process and its descendants (the browser it launched)
  const parent = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); parent.set(+d, +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); } catch { /* gone */ }
  }
  const mine = (pid) => { for (let p = pid, n = 0; p > 1 && n < 64; p = parent.get(p) ?? 0, n++) if (p === process.pid) return true; return false; };
  return [...parent.keys()].filter(mine);
};
const cpuSample = () => {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const busy = f[0] + f[1] + f[2] + f[5] + f[6] + f[7]; // user nice system irq softirq steal
  let ours = 0;
  for (const pid of ourPids()) {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const x = st.slice(st.lastIndexOf(')') + 2).split(' '); ours += +x[11] + +x[12]; } catch { /* gone */ }
  }
  return { busy, ours, t: Date.now() };
};
// foreign CPU in cores (1.0 = one core fully used by something else)
const foreignCores = (a, b) => Math.max(0, ((b.busy - a.busy) - (b.ours - a.ours)) / HZ / Math.max(0.001, (b.t - a.t) / 1000));
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const results = { label, git, stamp, dist, frames, runs, scenes: {} };

for (const name of names) {
  const sc = JSON.parse(fs.readFileSync(path.join(sceneDir, `${name}.json`), 'utf8'));
  const t0 = Date.now();
  await page.evaluate((d) => window.__clay.openDoc(d), sc.doc);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => !window.__clay.busy() && !/refining|building/i.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 900000, polling: 250 });
  const settleMs = Date.now() - t0;
  const cpu0 = cpuSample();
  const r = await page.evaluate(({ view, frames, runs }) => {
    const v = window.__clay.view;
    const V = v.camera.position.constructor;
    const box = v.bounds();
    const c = box.getCenter(new V()), R = box.getSize(new V()).length() / 2;
    const dir = new V(...(view?.dir ?? [-0.55, 0.45, 0.7])).normalize();
    const fov = v.camera.fov * Math.PI / 180, aspect = v.camera.aspect;
    const dist = (R / Math.sin(Math.min(fov, fov * aspect) / 2)) * (view?.zoom ?? 0.78);
    const helpers = [v.gizmo.getHelper(), v.ghost].filter((o) => o.visible);
    for (const o of helpers) o.visible = false;
    v.renderer.setPixelRatio(1); v.resize();
    const gl = v.renderer.getContext(), px = new Uint8Array(4);
    const place = (a) => {
      const off = dir.clone().multiplyScalar(dist);
      const x = off.x * Math.cos(a) - off.z * Math.sin(a), z = off.x * Math.sin(a) + off.z * Math.cos(a);
      v.orbit.target.copy(c); v.camera.position.set(c.x + x, c.y + off.y, c.z + z); v.camera.lookAt(c); v.camera.updateMatrixWorld();
    };
    // what the user sees: the settled (full) frame and the moving frame, each whole
    const draw = (moving) => v.benchFrame(moving);
    // per-edit work a build does once the field is at rest (a bake): its own series
    place(0);
    const tp = performance.now(); v.benchPrepare?.(); const prepareMs = performance.now() - tp;
    draw(false); draw(true); // warm-up (shader compile, uploads, targets)
    const ms = [], msMove = [];
    for (let run = 0; run < runs; run++) for (let i = 0; i < frames; i++) {
      place((2 * Math.PI * i) / frames);
      let t = performance.now(); draw(false); ms.push(performance.now() - t);
      t = performance.now(); draw(true); msMove.push(performance.now() - t);
    }
    // cost view at angle 0: R = map() calls (capped 255), G·256+B = object evaluations
    place(0);
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, buf = new Uint8Array(W * H * 4);
    const bg = v.scene.background, clear = v.renderer.getClearColor(new V()), clearA = v.renderer.getClearAlpha();
    const hide = [v.grid, v.hand.object].filter((o) => o.visible);
    for (const o of hide) o.visible = false;
    v.scene.background = null; v.renderer.setClearColor(0x000000, 1);
    v.sdf.setStyle({ cost: true });
    draw(false);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    v.sdf.setStyle({ cost: false });
    let n = 0, maps = 0, objs = 0, maxMaps = 0;
    for (let k = 0; k < buf.length; k += 4) {
      const m = buf[k], o = buf[k + 1] * 256 + buf[k + 2];
      if (!m && !o) continue;
      n++; maps += m; objs += o; maxMaps = Math.max(maxMaps, m);
    }
    // still: the settled frame on black, no helpers
    draw(false);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d'), img = cx.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    cx.putImageData(img, 0, 0);
    v.scene.background = bg; v.renderer.setClearColor(clear, clearA);
    for (const o of [...hide, ...helpers]) o.visible = true;
    return { ms, msMove, prepareMs, w: W, h: H, covered: n, mapsPerPx: n ? maps / n : 0, maxMaps, objsPerMap: maps ? objs / maps : 0, objsPerPx: n ? objs / n : 0, png: cv.toDataURL('image/png') };
  }, { view: sc.view, frames, runs });
  const foreign = +foreignCores(cpu0, cpuSample()).toFixed(2);
  fs.writeFileSync(path.join(runDir, `${name}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
  const mean = r.ms.reduce((a, b) => a + b, 0) / r.ms.length;
  const meanMove = r.msMove.reduce((a, b) => a + b, 0) / r.msMove.length;
  results.scenes[name] = {
    group: sc.group, msMean: +mean.toFixed(1), msP95: +pct(r.ms, 0.95).toFixed(1), msMax: +Math.max(...r.ms).toFixed(1), fps: +(1000 / mean).toFixed(3), prepareMs: +r.prepareMs.toFixed(0), msMove: +meanMove.toFixed(1), fpsMove: +(1000 / meanMove).toFixed(3),
    w: r.w, h: r.h, coveredPx: r.covered, mapsPerPx: +r.mapsPerPx.toFixed(2), maxMaps: r.maxMaps, objsPerMap: +r.objsPerMap.toFixed(2), objsPerPx: +r.objsPerPx.toFixed(1), settleMs,
    // machine-independent work of one settled frame (the cost view's counts): object
    // evaluations and field evaluations summed over the covered pixels
    workObjEvals: Math.round(r.objsPerPx * r.covered), workMaps: Math.round(r.mapsPerPx * r.covered), foreignCores: foreign, ms: r.ms.map((x) => +x.toFixed(1)),
  };
  console.log(`${name.padEnd(16)} ${mean.toFixed(0).padStart(6)} ms  moving ${meanMove.toFixed(0).padStart(5)} ms  p95 ${pct(r.ms, 0.95).toFixed(0).padStart(6)}  fps ${(1000 / mean).toFixed(3)}  maps/px ${r.mapsPerPx.toFixed(1)}  objs/map ${r.objsPerMap.toFixed(2)}  settle ${settleMs} ms  work ${(r.objsPerPx * r.covered / 1e6).toFixed(2)}M obj-evals${foreign > 0.25 ? `  CONTAMINATED (${foreign} foreign cores)` : ''}`);
}
const fpsList = Object.values(results.scenes).map((s) => s.fps);
results.geomeanFps = +Math.exp(fpsList.reduce((a, f) => a + Math.log(f), 0) / fpsList.length).toFixed(4);
results.headlineFps = results.scenes.composite?.fps ?? null;
results.headlineMovingFps = results.scenes.composite?.fpsMove ?? null;
results.maxForeignCores = Math.max(...Object.values(results.scenes).map((s) => s.foreignCores));
results.contaminated = results.maxForeignCores > 0.25;
results.errors = errors.slice(0, 10);
fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(results, null, 1));
if (results.contaminated) console.log(`WARNING: up to ${results.maxForeignCores} cores of foreign CPU during timing; rerun before trusting these numbers`);
console.log(`headline ${results.headlineFps} fps · geomean ${results.geomeanFps} · ${runDir}${errors.length ? ` · ${errors.length} errors: ${errors[0]}` : ''}`);
await browser.close();
