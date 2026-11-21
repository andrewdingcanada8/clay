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
import { type CavityGrid, attachGrid } from '../engine/cavity';
import { type SceneDoc, isCut } from '../engine/document';
import { buildProfileTable, tableProfile } from '../engine/profileTable';
import { MAX_PATH_POINTS, MAX_SECTION_POINTS, sweepGeo } from '../engine/sweep';
import type { CompiledObject } from '../engine/primitives';
import { type CompiledGroup, OPENING_EPS, compileGroups } from '../engine/scene';

const MAX_GROUPS = 8;
const MAX_GRIDS = 4;
const MAX_PROFILES = 8;
const ROWS = 16; // texels per object in the data texture (10 used; a power of two for the program's)
const TYPE_CODE: Record<string, number> = { sphere: 0, box: 1, cylinder: 2, cone: 3, torus: 4, capsule: 5, prism: 6, revolve: 7, sweep: 8 };
const MAX_SWEEPS = 6; // distinct sweep shapes (texture slots); copies of one share its slot
const MAX_SWEEP_OBJS = 64; // sweep objects (copies included), each with its own distance
/** Hole-mask bit marking a mask object (above the faces' bits): no opening, never culled. */
const MASK_FLAG = 256;
/** Layer program: most steps, and deepest group nesting. */
const MAX_PROG = 512;
const MAX_CLUSTERS = 32; // top-level layers, each culled per ray as a whole (see rayMask)
const MAX_DEPTH = 12;
const MAX_LOOP = 4096; // a constant bound for loops over a run of objects (they break first)
// sweep texture rows per slot (indexed by path vertex / segment unless noted):
// 0 point + length so far, 1 segment direction + length, 2/4 section normal square
// to the segment at its start/end + flags of the vertex there (1 miter, 2 round
// corner, 4 sharp), 3 section outline (by outline point), 5 plane between pieces
// at a miter, 6-8 round corner axes and frame, 9 a bounding sphere per chunk of
// SWEEP_CHUNK segments (for the nearest-segment search)
const SWEEP_ROWS = 10;
const SWEEP_CHUNK = 8;
const SECTION_CODE: Record<string, number> = { circle: 0, square: 1, custom: 2 };

interface ProfileTex { tex: THREE.DataTexture; min: [number, number]; max: [number, number] }

const range = (n: number) => Array.from({ length: n }, (_, i) => i);



