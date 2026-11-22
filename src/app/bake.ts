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
import { SlotSet, LIST_W, REFINE, SCATTER_F, SCATTER_V, CONE, CONE_PX, drawRows, ATLAS_W, BRICK_NEAR, BRICK_B, BRICK_N, BRICK_SHARP, BRICK_THR, BrickLevel, CLASSIFY, SETTLED } from './bricks';

/** Voxels along the box's longest side. */
const RES = 192;
/** A batch of layers is sized to take about this long on the GPU. */
const BATCH_MS = 30;
/** (prototype: time the refinement's steps, ?rt=1) */
const LIST_CREEP_N = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('ln') || 4);
const LIST_CREEP = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('lc') || 60);
const LIST_WIN = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('lw') || '0.6,1').split(',').map(Number);
const LIST_BACK = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('lb') || 0.2);
const SHOW_FLAGS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('fv') === '1';
/** Mid-drag exact pixels take their occlusion from the stale bake (1) or exactly (0). */
const DIRTY_AO = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('dao') || 1);
/** Mid-drag exact pixels at half resolution first, the rest from their means where smooth (colour spread, relative depth spread). */
const DIRTY_LEVELS = Math.max(1, +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('dl') || 3));
const DIRTY_CT = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('dct') || 12);
const DIRTY_CT1 = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('dct1') || 12);
const DIRTY_STEPS = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('dst') || 200);
const DIRTY_DT = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('ddt') || 0.03);
const DIRTY_NR = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('dnr') || 1.5);
const DEBUG_TIMES = typeof location !== 'undefined' && new URLSearchParams(location.search).get('rt') === '1';
/** The first batch, before the pace is known: this many rows of voxels. */
const FIRST_ROWS = 8;
/** Two-level coarse bake: map() only where the half-resolution field is within this many
 *  voxels of the surface (0: one level, every voxel exactly). */
const COARSE_BAND = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('cb') || 5);
/** Incremental bakes (an edit re-bakes only where the field changed); ?inc=0 turns them off. */
const INC = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('inc')) !== '0';
/** Atlas room for this many times the bricks (incremental bakes add bricks in place). */
const SLOT_SLACK = 1.25;
/** How far past where map() changes the snapshot boxes reach (raymarch.ts snapshot: 2.1, for the exact pass's taps;
 *  the occlusion taps reach 1.95), less a margin. */
