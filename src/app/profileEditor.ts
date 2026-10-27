// 2D profile editor for revolve objects. The right half is the editable profile
// (radius ≥ 0); the left half mirrors it so the silhouette reads as the pot.
// Tap empty space to insert a point, drag points to move them, tap a point to
// select it (then toggle corner / delete).

import type { ProfilePoint } from '../engine/profile';
import { sampleCurve } from '../engine/profile';

export class ProfileEditor {
  private ctx: CanvasRenderingContext2D;
  private pts: ProfilePoint[];
  selected = -1;
  private drag = -1;
  private downAt: { x: number; y: number; moved: boolean } | null = null;
  private view = { cx: 0, cy: 0, s: 20 };
  onChange: (pts: ProfilePoint[], done: boolean) => void = () => {};
  onSelect: (i: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, points: ProfilePoint[]) {
    this.ctx = canvas.getContext('2d')!;
    this.pts = points.map((p) => ({ ...p }));
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', () => { this.drag = -1; this.downAt = null; });
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.fit();
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

  private fit() {
    let rMax = 4, yMin = -4, yMax = 4;
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
    const s = Math.min(w / (2 * e.rMax), h / (e.yMax - e.yMin));
    this.view = { cx: w / 2, cy: h / 2 + ((e.yMax + e.yMin) / 2) * s, s };
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  private toScreen(r: number, y: number): [number, number] {
    return [this.view.cx + r * this.view.s, this.view.cy - y * this.view.s];
  }
  private toWorld(x: number, y: number): [number, number] {
    return [(x - this.view.cx) / this.view.s, (this.view.cy - y) / this.view.s];
  }

  private local(e: PointerEvent): [number, number] {
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
    this.downAt = { x, y, moved: false };
    this.drag = this.hitPoint(x, y);
  }

  private move(e: PointerEvent) {
    if (!this.downAt) return;
    const [x, y] = this.local(e);
    if (Math.hypot(x - this.downAt.x, y - this.downAt.y) > 4) this.downAt.moved = true;
    if (this.drag >= 0 && this.downAt.moved) {
      const [r, wy] = this.toWorld(x, y);
      this.pts[this.drag] = { ...this.pts[this.drag], r: snap(Math.max(0, r)), y: snap(wy) };
      this.emit(false);
    }
  }

  private up(e: PointerEvent) {
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
    for (let gx = Math.ceil(x0); gx <= x1; gx++) {
      const [sx] = this.toScreen(gx, 0);
      ctx.strokeStyle = line;
      ctx.globalAlpha = gx % 5 === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
    }
    for (let gy = Math.ceil(y0); gy <= y1; gy++) {
      const [, sy] = this.toScreen(0, gy);
      ctx.globalAlpha = gy % 5 === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // axis of revolution
    ctx.strokeStyle = muted;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(this.view.cx, 0); ctx.lineTo(this.view.cx, h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText('axis', this.view.cx + 4, 12);
    ctx.fillText('1 cm grid', 6, h - 6);

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
