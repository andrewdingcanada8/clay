// Fine bricks: a sparse, finer copy of the baked field near the surface.
// After the coarse bake (bake.ts), the cells of B×B×B voxels the surface passes near
// get a brick of (N+1)³ samples of the exact field (spacing B/N voxels), stored in a
// 3D atlas; an indirection texture maps cell → atlas slot. Cells where the coarse
// samples bend sharply (rims, creases: where trilinear rounds the surface off) get a
// finer brick, in a second atlas. The settled frame marches the coarse field to the
// band, then the bricks to the hit, and shades from them: no exact field evaluations.
import * as THREE from 'three';

// (prototype knobs: ?bb=&bn=&bn2=&bt=&bs= on the page URL)
const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
/** Cell size in coarse voxels. */
export const BRICK_B = +(Q.get('bb') ?? 2);
/** Fine intervals per cell: smooth cells, sharp cells. */
export const BRICK_N = [+(Q.get('bn') ?? 4), +(Q.get('bn2') ?? 8)];
/** A cell gets a brick if one of its (B+1)³ samples is within this many voxels of the
 *  surface (any point of the cell is within half a voxel diagonal of one, the band
 *  reaches half a voxel past the surface for the normal taps, plus slack). */
export const BRICK_THR = +(Q.get('bt') ?? 1.6);
/** A band cell is sharp if a second difference of its samples exceeds this (voxels). */
export const BRICK_SHARP = +(Q.get('bs') ?? 0.6);
/** Objects that can't change a brick's values within this many voxels of the surface are
 *  left out of its bake (any further, they only raise values already past the band). */
export const BRICK_REACH = +(Q.get('br') ?? 3);
/** Occlusion taps read the bricks where they reach the band (else the coarse field). */
export const AO_FINE = Q.get('ao') === '1';
/** Bake each brick's own N³ samples only (a core atlas), then fill the shared faces from
 *  the neighbours' cores in a copy pass (no map()): about half the samples of (N+1)³. */
export const APRON_COPY = Q.get('ap') !== '0';
/** Atlas slots per row and per column. */
export const SLOTS_XY = 40;

export const VERT = 'out vec2 vNdc; void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** Flags the cells: one fragment per (I, J) column of cells, 128 K's per row block.
 *  Rows [0, rows): band cells; [rows, 2 rows): band cells that are sharp. */
