// GPU raymarcher for the SDF kernel: the scene field is evaluated per pixel in a
// fragment shader. No triangles anywhere: outer surfaces and joins are exact at
// any zoom. The inner wall comes from each group's cavity-depth grid (a smooth
// distance field in a 3D texture), or from an analytic approximation while a
// grid is being rebuilt.
//
// The shader is fixed: objects, groups and pins are data (a float texture and
// uniform arrays), so editing anything — even adding objects or toggling
// openings — never recompiles.

import * as THREE from 'three';
import type { CavityGrid } from '../engine/cavity';
import type { SceneDoc } from '../engine/document';
import { polygonSDF } from '../engine/math';
import { sampleProfile } from '../engine/profile';
import type { CompiledObject } from '../engine/primitives';
import { type CompiledGroup, OPENING_EPS, compileGroups } from '../engine/scene';

const MAX_GROUPS = 8;
const MAX_GRIDS = 4;
const MAX_PROFILES = 8;
const MAX_PINS = 32;
const ROWS = 8; // texels per object in the data texture
const PROFILE_RES: [number, number] = [160, 320];
const PROFILE_SAMPLES = 64; // curve samples per profile span for the tables
const TYPE_CODE: Record<string, number> = { sphere: 0, box: 1, cylinder: 2, cone: 3, torus: 4, capsule: 5, prism: 6, revolve: 7 };

interface ProfileTex { tex: THREE.DataTexture; min: [number, number]; max: [number, number] }

const range = (n: number) => Array.from({ length: n }, (_, i) => i);



const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
in vec2 vNdc;
layout(location = 0) out highp vec4 pc_fragColor;
uniform mat4 uInvProjView;
uniform mat4 uProjView;
uniform sampler2D uData;
uniform vec4 uClip;
uniform int uClipOn;
uniform int uFlat;
uniform vec3 uClay;
uniform vec3 uCap;
uniform vec3 uBoundsMin;
uniform vec3 uBoundsMax;
uniform float uPixelAngle;
uniform int uGroupCount;
uniform ivec4 uGroupRange[${MAX_GROUPS}];   // shells start, solids start, subs start, end
uniform ivec2 uPinRange[${MAX_GROUPS}];
uniform vec4 uGroupC[${MAX_GROUPS}];
uniform vec4 uGroupE[${MAX_GROUPS}];
uniform float uT[${MAX_GROUPS}];
uniform float uK[${MAX_GROUPS}];
uniform int uHollow[${MAX_GROUPS}];
uniform int uUseGrid[${MAX_GRIDS}];
uniform float uCavH[${MAX_GRIDS}];
uniform vec4 uPins[${MAX_PINS * 2}];
${range(MAX_GRIDS).map((i) => `uniform sampler3D uCav${i}; uniform vec3 uCavO${i}; uniform vec3 uCavS${i}; uniform float uCavC${i};`).join('\n')}
${range(MAX_PROFILES).map((i) => `uniform sampler2D uProf${i}; uniform vec2 uProfLo${i}; uniform vec2 uProfHi${i};`).join('\n')}

