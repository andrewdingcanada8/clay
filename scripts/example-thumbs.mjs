// Renders the gallery previews for the built-in examples into src/assets/example-thumbs/.
// Usage: npx vite --port 5199 & THUMB_DIR=/tmp/thumbs node scripts/example-thumbs.mjs [id ...]
// (write outside src/ while the dev server runs, or each file triggers a reload), then copy in.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { writeFileSync, mkdirSync } from 'node:fs';

const url = process.env.CLAY_URL ?? 'http://localhost:5199/';
const outDir = new URL(process.env.THUMB_DIR ? `file://${process.env.THUMB_DIR}/` : '../src/assets/example-thumbs/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
await page.waitForFunction(() => window.__clay, null, { timeout: 300000 });
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : await page.evaluate(async () => (await import('/src/examples.ts')).examples().map((e) => e.id));
for (const id of ids) {
  await page.evaluate((id) => window.__clay.loadExample(id), id);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('.chip')].map((c) => c.textContent).join(' ');
    return !window.__clay.busy() && !/refining|building/.test(t);
  }, null, { timeout: 180000 });
  const data = await page.evaluate(() => {
    const v = window.__clay.view;
    // three-quarter view, facing the piece's long horizontal side
    const b = v.bounds(), sx = b ? b.max.x - b.min.x : 1, sz = b ? b.max.z - b.min.z : 1;
    v.setCameraState({ pos: sx >= sz ? [40, 30, 52] : [52, 30, 40], target: [0, 0, 0] });
    return v.snapshot(360, 480);
  });
  writeFileSync(new URL(`${id}.jpg`, outDir), Buffer.from(data.split(',')[1], 'base64'));
  console.log('ok', id);
}
await browser.close();
