import './styles.css';
import * as THREE from 'three';
import {
  type ObjectMode, type PrimitiveType, type Quality, type SceneDoc, type SceneObject,
  TYPE_LABEL, cloneDoc, emptyDoc, makeObject, newId, normalizeDoc,
} from '../engine/document';
import type { BuildResult } from '../engine/kernel';
import type { Vec3 } from '../engine/math';
import { classifyPoint, compileScene, sdfWorld, toLocal } from '../engine/primitives';
import { examples } from '../examples';
import { Builder } from './builder';
import { ProfileEditor } from './profileEditor';
import { type GizmoMode, Viewport } from './viewport';

type Tab = 'add' | 'edit' | 'shell' | 'holes' | 'view';

const ICON: Record<string, string> = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><path d="M12 3l-3 3M12 3l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
  shell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 6h14l-1.5 13h-11z"/><path d="M8 9h8l-1 8H9z" opacity=".5"/></svg>',
  holes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/></svg>',
  view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/></svg>',
  frame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  sphere: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><circle cx="16" cy="16" r="11"/><ellipse cx="16" cy="16" rx="11" ry="4" opacity=".5"/></svg>',
  box: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 11l10-5 10 5v11l-10 5-10-5z"/><path d="M6 11l10 5 10-5M16 16v11" opacity=".6"/></svg>',
  cylinder: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="16" cy="8" rx="9" ry="3"/><path d="M7 8v16c0 1.7 4 3 9 3s9-1.3 9-3V8"/></svg>',
  cone: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4L7 24M16 4l9 20"/><ellipse cx="16" cy="24" rx="9" ry="3"/></svg>',
  torus: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="16" cy="16" rx="12" ry="7"/><ellipse cx="16" cy="15" rx="5" ry="2.2"/></svg>',
  capsule: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><rect x="10" y="3" width="12" height="26" rx="6"/></svg>',
  prism: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 7h14l4 4-4 4H9l-4-4z"/><path d="M5 11v12l4 4h14l4-4V11" opacity=".7"/></svg>',
  revolve: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4h8M13 4c-1 4 3 7 3 10s-7 4-7 9 3 5 3 5h8s3 0 3-5-7-6-7-9 4-6 3-10"/></svg>',
};

interface UIState {
  tab: Tab;
  sheetOpen: boolean;
  selectedId: string | null;
  gizmo: GizmoMode;
  holeMode: 'face' | 'pin';
  pinRadius: number;
  quality: Quality;
  section: { on: boolean; axis: 'x' | 'y' | 'z'; t: number };
  wire: boolean;
  lockScale: boolean;
  profileEditing: string | null;
  profilePoint: number;
  showExamples: boolean;
}

const STORAGE_KEY = 'clay.doc.v1';

function loadSaved(): SceneDoc | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? normalizeDoc(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

function save(doc: SceneDoc) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch { /* storage unavailable */ }
}

const exampleList = examples();
let doc: SceneDoc = loadSaved() ?? cloneDoc(exampleList.find((e) => e.id === 'vase-sticks')!.doc);
let committed = JSON.stringify(doc);
const past: string[] = [];
const future: string[] = [];
const ui: UIState = {
  tab: 'edit', sheetOpen: true, selectedId: doc.objects[0]?.id ?? null, gizmo: 'translate', holeMode: 'face', pinRadius: 0.3,
  quality: 'normal', section: { on: false, axis: 'z', t: 0.5 }, wire: false, lockScale: false,
  profileEditing: null, profilePoint: -1, showExamples: false,
};
let lastResult: BuildResult | null = null;
let busy = false;
let frameOnNext = true;
let profileEditor: ProfileEditor | null = null;

