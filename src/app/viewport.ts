// three.js viewport: result mesh, ghost of the selected primitive, transform gizmo,
// section plane, and tap picking.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SceneObject } from '../engine/document';
import type { BuildResult } from '../engine/kernel';
import { DEG } from '../engine/math';
import { revolveOutline } from '../engine/primitives';
import { sampleCurve } from '../engine/profile';

export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'off';

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  gizmo: TransformControls;
  private result: THREE.Group = new THREE.Group();
  private ghost: THREE.Group = new THREE.Group();
  private grid: THREE.GridHelper;
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

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
    this.camera.position.set(14, 11, 18);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.addEventListener('change', () => this.invalidate());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5048, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(6, 10, 7);
    this.camera.add(key); // light follows the camera so the form always reads
    this.scene.add(this.camera);
    this.grid = new THREE.GridHelper(40, 40, 0x888888, 0x888888);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.18;
    this.scene.add(this.grid);

    this.front = new THREE.MeshStandardMaterial({ color: 0xc8b6a4, roughness: 0.85, metalness: 0, clippingPlanes: this.clipPlanes });
    this.back = new THREE.MeshBasicMaterial({ color: 0x8c3b2a, side: THREE.BackSide, clippingPlanes: this.clipPlanes });
    this.wire = new THREE.MeshBasicMaterial({ color: 0x222222, wireframe: true, transparent: true, opacity: 0.25, clippingPlanes: this.clipPlanes });
    this.scene.add(this.result);
    this.scene.add(this.ghost);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('local');
    this.gizmo.setSize(1.1);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = !!e.value;
      this.orbit.enabled = !e.value;
      if (!e.value) this.emitGizmo(true);
    });
    this.gizmo.addEventListener('objectChange', () => this.emitGizmo(false));
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.scene.add(this.gizmo.getHelper());

    this.setupTap();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.orbit.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  invalidate() {
    this.needsRender = true;
  }

  setTheme(dark: boolean) {
    this.scene.background = new THREE.Color(dark ? 0x1d1b19 : 0xf3efe9);
    this.invalidate();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
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
      const hits = this.resultMesh ? rc.intersectObject(this.resultMesh, false) : [];
      const hit = hits.find((h) => !this.clipPlanes.length || this.clipPlanes[0].distanceToPoint(h.point) >= 0);
      if (hit && hit.face) this.onTap({ point: hit.point.clone(), normal: hit.face.normal.clone() });
      else this.onTap(null);
    });
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
    this.invalidate();
  }

  bounds(): THREE.Box3 | null {
    if (!this.resultMesh) return null;
    this.resultMesh.geometry.computeBoundingBox();
    return this.resultMesh.geometry.boundingBox!.clone();
  }

  frame(box: THREE.Box3 | null = this.bounds()) {
    if (!box) return;
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
    this.front.needsUpdate = this.back.needsUpdate = this.wire.needsUpdate = true;
    this.invalidate();
  }

  setGhost(obj: SceneObject | null, mode: GizmoMode) {
    this.gizmo.detach();
    for (const c of this.ghost.children) {
      (c as THREE.Mesh).geometry?.dispose();
    }
    this.ghost.clear();
    if (!obj) { this.invalidate(); return; }
    const geo = ghostGeometry(obj);
    const color = obj.mode === 'cut' ? 0xd04040 : obj.mode === 'solid' ? 0x3a7bd5 : 0xff8a1f;
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    fill.renderOrder = edges.renderOrder = 2;
    this.ghost.add(fill, edges);
    this.syncGhost(obj);
    if (mode !== 'off') {
      this.gizmo.attach(this.ghost);
      this.gizmo.setMode(mode);
    }
    this.invalidate();
  }

  syncGhost(obj: SceneObject) {
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

export function ghostGeometry(o: SceneObject): THREE.BufferGeometry {
  const p = o.params;
  switch (o.type) {
    case 'box': return new THREE.BoxGeometry(p.x, p.y, p.z);
    case 'prism': return lathe([0, -p.h! / 2, p.r!, -p.h! / 2, p.r!, p.h! / 2, 0, p.h! / 2], Math.max(3, Math.round(p.n!)), Math.PI / 2);
    case 'torus': {
      const g = new THREE.TorusGeometry(p.R, p.r, 16, 48);
      g.rotateX(Math.PI / 2);
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