export const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
in vec2 vNdc;
#ifdef SDF_MASK
layout(location = 0) out highp uvec4 pc_fragColor;
#else
layout(location = 0) out highp vec4 pc_fragColor;
#endif
#ifdef SDF_BRICK
// each slot's object mask (even rows) and cluster bits (odd rows), from the SDF_MASK pass
uniform highp usampler2D uBrickMask;
#endif
uniform mat4 uInvProjView;
uniform mat4 uProjView;
uniform sampler2D uData;
// sweeps: per slot, rows 0..3 = path point + length, normal, binormal, section outline
uniform highp sampler2D uSweep;
uniform vec4 uClip;
uniform int uClipOn;
uniform int uFlat;
// reference sheet passes: 0 shaded, 1 depth (near white), 2 view-space normal
uniform int uPass;
uniform vec3 uCamPos;
uniform vec3 uCamDir;
uniform mat3 uViewRot;
uniform vec2 uDepthRange;
uniform vec3 uClay;
uniform vec3 uCap;
uniform vec3 uBoundsMin;
uniform vec3 uBoundsMax;
uniform float uPixelAngle;
uniform float uPixelSize; // orthographic cameras: world size of a pixel
uniform int uGroupCount;
uniform int uObjCount;
uniform int uProgLen; // the layer program (scene.CompiledIns), in uData from row uProgRow
uniform int uProgRow;
uniform int uCluCount;
// the baked field (bake.ts): a bake pass writes map() at voxel centres of layer uBakeZ;
// the settled pass may start each ray where the baked field says the surface is
uniform vec3 uBakeO;
uniform float uBakeH;
uniform float uBakeZ;
uniform int uStartOn;
uniform sampler2D uStartT;
uniform float uStartBack;
uniform highp sampler3D uBakeTex;
uniform vec3 uBakeSize;
// fine bricks (bake.ts): atlas slots per axis, cell size in voxels, fine step in voxels
uniform ivec3 uBrickSlots;
uniform float uBrickCell;
uniform float uBrickStep;
uniform float uBrickReach;
// occlusion from the baked field (settled pass with a bake): the same four taps
float bakedField(vec3 p) {
  vec3 q = clamp((p - uBakeO) / uBakeSize, 0.0, 1.0);
  vec3 n = vec3(textureSize(uBakeTex, 0));
  return texture(uBakeTex, (q * (n - 1.0) + 0.5) / n).r;
}
uniform vec4 uCluMin[${MAX_CLUSTERS}]; // a top-level layer's world box; w: how far it reaches past it
uniform vec4 uCluMax[${MAX_CLUSTERS}];
uniform int uSweepObj[${MAX_SWEEP_OBJS}]; // object index of each sweep object
uniform int uSweepData[${MAX_SWEEP_OBJS}]; // its shape's texture slot
uniform float uSweepGate;
uniform ivec2 uCluSw[${MAX_CLUSTERS}]; // each cluster's range in the sweep list
uniform ivec4 uGroupRange[${MAX_GROUPS}];   // shells start, solids start, subs start, end
uniform float uT[${MAX_GROUPS}];
uniform float uK[${MAX_GROUPS}];
uniform float uReach[${MAX_GROUPS}]; // scene.CompiledGroup.reach: every fold its objects pass through
uniform int uCutsBound[${MAX_GROUPS}]; // scene.CompiledGroup.cutsBound
uniform float uRound[${MAX_GROUPS}]; // rounds the rims of the group's cuts
uniform int uHollow[${MAX_GROUPS}];
uniform int uUseGrid[${MAX_GRIDS}];
uniform float uCavH[${MAX_GRIDS}];
${range(MAX_GRIDS).map((i) => `uniform sampler3D uCav${i}; uniform vec3 uCavO${i}; uniform vec3 uCavS${i}; uniform float uCavC${i};`).join('\n')}
${range(MAX_PROFILES).map((i) => `uniform sampler2D uProf${i};`).join('\n')}
// per profile slot: first and last texel centres, texture size
uniform vec2 uProfLo[${MAX_PROFILES}];
uniform vec2 uProfHi[${MAX_PROFILES}];
uniform vec2 uProfSz[${MAX_PROFILES}];

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
float profile(int slot, vec2 q, int ch) {
  if (slot < 0 || slot >= ${MAX_PROFILES}) return 1e5;
  vec2 lo = uProfLo[slot], hi = uProfHi[slot], sz = uProfSz[slot];
  vec2 c = clamp(q, lo, hi);
  vec2 o = q - c;
  o.x = max(o.x, 0.0); // r below the first texel centre is still inside the table
  float outside = length(o);
  // lo/hi are the first/last texel centres
  vec2 uv = (0.5 + (c - lo) / (hi - lo) * (sz - 1.0)) / sz;
  vec4 t = vec4(0.0);
${range(MAX_PROFILES).map((i) => `  ${i ? 'else ' : ''}if (slot == ${i}) t = texture(uProf${i}, uv);`).join('\n')}
  float v = t[ch];
  if (ch == 1) return v;
  return outside > 0.0 ? max(outside, v) : v; // the table has margin around the shape
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
// E: the object's row 7 = (edge rounding, cos(pi/n), tan(pi/n), 1 / slant length of a
// side's apothem line), constants worked out on the CPU (see writeData)
float frustumSide(float u, float y, vec4 P, vec4 E) {
  float ap1 = P.y * E.y, ap2 = P.w * E.y, h = 2.0 * P.z;
  return ((u - ap1) * h + (y + P.z) * (ap1 - ap2)) * E.w;
}
// (rho, b): distance from the axis, angle from the nearest side normal (side normals
// point at angles (2k+1)*pi/n)
float sdFrustum(vec3 q, vec4 P, vec4 E, float rho, float b) {
  float side = frustumSide(rho * cos(b), q.y, P, E);
  return max(side, abs(q.y) - P.z);
}

// lowest set bit's index (x != 0; findLSB needs ES 3.1); powers of two are exact in float
int lowBit(uint x) { return int(log2(float(x & (~x + 1u))) + 0.5); }
vec4 sw(int slot, int r, int i) { return texelFetch(uSweep, ivec2(i, slot * ${SWEEP_ROWS} + r), 0); }
// section in its own plane; P = (kind, half width, half height, -)
float sweepSection(int slot, vec4 P, int polyN, vec2 uv) {
  if (P.x < 0.5) return length(uv) - P.y;
  if (P.x < 1.5) { vec2 d = abs(uv) - P.yz; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
  float best = 1e10;
  bool inside = false;
  vec2 a = sw(slot, 3, polyN - 1).xy;
  for (int k = 0; k < ${MAX_SECTION_POINTS}; k++) {
    if (k >= polyN) break;
    vec2 b = sw(slot, 3, k).xy;
    vec2 e = b - a, w = uv - a;
    vec2 d = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    best = min(best, dot(d, d));
    if ((a.y > uv.y) != (b.y > uv.y) && uv.x < e.x * (uv.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    a = b;
  }
  return inside ? -sqrt(best) : sqrt(best);
}
// Distance to a sweep (mirrors sweep.sweepEval): the prism of the segment nearest
// by its centre line, its ends cut flat, square-capped, or on the bisecting plane
// at a miter; where it meets a sharp corner, the piece beyond and the corner piece
// (the section spun about the bend's axis); and round caps (the section spun about
// its out-of-plane axis). Seams don't bound the depth inside. Open ends run on.
// All candidates go through one loop with a single section evaluation, so the
// (inlined) shader stays small.
// P = (section kind, half width, half height, cap + 4 * miter), M = (points, outline points, loop, length)
float swCapped(float d2, float e) { return min(max(d2, e), 0.0) + length(max(vec2(d2, e), 0.0)); }
// Returns (distance, distance with the object's open ends running on, for the depth).
vec2 sdSweep(int slot, vec4 P, vec4 M, vec3 q, int holeMask) {
  int n = int(M.x), segs = n - 1, cap = int(P.w + 0.5) & 3;
  bool loop = M.z > 0.5, roundCap = cap == 1;
  bool openS = (holeMask & 2) != 0, openE = (holeMask & 4) != 0;
  float ext = cap == 2 ? P.z : 0.0;
  // the segment nearest by its centre line: the chunk whose bounding sphere is
  // nearest first, then only the chunks that could hold a nearer segment
  float bd = 1e20;
  int bi = 0;
  int nch = (segs + ${SWEEP_CHUNK - 1}) / ${SWEEP_CHUNK}, cb = 0;
  float lbBest = 1e20;
  for (int c = 0; c < ${Math.ceil(MAX_PATH_POINTS / SWEEP_CHUNK)}; c++) {
    if (c >= nch) break;
    vec4 C = sw(slot, 9, c);
    float lb = max(length(q - C.xyz) - C.w, 0.0);
    if (lb < lbBest) { lbBest = lb; cb = c; }
  }
  for (int pass = 0; pass < ${Math.ceil(MAX_PATH_POINTS / SWEEP_CHUNK) + 1}; pass++) {
    int c = pass == 0 ? cb : pass - 1;
    if (c >= nch) break;
    if (pass > 0) {
      if (c == cb) continue;
      vec4 C = sw(slot, 9, c);
      float lb = max(length(q - C.xyz) - C.w, 0.0);
      if (lb * lb >= bd) continue;
    }
    int i0 = c * ${SWEEP_CHUNK};
    vec3 a = sw(slot, 0, i0).xyz;
    for (int j = 0; j < ${SWEEP_CHUNK}; j++) {
      int i = i0 + j;
      if (i >= segs) break;
      vec3 b = sw(slot, 0, i + 1).xyz, e = b - a;
      vec3 dv = q - a - e * clamp(dot(q - a, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
      float dd = dot(dv, dv);
      if (dd < bd) { bd = dd; bi = i; }
      a = b;
    }
  }
  int g0 = int(sw(slot, 2, bi).w + 0.5), g1 = int(sw(slot, 4, bi).w + 0.5);
  bool sharp0 = (g0 & 4) == 4 && (bi > 0 || loop), sharp1 = (g1 & 4) == 4 && (bi + 1 < segs || loop);
  vec2 best = vec2(1e20);
  // candidates: 0-2 segment pieces (nearest, before, after), 3-4 corners, 5-8 cap
  // halves; the loop visits only those that apply here, in order
  uint cm = 1u;
  if (sharp0) cm |= (g0 & 2) != 0 ? 10u : 2u;
  if (sharp1) cm |= (g1 & 2) != 0 ? 20u : 4u;
  if (!loop && roundCap) {
    if (bi == 0) cm |= 96u;
    if (bi == segs - 1) cm |= 384u;
  }
  for (int c = min(uGroupCount, 0); c < 9; c++) {
    if (cm == 0u) break;
    int k = lowBit(cm);
    cm &= cm - 1u;
    vec2 uv;
    float eReal = -1e9, eSeam = -1e9, eRealO = -1e9, eSeamO = -1e9;
    bool closedOnly = false;
    if (k < 3) {
      int i = k == 0 ? bi : k == 1 ? (bi > 0 ? bi - 1 : segs - 1) : (bi + 1 < segs ? bi + 1 : 0);
      vec4 A = sw(slot, 0, i), DL = sw(slot, 1, i), Na = sw(slot, 2, i), Nb = sw(slot, 4, i);
      vec3 w = q - A.xyz, d = DL.xyz;
      float xa = dot(w, d), L = DL.w;
      vec3 N = normalize(mix(Na.xyz, Nb.xyz, L > 0.0 ? clamp(xa / L, 0.0, 1.0) : 0.0));
      uv = vec2(dot(w, N), dot(w, cross(d, N)));
      // closed, and with the open ends running on
      float along = A.w + xa;
      if (!loop && !roundCap) {
        eReal = max(-along, along - M.w) - ext;
        eRealO = max(openS ? -1e9 : -along, openE ? -1e9 : along - M.w) - ext;
      }
      int f0 = int(Na.w + 0.5), f1 = int(Nb.w + 0.5);
      float sIn = -1e9, sOut = -1e9;
      if (!loop && i == 0) sIn = roundCap ? -xa : -1e9;
      else if ((f0 & 4) == 4) sIn = (f0 & 1) == 1 ? -dot(w, sw(slot, 5, i).xyz) : -xa;
      if (!loop && i == segs - 1) sOut = roundCap ? xa - L : -1e9;
      else if ((f1 & 4) == 4) sOut = (f1 & 1) == 1 ? dot(q - sw(slot, 0, i + 1).xyz, sw(slot, 5, i + 1).xyz) : xa - L;
      eSeam = max(sIn, sOut);
      eSeamO = max(!loop && i == 0 && openS ? -1e9 : sIn, !loop && i == segs - 1 && openE ? -1e9 : sOut);
    } else if (k < 5) {
      int j = k == 3 ? bi : bi + 1;
      vec3 w = q - sw(slot, 0, j).xyz;
      vec4 J0 = sw(slot, 6, j), J1 = sw(slot, 7, j), J2 = sw(slot, 8, j);
      vec3 ax = J0.xyz, co = vec3(J0.w, J1.xy), Nn = vec3(J1.zw, J2.x), Bn = J2.yzw;
      float yb = dot(w, ax), rho = length(w - ax * yb);
      uv = rho * vec2(dot(co, Nn), dot(co, Bn)) + yb * vec2(dot(ax, Nn), dot(ax, Bn));
      vec3 dA = sw(slot, 1, j > 0 ? j - 1 : segs - 1).xyz, dB = sw(slot, 1, j < segs ? j : 0).xyz;
      eSeam = max(-dot(w, dA), dot(w, dB));
      eSeamO = eSeam;
    } else {
      int e = (k - 5) / 2;
      closedOnly = e == 0 ? openS : openE; // an open end has no cap in the depth
      int j = e == 0 ? 0 : n - 1, seg = e == 0 ? 0 : segs - 1;
      vec3 w = q - sw(slot, 0, j).xyz;
      vec3 d = sw(slot, 1, seg).xyz * (e == 0 ? -1.0 : 1.0);
      vec3 N = sw(slot, e == 0 ? 2 : 4, seg).xyz;
      float al = dot(w, d), rho = length(vec2(dot(w, cross(d, N)), al));
      uv = vec2(dot(w, N), (k & 1) == 1 ? rho : -rho);
      eSeam = eSeamO = -al;
    }
    float d2 = sweepSection(slot, P, int(M.y), uv);
    best.x = min(best.x, eSeam > 0.0 ? swCapped(d2, max(eReal, eSeam)) : swCapped(d2, eReal));
    if (!closedOnly) best.y = min(best.y, eSeamO > 0.0 ? swCapped(d2, max(eRealO, eSeamO)) : swCapped(d2, eRealO));
  }
  return best;
}

// a regular n-gon frustum with every edge rounded by rr (primitives.prismFrustum.roundedSdf)
float sdFrustumRound(vec3 q, vec4 P, vec4 E, float rho, float b) {
  float rr = E.x, hh = P.z, h = 2.0 * hh;
  float ap1 = P.y * E.y, ap2 = P.w * E.y, cosT = h * E.w;
  float a1 = ap1 - rr / cosT, a2 = ap2 - rr / cosT;
  float yAx = a1 > a2 ? -hh + a1 / (a1 - a2) * h : hh;
  float y0 = -hh + rr, y1 = min(hh - rr, yAx);
  float ap = max(0.0, a1 + (a2 - a1) * (clamp(q.y, y0, y1) + hh) / h);
  float ex = rho * cos(b) - ap, py = abs(rho * sin(b));
  float side = sign(ex) * length(vec2(ex, py - min(py, ap * E.z))) * cosT;
  float cap = max(y0 - q.y, q.y - y1);
  return min(max(side, cap), 0.0) + length(max(vec2(side, cap), 0.0)) - rr;
}
// E: row 7 (prisms: see frustumSide; boxes carry their rounding in P.w)
float sdLocal(vec3 q, vec4 P, int type, int slot, vec4 E) {
  float rho = length(q.xz); // (most types: worked out once)
  if (type == 0) return length(q) - P.x;
  if (type == 1) return sdBox(q, P.xyz - P.w) - P.w;
  if (type == 2) return extrude(rho - P.x, q.y, P.y);
  if (type == 3) return sdCone2(vec2(rho, q.y), P.x, P.y);
  if (type == 4) return length(vec2(rho - P.x, q.y)) - P.y;
  if (type == 5) return length(vec3(q.x, q.y - clamp(q.y, -P.y, P.y), q.z)) - P.x;
  if (type == 6) {
    float an = 3.14159265 / P.x;
    float b = mod(atan(q.z, q.x), 2.0 * an) - an;
    return E.x > 0.0 ? sdFrustumRound(q, P, E, rho, b) : sdFrustum(q, P, E, rho, b);
  }
  return profile(slot, vec2(rho, q.y), 0);
}
int gObjN = 0, gMapN = 0; // evaluation counters for the cost view (uFlat == 2)
// Sweeps at the point map() is evaluating, by sweep object: (distance, distance with open
// ends running on), both in world units. Filled once per map() call by sweepAll,
// so the long sweep code appears once in the shader instead of at every sdObj.
vec2 gSw[${MAX_SWEEP_OBJS}];
float sdObj(int i, vec3 p) {
  gObjN++;
  vec4 meta = row(i, 6);
  if (int(meta.x) == 8) return gSw[int(meta.y)].x;
  return sdLocal(toLocal(i, p), row(i, 3), int(meta.x), int(meta.y), row(i, 7)) * row(i, 4).w;
}
// lower bound from the object's bounding sphere
float bound(int i, vec3 p) { vec4 b = row(i, 5); return length(p - b.xyz) - b.w; }

// Per-ray object culling. Before marching, each object's local box is tested
// against the ray segment, grown by every distance at which the object can still
// change the field near the ray: the group's blend, the cavity smoothing and
// grid offsets, through-opening depth (objects with openings), and the reach of
// the normal and occlusion samples. Objects outside it cannot change map() at any
// point the pixel evaluates, so skipping them leaves the image unchanged.
uvec4 gMask = uvec4(0xffffffffu);
uint gClu = 0xffffffffu, gAOClu = 0xffffffffu;
bool objOn(int i) { return i >= 128 || ((gMask[i >> 5] >> uint(i & 31)) & 1u) == 1u; }
// the part [t0, t1] of the segment [ta, tb] inside the box (empty if t0 > t1)
vec2 segBox(vec3 ro, vec3 rd, float ta, float tb, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / rd;
  vec3 a = (lo - ro) * inv, b = (hi - ro) * inv;
  vec3 mn = min(a, b), mx = max(a, b);
  return vec2(max(max(mn.x, mn.y), max(mn.z, ta)), min(min(mx.x, mx.y), min(mx.z, tb)));
}
// bit set per object hit by the segment [ta, tb], boxes grown by 'reach' (world units);
// span: the first entry and last exit over those boxes
// Top-level layers (clusters) first: a ray that misses one's box, grown the same way,
// skips all its objects here and its steps in map(). clu: bit per cluster hit.
uvec4 rayMask(vec3 ro, vec3 rd, float ta, float tb, float reach, out vec2 span, out uint clu) {
  uvec4 m = uvec4(0u);
  span = vec2(1e9, -1e9);
  clu = 0u;
  float cav = 0.0;
  for (int k = 0; k < ${MAX_GRIDS}; k++) cav = max(cav, uCavH[k]);
  for (int c = 0; c < ${MAX_CLUSTERS}; c++) {
    if (c >= uCluCount) break;
    float grow = reach + uCluMin[c].w + 3.0 * cav;
    vec2 st = segBox(ro, rd, ta, tb, uCluMin[c].xyz - grow, uCluMax[c].xyz + grow);
    if (st.x <= st.y) clu |= 1u << uint(c);
  }
  for (int i = 0; i < 128; i++) {
    if (i >= uObjCount) break;
    if (((clu >> uint(int(row(i, 8).w + 0.5))) & 1u) == 0u) continue;
    vec4 meta = row(i, 6), S = row(i, 4);
    int g = int(meta.w);
    float cavH = g < ${MAX_GRIDS} ? uCavH[min(g, ${MAX_GRIDS - 1})] : 0.0;
    float grow = reach + uReach[g] + uRound[g] + 3.0 * cavH + 0.05;
    if (int(meta.z) != 0) grow += 2.0 * row(i, 5).w; // depth carries on through openings
    if (i >= uGroupRange[g].z) grow += 2.0 * uT[g];  // a cut's wall lies up to t inside the shape
    vec3 o = toLocal(i, ro), d = toLocal(i, ro + rd) - o;
    vec3 gl = grow / S.xyz;
    // a mask trims everything below it wherever the ray goes: never culled
    if ((int(meta.z) & ${MASK_FLAG}) != 0) { m[i >> 5] |= 1u << uint(i & 31); continue; }
    vec2 st = segBox(o, d, ta, tb, row(i, 8).xyz - gl, row(i, 9).xyz + gl);
    if (st.x <= st.y) { m[i >> 5] |= 1u << uint(i & 31); span = vec2(min(span.x, st.x), max(span.y, st.y)); }
  }
  return m;
}

// depth (world units) below this object's surface, ignoring faces that are openings;
// outside the object it is the distance to its non-opening faces (signed or not)
float holeDepth(int i, vec3 p) {
  vec3 q = toLocal(i, p);
  vec4 P = row(i, 3), S = row(i, 4), meta = row(i, 6);
  int type = int(meta.x), slot = int(meta.y), mask = int(meta.z);
  float d = 1e5;
  if (type == 0 || type == 4 || type == 5) return bit(mask, 0) ? 1e5 : -sdLocal(q, P, type, slot, vec4(0.0)) * S.w;
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
    vec4 E = row(i, 7);
    for (int k = 0; k < 12; k++) {
      if (float(k) >= n) break;
      if (bit(mask, 2 + k)) continue;
      float a = 6.2831853 * (float(k) - 0.5) / n;
      d = min(d, -frustumSide(dot(q.xz, vec2(cos(a), sin(a))), q.y, P, E) * min(S.x, S.z));
    }
    return d;
  }
  if (type == 8) {
    // depth below the sweep with its open ends running on (as scene.openDepth)
    return bit(mask, 0) ? 1e5 : -gSw[slot].y;
  }
  return profile(slot, vec2(length(q.xz), q.y), 1) * S.w;
}

// Tricubic B-spline lookup from 8 trilinear fetches (smooth, no texel banding).
// f is in texel units with texel centres at integers.
vec2 cubic(sampler3D tex, vec3 f, vec3 dims) {
  vec3 i = floor(f), x = f - i, o = 1.0 - x;
  vec3 w0 = o * o * o / 6.0;
  vec3 w1 = (4.0 - 6.0 * x * x + 3.0 * x * x * x) / 6.0;
  vec3 w2 = (1.0 + 3.0 * x + 3.0 * x * x - 3.0 * x * x * x) / 6.0;
  vec3 w3 = x * x * x / 6.0;
  vec3 g0 = w0 + w1, g1 = w2 + w3;
  vec3 a = (i - 1.0 + w1 / g0 + 0.5) / dims;
  vec3 b = (i + 1.0 + w3 / g1 + 0.5) / dims;
  vec2 v000 = texture(tex, vec3(a.x, a.y, a.z)).rg, v100 = texture(tex, vec3(b.x, a.y, a.z)).rg;
  vec2 v010 = texture(tex, vec3(a.x, b.y, a.z)).rg, v110 = texture(tex, vec3(b.x, b.y, a.z)).rg;
  vec2 v001 = texture(tex, vec3(a.x, a.y, b.z)).rg, v101 = texture(tex, vec3(b.x, a.y, b.z)).rg;
  vec2 v011 = texture(tex, vec3(a.x, b.y, b.z)).rg, v111 = texture(tex, vec3(b.x, b.y, b.z)).rg;
  vec2 y0 = g0.y * (g0.x * v000 + g1.x * v100) + g1.y * (g0.x * v010 + g1.x * v110);
  vec2 y1 = g0.y * (g0.x * v001 + g1.x * v101) + g1.y * (g0.x * v011 + g1.x * v111);
  return g0.z * y0 + g1.z * y1;
}
float cubicR(sampler3D tex, vec3 f, vec3 dims) { return cubic(tex, f, dims).r; }

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

// The shell loop's last four exact object distances at this point, so the cavity
// loop below doesn't evaluate the same objects again.
ivec4 cId; vec4 cD;
float sdShell(int i, vec3 p) {
  float d = sdObj(i, p);
  cId = ivec4(i, cId.xyz); cD = vec4(d, cD.xyz);
  return d;
}
float sdCached(int i, vec3 p) {
  if (cId.x == i) return cD.x;
  if (cId.y == i) return cD.y;
  if (cId.z == i) return cD.z;
  if (cId.w == i) return cD.w;
  return sdObj(i, p);
}

int gKind;        // 0 clay, 1 section cap, 2 cavity wall
float gCavH;
bool gNoClip = false;

// Each nearby sweep, once per map() call (see gSw). Farther than the gate, a
// bound stands in: every caller that wants it exact is nearer than that. Sweeps are
// listed by cluster, so a ray only loops over the sweeps of clusters it reaches.
// Lower bound from the object's local box (tighter than its sphere for long shapes).
float boxBound(int i, vec3 p) {
  vec3 q = toLocal(i, p);
  return length(max(max(row(i, 8).xyz - q, q - row(i, 9).xyz), 0.0)) * row(i, 4).w;
}
void sweepAll(vec3 p) {
  // the bounds first, marking the sweeps within the gate; then one pass per marked
  // sweep (the long sweep code runs only as often as the most any pixel needs)
  uvec2 todo = uvec2(0u);
  for (int c = min(uGroupCount, 0); c < ${MAX_CLUSTERS}; c++) {
    if (c >= uCluCount) break;
    if (((gClu >> uint(c)) & 1u) == 0u) continue;
    ivec2 r = uCluSw[c];
    for (int n = 0; n < ${MAX_SWEEP_OBJS}; n++) {
      int k = r.x + n;
      if (k >= r.y) break;
      int i = uSweepObj[k];
      float b = bound(i, p);
      if (!objOn(i) || b > uSweepGate || (b = max(b, boxBound(i, p))) > uSweepGate) { gSw[k] = vec2(b); continue; }
      if (k < 32) todo.x |= 1u << uint(k); else todo.y |= 1u << uint(k - 32);
    }
  }
  for (int n = min(uGroupCount, 0); n < ${MAX_SWEEP_OBJS}; n++) {
    if (todo == uvec2(0u)) break;
    int k;
    if (todo.x != 0u) { k = lowBit(todo.x); todo.x &= todo.x - 1u; }
    else { k = 32 + lowBit(todo.y); todo.y &= todo.y - 1u; }
    int i = uSweepObj[k];
    gObjN++;
    gSw[k] = sdSweep(uSweepData[k], row(i, 3), row(i, 7), toLocal(i, p), int(row(i, 6).z)) * row(i, 4).w;
  }
}

// Depth below hollow body g's shell surface (fs: that surface's field here): the
// deepest single-object depth A, exact wherever one object's surface is nearest,
// bounded by the closed cuts' surfaces, plus the cavity grid's correction where
// the body has one (joins, blends, layers above cuts).
float unitDepth(int g, vec3 p, float fs) {
  ivec4 R = uGroupRange[g];
  float kb = uK[g];
  bool useGrid = g < ${MAX_GRIDS} && uUseGrid[min(g, ${MAX_GRIDS - 1})] == 1;
  // (smooth max over two texels where the deepest object switches; see scene.baseDepth)
  float kA = useGrid ? 2.0 * uCavH[min(g, ${MAX_GRIDS - 1})] : 0.0;
  // The smooth max takes the two deepest terms only, so it doesn't depend on object
  // order and terms far below the deepest can be skipped exactly. -fs (less the
  // blend bulge: up to k/4 per sequential smooth min) is a lower bound on the
  // deepest term; an object without openings can't be deeper than -bound.
  float tau = useGrid ? 0.5 * uCavH[min(g, ${MAX_GRIDS - 1})] : 0.02;
  float t1 = -1e5, t2 = -1e5, lb = -fs - 0.25 * kb * float(R.y - R.x - 1);
  float kS = max(kA, kb);
  for (int n = 0; n < ${MAX_LOOP}; n++) {
    int i = R.x + n;
    if (i >= R.y) break;
    if (!objOn(i)) continue;
    if (int(row(i, 6).z) == 0 && -bound(i, p) < max(lb, t1) - kS) continue;
    float d = sdCached(i, p);
    if (int(row(i, 6).z) == 0) d = -d;
    else {
      // Through an opening the depth carries on as if the face weren't there (as the
      // grid stores it): no jump at the face, so the rim stays clean and the cavity
      // passes the face instead of leaving a skin.
      float hd = holeDepth(i, p);
      d = d <= 0.0 || hd > d + tau ? hd : -d;
    }
    if (d > t1) { t2 = t1; t1 = d; } else t2 = max(t2, d);
  }
  float D = -smin(-t1, -t2, kS);
  // a closed cut's surface bounds the depth too, unless a layer is added above a cut (see scene.baseDepth)
  for (int n = 0; n < ${MAX_LOOP}; n++) {
    int i = R.z + n;
    if (i >= R.w || uCutsBound[g] == 0) break;
    if (!objOn(i) || int(row(i, 6).z) != 0) continue;
    float b = bound(i, p);
    D = min(D, b < D + 0.5 ? sdObj(i, p) : b);
  }
  if (useGrid) D = gridDepth(g, p, uT[g], D);
  return D;
}

// The scene field: the layer program (scene.runProgram) run with a stack of (body,
// shell surface, active piece) per open group. An object step folds one object in
// (smoothly by its group's blend); a group's end hollows it if it is a hollow body
// and folds it into its parent. Objects whose bound shows they can't change the
// fold aren't evaluated, and objects off this ray (gMask) not at all.
float map(vec3 p) {
  gMapN++;
  sweepAll(p);
  cId = ivec4(-1);
  // the open group's values in registers (g, f, kd); its parents' on the stack
  float G[${MAX_DEPTH}], F[${MAX_DEPTH}];
  int K[${MAX_DEPTH}];
  int sp = 0;
  float g = 1e5, f = 1e5;
  int kd = -1;
  // The depth below a hollow body is computed outside the step loop, once per body
  // the point is near: the loop stops at that body's end, the depth is found, and
  // the loop picks up again there. (With it inside, the loop compiles far slower.)
  int pc = 0, ready = -1;
  float cavD = 0.0;
  for (int pass = 0; pass <= ${MAX_GROUPS}; pass++) {
  int needU = -1;
  for (int n = 0; n < ${MAX_PROG}; n++) {
    if (pc >= uProgLen) break;
    vec4 ins = texelFetch(uData, ivec2(pc & ${ROWS - 1}, uProgRow + (pc >> ${Math.log2(ROWS)})), 0);
    // The cheap steps run in this tight loop: object steps that can't change the fold
    // here (off this ray, or the bound shows the smooth min/max would return g and f
    // exactly: see 'need'), group opens, and group ends that hollow nothing. It stops
    // at an object the fold needs exactly or a hollow body's end, which the long body
    // below handles, so that body runs only for the steps that matter.
    for (int s = 0; s < ${MAX_PROG}; s++) {
      int op = int(ins.x + 0.5);
      if (op == 0) {
        int i = int(ins.y + 0.5), fl = int(ins.z + 0.5);
        if (objOn(i)) {
          // (the shell surface is never below the body, so the body's test covers it
          // for cuts; a mask's distance is the field wherever it trims: always exact)
          if ((fl & 4) == 4) break;
          float b = bound(i, p), k = ins.w;
          if ((fl & 1) == 1 ? b < 0.5 + k - g : b < max((fl & 2) == 2 ? g : f, 0.0) + 0.5 + k) break;
        }
        pc++;
      } else if (op == 1) {
        // a top-level group the ray can't reach: as if empty (never a mask; see setDoc)
        int c = int(ins.z + 0.5) - 1;
        if (c >= 0 && ((gClu >> uint(c)) & 1u) == 0u) pc = int(ins.y + 0.5);
        else {
          if (sp < ${MAX_DEPTH}) { G[sp] = g; F[sp] = f; K[sp] = kd; sp++; }
          g = 1e5; f = 1e5; kd = -1;
          pc++;
        }
      } else {
        int fl = int(ins.y + 0.5), u = int(ins.z + 0.5) - 1;
        if (u >= 0 && uHollow[u] == 1 && f < ${OPENING_EPS.toFixed(3)}) break;
        float gv = g;
        int kind = kd;
        if (sp > 0) { sp--; g = G[sp]; f = F[sp]; kd = K[sp]; }
        // the group folds into its parent (as below)
        bool fm = (fl & 4) == 4, fs = !fm && (fl & 1) == 1, mx = fm || fs;
        float a = mx ? -g : g, w = fm ? -gv : gv;
        if (w < a) kd = fs ? -1 : kind;
        float r = smin(a, w, ins.w), rf = smin(mx ? -f : f, w, ins.w);
        g = mx ? -r : r; f = mx ? -rf : rf;
        pc++;
      }
      if (pc >= uProgLen) break;
      ins = texelFetch(uData, ivec2(pc & ${ROWS - 1}, uProgRow + (pc >> ${Math.log2(ROWS)})), 0);
    }
    if (pc >= uProgLen) break;
    pc++;
    // what the step folds into the open group: v with blend kv, as a mask (fm), a
    // cut (fs) or an add (solid: not into the shell surface f); kindV: its kind
    float v = 0.0, kv = ins.w;
    bool fm = false, fs = false, fsolid = false;
    int kindV = -1;
    if (int(ins.x + 0.5) == 0) {
      // an object the fold needs exactly
      int i = int(ins.y + 0.5), fl = int(ins.z + 0.5);
      v = sdShell(i, p);
      fm = (fl & 4) == 4; fs = !fm && (fl & 1) == 1; fsolid = !fm && !fs && (fl & 2) == 2;
    } else {
      // a hollow body's end: back for its depth first
      int fl = int(ins.y + 0.5), u = int(ins.z + 0.5) - 1;
      if (ready != pc) { needU = u; pc--; break; }
      float gv = g;
      int kind = kd;
      float cav = max(f - ${OPENING_EPS.toFixed(3)}, uT[u] - cavD);
      if (-cav > gv) { gv = -cav; kind = u; }
      if (sp > 0) { sp--; g = G[sp]; f = F[sp]; kd = K[sp]; }
      v = gv; kindV = kind;
      fm = (fl & 4) == 4; fs = !fm && (fl & 1) == 1;
    }
    // one fold for objects and groups: a mask is a smooth max with v, a cut one
    // with -v, an add a smooth min with v (negated in and out: exact)
    bool mx = fm || fs;
    float a = mx ? -g : g, w = fm ? -v : v;
    if (w < a) kd = fs ? -1 : kindV;
    float r = smin(a, w, kv);
    g = mx ? -r : r;
    if (!fsolid) { float rf = smin(mx ? -f : f, w, kv); f = mx ? -rf : rf; }
  }
  if (needU < 0) break;
  cavD = unitDepth(needU, p, f);
  ready = pc + 1;
  }
  float s = g;
  gKind = kd >= 0 ? 2 : 0;
  gCavH = kd >= 0 && kd < ${MAX_GRIDS} ? uCavH[min(kd, ${MAX_GRIDS - 1})] : 0.0;
  if (uClipOn == 1 && !gNoClip) { float c = -(dot(p, uClip.xyz) + uClip.w); if (c > s) { s = c; gKind = 1; } }
  return s;
}

uvec4 gAOMask;
bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 a = (uBoundsMin - ro) * inv, b = (uBoundsMax - ro) * inv;
  vec3 lo = min(a, b), hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z); t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}
#ifdef SDF_BAKE
// bake: the field at the voxel centres of layer uBakeZ (no clip plane, no culling)
void main() {
  gNoClip = true;
  vec3 p = uBakeO + vec3(gl_FragCoord.xy - 0.5, uBakeZ) * uBakeH;
  pc_fragColor = vec4(map(p), 0.0, 0.0, 1.0);
}
#elif defined(SDF_BRICK)
// brick bake: atlas layer uBakeZ; each slot's cell comes from the slot table (uStartT)
void main() {
  gNoClip = true;
  ivec3 a = ivec3(ivec2(gl_FragCoord.xy), int(uBakeZ + 0.5));
  ivec3 sl = a / BRICK_S, l = a - sl * BRICK_S;
  int slot = (sl.z * uBrickSlots.y + sl.y) * uBrickSlots.x + sl.x;
  ivec2 st = ivec2(slot & 4095, slot >> 12);
  vec3 cell = texelFetch(uStartT, st, 0).xyz;
  gMask = texelFetch(uBrickMask, ivec2(st.x, 2 * st.y), 0);
  gClu = texelFetch(uBrickMask, ivec2(st.x, 2 * st.y + 1), 0).x;
  vec3 p = uBakeO + (cell * uBrickCell + vec3(l) * uBrickStep) * uBakeH;
  pc_fragColor = vec4(map(p), 0.0, 0.0, 1.0);
}
#elif defined(SDF_MASK)
// the objects (and clusters) within uBrickReach of each slot's cell centre
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec3 cell = texelFetch(uStartT, ivec2(fc.x, fc.y >> 1), 0).xyz;
  vec3 c = uBakeO + (cell + 0.5) * uBrickCell * uBakeH;
  vec2 span;
  uint clu;
  uvec4 m = rayMask(c, vec3(1.0, 0.0, 0.0), 0.0, 0.0, uBrickReach, span, clu);
  pc_fragColor = (fc.y & 1) == 0 ? m : uvec4(clu, 0u, 0u, 0u);
}
#else
void main() {
  vec4 a = uInvProjView * vec4(vNdc, -1.0, 1.0);
  vec4 b = uInvProjView * vec4(vNdc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w;
  vec3 rd = normalize(b.xyz / b.w - ro);
  float t0, t1;
  if (uGroupCount == 0 || !boxHit(ro, rd, t0, t1)) discard;
  float t = max(t0, 0.0);
  // the baked field already found where (or whether) this ray meets the surface:
  // rays that miss stop here, before any per-ray setup
  float tStart = 0.0;
  if (uStartOn == 1) {
    float ts = texelFetch(uStartT, ivec2(gl_FragCoord.xy), 0).r;
    if (ts < 0.0) discard;
    tStart = ts - uStartBack;
  }
  // normal samples reach up to max(pixel footprint, quarter texel) from the hit;
  // occlusion samples up to 1.95 along the normal, and see objects within that again
  float nReach = uPixelAngle * t1 + 0.002;
  for (int k = 0; k < ${MAX_GRIDS}; k++) nReach = max(nReach, 0.25 * uCavH[k]);
  vec2 span, aoSpan;
  uint marchClu, aoClu;
  // From a baked start every evaluation lies within a few voxels of the baked hit:
  // only objects near that stretch of the ray are switched on, and the march ends
  // with it (the bake puts the surface there).
  float t1Full = t1;
  if (uStartOn == 1) { t = max(t, tStart - 2.0 * uBakeH); t1 = min(t1, tStart + 3.0 * uBakeH); }
  uvec4 marchMask = rayMask(ro, rd, t, t1, nReach, span, marchClu), aoMask = uStartOn == 1 ? marchMask : rayMask(ro, rd, t, t1, 4.0, aoSpan, aoClu);
  gClu = marchClu;
  gAOClu = uStartOn == 1 ? marchClu : aoClu;
  gMask = marchMask;
  gAOMask = aoMask;
  bool hit = false;
  // nothing near this ray: it can't hit (the cost view still reports the pixel)
  if (marchMask == uvec4(0u) && uObjCount <= 128) {
    if (uFlat == 2) { pc_fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    discard;
  }
  // every surface lies inside the boxes the ray crosses: march only that stretch
  if (uObjCount <= 128) { t = max(t, span.x); t1 = min(t1, span.y); }
  if (uStartOn == 1) t = max(t, tStart);
  float d = 1e5, eps = 0.0;
  // One loop calls map() for the march, then the 3 normal taps, then (without a
  // baked field) the 4 occlusion taps, so the long inlined field appears once.
  // phase 0: marching (step i); 1-3: normal taps (forward differences from d at p);
  // 5-8: occlusion taps
  int phase = 0, i = 0, kind = 0;
  vec3 p = vec3(0.0), n = vec3(0.0);
  float ne = 0.0, occ = 0.0, sca = 1.0;
  for (int it = min(uGroupCount, 0); it < 216; it++) {
    vec3 q;
    if (phase == 0) q = ro + rd * t;
    else if (phase <= 3) q = p + vec3(phase == 1, phase == 2, phase == 3) * ne;
    else q = p + n * (0.15 + 0.6 * float(phase - 5));
    float m = map(q);
    if (phase == 0) {
      d = m;
      eps = clamp((uPixelAngle * t + uPixelSize) * 0.35, 0.0008, 0.008);
      bool done = false;
      if (d < eps) hit = true;
      else {
        t += max(d * 0.92, eps * 0.5);
        if (t > t1) {
          // past the window round the baked hit without meeting the surface (a ray
          // that grazes an edge the bake rounded over): the rest of the ray, with its objects
          if (uStartOn == 1 && t1 < t1Full) {
            vec2 sp2; uint c2;
            gMask = rayMask(ro, rd, t, t1Full, nReach, sp2, c2);
            gClu = c2;
            t1 = min(t1Full, sp2.y);
            if (gMask == uvec4(0u)) done = true;
            else { t = max(t, sp2.x); i++; continue; }
          } else done = true;
        }
      }
      i++;
      if (!hit && !done && i < 200) continue;
      // A ray running just alongside a flat face (seen edge-on) creeps along it in
      // tiny steps and can use up its steps before touching it: it is a hit.
      if (!hit && !done && d < 8.0 * eps) hit = true;
      // cost view: map() calls and object evaluations for this pixel, no shading
      if (uFlat == 2 && !hit) { pc_fragColor = vec4(float(min(gMapN, 255)) / 255.0, float(min(gObjN >> 8, 255)) / 255.0, float(gObjN & 255) / 255.0, 1.0); return; }
      if (!hit) discard;
      p = ro + rd * t;
      vec4 clip = uProjView * vec4(p, 1.0);
      gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
      if (uFlat == 1) { pc_fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      kind = gKind; // set by the last map() call, at p
      // the inner wall comes from an interpolated grid: take its normal over half a
      // texel so texel boundaries don't show as facets
      ne = max(0.0008, uPixelAngle * t * 0.5);
      if (kind == 2 && gCavH > 0.0) ne = max(ne, 0.25 * gCavH);
      phase = 1;
    } else if (phase <= 3) {
      n[phase - 1] = m - d;
      phase++;
      if (phase < 4) continue;
      n = normalize(n);
      if (dot(n, rd) > 0.0) n = -n;
      if (uPass != 0) break;
      // with a baked field, occlusion comes from it (below)
      if (uStartOn == 1) break;
      // occlusion: the wider mask, and the clay only (not the section plane)
      gMask = gAOMask;
      gClu = gAOClu;
      gNoClip = true;
      phase = 5;
    } else {
      float h = 0.15 + 0.6 * float(phase - 5);
      occ += (h - m) * sca; sca *= 0.75;
      phase++;
      if (phase == 9) break;
    }
  }
  if (uPass == 1) {
    float z = dot(p - uCamPos, uCamDir);
    float v = 1.0 - clamp((z - uDepthRange.x) / max(uDepthRange.y - uDepthRange.x, 1e-4), 0.0, 1.0);
    pc_fragColor = vec4(vec3(0.06 + 0.94 * v), 1.0); // (never black: black is background)
    return;
  }
  if (uPass == 2) { pc_fragColor = vec4(normalize(uViewRot * n) * 0.5 + 0.5, 1.0); return; }
  vec3 base = kind == 1 ? uCap : uClay;
  vec3 key = normalize(-rd + vec3(0.35, 0.65, 0.2));
  float dif = clamp(dot(n, key), 0.0, 1.0);
  float hemi = 0.55 + 0.45 * n.y;
  if (uStartOn == 1) {
    for (int k = 0; k < 4; k++) { float h = 0.15 + 0.6 * float(k); occ += (h - bakedField(p + n * h)) * sca; sca *= 0.75; }
  }
  float ao = clamp(1.0 - 0.18 * occ, 0.0, 1.0);
  vec3 col = base * (0.38 + 0.22 * hemi + 0.62 * dif) * (0.55 + 0.45 * ao);
  col += 0.06 * pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  pc_fragColor = vec4(pow(col, vec3(1.0 / 1.15)), 1.0);
  if (uFlat == 2) pc_fragColor = vec4(float(min(gMapN, 255)) / 255.0, float(min(gObjN >> 8, 255)) / 255.0, float(gObjN & 255) / 255.0, 1.0);
}
#endif
`;

export class SdfRenderer {
  /** Bumped by every change to what it draws (the view redraws its image on a change). */
  version = 0;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** Bumped by changes to the field itself (not the camera, clip or style): the bake follows it. */
  fieldVersion = 0;
  /** The last setDoc was mid-drag: nothing heavy (the bake waits for release). */
  interactive = false;
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
      uSweep: { value: this.sweepTex },
      uClip: { value: new THREE.Vector4(0, 0, -1, 0) },
      uClipOn: { value: 0 },
      uBakeO: { value: new THREE.Vector3() },
      uBakeH: { value: 1 },
      uBakeZ: { value: 0 },
      uStartOn: { value: 0 },
      uStartT: { value: null },
      uStartBack: { value: 1 },
      uBakeTex: { value: null },
      uBakeSize: { value: new THREE.Vector3(1, 1, 1) },
      uBrickSlots: { value: new Int32Array(3) },
      uBrickCell: { value: 2 },
      uBrickStep: { value: 0.5 },
      uBrickReach: { value: 1 },
      uBrickMask: { value: null },
      uFlat: { value: 0 },
      uPass: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uCamDir: { value: new THREE.Vector3(0, 0, -1) },
      uViewRot: { value: new THREE.Matrix3() },
      uDepthRange: { value: new THREE.Vector2(0, 1) },
      uClay: { value: new THREE.Color(0xc8b6a4) },
      uCap: { value: new THREE.Color(0xc0634a) },
      uBoundsMin: { value: new THREE.Vector3() },
      uBoundsMax: { value: new THREE.Vector3() },
      uCluCount: { value: 0 },
      uCluMin: { value: range(MAX_CLUSTERS).map(() => new THREE.Vector4()) },
      uCluMax: { value: range(MAX_CLUSTERS).map(() => new THREE.Vector4()) },
      uPixelAngle: { value: 0.0015 },
      uPixelSize: { value: 0 },
      uGroupCount: { value: 0 },
      uObjCount: { value: 0 },
      uProgLen: { value: 0 },
      uProgRow: { value: 0 },
      uSweepObj: { value: range(MAX_SWEEP_OBJS).map(() => 0) },
      uSweepData: { value: range(MAX_SWEEP_OBJS).map(() => 0) },
      uCluSw: { value: new Int32Array(2 * MAX_CLUSTERS) }, // (an ivec2 array goes up as flat ints)
      uSweepGate: { value: 4 },
      // integer vector arrays must be flat Int32Arrays (three.js does not flatten them)
      uGroupRange: { value: new Int32Array(MAX_GROUPS * 4) },
      uT: { value: range(MAX_GROUPS).map(() => 0.5) },
      uK: { value: range(MAX_GROUPS).map(() => 0) },
      uReach: { value: range(MAX_GROUPS).map(() => 0) },
      uRound: { value: range(MAX_GROUPS).map(() => 0) },
      uHollow: { value: range(MAX_GROUPS).map(() => 0) },
      uCutsBound: { value: range(MAX_GROUPS).map(() => 1) },
      uUseGrid: { value: range(MAX_GRIDS).map(() => 0) },
      uCavH: { value: range(MAX_GRIDS).map(() => 0) },
    };
    for (const i of range(MAX_GRIDS)) {
      u[`uCav${i}`] = { value: null };
      u[`uCavO${i}`] = { value: new THREE.Vector3() };
      u[`uCavS${i}`] = { value: new THREE.Vector3(1, 1, 1) };
      u[`uCavC${i}`] = { value: 1 };
    }
    u.uProfLo = { value: range(MAX_PROFILES).map(() => new THREE.Vector2()) };
    u.uProfHi = { value: range(MAX_PROFILES).map(() => new THREE.Vector2(1, 1)) };
    u.uProfSz = { value: range(MAX_PROFILES).map(() => new THREE.Vector2(1, 1)) };
    for (const i of range(MAX_PROFILES)) {
      u[`uProf${i}`] = { value: null };
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
    this.mesh.onBeforeRender = (r, _s, camera) => this.beforeRender(camera, r);
  }

  private beforeRender(camera: THREE.Camera, renderer: THREE.WebGLRenderer) {
    const u = this.material.uniforms;
    camera.updateMatrixWorld();
    const pv = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uProjView.value.copy(pv);
    u.uInvProjView.value.copy(pv).invert();
    const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
    u.uPixelAngle.value = persp ? 0.0015 : 0;
    const o = camera as THREE.OrthographicCamera;
    u.uPixelSize.value = persp ? 0 : (o.top - o.bottom) / o.zoom / renderer.getContext().drawingBufferHeight;
  }

  setStyle(opts: { flat?: boolean; cost?: boolean; clay?: number; cap?: number }) {
    this.version++;
    const u = this.material.uniforms;
    if (opts.flat !== undefined) u.uFlat.value = opts.flat ? 1 : 0;
    if (opts.cost !== undefined) u.uFlat.value = opts.cost ? 2 : 0;
    if (opts.clay !== undefined) u.uClay.value.set(opts.clay);
    if (opts.cap !== undefined) u.uCap.value.set(opts.cap);
  }

  /** Reference-sheet pass: 0 shaded, 1 depth over [near, far] along the view (near
   *  white), 2 view-space normal (x right, y up, z toward the camera). */
  setPass(pass: 0 | 1 | 2, camera?: THREE.Camera, near = 0, far = 1) {
    this.version++;
    const u = this.material.uniforms;
    u.uPass.value = pass;
    if (!camera) return;
    camera.updateMatrixWorld();
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(u.uCamDir.value);
    u.uViewRot.value.setFromMatrix4(camera.matrixWorldInverse);
    u.uDepthRange.value.set(near, far);
  }

  /** After a lost GPU context: upload every texture again. */
  reupload() {
    this.version++;
    this.fieldVersion++;
    if (this.dataTex) this.dataTex.needsUpdate = true;
    for (const u of Object.values(this.material.uniforms)) {
      const v = u.value as { isTexture?: boolean; needsUpdate?: boolean } | null;
      if (v && v.isTexture) v.needsUpdate = true;
    }
    this.material.needsUpdate = true;
  }

  /** Keep the side the plane normal points to (three.js clipping convention). */
  setClip(plane: THREE.Plane | null) {
    this.version++;
    const u = this.material.uniforms;
    u.uClipOn.value = plane ? 1 : 0;
    if (plane) u.uClip.value.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  }

  /** `interactive`: while dragging, a profile whose table isn't built yet keeps its
   *  slot's previous table (a moment's stale preview); it is built on release. */
  setDoc(doc: SceneDoc, interactive = false) {
    this.version++;
    this.fieldVersion++;
    this.interactive = interactive;
    const groups = compileGroups(doc).slice(0, MAX_GROUPS);
    this.groups = groups;
    const u = this.material.uniforms;
    const objs: CompiledObject[] = [];
    const ranges = u.uGroupRange.value as Int32Array;
    groups.forEach((g, k) => {
      const a = objs.length;
      objs.push(...g.shells);
      const b = objs.length;
      objs.push(...g.solids);
      const c = objs.length;
      objs.push(...g.subs);
      ranges.set([a, b, c, objs.length], 4 * k);
      (u.uT.value as number[])[k] = g.t;
      (u.uK.value as number[])[k] = g.k;
      (u.uRound.value as number[])[k] = g.rim;
      (u.uHollow.value as number[])[k] = g.hollow ? 1 : 0;
      (u.uCutsBound.value as number[])[k] = g.cutsBound ? 1 : 0;
    });
    u.uGroupCount.value = groups.length;
    u.uObjCount.value = objs.length;
    const slots = this.updateProfiles(objs, groups, interactive);
    const shapes = this.updateSweeps(objs);
    // sweeps are evaluated once per map() call (see sweepAll); a sweep's slot in the
    // object rows is its index here, and its shape's texture slot goes alongside
    // beyond this, a sweep's bounding sphere stands in for it: farther than any
    // caller needs it exactly (blends, occlusion samples, cut walls)
    u.uSweepGate.value = 1.2 + Math.max(0, ...groups.map((g) => g.reach)) + 2 * Math.max(0, ...groups.map((g) => g.t));
    // the layer program, by object and body index; each body's widest blend (culling reach)
    const prog: number[] = [];
    const ks = groups.map(() => 0);
    const bodyOf = (o: CompiledObject) => groups.findIndex((g) => g.shells.includes(o) || g.solids.includes(o) || g.subs.includes(o));
    for (const n of groups[0]?.prog ?? []) {
      if (n.op === 0) {
        const i = objs.indexOf(n.o!);
        if (i < 0) continue;
        prog.push(0, i, (n.sub ? 1 : 0) | (n.solid ? 2 : 0) | (n.mask ? 4 : 0), n.k);
        const b = bodyOf(n.o!);
        if (b >= 0) ks[b] = Math.max(ks[b], n.k);
      } else if (n.op === 1) prog.push(1, 0, 0, 0);
      else prog.push(2, (n.sub ? 1 : 0) | (n.mask ? 4 : 0), n.g ? groups.indexOf(n.g) + 1 : 0, n.k);
    }
    ks.forEach((k, i) => {
      (u.uK.value as number[])[i] = Math.max(k, groups[i].k);
      (u.uReach.value as number[])[i] = Math.max(k, groups[i].k, groups[i].reach);
    });
    const cluster = this.clusters(objs, groups, prog);
    // sweeps are evaluated once per map() call (see sweepAll), listed by cluster; a
    // sweep's slot in the object rows is its place in the list
    const sweepObjs = u.uSweepObj.value as number[], sweepData = u.uSweepData.value as number[];
    const cluSw = u.uCluSw.value as Int32Array;
    const sw = objs.map((o, i) => ({ o, i })).filter(({ o }) => o.obj.type === 'sweep' && shapes.has(o))
      .sort((a, b) => (cluster.get(a.o) ?? 0) - (cluster.get(b.o) ?? 0) || a.i - b.i);
    cluSw.fill(0);
    let ns = 0;
    for (const { o, i } of sw) {
      if (ns >= MAX_SWEEP_OBJS) { slots.set(o, MAX_SWEEP_OBJS - 1); continue; }
      const c = cluster.get(o) ?? 0;
      if (cluSw[2 * c + 1] === 0) cluSw[2 * c] = ns;
      sweepObjs[ns] = i; sweepData[ns] = shapes.get(o)!; slots.set(o, ns++);
      cluSw[2 * c + 1] = ns;
    }
    u.uProgLen.value = Math.min(MAX_PROG, prog.length / 4);
    u.uProgRow.value = objs.length;
    this.writeData(objs, groups, slots, prog, cluster);
    this.bounds.makeEmpty();
    for (const g of groups) {
      if (g.bounds.min[0] > g.bounds.max[0]) continue; // a body of cuts only
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
    this.version++;
    this.fieldVersion++;
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
          // red: the cavity depth correction; green: the compound rounding (if any)
          const half = new Uint16Array(2 * c.data.length);
          for (let q = 0; q < c.data.length; q++) {
            half[2 * q] = THREE.DataUtils.toHalfFloat(c.data[q]);
            half[2 * q + 1] = THREE.DataUtils.toHalfFloat(c.round ? c.round[q] : 0);
          }
          const tex = new THREE.Data3DTexture(half, c.dims[0], c.dims[1], c.dims[2]);
          tex.type = THREE.HalfFloatType;
          tex.format = THREE.RGFormat;
          tex.minFilter = tex.magFilter = THREE.LinearFilter;
          tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
          tex.unpackAlignment = 1;
          tex.needsUpdate = true;
          this.gridTex[k] = tex;
        }
        this.gridSrc[k] = c;
      }
      u[`uCav${k}`].value = this.gridTex[k];
      (u.uUseGrid.value as number[])[k] = c && !c.noCavity ? 1 : 0;
      if (g) attachGrid(g, c); // CPU picking sees the rounding too
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

  /**
   * Clusters: each top-level layer (a group, or an object on its own) with its world
   * box and how far past it its objects can change the field (as rayMask grows an
   * object's box, less the ray's own reach and the grid's smoothing). A ray that
   * misses a cluster skips its objects, and map() jumps over a top-level group's
   * steps (its open step gets the jump). A cluster holding a mask is never culled.
   * Returns each object's cluster.
   */
  private clusters(objs: CompiledObject[], groups: CompiledGroup[], prog: number[]): Map<CompiledObject, number> {
    const u = this.material.uniforms;
    const of = new Map<CompiledObject, number>();
    const lo: number[][] = [], hi: number[][] = [], grow: number[] = [], never: boolean[] = [];
    const reach = u.uReach.value as number[], round = u.uRound.value as number[];
    const n = prog.length / 4;
    let depth = 0, cur = -1, open = -1;
    const start = () => {
      const c = Math.min(lo.length, MAX_CLUSTERS - 1);
      if (c === lo.length) { lo.push([Infinity, Infinity, Infinity]); hi.push([-Infinity, -Infinity, -Infinity]); grow.push(0); never.push(false); }
      return c;
    };
    for (let k = 0; k < n; k++) {
      const op = prog[4 * k];
      if (op === 1) { if (depth === 0) { cur = start(); open = k; } depth++; continue; }
      if (op === 2) {
        depth--;
        if (depth === 0 && open >= 0) {
          // the jump past the group, and its cluster (none when it has to stay: a mask)
          prog[4 * open + 1] = k + 1;
          prog[4 * open + 2] = never[cur] || (prog[4 * k + 1] & 4) ? 0 : cur + 1;
          if (prog[4 * k + 1] & 4) never[cur] = true;
          open = -1;
        }
        continue;
      }
      const c = depth === 0 ? start() : cur;
      const o = objs[prog[4 * k + 1]];
      of.set(o, c);
      const gi = groups.findIndex((g) => g.shells.includes(o) || g.solids.includes(o) || g.subs.includes(o));
      const b = o.worldBounds;
      for (let a = 0; a < 3; a++) { lo[c][a] = Math.min(lo[c][a], b.min[a]); hi[c][a] = Math.max(hi[c][a], b.max[a]); }
      const g = groups[gi];
      // (openings and cuts reach past an object only inside its own body, which is
      // inside the cluster: outside the cluster's box only blends reach)
      grow[c] = Math.max(grow[c], (reach[gi] ?? 0) + (round[gi] ?? 0) + (g ? g.k : 0) + 0.05);
      if (prog[4 * k + 2] & 4) never[c] = true;
    }
    // objects on no step (none expected) belong to every ray
    objs.forEach((o) => { if (!of.has(o)) { const c = start(); never[c] = true; of.set(o, c); } });
    lo.forEach((l, c) => {
      const big = never[c] || !(l[0] <= hi[c][0]);
      (u.uCluMin.value as THREE.Vector4[])[c].set(big ? -1e6 : l[0], big ? -1e6 : l[1], big ? -1e6 : l[2], grow[c]);
      (u.uCluMax.value as THREE.Vector4[])[c].set(big ? 1e6 : hi[c][0], big ? 1e6 : hi[c][1], big ? 1e6 : hi[c][2], 0);
    });
    u.uCluCount.value = lo.length;
    return of;
  }

  private writeData(objs: CompiledObject[], groups: CompiledGroup[], slots: Map<CompiledObject, number>, prog: number[], cluster: Map<CompiledObject, number>) {
    // the objects' rows, then the program's (ROWS steps a row)
    const n = Math.max(1, objs.length + Math.ceil(prog.length / 4 / ROWS));
    const data = new Float32Array(ROWS * 4 * n);
    data.set(prog, ROWS * 4 * objs.length);
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
        case 'box': data[k3] = q.x! / 2; data[k3 + 1] = q.y! / 2; data[k3 + 2] = q.z! / 2; data[k3 + 3] = o.round; break;
        case 'cylinder': case 'cone': case 'capsule': data[k3] = q.r!; data[k3 + 1] = q.h! / 2; break;
        case 'torus': data[k3] = q.R!; data[k3 + 1] = q.r!; break;
        case 'prism': {
          const n = Math.min(12, Math.max(3, Math.round(q.n!))), r2 = q.r2 ?? q.r!;
          data[k3] = n; data[k3 + 1] = q.r!; data[k3 + 2] = q.h! / 2; data[k3 + 3] = r2;
          // constants of the side planes (see frustumSide in the shader)
          const k7 = (i * ROWS + 7) * 4, c = Math.cos(Math.PI / n);
          data[k7] = o.round; data[k7 + 1] = c; data[k7 + 2] = Math.tan(Math.PI / n);
          data[k7 + 3] = 1 / Math.hypot(q.h!, (q.r! - r2) * c);
          break;
        }
        case 'sweep': {
          const { path, sec } = o.sweep!;
          data[k3] = SECTION_CODE[sec.kind]; data[k3 + 1] = sec.hw; data[k3 + 2] = sec.hd;
          data[k3 + 3] = { flat: 0, round: 1, square: 2 }[o.sweep!.style.cap] + (o.sweep!.style.join === 'miter' ? 4 : 0);
          const k7 = (i * ROWS + 7) * 4;
          data[k7] = path.n; data[k7 + 1] = sec.polyN; data[k7 + 2] = path.loop ? 1 : 0; data[k7 + 3] = path.length;
          break;
        }
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
      data[k6] = usesTable(o) ? TYPE_CODE.revolve : TYPE_CODE[o.obj.type];
      data[k6 + 1] = slots.get(o) ?? 0;
      data[k6 + 2] = holeMask(o, g);
      data[k6 + 3] = groups.indexOf(g);
      const lb = o.localBounds, k8 = (i * ROWS + 8) * 4, k9 = (i * ROWS + 9) * 4;
      data[k8] = lb.min[0]; data[k8 + 1] = lb.min[1]; data[k8 + 2] = lb.min[2]; data[k8 + 3] = cluster.get(o) ?? 0;
      data[k9] = lb.max[0]; data[k9 + 1] = lb.max[1]; data[k9 + 2] = lb.max[2];
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
  private sweepData = new Float32Array(MAX_PATH_POINTS * MAX_SWEEPS * SWEEP_ROWS * 4);
  private sweepTex = (() => {
    const t = new THREE.DataTexture(this.sweepData, MAX_PATH_POINTS, MAX_SWEEPS * SWEEP_ROWS, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  })();
  private sweepKeys: string[] = [];

  /** Sweep paths, frames and section outlines into the sweep texture (one slot per sweep). */
  /** Each sweep's texture slot: one per distinct shape (copies share theirs). */
  private updateSweeps(objs: CompiledObject[]): Map<CompiledObject, number> {
    const W = MAX_PATH_POINTS;
    const shapes = new Map<CompiledObject, number>(), byKey = new Map<string, number>();
    let slot = 0, changed = false;
    for (const o of objs) {
      if (o.obj.type !== 'sweep' || !o.sweep) continue;
      const key = JSON.stringify(o.obj.params);
      const had = byKey.get(key);
      if (had !== undefined) { shapes.set(o, had); continue; }
      if (slot >= MAX_SWEEPS) { shapes.set(o, MAX_SWEEPS - 1); continue; }
      byKey.set(key, slot);
      shapes.set(o, slot);
      if (this.sweepKeys[slot] !== key) {
        this.sweepKeys[slot] = key;
        changed = true;
        const { path, sec, style } = o.sweep;
        const g = sweepGeo(path, style.join);
        const put = (r: number, i: number, a: number, b: number, c: number, d: number) => {
          const k = ((slot * SWEEP_ROWS + r) * W + i) * 4;
          this.sweepData[k] = a; this.sweepData[k + 1] = b; this.sweepData[k + 2] = c; this.sweepData[k + 3] = d;
        };
        for (let i = 0; i < path.n; i++) {
          put(0, i, path.P[3 * i], path.P[3 * i + 1], path.P[3 * i + 2], path.s[i]);
          put(5, i, g.M[3 * i], g.M[3 * i + 1], g.M[3 * i + 2], 0);
          const J = g.J.subarray(12 * i, 12 * i + 12);
          put(6, i, J[0], J[1], J[2], J[3]); put(7, i, J[4], J[5], J[6], J[7]); put(8, i, J[8], J[9], J[10], J[11]);
        }
        for (let i = 0; i < g.segs; i++) {
          put(1, i, g.D[3 * i], g.D[3 * i + 1], g.D[3 * i + 2], g.L[i]);
          put(2, i, g.Na[3 * i], g.Na[3 * i + 1], g.Na[3 * i + 2], g.miter[i] + 2 * g.hasJ[i] + 4 * g.sharp[i]);
          put(4, i, g.Nb[3 * i], g.Nb[3 * i + 1], g.Nb[3 * i + 2], g.miter[i + 1] + 2 * g.hasJ[i + 1] + 4 * g.sharp[i + 1]);
        }
        for (let k = 0; k < sec.polyN; k++) put(3, k, sec.poly[2 * k], sec.poly[2 * k + 1], 0, 0);
        // a bounding sphere per chunk of segments (their end points)
        for (let c = 0; c * SWEEP_CHUNK < g.segs; c++) {
          const i0 = c * SWEEP_CHUNK, i1 = Math.min(i0 + SWEEP_CHUNK, g.segs);
          const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
          for (let i = i0; i <= i1; i++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], path.P[3 * i + a]); hi[a] = Math.max(hi[a], path.P[3 * i + a]); }
          const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
          let r = 0;
          for (let i = i0; i <= i1; i++) r = Math.max(r, Math.hypot(path.P[3 * i] - cx, path.P[3 * i + 1] - cy, path.P[3 * i + 2] - cz));
          put(9, c, cx, cy, cz, r + 1e-4);
        }
      }
      slot++;
    }
    if (changed) this.sweepTex.needsUpdate = true;
    return shapes;
  }

  private slotKeys: string[] = [];
  private updateProfiles(objs: CompiledObject[], groups: CompiledGroup[], interactive = false): Map<CompiledObject, number> {
    const u = this.material.uniforms;
    const slots = new Map<CompiledObject, number>();
    const keep = new Set<string>();
    let slot = 0;
    for (const o of objs) {
      if (!usesTable(o) || slot >= MAX_PROFILES) continue;
      const g = groups.find((x) => x.shells.includes(o) || x.solids.includes(o) || x.subs.includes(o))!;
      const isHole = (f: string) => g.holes.has(`${o.obj.id}|${f}`);
      const key = JSON.stringify([o.obj.type, o.obj.type === 'revolve' ? o.obj.params.points : Array.from(o.profile!.pts), o.round, o.profile!.faces.filter(isHole)]);
      let pt = this.profiles.get(key);
      if (!pt && interactive && this.slotKeys[slot] && this.profiles.has(this.slotKeys[slot])) {
        keep.add(this.slotKeys[slot]);
        slots.set(o, slot++);
        continue;
      }
      keep.add(key);
      this.slotKeys[slot] = key;
      if (!pt) {
        const t = buildProfileTable(tableProfile(o.obj.type, o.obj.params.points, o.profile!, o.round), isHole);
        const data = new Uint16Array(t.W * t.H * 2);
        for (let q = 0; q < t.W * t.H; q++) {
          data[2 * q] = THREE.DataUtils.toHalfFloat(t.sd[q]);
          data[2 * q + 1] = THREE.DataUtils.toHalfFloat(t.dh[q]);
        }
        const tex = new THREE.DataTexture(data, t.W, t.H, THREE.RGFormat, THREE.HalfFloatType);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        pt = { tex, min: t.min, max: t.max };
        this.profiles.set(key, pt);
      }
      u[`uProf${slot}`].value = pt.tex;
      (u.uProfLo.value as THREE.Vector2[])[slot].set(pt.min[0], pt.min[1]);
      (u.uProfHi.value as THREE.Vector2[])[slot].set(pt.max[0], pt.max[1]);
      (u.uProfSz.value as THREE.Vector2[])[slot].set(pt.tex.image.width, pt.tex.image.height);
      slots.set(o, slot);
      slot++;
    }
    for (const [k, v] of this.profiles) if (!keep.has(k)) { v.tex.dispose(); this.profiles.delete(k); }
    return slots;
  }
}

/** Drawn from a 2D profile table (shader type 7): revolves, and rounded cylinders and cones. */
function usesTable(o: CompiledObject): boolean {
  return o.obj.type === 'revolve' || ((o.obj.type === 'cylinder' || o.obj.type === 'cone') && o.round > 0);
}

/** Bit mask of a primitive's faces that are openings (layout matches holeDepth in the shader). */
function holeMask(o: CompiledObject, g: CompiledGroup): number {
  if (o.obj.mode === 'mask') return MASK_FLAG; // (not an opening: skipped by the cut-depth bound, never culled)
  if (isCut(o.obj.mode)) return o.obj.mode === 'cutout' ? 1 : 0; // a cutout gets no wall
  const h = (f: string) => g.holes.has(`${o.obj.id}|${f}`);
  if (usesTable(o)) return o.profile!.faces.some(h) ? 1 : 0;
  let names: string[] = [];
  switch (o.obj.type) {
    case 'sphere': case 'torus': case 'capsule': names = ['surface']; break;
    case 'box': names = ['px', 'nx', 'py', 'ny', 'pz', 'nz']; break;
    case 'cylinder': names = ['side', 'top', 'bottom']; break;
    case 'cone': names = ['base', 'side']; break;
    case 'prism': names = ['top', 'bottom', ...range(Math.max(3, Math.round(o.obj.params.n!))).map((i) => `side${i}`)]; break;
    case 'sweep': names = ['surface', 'start', 'end']; break;
    // revolves: which spans are open lives in the depth table; the mask only says
    // whether any are (the depth then carries on through the opening)
    default: return o.profile!.faces.some(h) ? 1 : 0;
  }
  return names.reduce((m, f, i) => (h(f) ? m | (1 << i) : m), 0);
}