vec4 row(int obj, int r) { return texelFetch(uData, ivec2(r, obj), 0); }
vec3 toLocal(int o, vec3 p) {
  vec4 p4 = vec4(p, 1.0);
  return vec3(dot(row(o, 0), p4), dot(row(o, 1), p4), dot(row(o, 2), p4));
}
float sdBox(vec3 q, vec3 b) { vec3 d = abs(q) - b; return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0); }
float extrude(float d2, float y, float hh) { vec2 w = vec2(d2, abs(y) - hh); return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)); }
float segDist(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float sdCone2(vec2 q, float r, float hh) {
  float d = min(segDist(q, vec2(0.0, -hh), vec2(r, -hh)), segDist(q, vec2(r, -hh), vec2(0.0, hh)));
  bool inside = q.y > -hh && q.y < hh && q.x < r * (hh - q.y) / (2.0 * hh);
  return inside ? -d : d;
}
float sdPin(vec3 p, vec3 a, vec3 b, float r) {
  vec3 ba = b - a, pa = p - a;
  float baba = dot(ba, ba), paba = dot(pa, ba);
  float x = length(pa * baba - ba * paba) - r * baba;
  float y = abs(paba - baba * 0.5) - baba * 0.5;
  float x2 = x * x, y2 = y * y * baba;
  float d = (max(x, y) < 0.0) ? -min(x2, y2) : (((x > 0.0) ? x2 : 0.0) + ((y > 0.0) ? y2 : 0.0));
  return sign(d) * sqrt(abs(d)) / baba;
}
float profileLookup(sampler2D tex, vec2 lo, vec2 hi, vec2 q, int ch) {
  vec2 c = clamp(q, lo, hi);
  vec2 o = q - c;
  o.x = max(o.x, 0.0); // r below the first texel centre is still inside the table
  float outside = length(o);
  float v = texture(tex, (c - lo) / (hi - lo))[ch];
  if (ch == 1) return v;
  return outside > 0.0 ? max(outside, v) : v; // the table has margin around the shape
}
float profile(int slot, vec2 q, int ch) {
${range(MAX_PROFILES).map((i) => `  if (slot == ${i}) return profileLookup(uProf${i}, uProfLo${i}, uProfHi${i}, q, ch);`).join('\n')}
  return 1e5;
}
float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
bool bit(int mask, int n) { return ((mask >> n) & 1) == 1; }
// Regular n-gon frustum along Y: P = (n, bottom radius, half height, top radius).
// Signed distance to the side plane at angle 'a' (outward normal), from (u, y)
// where u is the coordinate along that normal.
float frustumSide(float u, float y, vec4 P) {
  float c = cos(3.14159265 / P.x);
  float ap1 = P.y * c, ap2 = P.w * c, h = 2.0 * P.z;
  return ((u - ap1) * h + (y + P.z) * (ap1 - ap2)) / length(vec2(h, ap1 - ap2));
}
float sdFrustum(vec3 q, vec4 P) {
  float an = 3.14159265 / P.x;
  // side normals point at angles (2k+1)*an; b = angle from the nearest one
  float b = mod(atan(q.z, q.x), 2.0 * an) - an;
  float side = frustumSide(length(q.xz) * cos(b), q.y, P);
  return max(side, abs(q.y) - P.z);
}

float sdLocal(vec3 q, vec4 P, int type, int slot) {
  if (type == 0) return length(q) - P.x;
  if (type == 1) return sdBox(q, P.xyz);
  if (type == 2) return extrude(length(q.xz) - P.x, q.y, P.y);
  if (type == 3) return sdCone2(vec2(length(q.xz), q.y), P.x, P.y);
  if (type == 4) return length(vec2(length(q.xz) - P.x, q.y)) - P.y;
  if (type == 5) return length(vec3(q.x, q.y - clamp(q.y, -P.y, P.y), q.z)) - P.x;
  if (type == 6) return sdFrustum(q, P);
  return profile(slot, vec2(length(q.xz), q.y), 0);
}
float sdObj(int i, vec3 p) {
  vec4 meta = row(i, 6);
  return sdLocal(toLocal(i, p), row(i, 3), int(meta.x), int(meta.y)) * row(i, 4).w;
}
// lower bound from the object's bounding sphere
float bound(int i, vec3 p) { vec4 b = row(i, 5); return length(p - b.xyz) - b.w; }

// depth (world units) below this object's surface, ignoring faces that are openings
float holeDepth(int i, vec3 p) {
  vec3 q = toLocal(i, p);
  vec4 P = row(i, 3), S = row(i, 4), meta = row(i, 6);
  int type = int(meta.x), slot = int(meta.y), mask = int(meta.z);
  float d = 1e5;
  if (type == 0 || type == 4 || type == 5) return bit(mask, 0) ? 1e5 : -sdLocal(q, P, type, slot) * S.w;
  if (type == 1) {
    if (!bit(mask, 0)) d = min(d, (P.x - q.x) * S.x);
    if (!bit(mask, 1)) d = min(d, (P.x + q.x) * S.x);
    if (!bit(mask, 2)) d = min(d, (P.y - q.y) * S.y);
    if (!bit(mask, 3)) d = min(d, (P.y + q.y) * S.y);
    if (!bit(mask, 4)) d = min(d, (P.z - q.z) * S.z);
    if (!bit(mask, 5)) d = min(d, (P.z + q.z) * S.z);
    return d;
  }
  if (type == 2) {
    if (!bit(mask, 0)) d = min(d, (P.x - length(q.xz)) * min(S.x, S.z));
    if (!bit(mask, 1)) d = min(d, (P.y - q.y) * S.y);
    if (!bit(mask, 2)) d = min(d, (P.y + q.y) * S.y);
    return d;
  }
  if (type == 3) {
    if (!bit(mask, 0)) d = min(d, (P.y + q.y) * S.y);
    if (!bit(mask, 1)) d = min(d, segDist(vec2(length(q.xz), q.y), vec2(P.x, -P.y), vec2(0.0, P.y)) * S.w);
    return d;
  }
  if (type == 6) {
    if (!bit(mask, 0)) d = min(d, (P.z - q.y) * S.y);
    if (!bit(mask, 1)) d = min(d, (P.z + q.y) * S.y);
    float n = P.x;
    for (int k = 0; k < 12; k++) {
      if (float(k) >= n) break;
      if (bit(mask, 2 + k)) continue;
      float a = 6.2831853 * (float(k) - 0.5) / n;
      d = min(d, -frustumSide(dot(q.xz, vec2(cos(a), sin(a))), q.y, P) * min(S.x, S.z));
    }
    return d;
  }
  return profile(slot, vec2(length(q.xz), q.y), 1) * S.w;
}

// Tricubic B-spline lookup from 8 trilinear fetches (smooth, no texel banding).
// f is in texel units with texel centres at integers.
float cubicR(sampler3D tex, vec3 f, vec3 dims) {
  vec3 i = floor(f), x = f - i, o = 1.0 - x;
  vec3 w0 = o * o * o / 6.0;
  vec3 w1 = (4.0 - 6.0 * x * x + 3.0 * x * x * x) / 6.0;
  vec3 w2 = (1.0 + 3.0 * x + 3.0 * x * x - 3.0 * x * x * x) / 6.0;
  vec3 w3 = x * x * x / 6.0;
  vec3 g0 = w0 + w1, g1 = w2 + w3;
  vec3 a = (i - 1.0 + w1 / g0 + 0.5) / dims;
  vec3 b = (i + 1.0 + w3 / g1 + 0.5) / dims;
  float v000 = texture(tex, vec3(a.x, a.y, a.z)).r, v100 = texture(tex, vec3(b.x, a.y, a.z)).r;
  float v010 = texture(tex, vec3(a.x, b.y, a.z)).r, v110 = texture(tex, vec3(b.x, b.y, a.z)).r;
  float v001 = texture(tex, vec3(a.x, a.y, b.z)).r, v101 = texture(tex, vec3(b.x, a.y, b.z)).r;
  float v011 = texture(tex, vec3(a.x, b.y, b.z)).r, v111 = texture(tex, vec3(b.x, b.y, b.z)).r;
  float y0 = g0.y * (g0.x * v000 + g1.x * v100) + g1.y * (g0.x * v010 + g1.x * v110);
  float y1 = g0.y * (g0.x * v001 + g1.x * v101) + g1.y * (g0.x * v011 + g1.x * v111);
  return g0.z * y0 + g1.z * y1;
}

// Cavity depth from grid k: the analytic base depth A plus the grid's correction
// (trilinear far from the inner wall, tricubic near it). A must match scene.baseDepth.
float gridDepth(int k, vec3 p, float wall, float A) {
${range(MAX_GRIDS).map((i) => `  if (k == ${i}) {
    vec3 dims = vec3(textureSize(uCav${i}, 0));
    vec3 tc = (p - uCavO${i}) * uCavS${i} + 0.5 / dims;
    if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return -uCavC${i};
    A = clamp(A, -uCavC${i}, uCavC${i});
    float d = A + texture(uCav${i}, tc).r;
    if (abs(d - wall) < 2.0 * uCavH[${i}]) d = A + cubicR(uCav${i}, tc * dims - 0.5, dims);
    // keep the field 1-Lipschitz: the far-interior correction is only a 'deep' flag
    return clamp(d, -uCavC${i}, uCavC${i});
  }`).join('\n')}
  return -1e5;
}

int gKind;        // 0 clay, 1 section cap, 2 cavity wall
float gCavH;
bool gNoClip = false;

float map(vec3 p) {
  float s = 1e5;
  int kind = 0;
  gCavH = 0.0;
  for (int g = 0; g < ${MAX_GROUPS}; g++) {
    if (g >= uGroupCount) break;
    if (sdBox(p - uGroupC[g].xyz, uGroupE[g].xyz) >= s) continue;
    ivec4 R = uGroupRange[g];
    float fs = 1e5, fo = 1e5, cut = 1e5, cav = 1e5, kb = uK[g];
    for (int i = R.x; i < R.y; i++) {
      float b = bound(i, p);
      fs = smin(fs, b < max(fs, 0.0) + 0.5 + kb ? sdObj(i, p) : b, kb);
    }
    for (int i = R.y; i < R.z; i++) {
      float b = bound(i, p);
      fo = smin(fo, b < max(min(fs, fo), 0.0) + 0.5 + kb ? sdObj(i, p) : b, kb);
    }
    float G = smin(fs, fo, kb);
    if (uHollow[g] == 1 && fs < ${OPENING_EPS.toFixed(3)}) {
      // Depth below the shell surface. A: the deepest single-object depth, exact
      // wherever one object's surface is nearest. The cavity grid stores the
      // correction to A, which only matters near joins, blends and shared openings.
      // (smooth max over two texels where the deepest object switches; see scene.baseDepth)
      bool useGrid = g < ${MAX_GRIDS} && uUseGrid[min(g, ${MAX_GRIDS - 1})] == 1;
      float kA = useGrid ? 2.0 * uCavH[min(g, ${MAX_GRIDS - 1})] + kb : 0.0;
      float D = -1e5;
      for (int i = R.x; i < R.y; i++) {
        // (exact for every shell, no bounding-sphere shortcut: a jump in any term
        // would show through the smooth max)
        float d = sdObj(i, p);
        d = d > 0.0 ? -d : holeDepth(i, p);
        D = -smin(-D, -d, kA);
      }
      if (useGrid) D = gridDepth(g, p, uT[g], D);
      cav = max(fs - ${OPENING_EPS.toFixed(3)}, uT[g] - D);
      cut = cav;
    }
    for (int i = R.z; i < R.w; i++) {
      float b = bound(i, p);
      cut = min(cut, b < cut + 0.5 ? sdObj(i, p) : b);
    }
    ivec2 PR = uPinRange[g];
    for (int k = PR.x; k < PR.y; k++) cut = min(cut, sdPin(p, uPins[2 * k].xyz, uPins[2 * k + 1].xyz, uPins[2 * k].w));
    float sg = max(G, -cut);
    if (sg < s) {
      s = sg;
      kind = (-cut > G && cut == cav) ? 2 : 0;
      gCavH = g < ${MAX_GRIDS} ? uCavH[min(g, ${MAX_GRIDS - 1})] : 0.0;
    }
  }
  gKind = kind;
  if (uClipOn == 1 && !gNoClip) { float c = -(dot(p, uClip.xyz) + uClip.w); if (c > s) { s = c; gKind = 1; } }
  return s;
}

vec3 calcNormal(vec3 p, float e) {
  // looped so the compiler emits map() once here (keeps the shader small)
  vec3 n = vec3(0.0);
  for (int i = min(uGroupCount, 0); i < 4; i++) {
    vec3 k = 0.5773 * (2.0 * vec3((((i + 3) >> 1) & 1), ((i >> 1) & 1), (i & 1)) - 1.0);
    n += k * map(p + k * e);
  }
  return normalize(n);
}
float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  gNoClip = true; // occlusion comes from the clay only, not the section plane
  for (int i = min(uGroupCount, 0); i < 4; i++) {
    float h = 0.15 + 0.6 * float(i);
    float d = map(p + n * h);
    occ += (h - d) * sca; sca *= 0.75;
  }
  gNoClip = false;
  return clamp(1.0 - 0.18 * occ, 0.0, 1.0);
}
bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 a = (uBoundsMin - ro) * inv, b = (uBoundsMax - ro) * inv;
  vec3 lo = min(a, b), hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z); t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}