export const CLASSIFY = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler3D uTex;
uniform int uCy;
uniform int uRows;
uniform float uThr;   // world units
uniform float uSharp; // world units
out uvec4 fragColor;
#define B ${BRICK_B}
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  bool sharpMode = fc.y >= uRows;
  int y = sharpMode ? fc.y - uRows : fc.y;
  int kOff = (y / uCy) * 128;
  ivec2 c = ivec2(fc.x, y - (y / uCy) * uCy);
  ivec3 n = textureSize(uTex, 0);
  uvec4 bits = uvec4(0u);
  for (int k = 0; k < 128; k++) {
    int K = kOff + k;
    if (K * B >= n.z - 1) break;
    float m = 1e9, s = 0.0;
    float v[(B + 1) * (B + 1) * (B + 1)];
    for (int z = 0; z <= B; z++) for (int y = 0; y <= B; y++) for (int x = 0; x <= B; x++) {
      ivec3 q = min(ivec3(c * B + ivec2(x, y), K * B + z), n - 1);
      float d = texelFetch(uTex, q, 0).r;
      v[(z * (B + 1) + y) * (B + 1) + x] = d;
      m = min(m, abs(d));
    }
    // second differences along each axis over the cell's samples
    for (int a = 0; a <= B; a++) for (int b = 0; b <= B; b++) for (int x = 1; x < B; x++) {
      int i = (a * (B + 1) + b) * (B + 1) + x;
      s = max(s, abs(v[i - 1] - 2.0 * v[i] + v[i + 1]));
      int j = (a * (B + 1) + x) * (B + 1) + b;
      s = max(s, abs(v[j - (B + 1)] - 2.0 * v[j] + v[j + (B + 1)]));
      int l = (x * (B + 1) + a) * (B + 1) + b;
      s = max(s, abs(v[l - (B + 1) * (B + 1)] - 2.0 * v[l] + v[l + (B + 1) * (B + 1)]));
    }
    if (m < uThr && (!sharpMode || s > uSharp)) {
      uint bit = 1u << uint(k & 31);
      int w = k >> 5;
      if (w == 0) bits.x |= bit; else if (w == 1) bits.y |= bit; else if (w == 2) bits.z |= bit; else bits.w |= bit;
    }
  }
  fragColor = bits;
}`;

const f = (x: number) => x.toFixed(6);

/** The settled frame from coarse field + bricks. */
export const SETTLED = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
in vec2 vNdc;
out vec4 fragColor;
uniform sampler3D uTex;
uniform sampler3D uInd;
uniform sampler3D uAtlas0;
uniform sampler3D uAtlas1;
uniform vec3 uO;
uniform vec3 uSize;
uniform float uH;
uniform ivec3 uCells;
uniform ivec3 uSlots0;
uniform ivec3 uSlots1;
uniform mat4 uInvProjView;
uniform mat4 uProjView;
uniform vec4 uClip;
uniform int uClipOn;
uniform vec3 uClay;
uniform vec3 uCap;
uniform float uPixelAngle;
uniform float uPixelSize;
uniform int uFlat;
float coarse(vec3 p) {
  vec3 q = (p - uO) / uSize;
  vec3 c = clamp(q, 0.0, 1.0);
  float outside = length((q - c) * uSize);
  vec3 n = vec3(textureSize(uTex, 0));
  float d = texture(uTex, (c * (n - 1.0) + 0.5) / n).r;
  return outside > 0.0 ? max(outside, d) : d;
}
float bakedField(vec3 p) {
  vec3 q = clamp((p - uO) / uSize, 0.0, 1.0);
  vec3 n = vec3(textureSize(uTex, 0));
  return texture(uTex, (q * (n - 1.0) + 0.5) / n).r;
}
ivec3 slotOf(int slot, ivec3 s) { return ivec3(slot % s.x, (slot / s.x) % s.y, slot / (s.x * s.y)); }
// the field from the brick holding p, else the coarse field; level: -1 none, 0 smooth, 1 sharp
float field(vec3 p, out int level) {
  vec3 g = (p - uO) / uH;
  vec3 cf = floor(g * ${f(1 / BRICK_B)});
  ivec3 c = clamp(ivec3(cf), ivec3(0), uCells - 1);
  float s = texelFetch(uInd, c, 0).r;
  int slot = max(int(abs(s) + 0.5) - 1, 0);
  vec3 u = g - cf * ${BRICK_B.toFixed(1)};
  vec3 l0 = clamp(u * ${f(BRICK_N[0] / BRICK_B)}, 0.0, ${BRICK_N[0].toFixed(1)});
  vec3 l1 = clamp(u * ${f(BRICK_N[1] / BRICK_B)}, 0.0, ${BRICK_N[1].toFixed(1)});
  float f0 = texture(uAtlas0, (vec3(slotOf(slot, uSlots0)) * ${(BRICK_N[0] + 1).toFixed(1)} + 0.5 + l0) / vec3(textureSize(uAtlas0, 0))).r;
  float f1 = texture(uAtlas1, (vec3(slotOf(slot, uSlots1)) * ${(BRICK_N[1] + 1).toFixed(1)} + 0.5 + l1) / vec3(textureSize(uAtlas1, 0))).r;
  level = ivec3(cf) != c || s == 0.0 ? -1 : s > 0.0 ? 0 : 1;
  return level == 0 ? f0 : level == 1 ? f1 : coarse(p);
}
bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 lo = uO, hi = uO + uSize;
  vec3 inv = 1.0 / rd, a = (lo - ro) * inv, b = (hi - ro) * inv;
  vec3 mn = min(a, b), mx = max(a, b);
  t0 = max(max(mn.x, mn.y), mn.z); t1 = min(min(mx.x, mx.y), mx.z);
  return t1 > max(t0, 0.0);
}
void main() {
  vec4 a = uInvProjView * vec4(vNdc, -1.0, 1.0), b = uInvProjView * vec4(vNdc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w, rd = normalize(b.xyz / b.w - ro);
  float t0, t1;
  if (!boxHit(ro, rd, t0, t1)) discard;
  float t = max(t0, 0.0);
  int kind = 0, level = -1;
  bool hit = false, done = false;
  float d = 1e5, eps = 0.0;
  for (int i = 0; i < 240; i++) {
    vec3 p = ro + rd * t;
    d = field(p, level);
    kind = 0;
    if (uClipOn == 1) { float c = -(dot(p, uClip.xyz) + uClip.w); if (c > d) { d = c; kind = 1; } }
    eps = clamp((uPixelAngle * t + uPixelSize) * 0.35, 0.0008, 0.008);
    if (d < eps) { hit = true; break; }
    t += max(d * 0.92, eps * 0.5);
    if (t > t1) { done = true; break; }
  }
  if (!hit && !done && d < 8.0 * eps) hit = true;
  if (!hit) discard;
  vec3 p = ro + rd * t;
  vec4 clip = uProjView * vec4(p, 1.0);
  gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  if (uFlat != 0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 n;
  if (kind == 1) n = -uClip.xyz;
  else {
    // central differences one fine spacing apart
    vec3 e = vec3(uH * (level == 1 ? ${f(BRICK_B / BRICK_N[1])} : ${f(BRICK_B / BRICK_N[0])}), 0.0, 0.0);
    int l2;
    n = vec3(field(p + e.xyy, l2) - field(p - e.xyy, l2), field(p + e.yxy, l2) - field(p - e.yxy, l2), field(p + e.yyx, l2) - field(p - e.yyx, l2));
  }
  n = normalize(n);
  if (dot(n, rd) > 0.0) n = -n;
  float occ = 0.0, sca = 1.0;
  int l3;
  for (int k = 0; k < 4; k++) { float h = 0.15 + 0.6 * float(k); occ += (h - ${AO_FINE ? 'field(p + n * h, l3)' : 'bakedField(p + n * h)'}) * sca; sca *= 0.75; }
  float ao = clamp(1.0 - 0.18 * occ, 0.0, 1.0);
  vec3 base = kind == 1 ? uCap : uClay;
  vec3 key = normalize(-rd + vec3(0.35, 0.65, 0.2));
  float dif = clamp(dot(n, key), 0.0, 1.0), hemi = 0.55 + 0.45 * n.y;
  vec3 col = base * (0.38 + 0.22 * hemi + 0.62 * dif) * (0.55 + 0.45 * ao);
  col += 0.06 * pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  fragColor = vec4(pow(col, vec3(1.0 / 1.15)), 1.0);
}`;

