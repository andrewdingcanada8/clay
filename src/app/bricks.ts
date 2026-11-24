// Fine bricks: a sparse, finer copy of the baked field near the surface.
// After the coarse bake (bake.ts), the cells of B×B×B voxels the surface passes near
// get a brick of (N+1)³ samples of the exact field (spacing B/N voxels), stored in a
// 3D atlas; an indirection texture maps cell → atlas slot. Cells where the coarse
// samples bend sharply (rims, creases: where trilinear rounds the surface off) get a
// finer brick, in a second atlas. The settled frame marches the coarse field to the
// band, then the bricks to the hit, and shades from them: no exact field evaluations.
import * as THREE from 'three';
import { dlog } from './debugLog';

// (prototype knobs: ?bb=&bn=&bn2=&bt=&bs= on the page URL)
const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
/** Cell size in coarse voxels. */
export const BRICK_B = +(Q.get('bb') ?? 2);
/** Fine intervals per cell: smooth cells, sharp cells. */
export const BRICK_N = [+(Q.get('bn') ?? 4), +(Q.get('bn2') ?? 8)];
/** A cell gets a brick if one of its (B+1)³ samples is within this many voxels of the
 *  surface (any point of the cell is within half a voxel diagonal of one, the band
 *  reaches half a voxel past the surface for the normal taps, plus slack). */
export const BRICK_THR = +(Q.get('bt') ?? 1.2);
/** A band cell is sharp if a second difference of its samples exceeds this (voxels). */
export const BRICK_SHARP = +(Q.get('bs') ?? 99);
/** Objects that can't change a brick's values within this many voxels of the surface are
 *  left out of its bake (any further, they only raise values already past the band). */
export const BRICK_REACH = +(Q.get('br') ?? 3);
/** Occlusion taps read the bricks where they reach the band (else the coarse field). */
export const AO_FINE = Q.get('ao') === '1';
/** Bake each brick's own N³ samples only (a core atlas), then fill the shared faces from
 *  the neighbours' cores in a copy pass (no map()): about half the samples of (N+1)³. */
export const APRON_COPY = Q.get('ap') !== '0';
/** Second differences count only along sample lines that come this near the surface (voxels). */
export const BRICK_NEAR = +(Q.get('bl') ?? 1);
/** Brick samples where the coarse field is farther than this many voxels from the surface take its value (0: all exact). */
export const BRICK_FAR = +(Q.get('bf') ?? 0);
/** Normal taps this many fine spacings from the hit. */
export const NORMAL_E = +(Q.get('ne') ?? 1);
/** Brick reads: take off trilinear's curvature error, ½Σ w(1-w)·(second difference along each
 *  axis); the second differences are baked beside the values (RGBA: d, Δ²x, Δ²y, Δ²z). */
export const QUAD_CORR = Q.get('qc') !== '0';
/** Atlas slots per row and per column. */
/** Cone pre-pass block size (pixels), its radius in pixels for the block's corner rays (with
 *  slack for uPixelAngle), and how near (voxels) it may come before the full rays take over. */
export const CONE_PX = +(Q.get('cp') ?? 4);
const CONE_R = CONE_PX * 0.71 + 0.7;
const CONE_MARGIN = +(Q.get('cg') ?? 2);
/** Exact refinement: pixels whose hit lies where a brick sample's second difference exceeds
 *  FLAG_CREASE fine spacings, or whose ray passed that near such a place within FLAG_NEAR fine
 *  spacings of the surface without touching it, are resolved by the exact pass. */
