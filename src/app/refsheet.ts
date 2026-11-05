// The reference sheet: the piece from the angle on screen (shaded, and its depth,
// normal, edge and silhouette maps) and from fixed views, composed into one image to
// hand an image model along with a prompt. Rendered by Viewport.captureViews.

import * as THREE from 'three';
import type { CaptureSpec, Viewport } from './viewport';

/** A glaze to ask for: its name, a swatch (CSS background) and how to describe it. */
export interface Glaze { id: string; name: string; swatch: string; prompt: string; /** prompt still being workshopped; no reference photo yet */ wip?: boolean }
/** A setting to photograph the piece in. */
export interface Backdrop { id: string; name: string; swatch: string; prompt: string }

// Glazes read from reference photos of finished pottery (glossy drips and speckles,
// satin ash and iron, matte copper), each worded for an image model.
export const GLAZES: Glaze[] = [
  { id: 'blue-drip', name: 'Watercolor blue drip', swatch: 'linear-gradient(180deg,#eef2f6 0 42%,#7d97c4 52%,#2f4fa6 64%,#d8c2a2 74%,#f4f2ee 82%)',
    prompt: 'glossy cool white over the upper half and the handle; across the lower-middle body an irregular, mountain-like band about a quarter of the height, grey-blue at its top deepening to saturated cobalt, its lower edge bleeding downward in fine feathered vertical streaks; beneath it uneven patches of creamy beige edged by a thin wavy tan line, then a glossy white base and foot' },
  { id: 'speckled-blue', name: 'Speckled midnight blue', swatch: 'radial-gradient(circle at 30% 30%,#5c86b0 0 6%,transparent 7%),radial-gradient(circle at 70% 60%,#0d1a2b 0 7%,transparent 8%),linear-gradient(160deg,#2f5f8f,#1b3556)',
    prompt: 'high-gloss teal-blue glaze over the whole body, densely mottled with irregular black flecks covering about half the surface and paler sky-blue spots between them, evenly spread from shoulder to foot; the narrow neck darkens to near-black at the rim' },
  { id: 'celadon', name: 'Celadon green', swatch: 'linear-gradient(160deg,#bfd8c3,#8fb59b 60%,#6f9a80)',
    prompt: 'smooth high-gloss sage-green glaze over the whole body, slightly deeper and more saturated on the neck and upper shoulder, a faint cloudy paler band just below the shoulder, then an even soft green to the foot; semi-opaque with soft mottling' },
  { id: 'turquoise-teal', name: 'Turquoise over teal', swatch: 'linear-gradient(180deg,#5f8f86 0 30%,#3f9c9a 55%,#2fb3c4 80%,#46c0d0)',
    prompt: 'glossy banded glaze: teal-green on the neck and upper shoulder, then a cloudy band of pale frosty green-white with wispy streaks running down across the upper body, a deep sea-green middle third, and bright saturated turquoise over the lowest quarter, the bands meeting in soft, slightly wavy horizontal transitions' },
  { id: 'blue-ochre', name: 'Blue-grey over ochre', swatch: 'linear-gradient(180deg,#9fb2c4 0 40%,#7e98ad 55%,#c8a24a 70%,#b8902f)',
    prompt: 'glossy pale misty blue-grey from the neck to about two thirds of the way down, crossed by a thin streaky olive-ochre band on the upper body, olive at the rim; the lowest third is saturated mustard ochre, the blue running down into it in a soft, feathered, slightly drippy transition' },
  { id: 'oil-spot', name: 'Black oil-spot', swatch: 'radial-gradient(circle at 25% 35%,#6f8fb0 0 5%,transparent 6%),radial-gradient(circle at 65% 70%,#8fa6bf 0 4%,transparent 5%),linear-gradient(160deg,#1c2533,#0b0f15)',
    prompt: 'high-gloss black glaze with a dense field of small teal-blue and turquoise specks over the shoulder and upper two thirds, thinning out in an irregular, drippy lower edge above a solid glossy black lowest fifth, with a few deeper blue pools where it runs; the neck mostly black with fine specks' },
  { id: 'rust-shino', name: 'Rust shino', swatch: 'linear-gradient(180deg,#9a5a34 0 30%,#b07a52 50%,#cfc7bd 75%,#e2ddd5)',
    prompt: 'satin-matte rust-orange to caramel brown over the upper half with fine vertical streaking, darkest at the neck and shoulder, fading downward in an irregular diagonal, feathered edge into pale grey-white over the lower half, flecked with scattered rust speckles and a few orange patches' },
  { id: 'ash-grey', name: 'Pale ash grey', swatch: 'linear-gradient(160deg,#dcdcd6,#c4c6c0 60%,#b3b4ae)',
    prompt: 'satin-matte pale grey-white glaze with a faint cool blue-grey cast and fine dry speckled texture, even from shoulder to foot with only soft mottling; the lip breaks to a thin warm brown at its edge' },
  { id: 'iron-brown', name: 'Toasted iron brown', swatch: 'radial-gradient(circle at 40% 40%,#6d4a32 0 4%,transparent 5%),linear-gradient(180deg,#8f6a52,#a5785a 60%,#8c5f44)',
    prompt: 'satin-matte warm brown glaze with dense fine dark speckles and subtle vertical streaks, a muted grey-mauve brown on the shoulder and upper half warming gradually to caramel orange-brown toward the foot; the small lip a paler grey-brown' },
  { id: 'plum-tenmoku', name: 'Plum tenmoku', swatch: 'linear-gradient(180deg,#4a2a26 0 25%,#6b3d2e 55%,#8a5a3e)',
    prompt: 'satin glaze: the flat shoulder and neck a pale speckled grey-brown, then a dark plum-aubergine band just below the shoulder edge fading downward through reddish brown to lighter caramel brown with fine vertical streaks and faint grey-green wisps over the lower half' },
  { id: 'mint-ash', name: 'Mint-lavender ash', swatch: 'linear-gradient(90deg,#c9cbc4,#b9c9bd 35%,#c5bccb 65%,#cfcfc8)',
    prompt: 'satin-matte pale grey glaze over the whole body with soft vertical streaks of mint green and muted lavender, the lavender stronger on the upper half and the mint lower down; a thin rust-brown line at the shoulder edge and a brown lip, fine speckled texture throughout' },
  { id: 'copper-green', name: 'Copper verdigris', swatch: 'radial-gradient(circle at 35% 30%,#7a6b45 0 10%,transparent 18%),linear-gradient(180deg,#6e7a52 0 25%,#3f8a6c 55%,#2f7a62)',
    prompt: 'matte, finely speckled copper-green glaze; on the upper cone it is broken by large cloudy patches of dark bronze-brown covering about half of it, heaviest toward the rim, with green showing through at uneven mottled edges; a thin dark brown line along the sharp widest edge; the lower cone an even speckled verdigris green' },
  // common glazes, prompts being workshopped (no reference photos yet)
  { id: 'gloss-white', name: 'Glossy white', swatch: 'linear-gradient(160deg,#ffffff,#e9e9e7)',
    prompt: 'high-gloss opaque bright white glaze covering the whole body evenly, smooth and glassy with crisp reflections, thinning to a faint warm cream at the rim and edges and pooling slightly brighter in recesses' },
  { id: 'matte-white', name: 'Matte white', swatch: 'linear-gradient(160deg,#efebe4,#ddd7cd)',
    prompt: 'dry matte warm white glaze covering the whole body evenly, soft and chalky with no reflections, a very fine eggshell texture, thinning to a pale buff at the rim and sharp edges' },
  { id: 'gloss-black', name: 'Glossy black', swatch: 'repeating-conic-gradient(#ff00ff 0 25%,#000 0 50%) 0 0/14px 14px', wip: true,
    prompt: 'high-gloss deep jet-black glaze covering the whole body evenly, smooth and mirror-like with sharp white reflections, thinning to a dark brown at the rim and edges' },
  { id: 'matte-black', name: 'Matte black', swatch: 'repeating-conic-gradient(#ff00ff 0 25%,#000 0 50%) 0 0/14px 14px', wip: true,
    prompt: 'satin-matte soft charcoal-black glaze covering the whole body evenly, velvety with only faint diffuse sheen, a fine smooth texture, slightly greyer where it thins at the rim and edges' },
  { id: 'stone-grey', name: 'Satin stone grey', swatch: 'repeating-conic-gradient(#ff00ff 0 25%,#000 0 50%) 0 0/14px 14px', wip: true,
    prompt: 'satin mid-grey glaze with a faint cool cast covering the whole body, softly mottled with slightly darker and lighter grey patches and fine dark specks, thinning to a pale grey at the rim and edges' },
  { id: 'clear-stoneware', name: 'Clear over speckled clay', swatch: 'repeating-conic-gradient(#ff00ff 0 25%,#000 0 50%) 0 0/14px 14px', wip: true,
    prompt: 'glossy clear glaze over a warm buff stoneware body covering the whole piece, the clay\'s fine dark iron speckles showing through evenly, light and slightly honey-toned where the glaze is thin at the rim and edges, deeper amber where it pools in recesses' },
  { id: 'apple-celadon', name: 'Apple green celadon', swatch: 'linear-gradient(160deg,#a9bf8f,#8eaa72 60%,#7f9c66)',
    prompt: 'glossy semi-translucent soft apple-green celadon covering every part of the piece evenly; a slightly paler, milky band with soft feathered mottling across the upper body, settling into a smooth, slightly deeper sage green over the lower body toward the foot, no crackle, a touch lighter and yellower where it thins at the rim and edges' },
  { id: 'chun-blue', name: 'Chun blue', swatch: 'linear-gradient(160deg,#a9d3d0,#86bcbb 60%,#76aeae)',
    prompt: 'glossy translucent pale blue-teal Chun glaze covering the whole body evenly, soft and slightly milky with a subtle cloudy depth and fine natural mottling, a balanced cool cyan-blue with a gentle hint of green, no purple or red splashes, no streaks or strong color transitions, thinning to a faint warm beige at the rim and edges with subtle variations in transparency' },
  { id: 'tea-dust', name: 'Tea dust', swatch: 'repeating-conic-gradient(#ff00ff 0 25%,#000 0 50%) 0 0/14px 14px', wip: true,
    prompt: 'matte olive-brown glaze covering the whole body, densely covered with fine yellow-green specks like dust, evenly spread from rim to foot, slightly darker brown where it thins at the rim and edges' },
  { id: 'tenmoku', name: 'Tenmoku', swatch: 'repeating-conic-gradient(#ff00ff 0 25%,#000 0 50%) 0 0/14px 14px', wip: true,
    prompt: 'glossy deep black-brown glaze over most of the body, breaking to rust-brown on the rim, edges and raised areas where it thins, with the darkest black where it pools in recesses and toward the foot' },
  { id: 'unglazed', name: 'Unglazed stoneware', swatch: 'radial-gradient(circle at 60% 40%,#8a7560 0 3%,transparent 4%),linear-gradient(160deg,#cbb59b,#b59c80)',
    prompt: 'unglazed bisque-fired stoneware, dry warm-buff clay body with fine iron speckles and visible throwing texture' },
];