// ---------- DOM skeleton
const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="viewport">
    <div class="topbar">
      <div class="brand">Clay <small>shell studio</small></div>
      <button class="icon-btn" id="btn-examples" aria-label="Examples">Examples</button>
      <button class="icon-btn" id="btn-frame" aria-label="Frame model">${ICON.frame}</button>
      <button class="icon-btn" id="btn-undo" aria-label="Undo">${ICON.undo}</button>
      <button class="icon-btn" id="btn-redo" aria-label="Redo">${ICON.redo}</button>
    </div>
    <div class="status" id="status"></div>
  </div>
  <div class="sheet">
    <div class="sheet-body" id="panel"></div>
    <nav class="tabbar" role="tablist">
      ${(['add', 'edit', 'shell', 'holes', 'view'] as Tab[]).map((t) => `<button class="tab" role="tab" data-tab="${t}">${ICON[t]}<span>${t[0].toUpperCase() + t.slice(1)}</span></button>`).join('')}
    </nav>
  </div>`;
const viewportEl = document.getElementById('viewport')!;
const panel = document.getElementById('panel')!;
const statusEl = document.getElementById('status')!;
const view = new Viewport(viewportEl);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  const attr = document.documentElement.getAttribute('data-theme');
  view.setTheme(attr ? attr === 'dark' : darkQuery.matches);
};
applyTheme();
darkQuery.addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

const builder = new Builder();
builder.onBusy = (b) => { busy = b; renderStatus(); };
builder.onResult = (r) => {
  lastResult = r;
  view.setResult(r, ui.wire);
  if (ui.section.on) view.setSection(true, ui.section.axis, ui.section.t);
  if (frameOnNext) { view.frame(); frameOnNext = false; }
  renderStatus();
  if (ui.tab === 'view') renderPanel();
};
builder.onError = (msg) => { toast(`Build failed: ${msg.split('\n')[0]}`); };

// ---------- document updates
function selected(): SceneObject | null {
  return doc.objects.find((o) => o.id === ui.selectedId) ?? null;
}

/** Apply a change. interactive = still dragging (draft build, no history entry). */
function update(mut: (d: SceneDoc) => void, interactive = false) {
  const next = cloneDoc(doc);
  mut(next);
  doc = next;
  if (!interactive) commit();
  const sel = selected();
  if (sel) view.syncGhost(sel);
  builder.schedule(doc, ui.quality, interactive);
}

function commit() {
  const s = JSON.stringify(doc);
  if (s === committed) return;
  past.push(committed);
  if (past.length > 200) past.shift();
  future.length = 0;
  committed = s;
  save(doc);
  renderTopbar();
}

function restore(s: string) {
  doc = normalizeDoc(JSON.parse(s));
  committed = s;
  save(doc);
  if (!selected()) ui.selectedId = doc.objects[0]?.id ?? null;
  refreshGhost();
  builder.schedule(doc, ui.quality, false);
  renderAll();
}

function refreshGhost() {
  view.setGhost(ui.tab === 'edit' || ui.tab === 'add' ? selected() : selected() && ui.tab === 'holes' ? selected() : null,
    ui.tab === 'edit' ? ui.gizmo : 'off');
}

// ---------- rendering
function renderTopbar() {
  (document.getElementById('btn-undo') as HTMLButtonElement).disabled = !past.length;
  (document.getElementById('btn-redo') as HTMLButtonElement).disabled = !future.length;
}

function renderStatus() {
  const chips: string[] = [];
  const s = lastResult?.stats;
  const kernelName = doc.kernel === 'sdf' ? 'SDF' : doc.meshMethod === 'minkowski' ? 'Mesh · Minkowski' : 'Mesh';
  chips.push(`<span class="chip ${busy ? 'busy' : 'ok'}">${kernelName}${busy ? ' · building' : s ? ` · ${fmtMs(s.totalMs)}` : ''}</span>`);
  if (doc.shell.enabled) chips.push(`<span class="chip">wall ${doc.shell.thickness.toFixed(2)} cm</span>`);
  if (s && !busy) {
    if (s.boundaryEdges) chips.push(`<span class="chip warn">${s.boundaryEdges} open edges</span>`);
    for (const w of s.warnings.slice(0, 2)) chips.push(`<span class="chip warn">${escapeHtml(w)}</span>`);
  }
  statusEl.innerHTML = chips.join('');
}

function fmtMs(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function seg<T extends string>(name: string, value: T, options: [T, string][]) {
  return `<div class="seg" role="group">${options.map(([v, l]) => `<button data-seg="${name}" data-value="${v}" aria-pressed="${v === value}">${l}</button>`).join('')}</div>`;
}

function slider(key: string, label: string, value: number, min: number, max: number, step: number) {
  return `<label class="field"><span>${label}</span>
    <input type="range" id="r-${key}" data-num="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    <input type="number" id="n-${key}" data-num="${key}" min="${min}" step="${step}" value="${value}"></label>`;
}