export const REFINE = Q.get('rf') !== '0';
export const FLAG_CREASE = +(Q.get('fc') ?? 0.35);
export const FLAG_NEAR = +(Q.get('fn') ?? 0.5);
const FLAG_HITS = Q.get('fh') !== '0', FLAG_MISSES = Q.get('fm') !== '0';
/** Atlas width and height in texels (each level fits as many slots across as it can). */
export const ATLAS_W = 360;
/** (prototype: settled reads as textureLod, ?tl=1) */
const TL = Q.get('tl') === '1';
const DBG = Q.get('dbg') === '1';
/** Near-misses start the exact pass at the ray's closest approach to a crease (else the first near point). */
const NEAR_MIN = Q.get('nm') === '1';
const TEX = TL ? 'textureLod' : 'texture', LOD = TL ? ', 0.0' : '';
/** The exact pass's list width (texels): narrow, so its quad rows spread over the rasterizer's threads. */
export const LIST_W = +(Q.get('lq') ?? 32);

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
uniform float uNear;  // world units
uniform int uK0;      // cells [uK0, uK1] in z only (an incremental bake's region)
uniform int uK1;
#define B ${BRICK_B}
// a bend only rounds the surface off where it lies near it
bool near(float a, float b, float c) { return min(min(abs(a), abs(b)), abs(c)) < uNear; }
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
    if (K * B >= n.z - 1 || K > uK1) break;
    if (K < uK0) continue;
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
      s = max(s, near(v[i - 1], v[i], v[i + 1]) ? abs(v[i - 1] - 2.0 * v[i] + v[i + 1]) : 0.0);
      int j = (a * (B + 1) + x) * (B + 1) + b;
      s = max(s, near(v[j - (B + 1)], v[j], v[j + (B + 1)]) ? abs(v[j - (B + 1)] - 2.0 * v[j] + v[j + (B + 1)]) : 0.0);
      int l = (x * (B + 1) + a) * (B + 1) + b;
      s = max(s, near(v[l - (B + 1) * (B + 1)], v[l], v[l + (B + 1) * (B + 1)]) ? abs(v[l - (B + 1) * (B + 1)] - 2.0 * v[l] + v[l + (B + 1) * (B + 1)]) : 0.0);
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
// per cell: where its brick starts in the read atlas (texels) and its N (0: no brick)
uniform sampler3D uIndS;
// every level's bricks, values and second differences (RGBA), one level after another in z
uniform sampler3D uAtlasR;
// beside it: each sample's normal and occlusion (SHADE)
uniform sampler3D uAtlasG;
uniform vec3 uInvA;  // 1 / the read atlas's size
uniform vec3 uInvN;  // 1 / the coarse texture's size
uniform vec3 uNm1;   // the coarse texture's size - 1
uniform vec3 uO;
uniform vec3 uSize;
uniform float uH;
uniform ivec3 uCells;
uniform mat4 uInvProjView;
uniform mat4 uProjView;
uniform vec4 uClip;
uniform int uClipOn;
uniform vec3 uClay;
uniform vec3 uCap;
uniform float uPixelAngle;
uniform float uPixelSize;
uniform int uFlat;
// where each block of CONE_PX × CONE_PX rays may start (cone pre-pass); >= 1e9: none hits
uniform sampler2D uConeT;
// pixels to resolve exactly (uFlagOn): written as alpha 0.5 with the start distance / uTMax in rgb
uniform int uFlagOn;
uniform float uTMax;
uniform float uCoarsePx; // flag hits where a fine spacing spans more than this many pixels (0: off)
float gCrease = 0.0; // the last brick read's largest second difference, in fine spacings
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
  vec4 e = texelFetch(uIndS, c, 0);
  vec3 l = clamp((g - cf * ${BRICK_B.toFixed(1)}) * (e.w * ${f(1 / BRICK_B)}), 0.0, e.w);
  vec4 q = ${TEX}(uAtlasR, (e.xyz + 0.5 + l) * uInvA${LOD});
  float fb = q.r;
  // (second differences over one fine spacing hf = B h / N, in units of hf)
  gCrease = max(max(abs(q.g), abs(q.b)), abs(q.a)) * e.w / (${BRICK_B.toFixed(1)} * uH);${QUAD_CORR ? `
  vec3 w = fract(l);
  fb -= 0.5 * dot(w * (1.0 - w), q.gba);` : ''}
  level = ivec3(cf) != c || e.w == 0.0 ? -1 : e.w == ${BRICK_N[0].toFixed(1)} ? 0 : 1;
  // (the ray stays inside the baked box: the coarse read needs no outside term)
  if (level >= 0) return fb;
  return ${TEX}(uTex, (clamp(g, vec3(0.0), uNm1) + 0.5) * uInvN${LOD}).r;
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
  if (!boxHit(ro, rd, t0, t1)) { ${DBG ? "fragColor = vec4(0.0, 1.0, 0.0, 1.0); gl_FragDepth = 0.0; return;" : "discard;"} }
  float tc = texelFetch(uConeT, ivec2(gl_FragCoord.xy) / ${CONE_PX}, 0).r;
  if (tc >= 1e9) { ${DBG ? "fragColor = vec4(0.0, 0.0, 1.0, 1.0); gl_FragDepth = 0.0; return;" : "discard;"} }
  float t = max(max(t0, 0.0), tc);
  int kind = 0, level = -1;
  bool hit = false, done = false, nearCrease = false;
  // (the closest approach to a crease so far, and where)
  float nearGap = ${f(FLAG_NEAR * BRICK_B / BRICK_N[0])} * uH;
  float d = 1e5, eps = 0.0, tNear = 0.0;${DBG ? `
  float dbgGap = 1e9, dbgCr = 0.0; int dbgN = 0, dbgLv = -2;` : ''}
  for (int i = 0; i < 240; i++) {
    vec3 p = ro + rd * t;
    d = field(p, level);
    kind = 0;
#if CLIP
    { float c = -(dot(p, uClip.xyz) + uClip.w); if (c > d) { d = c; kind = 1; } }
#endif
    eps = clamp((uPixelAngle * t + uPixelSize) * 0.35, 0.0008, 0.008);
    if (d < eps) { hit = true; break; }${DBG ? `
    dbgN = i; if (d - eps < dbgGap) { dbgGap = d - eps; dbgCr = gCrease; dbgLv = level; }` : ''}
    // passing close by a crease without touching: the exact pass decides
    ${NEAR_MIN ? `if (level >= 0 && gCrease > ${FLAG_CREASE.toFixed(3)} && d - eps < nearGap) { nearGap = d - eps; tNear = t; nearCrease = true; }` : `if (!nearCrease && level >= 0 && gCrease > ${FLAG_CREASE.toFixed(3)} && d < eps + ${FLAG_NEAR.toFixed(3)} * uH * ${f(BRICK_B / BRICK_N[0])}) { nearCrease = true; tNear = t; }`}
    t += max(d * 0.92, eps * 0.5);
    if (t > t1) { done = true; break; }
  }
  if (!hit && !done && d < 8.0 * eps) hit = true;
  // alpha 128: the exact pass looks only round the start (the bricks saw nothing further);
  // 129: past it too (the bricks hit there)
  bool creaseHit = hit && level >= 0 && gCrease > ${FLAG_CREASE.toFixed(3)};
  // a hit where the samples are coarser than the screen (a wide scene, or close up): the
  // exact pass draws it, so the bricks never show detail coarser than about uCoarsePx pixels
  float spacing = level >= 0 ? uH * ${f(BRICK_B / BRICK_N[0])} : uH;
  // (a hit outside every brick is on the coarse field alone: always exact)
  if (hit && uCoarsePx > 0.0 && (level < 0 || spacing > uCoarsePx * (uPixelAngle * t + uPixelSize))) creaseHit = true;
  // (a ray that passed near a crease but hit something else further on keeps its brick hit)
  bool flag = uFlagOn == 1 && (hit ? ${FLAG_HITS ? 'creaseHit' : 'false'} : ${FLAG_MISSES ? 'nearCrease' : 'false'});