export const BACKDROPS: Backdrop[] = [
  { id: 'white-sweep', name: 'White sweep', swatch: 'linear-gradient(180deg,#ffffff,#eceae6)',
    prompt: 'on a seamless pure white studio backdrop with a soft gradient, soft diffuse lighting and a gentle contact shadow' },
  { id: 'black-mirror', name: 'Black mirror', swatch: 'linear-gradient(180deg,#f4f4f4 0 58%,#c9c9c9 60%,#111 62%,#2a2a2a)',
    prompt: 'against a light grey to white gradient backdrop, standing on a glossy black mirror surface with a clear reflection of the piece below it' },
  { id: 'white-counter', name: 'White countertop', swatch: 'linear-gradient(180deg,#f2f2f0 0 55%,#e2e1dd 56%,#fbfbfa)',
    prompt: 'standing on a matte white tabletop against a bright white wall, the line where the table meets the wall visible behind it, soft natural window light and a soft shadow' },
];

/** The prompt for a sheet: match the design exactly, in this glaze and setting. */
export function composePrompt(glaze: Glaze, bg: Backdrop): string {
  return 'Photorealistic handmade pottery, product photography, 4K. The ceramic piece must match the reference sheet exactly: ' +
    'the same silhouette, proportions, openings and details as the reference view and its depth, normal and edge maps, ' +
    `and as the front, side, top and 3/4 views. Glaze: ${glaze.prompt}. Setting: ${bg.prompt}. ` +
    'Realistic glaze texture and reflections, sharp focus, no text or labels.';
}