void main() {
  vec4 a = uInvProjView * vec4(vNdc, -1.0, 1.0);
  vec4 b = uInvProjView * vec4(vNdc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w;
  vec3 rd = normalize(b.xyz / b.w - ro);
  float t0, t1;
  if (uGroupCount == 0 || !boxHit(ro, rd, t0, t1)) discard;
  float t = max(t0, 0.0);
  bool hit = false;
  for (int i = 0; i < 200; i++) {
    float d = map(ro + rd * t);
    float eps = clamp(uPixelAngle * t * 0.35, 0.0008, 0.008);
    if (d < eps) { hit = true; break; }
    t += max(d * 0.92, eps * 0.5);
    if (t > t1) break;
  }
  if (!hit) discard;
  vec3 p = ro + rd * t;
  vec4 clip = uProjView * vec4(p, 1.0);
  gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  if (uFlat == 1) { pc_fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  int kind = gKind; // set by the last map() call, at p
  // the inner wall comes from an interpolated grid: take its normal over half a
  // texel so texel boundaries don't show as facets
  float ne = max(0.0008, uPixelAngle * t * 0.5);
  if (kind == 2 && gCavH > 0.0) ne = max(ne, 0.25 * gCavH);
  vec3 n = calcNormal(p, ne);
  if (dot(n, rd) > 0.0) n = -n;
  vec3 base = kind == 1 ? uCap : uClay;
  vec3 key = normalize(-rd + vec3(0.35, 0.65, 0.2));
  float dif = clamp(dot(n, key), 0.0, 1.0);
  float hemi = 0.55 + 0.45 * n.y;
  float ao = calcAO(p, n);
  vec3 col = base * (0.38 + 0.22 * hemi + 0.62 * dif) * (0.55 + 0.45 * ao);
  col += 0.06 * pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  pc_fragColor = vec4(pow(col, vec3(1.0 / 1.15)), 1.0);
}
`;

export class SdfRenderer {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private dataTex: THREE.DataTexture | null = null;
  private groups: CompiledGroup[] = [];
  private profiles = new Map<string, ProfileTex>();
  private gridTex: (THREE.Data3DTexture | null)[] = [];
  private gridSrc: (CavityGrid | null)[] = [];
  private gridsByIndex: (CavityGrid | null)[] = [];
  /** World-space bounds of everything drawn. */
  bounds = new THREE.Box3();

  constructor() {
    const u: Record<string, THREE.IUniform> = {
      uInvProjView: { value: new THREE.Matrix4() },
      uProjView: { value: new THREE.Matrix4() },
      uData: { value: null },
      uClip: { value: new THREE.Vector4(0, 0, -1, 0) },
      uClipOn: { value: 0 },
      uFlat: { value: 0 },
      uClay: { value: new THREE.Color(0xc8b6a4) },
      uCap: { value: new THREE.Color(0xc0634a) },
      uBoundsMin: { value: new THREE.Vector3() },
      uBoundsMax: { value: new THREE.Vector3() },
      uPixelAngle: { value: 0.0015 },
      uGroupCount: { value: 0 },
      // integer vector arrays must be flat Int32Arrays (three.js does not flatten them)
      uGroupRange: { value: new Int32Array(MAX_GROUPS * 4) },
      uPinRange: { value: new Int32Array(MAX_GROUPS * 2) },
      uGroupC: { value: range(MAX_GROUPS).map(() => new THREE.Vector4()) },
      uGroupE: { value: range(MAX_GROUPS).map(() => new THREE.Vector4()) },
      uT: { value: range(MAX_GROUPS).map(() => 0.5) },
      uK: { value: range(MAX_GROUPS).map(() => 0) },
      uHollow: { value: range(MAX_GROUPS).map(() => 0) },
      uUseGrid: { value: range(MAX_GRIDS).map(() => 0) },
      uCavH: { value: range(MAX_GRIDS).map(() => 0) },
      uPins: { value: range(MAX_PINS * 2).map(() => new THREE.Vector4()) },
    };
    for (const i of range(MAX_GRIDS)) {
      u[`uCav${i}`] = { value: null };
      u[`uCavO${i}`] = { value: new THREE.Vector3() };
      u[`uCavS${i}`] = { value: new THREE.Vector3(1, 1, 1) };
      u[`uCavC${i}`] = { value: 1 };
    }
    for (const i of range(MAX_PROFILES)) {
      u[`uProf${i}`] = { value: null };
      u[`uProfLo${i}`] = { value: new THREE.Vector2() };
      u[`uProfHi${i}`] = { value: new THREE.Vector2(1, 1) };
    }
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'out vec2 vNdc; void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FRAG,
      uniforms: u,
      depthWrite: true,
      depthTest: true,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (_r, _s, camera) => this.beforeRender(camera);
  }

  private beforeRender(camera: THREE.Camera) {
    const u = this.material.uniforms;
    camera.updateMatrixWorld();
    const pv = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uProjView.value.copy(pv);
    u.uInvProjView.value.copy(pv).invert();
    u.uPixelAngle.value = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 0.0015 : 0;
  }

  setStyle(opts: { flat?: boolean; clay?: number; cap?: number }) {
    const u = this.material.uniforms;
    if (opts.flat !== undefined) u.uFlat.value = opts.flat ? 1 : 0;
    if (opts.clay !== undefined) u.uClay.value.set(opts.clay);
    if (opts.cap !== undefined) u.uCap.value.set(opts.cap);
  }

  /** Keep the side the plane normal points to (three.js clipping convention). */
  setClip(plane: THREE.Plane | null) {
    const u = this.material.uniforms;
    u.uClipOn.value = plane ? 1 : 0;
    if (plane) u.uClip.value.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  }

  setDoc(doc: SceneDoc) {
    const groups = compileGroups(doc).slice(0, MAX_GROUPS);
    this.groups = groups;
    const u = this.material.uniforms;
    const objs: CompiledObject[] = [];
    const ranges = u.uGroupRange.value as Int32Array;
    const pinRanges = u.uPinRange.value as Int32Array;
    const pins = u.uPins.value as THREE.Vector4[];
    let pinCount = 0;
    groups.forEach((g, k) => {
      const a = objs.length;
      objs.push(...g.shells);
      const b = objs.length;
      objs.push(...g.solids);
      const c = objs.length;
      objs.push(...g.subs);
      ranges.set([a, b, c, objs.length], 4 * k);
      const p0 = pinCount;
      for (const p of g.pins) {
        if (pinCount >= MAX_PINS) break;
        pins[2 * pinCount].set(p.ax, p.ay, p.az, p.r);
        pins[2 * pinCount + 1].set(p.bx, p.by, p.bz, 0);
        pinCount++;
      }
      pinRanges.set([p0, pinCount], 2 * k);
      const gb = g.bounds;
      (u.uGroupC.value as THREE.Vector4[])[k].set((gb.min[0] + gb.max[0]) / 2, (gb.min[1] + gb.max[1]) / 2, (gb.min[2] + gb.max[2]) / 2, 0);
      (u.uGroupE.value as THREE.Vector4[])[k].set((gb.max[0] - gb.min[0]) / 2 + 0.05, (gb.max[1] - gb.min[1]) / 2 + 0.05, (gb.max[2] - gb.min[2]) / 2 + 0.05, 0);
      (u.uT.value as number[])[k] = g.t;
      (u.uK.value as number[])[k] = g.k;
      (u.uHollow.value as number[])[k] = g.hollow ? 1 : 0;
    });
    u.uGroupCount.value = groups.length;
    const slots = this.updateProfiles(objs, groups);
    this.writeData(objs, groups, slots);
    this.bounds.makeEmpty();
    for (const g of groups) {
      this.bounds.expandByPoint(new THREE.Vector3(...g.bounds.min));
      this.bounds.expandByPoint(new THREE.Vector3(...g.bounds.max));
    }
    if (!this.bounds.isEmpty()) {
      u.uBoundsMin.value.copy(this.bounds.min).subScalar(0.5);
      u.uBoundsMax.value.copy(this.bounds.max).addScalar(0.5);
    }
    this.mesh.visible = groups.length > 0;
    this.bindGrids();
  }

  /** Cavity grids by document group index; null falls back to the analytic depth. */
  setGrids(grids: (CavityGrid | null)[]) {
    this.gridsByIndex = grids;
    this.bindGrids();
  }

  private bindGrids() {
    const u = this.material.uniforms;
    for (let k = 0; k < MAX_GRIDS; k++) {
      const g = this.groups[k];
      const c = g ? this.gridsByIndex[g.index] ?? null : null;
      if (c !== this.gridSrc[k]) {
        this.gridTex[k]?.dispose();
        this.gridTex[k] = null;
        if (c) {
          const half = new Uint16Array(c.data.length);
          for (let q = 0; q < c.data.length; q++) half[q] = THREE.DataUtils.toHalfFloat(c.data[q]);
          const tex = new THREE.Data3DTexture(half, c.dims[0], c.dims[1], c.dims[2]);
          tex.type = THREE.HalfFloatType;
          tex.format = THREE.RedFormat;
          tex.minFilter = tex.magFilter = THREE.LinearFilter;
          tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
          tex.unpackAlignment = 1;
          tex.needsUpdate = true;
          this.gridTex[k] = tex;
        }
        this.gridSrc[k] = c;
      }
      u[`uCav${k}`].value = this.gridTex[k];
      (u.uUseGrid.value as number[])[k] = c ? 1 : 0;
      (u.uCavH.value as number[])[k] = c ? c.h : 0;
      if (c) {
        u[`uCavO${k}`].value.set(...c.origin);
        u[`uCavS${k}`].value.set(1 / (c.h * c.dims[0]), 1 / (c.h * c.dims[1]), 1 / (c.h * c.dims[2]));
        u[`uCavC${k}`].value = c.clampV;
      }
    }
  }

  /** Grids by document group index (for CPU picking). */
  grids(): (CavityGrid | null)[] {
    return this.gridsByIndex;
  }

  compiledGroups(): CompiledGroup[] {
    return this.groups;
  }

  private writeData(objs: CompiledObject[], groups: CompiledGroup[], slots: Map<CompiledObject, number>) {
    const n = Math.max(1, objs.length);
    const data = new Float32Array(ROWS * 4 * n);
    objs.forEach((o, i) => {
      const r = o.rot, s = o.scale, p = o.pos;
      for (let a = 0; a < 3; a++) { // world -> param: S^-1 R^T (x - p)
        const k = (i * ROWS + a) * 4;
        const ra = [r[a], r[3 + a], r[6 + a]];
        data[k] = ra[0] / s[a]; data[k + 1] = ra[1] / s[a]; data[k + 2] = ra[2] / s[a];
        data[k + 3] = -(ra[0] * p[0] + ra[1] * p[1] + ra[2] * p[2]) / s[a];
      }
      const q = o.obj.params;
      const k3 = (i * ROWS + 3) * 4;
      switch (o.obj.type) {
        case 'sphere': data[k3] = q.r!; break;
        case 'box': data[k3] = q.x! / 2; data[k3 + 1] = q.y! / 2; data[k3 + 2] = q.z! / 2; break;
        case 'cylinder': case 'cone': case 'capsule': data[k3] = q.r!; data[k3 + 1] = q.h! / 2; break;
        case 'torus': data[k3] = q.R!; data[k3 + 1] = q.r!; break;
        case 'prism': data[k3] = Math.min(12, Math.max(3, Math.round(q.n!))); data[k3 + 1] = q.r!; data[k3 + 2] = q.h! / 2; data[k3 + 3] = q.r2 ?? q.r!; break;
        default: break;
      }
      const k4 = (i * ROWS + 4) * 4;
      data[k4] = s[0]; data[k4 + 1] = s[1]; data[k4 + 2] = s[2]; data[k4 + 3] = o.minScale;
      const b = o.worldBounds;
      const k5 = (i * ROWS + 5) * 4;
      data[k5] = (b.min[0] + b.max[0]) / 2; data[k5 + 1] = (b.min[1] + b.max[1]) / 2; data[k5 + 2] = (b.min[2] + b.max[2]) / 2;
      data[k5 + 3] = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 + 0.01;
      const g = groups.find((x) => x.shells.includes(o) || x.solids.includes(o) || x.subs.includes(o))!;
      const k6 = (i * ROWS + 6) * 4;
      data[k6] = TYPE_CODE[o.obj.type];
      data[k6 + 1] = slots.get(o) ?? 0;
      data[k6 + 2] = holeMask(o, g);
    });
    if (!this.dataTex || this.dataTex.image.height !== n) {
      this.dataTex?.dispose();
      this.dataTex = new THREE.DataTexture(data, ROWS, n, THREE.RGBAFormat, THREE.FloatType);
      this.dataTex.minFilter = this.dataTex.magFilter = THREE.NearestFilter;
    } else (this.dataTex.image.data as Float32Array).set(data);
    this.dataTex.needsUpdate = true;
    this.material.uniforms.uData.value = this.dataTex;
  }

  /** Revolve profiles as 2D distance tables (R: signed distance, G: depth to non-opening segments). */
  private updateProfiles(objs: CompiledObject[], groups: CompiledGroup[]): Map<CompiledObject, number> {
    const u = this.material.uniforms;
    const slots = new Map<CompiledObject, number>();
    const keep = new Set<string>();
    let slot = 0;
    for (const o of objs) {
      if (o.obj.type !== 'revolve' || slot >= MAX_PROFILES) continue;
      const g = groups.find((x) => x.shells.includes(o) || x.solids.includes(o) || x.subs.includes(o))!;
      const isHole = (f: string) => g.holes.has(`${o.obj.id}|${f}`);
      // Finer than the CPU profile: the inner wall is an offset of this polyline, and
      // coarse segments show as flat bands inside a large pot.
      const prof = sampleProfile(o.obj.params.points ?? [], PROFILE_SAMPLES);
      const key = JSON.stringify([o.obj.params.points, prof.faces.filter(isHole)]);
      keep.add(key);
      let pt = this.profiles.get(key);
      if (!pt) {
        const m = Math.max(1, 0.15 * Math.max(prof.rMax, prof.yMax - prof.yMin));
        const lo: [number, number] = [0, prof.yMin - m], hi: [number, number] = [prof.rMax + m, prof.yMax + m];
        const [W, H] = PROFILE_RES;
        const data = new Uint16Array(W * H * 2);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const r = lo[0] + ((i + 0.5) / W) * (hi[0] - lo[0]);
          const y = lo[1] + ((j + 0.5) / H) * (hi[1] - lo[1]);
          const sd = polygonSDF(prof.pts, prof.n, r, y, prof.axisSeg).d;
          let dh = 6e4;
          for (let s = 0; s < prof.n; s++) {
            const f = prof.segFace[s];
            if (f === 'axis' || isHole(f)) continue;
            const t2 = (s + 1) % prof.n;
            const ax = prof.pts[2 * s], ay = prof.pts[2 * s + 1], bx = prof.pts[2 * t2], by = prof.pts[2 * t2 + 1];
            const ex = bx - ax, ey = by - ay, wx = r - ax, wy = y - ay;
            const tt = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
            dh = Math.min(dh, Math.hypot(wx - ex * tt, wy - ey * tt));
          }
          const q = 2 * (i + W * j);
          data[q] = THREE.DataUtils.toHalfFloat(sd);
          data[q + 1] = THREE.DataUtils.toHalfFloat(dh);
        }
        const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.HalfFloatType);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        // lookups map [min, max] onto the first/last texel centres
        const hx = (hi[0] - lo[0]) / W / 2, hy = (hi[1] - lo[1]) / H / 2;
        pt = { tex, min: [lo[0] + hx, lo[1] + hy], max: [hi[0] - hx, hi[1] - hy] };
        this.profiles.set(key, pt);
      }
      u[`uProf${slot}`].value = pt.tex;
      u[`uProfLo${slot}`].value.set(pt.min[0], pt.min[1]);
      u[`uProfHi${slot}`].value.set(pt.max[0], pt.max[1]);
      slots.set(o, slot);
      slot++;
    }
    for (const [k, v] of this.profiles) if (!keep.has(k)) { v.tex.dispose(); this.profiles.delete(k); }
    return slots;
  }
}

/** Bit mask of a primitive's faces that are openings (layout matches holeDepth in the shader). */
function holeMask(o: CompiledObject, g: CompiledGroup): number {
  const h = (f: string) => g.holes.has(`${o.obj.id}|${f}`);
  let names: string[] = [];
  switch (o.obj.type) {
    case 'sphere': case 'torus': case 'capsule': names = ['surface']; break;
    case 'box': names = ['px', 'nx', 'py', 'ny', 'pz', 'nz']; break;
    case 'cylinder': names = ['side', 'top', 'bottom']; break;
    case 'cone': names = ['base', 'side']; break;
    case 'prism': names = ['top', 'bottom', ...range(Math.max(3, Math.round(o.obj.params.n!))).map((i) => `side${i}`)]; break;
    default: return 0;
  }
  return names.reduce((m, f, i) => (h(f) ? m | (1 << i) : m), 0);
}
