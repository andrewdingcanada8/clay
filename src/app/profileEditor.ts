// 2D profile editor for revolve objects. The right half is the editable profile
// (radius ≥ 0); the left half mirrors it so the silhouette reads as the pot.
// Tap empty space to insert a point, tap a point to select it. Dragging near a
// point moves it; dragging anywhere else moves the selected point, so the finger
// never has to cover it. Points follow the finger's motion (no jump to the
// touch). Pinch or scroll to zoom and two fingers to pan, so the canvas can
// cover small or large pieces.
//
// Modes: 'profile' (revolve: r >= 0, mirrored), 'path' and 'section' (free curves
// on a plane, open or closed), and 'graph' (a function of the distance along a
// path: x runs from 0 to the path's length and the end points stay at the ends).

import type { ProfilePoint } from '../engine/profile';
import { sampleCurve, smoothOf } from '../engine/profile';

export interface CurveMode {
  kind: 'profile' | 'path' | 'section' | 'graph';
  closed?: boolean;
  /** axis names for path and section curves, e.g. ['X', 'Z'] */
  axes?: [string, string];
  /** graph: the path length (cm) that x = 0..1 spans */
  length?: number;
}

export class ProfileEditor {
  private ctx: CanvasRenderingContext2D;
  private pts: ProfilePoint[];
  selected = -1;
  private drag = -1;
  private hit = -1;
  private downAt: { x: number; y: number; moved: boolean; r: number; py: number } | null = null;
  /** screen = centre + world × scale; a graph scales x and y separately */
  private view = { cx: 0, cy: 0, sx: 20, sy: 20 };
  private zoom = 1;
  private pan = { r: 0, y: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; x: number; y: number } | null = null;
  onChange: (pts: ProfilePoint[], done: boolean) => void = () => {};
  onSelect: (i: number) => void = () => {};

  private mode: CurveMode;
  /** graph x scale: stored x (0..1) times this is the shown distance in cm */
  private gx = 1;

  constructor(private canvas: HTMLCanvasElement, points: ProfilePoint[], mode: CurveMode = { kind: 'profile' }) {
    this.ctx = canvas.getContext('2d')!;
    this.mode = mode;
    this.gx = mode.kind === 'graph' ? Math.max(1, mode.length ?? 1) : 1;
    this.pts = points.map((p) => ({ ...p, r: p.r * this.gx }));
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
    return this.pts.map((p) => ({ ...p, r: p.r / this.gx }));
  }

  private get closed() { return !!this.mode.closed && (this.mode.kind === 'path' || this.mode.kind === 'section'); }
  private get mirrored() { return this.mode.kind === 'profile'; }

  /** Smoothness of the selected point: 0 sharp … 1 smooth. */
  smooth(): number {
    return this.selected < 0 ? 1 : smoothOf(this.pts[this.selected]);
  }

  setSmooth(v: number, done: boolean) {
    if (this.selected < 0) return;
    const p = this.pts[this.selected];
    delete p.corner;
    p.smooth = v;
    this.emit(done);
  }

  canDelete(i = this.selected) {
    if (i < 0) return false;
    if (this.mode.kind === 'graph') return i > 0 && i < this.pts.length - 1;
    return this.pts.length > (this.closed ? 3 : 2);
  }

