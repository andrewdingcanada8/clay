// The baked field: the SDF view's field written into a 3D texture once per edit (on
// release, in GPU-paced batches of layers), then read back cheaply every frame.
// The field only changes when an edit lands, so orbiting, zooming and sitting still
// shouldn't pay the full layer program per pixel per frame:
//   - moving frames march the texture: one texture read per step;
//   - the settled frame uses it to find where each ray meets the surface (and which
//     rays miss), then runs the exact field only for the last few steps and the
//     normal (raymarch.ts: uStartOn).
// Distances come from the same shader (FRAG with SDF_BAKE), so blends, hollow walls,
// openings, masks and symmetry come along. The clip plane is applied when drawing.
import * as THREE from 'three';
import { FRAG, type FieldSnapshot, type SdfRenderer } from './raymarch';
import { dlog } from './debugLog';

/** Voxels along the box's longest side. */
const RES = 192;
/** A batch of rows is sized to take about this long on the GPU. */
const BATCH_MS = 30;
/** The first batch of a bake, before its pace is known: a few rows of one layer
 *  (a whole layer of a big scene can take longer than a phone lets one frame run). */
const FIRST_ROWS = 8;

const VERT = 'out vec2 vNdc; void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** Marches the baked texture. uMode 0: shade (moving frames); 1: write the distance
 *  along the ray to the surface (or -1: no surface) for the exact settled pass. */
