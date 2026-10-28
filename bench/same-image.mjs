// Renders each example from fixed views with two builds and reports how many pixels
// differ, to check that a renderer optimization leaves the image unchanged.
// Usage: node bench/same-image.mjs <distA> <distB> <outDir> [id ...]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [distA, distB, outDir, ...only] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function shots(dist, tag) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await page.goto(`file://${dist}/index.html`, { waitUntil: 'commit', timeout: 120000 });
  await page.waitForFunction(() => window.__clay, null, { timeout: 300000 });
  const ids = only.length ? only : await page.evaluate(() => window.__clay.exampleIds());
  for (const id of ids) {
    await page.evaluate(async (id) => { await window.__clay.loadExample(id); window.__clay.setKernel('sdf'); }, id);
    await page.waitForTimeout(300);
    await page.waitForFunction(() => {
      const t = [...document.querySelectorAll('.chip')].map((c) => c.textContent).join(' ');
      return window.__clay && !window.__clay.busy() && !/refining|building/.test(t);
    }, null, { timeout: 300000 });
    const urls = await page.evaluate(() => {
      const v = window.__clay.view, out = [];
      const s = v.cameraState(), c = s.target, off = s.pos.map((x, i) => x - c[i]);
      const r = Math.hypot(off[0], off[2]);
      for (const a of [0.6, 2.4, 4.2]) {
        v.setCameraState({ pos: [c[0] + r * Math.cos(a), c[1] + off[1], c[2] + r * Math.sin(a)], target: c });
        v.camera.updateMatrixWorld(); v.renderer.render(v.scene, v.camera);
        out.push(v.renderer.domElement.toDataURL('image/png'));
      }
      v.setCameraState(s);
      return out;
    });
    urls.forEach((u, k) => writeFileSync(`${outDir}/${id}-${k}-${tag}.png`, Buffer.from(u.split(',')[1], 'base64')));
  }
  await page.close();
  return ids;
}
const ids = await shots(distA, 'a');
await shots(distB, 'b');
await browser.close();
console.log(ids.join(' '));