const REF = 1024; // the reference view and its passes
const TILE = 500; // the smaller tiles
const GAP = 24, PAD = 32, HEAD = 64;

/** Edge map (white lines on black) from a depth and a normal pass of the same view:
 *  the outline, depth jumps, and creases where the surface turns. Normals are compared
 *  K pixels either side (a crease spreads over a few pixels, so neighbours alone miss
 *  it), only the peak across a crease is kept (thin lines), and lines are drawn 2 px
 *  wide so they survive the sheet's downscaling. */
function edges(depth: HTMLCanvasElement, normal: HTMLCanvasElement): HTMLCanvasElement {
  const K = 3, CREASE = 1 - Math.cos((16 * Math.PI) / 180), JUMP = 14;
  const w = depth.width, h = depth.height;
  const D = depth.getContext('2d')!.getImageData(0, 0, w, h).data;
  const N = normal.getContext('2d')!.getImageData(0, 0, w, h).data;
  const n = new Float32Array(w * h * 3);
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    inside[i] = D[4 * i] > 4 ? 1 : 0;
    const x = N[4 * i] / 127.5 - 1, y = N[4 * i + 1] / 127.5 - 1, z = N[4 * i + 2] / 127.5 - 1;
    const l = Math.hypot(x, y, z) || 1;
    n[3 * i] = x / l; n[3 * i + 1] = y / l; n[3 * i + 2] = z / l;
  }
  // how much the surface turns across each pixel, horizontally and vertically
  const turn = (a: number, b: number) => (inside[a] && inside[b] ? 1 - (n[3 * a] * n[3 * b] + n[3 * a + 1] * n[3 * b + 1] + n[3 * a + 2] * n[3 * b + 2]) : 0);
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = K; y < h - K; y++) for (let x = K; x < w - K; x++) {
    const i = y * w + x;
    if (!inside[i]) continue;
    gx[i] = turn(i - K, i + K);
    gy[i] = turn(i - K * w, i + K * w);
  }
  const on = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    // outline and depth jumps
    if (inside[i] !== inside[i + 1] || inside[i] !== inside[i + w]) { on[i] = 1; continue; }
    if (!inside[i]) continue;
    if (Math.abs(D[4 * (i - 1)] - D[4 * (i + 1)]) > JUMP || Math.abs(D[4 * (i - w)] - D[4 * (i + w)]) > JUMP) { on[i] = 1; continue; }
    // creases: past the angle, and the peak across the crease
    const hx = gx[i], hy = gy[i];
    if (Math.max(hx, hy) < CREASE) continue;
    if (hx >= hy ? hx >= gx[i - 1] && hx >= gx[i + 1] : hy >= gy[i - w] && hy >= gy[i + w]) on[i] = 1;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const v = on[i] || (x > 0 && on[i - 1]) || (y > 0 && on[i - w]) || (x > 0 && y > 0 && on[i - w - 1]) ? 255 : 0;
    img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Stretch a depth pass to the depths it shows (nearest white, farthest dark grey). */