function xyz(key: string, label: string, v: Vec3, step: number, lock = false) {
  return `<div class="xyz"><span>${label}</span>${['x', 'y', 'z'].map((a, i) =>
    `<label><i>${a.toUpperCase()}</i><input type="number" id="t-${key}-${i}" data-num="tf.${key}.${i}" step="${step}" value="${+v[i].toFixed(3)}"></label>`).join('')}
    ${lock ? `<button class="lock" data-act="lock" aria-pressed="${ui.lockScale}" aria-label="Lock uniform scale" title="Uniform scale">⛓</button>` : '<span></span>'}</div>`;
}

const PARAMS: Record<PrimitiveType, [string, string, number, number, number][]> = {
  sphere: [['r', 'Radius', 0.2, 15, 0.05]],
  box: [['x', 'Width', 0.2, 30, 0.05], ['y', 'Height', 0.2, 30, 0.05], ['z', 'Depth', 0.2, 30, 0.05]],
  cylinder: [['r', 'Radius', 0.1, 15, 0.05], ['h', 'Height', 0.1, 30, 0.05]],
  cone: [['r', 'Radius', 0.1, 15, 0.05], ['h', 'Height', 0.1, 30, 0.05]],
  torus: [['R', 'Ring', 0.5, 15, 0.05], ['r', 'Tube', 0.1, 8, 0.05]],
  capsule: [['r', 'Radius', 0.1, 10, 0.05], ['h', 'Length', 0, 30, 0.05]],
  prism: [['n', 'Sides', 3, 12, 1], ['r', 'Radius', 0.2, 15, 0.05], ['h', 'Height', 0.1, 30, 0.05]],
  revolve: [],
};

function faceLabel(o: SceneObject, fid: string): string {
  const c = compileScene([o])[0];
  return c?.faces.find((f) => f.id === fid)?.label ?? fid;
}

function renderPanel() {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
  panel.hidden = !ui.sheetOpen;
  panel.classList.toggle('tall', !!ui.profileEditing || ui.showExamples);
  profileEditor = null;
  if (ui.showExamples) { panel.innerHTML = examplesPanel(); return; }
  if (ui.profileEditing) { renderProfilePanel(); return; }
  panel.innerHTML = ({ add: addPanel, edit: editPanel, shell: shellPanel, holes: holesPanel, view: viewPanel } as Record<Tab, () => string>)[ui.tab]();
}

function objectChips() {
  if (!doc.objects.length) return '<p class="hint">No objects yet. Add one from the Add tab.</p>';
  return `<div class="chips">${doc.objects.map((o) => `<button class="obj-chip" data-select="${o.id}" aria-pressed="${o.id === ui.selectedId}"><span class="dot ${o.mode}"></span>${escapeHtml(o.name)}</button>`).join('')}</div>`;
}

function addPanel() {
  const types: PrimitiveType[] = ['sphere', 'box', 'cylinder', 'cone', 'torus', 'capsule', 'prism', 'revolve'];
  return `<div class="section"><h3>Add a form</h3>
    <div class="grid-add">${types.map((t) => `<button class="add-btn" data-add="${t}">${ICON[t]}${TYPE_LABEL[t]}</button>`).join('')}</div>
    <p class="hint">New forms join the piece at the centre. Revolve opens the profile editor: draw half the silhouette and it spins 360° around the axis.</p></div>`;
}

