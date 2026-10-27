// 2D profile editor for revolve objects. The right half is the editable profile
// (radius ≥ 0); the left half mirrors it so the silhouette reads as the pot.
// Tap empty space to insert a point, drag points to move them, tap a point to
// select it (then toggle corner / delete). Pinch or scroll to zoom and two
// fingers to pan, so the canvas can cover small or large pieces.

import type { ProfilePoint } from '../engine/profile';
import { sampleCurve } from '../engine/profile';

export class ProfileEditor {
  private ctx: CanvasRenderingContext2D;
  private pts: ProfilePoint[];
  selected = -1;
  private drag = -1;
  private downAt: { x: number; y: number; moved: boolean } | null = null;
  private view = { cx: 0, cy: 0, s: 20 };
  private zoom = 1;
  private pan = { r: 0, y: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; x: number; y: number } | null = null;
  onChange: (pts: ProfilePoint[], done: boolean) => void = () => {};
  onSelect: (i: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, points: ProfilePoint[]) {
    this.ctx = canvas.getContext('2d')!;
    this.pts = points.map((p) => ({ ...p }));
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); this.pinch = null; this.drag = -1; this.downAt = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.local(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.fitExtent();
    this.draw();
  }

  points() {
    return this.pts.map((p) => ({ ...p }));
  }

  toggleCorner() {
    if (this.selected < 0) return;
    this.pts[this.selected].corner = !this.pts[this.selected].corner;
    this.emit(true);
  }

  deleteSelected() {
    if (this.selected < 0 || this.pts.length <= 2) return;
    this.pts.splice(this.selected, 1);
    this.selected = -1;
    this.onSelect(-1);
    this.emit(true);
  }

  /** Reset the view to frame the profile. */
  fit() {
    this.zoom = 1;
    this.pan = { r: 0, y: 0 };
    this.fitExtent();
    this.draw();
  }

  zoomBy(f: number) {
    this.zoomAt(f, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  /** Zoom keeping the world point under (x, y) fixed. */
  private zoomAt(f: number, x: number, y: number) {
    this.layout();
    const [r0, y0] = this.toWorld(x, y);
    this.zoom = Math.min(50, Math.max(0.05, this.zoom * f));
    this.layout();
    const [r1, y1] = this.toWorld(x, y);
    this.pan.r += r0 - r1;
    this.pan.y += y0 - y1;
    this.draw();
  }

  private fitExtent() {
    let rMax = 6, yMin = -6, yMax = 6;
    for (const p of this.pts) {
      rMax = Math.max(rMax, p.r);
      yMin = Math.min(yMin, p.y);
      yMax = Math.max(yMax, p.y);
    }
    this.extent = { rMax: rMax * 1.35 + 0.5, yMin: yMin - 1.5, yMax: yMax + 1.5 };
  }
  private extent = { rMax: 8, yMin: -8, yMax: 8 };

  private layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const e = this.extent;
    const s = Math.min(w / (2 * e.rMax), h / (e.yMax - e.yMin)) * this.zoom;
    const cr = this.pan.r, cy = (e.yMax + e.yMin) / 2 + this.pan.y;
    this.view = { cx: w / 2 - cr * s, cy: h / 2 + cy * s, s };
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  private toScreen(r: number, y: number): [number, number] {
    return [this.view.cx + r * this.view.s, this.view.cy - y * this.view.s];
  }
  private toWorld(x: number, y: number): [number, number] {
    return [(x - this.view.cx) / this.view.s, (this.view.cy - y) / this.view.s];
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private hitPoint(x: number, y: number): number {
    let best = -1, bd = 24;
    this.pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p.r, p.y);
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  private down(e: PointerEvent) {
    const [x, y] = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 2) {
      // second finger: stop editing and pinch/pan instead
      if (this.drag >= 0 && this.downAt?.moved) this.emit(true);
      this.drag = -1;
      this.downAt = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }
    if (this.pointers.size > 2) return;
    this.downAt = { x, y, moved: false };
    this.drag = this.hitPoint(x, y);
  }

  private move(e: PointerEvent) {
    const [x, y] = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.pan.r -= (mx - this.pinch.x) / this.view.s;
      this.pan.y += (my - this.pinch.y) / this.view.s;
      this.zoomAt(d / Math.max(1, this.pinch.d), mx, my);
      this.pinch = { d, x: mx, y: my };
      return;
    }
    if (!this.downAt) return;
    if (Math.hypot(x - this.downAt.x, y - this.downAt.y) > 4) this.downAt.moved = true;
    if (this.drag >= 0 && this.downAt.moved) {
      const [r, wy] = this.toWorld(x, y);
      this.pts[this.drag] = { ...this.pts[this.drag], r: snap(Math.max(0, r)), y: snap(wy) };
      this.emit(false);
    }
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.downAt) return;
    const [x, y] = this.local(e);
    if (this.drag >= 0) {
      if (this.downAt.moved) this.emit(true);
      else { this.selected = this.drag; this.onSelect(this.selected); this.draw(); }
    } else if (!this.downAt.moved) {
      const [r, wy] = this.toWorld(x, y);
      this.insert(Math.max(0, snap(r)), snap(wy));
    }
    this.drag = -1;
    this.downAt = null;
  }