/** Fills a level's atlas (N+1 samples per side) from the cores (N per side): the +1 face
 *  comes from the neighbour cell's core (the other level's, interpolated, where the
 *  neighbour has the other kind of brick) or, with no neighbour, extrapolated. */
export const COPY = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
out vec4 fragColor;
uniform sampler3D uCore0;
uniform sampler3D uCore1;
uniform sampler3D uInd;
uniform sampler2D uSlotTab;
uniform ivec3 uSlots0;
uniform ivec3 uSlots1;
uniform ivec3 uCells;
uniform int uLevel;
uniform float uZ;
const int N0 = ${BRICK_N[0]}, N1 = ${BRICK_N[1]};
ivec3 slotOf(int slot, ivec3 s) { return ivec3(slot % s.x, (slot / s.x) % s.y, slot / (s.x * s.y)); }
// a core's value at l (its own fine units, clamped to its samples), interpolated
float coreAt(int lv, int slot, vec3 l) {
  vec3 c0 = clamp(l, 0.0, float(N0 - 1)), c1 = clamp(l, 0.0, float(N1 - 1));
  float a = texture(uCore0, (vec3(slotOf(slot, uSlots0) * N0) + c0 + 0.5) / vec3(textureSize(uCore0, 0))).r;
  float b = texture(uCore1, (vec3(slotOf(slot, uSlots1) * N1) + c1 + 0.5) / vec3(textureSize(uCore1, 0))).r;
  return lv == 0 ? a : b;
}
void main() {
  int N = uLevel == 0 ? N0 : N1, S = N + 1;
  ivec3 sl3 = uLevel == 0 ? uSlots0 : uSlots1;
  ivec3 a = ivec3(ivec2(gl_FragCoord.xy), int(uZ + 0.5));
  ivec3 sl = a / S, l = a - sl * S;
  int slot = (sl.z * sl3.y + sl.y) * sl3.x + sl.x;
  ivec3 cell = ivec3(texelFetch(uSlotTab, ivec2(slot & 4095, slot >> 12), 0).xyz + 0.5);
  ivec3 over = ivec3(greaterThanEqual(l, ivec3(N)));
  float own = coreAt(uLevel, slot, vec3(min(l, ivec3(N - 1))));
  ivec3 nc = cell + over;
  float s = all(lessThan(nc, uCells)) ? texelFetch(uInd, min(nc, uCells - 1), 0).r : 0.0;
  int lv = s > 0.0 ? 0 : 1, ns = max(int(abs(s) + 0.5) - 1, 0);
  vec3 ll = vec3(l - over * N) * (float(lv == 0 ? N0 : N1) / float(N));
  float nb = coreAt(lv, ns, ll);
  // no neighbour: linear extrapolation along each axis that steps out
  vec3 lc = vec3(min(l, ivec3(N - 1)));
  float ex = own;
  if (over.x == 1) ex += own - coreAt(uLevel, slot, lc - vec3(1.0, 0.0, 0.0));
  if (over.y == 1) ex += own - coreAt(uLevel, slot, lc - vec3(0.0, 1.0, 0.0));
  if (over.z == 1) ex += own - coreAt(uLevel, slot, lc - vec3(0.0, 0.0, 1.0));
  float v = over == ivec3(0) ? own : s != 0.0 ? nb : ex;
  fragColor = vec4(v, 0.0, 0.0, 1.0);
}`;

export const tri = () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
};

/** One level of bricks: N fine intervals per cell, its atlas and slot table. */
export class BrickLevel {
  readonly S: number;
  atlas: THREE.WebGL3DRenderTarget | null = null;
  /** Each brick's own samples (APRON_COPY), N per side; the atlas is filled from these. */
  core: THREE.WebGL3DRenderTarget | null = null;
  private copyScene = new THREE.Scene();
  readonly copyMat: THREE.ShaderMaterial;
  slotTex: THREE.DataTexture | null = null;
  readonly slots = new Int32Array(3);
  count = 0;
  private scene = new THREE.Scene();
  private maskScene = new THREE.Scene();
  private maskRT: THREE.WebGLRenderTarget | null = null;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(readonly N: number, frag: string, private uniforms: Record<string, THREE.IUniform>) {
    this.S = N + 1;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms,
      defines: { SDF_BRICK: 1, BRICK_S: APRON_COPY ? N : this.S }, depthTest: false, depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: COPY, depthTest: false, depthWrite: false,
      uniforms: {
        uCore0: { value: null }, uCore1: { value: null }, uInd: { value: null }, uSlotTab: { value: null },
        uSlots0: { value: null }, uSlots1: { value: null }, uCells: { value: null }, uLevel: { value: 0 }, uZ: { value: 0 },
      },
    });
    const cm = new THREE.Mesh(tri(), this.copyMat);
    cm.frustumCulled = false;
    this.copyScene.add(cm);
    const m = new THREE.Mesh(tri(), mat);
    m.frustumCulled = false;
    this.scene.add(m);
    const mm = new THREE.Mesh(tri(), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms,
      defines: { SDF_MASK: 1 }, depthTest: false, depthWrite: false,
    }));
    mm.frustumCulled = false;
    this.maskScene.add(mm);
  }

  /** Each slot's objects and clusters (those that can matter within the cell's samples). */
  masks(renderer: THREE.WebGLRenderer, origin: THREE.Vector3, h: number) {
    const rows = this.slotTex!.image.height;
    if (!this.maskRT || this.maskRT.height !== 2 * rows) {
      this.maskRT?.dispose();
      this.maskRT = new THREE.WebGLRenderTarget(4096, 2 * rows, { type: THREE.UnsignedIntType, format: THREE.RGBAIntegerFormat, internalFormat: 'RGBA32UI', depthBuffer: false });
      this.maskRT.texture.minFilter = this.maskRT.texture.magFilter = THREE.NearestFilter;
    }
    const u = this.uniforms;
    u.uBakeO.value.copy(origin);
    u.uBakeH.value = h;
    u.uStartT.value = this.slotTex;
    u.uBrickCell.value = BRICK_B;
    // half the cell's diagonal, then the values that matter (the band and the apron)
    u.uBrickReach.value = (0.87 * BRICK_B + BRICK_REACH) * h;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.maskRT);
    renderer.render(this.maskScene, this.cam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }

  /** Lay out the atlas for these cells (x, y, z triples). */
  layout(cells: number[]) {
    const count = cells.length / 3;
    this.count = count;
    const az = Math.max(1, Math.ceil(count / (SLOTS_XY * SLOTS_XY)));
    this.slots.set([SLOTS_XY, SLOTS_XY, az]);
    const rows = Math.max(1, Math.ceil(count / 4096));
    const st = new Float32Array(4096 * rows * 4);
    for (let s = 0; s < count; s++) { st[s * 4] = cells[s * 3]; st[s * 4 + 1] = cells[s * 3 + 1]; st[s * 4 + 2] = cells[s * 3 + 2]; }
    this.slotTex?.dispose();
    this.slotTex = new THREE.DataTexture(st, 4096, rows, THREE.RGBAFormat, THREE.FloatType);
    this.slotTex.minFilter = this.slotTex.magFilter = THREE.NearestFilter;
    this.slotTex.needsUpdate = true;
    const make = (old: THREE.WebGL3DRenderTarget | null, S: number) => {
      const W = SLOTS_XY * S, D = count ? az * S : 1;
      if (old && old.width === W && old.height === W && old.depth === D) return old;
      old?.dispose();
      const t = new THREE.WebGL3DRenderTarget(W, W, D, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false });
      const tex = t.texture;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      return t;
    };
    this.atlas = make(this.atlas, this.S);
    if (APRON_COPY) this.core = make(this.core, this.N);
  }

  /** Fill the atlas from the cores (after every level's core is baked). */
  copy(renderer: THREE.WebGLRenderer, level: number, levels: BrickLevel[], ind: THREE.Data3DTexture, cells: Int32Array) {
    if (!APRON_COPY || !this.count) return;
    const u = this.copyMat.uniforms;
    u.uCore0.value = levels[0].core!.texture; u.uCore1.value = levels[1].core!.texture;
    u.uInd.value = ind; u.uSlotTab.value = this.slotTex;
    u.uSlots0.value = levels[0].slots; u.uSlots1.value = levels[1].slots; u.uCells.value = cells; u.uLevel.value = level;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    for (let z = 0; z < this.atlas!.depth; z++) {
      u.uZ.value = z;
      renderer.setRenderTarget(this.atlas!, z);
      renderer.render(this.copyScene, this.cam);
    }
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }

  /** Atlas layers that hold bricks. */
  get layers() { return this.count ? (APRON_COPY ? this.core! : this.atlas!).depth : 0; }

  draw(renderer: THREE.WebGLRenderer, origin: THREE.Vector3, h: number, z0: number, n: number) {
    const u = this.uniforms;
    u.uBakeO.value.copy(origin);
    u.uBakeH.value = h;
    u.uStartT.value = this.slotTex;
    u.uBrickMask.value = this.maskRT!.texture;
    (u.uBrickSlots.value as Int32Array).set(this.slots);
    u.uBrickCell.value = BRICK_B;
    u.uBrickStep.value = BRICK_B / this.N;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    for (let z = z0; z < z0 + n; z++) {
      u.uBakeZ.value = z;
      renderer.setRenderTarget(APRON_COPY ? this.core! : this.atlas!, z);
      renderer.render(this.scene, this.cam);
    }
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }

  dispose() { this.maskRT?.dispose(); this.maskRT = null; this.atlas?.dispose(); this.atlas = null; this.core?.dispose(); this.core = null; this.slotTex?.dispose(); this.slotTex = null; this.count = 0; }
}
