// 2D profile editor for revolve objects. The right half is the editable profile
// (radius >= 0); the left half mirrors it so the silhouette reads as the pot.
//
// One finger: drag moves the nearest point (or the selected one when none is
// close), so small points are easy to move on a phone. Two fingers: pinch to
// zoom, drag to pan. Mouse wheel zooms too. Points keep their bottom-to-top
// order; the foot and rim can't be removed.

import type { FootStyle, ProfilePoint, RimStyle } from '../engine/profile';
import { bezierAt, bezierSegments, decorate, edgeOf, pointName, sampleCurve } from '../engine/profile';

const MAX_POINTS = 10;
const GAP = 0.4; // cm between neighbouring points' heights

export class ProfileEditor {
  private ctx: CanvasRenderingContext2D;
  private pts: ProfilePoint[];
  private rim: RimStyle;
  private foot: FootStyle;
  selected = 1;
  /** view: world (r, y) at the canvas centre, pixels per cm */
  private view = { cx: 0, cy: 0, s: 20 };
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { target: number; x: number; y: number; moved: boolean } | null = null;
  private pinch: { d: number; mx: number; my: number } | null = null;
  onChange: (pts: ProfilePoint[], done: boolean) => void = () => {};
  onSelect: (i: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, points: ProfilePoint[], rim: RimStyle = 'plain', foot: FootStyle = 'flat') {
    this.ctx = canvas.getContext('2d')!;
    this.pts = points.map((p) => ({ r: p.r, y: p.y, t: edgeOf(p) }));
    this.rim = rim;
    this.foot = foot;
    this.selected = Math.min(1, this.pts.length - 1);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.local(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
    }, { passive: false });
    new ResizeObserver(() => { if (!this.fitted) this.fit(); this.draw(); }).observe(canvas);
  }

  private fitted = false;

  points() {
    return this.pts.map((p) => ({ ...p }));
  }

  setStyles(rim: RimStyle, foot: FootStyle) {
    this.rim = rim;
    this.foot = foot;
    this.draw();
  }

  setPoints(points: ProfilePoint[]) {
    this.pts = points.map((p) => ({ r: p.r, y: p.y, t: edgeOf(p) }));
    this.selected = Math.min(1, this.pts.length - 1);
    this.onSelect(this.selected);
    this.fit();
    this.emit(true);
  }

  edge(): number {
    return edgeOf(this.pts[this.selected]);
  }

  setEdge(v: number, done: boolean) {
    this.pts[this.selected].t = v;
    this.emit(done);
  }

  name(i = this.selected) {
    return pointName(i, this.pts.length);
  }

  canRemove() {
    return this.selected > 0 && this.selected < this.pts.length - 1 && this.pts.length > 2;
  }

  removePoint() {
    if (!this.canRemove()) return;
    this.pts.splice(this.selected, 1);
    this.selected = Math.max(1, this.selected - 1);
    this.onSelect(this.selected);
    this.emit(true);
  }

  /** Segment that can take another point: just above the selected one, else the roomiest. */
  private splitTarget(): number {
    if (this.pts.length >= MAX_POINTS) return -1;
    const fits = (i: number) => i >= 0 && i < this.pts.length - 1 && Math.abs(this.pts[i + 1].y - this.pts[i].y) >= GAP * 2;
    const first = this.selected < this.pts.length - 1 ? this.selected : this.selected - 1;
    if (fits(first)) return first;
    let best = -1, span = 0;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const h = Math.abs(this.pts[i + 1].y - this.pts[i].y);
      if (fits(i) && h > span) { span = h; best = i; }
    }
    return best;
  }

  canAdd() {
    return this.splitTarget() >= 0;
  }

  /** Insert halfway up the segment, sitting on the curve so nothing jumps. */
  addPoint() {
    const i = this.splitTarget();
    if (i < 0) return;
    const s = bezierSegments(this.pts)[i];
    const want = (this.pts[i].y + this.pts[i + 1].y) / 2;
    let mid = bezierAt(s, 0.5), bd = Infinity;
    for (let k = 1; k < 60; k++) {
      const q = bezierAt(s, k / 60);
      const d = Math.abs(q.y - want);
      if (d < bd) { bd = d; mid = q; }
    }
    this.pts.splice(i + 1, 0, { r: Math.max(0, mid.x), y: mid.y, t: 1 });
    this.selected = i + 1;
    this.onSelect(this.selected);
    this.emit(true);
  }

  // ------------------------------------------------------------ view
  /** Fit the decorated profile (both halves) into the canvas. */
  fit() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.fitted = true;
    const { xy } = sampleCurve(decorate(this.pts, this.rim, this.foot), 6);
    let rMax = 2, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < xy.length; i += 2) { rMax = Math.max(rMax, xy[i]); yMin = Math.min(yMin, xy[i + 1]); yMax = Math.max(yMax, xy[i + 1]); }
    const ext = { r: rMax * 1.25 + 1, y0: yMin - 2, y1: yMax + 2 };
    this.view = { cx: 0, cy: (ext.y0 + ext.y1) / 2, s: Math.min(w / (2 * ext.r), h / (ext.y1 - ext.y0)) };
    this.draw();
  }

  zoomBy(f: number) {
    this.zoomAt(f, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  private zoomAt(f: number, x: number, y: number) {
    const [wx, wy] = this.toWorld(x, y);
    this.view.s = Math.min(400, Math.max(2, this.view.s * f));
    // keep the point under the cursor fixed
    const [nx, ny] = this.toWorld(x, y);
    this.view.cx += wx - nx;
    this.view.cy += wy - ny;
    this.draw();
  }

  private toScreen(r: number, y: number): [number, number] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [w / 2 + (r - this.view.cx) * this.view.s, h / 2 - (y - this.view.cy) * this.view.s];
  }

  private toWorld(x: number, y: number): [number, number] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [(x - w / 2) / this.view.s + this.view.cx, -(y - h / 2) / this.view.s + this.view.cy];
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ------------------------------------------------------------ input
  private nearest(x: number, y: number, reach = 30): number {
    let best = -1, bd = reach;
    this.pts.forEach((p, i) => {
      // either half of the silhouette grabs the point
      for (const sgn of [1, -1]) {
        const [sx, sy] = this.toScreen(sgn * p.r, p.y);
        const d = Math.hypot(sx - x, sy - y);
        if (d < bd) { bd = d; best = i; }
      }
    });
    return best;
  }

  private down(e: PointerEvent) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 2) {
      // second finger: switch from dragging a point to pinch/pan
      if (this.drag?.moved) this.emit(true);
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    const hit = this.nearest(x, y);
    const target = hit >= 0 ? hit : this.selected;
    if (target !== this.selected) { this.selected = target; this.onSelect(target); }
    this.drag = { target, x, y, moved: false };
    this.draw();
  }

  private move(e: PointerEvent) {
    if (!this.pointers.has(e.pointerId)) return;
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.view.cx -= (mx - this.pinch.mx) / this.view.s;
      this.view.cy += (my - this.pinch.my) / this.view.s;
      this.zoomAt(d / Math.max(1, this.pinch.d), mx, my);
      this.pinch = { d, mx, my };
      return;
    }
    const dr = this.drag;
    if (!dr) return;
    const dx = (x - dr.x) / this.view.s, dy = -(y - dr.y) / this.view.s;
    if (!dr.moved && Math.hypot(x - dr.x, y - dr.y) < 3) return;
    dr.moved = true;
    dr.x = x; dr.y = y;
    this.moveNode(dr.target, dx, dy);
    this.emit(false);
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    const dr = this.drag;
    if (dr && this.pointers.size === 0) {
      if (dr.moved) this.emit(true);
      this.drag = null;
    }
  }

  /** Move a point, keeping the bottom-to-top order and r >= 0. */
  private moveNode(i: number, dr: number, dy: number) {
    const p = this.pts[i];
    p.r = Math.max(0, snap(p.r + dr));
    let y = p.y + dy;
    const below = this.pts[i - 1], above = this.pts[i + 1];
    if (below) y = Math.max(y, below.y + GAP);
    if (above) y = Math.min(y, above.y - GAP);
    p.y = snap(y);
  }

  private emit(done: boolean) {
    this.draw();
    this.onChange(this.points(), done);
  }

  // ------------------------------------------------------------ drawing
  draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.canvas);
    const col = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
    const fg = col('--fg', '#222'), muted = col('--muted', '#777'), line = col('--line', '#ccc');
    const accent = col('--accent', '#2c7a6e'), surface = col('--surface', '#fff');
    ctx.clearRect(0, 0, w, h);

    // grid: pick a step so lines are 18-60 px apart
    const steps = [0.5, 1, 2, 5, 10, 20, 50];
    const step = steps.find((s) => s * this.view.s >= 18) ?? 50;
    const major = step * 5;
    const [x0, y0] = this.toWorld(0, h), [x1, y1] = this.toWorld(w, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = line;
    for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
      const [sx] = this.toScreen(gx, 0);
      ctx.globalAlpha = Math.abs(gx / major - Math.round(gx / major)) < 1e-6 ? 0.9 : 0.4;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
    }
    for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
      const [, sy] = this.toScreen(0, gy);
      ctx.globalAlpha = Math.abs(gy / major - Math.round(gy / major)) < 1e-6 ? 0.9 : 0.4;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // axis of revolution
    const [ax] = this.toScreen(0, 0);
    ctx.strokeStyle = muted;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, h); ctx.stroke();
    ctx.setLineDash([]);

    // the decorated silhouette, both halves
    const { xy } = sampleCurve(decorate(this.pts, this.rim, this.foot), 16);
    const path = (mirror: number) => {
      ctx.beginPath();
      const [sx0, sy0] = this.toScreen(0, xy[1]);
      ctx.moveTo(sx0, sy0);
      for (let i = 0; i < xy.length; i += 2) {
        const [sx, sy] = this.toScreen(mirror * xy[i], xy[i + 1]);
        ctx.lineTo(sx, sy);
      }
      const [sx1, sy1] = this.toScreen(0, xy[xy.length - 1]);
      ctx.lineTo(sx1, sy1);
    };
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.12;
    path(-1); ctx.fill();
    path(1); ctx.fill();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    path(-1); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    path(1); ctx.stroke();

    // control points: hollow = smooth-ish, small square = sharp corner
    this.pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p.r, p.y);
      const on = i === this.selected;
      if (on) {
        ctx.fillStyle = accent; ctx.globalAlpha = 0.18;
        ctx.beginPath(); ctx.arc(sx, sy, 16, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = on ? accent : surface;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (edgeOf(p) < 0.15) ctx.rect(sx - 6, sy - 6, 12, 12);
      else ctx.arc(sx, sy, on ? 8 : 6.5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });

    // labels: selected point name, size of the piece, grid step
    ctx.font = '600 12px Figtree, system-ui, sans-serif';
    ctx.fillStyle = fg;
    const sp = this.pts[this.selected];
    if (sp) {
      const [sx, sy] = this.toScreen(sp.r, sp.y);
      ctx.fillText(`${this.name()}  r ${sp.r.toFixed(1)}`, Math.min(sx + 14, w - 90), sy - 12);
    }
    let rMax = 0, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < xy.length; i += 2) { rMax = Math.max(rMax, xy[i]); yMin = Math.min(yMin, xy[i + 1]); yMax = Math.max(yMax, xy[i + 1]); }
    ctx.font = '500 11px "IBM Plex Mono", monospace';
    ctx.fillStyle = muted;
    ctx.fillText(`height ${(yMax - yMin).toFixed(1)} cm · widest ⌀ ${(2 * rMax).toFixed(1)} cm`, 8, 16);
    ctx.fillText(`grid ${step} cm`, 8, h - 8);
    ctx.fillText('axis', ax + 4, h - 24);
  }
}

function snap(v: number): number {
  return Math.round(v * 20) / 20; // 0.5 mm
}