  private insert(r: number, y: number) {
    // insert after the span whose sampled curve passes closest to the tap
    const { xy, span } = sampleCurve(this.pts, 8);
    let best = 0, bd = Infinity;
    for (let i = 0; i < span.length; i++) {
      const d = Math.hypot(xy[2 * (i + 1)] - r, xy[2 * (i + 1) + 1] - y);
      if (d < bd) { bd = d; best = span[i]; }
    }
    const first = this.pts[0], last = this.pts[this.pts.length - 1];
    let at = best + 1;
    if (Math.hypot(first.r - r, first.y - y) < bd && y < first.y) at = 0;
    else if (Math.hypot(last.r - r, last.y - y) < bd && y > last.y) at = this.pts.length;
    this.pts.splice(at, 0, { r, y });
    this.selected = at;
    this.onSelect(at);
    this.emit(true);
  }

  private emit(done: boolean) {
    this.draw();
    this.onChange(this.points(), done);
  }

  draw() {
    const { w, h } = this.layout();
    const ctx = this.ctx;
    const css = getComputedStyle(this.canvas);
    const fg = css.getPropertyValue('--fg').trim() || '#222';
    const muted = css.getPropertyValue('--muted').trim() || '#777';
    const line = css.getPropertyValue('--line').trim() || '#ccc';
    const accent = css.getPropertyValue('--accent').trim() || '#2c7a6e';
    ctx.clearRect(0, 0, w, h);
    // centimetre grid
    ctx.lineWidth = 1;
    ctx.font = '500 10px "IBM Plex Mono", monospace';
    ctx.fillStyle = muted;
    const [x0, y0] = this.toWorld(0, h), [x1, y1] = this.toWorld(w, 0);
    // grid step follows the zoom (lines at least 12 px apart), bolder every 10 cm
    const step = [0.5, 1, 2, 5, 10, 20, 50, 100].find((v) => v * this.view.s >= 12) ?? 100;
    const major = Math.max(10, step * 5);
    for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
      const [sx] = this.toScreen(gx, 0);
      ctx.strokeStyle = line;
      ctx.globalAlpha = gx % major === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
    }
    for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
      const [, sy] = this.toScreen(0, gy);
      ctx.globalAlpha = gy % major === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // axis of revolution
    ctx.strokeStyle = muted;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(this.view.cx, 0); ctx.lineTo(this.view.cx, h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText('axis', this.view.cx + 4, 12);
    ctx.fillText(`${step} cm grid`, 6, h - 6);

    const { xy } = sampleCurve(this.pts, 16);
    const path = (mirror: number) => {
      ctx.beginPath();
      const [ax, ay] = this.toScreen(0, xy[1]);
      ctx.moveTo(ax, ay);
      for (let i = 0; i < xy.length; i += 2) {
        const [sx, sy] = this.toScreen(mirror * xy[i], xy[i + 1]);
        ctx.lineTo(sx, sy);
      }
      const [bx, by] = this.toScreen(0, xy[xy.length - 1]);
      ctx.lineTo(bx, by);
    };
    // mirrored silhouette (left) and editable profile (right)
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.1;
    path(-1); ctx.fill();
    path(1); ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    path(-1); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    path(1); ctx.stroke();
    // control points: circles = smooth, squares = corner
    this.pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p.r, p.y);
      ctx.fillStyle = i === this.selected ? accent : (css.getPropertyValue('--surface').trim() || '#fff');
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (p.corner) ctx.rect(sx - 7, sy - 7, 14, 14);
      else ctx.arc(sx, sy, 7.5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
  }
}

function snap(v: number): number {
  return Math.round(v * 20) / 20; // 0.5 mm
}