const TAP_REACH = 2.0;
type Box = { min: [number, number, number]; max: [number, number, number] };
/** Inclusive voxel ranges [x0, y0, z0, x1, y1, z1]. */
type VBox = number[];
/** Band tiles: BAND_T × BAND_T fine voxels of one layer; the upsample pass in this many strips. */
const BAND_T = 4, UP_STRIPS = 4;
const UP_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uLow;
uniform vec3 uInv;
uniform float uZ;
out vec4 fragColor;
void main() { fragColor = vec4(texture(uLow, (vec3(gl_FragCoord.xy - 0.5, uZ) * 0.5 + 0.5) * uInv).r, 0.0, 0.0, 1.0); }`;
/** Rows of cells the classify pass draws per batch, and rows of slots the mask pass does. */
const CLASS_ROWS = 8, MASK_ROWS = 2;

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
  /** The half-resolution field the two-level bake starts from. */
  private low: THREE.WebGL3DRenderTarget | null = null;
  /** The two-level band (voxels; 0: one level). */
  coarseBand = COARSE_BAND;
  /** (probes) bake in full even where an incremental bake could run (the grid is kept). */
  noInc = false;
  private upScene = new THREE.Scene();
  private upMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: UP_FRAG, depthTest: false, depthWrite: false,
    uniforms: { uLow: { value: null }, uInv: { value: new THREE.Vector3(1, 1, 1) }, uZ: { value: 0 } },
  });
  private bandScene = new THREE.Scene();
  private bandGeo = new THREE.BufferGeometry();
  private bandStart = new Int32Array(1);
  private bandCount = new Int32Array(1);
  private lowVals: Float32Array | null = null;
  private classBits: Uint32Array | null = null;
  // ---- incremental bakes
  /** The fields the bricks may hold (the last complete brick bake and any incremental ones since). */
  private brickSnaps: FieldSnapshot[] = [];
  /** The brick layout the atlases hold: per cell +slot+1 (0: none), and per slot its cell (-1: free). */
  private slotInd: Float32Array | null = null;
  private slotCell: Int32Array | null = null;
  /** This bake's changed regions (null: a full bake): coarse voxels, low voxels, brick world boxes. */
  private inc: { fine: VBox[]; low: VBox[]; brick: Box[]; coarse: Box[] } | null = null;
  /** The slot subsets an incremental brick bake redraws: samples, copies (and curvature), shading. */
  private sets: { bake: SlotSet; copy: SlotSet; shade: SlotSet } | null = null;
  private job: { version: number; row: number; batch: number; fence: WebGLSync | null; at: number; t0: number; n: number; phase: number; tb: number; level: number; kind?: string } | null = null;
  /** Texels baked per ms, learned from the last batches. */
  private texRate = 0;
  /** The same for the passes that run no map() (copies, curvature, shading, upsampling), by kind. */
  private rates = new Map<string, number>();
  /** Texels a batch of this kind may draw: from its learned rate (at most 4x the last batch: rates are
   *  measured to the nearest frame), else from the map() rate. */
  private want(kind: string, last: number) {
    const r = kind === 'map' ? this.texRate : this.rates.get(kind) ?? this.texRate;
    if (!(r > 0)) return 0;
    return kind === 'map' || !last ? r * BATCH_MS : Math.min(r * BATCH_MS, 4 * last);
  }
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
  lastBake = { ms: 0, voxels: 0, bricks: [0, 0], samples: 0, brickMs: 0, classifyMs: 0, bandTiles: 0, allTiles: 0, inc: null as number[] | null, batches: 0 };
  // ---- fine bricks (bricks.ts)
  /** The field version the bricks hold (complete), or -1. */
  brickVersion = -1;
  private ind: THREE.Data3DTexture | null = null;
  private levels: BrickLevel[];
  /** What the settled pass reads: every level's values and second differences (RGBA). */
  private readAtlas: THREE.WebGL3DRenderTarget | null = null;
  /** Beside it: each sample's normal and occlusion (SHADE). */
  private shadeAtlas: THREE.WebGL3DRenderTarget | null = null;
  private zOff = [0, 0];
  private indS: THREE.Data3DTexture | null = null;
  private classMat: THREE.ShaderMaterial;
  private classScene = new THREE.Scene();
  private classRT: THREE.WebGLRenderTarget | null = null;
  readonly settledMat: THREE.ShaderMaterial;
  readonly settledScene = new THREE.Scene();
  readonly coneScene = new THREE.Scene();
  // exact refinement of flagged pixels (REFINE): the list, the exact pass over it, the scatter
  private listScene = new THREE.Scene();
  private listTex: THREE.DataTexture | null = null;
  private listRT: THREE.WebGLRenderTarget | null = null;
  private dirtyListScene = new THREE.Scene();
  private dirtyBuf = new Float32Array(4);
  lastDirty = { n: 0, readMs: 0, listMs: 0, exactMs: 0, nA: 0, nI: 0, nB: 0 };
  private dMark: Uint8Array | null = null;
  private dSE: Float32Array | null = null;
  private dIdx: Int32Array | null = null;
  private dRes: Float32Array | null = null;
  private resBuf = new Float32Array(4);
  private mixList: THREE.DataTexture | null = null;
  private mixRes: THREE.DataTexture | null = null;
  private scatterScene = new THREE.Scene();
  private scatterGeo = new THREE.BufferGeometry();
  private scatterMat: THREE.ShaderMaterial;
  private readBuf = new Uint8Array(4);
  /** Pixels the last settled frame resolved exactly, and how many it drew. */
  lastRefine = { flagged: 0, covered: 0 };
  private coneRT: THREE.WebGLRenderTarget | null = null;
  private cells = new Int32Array(3);
  /** The fields whose voxels the texture may hold (the last complete bake and any
   *  partial ones since), and whether a bake on its current grid has completed. */
  private snaps: FieldSnapshot[] = [];
  private geomOk = false;
  private dirtyKey = -1;
  private dirtyMemo: ReturnType<SdfRenderer['dirtyBoxes']> = null;
  /** The field the complete bricks (and the coarse texture under them) hold, until a bake
   *  starts overwriting them; null: none. */
  private brickSnap: FieldSnapshot | null = null;

  constructor(private sdf: SdfRenderer) {
    this.bakeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { ...sdf.material.uniforms, uBakeLow: { value: null }, uBakeLowInv: { value: new THREE.Vector3(1, 1, 1) }, uBakeBand: { value: 0 } },
      defines: { SDF_BAKE: 1 }, depthTest: false, depthWrite: false,
    });
    const m = new THREE.Mesh(tri(), this.bakeMat);
    m.frustumCulled = false;
    this.bakeScene.add(m);
    const um = new THREE.Mesh(tri(), this.upMat);
    um.frustumCulled = false;
    this.upScene.add(um);
    const bm = new THREE.Mesh(this.bandGeo, this.bakeMat);
    bm.frustumCulled = false;
    this.bandScene.add(bm);
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
    this.levels = BRICK_N.map((n) => new BrickLevel(n, FRAG, sdf.material.uniforms));
    this.classMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: CLASSIFY, depthTest: false, depthWrite: false,
      uniforms: { uTex: { value: null }, uCy: { value: 1 }, uRows: { value: 1 }, uThr: { value: 1 }, uSharp: { value: 1 }, uNear: { value: 1 }, uK0: { value: 0 }, uK1: { value: 1 << 20 } },
    });
    const cm = new THREE.Mesh(tri(), this.classMat);
    cm.frustumCulled = false;
    this.classScene.add(cm);
    this.settledMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: SETTLED, depthTest: true, depthWrite: true, defines: { CLIP: 0 },
      uniforms: {
        uTex: { value: null }, uIndS: { value: null }, uAtlasR: { value: null }, uAtlasG: { value: null }, uInvA: { value: new THREE.Vector3(1, 1, 1) }, uInvN: { value: new THREE.Vector3(1, 1, 1) }, uNm1: { value: new THREE.Vector3(1, 1, 1) }, uConeT: { value: null }, uFlagOn: { value: REFINE ? 1 : 0 }, uTMax: { value: 1 },
        uO: { value: this.origin }, uSize: { value: this.size }, uH: { value: 1 },
        uCells: { value: this.cells },
        uInvProjView: su.uInvProjView, uProjView: su.uProjView, uClip: su.uClip, uClipOn: su.uClipOn,
        uClay: su.uClay, uCap: su.uCap, uPixelAngle: su.uPixelAngle, uPixelSize: su.uPixelSize, uFlat: su.uFlat,
      },
    });
    const sm = new THREE.Mesh(tri(), this.settledMat);
    sm.frustumCulled = false;
    sm.onBeforeRender = (r, s, c, g, mat, grp) => sdf.mesh.onBeforeRender(r, s, c, g, mat, grp);
    this.settledScene.add(sm);
    const u2 = this.settledMat.uniforms;
    const coneMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: CONE, depthTest: false, depthWrite: false,
      uniforms: {
        uTex: u2.uTex, uO: u2.uO, uSize: u2.uSize, uH: u2.uH, uInvProjView: su.uInvProjView, uClip: su.uClip, uClipOn: su.uClipOn,
        uPixelAngle: su.uPixelAngle, uPixelSize: su.uPixelSize, uInvN: u2.uInvN, uNm1: u2.uNm1, uFull: { value: new THREE.Vector2(1, 1) },
      },
    });
    const cm2 = new THREE.Mesh(tri(), coneMat);
    cm2.frustumCulled = false;
    cm2.onBeforeRender = (r, s, c, g, mat, grp) => sdf.mesh.onBeforeRender(r, s, c, g, mat, grp);
    this.coneScene.add(cm2);
    const lm = new THREE.Mesh(tri(), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: sdf.material.uniforms,
      defines: { SDF_LIST: 1, LIST_CREEP, LIST_CREEP_N }, depthTest: false, depthWrite: false,
    }));
    lm.frustumCulled = false;
    lm.onBeforeRender = (r, s, c, g, mat, grp) => sdf.mesh.onBeforeRender(r, s, c, g, mat, grp);
    this.listScene.add(lm);
    // mid-drag: the pixels whose rays meet a changed box, exactly (dirtyPass)
    const dm = new THREE.Mesh(tri(), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: sdf.material.uniforms,
      defines: { SDF_DIRTY: 1, DIRTY_ONLY: 1, DIRTY_AO, DIRTY_NR: 24, DIRTY_STEPS }, depthTest: false, depthWrite: false,
    }));
    dm.frustumCulled = false;
    dm.onBeforeRender = (r, s, c, g, mat, grp) => sdf.mesh.onBeforeRender(r, s, c, g, mat, grp);
    this.dirtyListScene.add(dm);
    this.scatterMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SCATTER_V, fragmentShader: SCATTER_F,
      uniforms: { uList: { value: null }, uRes: { value: null }, uViewSize: { value: new THREE.Vector2(1, 1) } },
      depthTest: false, depthWrite: true, blending: THREE.NoBlending,
    });
    const pts = new THREE.Points(this.scatterGeo, this.scatterMat);
    pts.frustumCulled = false;
    this.scatterScene.add(pts);
  }

  /** The cone pre-pass for a W × H frame, into its own target (the settled pass reads it). */
  drawCone(renderer: THREE.WebGLRenderer, camera: THREE.Camera, W: number, H: number) {
    const w = Math.ceil(W / CONE_PX), h = Math.ceil(H / CONE_PX);
    if (!this.coneRT || this.coneRT.width !== w || this.coneRT.height !== h) {
      this.coneRT?.dispose();
      this.coneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false });
      this.coneRT.texture.minFilter = this.coneRT.texture.magFilter = THREE.NearestFilter;
      this.coneRT.texture.generateMipmaps = false;
    }
    // (the block's centre ray: the low target's pixel centres map to the blocks' centres
    // only when W and H are multiples of CONE_PX; the cone's slack covers the rest)
    ((this.coneScene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial).uniforms.uFull.value.set(W, H);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.coneRT);
    renderer.render(this.coneScene, camera);
    renderer.setRenderTarget(prev);
    this.settledMat.uniforms.uConeT.value = this.coneRT.texture;
  }

  /**
   * Resolve the pixels the bricks pass flagged (alpha 0.5, start distance in rgb) with the
   * exact settled pass, one fragment per flagged pixel in a compact list, and put the results
   * back into frame t. Returns the number of flagged pixels.
   */
  refine(renderer: THREE.WebGLRenderer, camera: THREE.Camera, t: THREE.WebGLRenderTarget, tMax: number) {
    if (!REFINE || SHOW_FLAGS) return 0;
    const W = t.width, H = t.height;
    if (this.readBuf.length !== W * H * 4) this.readBuf = new Uint8Array(W * H * 4);
    const px = this.readBuf;
    const T0 = performance.now();
    renderer.readRenderTargetPixels(t, 0, 0, W, H, px);
    const T1 = performance.now();
    let n = 0, covered = 0, hits = 0;
    for (let i = 3; i < px.length; i += 4) { if (px[i] === 128 || px[i] === 129) { n++; if (px[i] === 129) hits++; } else if (px[i]) covered++; }
    this.lastRefine = { flagged: n, covered, hits } as typeof this.lastRefine;
    (window as unknown as { __refine: unknown }).__refine = this.lastRefine;
    if (!n) return 0;
    // (4 consecutive entries fill one 2×2 quad: neighbouring pixels run side by side)
    const L = this.listFor(n);
    let k = 0;
    for (let i = 0; i < W * H; i++) {
      const al = px[i * 4 + 3];
      if (al !== 128 && al !== 129) continue;
      const v = px[i * 4] * 65536 + px[i * 4 + 1] * 256 + px[i * 4 + 2];
      const o = FieldBake.slot(k);
      L[o] = i % W; L[o + 1] = Math.floor(i / W); L[o + 2] = (v / 16777215) * tMax; L[o + 3] = al - 127;
      k++;
    }
    const T2 = performance.now();
    const u = this.sdf.material.uniforms;
    u.uStartBack.value = LIST_BACK * this.h; u.uListWin.value.set(LIST_WIN[0], LIST_WIN[1]);
    const T3 = this.runList(renderer, camera, t, n, this.listScene);
    if (DEBUG_TIMES) { renderer.readRenderTargetPixels(t, 0, 0, 1, 1, new Uint8Array(4)); Object.assign(this.lastRefine, { readMs: T1 - T0, listMs: T2 - T1, exactMs: T3 - T2, scatterMs: performance.now() - T3 }); }
    return n;
  }

  /** A list texture of at least n entries (4 consecutive entries fill one 2×2 quad), cleared. */
  private listFor(n: number) {
    const rows = 2 * Math.ceil(n / (2 * LIST_W));
    if (!this.listTex || this.listTex.image.height < rows) {
      this.listTex?.dispose();
      this.listTex = new THREE.DataTexture(new Float32Array(LIST_W * rows * 4), LIST_W, rows, THREE.RGBAFormat, THREE.FloatType);
      this.listTex.minFilter = this.listTex.magFilter = THREE.NearestFilter;
    }
    const L = this.listTex.image.data as Float32Array;
    L.fill(0);
    return L;
  }

  /** Where list entry k goes in the list texture (float offset). */
  private static slot(k: number) {
    const q = k >> 2, hq = LIST_W >> 1;
    return ((Math.floor(q / hq) * 2 + ((k >> 1) & 1)) * LIST_W + (q % hq) * 2 + (k & 1)) * 4;
  }

  /** The exact pass (scene) over the list's n entries, then each result back into frame t. Returns when the exact pass was issued. */
  private runList(renderer: THREE.WebGLRenderer, camera: THREE.Camera, t: THREE.WebGLRenderTarget, n: number, scene: THREE.Scene, scatter = true) {
    const W = t.width, H = t.height;
    this.listTex!.needsUpdate = true;
    const lh = this.listTex!.image.height;
    if (!this.listRT || this.listRT.height !== lh) {
      this.listRT?.dispose();
      this.listRT = new THREE.WebGLRenderTarget(LIST_W, lh, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
      this.listRT.texture.minFilter = this.listRT.texture.magFilter = THREE.NearestFilter;
    }
    // the exact pass over the list (misses discard: the target clears to 0, no hit)
    const u = this.sdf.material.uniforms;
    u.uStartOn.value = 1; u.uStartT.value = this.listTex;
    u.uBakeO.value.copy(this.origin); u.uViewSize.value.set(W, H);
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    const clear = renderer.getClearColor(new THREE.Color()), clearA = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.listRT);
    renderer.render(scene, camera);
    u.uStartOn.value = 0;
    if (DEBUG_TIMES) { const b = new Float32Array(4); renderer.readRenderTargetPixels(this.listRT, 0, 0, 1, 1, b); }
    const T3 = performance.now();
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clear, clearA);
    if (scatter) this.scatter(renderer, t, this.listTex!, this.listRT.texture, n);
    return T3;
  }

  /** Results res (packed colour, depth, hit) of the list's n entries back into frame t, one point each. */
  private scatter(renderer: THREE.WebGLRenderer, t: THREE.WebGLRenderTarget, list: THREE.Texture, res: THREE.Texture, n: number) {
    const W = t.width, H = t.height;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    if (!this.scatterGeo.getAttribute('position') || this.scatterGeo.getAttribute('position').count < n) {
      this.scatterGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(n, 1024) * 3 * 2), 3));
    }
    this.scatterGeo.setDrawRange(0, n);
    const su = this.scatterMat.uniforms;
    su.uList.value = list; su.uRes.value = res; su.uViewSize.value.set(W, H);
    renderer.autoClear = false;
    renderer.setRenderTarget(t);
    renderer.render(this.scatterScene, this.bakeCam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }

  /**
   * Mid-drag, over frame t drawn from the stale bricks: the pixels whose rays meet a changed
   * box before the stale hit (the bake holds the field exactly everywhere else) are resolved
   * exactly, from a list, and written over it; a ray the shifted field can't meet clears.
   * st: the stale start pass at t's size (float: ts, tS, closest approach, where).
   * Returns the number of pixels resolved.
   */
  dirtyPass(renderer: THREE.WebGLRenderer, camera: THREE.Camera, t: THREE.WebGLRenderTarget, st: THREE.WebGLRenderTarget, d: NonNullable<ReturnType<SdfRenderer['dirtyBoxes']>>, rect: [number, number, number, number]) {
    const W = t.width, H = t.height, h = this.h, back = 0.5 * h;
    if (this.dirtyBuf.length < W * H * 4) this.dirtyBuf = new Float32Array(W * H * 4);
    const S = this.dirtyBuf;
    const T0 = performance.now();
    const [rx0, ry0, rx1, ry1] = rect, rw = rx1 - rx0, rh = ry1 - ry0;
    const N = W * H;
    if (!this.dMark || this.dMark.length !== N) { this.dMark = new Uint8Array(N); this.dSE = new Float32Array(2 * N); this.dIdx = new Int32Array(N); }
    const mark = this.dMark, se = this.dSE!;
    mark.fill(0);
    let nd = 0;
    if (rw > 0 && rh > 0) renderer.readRenderTargetPixels(st, rx0, ry0, rw, rh, S);
    const T1 = performance.now();
    const shiftOn = Number.isFinite(d.shift) && d.shift > 0;
    const pa = this.sdf.material.uniforms.uPixelAngle.value as number, ps = this.sdf.material.uniforms.uPixelSize.value as number;
    const boxes = [...d.full, ...d.cavity], nb = boxes.length;
    const bl = new Float64Array(6 * nb);
    boxes.forEach((B, k) => { for (let c = 0; c < 3; c++) { bl[6 * k + c] = B.min[c]; bl[6 * k + 3 + c] = B.max[c]; } });
    const M = (this.sdf.material.uniforms.uInvProjView.value as THREE.Matrix4).elements;
    // (the ray through a pixel centre as the shader makes it: near and far points)
    const a = [0, 0, 0], b = [0, 0, 0];
    const pt = (x: number, y: number, z: number, o: number[]) => {
      const w = M[3] * x + M[7] * y + M[11] * z + M[15];
      o[0] = (M[0] * x + M[4] * y + M[8] * z + M[12]) / w; o[1] = (M[1] * x + M[5] * y + M[9] * z + M[13]) / w; o[2] = (M[2] * x + M[6] * y + M[10] * z + M[14]) / w;
    };
    const put = (i: number, s0: number, s1: number) => { mark[i] = 1; se[2 * i] = s0; se[2 * i + 1] = s1; nd++; };
    for (let y = ry0; y < ry1; y++) {
      const ny = ((y + 0.5) / H) * 2 - 1;
      for (let x = rx0; x < rx1; x++) {
        const nx = ((x + 0.5) / W) * 2 - 1;
        pt(nx, ny, -1, a); pt(nx, ny, 1, b);
        let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const l = Math.hypot(dx, dy, dz);
        const ix = l / dx, iy = l / dy, iz = l / dz;
        let tD = 1e9, tDx = -1e9;
        for (let k = 0; k < nb; k++) {
          const o = 6 * k;
          let p = (bl[o] - a[0]) * ix, q = (bl[o + 3] - a[0]) * ix;
          let lo = Math.max(0, Math.min(p, q)), hi = Math.min(1e9, Math.max(p, q));
          p = (bl[o + 1] - a[1]) * iy; q = (bl[o + 4] - a[1]) * iy;
          lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q));
          p = (bl[o + 2] - a[2]) * iz; q = (bl[o + 5] - a[2]) * iz;
          lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q));
          if (lo <= hi) { if (lo < tD) tD = lo; if (hi > tDx) tDx = hi; }
        }
        if (tD > 1e8) continue;
        const i = ((y - ry0) * rw + (x - rx0)) * 4, ts = S[i], tS = S[i + 1], pi = y * W + x;
        if (ts >= 0 && ts + 3 * h < tD) continue;
        if (ts < -1.5) { tD = Math.min(tD, tS >= 0 ? tS : 0); tDx = 1e9; }
        const shiftOk = shiftOn && tS > -2.5;
        // (the shifted field never came near: a miss; how near in pixels, from the stale march's closest approach)
        if (shiftOk && ts === -1 && tS < 0) { put(pi, -Math.max(1e-3, (S[i + 2] - d.shift - h) / (pa * Math.max(S[i + 3], 0) + ps + 1e-6)), -1); continue; }
        let t0 = (ts >= 0 ? Math.min(ts, tD) : tD) - back;
        if (shiftOk && tS >= 0) t0 = Math.max(t0, tS - back);
        put(pi, Math.max(t0, 0), ts < -1.5 ? 1e9 : Math.max(tDx, ts) + 3 * h);
      }
    }
    const T2 = performance.now();
    this.lastDirty = { n: nd, readMs: T1 - T0, listMs: T2 - T1, exactMs: 0, nA: 0, nI: 0, nB: 0 };
    (window as unknown as { __dirty: unknown }).__dirty = this.lastDirty;
    if (!nd) return 0;
    // Coarse to fine: the pixels on a grid of spacing 2^(levels-1) exactly; then each finer
    // grid's new pixels take the mean of the 2 or 4 resolved pixels around them where those
    // agree (all hit with nearly the same colour and depth, or all missed far from any
    // surface), the rest exactly; once per level, so a level's means can stand on the last.
    if (!this.dRes || this.dRes.length !== 4 * N) this.dRes = new Float32Array(4 * N);
    const res = this.dRes, state = this.dIdx!; // state: 1 resolved, 0 not
    state.fill(0);
    const cam = camera as THREE.PerspectiveCamera, near = cam.near, far = cam.far;
    // (misses report how near they came in the shader's pixel units, uPixelAngle * t + uPixelSize:
    // to this frame's pixels; a pixel's ray between samples sp pixels apart is within sp·√2 of one)
    const toPx = cam.isPerspectiveCamera ? pa / ((2 * Math.tan((cam.fov * Math.PI) / 360)) / (cam.zoom * H)) : 0.5;
    const lin = (z: number) => (2 * near * far) / (far + near - (2 * z - 1) * (far - near));
    const exact: number[] = [];
    let nA = 0, nB = 0, nI = 0;
    const why = [0, 0, 0, 0, 0, 0], passes: number[] = [];
    Object.assign(this.lastDirty, { why, passes });
    const runExact = () => {
      const n = exact.length;
      if (!n) return;
      const tp = performance.now();
      const L = this.listFor(n);
      for (let k = 0; k < n; k++) { const i = exact[k], o = FieldBake.slot(k); L[o] = i % W; L[o + 1] = (i / W) | 0; L[o + 2] = se[2 * i]; L[o + 3] = se[2 * i + 1]; }
      this.runList(renderer, camera, t, n, this.dirtyListScene, false);
      const rows = this.listTex!.image.height;
      if (this.resBuf.length < LIST_W * rows * 4) this.resBuf = new Float32Array(LIST_W * rows * 4);
      const R = this.resBuf;
      renderer.readRenderTargetPixels(this.listRT!, 0, 0, LIST_W, rows, R);
      for (let k = 0; k < n; k++) { const i = exact[k], o = FieldBake.slot(k); for (let c = 0; c < 4; c++) res[4 * i + c] = R[o + c]; state[i] = 1; }
      passes.push(n, Math.round(performance.now() - tp));
      exact.length = 0;
    };
    const corners: number[] = [];
    for (let lv = DIRTY_LEVELS - 1; lv >= 0; lv--) {
      const sp = 1 << lv, S2 = sp * 2, top = lv === DIRTY_LEVELS - 1;
      for (let y = 0; y < H; y += sp) for (let x = 0; x < W; x += sp) {
        const i = y * W + x;
        if (!mark[i] || state[i]) continue;
        if (top) { exact.push(i); nA++; continue; }
        corners.length = 0;
        let ok = true;
        for (const yy of y % S2 ? [y - sp, y + sp] : [y]) for (const xx of x % S2 ? [x - sp, x + sp] : [x]) {
          const j = yy * W + xx;
          if (xx >= W || yy >= H || !mark[j] || !state[j]) { ok = false; break; }
          corners.push(4 * j);
        }
        if (ok) {
          let nHit = 0, far = 0;
          for (const o of corners) { if (res[o + 2] >= 0.5) nHit++; else if (res[o + 3] * toPx >= DIRTY_NR * sp) far++; }
          if (far === corners.length) { res[4 * i] = 0; res[4 * i + 1] = 1; res[4 * i + 2] = 0; res[4 * i + 3] = Math.min(...corners.map((o) => res[o + 3])) - sp / toPx; state[i] = 1; nI++; continue; }
          if (nHit === corners.length) {
            let rl = 255, rh = 0, gl = 255, gh = 0, bl = 255, bh = 0, zl = 1e30, zh = 0, rs = 0, gs = 0, bs = 0, zs = 0;
            for (const o of corners) {
              const v = res[o], r = v % 256, g = Math.floor(v / 256) % 256, bb = Math.floor(v / 65536), z = lin(res[o + 1]);
              rl = Math.min(rl, r); rh = Math.max(rh, r); gl = Math.min(gl, g); gh = Math.max(gh, g); bl = Math.min(bl, bb); bh = Math.max(bh, bb);
              zl = Math.min(zl, z); zh = Math.max(zh, z); rs += r; gs += g; bs += bb; zs += res[o + 1];
            }
            const cs = Math.max(rh - rl, gh - gl, bh - bl);
            if (cs <= (sp === 1 ? DIRTY_CT1 : DIRTY_CT) && zh - zl <= DIRTY_DT * zl) {
              const c = corners.length;
              res[4 * i] = Math.round(rs / c) + Math.round(gs / c) * 256 + Math.round(bs / c) * 65536; res[4 * i + 1] = zs / c; res[4 * i + 2] = 1; res[4 * i + 3] = 0;
              state[i] = 1; nI++;
              continue;
            }
            why[cs > (sp === 1 ? DIRTY_CT1 : DIRTY_CT) ? 4 : 5]++;
          } else why[nHit ? 3 : 2]++;
        } else why[0]++;
        exact.push(i); nB++;
      }
      runExact();
    }
    // every listed pixel back into the frame at once
    const nMax = nd;
    const rows2 = 2 * Math.ceil(nMax / (2 * LIST_W));
    if (!this.mixList || this.mixList.image.height < rows2) {
      this.mixList?.dispose(); this.mixRes?.dispose();
      this.mixList = new THREE.DataTexture(new Float32Array(LIST_W * rows2 * 4), LIST_W, rows2, THREE.RGBAFormat, THREE.FloatType);
      this.mixRes = new THREE.DataTexture(new Float32Array(LIST_W * rows2 * 4), LIST_W, rows2, THREE.RGBAFormat, THREE.FloatType);
      for (const tx of [this.mixList, this.mixRes]) { tx.minFilter = tx.magFilter = THREE.NearestFilter; }
    }
    const ML = this.mixList.image.data as Float32Array, MR = this.mixRes!.image.data as Float32Array;
    let m = 0;
    for (let i = 0; i < N; i++) {
      if (!mark[i]) continue;
      const o = FieldBake.slot(m++);
      ML[o] = i % W; ML[o + 1] = (i / W) | 0; MR[o] = res[4 * i]; MR[o + 1] = res[4 * i + 1]; MR[o + 2] = res[4 * i + 2]; MR[o + 3] = 0;
    }
    this.mixList.needsUpdate = true; this.mixRes!.needsUpdate = true;
    this.scatter(renderer, t, this.mixList, this.mixRes!, m);
    Object.assign(this.lastDirty, { nA, nI, nB });
    if (DEBUG_TIMES) { renderer.readRenderTargetPixels(t, 0, 0, 1, 1, new Uint8Array(4)); this.lastDirty.exactMs = performance.now() - T2; }
    return nd;
  }

  /**
   * The pixel rect [x0, y0, x1, y1) (GL rows, bottom up) of a W × H frame that the changed boxes
   * can cover (every ray meeting one passes through it); the whole frame if one reaches behind the camera.
   */
  static dirtyRect(camera: THREE.Camera, W: number, H: number, d: NonNullable<ReturnType<SdfRenderer['dirtyBoxes']>>): [number, number, number, number] {
    const boxes = [...d.full, ...d.cavity];
    if (!boxes.length) return [0, 0, 0, 0];
    const pv = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const v = new THREE.Vector4();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const B of boxes) for (let c = 0; c < 8; c++) {
      v.set(c & 1 ? B.max[0] : B.min[0], c & 2 ? B.max[1] : B.min[1], c & 4 ? B.max[2] : B.min[2], 1).applyMatrix4(pv);
      if (v.w <= 1e-6) return [0, 0, W, H];
      const px = (v.x / v.w * 0.5 + 0.5) * W, py = (v.y / v.w * 0.5 + 0.5) * H;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    const cl = (u: number, n: number) => Math.max(0, Math.min(n, u));
    return [cl(Math.floor(x0) - 2, W), cl(Math.floor(y0) - 2, H), cl(Math.ceil(x1) + 2, W), cl(Math.ceil(y1) + 2, H)];
  }

  /** The mid-drag exact pass's program, compiled at rest (once): the first drag frame would pay for it. */
  private dirtyWarm = false;
  private warmDirty(renderer: THREE.WebGLRenderer) {
    if (this.dirtyWarm) return;
    this.dirtyWarm = true;
    // (a real draw of one empty entry: the driver may build the program only when it is drawn)
    this.listFor(1);
    const tgt = this.listRT ?? new THREE.WebGLRenderTarget(1, 1);
    this.runList(renderer, this.bakeCam, tgt, 1, this.dirtyListScene, false);
    if (!this.listRT) tgt.dispose();
  }

  /** The bricks match the field (the settled frame can come from them). */
  get bricksReady() { return this.brickVersion === this.sdf.fieldVersion && this.ready; }

  get ready() { return this.readyVersion === this.sdf.fieldVersion && !!this.target; }
  get busy() { return !!this.job; }
  get originVec() { return this.origin; }
  /** Voxel size, for the exact pass's starting margin. */
  get voxel() { return this.h; }

  /** Forget what an incremental bake would build on (a different document): the next bake is a full one. */
  forget() { this.snaps = []; this.brickSnaps = []; this.slotInd = null; this.slotCell = null; this.geomOk = false; this.inc = null; this.brickSnap = null; }

  /** Forget the bake (the GPU context it lived in is gone). */
  reset() { this.target?.dispose(); this.target = null; this.low?.dispose(); this.low = null; this.job = null; this.readyVersion = -1; this.brickVersion = -1; for (const l of this.levels) l.dispose(); this.classRT?.dispose(); this.classRT = null; this.snaps = []; this.geomOk = false; this.brickSnap = null; this.dirtyWarm = false; }

  /**
   * Mid-drag (the field changed since the bake): where the baked texture may be wrong, as
   * world boxes; everywhere else it still holds the field exactly. null: unusable (no
   * complete bake on this grid, or the program's shape changed). Once per field version.
   */
  /** Mid-drag: the bricks still hold the field the stale bake does, whole (staleDirty's boxes
   *  are where they may be wrong); the settled pass can draw from them. */
  get staleBricks() { return !!this.brickSnap && this.geomOk && !!this.target && this.snaps.length === 1 && this.snaps[0] === this.brickSnap; }

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
      if (j.batch > 0) { if (!j.kind || j.kind === 'map') this.texRate = j.batch / ms; else this.rates.set(j.kind, j.batch / ms); }
      if (j.n < 30 || j.n % 20 === 0) dlog('bake-batch', { n: j.n, texels: j.batch, ms, phase: j.phase, row: j.row });
    }
    const t = this.target!;
    // one paced batch of rows of the current target (rows of texels across all its layers)
    // (total, width: rows to draw and texels per row, when not the whole target's)
    const batch = (target: THREE.WebGL3DRenderTarget, draw: (r0: number, n: number) => void, total = target.height * target.depth, width = target.width, kind = 'map') => {
      const w = this.want(kind, j.kind === kind ? j.batch : 0);
      const n = Math.max(1, Math.min(total - j.row, w > 0 ? Math.round(w / width) : Math.ceil(FIRST_ROWS * t.width / width)));
      if (total > 0) {
        draw(j.row, n);
        j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      }
      j.row += n; j.batch = n * width; j.kind = kind; j.at = performance.now(); j.n++;
      return j.row >= total;
    };
    if (j.phase === 0 && j.level === 0 && this.low) {
      const [rows, w] = this.inc ? regionRows(this.inc.low) : [this.low.height * this.low.depth, this.low.width];
      if (batch(this.low, (r0, n) => this.drawLow(renderer, r0, n), rows, w)) { j.level = 1; j.row = 0; }
      return true;
    }
    if (j.phase === 0 && j.level === 1) {
      // (the low field is done: read it back, list the band tiles) the upsampled field, in a few cheap strips
      if (j.row === 0) this.bandTiles(renderer);
      const total = this.inc ? regionRows(this.inc.fine)[0] : t.height * t.depth, n = Math.max(1, Math.ceil(total / UP_STRIPS));
      this.drawUp(renderer, j.row, Math.min(n, total - j.row));
      j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      j.row += n; j.batch = 0; j.kind = 'up'; j.at = performance.now(); j.n++;
      if (j.row >= total) { j.level = 2; j.row = 0; }
      return true;
    }
    if (j.phase === 0 && j.level === 2) {
      // map() over the band tiles, a paced number of tiles (whole layers) at a time
      const total = this.bandStart[t.depth];
      const want = Math.max(1, Math.round(this.texRate > 0 ? this.texRate * BATCH_MS / (BAND_T * BAND_T) : FIRST_ROWS * t.width / (BAND_T * BAND_T)));
      const q1 = Math.min(total, j.row + want);
      if (q1 > j.row) {
        this.drawBand(renderer, j.row, q1);
        j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      }
      j.batch = (q1 - j.row) * BAND_T * BAND_T; j.kind = 'map'; j.row = q1; j.at = performance.now(); j.n++;
      if (j.row < total) return true;
      j.level = 3;
    }
    if (j.phase === 0 && (j.level === 3 || batch(t, (r0, n) => this.drawRows(renderer, r0, n)))) {
      {
        j.level = 0;
        this.readyVersion = v;
        this.done();
        this.lastBake.ms = performance.now() - j.t0;
        this.lastBake.voxels = t.width * t.height * t.depth;
        dlog('bake-done', { ms: this.lastBake.ms, batches: j.n, dims: `${t.width}x${t.height}x${t.depth}` });
        // next: find the band cells (a readback, once the GPU is done), then bake their bricks
        j.phase = 1; j.row = 0; j.tb = performance.now();
      }
      return true;
    }
    if (j.phase === 1) {
      // the classify pass in strips of rows, then (once the GPU is done) its readback
      const H = this.classDraw(renderer, j.row, CLASS_ROWS);
      if (j.row < H) {
        j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        j.row += CLASS_ROWS; j.batch = 0; j.at = performance.now(); j.n++;
        return true;
      }
      this.classify(renderer);
      j.phase = 1.5; j.row = 0; j.level = 0; j.batch = 0;
      return true;
    }
    if (j.phase === 1.5) {
      // each level's object masks, a few rows of slots at a time (incremental: the changed slots')
      if (this.sets && this.levels[0].maskRows() === this.levels[0].slotTex!.image.height) {
        this.levels[0].maskSlots(renderer, this.origin, this.h, this.sets.bake.slots);
        j.phase = 2; j.row = 0; j.level = 0; j.batch = 0;
        return true;
      }
      while (j.level < this.levels.length) {
        const L = this.levels[j.level];
        const H = L.count ? L.masks(renderer, this.origin, this.h, j.row, MASK_ROWS) : 0;
        if (j.row < H) {
          j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          gl.flush();
          j.row += MASK_ROWS; j.at = performance.now(); j.n++;
          return true;
        }
        j.level++; j.row = 0;
      }
      j.phase = 2; j.row = 0; j.level = 0; j.batch = 0;
      return true;
    }
    // incremental: 2 the changed slots' samples, 3 copies, 4 curvature, 5 shading, each over its slot set
    if (this.sets) {
      const L = this.levels[0], sets = this.sets;
      while (j.phase <= 5) {
        const set = j.phase === 2 ? sets.bake : j.phase === 3 || j.phase === 4 ? sets.copy : sets.shade;
        if (j.row < set.n) {
          const per = j.phase === 2 ? L.N ** 3 : L.S ** 3, kind = ['map', 'copy', 'curv', 'shade'][j.phase - 2];
          const w = this.want(kind, j.kind === kind ? j.batch : 0);
          const n = Math.max(1, Math.min(set.n - j.row, w > 0 ? Math.round(w / per) : 64));
          const q0 = j.row;
          if (j.phase === 2) L.draw(renderer, this.origin, this.h, q0, n, set);
          else if (j.phase === 3) L.copy(renderer, 0, this.levels, this.ind!, this.cells, q0, n, set);
          else L.curvSet(renderer, this.readAtlas!, this.zOff[0], set, q0, q0 + n, j.phase === 5 ? this.shadeAtlas : null);
          j.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
          j.row += n; j.batch = n * per; j.kind = kind; j.at = performance.now(); j.n++;
          return true;
        }
        j.row = 0; j.phase++;
      }
      return this.bricksDone(renderer, v, j.tb);
    }
    // 2: each level's brick samples (the exact field); 3: each level's atlas from them (copies)
    while (j.phase <= 4) {
      const L = this.levels[j.level];
      const tgt = L && L.count ? (j.phase === 2 ? L.bakeTarget : j.phase === 3 ? L.copyTarget : L.atlas) : null;
      const rows = tgt ? L.rowsUsed(tgt, tgt !== L.atlas ? L.N : L.S) : 0;
      if (tgt && j.row < rows) {
        if (j.phase === 2) batch(tgt, (r0, n) => L.draw(renderer, this.origin, this.h, r0, n), rows);
        else if (j.phase === 3) batch(tgt, (r0, n) => L.copy(renderer, j.level, this.levels, this.ind!, this.cells, r0, n), rows, tgt.width, 'copy');
        else { const lv = j.level; batch(tgt, (r0, n) => L.curv(renderer, this.readAtlas!, this.zOff[lv], r0, n, this.shadeAtlas), rows, tgt.width, 'curvshade'); }
        return true;
      }
      j.row = 0; j.level++;
      if (j.level >= this.levels.length) { j.level = 0; j.phase++; }
    }
    return this.bricksDone(renderer, v, j.tb);
  }

  private bricksDone(renderer: THREE.WebGLRenderer, v: number, tb: number) {
    this.brickVersion = v;
    this.brickSnap = this.snaps[this.snaps.length - 1] ?? null;
    this.brickSnaps = this.brickSnap ? [this.brickSnap] : [];
    this.warmDirty(renderer);
    this.lastBake.brickMs = performance.now() - tb;
    this.lastBake.inc = this.sets ? [this.sets.bake.n, this.sets.copy.n, this.sets.shade.n] : null;
    this.lastBake.batches = this.job?.n ?? 0;
    dlog('bricks-done', { ms: this.lastBake.brickMs, bricks: this.lastBake.bricks, samples: this.lastBake.samples, inc: this.lastBake.inc });
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
    const gl = renderer.getContext(), px = new Float32Array(4);
    const sync = () => { if (DEBUG_TIMES) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return performance.now() - t0; };
    if (this.low) this.drawLow(renderer, 0, this.inc ? regionRows(this.inc.low)[0] : this.low.height * this.low.depth);
    const tLow = sync();
    if (this.low) {
      this.bandTiles(renderer);
      this.drawUp(renderer, 0, this.inc ? regionRows(this.inc.fine)[0] : this.target!.height * this.target!.depth);
      this.drawBand(renderer, 0, this.bandStart[this.target!.depth]);
    } else this.drawRows(renderer, 0, this.target!.height * this.target!.depth);
    const tFine = sync();
    renderer.readRenderTargetPixels(this.target! as unknown as THREE.WebGLRenderTarget, 0, 0, 1, 1, px, 0);
    void gl;
    this.readyVersion = this.sdf.fieldVersion;
    this.done();
    this.job = null;
    this.lastBake.ms = performance.now() - t0;
    this.lastBake.voxels = this.target!.width * this.target!.height * this.target!.depth;
    const tb = performance.now();
    this.classDraw(renderer, 0, 1 << 20);
    this.classify(renderer);
    const ph: number[] = [performance.now() - tb];
    const mark = () => { if (DEBUG_TIMES) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); ph.push(performance.now() - tb); } };
    if (this.sets && this.levels[0].maskRows() === this.levels[0].slotTex!.image.height) this.levels[0].maskSlots(renderer, this.origin, this.h, this.sets.bake.slots);
    else for (const L of this.levels) if (L.count) L.masks(renderer, this.origin, this.h, 0, 1 << 20);
    mark();
    const sets = this.sets, L0 = this.levels[0];
    if (sets) L0.draw(renderer, this.origin, this.h, 0, sets.bake.n, sets.bake);
    else for (const L of this.levels) if (L.count) L.draw(renderer, this.origin, this.h, 0, L.rowsUsed(L.bakeTarget, L.bakeTarget === L.atlas ? L.S : L.N));
    mark();
    if (sets) L0.copy(renderer, 0, this.levels, this.ind!, this.cells, 0, sets.copy.n, sets.copy);
    else this.levels.forEach((L, i) => { if (L.count && L.copyTarget) L.copy(renderer, i, this.levels, this.ind!, this.cells, 0, L.rowsUsed(L.copyTarget, L.S)); });
    mark();
    if (sets) {
      L0.curvSet(renderer, this.readAtlas!, this.zOff[0], sets.copy, 0, sets.copy.n, null);
      L0.curvSet(renderer, this.readAtlas!, this.zOff[0], sets.shade, 0, sets.shade.n, this.shadeAtlas);
    } else this.levels.forEach((L, i) => { if (L.count) L.curv(renderer, this.readAtlas!, this.zOff[i], 0, L.rowsUsed(L.atlas!, L.S), this.shadeAtlas); });
    mark();
    (this.lastBake as unknown as { phases: number[] }).phases = [tLow, tFine, ...ph.map((x) => x + tb - t0)];
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.bricksDone(renderer, this.sdf.fieldVersion, tb);
    (window as unknown as { __brickStats: unknown }).__brickStats = { ...this.lastBake, cells: [...this.cells], atlas: this.levels.map((l) => l.atlas ? [l.atlas.width, l.atlas.height, l.atlas.depth] : null) };
    return performance.now() - t0;
  }

  private done() {
    this.snaps = this.snaps.slice(-1);
    this.geomOk = true;
    this.dirtyKey = -1;
  }

  private start(version: number, now: number) {
    const b = this.sdf.bounds;
    const ext = b.getSize(new THREE.Vector3());
    let h = Math.max(ext.x, ext.y, ext.z, 1e-3) / RES;
    let pad = 3 * h;
    let nx = Math.max(2, Math.ceil((ext.x + 2 * pad) / h) + 1), ny = Math.max(2, Math.ceil((ext.y + 2 * pad) / h) + 1), nz = Math.max(2, Math.ceil((ext.z + 2 * pad) / h) + 1);
    let ox = b.min.x - pad, oy = b.min.y - pad, oz = b.min.z - pad;
    // an edit of the same document (geomOk: forget() clears it when another is opened) with the same
    // program shape whose box stays inside the current grid at a close scale keeps the grid, so the
    // bake can be incremental; anything else gets the grid a fresh bake would
    const T = this.target, o = this.origin, H0 = this.h;
    if (INC && T && this.geomOk && this.snaps.length && this.sdf.dirtyBoxes(this.snaps) && h <= H0 && h >= 0.85 * H0
      && b.min.x - 3 * H0 >= o.x && b.min.y - 3 * H0 >= o.y && b.min.z - 3 * H0 >= o.z
      && b.max.x + 3 * H0 <= o.x + (T.width - 1) * H0 && b.max.y + 3 * H0 <= o.y + (T.height - 1) * H0 && b.max.z + 3 * H0 <= o.z + (T.depth - 1) * H0) {
      h = H0; pad = 3 * h; nx = T.width; ny = T.height; nz = T.depth; ox = o.x; oy = o.y; oz = o.z;
    }
    // a different grid: the old voxels mean nothing on it until this bake completes
    if (h !== this.h || ox !== this.origin.x || oy !== this.origin.y || oz !== this.origin.z || !this.target
      || this.target.width !== nx || this.target.height !== ny || this.target.depth !== nz) { this.geomOk = false; this.snaps = []; this.brickSnaps = []; this.slotInd = null; }
    // incremental: what changed since the fields the coarse texture and the bricks may hold
    this.inc = null;
    this.sets?.bake.dispose(); this.sets?.copy.dispose(); this.sets?.shade.dispose(); this.sets = null;
    if (INC && !this.noInc && this.geomOk && this.low && this.slotInd && this.snaps.length && this.snaps.length <= 3 && this.brickSnaps.length && this.brickSnaps.length <= 3) {
      const dc = this.sdf.dirtyBoxes(this.snaps), db = this.sdf.dirtyBoxes(this.brickSnaps);
      if (dc && db) {
        const vox = (bx: Box, grow: number, sp: number, t: { width: number; height: number; depth: number }): VBox | null => {
          const r = [0, 1, 2].map((k) => Math.max(0, Math.floor((bx.min[k] - grow - [ox, oy, oz][k]) / sp)));
          const dims = [t.width, t.height, t.depth];
          const e = [0, 1, 2].map((k) => Math.min(dims[k] - 1, Math.ceil((bx.max[k] + grow - [ox, oy, oz][k]) / sp)));
          return e.every((x, k) => x >= r[k]) ? [...r, ...e] : null;
        };
        // (the snapshot boxes carry the exact pass's 2.1 tap reach; map() itself changes only inside it)
        const shrink = (bx: Box): Box => ({ min: bx.min.map((x) => x + TAP_REACH) as Box['min'], max: bx.max.map((x) => x - TAP_REACH) as Box['max'] });
        const cb = [...dc.full, ...dc.cavity].map(shrink).filter((bx) => bx.min.every((x, k) => x <= bx.max[k]));
        const low = this.low;
        this.inc = {
          // (the fine field's band test reads the low voxels around: 2 voxels more)
          fine: cb.map((bx) => vox(bx, 2 * h, h, { width: nx, height: ny, depth: nz })).filter((x): x is VBox => !!x),
          low: cb.map((bx) => vox(bx, 2 * h, 2 * h, low)).filter((x): x is VBox => !!x),
          brick: [...db.full, ...db.cavity].map(shrink).filter((bx) => bx.min.every((x, k) => x <= bx.max[k])), coarse: cb,
        };
      }
    }
    if (!this.inc) { this.brickSnaps = []; this.slotInd = null; }
    this.snaps.push(this.sdf.snapshot());
    this.brickSnaps.push(this.snaps[this.snaps.length - 1]);
    this.brickSnap = null;
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
    // the half-resolution field: voxel j sits on fine voxel 2j
    const lx = Math.ceil((nx - 1) / 2) + 1, ly = Math.ceil((ny - 1) / 2) + 1, lz = Math.ceil((nz - 1) / 2) + 1;
    if (!this.coarseBand) { this.low?.dispose(); this.low = null; }
    else if (!this.low || this.low.width !== lx || this.low.height !== ly || this.low.depth !== lz) {
      this.low?.dispose();
      this.low = new THREE.WebGL3DRenderTarget(lx, ly, lz, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false });
      const tex = this.low.texture;
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
    const u = this.sdf.material.uniforms, b = this.bakeMat.uniforms;
    u.uBakeO.value.copy(this.origin);
    u.uBakeH.value = this.h;
    b.uBakeLow.value = this.low?.texture ?? null;
    if (this.low) b.uBakeLowInv.value.set(1 / this.low.width, 1 / this.low.height, 1 / this.low.depth);
    b.uBakeBand.value = this.low ? this.coarseBand * this.h : 0;
    drawRows(renderer, this.target!, this.bakeScene, this.bakeCam, (z) => { u.uBakeZ.value = z; }, r0, n);
  }

  /** From the half-resolution field (read back): the fine tiles (BAND_T × BAND_T voxels of a
   *  layer) where some voxel's upsampled value may lie within the band (a sign change or a
   *  low voxel within it among those it interpolates), as quads per layer. */
  private bandTiles(renderer: THREE.WebGLRenderer) {
    const L = this.low!, t = this.target!, gl = renderer.getContext() as WebGL2RenderingContext;
    const lx = L.width, ly = L.height, lz = L.depth;
    if (this.inc && !this.inc.fine.length) { this.bandStart = new Int32Array(t.depth + 1); this.bandCount = new Int32Array(t.depth); this.lastBake.bandTiles = 0; return; }
    const band = this.coarseBand * this.h, T = BAND_T, H = T >> 1;
    const bx = Math.ceil(t.width / T), by = Math.ceil(t.height / T);
    // the tiles to look at (an incremental bake: those over its regions) and the low voxels they read
    let ti0 = 0, tj0 = 0, ti1 = bx - 1, tj1 = by - 1, z0 = 0, z1 = lz - 1;
    if (this.inc) {
      const f = this.inc.fine;
      ti0 = Math.floor(Math.min(...f.map((r) => r[0])) / T); ti1 = Math.floor(Math.max(...f.map((r) => r[3])) / T);
      tj0 = Math.floor(Math.min(...f.map((r) => r[1])) / T); tj1 = Math.floor(Math.max(...f.map((r) => r[4])) / T);
      z0 = Math.floor(Math.min(...f.map((r) => r[2])) / 2); z1 = Math.min(lz - 1, Math.ceil(Math.max(...f.map((r) => r[5])) / 2));
    }
    const x0 = H * ti0, x1 = Math.min(lx - 1, H * ti1 + H), y0 = H * tj0, y1 = Math.min(ly - 1, H * tj1 + H), w = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (!this.lowVals || this.lowVals.length !== lx * ly * lz) this.lowVals = new Float32Array(lx * ly * lz);
    const v = this.lowVals, row = new Float32Array(w * hh * 4);
    const fb = gl.createFramebuffer(), tex = (renderer.properties.get(L.texture) as { __webglTexture: WebGLTexture }).__webglTexture;
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (let z = z0; z <= z1; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
      gl.readPixels(x0, y0, w, hh, gl.RGBA, gl.FLOAT, row);
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) v[(z * ly + y0 + y) * lx + x0 + x] = row[(y * w + x) * 4];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.deleteFramebuffer(fb);
    // per low layer: each tile's min |v| and signs over its low voxels [H·i, H·i + H] in x, y
    const mn = new Float32Array(bx * by * lz), sg = new Uint8Array(bx * by * lz);
    for (let z = z0; z <= z1; z++) for (let j = tj0; j <= tj1; j++) for (let i = ti0; i <= ti1; i++) {
      let m = 1e9, s = 0;
      for (let y = H * j; y <= Math.min(H * j + H, ly - 1); y++) for (let x = H * i; x <= Math.min(H * i + H, lx - 1); x++) {
        const a = v[(z * ly + y) * lx + x];
        m = Math.min(m, Math.abs(a)); s |= a < 0 ? 1 : 2;
      }
      const o = (z * by + j) * bx + i;
      mn[o] = m; sg[o] = s;
    }
    const quads: number[] = [];
    this.bandStart = new Int32Array(t.depth + 1);
    this.bandCount = new Int32Array(t.depth);
    for (let z = 0; z < t.depth; z++) {
      this.bandStart[z] = quads.length / 18;
      const za = Math.min(z >> 1, lz - 1), zb = Math.min((z + 1) >> 1, lz - 1);
      const boxes = this.inc ? this.inc.fine.filter((r) => z >= r[2] && z <= r[5]) : null;
      if (boxes && !boxes.length) { this.bandCount[z] = 0; continue; }
      for (let j = tj0; j <= tj1; j++) for (let i = ti0; i <= ti1; i++) {
        if (boxes && !boxes.some((r) => i * T <= r[3] && (i + 1) * T > r[0] && j * T <= r[4] && (j + 1) * T > r[1])) continue;
        const a = (za * by + j) * bx + i, b = (zb * by + j) * bx + i;
        if ((sg[a] | sg[b]) !== 3 && Math.min(mn[a], mn[b]) > band) continue;
        const x0 = i * T / t.width * 2 - 1, x1 = Math.min(1, (i + 1) * T / t.width * 2 - 1);
        const y0 = j * T / t.height * 2 - 1, y1 = Math.min(1, (j + 1) * T / t.height * 2 - 1);
        quads.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0);
      }
      this.bandCount[z] = quads.length / 18 - this.bandStart[z];
    }
    this.bandStart[t.depth] = quads.length / 18;
    this.bandGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads), 3));
    this.lastBake.bandTiles = quads.length / 18;
    this.lastBake.allTiles = bx * by * t.depth;
  }

  /** Rows [r0, r0 + n) of the fine field from the half-resolution one (no map()). */
  private drawUp(renderer: THREE.WebGLRenderer, r0: number, n: number) {
    const u = this.upMat.uniforms, L = this.low!;
    u.uLow.value = L.texture; u.uInv.value.set(1 / L.width, 1 / L.height, 1 / L.depth);
    if (this.inc) drawRegion(renderer, this.target!, this.upScene, this.bakeCam, (z) => { u.uZ.value = z; }, this.inc.fine, r0, n);
    else drawRows(renderer, this.target!, this.upScene, this.bakeCam, (z) => { u.uZ.value = z; }, r0, n);
  }

  /** map() over band tiles [q0, q1) (in layer order; voxels outside the band keep the upsampled value). */
  private drawBand(renderer: THREE.WebGLRenderer, q0: number, q1: number) {
    const u = this.sdf.material.uniforms, b = this.bakeMat.uniforms, t = this.target!;
    u.uBakeO.value.copy(this.origin);
    u.uBakeH.value = this.h;
    b.uBakeLow.value = this.low!.texture;
    b.uBakeLowInv.value.set(1 / this.low!.width, 1 / this.low!.height, 1 / this.low!.depth);
    b.uBakeBand.value = this.coarseBand * this.h;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    for (let z = 0; z < t.depth; z++) {
      const a = Math.max(q0, this.bandStart[z]), e = Math.min(q1, this.bandStart[z + 1]);
      if (e <= a) continue;
      u.uBakeZ.value = z;
      this.bandGeo.setDrawRange(a * 6, (e - a) * 6);
      renderer.setRenderTarget(t, z);
      renderer.render(this.bandScene, this.bakeCam);
    }
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }

  /** Rows [r0, r0 + n) of the half-resolution field (every voxel exactly). */
  private drawLow(renderer: THREE.WebGLRenderer, r0: number, n: number) {
    const u = this.sdf.material.uniforms, b = this.bakeMat.uniforms;
    u.uBakeO.value.copy(this.origin);
    u.uBakeH.value = 2 * this.h;
    b.uBakeBand.value = 0;
    // (never sample the target being drawn: with the low field bound the draw is a feedback loop, and fails)
    b.uBakeLow.value = null;
    if (this.inc) drawRegion(renderer, this.low!, this.bakeScene, this.bakeCam, (z) => { u.uBakeZ.value = z; }, this.inc.low, r0, n);
    else drawRows(renderer, this.low!, this.bakeScene, this.bakeCam, (z) => { u.uBakeZ.value = z; }, r0, n);
    u.uBakeH.value = this.h;
  }

  /** Find the band cells and the sharp ones (a GPU pass, read back), lay out the atlases and the indirection. */
  /** The classify pass's target, set up (r0 = 0), and its rows [r0, r0 + n) drawn. Returns its height. */
  private classDraw(renderer: THREE.WebGLRenderer, r0: number, n: number) {
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
    cu.uThr.value = BRICK_THR * this.h; cu.uSharp.value = BRICK_SHARP * this.h; cu.uNear.value = BRICK_NEAR * this.h;
    cu.uK0.value = 0; cu.uK1.value = 1 << 20;
    // (no sharp level: the sharp half isn't drawn)
    const rt = this.classRT, H = BRICK_SHARP >= 99 ? rows : rt.height;
    const reg = this.classRegion();
    if (reg) {
      // an incremental bake: the region's cells only (one draw per block of 128 z cells it meets)
      if (r0 > 0) return H;
      const [i0, j0, k0, i1, j1, k1] = reg;
      cu.uK0.value = k0; cu.uK1.value = k1;
      const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      for (let blk = k0 >> 7; blk <= k1 >> 7; blk++) for (const half of H > rows ? [0, rows] : [0]) {
        rt.scissor.set(i0, half + blk * cy + j0, i1 - i0 + 1, j1 - j0 + 1);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.render(this.classScene, this.bakeCam);
      }
      rt.scissorTest = false;
      renderer.setRenderTarget(prev);
      renderer.autoClear = auto;
      return H;
    }
    n = Math.min(n, H - r0);
    if (n > 0) {
      const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
      renderer.autoClear = false;
      rt.scissor.set(0, r0, rt.width, n);
      rt.scissorTest = r0 > 0 || n < H;
      renderer.setRenderTarget(rt);
      renderer.render(this.classScene, this.bakeCam);
      rt.scissorTest = false;
      renderer.setRenderTarget(prev);
      renderer.autoClear = auto;
    }
    return H;
  }

  /** An incremental bake's classify region: the cells [i0, j0, k0, i1, j1, k1] whose corner voxels it changed (null: all). */
  private classRegion(): number[] | null {
    if (!this.inc || !this.classBits) return null;
    const f = this.inc.fine, t = this.target!, B = BRICK_B;
    if (!f.length) return [0, 0, 0, -1, -1, -1];
    const cx = Math.ceil((t.width - 1) / B), cy = Math.ceil((t.height - 1) / B), cz = Math.ceil((t.depth - 1) / B);
    const lo = (k: number) => Math.max(0, Math.floor(Math.min(...f.map((r) => r[k])) / B) - 1);
    const hi = (k: number, n: number) => Math.min(n - 1, Math.floor(Math.max(...f.map((r) => r[k + 3])) / B));
    return [lo(0), lo(1), lo(2), hi(0, cx), hi(1, cy), hi(2, cz)];
  }

  /** Read the classify pass back (its rows all drawn) and lay out the bricks. */
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
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.setRenderTarget(this.classRT);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const sharpOn = BRICK_SHARP < 99, reg = this.classRegion();
    if (!reg || !this.classBits || this.classBits.length !== cx * 2 * rows * 4) {
      this.classBits = new Uint32Array(cx * 2 * rows * 4);
      gl.readPixels(0, 0, cx, sharpOn ? 2 * rows : rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.classBits);
    } else {
      // the region's rows read back and merged: its z cells' bits only
      const [i0, j0, k0, i1, j1, k1] = reg, w = i1 - i0 + 1, hh = j1 - j0 + 1, buf = new Uint32Array(w * hh * 4);
      for (let blk = k0 >> 7; blk <= k1 >> 7; blk++) for (const half of sharpOn ? [0, rows] : [0]) {
        gl.readPixels(i0, half + blk * cy + j0, w, hh, gl.RGBA_INTEGER, gl.UNSIGNED_INT, buf);
        const m = [0, 1, 2, 3].map((wd) => {
          let mk = 0;
          for (let b = 0; b < 32; b++) { const K = blk * 128 + wd * 32 + b; if (K >= k0 && K <= k1) mk |= 1 << b; }
          return mk >>> 0;
        });
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) for (let wd = 0; wd < 4; wd++) {
          const o = ((half + blk * cy + j0 + y) * cx + i0 + x) * 4 + wd;
          this.classBits[o] = ((this.classBits[o] & ~m[wd]) | (buf[(y * w + x) * 4 + wd] & m[wd])) >>> 0;
        }
      }
    }
    const bits = this.classBits;
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
    // incremental: bricks outside the changed boxes keep their slots (and their samples); the
    // rest (changed or new cells) take free slots and are baked
    const L0 = this.levels[0];
    let incOk = !!this.inc && !lists[1].length && !!this.slotInd && this.slotInd.length === ind.length && !!this.slotCell;
    let bySlot: number[] | null = null;
    if (incOk) {
      const old = this.slotInd!, oldCell = this.slotCell!, n = ind.length, h2 = BRICK_B * this.h, o = this.origin;
      const hits = (bs: Box[], grow: number, i: number, j: number, k: number) => bs.some((b) =>
        o.x + i * h2 <= b.max[0] + grow && o.x + (i + 1) * h2 >= b.min[0] - grow && o.y + j * h2 <= b.max[1] + grow && o.y + (j + 1) * h2 >= b.min[1] - grow
        && o.z + k * h2 <= b.max[2] + grow && o.z + (k + 1) * h2 >= b.min[2] - grow);
      const nInd = new Float32Array(n), used = new Uint8Array(Math.max(oldCell.length, 1));
      const cl = lists[0], toBake: number[] = [];
      for (let q = 0; q < cl.length; q += 3) {
        const i = cl[q], j = cl[q + 1], k = cl[q + 2], c = (k * cy + j) * cx + i;
        if (old[c] > 0 && !hits(this.inc!.brick, 1.5 * this.h, i, j, k) && !hits(this.inc!.coarse, 1.5 * this.h, i, j, k)) { nInd[c] = old[c]; used[old[c] - 1] = 1; }
      }
      let free = 0, top = 0;
      for (let s2 = 0; s2 < used.length; s2++) if (used[s2]) top = s2 + 1;
      for (let q = 0; q < cl.length; q += 3) {
        const c = (cl[q + 2] * cy + cl[q + 1]) * cx + cl[q];
        if (nInd[c]) continue;
        while (free < used.length && used[free]) free++;
        const s2 = free++;
        nInd[c] = s2 + 1; toBake.push(s2); top = Math.max(top, s2 + 1);
      }
      if (top > L0.cap) incOk = false;
      else {
        // changed cells (rebaked, or gone): their own and their -x/-y/-z neighbours' aprons are copied again
        const changed = new Uint8Array(n), copy = new Set<number>(), shade = new Set<number>();
        for (let c = 0; c < n; c++) if ((nInd[c] && (old[c] !== nInd[c] || !used[nInd[c] - 1])) || (old[c] && !nInd[c])) changed[c] = 1;
        for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
          const c = (k * cy + j) * cx + i;
          if (!nInd[c]) continue;
          let ch = false;
          for (let d = 0; d < 8 && !ch; d++) {
            const a = i + (d & 1), b = j + ((d >> 1) & 1), e = k + (d >> 2);
            if (a < cx && b < cy && e < cz && changed[(e * cy + b) * cx + a]) ch = true;
          }
          if (ch) copy.add(nInd[c] - 1);
          // (occlusion taps reach 1.95 from a sample into the coarse field)
          if (ch || hits(this.inc!.brick, TAP_REACH + 0.05, i, j, k) || hits(this.inc!.coarse, TAP_REACH + 0.05, i, j, k)) shade.add(nInd[c] - 1);
        }
        bySlot = new Array(top * 3).fill(-1);
        const sc = new Int32Array(top).fill(-1);
        for (let c = 0; c < n; c++) if (nInd[c]) { const s2 = nInd[c] - 1; sc[s2] = c; bySlot[s2 * 3] = c % cx; bySlot[s2 * 3 + 1] = Math.floor(c / cx) % cy; bySlot[s2 * 3 + 2] = Math.floor(c / (cx * cy)); }
        ind.set(nInd);
        this.slotCell = sc;
        const sx = L0.slots[0] || Math.floor(ATLAS_W / L0.S);
        this.sets = { bake: new SlotSet(toBake, sx), copy: new SlotSet([...copy], sx), shade: new SlotSet([...shade], sx) };
      }
    }
    if (!incOk) { this.inc = null; this.sets = null; }
    this.ind?.dispose();
    this.ind = new THREE.Data3DTexture(ind, cx, cy, cz);
    this.ind.format = THREE.RedFormat; this.ind.type = THREE.FloatType;
    this.ind.minFilter = this.ind.magFilter = THREE.NearestFilter;
    this.ind.unpackAlignment = 1;
    this.ind.needsUpdate = true;
    if (bySlot) L0.layout(bySlot, 1, true);
    else {
      this.levels.forEach((L, i) => L.layout(lists[i], i === 0 ? SLOT_SLACK : 1));
      // the layout an incremental bake starts from (one level only)
      if (!lists[1].length) {
        this.slotInd = ind.slice();
        this.slotCell = new Int32Array(L0.count);
        for (let c = 0; c < ind.length; c++) if (ind[c] > 0) this.slotCell[ind[c] - 1] = c;
      } else { this.slotInd = null; this.slotCell = null; }
    }
    const su = this.settledMat.uniforms;
    // the read atlas: level 0's layers, then level 1's; each cell's brick start and N
    const L1 = this.levels[1];
    const d0 = L0.count ? L0.atlas!.depth : 0, d1 = L1.count ? L1.atlas!.depth : 0, D = Math.max(1, d0 + d1);
    this.zOff = [0, d0];
    if (!this.readAtlas || this.readAtlas.depth !== D) {
      this.readAtlas?.dispose();
      this.readAtlas = new THREE.WebGL3DRenderTarget(ATLAS_W, ATLAS_W, D, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
      const tex = this.readAtlas.texture;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    }
    if ((!this.shadeAtlas || this.shadeAtlas.depth !== D)) {
      this.shadeAtlas?.dispose();
      this.shadeAtlas = new THREE.WebGL3DRenderTarget(ATLAS_W, ATLAS_W, D, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
      const tex = this.shadeAtlas.texture;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    }
    for (const L of this.levels) {
      const g = L.shadeMat.uniforms;
      g.uTex.value = t.texture; g.uO.value.copy(this.origin); g.uH.value = this.h;
      g.uInvN.value.set(1 / t.width, 1 / t.height, 1 / t.depth); g.uNm1.value.set(t.width - 1, t.height - 1, t.depth - 1);
    }
    const es = new Float32Array(cx * cy * cz * 4);
    for (let c = 0; c < cx * cy * cz; c++) {
      const v = ind[c];
      if (!v) continue;
      const lv = v > 0 ? 0 : 1, L = this.levels[lv], s = Math.abs(v) - 1, [sx, sy] = L.slots;
      es[c * 4] = (s % sx) * L.S; es[c * 4 + 1] = (Math.floor(s / sx) % sy) * L.S;
      es[c * 4 + 2] = Math.floor(s / (sx * sy)) * L.S + this.zOff[lv]; es[c * 4 + 3] = L.N;
    }
    this.indS?.dispose();
    this.indS = new THREE.Data3DTexture(es, cx, cy, cz);
    this.indS.format = THREE.RGBAFormat; this.indS.type = THREE.FloatType;
    this.indS.minFilter = this.indS.magFilter = THREE.NearestFilter;
    this.indS.needsUpdate = true;
    su.uTex.value = t.texture; su.uIndS.value = this.indS; su.uH.value = this.h;
    su.uAtlasR.value = this.readAtlas.texture;
    su.uAtlasG.value = this.shadeAtlas?.texture ?? null;
    su.uInvA.value.set(1 / ATLAS_W, 1 / ATLAS_W, 1 / D);
    su.uInvN.value.set(1 / t.width, 1 / t.height, 1 / t.depth);
    su.uNm1.value.set(t.width - 1, t.height - 1, t.depth - 1);
    this.lastBake.bricks = this.levels.map((l) => l.count);
    this.lastBake.samples = this.levels.reduce((a, l) => a + l.count * (l.core ? l.N : l.S) ** 3, 0);
    this.lastBake.classifyMs = performance.now() - t0;
  }

}

/** Rows (and the widest row) of these voxel regions, as drawRegion counts them. */
function regionRows(boxes: VBox[]): [number, number] {
  let n = 0, w = 1;
  for (const r of boxes) { n += (r[5] - r[2] + 1) * (r[4] - r[1] + 1); w = Math.max(w, r[3] - r[0] + 1); }
  return [n, w];
}

/** drawRows over voxel regions: row k runs through each region's layers, rows y0..y1 of each, scissored to x0..x1. */
function drawRegion(renderer: THREE.WebGLRenderer, t: THREE.WebGL3DRenderTarget, scene: THREE.Scene, cam: THREE.Camera, setZ: (z: number) => void, boxes: VBox[], r0: number, n: number) {
  const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
  renderer.autoClear = false;
  let base = 0;
  for (const r of boxes) {
    const H = r[4] - r[1] + 1, rows = (r[5] - r[2] + 1) * H;
    for (let k = Math.max(r0, base); k < Math.min(r0 + n, base + rows);) {
      const z = r[2] + Math.floor((k - base) / H), y = (k - base) % H, m = Math.min(H - y, r0 + n - k);
      setZ(z);
      t.scissor.set(r[0], r[1] + y, r[3] - r[0] + 1, m);
      t.scissorTest = true;
      renderer.setRenderTarget(t, z);
      renderer.render(scene, cam);
      k += m;
    }
    base += rows;
  }
  t.scissorTest = false;
  renderer.setRenderTarget(prev);
  renderer.autoClear = auto;
}