${DBG ? `  if (!hit && !flag && dbgGap < 1e8) { fragColor = vec4(clamp(dbgGap / (uH * ${f(BRICK_B / BRICK_N[0])}), 0.0, 1.0), float(dbgN) / 255.0, clamp(dbgCr / 4.0, 0.0, 1.0), dbgLv >= 0 ? 1.0 : 0.5); gl_FragDepth = 0.0; return; }` : ''}
  if (flag) {
    float x = floor(clamp((hit ? t : tNear) / uTMax, 0.0, 1.0) * 16777215.0);
    fragColor = vec4(floor(x / 65536.0), mod(floor(x / 256.0), 256.0), mod(x, 256.0), hit ? 129.0 : 128.0) / 255.0;
    gl_FragDepth = 1.0;
    return;
  }
  if (!hit) { ${DBG ? "fragColor = vec4(1.0, 0.0, 1.0, 1.0); gl_FragDepth = 0.0; return;" : "discard;"} }
  vec3 p = ro + rd * t;
  vec4 clip = uProjView * vec4(p, 1.0);
  gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  if (uFlat != 0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 n;
  float ao;
#if CLIP
  if (kind == 1) {
    // the section plane: its normal, occlusion from the coarse field
    n = -uClip.xyz;
    float occ = 0.0, sca = 1.0;
    for (int k = 0; k < 4; k++) { float h = 0.15 + 0.6 * float(k); occ += (h - bakedField(p + n * h)) * sca; sca *= 0.75; }
    ao = clamp(1.0 - 0.18 * occ, 0.0, 1.0);
  } else
#endif
  {
    // a clay hit lies in a brick (the band): its baked normal and occlusion at p, one read
    vec3 g = (p - uO) / uH;
    vec3 cf = floor(g * ${f(1 / BRICK_B)});
    vec4 e = texelFetch(uIndS, clamp(ivec3(cf), ivec3(0), uCells - 1), 0);
    vec3 l = clamp((g - cf * ${BRICK_B.toFixed(1)}) * (e.w * ${f(1 / BRICK_B)}), 0.0, e.w);
    vec4 G = ${TEX}(uAtlasG, (e.xyz + 0.5 + l) * uInvA${LOD});
    n = normalize(G.xyz);
    ao = G.w;
  }
  if (dot(n, rd) > 0.0) n = -n;
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
  // (by hand, from exact texel reads: a filtered read's weights are too coarse)
  int N = lv == 0 ? N0 : N1;
  vec3 c = clamp(l, 0.0, float(N - 1));
  ivec3 i0 = min(ivec3(floor(c)), ivec3(N - 2)), base = lv == 0 ? slotOf(slot, uSlots0) * N0 : slotOf(slot, uSlots1) * N1;
  vec3 w = c - vec3(i0);
  float v[8];
  for (int k = 0; k < 8; k++) {
    ivec3 q = base + i0 + ivec3(k & 1, (k >> 1) & 1, k >> 2);
    v[k] = lv == 0 ? texelFetch(uCore0, q, 0).r : texelFetch(uCore1, q, 0).r;
  }
  return mix(mix(mix(v[0], v[1], w.x), mix(v[2], v[3], w.x), w.y), mix(mix(v[4], v[5], w.x), mix(v[6], v[7], w.x), w.y), w.z);
}
void main() {
  int N = uLevel == 0 ? N0 : N1, S = N + 1;
  ivec3 sl3 = uLevel == 0 ? uSlots0 : uSlots1;
  ivec3 a = ivec3(ivec2(gl_FragCoord.xy), int(uZ + 0.5));
  ivec3 sl = a / S, l = a - sl * S;
  int slot = (sl.z * sl3.y + sl.y) * sl3.x + sl.x;
  ivec3 cell = ivec3(texelFetch(uSlotTab, ivec2(slot & 4095, slot >> 12), 0).xyz + 0.5);
  ivec3 over = ivec3(greaterThanEqual(l, ivec3(N)));
  // inside the core: its own sample, one read
  ivec3 base = uLevel == 0 ? slotOf(slot, uSlots0) * N0 : slotOf(slot, uSlots1) * N1;
  if (over == ivec3(0)) { fragColor = vec4(uLevel == 0 ? texelFetch(uCore0, base + l, 0).r : texelFetch(uCore1, base + l, 0).r, 0.0, 0.0, 1.0); return; }
  ivec3 nc = cell + over;
  float s = all(lessThan(nc, uCells)) ? texelFetch(uInd, min(nc, uCells - 1), 0).r : 0.0;
  float v;
  if (s != 0.0) {
    int lv = s > 0.0 ? 0 : 1, ns = max(int(abs(s) + 0.5) - 1, 0);
    vec3 ll = vec3(l - over * N) * (float(lv == 0 ? N0 : N1) / float(N));
    v = coreAt(lv, ns, ll);
  } else {
    // no neighbour: linear extrapolation along each axis that steps out
    vec3 lc = vec3(min(l, ivec3(N - 1)));
    float own = coreAt(uLevel, slot, lc);
    v = own;
    if (over.x == 1) v += own - coreAt(uLevel, slot, lc - vec3(1.0, 0.0, 0.0));
    if (over.y == 1) v += own - coreAt(uLevel, slot, lc - vec3(0.0, 1.0, 0.0));
    if (over.z == 1) v += own - coreAt(uLevel, slot, lc - vec3(0.0, 0.0, 1.0));
  }
  fragColor = vec4(v, 0.0, 0.0, 1.0);
}`;

/** Draw rows [r0, r0 + n) of a 3D target (row r: layer floor(r / height), row r % height),
 *  each layer's band of rows scissored; setZ is told the layer before each draw. */
export function drawRows(renderer: THREE.WebGLRenderer, t: THREE.WebGL3DRenderTarget, scene: THREE.Scene, cam: THREE.Camera, setZ: (z: number) => void, r0: number, n: number, zOff = 0, H = t.height) {
  const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
  renderer.autoClear = false;
  for (let r = r0; r < r0 + n;) {
    const z = Math.floor(r / H), y = r % H, rows = Math.min(H - y, r0 + n - r);
    setZ(z);
    t.scissor.set(0, y, t.width, rows);
    t.scissorTest = y > 0 || rows < t.height;
    renderer.setRenderTarget(t, z + zOff);
    renderer.render(scene, cam);
    r += rows;
  }
  t.scissorTest = false;
  renderer.setRenderTarget(prev);
  renderer.autoClear = auto;
}

/** A subset of a level's slots, as quads (one per slot, in the slots' xy rect: the same for
 *  the core and the atlas, whose widths are both slots × S), grouped by slot layer. */
export class SlotSet {
  readonly geo = new THREE.BufferGeometry();
  /** Per group: slot layer, first quad, end quad. */
  readonly groups: [number, number, number][] = [];
  readonly n: number;
  readonly slots: Int32Array;
  private scenes = new Map<THREE.Material, THREE.Scene>();
  constructor(slots: Int32Array | number[], sx: number) {
    const sorted = Int32Array.from(slots).sort();
    const pos = new Float32Array(sorted.length * 18);
    let q = 0;
    for (let k = 0; k < sorted.length; k++) {
      const s = sorted[k], sz = Math.floor(s / (sx * sx)), x = s % sx, y = Math.floor(s / sx) % sx;
      if (k > 0 && sz === this.groups[this.groups.length - 1][0]) this.groups[this.groups.length - 1][2] = k + 1;
      else this.groups.push([sz, k, k + 1]);
      const x0 = x / sx * 2 - 1, x1 = (x + 1) / sx * 2 - 1, y0 = y / sx * 2 - 1, y1 = (y + 1) / sx * 2 - 1;
      pos.set([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0], q); q += 18;
    }
    this.n = sorted.length;
    this.slots = sorted;
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  }
  /** Quads [q0, q1) with this material into target (slot size S, from layer zOff on). */
  draw(renderer: THREE.WebGLRenderer, t: THREE.WebGL3DRenderTarget, mat: THREE.Material, cam: THREE.Camera, S: number, setZ: (z: number) => void, q0: number, q1: number, zOff = 0) {
    let sc = this.scenes.get(mat);
    if (!sc) { sc = new THREE.Scene(); const m = new THREE.Mesh(this.geo, mat); m.frustumCulled = false; sc.add(m); this.scenes.set(mat, sc); }
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    for (const [sz, a0, b0] of this.groups) {
      const a = Math.max(a0, q0), b = Math.min(b0, q1);
      if (b <= a) continue;
      this.geo.setDrawRange(a * 6, (b - a) * 6);
      for (let z = sz * S; z < sz * S + S; z++) {
        setZ(z);
        renderer.setRenderTarget(t, z + zOff);
        renderer.render(sc, cam);
      }
    }
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }
  dispose() { this.geo.dispose(); }
}

/** The curvature atlas: each sample's value and its second differences along x, y, z
 *  (inside its own brick: at the faces, the next sample in), from the value atlas. */
export const CURV = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
out vec4 fragColor;
uniform sampler3D uAtlas;
uniform int uS;
uniform float uZ;
void main() {
  ivec3 a = ivec3(ivec2(gl_FragCoord.xy), int(uZ + 0.5));
  ivec3 sl = a / uS, l = a - sl * uS, base = sl * uS;
  ivec3 j = clamp(l, ivec3(1), ivec3(uS - 2));
  float v = texelFetch(uAtlas, a, 0).r;
  vec3 d2;
  for (int k = 0; k < 3; k++) {
    ivec3 e = ivec3(k == 0, k == 1, k == 2);
    ivec3 c = l + e * (j[k] - l[k]);
    d2[k] = texelFetch(uAtlas, base + c - e, 0).r - 2.0 * texelFetch(uAtlas, base + c, 0).r + texelFetch(uAtlas, base + c + e, 0).r;
  }
  fragColor = vec4(v, d2);
}`;