function editPanel() {
  const o = selected();
  let body = '';
  if (o) {
    const t = o.transform;
    body = `
    <div class="section"><h3>${TYPE_LABEL[o.type]} · how it combines</h3>
      ${seg<ObjectMode>('mode', o.mode, [['join', 'Join'], ['solid', 'Solid'], ['cut', 'Cut']])}
      <p class="hint">${o.mode === 'join' ? 'Part of the form. It gets hollowed with everything it touches.' : o.mode === 'solid' ? 'Added after hollowing, so it stays solid (sticks, handles).' : 'Carved out of the form before hollowing.'}</p>
    </div>
    <div class="section"><h3>Shape</h3>
      ${PARAMS[o.type].map(([k, l, mn, mx, st]) => slider(`p.${k}`, l, (o.params as Record<string, number>)[k], mn, mx, st)).join('')}
      ${o.type === 'revolve' ? `<button class="btn primary" data-act="edit-profile">Edit profile (${o.params.points?.length ?? 0} points)</button>` : ''}
    </div>
    <div class="section"><h3>Transform</h3>
      ${seg<GizmoMode>('gizmo', ui.gizmo, [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale'], ['off', 'Hide']])}
      ${xyz('position', 'Position', t.position, 0.1)}
      ${xyz('rotation', 'Rotation°', t.rotation, 1)}
      ${xyz('scale', 'Scale', t.scale, 0.05, true)}
      <p class="hint">Scale runs along the object's own axes. Lock ⛓ to scale uniformly.</p>
    </div>
    <div class="row"><button class="btn" data-act="duplicate">Duplicate</button><button class="btn danger" data-act="delete">Delete</button></div>`;
  } else body = '<p class="hint">Tap the model, or pick an object below, to edit it.</p>';
  return `<div class="section"><h3>Objects</h3>${objectChips()}</div>${body}`;
}

function shellPanel() {
  const holes = doc.objects.flatMap((o) => o.holes.map((h) => ({ o, h })));
  return `<div class="section"><h3>Hollow the piece</h3>
      <label class="toggle"><input type="checkbox" id="shell-on" data-act="shell-toggle" ${doc.shell.enabled ? 'checked' : ''}> Shell everything that is joined</label>
      ${slider('shell', 'Wall cm', doc.shell.thickness, 0.1, 3, 0.05)}
      <p class="hint">Walls grow inward from the outside surface, so the outside stays exactly as modelled. Where the piece is thinner than two walls it stays solid.</p>
    </div>
    <div class="section"><h3>Openings</h3>
      <p class="hint">${holes.length + doc.pins.length ? `${holes.length} face opening${holes.length === 1 ? '' : 's'}, ${doc.pins.length} pin hole${doc.pins.length === 1 ? '' : 's'}.` : 'No openings yet: the shell is fully closed.'} Add them in the Holes tab.</p>
    </div>`;
}

function holesPanel() {
  const o = selected();
  const faces = o ? compileScene([o])[0]?.faces ?? [] : [];
  const holeRows = doc.objects.flatMap((ob) => ob.holes.map((h) => `<div class="list-item"><span>${escapeHtml(ob.name)} · ${escapeHtml(faceLabel(ob, h))}</span><button data-unhole="${ob.id}|${h}" aria-label="Remove opening">×</button></div>`));
  const pinRows = doc.pins.map((p, i) => {
    const ob = doc.objects.find((x) => x.id === p.objectId);
    return `<div class="list-item"><span>Pin ${i + 1} on ${escapeHtml(ob?.name ?? '?')} · ⌀ ${(p.radius * 2).toFixed(2)} cm</span><button data-unpin="${p.id}" aria-label="Remove pin hole">×</button></div>`;
  });
  return `<div class="section"><h3>Tap the model to</h3>
      ${seg('holeMode', ui.holeMode, [['face', 'Open a face'], ['pin', 'Drill a pin hole']])}
      ${ui.holeMode === 'pin' ? slider('pin', 'Radius cm', ui.pinRadius, 0.05, 2, 0.05) : ''}
      <p class="hint">${ui.holeMode === 'face' ? 'Tapping a face removes it from the shell. Only the part of the face that is on the outside opens.' : 'Tapping places a round hole through the wall, on flat or curved surfaces.'}</p>
    </div>
    ${o ? `<div class="section"><h3>Faces of ${escapeHtml(o.name)}</h3><div class="row">${faces.map((f) => `<button class="face-chip" data-face="${f.id}" aria-pressed="${o.holes.includes(f.id)}">${escapeHtml(f.label)}</button>`).join('')}</div></div>` : ''}
    <div class="section"><h3>Openings</h3>${holeRows.length + pinRows.length ? `<div class="list">${[...holeRows, ...pinRows].join('')}</div>` : '<p class="hint">None yet.</p>'}</div>
    <div class="section"><h3>Objects</h3>${objectChips()}</div>`;
}

