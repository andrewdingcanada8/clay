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
import { FRAG, type SdfRenderer } from './raymarch';
import { dlog } from './debugLog';
import { drawRows, BRICK_B, BRICK_N, BRICK_SHARP, BRICK_THR, BrickLevel, CLASSIFY, SETTLED } from './bricks';

/** Voxels along the box's longest side. */
const RES = 192;
/** A batch of layers is sized to take about this long on the GPU. */
const BATCH_MS = 30;
/** The first batch, before the pace is known: this many rows of voxels. */
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
  if (!boxHit(ro, rd, t0, t1)) { if (uMode == 1) { fragColor = vec4(-1.0); return; } discard; }
  float t = max(t0, 0.0);
  int kind = 0;
  bool hit = false;
  float d = 1e5;
  for (int i = 0; i < 160; i++) {
    d = sdf(ro + rd * t, kind);
    float eps = max(0.25 * uH, uPixelAngle * t * 0.5);
    if (d < eps) { hit = true; break; }
    t += max(d * 0.9, 0.5 * eps);
    if (t > t1) break;
  }
  if (!hit) { if (uMode == 1) { fragColor = vec4(-1.0); return; } discard; }
  // a little closer: two steps on the interpolated field
  for (int i = 0; i < 2; i++) { t += sdf(ro + rd * t, kind); }
  if (uMode == 1) { fragColor = vec4(t); return; }
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
  private job: { version: number; row: number; batch: number; fence: WebGLSync | null; at: number; t0: number; n: number; phase: number; tb: number; level: number } | null = null;
  /** Texels baked per ms, learned from the last batches. */
  private texRate = 0;
  private layerRate = 0; // layers per ms, learned
  private bakeScene = new THREE.Scene();
  private bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bakeMat: THREE.ShaderMaterial;
  readonly marchMat: THREE.ShaderMaterial;
  readonly marchScene = new THREE.Scene();
  private origin = new THREE.Vector3();
  private size = new THREE.Vector3();
  private h = 1;
  /** How long the last complete bake took (ms, wall clock) and its voxel count. */
  lastBake = { ms: 0, voxels: 0, bricks: [0, 0], samples: 0, brickMs: 0, classifyMs: 0 };
  // ---- fine bricks (bricks.ts)
  /** The field version the bricks hold (complete), or -1. */
  brickVersion = -1;
  private ind: THREE.Data3DTexture | null = null;
  private levels: BrickLevel[];
  private classMat: THREE.ShaderMaterial;
  private classScene = new THREE.Scene();
  private classRT: THREE.WebGLRenderTarget | null = null;
  readonly settledMat: THREE.ShaderMaterial;
  readonly settledScene = new THREE.Scene();
  private cells = new Int32Array(3);

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
    const mm = new THREE.Mesh(tri(), this.marchMat);
    mm.frustumCulled = false;
    // the exact renderer's matrices are set in its onBeforeRender: share its camera upkeep
    mm.onBeforeRender = (r, s, c, g, mat, grp) => sdf.mesh.onBeforeRender(r, s, c, g, mat, grp);
    this.marchScene.add(mm);
    this.levels = BRICK_N.map((n) => new BrickLevel(n, FRAG, sdf.material.uniforms));
    this.classMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: CLASSIFY, depthTest: false, depthWrite: false,
      uniforms: { uTex: { value: null }, uCy: { value: 1 }, uRows: { value: 1 }, uThr: { value: 1 }, uSharp: { value: 1 } },
    });
    const cm = new THREE.Mesh(tri(), this.classMat);
    cm.frustumCulled = false;
    this.classScene.add(cm);
    this.settledMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: SETTLED, depthTest: true, depthWrite: true,
      uniforms: {
        uTex: { value: null }, uInd: { value: null }, uAtlas0: { value: null }, uAtlas1: { value: null },
        uO: { value: this.origin }, uSize: { value: this.size }, uH: { value: 1 },
        uCells: { value: this.cells }, uSlots0: { value: this.levels[0].slots }, uSlots1: { value: this.levels[1].slots },
        uInvProjView: su.uInvProjView, uProjView: su.uProjView, uClip: su.uClip, uClipOn: su.uClipOn,
        uClay: su.uClay, uCap: su.uCap, uPixelAngle: su.uPixelAngle, uPixelSize: su.uPixelSize, uFlat: su.uFlat,
      },
    });
    const sm = new THREE.Mesh(tri(), this.settledMat);
    sm.frustumCulled = false;
    sm.onBeforeRender = (r, s, c, g, mat, grp) => sdf.mesh.onBeforeRender(r, s, c, g, mat, grp);
    this.settledScene.add(sm);
  }

  /** The bricks match the field (the settled frame can come from them). */
  get bricksReady() { return this.brickVersion === this.sdf.fieldVersion && this.ready; }

  get ready() { return this.readyVersion === this.sdf.fieldVersion && !!this.target; }
  get busy() { return !!this.job; }
  get originVec() { return this.origin; }
  /** Voxel size, for the exact pass's starting margin. */
  get voxel() { return this.h; }

  /** Forget the bake (the GPU context it lived in is gone). */
  reset() { this.target?.dispose(); this.target = null; this.job = null; this.readyVersion = -1; this.brickVersion = -1; for (const l of this.levels) l.dispose(); this.classRT?.dispose(); this.classRT = null; }

  /**
   * Advance the bake by one batch of layers if the field changed and is at rest.
   * Each batch waits for the GPU to finish the last one (a fence) and is sized from
   * how long that took. Returns true while there is more to do.
   */
  step(renderer: THREE.WebGLRenderer, now: number): boolean {
    const v = this.sdf.fieldVersion;
    if (this.sdf.interactive || this.sdf.bounds.isEmpty()) { this.job = null; return false; }
    if (this.readyVersion === v && this.brickVersion === v && !this.job) return false;
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
      if (j.batch > 0) this.texRate = j.batch / ms;
      if (j.n < 30 || j.n % 20 === 0) dlog('bake-batch', { n: j.n, texels: j.batch, ms, phase: j.phase, row: j.row });
    }
    const t = this.target!;
    // one paced batch of rows of the current target (rows of texels across all its layers)
    const batch = (target: THREE.WebGL3DRenderTarget, draw: (r0: number, n: number) => void) => {
      const total = target.height * target.depth;
      const n = Math.max(1, Math.min(total - j.row, this.texRate > 0 ? Math.round(this.texRate * BATCH_MS / target.width) : Math.ceil(FIRST_ROWS * t.width / target.width)));
      draw(j.row, n);
      j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      j.row += n; j.batch = n * target.width; j.at = performance.now(); j.n++;
      return j.row >= total;
    };
    if (j.phase === 0) {
      if (batch(t, (r0, n) => this.drawRows(renderer, r0, n))) {
        this.readyVersion = v;
        this.lastBake.ms = performance.now() - j.t0;
        this.lastBake.voxels = t.width * t.height * t.depth;
        dlog('bake-done', { ms: this.lastBake.ms, batches: j.n, dims: `${t.width}x${t.height}x${t.depth}` });
        // next: find the band cells (a readback, once the GPU is done), then bake their bricks
        j.phase = 1; j.row = 0; j.tb = performance.now();
      }
      return true;
    }
    if (j.phase === 1) { this.classify(renderer); j.phase = 2; j.row = 0; j.level = 0; j.batch = 0; return true; }
    // 2: each level's brick samples (the exact field); 3: each level's atlas from them (copies)
    while (j.phase <= 3) {
      const L = this.levels[j.level];
      const tgt = L && L.count ? (j.phase === 2 ? L.bakeTarget : L.copyTarget) : null;
      if (tgt && j.row < tgt.height * tgt.depth) {
        if (j.phase === 2) batch(tgt, (r0, n) => L.draw(renderer, this.origin, this.h, r0, n));
        else batch(tgt, (r0, n) => L.copy(renderer, j.level, this.levels, this.ind!, this.cells, r0, n));
        // (copies are cheap: they don't teach the pace)
        if (j.phase === 3) j.batch = 0;
        return true;
      }
      j.row = 0; j.level++;
      if (j.level >= this.levels.length) { j.level = 0; j.phase++; }
    }
    this.brickVersion = v;
    this.lastBake.brickMs = performance.now() - j.tb;
    dlog('bricks-done', { ms: this.lastBake.brickMs, bricks: this.lastBake.bricks, samples: this.lastBake.samples });
    this.job = null;
    return false;
  }

  get lastBakeMs(): number | null { return this.lastBake?.ms ?? null; }

  /** Bake progress, 0..1 (null: no bake running). */
  get progress(): number | null {
    if (!this.job || !this.target) return null;
    return this.job.phase === 0 ? 0.5 * this.job.row / (this.target.height * this.target.depth) : 0.5 + 0.5 * this.job.phase / 4;
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
    this.job = null;
    this.lastBake.ms = performance.now() - t0;
    this.lastBake.voxels = this.target!.width * this.target!.height * this.target!.depth;
    const tb = performance.now();
    this.classify(renderer);
    for (const L of this.levels) if (L.count) L.draw(renderer, this.origin, this.h, 0, L.bakeTarget.height * L.bakeTarget.depth);
    this.levels.forEach((L, i) => { if (L.count && L.copyTarget) L.copy(renderer, i, this.levels, this.ind!, this.cells, 0, L.copyTarget.height * L.copyTarget.depth); });
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.brickVersion = this.sdf.fieldVersion;
    this.lastBake.brickMs = performance.now() - tb;
    (window as unknown as { __brickStats: unknown }).__brickStats = { ...this.lastBake, cells: [...this.cells], atlas: this.levels.map((l) => l.atlas ? [l.atlas.width, l.atlas.height, l.atlas.depth] : null) };
    return performance.now() - t0;
  }

  private start(version: number, now: number) {
    const b = this.sdf.bounds;
    const ext = b.getSize(new THREE.Vector3());
    const h = Math.max(ext.x, ext.y, ext.z, 1e-3) / RES;
    const pad = 3 * h;
    const nx = Math.max(2, Math.ceil((ext.x + 2 * pad) / h) + 1), ny = Math.max(2, Math.ceil((ext.y + 2 * pad) / h) + 1), nz = Math.max(2, Math.ceil((ext.z + 2 * pad) / h) + 1);
    this.h = h;
    this.origin.set(b.min.x - pad, b.min.y - pad, b.min.z - pad);
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
    this.job = { version, row: 0, batch: 0, fence: null, at: now, t0: now, n: 0, phase: 0, tb: now, level: 0 };
    this.texRate = 0;
    this.brickVersion = -1;
    dlog('bake-start', { dims: `${nx}x${ny}x${nz}`, objects: this.sdf.material.uniforms.uObjCount.value });
  }

  /** Bake rows [r0, r0 + n) of the volume (row r: layer floor(r / height), row r % height). */
  private drawRows(renderer: THREE.WebGLRenderer, r0: number, n: number) {
    const u = this.sdf.material.uniforms;
    u.uBakeO.value.copy(this.origin);
    u.uBakeH.value = this.h;
    drawRows(renderer, this.target!, this.bakeScene, this.bakeCam, (z) => { u.uBakeZ.value = z; }, r0, n);
  }

  /** Find the band cells and the sharp ones (a GPU pass, read back), lay out the atlases and the indirection. */
  private classify(renderer: THREE.WebGLRenderer) {
    const t0 = performance.now();
    const t = this.target!;
    const cx = Math.ceil((t.width - 1) / BRICK_B), cy = Math.ceil((t.height - 1) / BRICK_B), cz = Math.ceil((t.depth - 1) / BRICK_B);
    const blocks = Math.ceil(cz / 128), rows = cy * blocks;
    if (!this.classRT || this.classRT.width !== cx || this.classRT.height !== 2 * rows) {
      this.classRT?.dispose();
      this.classRT = new THREE.WebGLRenderTarget(cx, 2 * rows, { type: THREE.UnsignedIntType, format: THREE.RGBAIntegerFormat, internalFormat: 'RGBA32UI', depthBuffer: false });
      this.classRT.texture.minFilter = this.classRT.texture.magFilter = THREE.NearestFilter;
    }
    const cu = this.classMat.uniforms;
    cu.uTex.value = t.texture; cu.uCy.value = cy; cu.uRows.value = rows;
    cu.uThr.value = BRICK_THR * this.h; cu.uSharp.value = BRICK_SHARP * this.h;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.classRT);
    renderer.render(this.classScene, this.bakeCam);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const bits = new Uint32Array(cx * 2 * rows * 4);
    gl.readPixels(0, 0, cx, 2 * rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits);
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
    // slots in cell order; indirection: +slot+1 (smooth level), -(slot+1) (sharp level)
    const ind = new Float32Array(cx * cy * cz);
    const lists: number[][] = [[], []];
    const sharpOff = rows * cx * 4;
    for (let k = 0; k < cz; k++) {
      const blk = k >> 7, kk = k & 127, w = kk >> 5, bit = (1 << (kk & 31)) >>> 0;
      for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
        const o = ((blk * cy + j) * cx + i) * 4 + w;
        if ((bits[o] & bit) === 0) continue;
        const lv = (bits[sharpOff + o] & bit) !== 0 ? 1 : 0;
        lists[lv].push(i, j, k);
        ind[(k * cy + j) * cx + i] = (lv ? -1 : 1) * lists[lv].length / 3;
      }
    }
    this.cells.set([cx, cy, cz]);
    this.ind?.dispose();
    this.ind = new THREE.Data3DTexture(ind, cx, cy, cz);
    this.ind.format = THREE.RedFormat; this.ind.type = THREE.FloatType;
    this.ind.minFilter = this.ind.magFilter = THREE.NearestFilter;
    this.ind.unpackAlignment = 1;
    this.ind.needsUpdate = true;
    this.levels.forEach((L, i) => { L.layout(lists[i]); if (L.count) L.masks(renderer, this.origin, this.h); });
    const su = this.settledMat.uniforms;
    su.uTex.value = t.texture; su.uInd.value = this.ind; su.uH.value = this.h;
    su.uAtlas0.value = this.levels[0].atlas!.texture; su.uAtlas1.value = this.levels[1].atlas!.texture;
    this.lastBake.bricks = this.levels.map((l) => l.count);
    this.lastBake.samples = this.levels.reduce((a, l) => a + l.count * (l.core ? l.N : l.S) ** 3, 0);
    this.lastBake.classifyMs = performance.now() - t0;
  }

}