function stretch(depth: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = depth.getContext('2d')!;
  const img = ctx.getImageData(0, 0, depth.width, depth.height);
  const d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
  if (hi <= lo) return depth;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] <= 4) continue;
    const v = Math.round(40 + (215 * (d[i] - lo)) / (hi - lo));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return depth;
}

/** Silhouette (white on black) from a depth pass. */
function mask(depth: HTMLCanvasElement): HTMLCanvasElement {
  const w = depth.width, h = depth.height;
  const D = depth.getContext('2d')!.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    const v = D.data[4 * i] > 4 ? 255 : 0;
    D.data[4 * i] = D.data[4 * i + 1] = D.data[4 * i + 2] = v;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d')!.putImageData(D, 0, 0);
  return out;
}

/** The sheet as a PNG, or null when there is nothing to draw. `dir`: the view on
 *  screen, from the piece toward the camera. */
export async function buildSheet(view: Viewport, dir: THREE.Vector3, title: string, onProgress?: (f: number) => void): Promise<Blob | null> {
  const iso = new THREE.Vector3(1, 0.7, 1.2);
  const specs: CaptureSpec[] = [
    { dir, ortho: false, size: REF, passes: ['shade', 'depth', 'normal'] },
    { dir: new THREE.Vector3(0, 0, 1), ortho: true, size: TILE, passes: ['shade'] },
    { dir: new THREE.Vector3(1, 0, 0), ortho: true, size: TILE, passes: ['shade'] },
    { dir: new THREE.Vector3(0, 1, 0), ortho: true, size: TILE, passes: ['shade'] },
    { dir: iso, ortho: false, size: TILE, passes: ['shade'] },
  ];
  // one view per frame, so the page stays responsive while the sheet renders
  const shots: Record<string, HTMLCanvasElement>[] = [];
  for (let i = 0; i < specs.length; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const one = view.captureViews([specs[i]]);
    if (!one) return null;
    shots.push(one[0]);
    onProgress?.((i + 1) / specs.length);
  }
  const [ref, front, side, top, threeQ] = shots;
  stretch(ref.depth);

  const W = PAD * 2 + REF + GAP + 2 * TILE + GAP;
  const H = PAD * 2 + HEAD + REF + GAP + TILE;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#faf8f5';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2b2622';
  ctx.font = '600 30px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, PAD, PAD + HEAD / 2 - 6);
  ctx.fillStyle = '#7b726a';
  ctx.font = '400 18px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Reference sheet · views and maps of one design', W - PAD, PAD + HEAD / 2 - 6);
  ctx.textAlign = 'left';

  const tile = (src: HTMLCanvasElement, x: number, y: number, s: number, label: string, dark: boolean) => {
    ctx.drawImage(src, 0, 0, src.width, src.height, x, y, s, s);
    ctx.strokeStyle = dark ? '#000' : '#e2ddd6';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
    ctx.font = '600 15px system-ui, -apple-system, Segoe UI, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.88)' : 'rgba(43,38,34,0.82)';
    ctx.fillRect(x + 10, y + 10, tw + 16, 26);
    ctx.fillStyle = dark ? '#111' : '#fff';
    ctx.fillText(label, x + 18, y + 23);
  };
  const y0 = PAD + HEAD;
  const xr = PAD + REF + GAP;
  tile(ref.shade, PAD, y0, REF, 'Reference view', false);
  tile(ref.depth, xr, y0, TILE, 'Depth (near = white)', true);
  tile(ref.normal, xr + TILE + GAP, y0, TILE, 'Normal (view space)', true);
  tile(edges(ref.depth, ref.normal), xr, y0 + TILE + GAP, TILE, 'Edges', true);
  tile(mask(ref.depth), xr + TILE + GAP, y0 + TILE + GAP, TILE, 'Silhouette', true);
  const y1 = y0 + REF + GAP;
  [[front, 'Front (orthographic)'], [side, 'Side (orthographic)'], [top, 'Top (orthographic)'], [threeQ, '3/4 view']].forEach(([s, l], i) =>
    tile((s as Record<string, HTMLCanvasElement>).shade, PAD + i * (TILE + GAP), y1, TILE, l as string, false));
  return new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
}
