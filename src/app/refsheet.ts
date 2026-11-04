// The reference sheet: the piece from the angle on screen (shaded, and its depth,
// normal, edge and silhouette maps) and from fixed views, composed into one image to
// hand an image model along with a prompt. Rendered by Viewport.captureViews.

import * as THREE from 'three';
import type { Viewport } from './viewport';

export const DEFAULT_PROMPT =
  'Photorealistic handmade pottery, product photography, 4K. The ceramic piece must match the reference sheet exactly: ' +
  'the same silhouette, proportions, openings and details as the reference view and its depth, normal and edge maps, ' +
  'and as the front, side, top and 3/4 views. Real clay and glaze materials, soft studio lighting, neutral background, sharp focus.';

const REF = 1024; // the reference view and its passes
const TILE = 500; // the smaller tiles
const GAP = 24, PAD = 32, HEAD = 64;

/** Edge map (white lines on black) from a depth and a normal pass of the same view:
 *  creases where the normal turns, outlines where the depth jumps or the piece ends. */
function edges(depth: HTMLCanvasElement, normal: HTMLCanvasElement): HTMLCanvasElement {
  const w = depth.width, h = depth.height;
  const D = depth.getContext('2d')!.getImageData(0, 0, w, h).data;
  const N = normal.getContext('2d')!.getImageData(0, 0, w, h).data;
  const on = new Uint8Array(w * h);
  const nv = (i: number) => [N[4 * i] / 127.5 - 1, N[4 * i + 1] / 127.5 - 1, N[4 * i + 2] / 127.5 - 1];
  const inside = (i: number) => D[4 * i] > 4;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    for (const j of [i + 1, i + w]) {
      const a = inside(i), b = inside(j);
      let edge = a !== b;
      if (!edge && a) {
        const p = nv(i), q = nv(j);
        edge = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] < 0.9 || Math.abs(D[4 * i] - D[4 * j]) > 10;
      }
      if (edge) { on[i] = 1; on[j] = 1; }
    }
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = on[i] ? 255 : 0;
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
export async function buildSheet(view: Viewport, dir: THREE.Vector3, title: string): Promise<Blob | null> {
  const iso = new THREE.Vector3(1, 0.7, 1.2);
  const shots = view.captureViews([
    { dir, ortho: false, size: REF, passes: ['shade', 'depth', 'normal'] },
    { dir: new THREE.Vector3(0, 0, 1), ortho: true, size: TILE, passes: ['shade'] },
    { dir: new THREE.Vector3(1, 0, 0), ortho: true, size: TILE, passes: ['shade'] },
    { dir: new THREE.Vector3(0, 1, 0), ortho: true, size: TILE, passes: ['shade'] },
    { dir: iso, ortho: false, size: TILE, passes: ['shade'] },
  ]);
  if (!shots) return null;
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
