// three.js viewport: result mesh, ghost of the selected primitive, transform gizmo,
// section plane, and tap picking.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PartDef, SceneObject } from '../engine/document';
import type { BuildResult } from '../engine/kernel';
import { DEG } from '../engine/math';
import { revolveOutline } from '../engine/primitives';
import { sampleCurve } from '../engine/profile';
import { buildSweepPath, buildSweepSection, sectionRing, sweepMesh } from '../engine/sweep';
import type { CavityGrid } from '../engine/cavity';
import type { SceneDoc } from '../engine/document';
import { cavityDepth } from '../engine/cavity';
import { type CompiledGroup, approxDepth, traceScene } from '../engine/scene';
import type { Vec3 } from '../engine/math';
import { HandReference } from './hand';
import { SdfRenderer } from './raymarch';

export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'off';

/** SDF resolution while the view moves, as fractions of the settled one (starts at 0.5). */
const MOVING_LEVELS = [0.35, 0.5, 0.7, 1];

/** One view for the reference sheet (see Viewport.captureViews). */
export interface CaptureSpec {
  /** from the piece toward the camera */
  dir: THREE.Vector3;
  ortho: boolean;
  size: number;
  passes: ('shade' | 'depth' | 'normal')[];
  fov?: number;
  /** how much of the frame the piece's box fills */
  fill?: number;
}

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  gizmo: TransformControls;
  private result: THREE.Group = new THREE.Group();
  private ghost: THREE.Group = new THREE.Group();
  /** what the ghost's geometry was built from, so a parameter change rebuilds it */
  private ghostShape = '';
  private ghostOutline = true;
  private grid: THREE.GridHelper;
  private hand = new HandReference();
  private showHand = true;
  private clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private clipPlanes: THREE.Plane[] = [];
  private front: THREE.MeshStandardMaterial;
  private back: THREE.MeshBasicMaterial;
  private wire: THREE.MeshBasicMaterial;
  private resultMesh: THREE.Mesh | null = null;
  private dragging = false;
  onGizmoChange: (t: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }, done: boolean) => void = () => {};
  onTap: (hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null) => void = () => {};
  private needsRender = true;
  /** SDF kernel: drawn by raymarching on the GPU. Mesh kernel: triangles. */
  sdf = new SdfRenderer();
  private mode: 'sdf' | 'mesh' = 'sdf';
  private basePixelRatio = Math.min(window.devicePixelRatio, 2);
  private settleTimer = 0;
  /** SDF: resolution while the view moves, as a fraction of the settled one: one of
   *  MOVING_LEVELS, adapted to the frame rate (see adaptMoving). The settled frame is
   *  always full resolution. */
  private movingLevel = 1;
  private moving = false;
  private frameTimes: number[] = [];
  /** this drag: already stepped down once / every frame so far came at full rate */
  private dragStepped = false;
  private dragSmooth = true;
  private dragFrames = 0;

  constructor(private host: HTMLElement) {
    // (no preserveDrawingBuffer: every reader of the canvas reads right after a render,
    // and keeping the buffer costs a full-frame copy of GPU memory, which phones run out of)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.watchContext();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.position.set(38, 30, 50);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.addEventListener('change', () => this.invalidate());
    // Raymarching costs per pixel: render at reduced resolution while moving,
    // then one full-resolution frame once the view settles.
    this.orbit.addEventListener('start', () => this.interacting(true));
    this.orbit.addEventListener('end', () => this.interacting(false));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5048, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(6, 10, 7);
    this.camera.add(key); // light follows the camera so the form always reads
    this.scene.add(this.camera);
    this.grid = new THREE.GridHelper(200, 40, 0x888888, 0x888888); // 5 cm squares
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.18;
    this.scene.add(this.grid);
    this.scene.add(this.hand.object);

    this.front = new THREE.MeshStandardMaterial({ color: 0xc8b6a4, roughness: 0.85, metalness: 0, clippingPlanes: this.clipPlanes });
    this.back = new THREE.MeshBasicMaterial({ color: 0x8c3b2a, side: THREE.BackSide, clippingPlanes: this.clipPlanes });
    this.wire = new THREE.MeshBasicMaterial({ color: 0x222222, wireframe: true, transparent: true, opacity: 0.25, clippingPlanes: this.clipPlanes });
    this.scene.add(this.result);
    this.scene.add(this.sdf.mesh);
    this.scene.add(this.ghost);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('local');
    this.gizmo.setSize(1.1);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = !!e.value;
      this.interacting(!!e.value);
      this.orbit.enabled = !e.value;
      if (!e.value) this.emitGizmo(true);
    });
    this.gizmo.addEventListener('objectChange', () => this.emitGizmo(false));
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.scene.add(this.gizmo.getHelper());

    this.setupTap();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      if (this.orbit.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
        if (this.moving && this.mode === 'sdf') this.adaptMoving(now);
      }
    };
    requestAnimationFrame(loop);
  }

  /** Called when the GPU context is lost (the phone's graphics reset) and when it comes back. */
  onContextLost: () => void = () => {};
  onContextRestored: () => void = () => {};
  contextLost = false;
  private gpuName = '';
  private loseExt: WEBGL_lose_context | null = null;

  private watchContext() {
    const canvas = this.renderer.domElement;
    try {
      const gl = this.renderer.getContext();
      // (fetched while the context is alive: a lost context hands out no extensions)
      this.loseExt = gl.getExtension('WEBGL_lose_context');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpuName = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch { /* no info */ }
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // (lets the browser restore it)
      this.contextLost = true;
      this.onContextLost();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      // three.js re-creates its GPU state; make sure every texture goes up again
      this.sdf.reupload();
      this.resize();
      this.invalidate();
      this.onContextRestored();
    });
  }

  /**
   * Replace a dead renderer with a new one on a fresh canvas, in place: the camera,
   * controls, gizmo, taps, scene and every texture carry over (a new renderer uploads
   * them again). For a context the browser won't hand back. False if the device
   * won't create a new GPU context either.
   */
  recreateRenderer(): boolean {
    const old = this.renderer;
    let r: THREE.WebGLRenderer;
    try {
      r = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      if (r.getContext().isContextLost()) { r.dispose(); return false; }
    } catch {
      return false;
    }
    r.setPixelRatio(old.getPixelRatio());
    r.localClippingEnabled = true;
    this.host.insertBefore(r.domElement, old.domElement);
    old.domElement.remove();
    try { old.dispose(); } catch { /* already gone */ }
    this.renderer = r;
    this.orbit.disconnect(); this.orbit.connect(r.domElement);
    this.gizmo.disconnect(); this.gizmo.connect(r.domElement);
    this.setupTap();
    this.watchContext();
    this.contextLost = false;
    this.sdf.reupload();
    this.resize();
    this.invalidate();
    return true;
  }

  /** Ask the browser for the lost context back (true if it was asked). */
  restoreContext(): boolean {
    try { this.loseExt?.restoreContext(); return !!this.loseExt; } catch { return false; }
  }

  /** What the GPU was doing, for a crash report. */
  gpuReport() {
    const f = this.frameTimes;
    const c = this.renderer.domElement;
    return {
      gpu: this.gpuName, mode: this.mode, moving: this.moving, dragging: this.dragging,
      pixelRatio: +this.renderer.getPixelRatio().toFixed(2), canvas: [c.width, c.height],
      frameMs: f.length > 1 ? +((f[f.length - 1] - f[0]) / (f.length - 1)).toFixed(1) : null,
      dpr: window.devicePixelRatio, ua: navigator.userAgent,
    };
  }

  /**
   * While moving, judged on the interval between frames: frames slower than ~28 ms
   * over a dozen frames step the resolution down one level (at most once per drag).
   * Faster can't be told apart from a frame rate capped by the screen, so a level is
   * only won back at the start of the next drag, after a whole drag ran at full rate.
   * Changing the size mid-drag redraws at once (see resize), so it never flashes.
   */
  private adaptMoving(now: number) {
    const f = this.frameTimes;
    f.push(now);
    if (f.length > 13) f.shift();
    if (f.length < 13) return;
    const dt = (f[12] - f[0]) / 12;
    this.dragFrames++;
    if (dt > 20) this.dragSmooth = false;
    if (dt > 28 && !this.dragStepped && this.movingLevel > 0) {
      this.dragStepped = true;
      this.movingLevel--;
      f.length = 0;
      this.renderer.setPixelRatio(this.movingRatio());
      this.resize();
    }
  }

  private movingRatio() {
    return Math.max(0.35, this.basePixelRatio * MOVING_LEVELS[this.movingLevel]);
  }

  invalidate() {
    this.needsRender = true;
  }

  /** Portrait (3:4) JPEG thumbnail, framed on the piece (without the gizmo and
   *  ghost); the camera goes back to where it was afterwards. */
  snapshot(w = 240, h = 320): string {
    const saved = this.cameraState();
    const hidden = [this.gizmo.getHelper(), this.ghost].filter((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const src = this.renderer.domElement;
    const cw = Math.min(src.width, (src.height * w) / h), ch = (cw * h) / w;
    // Fit the piece's box corners (not its bounding sphere, which leaves it small)
    // to ~88% of the crop, keeping the current view direction.
    const box = this.bounds();
    if (box) {
      const c = box.getCenter(new THREE.Vector3());
      const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
      const fx = cw / src.width, fy = ch / src.height, fill = 0.88;
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
      const fits = (d: number) => {
        this.camera.position.copy(c).addScaledVector(dir, d);
        this.camera.lookAt(c);
        this.camera.updateMatrixWorld();
        return corners.every((p) => {
          const q = p.clone().project(this.camera);
          return q.z < 1 && Math.abs(q.x) <= fill * fx && Math.abs(q.y) <= fill * fy;
        });
      };
      let lo = 0.1, hi = box.getSize(new THREE.Vector3()).length() * 20 + 1;
      for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
      this.orbit.target.copy(c);
      this.camera.position.copy(c).addScaledVector(dir, hi);
      this.orbit.update();
    }
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d')!.drawImage(src, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, w, h);
    for (const o of hidden) o.visible = true;
    this.setCameraState(saved);
    return out.toDataURL('image/jpeg', 0.78);
  }

  /**
   * Views of the piece for the reference sheet: each from direction `dir` (from the
   * piece toward the camera), framed on it, square, `size` pixels, in each pass
   * asked for: shaded on a plain light ground, depth (near white, the piece's own
   * depth range, black ground), view-space normals (black ground). Helpers, the
   * section cut and the ghost are left out; everything is put back afterwards.
   */
  captureViews(specs: CaptureSpec[]): Record<string, HTMLCanvasElement>[] | null {
    const box = this.bounds();
    if (!box) return null;
    const c = box.getCenter(new THREE.Vector3());
    const R = Math.max(0.01, box.getSize(new THREE.Vector3()).length() / 2);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    // put aside: helpers, section, background, resolution
    const hidden = [this.gizmo.getHelper(), this.ghost, this.grid, this.hand.object].filter((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const clips = [...this.clipPlanes];
    this.clipPlanes.length = 0;
    this.sdf.setClip(null);
    this.front.needsUpdate = this.back.needsUpdate = this.wire.needsUpdate = true;
    const bg = this.scene.background;
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    const depthMat = new THREE.ShaderMaterial({
      uniforms: { uNear: { value: 0 }, uFar: { value: 1 } },
      vertexShader: 'varying float vZ; void main(){ vec4 v = modelViewMatrix * vec4(position, 1.0); vZ = -v.z; gl_Position = projectionMatrix * v; }',
      fragmentShader: 'uniform float uNear, uFar; varying float vZ; void main(){ float v = 1.0 - clamp((vZ - uNear) / max(uFar - uNear, 1e-4), 0.0, 1.0); gl_FragColor = vec4(vec3(0.06 + 0.94 * v), 1.0); }',
      side: THREE.DoubleSide,
    });
    const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    const out: Record<string, HTMLCanvasElement>[] = [];
    try {
      for (const spec of specs) {
        this.renderer.setSize(spec.size, spec.size, false);
        const dir = spec.dir.clone().normalize();
        const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, -Math.sign(dir.y)) : new THREE.Vector3(0, 1, 0);
        const fill = spec.fill ?? 0.86;
        let cam: THREE.PerspectiveCamera | THREE.OrthographicCamera;
        let dist: number;
        if (spec.ortho) {
          dist = R * 4 + 1;
          const o = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, dist + R * 2 + 1);
          o.up.copy(up);
          o.position.copy(c).addScaledVector(dir, dist);
          o.lookAt(c);
          o.updateMatrixWorld();
          let half = 0;
          for (const p of corners) { const q = p.clone().applyMatrix4(o.matrixWorldInverse); half = Math.max(half, Math.abs(q.x), Math.abs(q.y)); }
          half = Math.max(half, 0.01) / fill;
          Object.assign(o, { left: -half, right: half, top: half, bottom: -half });
          o.updateProjectionMatrix();
          cam = o;
        } else {
          const p = new THREE.PerspectiveCamera(spec.fov ?? 30, 1, 0.01, 5000);
          p.up.copy(up);
          const fits = (d: number) => {
            p.position.copy(c).addScaledVector(dir, d);
            p.lookAt(c);
            p.updateMatrixWorld();
            return corners.every((q) => { const v = q.clone().project(p); return v.z < 1 && Math.abs(v.x) <= fill && Math.abs(v.y) <= fill; });
          };
          let lo = 0.01, hi = R * 40 + 1;
          for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
          fits(hi);
          p.near = Math.max(0.01, hi - R * 2);
          p.far = hi + R * 2;
          p.updateProjectionMatrix();
          dist = hi;
          cam = p;
        }
        // the key light follows whichever camera draws (mesh kernel)
        const key = new THREE.DirectionalLight(0xffffff, 1.7);
        key.position.set(6, 10, 7);
        cam.add(key);
        this.scene.add(cam);
        // depth range: the piece's box along the view (tighter than its bounding sphere)
        const camPos = cam.position, view = dir.clone().negate();
        let near = Infinity, far = -Infinity;
        for (const q of corners) { const z = q.clone().sub(camPos).dot(view); near = Math.min(near, z); far = Math.max(far, z); }
        if (!(far > near)) { near = dist - R; far = dist + R; }
        const shots: Record<string, HTMLCanvasElement> = {};
        for (const pass of spec.passes) {
          this.scene.background = new THREE.Color(pass === 'shade' ? 0xf1eee9 : 0x000000);
          if (this.mode === 'sdf') {
            this.sdf.setPass(pass === 'depth' ? 1 : pass === 'normal' ? 2 : 0, cam, near, far);
            this.scene.overrideMaterial = null;
          } else {
            depthMat.uniforms.uNear.value = near; depthMat.uniforms.uFar.value = far;
            this.scene.overrideMaterial = pass === 'depth' ? depthMat : pass === 'normal' ? normalMat : null;
          }
          this.renderer.render(this.scene, cam);
          const cv = document.createElement('canvas');
          cv.width = cv.height = spec.size;
          cv.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0, spec.size, spec.size, 0, 0, spec.size, spec.size);
          shots[pass] = cv;
        }
        this.scene.remove(cam);
        out.push(shots);
      }
    } finally {
      this.sdf.setPass(0);
      this.scene.overrideMaterial = null;
      depthMat.dispose(); normalMat.dispose();
      this.scene.background = bg;
      for (const o of hidden) o.visible = true;
      this.clipPlanes.push(...clips);
      this.sdf.setClip(clips.length ? this.clip : null);
      this.front.needsUpdate = this.back.needsUpdate = this.wire.needsUpdate = true;
      this.renderer.setPixelRatio(ratio);
      this.resize();
    }
    return out;
  }

  /** Frame-time benchmark: orbit once around the piece, rendering `frames` frames
   *  (each waited on with a 1-pixel read), at the moving or the settled resolution.
   *  Returns per-frame milliseconds. */
  benchOrbit(frames = 24, moving = false): number[] & { w?: number; h?: number } {
    const saved = this.cameraState(), ratio = this.renderer.getPixelRatio();
    const gizmo = this.gizmo.getHelper(), gizmoOn = gizmo.visible;
    gizmo.visible = false;
    if (moving && this.mode === 'sdf') { this.renderer.setPixelRatio(this.movingRatio()); this.resize(); }
    else { this.renderer.setPixelRatio(this.basePixelRatio); this.resize(); }
    const gl = this.renderer.getContext(), px = new Uint8Array(4);
    const c = this.orbit.target.clone(), off = this.camera.position.clone().sub(c);
    const r = Math.hypot(off.x, off.z), a0 = Math.atan2(off.z, off.x);
    const out: number[] & { w?: number; h?: number } = [];
    out.w = gl.drawingBufferWidth; out.h = gl.drawingBufferHeight;
    this.renderer.render(this.scene, this.camera); // warm-up
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 0; i < frames; i++) {
      const a = a0 + (2 * Math.PI * i) / frames;
      this.camera.position.set(c.x + r * Math.cos(a), c.y + off.y, c.z + r * Math.sin(a));
      this.camera.lookAt(c);
      const t0 = performance.now();
      this.renderer.render(this.scene, this.camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push(performance.now() - t0);
    }
    gizmo.visible = gizmoOn;
    this.renderer.setPixelRatio(ratio); this.resize();
    this.setCameraState(saved);
    return out;
  }

  /** Cost view (SDF): mean map() calls and object SDF evaluations per pixel over
   *  `views` camera angles, counted in the shader, so independent of the GPU. */
  benchCost(views = 4): { map: number; obj: number; warp: number } {
    const saved = this.cameraState();
    const hide = [this.gizmo.getHelper(), this.ghost, this.grid, this.hand.object, this.result].filter((o) => o.visible);
    for (const o of hide) o.visible = false;
    const bg = this.scene.background;
    this.scene.background = new THREE.Color(0x000000);
    const clear = this.renderer.getClearColor(new THREE.Color()), clearA = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 1);
    this.sdf.setStyle({ cost: true });
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    const c = this.orbit.target.clone(), off = this.camera.position.clone().sub(c);
    const r = Math.hypot(off.x, off.z), a0 = Math.atan2(off.z, off.x);
    let map = 0, obj = 0, warp = 0;
    for (let i = 0; i < views; i++) {
      const a = a0 + (2 * Math.PI * i) / views;
      this.camera.position.set(c.x + r * Math.cos(a), c.y + off.y, c.z + r * Math.sin(a));
      this.camera.lookAt(c);
      this.renderer.render(this.scene, this.camera);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let k = 0; k < px.length; k += 4) { map += px[k]; obj += px[k + 1] * 256 + px[k + 2]; }
      // GPUs run pixels in lockstep groups that cost as much as their slowest pixel:
      // mean over 8x4 tiles of the tile's largest map() count, per pixel
      for (let ty = 0; ty + 4 <= h; ty += 4) for (let tx = 0; tx + 8 <= w; tx += 8) {
        let m = 0;
        for (let y = ty; y < ty + 4; y++) for (let x = tx; x < tx + 8; x++) m = Math.max(m, px[(y * w + x) * 4]);
        warp += m * 32;
      }
    }
    this.sdf.setStyle({ cost: false });
    this.renderer.setClearColor(clear, clearA);
    this.scene.background = bg;
    for (const o of hide) o.visible = true;
    this.setCameraState(saved);
    const n = views * w * h;
    return { map: map / n, obj: obj / n, warp: warp / n };
  }

  cameraState(): { pos: [number, number, number]; target: [number, number, number] } {
    return { pos: this.camera.position.toArray() as [number, number, number], target: this.orbit.target.toArray() as [number, number, number] };
  }

  setCameraState(s: { pos: [number, number, number]; target: [number, number, number] }) {
    this.camera.position.fromArray(s.pos);
    this.orbit.target.fromArray(s.target);
    this.orbit.update();
    this.invalidate();
  }

  /** Lower the render resolution during camera moves and drags (SDF mode). */
  interacting(on: boolean) {
    clearTimeout(this.settleTimer);
    const apply = (ratio: number) => {
      if (Math.abs(this.renderer.getPixelRatio() - ratio) < 1e-3) return;
      this.renderer.setPixelRatio(ratio);
      this.resize();
    };
    if (on && !this.moving) {
      // a whole smooth drag before this one: try a level finer
      if (this.dragSmooth && !this.dragStepped && this.dragFrames > 30 && this.movingLevel < MOVING_LEVELS.length - 1) this.movingLevel++;
      this.dragStepped = false;
      this.dragSmooth = true;
      this.dragFrames = 0;
    }
    this.moving = on;
    this.frameTimes.length = 0;
    if (on && this.mode === 'sdf') apply(this.movingRatio());
    else this.settleTimer = window.setTimeout(() => apply(this.basePixelRatio), on ? 0 : 180);
  }

  setMode(mode: 'sdf' | 'mesh') {
    this.mode = mode;
    this.result.visible = mode === 'mesh';
    this.sdf.mesh.visible = mode === 'sdf' && !this.sdf.bounds.isEmpty();
    this.invalidate();
  }

  /** SDF kernel: show the document directly (no build needed for the outer form). */
  /** `interactive`: mid-drag, slow profile tables wait for release (see SdfRenderer.setDoc). */
  setSdfDoc(doc: SceneDoc, interactive = false) {
    this.sdf.setDoc(doc, interactive);
    this.sdf.mesh.visible = this.mode === 'sdf' && !this.sdf.bounds.isEmpty();
    if (this.mode === 'sdf') this.placeGround();
    this.invalidate();
  }

  setSdfGrids(grids: (CavityGrid | null)[]) {
    this.sdf.setGrids(grids);
    this.invalidate();
  }

  private placeGround() {
    const box = this.bounds();
    if (!box) { this.hand.object.visible = false; return; }
    this.grid.position.y = box.min.y - 0.01;
    this.hand.place(box);
    this.hand.object.visible = this.showHand;
  }

  /** CPU sphere tracing of the same field the GPU draws (for taps). */
  private sdfPick(ro: THREE.Vector3, rd: THREE.Vector3): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const groups = this.sdf.compiledGroups();
    const grids = this.sdf.grids();
    const depth = (g: CompiledGroup, x: number, y: number, z: number) => {
      const c = grids[g.index];
      return c ? cavityDepth(c, g, x, y, z) : approxDepth(g, x, y, z);
    };
    const box = this.sdf.bounds.clone().expandByScalar(0.5);
    const ray = new THREE.Ray(ro, rd);
    const enter = ray.intersectBox(box, new THREE.Vector3());
    if (!enter) return null;
    const t0 = box.containsPoint(ro) ? 0 : enter.distanceTo(ro);
    const clip = this.clipPlanes[0];
    const hit = traceScene(groups, depth, ro.toArray() as Vec3, rd.toArray() as Vec3, t0, t0 + box.getSize(new THREE.Vector3()).length() + 1,
      clip ? { n: clip.normal.toArray() as Vec3, c: clip.constant } : undefined);
    return hit ? { point: new THREE.Vector3(...hit.p), normal: new THREE.Vector3(...hit.n) } : null;
  }

  setTheme(dark: boolean) {
    this.scene.background = new THREE.Color(dark ? 0x1d1b19 : 0xf3efe9);
    this.hand.setDark(dark);
    this.setTheme2(dark);
    this.invalidate();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    // resizing clears the canvas: draw again now, or a blank frame shows
    this.renderer.render(this.scene, this.camera);
    this.invalidate();
  }

  private emitGizmo(done: boolean) {
    const o = this.ghost;
    this.onGizmoChange({
      position: [round(o.position.x), round(o.position.y), round(o.position.z)],
      rotation: [round(o.rotation.x / DEG, 1), round(o.rotation.y / DEG, 1), round(o.rotation.z / DEG, 1)],
      scale: [round(o.scale.x, 3), round(o.scale.y, 3), round(o.scale.z, 3)],
    }, done);
  }

  isDragging() {
    return this.dragging;
  }

  private setupTap() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || this.dragging) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (moved > 8 || dt > 500) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, this.camera);
      if (this.mode === 'sdf') { this.onTap(this.sdfPick(rc.ray.origin.clone(), rc.ray.direction.clone())); return; }
      const hits = this.resultMesh ? rc.intersectObject(this.resultMesh, false) : [];
      const hit = hits.find((h) => !this.clipPlanes.length || this.clipPlanes[0].distanceToPoint(h.point) >= 0);
      if (hit && hit.face) this.onTap({ point: hit.point.clone(), normal: hit.face.normal.clone() });
      else this.onTap(null);
    });
  }

  setTheme2(dark: boolean) {
    this.sdf.setStyle({ clay: dark ? 0xb9a593 : 0xc8b6a4 });
  }

  setResult(r: BuildResult, wireframe: boolean) {
    for (const c of this.result.children) (c as THREE.Mesh).geometry?.dispose();
    this.result.clear();
    this.resultMesh = null;
    if (!r.indices.length) { this.invalidate(); return; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
    const shaded = toCreasedNormals(geo, 32 * DEG);
    const m = new THREE.Mesh(shaded, this.front);
    this.resultMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.result.add(m, new THREE.Mesh(shaded, this.back));
    if (wireframe) this.result.add(new THREE.Mesh(geo, this.wire));
    geo.computeBoundingBox();
    this.grid.position.y = geo.boundingBox!.min.y - 0.01;
    this.hand.place(geo.boundingBox!);
    this.hand.object.visible = this.showHand;
    this.invalidate();
  }

  bounds(): THREE.Box3 | null {
    if (this.mode === 'sdf') return this.sdf.bounds.isEmpty() ? null : this.sdf.bounds.clone();
    if (!this.resultMesh) return null;
    this.resultMesh.geometry.computeBoundingBox();
    return this.resultMesh.geometry.boundingBox!.clone();
  }

  setHandVisible(on: boolean) {
    this.showHand = on;
    this.hand.object.visible = on && !!this.bounds();
    this.invalidate();
  }

  frame(box: THREE.Box3 | null = this.bounds()) {
    if (!box) return;
    if (this.showHand) box = box.clone().union(this.hand.bounds());
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    const fov = this.camera.fov * DEG;
    const dist = r / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2) * 1.05;
    this.orbit.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.invalidate();
  }

  setSection(on: boolean, axis: 'x' | 'y' | 'z', t: number) {
    this.clipPlanes.length = 0;
    if (on) {
      const box = this.bounds();
      const n = axis === 'x' ? new THREE.Vector3(-1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, -1);
      const lo = box ? box.min[axis] : -10, hi = box ? box.max[axis] : 10;
      this.clip.set(n, lo + (hi - lo) * t);
      this.clipPlanes.push(this.clip);
    }
    this.sdf.setClip(on ? this.clip : null);
    this.front.needsUpdate = this.back.needsUpdate = this.wire.needsUpdate = true;
    this.invalidate();
  }

  /** Definitions for drawing placed parts' ghosts (the document's parts). */
  partDefs: PartDef[] = [];

  setGhost(obj: SceneObject | null, mode: GizmoMode) {
    this.gizmo.detach();
    for (const c of this.ghost.children) {
      (c as THREE.Mesh).geometry?.dispose();
    }
    this.ghost.clear();
    this.ghostShape = '';
    if (!obj) { this.invalidate(); return; }
    this.buildGhost(obj);
    this.syncGhost(obj);
    if (mode !== 'off') {
      this.gizmo.attach(this.ghost);
      this.gizmo.setMode(mode);
    }
    this.invalidate();
  }

  private buildGhost(obj: SceneObject) {
    for (const c of this.ghost.children) (c as THREE.Mesh).geometry?.dispose();
    this.ghost.clear();
    const geo = ghostGeometry(obj, this.partDefs);
    const color = obj.mode === 'mask' ? 0x1f8f86 : obj.mode === 'subtract' ? 0xd04040 : obj.mode === 'cutout' ? 0x9b3fb5 : obj.mode === 'solid' ? 0x3a7bd5 : 0xff8a1f;
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    fill.renderOrder = edges.renderOrder = 2;
    fill.visible = edges.visible = this.ghostOutline;
    this.ghost.add(fill, edges);
    this.ghostShape = this.shapeKey(obj);
  }

  private shapeKey(obj: SceneObject): string {
    const def = obj.type === 'part' ? this.partDefs.find((d) => d.id === obj.params.part) : null;
    return obj.type + obj.mode + JSON.stringify(obj.params) + (def ? JSON.stringify(def.objects) : '');
  }

  /** Show or hide the ghost's outline; the ghost itself stays as the gizmo's handle. */
  setGhostOutline(on: boolean) {
    if (on === this.ghostOutline) return;
    this.ghostOutline = on;
    for (const c of this.ghost.children) c.visible = on;
    this.invalidate();
  }

  syncGhost(obj: SceneObject) {
    if (this.ghostShape && this.ghostShape !== this.shapeKey(obj)) this.buildGhost(obj);
    const t = obj.transform;
    this.ghost.position.set(...t.position);
    this.ghost.rotation.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ');
    this.ghost.scale.set(...t.scale);
    this.invalidate();
  }
}

