// Visual benchmark driver: builds the app, serves it, renders a contact sheet per
// case x kernel with headless Chromium, and writes bench/out + bench/REPORT.md.
//   node bench/run.mjs [--kernel sdf,mesh] [--case id1,id2] [--quality normal] [--no-build]
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const kernels = opt('kernel', 'sdf,mesh').split(',');
const caseTimeout = Number(opt('timeout', '300')) * 1000;
const quality = opt('quality', 'normal');
const only = opt('case', '');
const port = 4179;

if (!args.includes('--no-build')) execSync('npx vite build', { stdio: 'inherit' });
mkdirSync('bench/out', { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
await new Promise((res) => {
  server.stdout.on('data', (d) => { if (String(d).includes(String(port))) res(); });
  setTimeout(res, 8000);
});

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()); });

// discover case ids from the bundled examples via the bench page itself
await page.goto(`http://localhost:${port}/bench.html?case=__list`);
await page.waitForFunction(() => window.__cases);
const caseIds = only ? only.split(',') : await page.evaluate(() => window.__cases);

const resultsPath = 'bench/out/results.json';
const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};
for (const id of caseIds) {
  for (const kernel of kernels) {
    const url = `http://localhost:${port}/bench.html?case=${id}&kernel=${kernel}&quality=${quality}`;
    const t0 = Date.now();
    try {
      await page.goto(url, { timeout: 60000 });
      await page.waitForFunction(() => window.__bench || window.__benchError, null, { timeout: caseTimeout });
    } catch (e) {
      console.log(`${id} ${kernel}: timeout after ${caseTimeout / 1000}s`);
      results[`${id}|${kernel}`] = { id, kernel, error: `timeout (> ${caseTimeout / 1000} s)` };
      await page.close().catch(() => {});
      page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
      continue;
    }
    const err = await page.evaluate(() => window.__benchError);
    if (err) {
      console.log(`${id} ${kernel}: ERROR ${err.split('\n')[0]}`);
      results[`${id}|${kernel}`] = { id, kernel, error: err.split('\n')[0] };
      continue;
    }
    const r = await page.evaluate(() => window.__bench);
    await page.setViewportSize({ width: r.width, height: r.height });
    await page.locator('#sheet').screenshot({ path: `bench/out/${id}-${kernel}.png` });
    results[`${id}|${kernel}`] = r;
    const s = r.stats;
    console.log(`${id.padEnd(18)} ${kernel.padEnd(5)} ${String(Math.round(s.totalMs)).padStart(6)} ms  tris ${String(s.triangles).padStart(7)}  boundary ${s.boundaryEdges}  nonmanifold ${s.nonManifoldEdges}  wall-clock ${Date.now() - t0} ms${s.warnings.length ? '  ! ' + s.warnings.join(' | ') : ''}`);
  }
}
writeFileSync(resultsPath, JSON.stringify(results, null, 1));

// Report
const rows = [];
const allIds = [...new Set(Object.values(results).map((r) => r.id))];
rows.push('# Benchmark report', '', `Quality: ${quality}. Images: \`bench/out/<case>-<kernel>.png\`.`, '');
rows.push('| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |');
rows.push('|---|---|---:|---:|---:|---:|---:|---|');
for (const id of allIds) {
  for (const k of ['sdf', 'mesh', 'mesh-mk']) {
    const r = results[`${id}|${k}`];
    if (!r) continue;
    if (r.error) { rows.push(`| ${id} | ${k} | — | — | — | — | — | ERROR: ${r.error} |`); continue; }
    const s = r.stats;
    const maxWhite = Math.max(0, ...r.whiteFrac.flat()) * 100;
    rows.push(`| ${id} | ${k} | ${Math.round(s.totalMs)} | ${s.triangles} | ${s.boundaryEdges} | ${s.nonManifoldEdges} | ${maxWhite.toFixed(1)} | ${s.warnings.join('; ')} |`);
  }
}
writeFileSync('bench/REPORT.md', rows.join('\n') + '\n');
await browser.close();
server.kill();
process.exit(0);