/** The shading atlas, beside the read atlas: each sample's unit normal (from the values:
 *  central differences, second-order one-sided at the brick's faces) and its occlusion
 *  (the settled pass's 4 taps along that normal on the coarse field), so a brick hit shades
 *  from one filtered read. */
export const SHADE = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
out vec4 fragColor;
uniform sampler3D uAtlas;
uniform sampler3D uTex;
uniform sampler2D uSlotTab;
uniform ivec3 uSlots;
uniform int uS;
uniform float uZ;
uniform vec3 uO;
uniform float uH;
uniform vec3 uInvN;
uniform vec3 uNm1;
float bakedField(vec3 p) { return texture(uTex, (clamp((p - uO) / uH, vec3(0.0), uNm1) + 0.5) * uInvN).r; }
void main() {
  ivec3 a = ivec3(ivec2(gl_FragCoord.xy), int(uZ + 0.5));
  ivec3 sl = a / uS, l = a - sl * uS;
  int slot = (sl.z * uSlots.y + sl.y) * uSlots.x + sl.x;
  vec3 cell = texelFetch(uSlotTab, ivec2(slot & 4095, slot >> 12), 0).xyz;
  vec3 g;
  for (int k = 0; k < 3; k++) {
    ivec3 e = ivec3(k == 0, k == 1, k == 2);
    if (l[k] == 0) g[k] = -1.5 * texelFetch(uAtlas, a, 0).r + 2.0 * texelFetch(uAtlas, a + e, 0).r - 0.5 * texelFetch(uAtlas, a + 2 * e, 0).r;
    else if (l[k] == uS - 1) g[k] = 1.5 * texelFetch(uAtlas, a, 0).r - 2.0 * texelFetch(uAtlas, a - e, 0).r + 0.5 * texelFetch(uAtlas, a - 2 * e, 0).r;
    else g[k] = 0.5 * (texelFetch(uAtlas, a + e, 0).r - texelFetch(uAtlas, a - e, 0).r);
  }
  vec3 n = length(g) > 0.0 ? normalize(g) : vec3(0.0, 1.0, 0.0);
  vec3 p = uO + (floor(cell + 0.5) * ${BRICK_B.toFixed(1)} + vec3(l) * (${BRICK_B.toFixed(1)} / float(uS - 1))) * uH;
  float occ = 0.0, sca = 1.0;
  for (int k = 0; k < 4; k++) { float h = 0.15 + 0.6 * float(k); occ += (h - bakedField(p + n * h)) * sca; sca *= 0.75; }
  fragColor = vec4(n, clamp(1.0 - 0.18 * occ, 0.0, 1.0));
}`;

/** Cone pre-pass: one ray per block of CONE_PX × CONE_PX pixels, with a cone wide enough
 *  to hold the block's rays, marched on the coarse field (one read per step) until the
 *  cone comes within a margin of the surface; every ray of the block starts there. */
export const CONE = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
in vec2 vNdc;
out vec4 fragColor;
uniform sampler3D uTex;
uniform vec3 uO;
uniform vec3 uSize;
uniform float uH;
uniform mat4 uInvProjView;
uniform vec4 uClip;
uniform int uClipOn;
uniform float uPixelAngle;
uniform float uPixelSize;
uniform vec3 uInvN;
uniform vec3 uNm1;
uniform vec2 uFull; // the full frame's size (pixels)
void main() {
  vec2 ndc = (floor(gl_FragCoord.xy) * ${CONE_PX.toFixed(1)} + ${(CONE_PX / 2).toFixed(1)}) / uFull * 2.0 - 1.0;
  vec4 a = uInvProjView * vec4(ndc, -1.0, 1.0), b = uInvProjView * vec4(ndc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w, rd = normalize(b.xyz / b.w - ro);
  vec3 lo = uO, hi = uO + uSize;
  vec3 inv = 1.0 / rd, ta = (lo - ro) * inv, tb = (hi - ro) * inv;
  vec3 mn = min(ta, tb), mx = max(ta, tb);
  float t0 = max(max(mn.x, mn.y), mn.z), t1 = min(min(mx.x, mx.y), mx.z);
  if (t1 <= max(t0, 0.0)) { fragColor = vec4(1e10); return; }
  float t = max(t0, 0.0);
  // the block's rays lie within this radius of the centre ray (perspective: grows with t)
  float k = ${CONE_R.toFixed(3)} * uPixelAngle, r0 = ${CONE_R.toFixed(3)} * uPixelSize + ${CONE_MARGIN.toFixed(3)} * uH;
  // every step is safe for all the block's rays, so wherever the loop stops (near, or out
  // of steps) they may start; only a cone that leaves the box lets them all go
  bool gone = false;
  for (int i = 0; i < 160; i++) {
    vec3 p = ro + rd * t;
    float d = texture(uTex, (clamp((p - uO) / uH, vec3(0.0), uNm1) + 0.5) * uInvN).r;
    if (uClipOn == 1) d = max(d, -(dot(p, uClip.xyz) + uClip.w));
    float r = k * t + r0;
    if (d < r + 0.25 * uH) break;
    // a safe step for every ray of the cone: the cone widens as it goes
    t += (d - r) / (1.0 + k);
    if (t > t1) { gone = true; break; }
  }
  fragColor = vec4(gone ? 1e10 : t);
}`;