  deleteSelected() {
    if (!this.canDelete()) return;
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
    const k = this.mode.kind;
    let rMin = k === 'profile' ? 0 : Infinity, rMax = k === 'profile' ? 6 : -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of this.pts) {
      rMin = Math.min(rMin, p.r); rMax = Math.max(rMax, p.r);
      yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y);
    }
    if (k === 'graph') { rMin = 0; rMax = this.gx; yMin = Math.min(yMin, -2); yMax = Math.max(yMax, 2); }
    if (k === 'profile') {
      yMin = Math.min(yMin, -6); yMax = Math.max(yMax, 6);
      this.extent = { rMin: -(rMax * 1.35 + 0.5), rMax: rMax * 1.35 + 0.5, yMin: yMin - 1.5, yMax: yMax + 1.5 };
      return;
    }
    const pad = 0.15 * Math.max(rMax - rMin, yMax - yMin, 2);
    this.extent = { rMin: rMin - pad, rMax: rMax + pad, yMin: yMin - pad, yMax: yMax + pad };
  }
  private extent = { rMin: -8, rMax: 8, yMin: -8, yMax: 8 };

  private layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const e = this.extent;
    const fx = w / (e.rMax - e.rMin), fy = h / (e.yMax - e.yMin);
    // curves keep true proportions; a graph fills the canvas both ways
    const sx = (this.mode.kind === 'graph' ? fx : Math.min(fx, fy)) * this.zoom;
    const sy = (this.mode.kind === 'graph' ? fy : Math.min(fx, fy)) * this.zoom;
    const cr = (e.rMax + e.rMin) / 2 + this.pan.r, cy = (e.yMax + e.yMin) / 2 + this.pan.y;
    this.view = { cx: w / 2 - cr * sx, cy: h / 2 + cy * sy, sx, sy };
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  private toScreen(r: number, y: number): [number, number] {
    return [this.view.cx + r * this.view.sx, this.view.cy - y * this.view.sy];
  }
  private toWorld(x: number, y: number): [number, number] {
    return [(x - this.view.cx) / this.view.sx, (this.view.cy - y) / this.view.sy];
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private hitPoint(x: number, y: number): number {
    let best = -1, bd = 28;
    this.pts.forEach((p, i) => {
      // either half of the silhouette grabs the point
      for (const sgn of this.mirrored ? [1, -1] : [1]) {
        const [sx, sy] = this.toScreen(sgn * p.r, p.y);
        const d = Math.hypot(sx - x, sy - y);
        if (d < bd) { bd = d; best = i; }
      }
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
    this.hit = this.hitPoint(x, y);
    this.drag = this.hit >= 0 ? this.hit : this.selected;
    const p = this.pts[this.drag];
    this.downAt = { x, y, moved: false, r: p?.r ?? 0, py: p?.y ?? 0 };
  }

  private move(e: PointerEvent) {
    const [x, y] = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.pan.r -= (mx - this.pinch.x) / this.view.sx;
      this.pan.y += (my - this.pinch.y) / this.view.sy;
      this.zoomAt(d / Math.max(1, this.pinch.d), mx, my);
      this.pinch = { d, x: mx, y: my };
      return;
    }
    if (!this.downAt) return;
    if (Math.hypot(x - this.downAt.x, y - this.downAt.y) > 4) this.downAt.moved = true;
    if (this.drag >= 0 && this.downAt.moved) {
      if (this.drag !== this.selected) { this.selected = this.drag; this.onSelect(this.drag); }
      // follow the finger's motion relative to where it went down
      // (on the mirrored left half, moving left grows the radius)
      const { sx, sy } = this.view, d = this.downAt, side = this.mirrored && d.x < this.view.cx ? -1 : 1;
      this.pts[this.drag] = { ...this.pts[this.drag], r: this.limitR(this.drag, snap(d.r + side * (x - d.x) / sx)), y: snap(d.py - (y - d.y) / sy) };
      this.emit(false);
    }
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.downAt) return;
    const [x, y] = this.local(e);
    if (this.downAt.moved) {
      if (this.drag >= 0) this.emit(true);
    } else if (this.hit >= 0) {
      this.selected = this.hit; this.onSelect(this.selected); this.draw();
    } else {
      const [r, wy] = this.toWorld(x, y);
      this.insert(snap(r), snap(wy));
    }
    this.drag = -1;
    this.downAt = null;
  }

  /** Where a point may sit horizontally: r >= 0 on a profile; on a graph the ends
   *  stay at the ends and the rest keep their order. */
  private limitR(i: number, r: number): number {
    if (this.mode.kind === 'profile') return Math.max(0, r);
    if (this.mode.kind !== 'graph') return r;
    if (i === 0) return 0;
    if (i === this.pts.length - 1) return this.gx;
    const gap = this.gx * 0.002;
    return Math.min(this.pts[i + 1].r - gap, Math.max(this.pts[i - 1].r + gap, r));
  }

  private insert(r: number, y: number) {
    if (this.mode.kind === 'graph') {
      // graph points stay in order of distance
      if (r <= 0 || r >= this.gx) return;
      const at = this.pts.findIndex((p) => p.r > r);
      this.pts.splice(at, 0, { r, y });
      this.selected = at;
      this.onSelect(at);
      this.emit(true);
      return;
    }
    if (this.mode.kind === 'profile') r = Math.max(0, r);
    // insert after the span whose sampled curve passes closest to the tap
    const { xy, span } = sampleCurve(this.pts, 8, { closed: this.closed, clampR: this.mirrored });
    let best = 0, bd = Infinity;
    for (let i = 0; i < span.length; i++) {
      const d = Math.hypot(xy[2 * (i + 1)] - r, xy[2 * (i + 1) + 1] - y);
      if (d < bd) { bd = d; best = span[i]; }
    }
    const first = this.pts[0], last = this.pts[this.pts.length - 1];
    let at = best + 1;
    if (!this.closed) {
      // past an end: extend the curve there
      if (Math.hypot(first.r - r, first.y - y) < bd && (this.mirrored ? y < first.y : true)) at = 0;
      else if (Math.hypot(last.r - r, last.y - y) < bd && (this.mirrored ? y > last.y : true)) at = this.pts.length;
    }
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
    const pick = (sc: number) => [0.5, 1, 2, 5, 10, 20, 50, 100].find((v) => v * sc >= 12) ?? 100;
    const stepX = pick(this.view.sx), stepY = pick(this.view.sy), step = Math.max(stepX, stepY);
    const majorX = Math.max(10, stepX * 5), majorY = Math.max(10, stepY * 5);
    for (let gx = Math.ceil(x0 / stepX) * stepX; gx <= x1; gx += stepX) {
      const [sx] = this.toScreen(gx, 0);
      ctx.strokeStyle = line;
      ctx.globalAlpha = gx % majorX === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, h); ctx.stroke();
    }
    for (let gy = Math.ceil(y0 / stepY) * stepY; gy <= y1; gy += stepY) {
      const [, sy] = this.toScreen(0, gy);
      ctx.globalAlpha = gy % majorY === 0 ? 0.9 : 0.45;
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(w, sy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const k = this.mode.kind;
    ctx.strokeStyle = muted;
    if (k === 'profile') {
      // axis of revolution
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(this.view.cx, 0); ctx.lineTo(this.view.cx, h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('axis', this.view.cx + 4, 12);
    } else {
      // the plane's axes through the origin (graph: the path's start and end)
      const [ox, oy] = this.toScreen(0, 0);
      ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(w, oy); ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.stroke();
      if (k === 'graph') {
        const [ex] = this.toScreen(this.gx, 0);
        ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(ex, 0); ctx.lineTo(ex, h); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillText('start', ox + 4, 12);
        ctx.fillText(`end · ${this.gx.toFixed(1)} cm along the path`, Math.min(ex + 4, w - 190), 24);
        ctx.fillText('lift ↑', ox + 4, oy - 6);
      } else if (this.mode.axes) {
        ctx.fillText(`${this.mode.axes[0]} →`, w - 30, oy - 6);
        ctx.fillText(`${this.mode.axes[1]} ↑`, ox + 4, 12);
      }
    }
    ctx.fillText(stepX === stepY ? `${step} cm grid` : `grid ${stepX} cm along · ${stepY} cm lift`, 6, h - 6);

    const { xy } = sampleCurve(this.pts, 16, { closed: this.closed, clampR: this.mirrored });
    if (k !== 'profile') {
      ctx.beginPath();
      for (let i = 0; i < xy.length; i += 2) {
        const [sx, sy] = this.toScreen(xy[i], xy[i + 1]);
        if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
      }
      if (this.closed) {
        ctx.closePath();
        ctx.fillStyle = accent; ctx.globalAlpha = k === 'section' ? 0.14 : 0.06; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.stroke();
      this.drawPoints(css, accent);
      return;
    }
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
    this.drawPoints(css, accent);
  }

  private drawPoints(css: CSSStyleDeclaration, accent: string) {
    const ctx = this.ctx;
    // control points: circles = smooth, squares = corner
    if (this.mode.kind === 'path' && !this.closed && this.pts.length) {
      const [sx, sy] = this.toScreen(this.pts[0].r, this.pts[0].y);
      ctx.fillStyle = css.getPropertyValue('--muted').trim() || '#777';
      ctx.fillText('start', sx + 10, sy + 16);
    }
    this.pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p.r, p.y);
      ctx.fillStyle = i === this.selected ? accent : (css.getPropertyValue('--surface').trim() || '#fff');
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (smoothOf(p) < 0.5) ctx.rect(sx - 7, sy - 7, 14, 14);
      else ctx.arc(sx, sy, 7.5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
  }
}

function snap(v: number): number {
  return Math.round(v * 20) / 20; // 0.5 mm
}