const MARCH = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vNdc;
out vec4 fragColor;
uniform sampler3D uTex;
uniform vec3 uO;      // world position of voxel (0,0,0)'s centre
uniform vec3 uSize;   // world size spanned by the voxel centres
uniform float uH;     // voxel size
uniform mat4 uInvProjView;
uniform mat4 uProjView;
uniform vec4 uClip;
uniform int uClipOn;
uniform vec3 uClay;
uniform vec3 uCap;
uniform int uMode;
uniform float uShift;
uniform float uPixelAngle;
float field(vec3 p) {
  vec3 q = (p - uO) / uSize;
  // outside the baked box: the distance to it (the field there is at least that far)
  vec3 c = clamp(q, 0.0, 1.0);
  float outside = length((q - c) * uSize);
  float d = texture(uTex, (c * (vec3(textureSize(uTex, 0)) - 1.0) + 0.5) / vec3(textureSize(uTex, 0))).r;
  return outside > 0.0 ? max(outside, d) : d;
}
float sdf(vec3 p, out int kind) {
  float d = field(p);
  kind = 0;
  if (uClipOn == 1) { float c = -(dot(p, uClip.xyz) + uClip.w); if (c > d) { d = c; kind = 1; } }
  return d;
}
bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 lo = uO - 0.5 * uH, hi = uO + uSize + 0.5 * uH;
  vec3 inv = 1.0 / rd, a = (lo - ro) * inv, b = (hi - ro) * inv;
  vec3 mn = min(a, b), mx = max(a, b);
  t0 = max(max(mn.x, mn.y), mn.z); t1 = min(min(mx.x, mx.y), mx.z);
  return t1 > max(t0, 0.0);
}
void main() {
  vec4 a = uInvProjView * vec4(vNdc, -1.0, 1.0), b = uInvProjView * vec4(vNdc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w, rd = normalize(b.xyz / b.w - ro);
  float t0, t1;
#ifdef START
  if (!boxHit(ro, rd, t0, t1)) { fragColor = vec4(-1.0, -3.0, 1e5, -1.0); return; } // (tS -3: unknown)
#else
  if (!boxHit(ro, rd, t0, t1)) discard;
#endif
  float t = max(t0, 0.0);
  int kind = 0;
  bool hit = false;
  float d = 1e5, dMin = 1e5, tMin = -1.0, tNear = -1.0;
#ifdef START
  // Mid-drag the field may have moved by up to uShift since the bake (objects only
  // translated): the march first steps by d - uShift, and tS is where that bound first
  // allows a surface; then on to the baked hit as usual.
  float tS = -1.0;
  bool ended = false;
  for (int i = 0; i < 240; i++) {
    if (uShift == 0.0 && i >= 160) break; // (the settled start as it always was)
#else
  for (int i = 0; i < 160; i++) {
#endif
    d = sdf(ro + rd * t, kind);
    float eps = max(0.25 * uH, uPixelAngle * t * 0.5);
#ifdef START
    if (tS < 0.0 && d - uShift < eps) tS = t;
#endif
    if (d < eps) { hit = true; break; }
    // a near approach: a wall thinner than a voxel can stay positive in the texture
    if (tNear < 0.0 && d < 0.5 * uH) tNear = t;
    if (d < dMin) { dMin = d; tMin = t; }
#ifdef START
    t += max((tS < 0.0 ? d - uShift : d) * 0.9, 0.5 * eps);
    if (t > t1) { ended = true; break; }
#else
    t += max(d * 0.9, 0.5 * eps);
    if (t > t1) break;
#endif
  }
#ifdef START
  // (no hit: a near approach starts the exact pass there; else -1, or -2: out of steps,
  // the bake can't say; then its closest approach, where the exact field may still meet it)
  if (!hit) { fragColor = vec4(tNear >= 0.0 ? tNear : (ended ? -1.0 : -2.0), tS, dMin, tMin); return; }
  // the exact pass starts at an earlier, separate near approach (a wall thinner than a
  // voxel can stay positive in the texture; the exact pass decides what is there)
  if (tNear >= 0.0 && t - tNear > 2.0 * uH) { fragColor = vec4(tNear, tS, 0.0, 0.0); return; }
#else
  if (!hit) { if (uMode == 1) { fragColor = vec4(tNear); return; } discard; }
  if (uMode == 1 && tNear >= 0.0 && t - tNear > 2.0 * uH) { fragColor = vec4(tNear); return; }
#endif
  // a little closer: two steps on the interpolated field
  for (int i = 0; i < 2; i++) { t += sdf(ro + rd * t, kind); }
#ifdef START
  fragColor = vec4(t, tS, 0.0, 0.0);
  return;
#endif
  vec3 p = ro + rd * t;
  vec4 clip = uProjView * vec4(p, 1.0);
  gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  int k2;
  vec3 e = vec3(0.7 * uH, 0.0, 0.0);
  vec3 n = normalize(vec3(sdf(p + e.xyy, k2) - sdf(p - e.xyy, k2), sdf(p + e.yxy, k2) - sdf(p - e.yxy, k2), sdf(p + e.yyx, k2) - sdf(p - e.yyx, k2)));
  if (dot(n, rd) > 0.0) n = -n;
  // the same lighting as the exact view (raymarch.ts), occlusion from the texture
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 4; i++) { float h = 0.15 + 0.6 * float(i); occ += (h - field(p + n * h)) * sca; sca *= 0.75; }
  float ao = clamp(1.0 - 0.18 * occ, 0.0, 1.0);
  vec3 base = kind == 1 ? uCap : uClay;
  vec3 key = normalize(-rd + vec3(0.35, 0.65, 0.2));
  float dif = clamp(dot(n, key), 0.0, 1.0), hemi = 0.55 + 0.45 * n.y;
  vec3 col = base * (0.38 + 0.22 * hemi + 0.62 * dif) * (0.55 + 0.45 * ao);
  col += 0.06 * pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  fragColor = vec4(pow(col, vec3(1.0 / 1.15)), 1.0);
}`;

const tri = () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
};

export class FieldBake {
  /** The field version the texture holds (complete), or -1. */
  readyVersion = -1;
  private target: THREE.WebGL3DRenderTarget | null = null;
  private job: { version: number; row: number; batch: number; fence: WebGLSync | null; at: number; t0: number; n: number } | null = null;
  /** Rows of voxels (all layers) baked per ms, learned from the last batches. */
  private rowRate = 0;
  private layerRate = 0; // layers per ms, learned
  private bakeScene = new THREE.Scene();
  private bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bakeMat: THREE.ShaderMaterial;
  readonly marchMat: THREE.ShaderMaterial;
  private startMat: THREE.ShaderMaterial;
  private marchMesh: THREE.Mesh;
  /** Draw the march as the shading pass (0) or the settled pass's start (1). */
  useMarch(mode: 0 | 1, shift = 0) { this.marchMesh.material = mode ? this.startMat : this.marchMat; this.startMat.uniforms.uShift.value = shift; }
  readonly marchScene = new THREE.Scene();
  private origin = new THREE.Vector3();
  private size = new THREE.Vector3();
  private h = 1;
  /** How long the last complete bake took (ms, wall clock) and its voxel count. */
  lastBake = { ms: 0, voxels: 0 };
  /** The fields whose voxels the texture may hold (the last complete bake and any
   *  partial ones since), and whether a bake on its current grid has completed. */
  private snaps: FieldSnapshot[] = [];
  private geomOk = false;
  private dirtyKey = -1;
  private dirtyMemo: ReturnType<SdfRenderer['dirtyBoxes']> = null;

  constructor(private sdf: SdfRenderer) {
    this.bakeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: sdf.material.uniforms,
      defines: { SDF_BAKE: 1 }, depthTest: false, depthWrite: false,
    });
    const m = new THREE.Mesh(tri(), this.bakeMat);
    m.frustumCulled = false;
    this.bakeScene.add(m);
    const su = sdf.material.uniforms;
    this.marchMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: MARCH, depthTest: true, depthWrite: true,
      uniforms: {
        uTex: { value: null }, uO: { value: this.origin }, uSize: { value: this.size }, uH: { value: 1 },
        uInvProjView: su.uInvProjView, uProjView: su.uProjView, uClip: su.uClip, uClipOn: su.uClipOn,
        uClay: su.uClay, uCap: su.uCap, uMode: { value: 0 }, uPixelAngle: su.uPixelAngle,
      },
    });
    // (the start pass: the same march as its own program, so the shading one stays as it was)
    this.startMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: MARCH, depthTest: true, depthWrite: true,
      uniforms: { ...this.marchMat.uniforms, uMode: { value: 1 }, uShift: { value: 0 } }, defines: { START: 1 },
    });
    const mm = new THREE.Mesh(tri(), this.marchMat);
    this.marchMesh = mm;
    mm.frustumCulled = false;
    // the exact renderer's matrices are set in its onBeforeRender: share its camera upkeep
    mm.onBeforeRender = (r, s, c, g, mat, grp) => sdf.mesh.onBeforeRender(r, s, c, g, mat, grp);
    this.marchScene.add(mm);
  }

  get ready() { return this.readyVersion === this.sdf.fieldVersion && !!this.target; }
  get busy() { return !!this.job; }
  get originVec() { return this.origin; }
  /** Voxel size, for the exact pass's starting margin. */
  get voxel() { return this.h; }

  /** Forget the bake (the GPU context it lived in is gone). */
  reset() { this.target?.dispose(); this.target = null; this.job = null; this.readyVersion = -1; this.snaps = []; this.geomOk = false; }

  /**
   * Mid-drag (the field changed since the bake): where the baked texture may be wrong, as
   * world boxes; everywhere else it still holds the field exactly. null: unusable (no
   * complete bake on this grid, or the program's shape changed). Once per field version.
   */
  staleDirty(): ReturnType<SdfRenderer['dirtyBoxes']> {
    if (!this.target || !this.geomOk || !this.snaps.length || this.snaps.length > 3) return null;
    if (this.dirtyKey !== this.sdf.fieldVersion) {
      this.dirtyKey = this.sdf.fieldVersion;
      this.dirtyMemo = this.sdf.dirtyBoxes(this.snaps);
    }
    return this.dirtyMemo;
  }

  /**
   * Advance the bake by one batch of layers if the field changed and is at rest.
   * Each batch waits for the GPU to finish the last one (a fence) and is sized from
   * how long that took. Returns true while there is more to do.
   */
  step(renderer: THREE.WebGLRenderer, now: number): boolean {
    const v = this.sdf.fieldVersion;
    if (this.sdf.interactive || this.sdf.bounds.isEmpty()) { this.job = null; return false; }
    if (this.readyVersion === v && !this.job) return false;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!this.job || this.job.version !== v) {
      if (this.job?.fence) gl.deleteSync(this.job.fence);
      this.start(v, now);
    }
    const j = this.job!;
    if (j.fence) {
      if (gl.clientWaitSync(j.fence, 0, 0) === gl.TIMEOUT_EXPIRED) return true;
      gl.deleteSync(j.fence); j.fence = null;
      const ms = Math.max(1, now - j.at);
      // (to the nearest frame, so it errs slow: smaller batches)
      this.rowRate = j.batch / ms;
      if (j.n < 30 || j.n % 20 === 0) dlog('bake-batch', { n: j.n, rows: j.batch, ms, row: j.row });
    }
    const t = this.target!, total = t.height * t.depth;
    const n = Math.max(1, Math.min(total - j.row, this.rowRate > 0 ? Math.round(this.rowRate * BATCH_MS) : FIRST_ROWS));
    this.drawRows(renderer, j.row, n);
    j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    j.row += n; j.batch = n; j.at = performance.now(); j.n++;
    if (j.row >= total) {
      this.readyVersion = v;
      this.done();
      this.lastBake = { ms: performance.now() - j.t0, voxels: t.width * t.height * t.depth };
      dlog('bake-done', { ms: this.lastBake.ms, batches: j.n, dims: `${t.width}x${t.height}x${t.depth}` });
      this.job = null;
      return false;
    }
    return true;
  }

  get lastBakeMs(): number | null { return this.lastBake?.ms ?? null; }

  /** Bake progress, 0..1 (null: no bake running). */
  get progress(): number | null {
    if (!this.job || !this.target) return null;
    return this.job.row / (this.target.height * this.target.depth);
  }

  /** The whole bake at once, waited on (for the benchmark harness). Returns ms. */
  bakeNow(renderer: THREE.WebGLRenderer): number {
    if (this.ready || this.sdf.bounds.isEmpty()) return 0;
    const t0 = performance.now();
    this.start(this.sdf.fieldVersion, t0);
    this.drawRows(renderer, 0, this.target!.height * this.target!.depth);
    const gl = renderer.getContext(), px = new Float32Array(4);
    renderer.readRenderTargetPixels(this.target! as unknown as THREE.WebGLRenderTarget, 0, 0, 1, 1, px, 0);
    void gl;
    this.readyVersion = this.sdf.fieldVersion;
    this.done();
    this.job = null;
    this.lastBake = { ms: performance.now() - t0, voxels: this.target!.width * this.target!.height * this.target!.depth };
    return this.lastBake.ms;
  }

  private done() {
    this.snaps = this.snaps.slice(-1);
    this.geomOk = true;
    this.dirtyKey = -1;
  }

  private start(version: number, now: number) {
    const b = this.sdf.bounds;
    const ext = b.getSize(new THREE.Vector3());
    const h = Math.max(ext.x, ext.y, ext.z, 1e-3) / RES;
    const pad = 3 * h;
    const nx = Math.max(2, Math.ceil((ext.x + 2 * pad) / h) + 1), ny = Math.max(2, Math.ceil((ext.y + 2 * pad) / h) + 1), nz = Math.max(2, Math.ceil((ext.z + 2 * pad) / h) + 1);
    const ox = b.min.x - pad, oy = b.min.y - pad, oz = b.min.z - pad;
    // a different grid: the old voxels mean nothing on it until this bake completes
    if (h !== this.h || ox !== this.origin.x || oy !== this.origin.y || oz !== this.origin.z || !this.target
      || this.target.width !== nx || this.target.height !== ny || this.target.depth !== nz) { this.geomOk = false; this.snaps = []; }
    this.snaps.push(this.sdf.snapshot());
    this.dirtyKey = -1;
    this.h = h;
    this.origin.set(ox, oy, oz);
    this.size.set((nx - 1) * h, (ny - 1) * h, (nz - 1) * h);
    if (!this.target || this.target.width !== nx || this.target.height !== ny || this.target.depth !== nz) {
      this.target?.dispose();
      this.target = new THREE.WebGL3DRenderTarget(nx, ny, nz, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false });
      const tex = this.target.texture;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    }
    this.marchMat.uniforms.uTex.value = this.target.texture;
    // the exact pass reads it too (occlusion) — its uBakeO / uBakeSize describe the same box
    this.sdf.material.uniforms.uBakeTex.value = this.target.texture;
    this.sdf.material.uniforms.uBakeSize.value.copy(this.size);
    this.marchMat.uniforms.uH.value = h;
    this.job = { version, row: 0, batch: 0, fence: null, at: now, t0: now, n: 0 };
    this.rowRate = 0;
    dlog('bake-start', { dims: `${nx}x${ny}x${nz}`, objects: this.sdf.material.uniforms.uObjCount.value });
  }

  /** Bake rows [r0, r0 + n) of the volume (row r: layer floor(r / height), row r % height). */
  private drawRows(renderer: THREE.WebGLRenderer, r0: number, n: number) {
    const t = this.target!, u = this.sdf.material.uniforms, H = t.height;
    u.uBakeO.value.copy(this.origin);
    u.uBakeH.value = this.h;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    for (let r = r0; r < r0 + n;) {
      const z = Math.floor(r / H), y = r % H, rows = Math.min(H - y, r0 + n - r);
      u.uBakeZ.value = z;
      // a band of rows of this layer only
      t.scissor.set(0, y, t.width, rows);
      t.scissorTest = y > 0 || rows < H;
      renderer.setRenderTarget(t, z);
      renderer.render(this.bakeScene, this.bakeCam);
      r += rows;
    }
    t.scissorTest = false;
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }
}