function round(x: number, dp = 3) {
  const k = 10 ** dp;
  return Math.round(x * k) / k;
}

function lathe(outline: number[], segs: number, phi = 0): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < outline.length; i += 2) pts.push(new THREE.Vector2(Math.max(0, outline[i]), outline[i + 1]));
  return new THREE.LatheGeometry(pts, segs, phi);
}

export function ghostGeometry(o: SceneObject, parts: PartDef[] = []): THREE.BufferGeometry {
  const p = o.params;
  switch (o.type) {
    case 'part': {
      // the outlines of the part's own objects, in part space
      const def = parts.find((d) => d.id === p.part) ?? parts.flatMap((d) => d.parts ?? []).find((d) => d.id === p.part);
      const chunks: Float32Array[] = [];
      for (const inner of def?.objects ?? []) {
        if (inner.hidden) continue;
        const g = ghostGeometry(inner, [...parts, ...(def?.parts ?? [])]);
        const flat = g.index ? g.toNonIndexed() : g;
        const t = inner.transform;
        flat.applyMatrix4(new THREE.Matrix4().compose(
          new THREE.Vector3(...t.position),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ')),
          new THREE.Vector3(...t.scale)));
        chunks.push(flat.getAttribute('position').array as Float32Array);
        g.dispose();
      }
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
      return geo;
    }
    case 'box': return new THREE.BoxGeometry(p.x, p.y, p.z);
    case 'prism': return lathe([0, -p.h! / 2, p.r!, -p.h! / 2, p.r2 ?? p.r!, p.h! / 2, 0, p.h! / 2], Math.max(3, Math.round(p.n!)), Math.PI / 2);
    case 'torus': {
      const g = new THREE.TorusGeometry(p.R, p.r, 16, 48);
      g.rotateX(Math.PI / 2);
      return g;
    }
    case 'sweep': {
      const path = buildSweepPath(p), sec = buildSweepSection(p);
      const m = sweepMesh(path, sectionRing(sec, 24));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      return g;
    }
    case 'revolve': {
      const { xy } = sampleCurve(p.points ?? [], 8);
      const out = [0, xy[1], ...xy, 0, xy[xy.length - 1]];
      return lathe(out, 48);
    }
    default: return lathe(revolveOutline(o.type, p, 24)!, 40);
  }
}