function viewPanel() {
  const s = lastResult?.stats;
  return `<div class="section"><h3>Shelling kernel</h3>
      ${seg('kernel', doc.kernel, [['sdf', 'SDF'], ['mesh', 'Mesh']])}
      ${doc.kernel === 'mesh' ? seg('meshMethod', doc.meshMethod, [['offset', 'Fast offset'], ['minkowski', 'Exact (slow)']]) : ''}
      <p class="hint">${doc.kernel === 'sdf' ? 'Distance fields: any union, openings on any surface, exact wall thickness. Detail depends on quality.' : doc.meshMethod === 'offset' ? 'Exact surfaces and very fast. Each form is hollowed separately, so walls come out thicker where forms meet, and narrow joins can stay closed.' : 'Exact erosion of the whole union. Correct at joins, but can take minutes.'}</p>
      ${seg<Quality>('quality', ui.quality, [['draft', 'Draft'], ['normal', 'Normal'], ['fine', 'Fine']])}
    </div>
    <div class="section"><h3>Look inside</h3>
      <label class="toggle"><input type="checkbox" id="sec-on" data-act="section-toggle" ${ui.section.on ? 'checked' : ''}> Section cut</label>
      ${ui.section.on ? `${seg('axis', ui.section.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']])}${slider('section', 'Position', ui.section.t, 0, 1, 0.005)}` : ''}
      <label class="toggle"><input type="checkbox" id="wire-on" data-act="wire-toggle" ${ui.wire ? 'checked' : ''}> Show triangles</label>
    </div>
    <div class="section"><h3>Last build</h3><div class="stats">${s ? escapeHtml([
      `kernel     ${s.kernel}`,
      `time       ${fmtMs(s.totalMs)}`,
      `triangles  ${s.triangles.toLocaleString()}`,
      s.cellSize ? `cell       ${s.cellSize.toFixed(3)} cm` : '',
      `open edges ${s.boundaryEdges}   non-manifold ${s.nonManifoldEdges}`,
      ...Object.entries(s.timings).map(([k, v]) => `  ${k.padEnd(10)} ${v} ms`),
      ...s.warnings.map((w) => `! ${w}`),
    ].filter(Boolean).join('\n')) : 'building…'}</div></div>
    <div class="row"><button class="btn danger" data-act="new">New empty scene</button></div>`;
}

function examplesPanel() {
  return `<div class="section"><div class="row"><h3 style="margin-right:auto">Benchmark scenes</h3><button class="btn" data-act="close-examples">Close</button></div>
    <div class="examples">${exampleList.map((e) => `<button class="example" data-example="${e.id}"><b>${escapeHtml(e.title)}</b><small>${escapeHtml(e.notes)}</small></button>`).join('')}</div></div>`;
}

function renderProfilePanel() {
  const o = doc.objects.find((x) => x.id === ui.profileEditing);
  if (!o || o.type !== 'revolve') { ui.profileEditing = null; renderPanel(); return; }
  panel.innerHTML = `<div class="profile-wrap">
    <div class="row"><h3 style="margin:0 auto 0 0;font:600 11px var(--font-body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Profile of ${escapeHtml(o.name)}</h3>
      <button class="btn primary" data-act="profile-done">Done</button></div>
    <canvas class="profile-canvas" id="profile-canvas"></canvas>
    <div class="row">
      <button class="btn" data-act="profile-corner" ${ui.profilePoint < 0 ? 'disabled' : ''}>Sharp / smooth</button>
      <button class="btn danger" data-act="profile-delete" ${ui.profilePoint < 0 ? 'disabled' : ''}>Delete point</button>
    </div>
    <p class="hint">Drag points to reshape. Tap empty space to add a point. Tap a point to select it. Squares are sharp corners. The curve spins a full 360° around the dashed axis.</p></div>`;
  profileEditor = new ProfileEditor(document.getElementById('profile-canvas') as HTMLCanvasElement, o.params.points ?? []);
  profileEditor.onChange = (pts, done) => {
    update((d) => { d.objects.find((x) => x.id === o.id)!.params.points = pts; }, !done);
    view.setGhost(selected(), 'off');
  };
  profileEditor.onSelect = (i) => {
    ui.profilePoint = i;
    panel.querySelectorAll<HTMLButtonElement>('[data-act="profile-corner"],[data-act="profile-delete"]').forEach((b) => { b.disabled = i < 0; });
  };
}

function renderAll() {
  renderTopbar();
  renderStatus();
  renderPanel();
}

// ---------- interactions
function selectObject(id: string | null) {
  ui.selectedId = id;
  refreshGhost();
  renderPanel();
}

function setNum(key: string, v: number, interactive: boolean) {
  if (Number.isNaN(v)) return;
  if (key === 'shell') return update((d) => { d.shell.thickness = Math.max(0.05, v); }, interactive);
  if (key === 'pin') { ui.pinRadius = Math.max(0.02, v); return; }
  if (key === 'section') { ui.section.t = v; view.setSection(true, ui.section.axis, v); return; }
  const o = selected();
  if (!o) return;
  if (key.startsWith('p.')) {
    const k = key.slice(2);
    return update((d) => { (d.objects.find((x) => x.id === o.id)!.params as Record<string, number>)[k] = k === 'n' ? Math.round(v) : v; }, interactive);
  }
  if (key.startsWith('tf.')) {
    const [, field, idx] = key.split('.');
    return update((d) => {
      const t = d.objects.find((x) => x.id === o.id)!.transform;
      const arr = t[field as 'position' | 'rotation' | 'scale'];
      const i = Number(idx);
      if (field === 'scale') {
        v = Math.max(0.01, v);
        if (ui.lockScale && arr[i] > 0) {
          const k = v / arr[i];
          for (let a = 0; a < 3; a++) arr[a] = +(arr[a] * k).toFixed(4);
          return;
        }
      }
      arr[i] = v;
    }, interactive);
  }
}

panel.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const key = el.dataset.num;
  if (!key) return;
  // keep slider and number box in step
  panel.querySelectorAll<HTMLInputElement>(`[data-num="${key}"]`).forEach((x) => { if (x !== el) x.value = el.value; });
  if (el.type === 'range') setNum(key, Number(el.value), true);
});
panel.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  const key = el.dataset.num;
  if (key) {
    setNum(key, Number(el.value), false);
    if (key.startsWith('tf.scale') && ui.lockScale) renderPanel();
    return;
  }
  const act = el.dataset.act;
  if (act === 'shell-toggle') update((d) => { d.shell.enabled = el.checked; });
  if (act === 'section-toggle') { ui.section.on = el.checked; view.setSection(el.checked, ui.section.axis, ui.section.t); renderPanel(); }
  if (act === 'wire-toggle') { ui.wire = el.checked; if (lastResult) view.setResult(lastResult, ui.wire); }
});

panel.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!btn) return;
  const d = btn.dataset;
  if (d.add) return addObject(d.add as PrimitiveType);
  if (d.select) return selectObject(d.select);
  if (d.example) return loadExample(d.example);
  if (d.seg) return onSeg(d.seg, d.value!);
  if (d.face) {
    const o = selected();
    if (o) toggleHole(o.id, d.face);
    return;
  }
  if (d.unhole) {
    const [oid, fid] = d.unhole.split('|');
    return toggleHole(oid, fid);
  }
  if (d.unpin) { update((doc2) => { doc2.pins = doc2.pins.filter((p) => p.id !== d.unpin); }); renderPanel(); return; }
  switch (d.act) {
    case 'lock': ui.lockScale = !ui.lockScale; btn.setAttribute('aria-pressed', String(ui.lockScale)); break;
    case 'duplicate': {
      const o = selected();
      if (!o) break;
      const c: SceneObject = JSON.parse(JSON.stringify(o));
      c.id = newId();
      c.name = `${o.name} copy`;
      c.transform.position = [o.transform.position[0] + 1.5, o.transform.position[1], o.transform.position[2]];
      update((doc2) => { doc2.objects.push(c); });
      selectObject(c.id);
      break;
    }
    case 'delete': {
      const o = selected();
      if (!o) break;
      update((doc2) => {
        doc2.objects = doc2.objects.filter((x) => x.id !== o.id);
        doc2.pins = doc2.pins.filter((p) => p.objectId !== o.id);
      });
      selectObject(doc.objects[0]?.id ?? null);
      break;
    }
    case 'edit-profile': ui.profileEditing = ui.selectedId; ui.profilePoint = -1; view.setGhost(selected(), 'off'); renderPanel(); break;
    case 'profile-done': ui.profileEditing = null; refreshGhost(); renderPanel(); break;
    case 'profile-corner': profileEditor?.toggleCorner(); break;
    case 'profile-delete': profileEditor?.deleteSelected(); break;
    case 'close-examples': ui.showExamples = false; renderPanel(); break;
    case 'new':
      update((doc2) => { Object.assign(doc2, emptyDoc(), { kernel: doc2.kernel }); });
      ui.selectedId = null; ui.tab = 'add'; refreshGhost(); renderPanel();
      break;
  }
});

function onSeg(name: string, value: string) {
  switch (name) {
    case 'mode': update((d) => { d.objects.find((x) => x.id === ui.selectedId)!.mode = value as ObjectMode; }); refreshGhost(); break;
    case 'gizmo': ui.gizmo = value as GizmoMode; refreshGhost(); break;
    case 'holeMode': ui.holeMode = value as 'face' | 'pin'; break;
    case 'kernel': update((d) => { d.kernel = value as SceneDoc['kernel']; }); break;
    case 'meshMethod': update((d) => { d.meshMethod = value as SceneDoc['meshMethod']; }); break;
    case 'quality': ui.quality = value as Quality; builder.schedule(doc, ui.quality, false); break;
    case 'axis': ui.section.axis = value as 'x' | 'y' | 'z'; view.setSection(true, ui.section.axis, ui.section.t); break;
  }
  renderPanel();
  renderStatus();
}

function toggleHole(oid: string, fid: string) {
  update((d) => {
    const o = d.objects.find((x) => x.id === oid)!;
    o.holes = o.holes.includes(fid) ? o.holes.filter((h) => h !== fid) : [...o.holes, fid];
  });
  renderPanel();
}

function addObject(type: PrimitiveType) {
  const o = makeObject(type);
  const n = doc.objects.filter((x) => x.type === type).length;
  if (n) o.name = `${TYPE_LABEL[type]} ${n + 1}`;
  update((d) => { d.objects.push(o); });
  ui.selectedId = o.id;
  ui.tab = 'edit';
  if (type === 'revolve') { ui.profileEditing = o.id; ui.profilePoint = -1; }
  refreshGhost();
  if (type === 'revolve') view.setGhost(o, 'off');
  renderPanel();
}

function loadExample(id: string) {
  const ex = exampleList.find((e) => e.id === id)!;
  update((d) => {
    const k = d.kernel, m = d.meshMethod;
    Object.assign(d, cloneDoc(ex.doc), { kernel: k, meshMethod: m });
  });
  ui.showExamples = false;
  ui.selectedId = doc.objects[0]?.id ?? null;
  frameOnNext = true;
  refreshGhost();
  renderPanel();
  toast(ex.title);
}

document.querySelector('.tabbar')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
  if (!b) return;
  const t = b.dataset.tab as Tab;
  ui.showExamples = false;
  ui.profileEditing = null;
  if (t === ui.tab) ui.sheetOpen = !ui.sheetOpen;
  else { ui.tab = t; ui.sheetOpen = true; }
  refreshGhost();
  renderPanel();
});
document.getElementById('btn-undo')!.addEventListener('click', () => {
  if (!past.length) return;
  future.push(committed);
  restore(past.pop()!);
});
document.getElementById('btn-redo')!.addEventListener('click', () => {
  if (!future.length) return;
  past.push(committed);
  restore(future.pop()!);
});
document.getElementById('btn-frame')!.addEventListener('click', () => view.frame());
document.getElementById('btn-examples')!.addEventListener('click', () => {
  ui.showExamples = !ui.showExamples;
  ui.sheetOpen = true;
  renderPanel();
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    document.getElementById(e.shiftKey ? 'btn-redo' : 'btn-undo')!.click();
  }
});

// gizmo -> document
view.onGizmoChange = (t, done) => {
  const o = selected();
  if (!o) return;
  update((d) => { Object.assign(d.objects.find((x) => x.id === o.id)!.transform, t); }, !done);
  if (done && ui.tab === 'edit') renderPanel();
};

// taps on the model: select, open a face, or drill a pin hole
view.onTap = (hit) => {
  if (!hit) {
    if (ui.tab === 'edit' && !ui.profileEditing) selectObject(null);
    return;
  }
  const objs = compileScene(doc.objects);
  const p = hit.point;
  const c = classifyPoint(objs, p.x, p.y, p.z, ['join', 'solid', 'cut']);
  if (!c) return;
  const oid = c.obj.obj.id;
  if (ui.tab === 'holes' && ui.holeMode === 'face') {
    if (c.obj.obj.mode !== 'join') { toast('Openings go on joined forms'); return; }
    ui.selectedId = oid;
    toggleHole(oid, c.face);
    toast(`${c.obj.obj.holes.includes(c.face) ? 'Closed' : 'Opened'} ${c.obj.obj.name} · ${faceLabel(c.obj.obj, c.face)}`);
    refreshGhost();
    return;
  }
  if (ui.tab === 'holes' && ui.holeMode === 'pin') {
    // surface normal from the object's own field, point projected onto its surface
    const e = 1e-3;
    const g = new THREE.Vector3(
      sdfWorld(c.obj, p.x + e, p.y, p.z) - sdfWorld(c.obj, p.x - e, p.y, p.z),
      sdfWorld(c.obj, p.x, p.y + e, p.z) - sdfWorld(c.obj, p.x, p.y - e, p.z),
      sdfWorld(c.obj, p.x, p.y, p.z + e) - sdfWorld(c.obj, p.x, p.y, p.z - e),
    ).normalize();
    const d = sdfWorld(c.obj, p.x, p.y, p.z);
    const q = p.clone().addScaledVector(g, -d);
    const lp: Vec3 = [0, 0, 0];
    toLocal(c.obj, q.x, q.y, q.z, lp);
    // param-space normal = S * R^T * n_world
    const r = c.obj.rot, s = c.obj.scale;
    const nl = new THREE.Vector3(
      (r[0] * g.x + r[3] * g.y + r[6] * g.z) * s[0],
      (r[1] * g.x + r[4] * g.y + r[7] * g.z) * s[1],
      (r[2] * g.x + r[5] * g.y + r[8] * g.z) * s[2],
    ).normalize();
    update((doc2) => { doc2.pins.push({ id: newId('p'), objectId: oid, point: lp, normal: [nl.x, nl.y, nl.z], radius: ui.pinRadius }); });
    renderPanel();
    toast(`Pin hole ⌀ ${(ui.pinRadius * 2).toFixed(2)} cm`);
    return;
  }
  if (ui.tab !== 'edit') ui.tab = 'edit';
  ui.sheetOpen = true;
  selectObject(oid);
};

let toastTimer = 0;
function toast(msg: string) {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    viewportEl.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.hidden = true; }, 2200);
}

// ---------- start
renderAll();
refreshGhost();
builder.schedule(doc, ui.quality, false);