/** Scatter the exactly resolved pixels back into the frame: one point per list entry. */
export const SCATTER_V = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uList;
uniform sampler2D uRes;
uniform vec2 uViewSize;
flat out vec4 vRes;
void main() {
  int k = gl_VertexID, q = k >> 2;
  ivec2 c = ivec2((q % ${LIST_W / 2}) * 2 + (k & 1), (q / ${LIST_W / 2}) * 2 + ((k >> 1) & 1));
  vec4 en = texelFetch(uList, c, 0);
  vRes = texelFetch(uRes, c, 0);
  gl_Position = vec4((en.xy + 0.5) / uViewSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;
export const SCATTER_F = /* glsl */ `
precision highp float;
flat in vec4 vRes;
out vec4 fragColor;
void main() {
  if (vRes.z < 0.5) { fragColor = vec4(0.0); gl_FragDepth = 1.0; return; }
  float v = vRes.x;
  fragColor = vec4(mod(v, 256.0), mod(floor(v / 256.0), 256.0), floor(v / 65536.0), 255.0) / 255.0;
  gl_FragDepth = vRes.y;
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
  private curvScene = new THREE.Scene();
  private curvMat: THREE.ShaderMaterial;
  private shadeScene = new THREE.Scene();
  readonly shadeMat: THREE.ShaderMaterial;
  slotTex: THREE.DataTexture | null = null;
  readonly slots = new Int32Array(3);
  count = 0;
  /** Slots the atlases hold room for. */
  cap = 0;
  /** Rows of a target with slot size S that hold slots [0, count) (whole slot layers). */
  rowsUsed(t: THREE.WebGL3DRenderTarget, S: number) { return t.height * Math.min(t.depth, Math.max(1, Math.ceil(this.count / (this.slots[0] * this.slots[1]))) * S); }
  private scene = new THREE.Scene();
  private bakeMat: THREE.ShaderMaterial;
  private maskScene = new THREE.Scene();
  private maskRT: THREE.WebGLRenderTarget | null = null;
  private maskPts: THREE.Points | null = null;
  private maskPtsScene = new THREE.Scene();
  /** Whether the mask target holds rows for this many slots (an incremental bake redoes only its slots). */
  maskRows(): number { return this.maskRT ? this.maskRT.height / 2 : 0; }
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(readonly N: number, private frag: string, private uniforms: Record<string, THREE.IUniform>) {
    this.S = N + 1;
    const mat = this.bakeMat = new THREE.ShaderMaterial({
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
    this.curvMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: CURV, depthTest: false, depthWrite: false,
      uniforms: { uAtlas: { value: null }, uS: { value: this.S }, uZ: { value: 0 } },
    });
    this.shadeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: SHADE, depthTest: false, depthWrite: false,
      uniforms: {
        uAtlas: { value: null }, uTex: { value: null }, uSlotTab: { value: null }, uSlots: { value: this.slots }, uS: { value: this.S }, uZ: { value: 0 },
        uO: { value: new THREE.Vector3() }, uH: { value: 1 }, uInvN: { value: new THREE.Vector3() }, uNm1: { value: new THREE.Vector3() },
      },
    });
    const gm = new THREE.Mesh(tri(), this.shadeMat);
    gm.frustumCulled = false;
    this.shadeScene.add(gm);
    const vm = new THREE.Mesh(tri(), this.curvMat);
    vm.frustumCulled = false;
    this.curvScene.add(vm);
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
  /** Rows [r0, r0 + n) of the mask target (set up at r0 = 0). Returns its height. */
  masks(renderer: THREE.WebGLRenderer, origin: THREE.Vector3, h: number, r0: number, n: number) {
    const rows = this.slotTex!.image.height;
    if (r0 === 0 && (!this.maskRT || this.maskRT.height !== 2 * rows)) {
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
    const rt = this.maskRT!, H = rt.height;
    n = Math.min(n, H - r0);
    if (n <= 0) return H;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    rt.scissor.set(0, r0, rt.width, n);
    rt.scissorTest = r0 > 0 || n < H;
    renderer.setRenderTarget(rt);
    renderer.render(this.maskScene, this.cam);
    rt.scissorTest = false;
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
    return H;
  }

  /** The masks of these slots only (points at their two texels; the mask target as it is otherwise). */
  maskSlots(renderer: THREE.WebGLRenderer, origin: THREE.Vector3, h: number, slots: Int32Array | number[]) {
    const rt = this.maskRT;
    if (!rt || !slots.length) return;
    const H = rt.height, pos = new Float32Array(slots.length * 6);
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k], x = ((s & 4095) + 0.5) / 4096 * 2 - 1;
      for (let r = 0; r < 2; r++) pos.set([x, (2 * (s >> 12) + r + 0.5) / H * 2 - 1, 0], k * 6 + r * 3);
    }
    if (!this.maskPts) {
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: 'out vec2 vNdc; void main(){ vNdc = position.xy; gl_PointSize = 1.0; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: this.frag,
        uniforms: this.uniforms, defines: { SDF_MASK: 1 }, depthTest: false, depthWrite: false,
      });
      this.maskPts = new THREE.Points(new THREE.BufferGeometry(), mat);
      this.maskPts.frustumCulled = false;
      this.maskPtsScene.add(this.maskPts);
    }
    this.maskPts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const u = this.uniforms;
    u.uBakeO.value.copy(origin);
    u.uBakeH.value = h;
    u.uStartT.value = this.slotTex;
    u.uBrickCell.value = BRICK_B;
    u.uBrickReach.value = (0.87 * BRICK_B + BRICK_REACH) * h;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.render(this.maskPtsScene, this.cam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }

  /** Lay out the atlas for these cells (x, y, z triples). */
  layout(cells: number[], slack = 1, keep = false) {
    const count = cells.length / 3;
    this.count = count;
    const sx = Math.floor(ATLAS_W / this.S), az = Math.max(1, Math.ceil(count * slack / (sx * sx)));
    this.slots.set([sx, sx, az]);
    const rows = Math.max(1, Math.ceil(count / 4096));
    const st = new Float32Array(4096 * rows * 4);
    for (let s = 0; s < count; s++) { st[s * 4] = cells[s * 3]; st[s * 4 + 1] = cells[s * 3 + 1]; st[s * 4 + 2] = cells[s * 3 + 2]; }
    this.cap = sx * sx * az;
    this.slotTex?.dispose();
    this.slotTex = new THREE.DataTexture(st, 4096, rows, THREE.RGBAFormat, THREE.FloatType);
    this.slotTex.minFilter = this.slotTex.magFilter = THREE.NearestFilter;
    this.slotTex.needsUpdate = true;
    const make = (old: THREE.WebGL3DRenderTarget | null, S: number, rgba = false) => {
      const W = sx * S, D = count ? az * S : 1;
      if (old && old.width === W && old.height === W && old.depth >= D && (keep || old.depth <= D + 2 * S)) { this.cap = sx * sx * Math.floor(old.depth / S); return old; }
      old?.dispose();
      const t = new THREE.WebGL3DRenderTarget(W, W, D, { type: THREE.HalfFloatType, format: rgba ? THREE.RGBAFormat : THREE.RedFormat, depthBuffer: false });
      dlog('gpu-alloc', { what: rgba ? 'brick atlas rgba' : 'brick atlas', dims: `${W}x${W}x${D}`, mb: +(W * W * D * (rgba ? 8 : 2) / 1048576).toFixed(1) });
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
  /** The target the brick samples are baked into, and the one the copy pass fills (or null). */
  get bakeTarget() { return (APRON_COPY ? this.core : this.atlas)!; }
  get copyTarget() { return APRON_COPY ? this.atlas : null; }
  /** Rows [r0, r0 + n) of this level's part of the read atlas (from layer zOff on): its
   *  values and second differences. */
  curv(renderer: THREE.WebGLRenderer, read: THREE.WebGL3DRenderTarget, zOff: number, r0: number, n: number, shadeT: THREE.WebGL3DRenderTarget | null = null) {
    const u = this.curvMat.uniforms;
    u.uAtlas.value = this.atlas!.texture;
    drawRows(renderer, read, this.curvScene, this.cam, (z) => { u.uZ.value = z; }, r0, n, zOff, this.atlas!.height);
    if (!shadeT) return;
    const g = this.shadeMat.uniforms;
    g.uAtlas.value = this.atlas!.texture; g.uSlotTab.value = this.slotTex;
    drawRows(renderer, shadeT, this.shadeScene, this.cam, (z) => { g.uZ.value = z; }, r0, n, zOff, this.atlas!.height);
  }

  copy(renderer: THREE.WebGLRenderer, level: number, levels: BrickLevel[], ind: THREE.Data3DTexture, cells: Int32Array, r0: number, n: number, set: SlotSet | null = null) {
    if (!APRON_COPY || !this.count) return;
    const u = this.copyMat.uniforms;
    u.uCore0.value = levels[0].core!.texture; u.uCore1.value = levels[1].core?.texture ?? levels[0].core!.texture;
    u.uInd.value = ind; u.uSlotTab.value = this.slotTex;
    u.uSlots0.value = levels[0].slots; u.uSlots1.value = levels[1].slots; u.uCells.value = cells; u.uLevel.value = level;
    if (set) set.draw(renderer, this.atlas!, this.copyMat, this.cam, this.S, (z) => { u.uZ.value = z; }, r0, r0 + n);
    else drawRows(renderer, this.atlas!, this.copyScene, this.cam, (z) => { u.uZ.value = z; }, r0, n);
  }

  /** Slots [q0, q1) of a set: the curvature pass (read atlas) or the shading pass (shadeT). */
  curvSet(renderer: THREE.WebGLRenderer, read: THREE.WebGL3DRenderTarget, zOff: number, set: SlotSet, q0: number, q1: number, shadeT: THREE.WebGL3DRenderTarget | null) {
    if (!shadeT) {
      const u = this.curvMat.uniforms;
      u.uAtlas.value = this.atlas!.texture;
      set.draw(renderer, read, this.curvMat, this.cam, this.S, (z) => { u.uZ.value = z; }, q0, q1, zOff);
      return;
    }
    const g = this.shadeMat.uniforms;
    g.uAtlas.value = this.atlas!.texture; g.uSlotTab.value = this.slotTex;
    set.draw(renderer, shadeT, this.shadeMat, this.cam, this.S, (z) => { g.uZ.value = z; }, q0, q1, zOff);
  }

  /** Bake rows [r0, r0 + n) of the brick samples (or slots [r0, r0 + n) of a set). */
  draw(renderer: THREE.WebGLRenderer, origin: THREE.Vector3, h: number, r0: number, n: number, set: SlotSet | null = null) {
    const u = this.uniforms;
    u.uBakeO.value.copy(origin);
    u.uBakeH.value = h;
    u.uStartT.value = this.slotTex;
    u.uBrickMask.value = this.maskRT!.texture;
    (u.uBrickSlots.value as Int32Array).set(this.slots);
    u.uBrickCell.value = BRICK_B;
    u.uBrickStep.value = BRICK_B / this.N;
    u.uBrickFar.value = BRICK_FAR * h;
    if (set) set.draw(renderer, this.bakeTarget, this.bakeMat, this.cam, APRON_COPY ? this.N : this.S, (z) => { u.uBakeZ.value = z; }, r0, r0 + n);
    else drawRows(renderer, this.bakeTarget, this.scene, this.cam, (z) => { u.uBakeZ.value = z; }, r0, n);
  }

  dispose() { this.maskRT?.dispose(); this.maskRT = null; this.atlas?.dispose(); this.atlas = null; this.core?.dispose(); this.core = null; this.slotTex?.dispose(); this.slotTex = null; this.count = 0; }
}
