// Benchmark contact sheet: exterior views, sections and a 360° interior camera
// (black mesh on white — any unexpected white is a leak).

import * as THREE from 'three';
import { examples } from '../examples';
import '../browserSetup';
import { buildMesh } from '../engine/build';
import type { KernelName, Quality } from '../engine/document';
import { buildCavityGrid, type CavityGrid, cavityDepth } from '../engine/cavity';
import { buildSDF } from '../engine/sdfKernel';
import { approxDepth, compileGroups, traceScene } from '../engine/scene';
import type { Vec3 } from '../engine/math';
import { SdfRenderer } from '../app/raymarch';
import type { BuildResult } from '../engine/kernel';

const params = new URLSearchParams(location.search);
const caseId = params.get('case') ?? 'open-box';
const kernelParam = params.get('kernel') ?? 'sdf';
const kernel = (kernelParam === 'sdf' ? 'sdf' : 'mesh') as KernelName;
const quality = (params.get('quality') ?? 'normal') as Quality;
const T = Number(params.get('tile') ?? 260);

declare global { interface Window { __bench?: unknown; __benchError?: string; __cases?: string[] } }

async function main() {
  for (const k of ['__dcExpand', '__dcLambda']) if (params.get(k)) (globalThis as Record<string, unknown>)[k] = Number(params.get(k));
  if (caseId === '__list') { window.__cases = examples().map((e) => e.id); return; }
  const ex = examples().find((e) => e.id === caseId);
  if (!ex) throw new Error(`unknown case ${caseId}`);
  const doc = { ...ex.doc, kernel, meshMethod: kernelParam === 'mesh-mk' ? 'minkowski' as const : 'offset' as const };
  // overrides for reproducing app states: ?wall=cm&blend=cm&nogrid=1
  if (params.get('wall')) doc.groups = doc.groups.map((g) => ({ ...g, thickness: Number(params.get('wall')) }));
  if (params.get('blend')) doc.groups = doc.groups.map((g) => ({ ...g, blend: Number(params.get('blend')) }));
  // SDF: raymarched exactly as in the app (cavity grids + GPU field); the mesher
  // runs too, only for topology statistics. Mesh kernels: triangles.
  const sdf = kernel === 'sdf';
  let result: BuildResult;
  let sdfR: SdfRenderer | null = null;
  let gridArr: (CavityGrid | null)[] = [];
  let cavityMs = 0;
  if (sdf) {
    const t0 = performance.now();
    const groups = compileGroups(doc);
    gridArr = [];
    for (const g of groups) gridArr[g.index] = g.hollow && !params.get('nogrid') ? buildCavityGrid(g, quality) : null;
    cavityMs = performance.now() - t0;
    sdfR = new SdfRenderer();
    sdfR.setDoc(doc);
    sdfR.setGrids(gridArr);
    sdfR.setStyle({ clay: 0xb8b2aa, cap: 0x8a1c1c });
    result = params.get('stats') === '0'
      ? { positions: new Float32Array(0), indices: new Uint32Array(0), stats: { kernel: 'sdf', triangles: 0, vertices: 0, boundaryEdges: 0, nonManifoldEdges: 0, warnings: [], timings: {}, totalMs: 0 } }
      : buildSDF(doc, quality, compileGroups(doc).map((g) => gridArr[g.index] ?? null));
    result.stats.timings = { cavity: Math.round(cavityMs), ...result.stats.timings };
  } else result = await buildMesh(doc, quality);
  const { positions, indices, stats } = result;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const bs = sdfR ? sdfR.bounds.getBoundingSphere(new THREE.Sphere()) : geo.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 5);

  // Close-up: one large section tile through a point (?closeup=x,y,z,radius)
  const cu = params.get('closeup');
  if (cu) {
    const [cx, cy, cz, cr, ax] = cu.split(',').map(Number); // ax: 0 = cut along Z (default), 1 = cut along Y, 2 = no cut
    const S = 900;
    const r2 = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r2.setPixelRatio(1);
    r2.setSize(S, S);
    document.getElementById('sheet')!.appendChild(r2.domElement);
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0xffffff);
    sc.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const dl2 = new THREE.DirectionalLight(0xffffff, 1.6);
    dl2.position.set(3, 5, 4);
    sc.add(dl2);
    const plane = ax === 1 ? new THREE.Plane(new THREE.Vector3(0, -1, 0), cy) : new THREE.Plane(new THREE.Vector3(0, 0, -1), cz);
    if (sdfR) { sc.add(sdfR.mesh); if (ax !== 2) sdfR.setClip(plane); }
    else {
      const mf = new THREE.MeshStandardMaterial({ color: 0xb8b2aa, roughness: 0.9, clippingPlanes: [plane] });
      const mb = new THREE.MeshBasicMaterial({ color: 0x8a1c1c, side: THREE.BackSide, clippingPlanes: [plane] });
      r2.localClippingEnabled = true;
      sc.add(new THREE.Mesh(geo, mf), new THREE.Mesh(geo, mb));
    }
    const cam = new THREE.PerspectiveCamera(35, 1, 0.05, 1000);
    const c = new THREE.Vector3(cx, cy, cz);
    const vp = params.get('view')?.split(',').map(Number);
    const viewDir = vp ? new THREE.Vector3(vp[0], vp[1], vp[2]) : ax === 1 ? new THREE.Vector3(0.15, 1, 0.25) : new THREE.Vector3(0.35, 0.25, 1);
    if (ax === 1) cam.up.set(0, 0, -1);
    cam.position.copy(c).add(viewDir.normalize().multiplyScalar(cr / Math.tan((17.5 * Math.PI) / 180)));
    cam.lookAt(c);
    r2.render(sc, cam);
    window.__bench = { id: ex.id, kernel, quality, stats, whiteFrac: [], width: S, height: S };
    return;
  }

  const probes = ex.probes;
  const cols = 6;
  const rows = 3 + probes.length;
  const W = cols * T, H = rows * T;
  const sheet = document.getElementById('sheet')!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.localClippingEnabled = true;
  renderer.setScissorTest(true);
  sheet.appendChild(renderer.domElement);
  const label = (x: number, y: number, text: string) => {
    const d = document.createElement('div');
    d.className = 'label';
    d.style.left = `${x}px`; d.style.top = `${y}px`;
    d.textContent = text;
    sheet.appendChild(d);
  };

  // --- shaded exterior scene
  const shaded = new THREE.Scene();
  shaded.background = new THREE.Color(0xffffff);
  shaded.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6);
  dl.position.set(3, 5, 4);
  shaded.add(dl);
  const clipPlanes: THREE.Plane[] = [];
  const front = new THREE.MeshStandardMaterial({ color: 0xb8b2aa, roughness: 0.9, side: THREE.FrontSide, clippingPlanes: clipPlanes, flatShading: false });
  const back = new THREE.MeshBasicMaterial({ color: 0x8a1c1c, side: THREE.BackSide, clippingPlanes: clipPlanes });
  const edges = new THREE.LineSegments(sdf ? new THREE.BufferGeometry() : new THREE.EdgesGeometry(geo, 35), new THREE.LineBasicMaterial({ color: 0x222222, clippingPlanes: clipPlanes }));
  if (!sdf) {
    shaded.add(new THREE.Mesh(geo, front));
    shaded.add(new THREE.Mesh(geo, back));
    shaded.add(edges);
  }
  const setClip = (pl: THREE.Plane | null) => {
    clipPlanes.length = 0;
    if (pl) clipPlanes.push(pl);
    front.needsUpdate = back.needsUpdate = edges.material.needsUpdate = true;
    sdfR?.setClip(pl);
  };
  const useSdf = (scene: THREE.Scene, flat: boolean) => {
    if (!sdfR) return;
    scene.add(sdfR.mesh);
    sdfR.setStyle({ flat });
  };
  if (params.get('wire')) {
    const wm = new THREE.MeshBasicMaterial({ color: 0x0044ff, wireframe: true, clippingPlanes: clipPlanes, transparent: true, opacity: 0.35 });
    shaded.add(new THREE.Mesh(geo, wm));
  }

  const view = (col: number, row: number, cam: THREE.Camera, scene: THREE.Scene) => {
    const x = col * T, y = H - (row + 1) * T;
    renderer.setViewport(x, y, T, T);
    renderer.setScissor(x, y, T, T);
    renderer.render(scene, cam);
  };
  const ortho = (dir: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) => {
    const r = bs.radius * 1.08;
    const cam = new THREE.OrthographicCamera(-r, r, r, -r, 0.01, r * 10);
    cam.position.copy(bs.center).addScaledVector(dir.clone().normalize(), r * 4);
    cam.up.copy(up);
    cam.lookAt(bs.center);
    return cam;
  };
  const ext: [string, THREE.Vector3, THREE.Vector3?][] = [
    ['iso front', new THREE.Vector3(1, 0.8, 1.3)],
    ['iso back', new THREE.Vector3(-1.2, 0.6, -1)],
    ['top', new THREE.Vector3(0, 1, 0.0001), new THREE.Vector3(0, 0, -1)],
    ['bottom', new THREE.Vector3(0, -1, 0.0001), new THREE.Vector3(0, 0, 1)],
    ['front', new THREE.Vector3(0, 0, 1)],
    ['side', new THREE.Vector3(1, 0, 0)],
  ];
  useSdf(shaded, false);
  ext.forEach(([name, dir, up], i) => {
    view(i, 0, ortho(dir, up), shaded);
    label(i * T + 2, 2, name);
  });

  // --- sections through the first probe
  const p0 = new THREE.Vector3(...(probes[0] ?? [0, 0, 0]));
  const sections: [string, THREE.Vector3, THREE.Vector3][] = [
    ['section Z', new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.25, 0.2, 1)],
    ['section X', new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0.2, 0.25)],
    ['section Y', new THREE.Vector3(0, -1, 0), new THREE.Vector3(0.2, 1, 0.3)],
  ];
  sections.forEach(([name, n, camDir], i) => {
    setClip(new THREE.Plane(n, -n.dot(p0)));
    view(i, 1, ortho(camDir, Math.abs(camDir.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : undefined), shaded);
    label(i * T + 2, T + 2, name);
  });
  setClip(null);

  // --- detail row: zoomed wall cross-sections and inner surface where rays from
  // the first probe hit the wall (+X side, top, bottom).
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const rc = new THREE.Raycaster();
  const zoomR = Number(params.get('zoom') ?? 0) || Math.min(bs.radius * 0.3, Math.max(4 * doc.groups[0].thickness, 1.2));
  const hits: [string, THREE.Vector3, THREE.Vector3][] = [];
  for (const [name, d] of [['+X', new THREE.Vector3(1, 0, 0)], ['+Y', new THREE.Vector3(0, 1, 0)], ['-Y', new THREE.Vector3(0, -1, 0)]] as [string, THREE.Vector3][]) {
    if (sdf) {
      const groups = compileGroups(doc);
      const depth = (g: { index: number }, x: number, y: number, z: number) => {
        const c = gridArr[g.index];
        return c ? cavityDepth(c, g as never, x, y, z) : approxDepth(g as never, x, y, z);
      };
      const h = traceScene(groups, depth, p0.toArray() as Vec3, d.toArray() as Vec3, 0.01, 500);
      if (h) hits.push([name, new THREE.Vector3(...h.p), d]);
    } else {
      rc.set(p0, d);
      const h = rc.intersectObject(mesh, false)[0];
      if (h) hits.push([name, h.point.clone(), d]);
    }
  }
  hits.forEach(([name, hp, d], i) => {
    setClip(new THREE.Plane(new THREE.Vector3(0, 0, -1), hp.z));
    const cam = new THREE.OrthographicCamera(-zoomR, zoomR, zoomR, -zoomR, 0.01, 1000);
    cam.position.copy(hp).add(new THREE.Vector3(0.15, 0.1, 1).multiplyScalar(50));
    cam.lookAt(hp);
    view(2 * i, 2, cam, shaded);
    label(2 * i * T + 2, 2 * T + 2, `detail section ${name}`);
    setClip(null);
    const pc = new THREE.PerspectiveCamera(60, 1, 0.005, 1000);
    pc.position.copy(hp).addScaledVector(d, -Math.min(hp.distanceTo(p0) * 0.9, zoomR * 2.5));
    pc.lookAt(hp);
    view(2 * i + 1, 2, pc, shaded);
    label((2 * i + 1) * T + 2, 2 * T + 2, `detail inner surface ${name}`);
  });
  setClip(null);

  // --- interior 360° views: unlit black on white
  const inner = new THREE.Scene();
  inner.background = new THREE.Color(0xffffff);
  if (sdf) useSdf(inner, true);
  else inner.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })));
  const dirs: [string, THREE.Vector3, THREE.Vector3][] = [
    ['+X', new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    ['-X', new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
    ['+Y', new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)],
    ['-Y', new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)],
    ['+Z', new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
    ['-Z', new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
  ];
  const whiteFrac: number[][] = [];
  const gl = renderer.getContext();
  const px = new Uint8Array(T * T * 4);
  probes.forEach((p, pi) => {
    const fr: number[] = [];
    dirs.forEach(([name, d, up], i) => {
      const cam = new THREE.PerspectiveCamera(90, 1, 0.005, bs.radius * 10);
      cam.position.set(p[0], p[1], p[2]);
      cam.up.copy(up);
      cam.lookAt(cam.position.clone().add(d));
      view(i, 3 + pi, cam, inner);
      const x = i * T, y = H - (4 + pi) * T;
      gl.readPixels(x, y, T, T, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let white = 0;
      for (let q = 0; q < px.length; q += 4) if (px[q] > 128) white++;
      fr.push(white / (T * T));
      label(i * T + 2, (3 + pi) * T + 2, `probe${pi} ${name} white=${((white / (T * T)) * 100).toFixed(1)}%`);
    });
    whiteFrac.push(fr);
  });

  const info = document.createElement('div');
  info.id = 'info';
  info.style.left = `${3 * T}px`;
  info.style.top = `${T}px`;
  info.style.width = `${3 * T - 16}px`;
  info.textContent = [
    `${ex.title}  [${stats.kernel} / ${quality}]`,
    ex.notes,
    `wall ${doc.groups[0].thickness} cm   tris ${stats.triangles}   cell ${stats.cellSize?.toFixed(3) ?? '-'}`,
    `boundary edges ${stats.boundaryEdges}   non-manifold ${stats.nonManifoldEdges}`,
    sdf ? `display: GPU raymarch · cavity grids ${cavityMs.toFixed(0)} ms ${gridArr.filter(Boolean).map((c) => `${c!.dims.join('x')} @${c!.h.toFixed(2)}cm`).join(', ')}` : '',
    sdf ? `mesher (stats only) ${stats.totalMs.toFixed(0)} ms` : `total ${stats.totalMs.toFixed(0)} ms`,
    Object.entries(stats.timings).map(([k, v]) => `${k} ${v}`).join('  '),
    ...stats.warnings.map((w) => `! ${w}`),
  ].join('\n');
  sheet.appendChild(info);
  window.__bench = { id: ex.id, kernel, quality, stats, whiteFrac, width: W, height: H };
}

main().catch((e) => {
  console.error(e);
  window.__benchError = String(e?.stack ?? e);
});
