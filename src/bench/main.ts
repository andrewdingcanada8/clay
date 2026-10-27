// Benchmark contact sheet: exterior views, sections and a 360° interior camera
// (black mesh on white — any unexpected white is a leak).

import * as THREE from 'three';
import { examples } from '../examples';
import '../browserSetup';
import { buildMesh } from '../engine/build';
import type { KernelName, Quality } from '../engine/document';

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
  const result = await buildMesh(doc, quality);
  const { positions, indices, stats } = result;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const bs = geo.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 5);

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
  shaded.add(new THREE.Mesh(geo, front));
  shaded.add(new THREE.Mesh(geo, back));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 35), new THREE.LineBasicMaterial({ color: 0x222222, clippingPlanes: clipPlanes }));
  shaded.add(edges);
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
    clipPlanes.length = 0;
    clipPlanes.push(new THREE.Plane(n, -n.dot(p0)));
    front.needsUpdate = back.needsUpdate = true;
    view(i, 1, ortho(camDir, Math.abs(camDir.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : undefined), shaded);
    label(i * T + 2, T + 2, name);
  });
  clipPlanes.length = 0;

  // --- detail row: zoomed wall cross-sections and inner surface where rays from
  // the first probe hit the wall (+X side, top, bottom).
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const rc = new THREE.Raycaster();
  const zoomR = Number(params.get('zoom') ?? 0) || Math.min(bs.radius * 0.3, Math.max(4 * doc.shell.thickness, 1.2));
  const hits: [string, THREE.Vector3, THREE.Vector3][] = [];
  for (const [name, d] of [['+X', new THREE.Vector3(1, 0, 0)], ['+Y', new THREE.Vector3(0, 1, 0)], ['-Y', new THREE.Vector3(0, -1, 0)]] as [string, THREE.Vector3][]) {
    rc.set(p0, d);
    const h = rc.intersectObject(mesh, false)[0];
    if (h) hits.push([name, h.point.clone(), d]);
  }
  hits.forEach(([name, hp, d], i) => {
    clipPlanes.length = 0;
    clipPlanes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), hp.z));
    front.needsUpdate = back.needsUpdate = edges.material.needsUpdate = true;
    const cam = new THREE.OrthographicCamera(-zoomR, zoomR, zoomR, -zoomR, 0.01, 1000);
    cam.position.copy(hp).add(new THREE.Vector3(0.15, 0.1, 1).multiplyScalar(50));
    cam.lookAt(hp);
    view(2 * i, 2, cam, shaded);
    label(2 * i * T + 2, 2 * T + 2, `detail section ${name}`);
    clipPlanes.length = 0;
    const pc = new THREE.PerspectiveCamera(60, 1, 0.005, 1000);
    pc.position.copy(hp).addScaledVector(d, -Math.min(hp.distanceTo(p0) * 0.9, zoomR * 2.5));
    pc.lookAt(hp);
    view(2 * i + 1, 2, pc, shaded);
    label((2 * i + 1) * T + 2, 2 * T + 2, `detail inner surface ${name}`);
  });
  clipPlanes.length = 0;

  // --- interior 360° views: unlit black on white
  const inner = new THREE.Scene();
  inner.background = new THREE.Color(0xffffff);
  inner.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })));
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
    `wall ${doc.shell.thickness} cm   tris ${stats.triangles}   cell ${stats.cellSize?.toFixed(3) ?? '-'}`,
    `boundary edges ${stats.boundaryEdges}   non-manifold ${stats.nonManifoldEdges}`,
    `total ${stats.totalMs.toFixed(0)} ms`,
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
