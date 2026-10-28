// Editor frame-rate benchmark: opens each example in the built app (dist-single),
// waits for exact walls, then orbits the camera and times every frame, both at the
// settled (full) resolution and at the reduced resolution used while moving.
// Software GL (SwiftShader) here, so absolute numbers are far below a phone GPU;
// compare runs against each other.
// Usage: npm run build:single && node bench/fps.mjs [--frames 12] [--kernel sdf|mesh] [--dpr 1]
//   [--out bench/fps.json (compared against)] [--save file] [--dist dir (another build)] [id ...]
import { createRequire } from 'node:module';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const frames = +opt('--frames', 12), kernel = opt('--kernel', 'sdf'), out = opt('--out', 'bench/fps.json');
const dpr = +opt('--dpr', 1);
const save = opt('--save', out.replace('.json', '-latest.json'));
const dist = opt('--dist', null);
const page0 = dist ? `file://${dist}/index.html` : new URL('../dist-single/index.html', import.meta.url).href;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr });
await page.goto(page0, { waitUntil: 'commit', timeout: 120000 });
await page.waitForFunction(() => window.__clay, null, { timeout: 300000 });
const ids = args.length ? args : await page.evaluate(() => window.__clay.exampleIds());
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const results = {};
for (const id of ids) {
  await page.evaluate(async ([id, kernel]) => { await window.__clay.loadExample(id); window.__clay.setKernel(kernel); }, [id, kernel]);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('.chip')].map((c) => c.textContent).join(' ');
    return window.__clay && !window.__clay.busy() && !/refining|building/.test(t);
  }, null, { timeout: 300000 });
  const r = await page.evaluate((n) => ({
    cost: window.__clay.view.benchCost(4),
    still: window.__clay.view.benchOrbit(n, false),
    moving: window.__clay.view.benchOrbit(n, true),
  }), frames);
  results[id] = { map: +r.cost.map.toFixed(2), obj: +r.cost.obj.toFixed(1), still: +med(r.still).toFixed(1), stillMax: +Math.max(...r.still).toFixed(1), moving: +med(r.moving).toFixed(1), movingMax: +Math.max(...r.moving).toFixed(1) };
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8'))[id] : null;
  const vs = prev ? `   (was ${prev.map} / ${prev.obj} / ${prev.still} / ${prev.moving})` : '';
  console.log(`${id.padEnd(18)} map/px ${String(results[id].map).padStart(6)}  obj/px ${String(results[id].obj).padStart(7)}  still ${String(results[id].still).padStart(7)} ms  moving ${String(results[id].moving).padStart(7)} ms${vs}`);
}
await browser.close();
const total = (k) => Object.values(results).reduce((a, r) => a + r[k], 0).toFixed(0);
console.log(`totals: map/px ${total('map')}  obj/px ${total('obj')}  still ${total('still')} ms  moving ${total('moving')} ms`);
writeFileSync(save, JSON.stringify(results, null, 1));
