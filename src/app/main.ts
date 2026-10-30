import './styles.css';
import * as THREE from 'three';
import {
  type LayerOp, type ObjectMode, type PrimitiveType, type Quality, type SceneDoc, type SceneObject, type Symmetry, type Transform,
  TYPE_LABEL, cloneDoc, defaultCoil, emptyDoc, makeObject, newGroup, newId, normalizeDoc,
} from '../engine/document';
import type { BuildResult } from '../engine/kernel';
import type { CavityGrid } from '../engine/cavity';
import { DEFAULT_WALL, type Group, isCut } from '../engine/document';
import type { Vec3 } from '../engine/math';
import { classifyPoint, compileScene, sdfWorld, toLocal } from '../engine/primitives';
import { compileGroups } from '../engine/scene';
import { examples } from '../examples';
import { Builder } from './builder';
import { type CurveMode, ProfileEditor } from './profileEditor';
import type { ProfilePoint } from '../engine/profile';
import { buildSweepPath } from '../engine/sweep';
import { HAND_LENGTH_CM } from './hand';
import { type LibraryPart, PartStore, type Piece, type PieceFlag, PieceStore, type ViewState } from './pieces';
import { partScale, placedId } from '../engine/parts';
import {
  type Layer, ancestors, attach, childIds, copyLayer, deleteLayer, flattenLayers, groupLayers, layerOf, layerOp, localTransform,
  parentOf, repairTree, subtree, toLayers, ungroup, worldTransform,
} from '../engine/layers';
import { expandDoc } from '../engine/symmetry';
import { type GizmoMode, Viewport } from './viewport';

type Tab = 'add' | 'edit' | 'layers' | 'holes' | 'view';

const ICON: Record<string, string> = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><path d="M12 3l-3 3M12 3l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5" opacity=".6"/></svg>',
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
  sweep: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 26c0-9 4-16 12-18"/><path d="M12 27c1-8 5-13 11-14" opacity=".6"/><ellipse cx="22" cy="10.5" rx="2.6" ry="3.6" transform="rotate(25 22 10.5)"/></svg>',
  coil: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="16" cy="25" rx="9" ry="3"/><ellipse cx="16" cy="18" rx="9" ry="3"/><ellipse cx="16" cy="11" rx="9" ry="3"/><path d="M7 25V11M25 25V11" opacity=".35"/></svg>',
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
  hand: boolean;
  lockScale: boolean;
  profileEditing: string | null;
  /** which curve of that object: a revolve's profile, or a sweep's path, section or lift */
  curveField: CurveField;
  profilePoint: number;
  showGallery: boolean;
  galleryTab: 'mine' | 'examples';
  /** result of the last frame-rate measurement (View tab) */
  fps: string | null;
  /** gallery card states (piece id): open ⋯ menu, renaming, flagging, confirming delete */
  menuFor: string | null;
  renameFor: string | null;
  flagFor: string | null;
  deleteFor: string | null;
  /** waiting on "save or discard" before opening another piece or starting a new one */
  /** group id being saved as a part (name prompt open) */
  partNaming: string | null;
  /** library part cards: open ⋯ menu, renaming, confirming delete */
  libMenu: string | null;
  libRename: string | null;
  libDelete: string | null;
}

const STORAGE_KEY = 'clay.doc.v2'; // v2: hand-scale defaults

function loadSaved(): SceneDoc | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? loadable(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

/** A saved or example document as edited here: normalized, in the layer tree. */
function loadable(d: SceneDoc): SceneDoc {
  return toLayers(normalizeDoc(d));
}

function save(doc: SceneDoc) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch { /* storage unavailable */ }
}

const exampleList = examples();
/** Example previews, rendered by scripts/example-thumbs.mjs (same framing as piece thumbnails). */
const EXAMPLE_THUMBS: Record<string, string> = Object.fromEntries(Object.entries(
  import.meta.glob('../assets/example-thumbs/*.jpg', { eager: true, query: '?inline', import: 'default' }) as Record<string, string>,
).map(([path, url]) => [path.split('/').pop()!.replace(/\.jpg$/, ''), url]));
const restoredDoc = loadSaved();
let doc: SceneDoc = restoredDoc ?? loadable(cloneDoc(exampleList.find((e) => e.id === 'vase-sticks')!.doc));
let committed = JSON.stringify(doc);
const past: string[] = [];
const future: string[] = [];
const ui: UIState = {
  tab: 'edit', sheetOpen: true, selectedId: doc.objects[0]?.id ?? null, gizmo: 'translate', holeMode: 'face', pinRadius: 0.5,
  quality: 'normal', section: { on: false, axis: 'z', t: 0.5 }, wire: false, hand: true, lockScale: false,
  profileEditing: null, curveField: 'points', profilePoint: -1, showGallery: false, galleryTab: 'mine', fps: null,
  menuFor: null, renameFor: null, flagFor: null, deleteFor: null,
  partNaming: null, libMenu: null, libRename: null, libDelete: null,
};
let lastResult: BuildResult | null = null;
let busy = false;
/** Cavity grids per group index, with the key of the shell geometry they were built for. */
const gridCache: ({ key: string; grid: CavityGrid } | null)[] = [];
let cavityMs = 0;
let frameOnNext = true;
let profileEditor: ProfileEditor | null = null;

// ---------- saved pieces
const store = new PieceStore();
const partStore = new PartStore();
const CURRENT_KEY = 'clay.current.v1';
/** The open piece: its saved id (null = never saved) and the doc JSON as last saved or opened. */
interface Current { id: string | null; name: string; saved: string }
let current: Current = (() => {
  try {
    const c = JSON.parse(localStorage.getItem(CURRENT_KEY) ?? 'null');
    if (c && typeof c.name === 'string') return c as Current;
  } catch { /* storage unavailable */ }
  return { id: null, name: 'Untitled', saved: committed };
})();

// ---------- DOM skeleton
const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="viewport">
    <div class="topbar">
      <div class="brand">Clay <small id="piece-name">Untitled</small></div>
      <button class="icon-btn" id="btn-gallery" aria-label="Pieces">Pieces</button>
      <button class="icon-btn" id="btn-frame" aria-label="Frame model">${ICON.frame}</button>
      <button class="icon-btn" id="btn-undo" aria-label="Undo">${ICON.undo}</button>
      <button class="icon-btn" id="btn-redo" aria-label="Redo">${ICON.redo}</button>
    </div>
    <div class="status" id="status"></div>
  </div>
  <div class="sheet">
    <div class="sheet-body" id="panel"></div>
    <nav class="tabbar" role="tablist">
      ${(['add', 'edit', 'layers', 'holes', 'view'] as Tab[]).map((t) => `<button class="tab" role="tab" data-tab="${t}">${ICON[t]}<span>${t[0].toUpperCase() + t.slice(1)}</span></button>`).join('')}
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
builder.onGrids = (grids, tag, ms) => {
  const keys = tag as Record<number, string>;
  for (const g of grids) gridCache[g.groupIndex] = { key: keys[g.groupIndex], grid: g };
  cavityMs = ms;
  applyGrids();
  renderStatus();
  if (ui.tab === 'view') renderPanel();
};
builder.onMesh = (r) => {
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

function selectedGroup(): Group | null {
  return doc.groups.find((g) => g.id === ui.selectedId) ?? null;
}

/** The selected layer as the ghost draws it: placed in the world (a group: its contents, in its own frame). */
function ghostOf(): SceneObject | null {
  const o = selected();
  if (o) return { ...o, transform: worldTransform(doc, o.id) };
  const g = selectedGroup();
  if (!g) return null;
  // the group's contents as built, in the group's own frame
  const sub: SceneDoc = { ...cloneDoc(doc), root: [g.id] };
  const own = sub.groups.find((x) => x.id === g.id)!;
  Object.assign(own, { transform: undefined, sym: undefined, hidden: false, op: 'add' });
  const objects = flattenLayers(sub).objects;
  view.partDefs = [{ id: g.id, name: g.name, thickness: g.thickness, hollow: false, pins: [], objects }];
  const mode: ObjectMode = (g.op ?? 'add') === 'add' ? 'shell' : g.op as ObjectMode;
  return { ...makeObject('part', { id: g.id, name: g.name, params: { part: g.id }, mode }), transform: worldTransform(doc, g.id) };
}

/** Apply a change. interactive = still dragging (draft build, no history entry). */
function update(mut: (d: SceneDoc) => void, interactive = false) {
  const next = cloneDoc(doc);
  mut(next);
  repairTree(next);
  doc = next;
  if (!interactive) commit();
  const ghost = ghostOf();
  if (ghost) view.syncGhost(ghost);
  ghostOutline(interactive);
  sync(interactive);
}

/** The outline of the selected object shows at rest only for Subtract and Cutout (the render already shows
 *  the rest), and for any object while it is being dragged or profiled, since builds wait for release. */
function ghostOutline(live = false) {
  const o = selected(), g = selectedGroup();
  view.setGhostOutline(o ? isCut(o.mode) || live || ui.profileEditing === o.id : !!g && ((g.op ?? 'add') !== 'add' || live));
}

// ---------- display / builds
// Everything is built and drawn from the expanded document: each placed part
// becomes its own group (see engine/parts). Group indices below refer to it.
function cavityKey(r: SceneDoc, gi: number): string {
  const g = r.groups[gi];
  // the cavity follows the shell objects and the cuts carved before hollowing
  const shells = r.objects.filter((o) => o.groupId === g.id && o.mode !== 'solid' && !o.hidden);
  return JSON.stringify([ui.quality, g.blend ?? 0, shells.map((o) => [o.type, o.mode, o.params, o.transform, o.holes])]);
}

/** Whether group gi of the built document needs a cavity grid (scene.needsCavityGrid,
 *  from the document): more than one shell object, or rounded cut rims. */
function needsGrid(r: SceneDoc, gi: number): boolean {
  const g = r.groups[gi];
  const members = r.objects.filter((o) => o.groupId === g.id && !o.hidden && o.type !== 'part');
  const shells = members.filter((o) => o.mode === 'shell').length;
  return r.shell.enabled && shells > 0 && (shells > 1 || ((g.round ?? 0) > 0 && members.some((o) => isCut(o.mode))));
}

function currentGrids(r: SceneDoc): (CavityGrid | null)[] {
  return r.groups.map((g, i) => {
    const c = gridCache[i];
    return c && c.key === cavityKey(r, i) && g.thickness <= c.grid.tMax ? c.grid : null;
  });
}

function applyGrids() {
  if (doc.kernel === 'sdf') view.setSdfGrids(currentGrids(expandDoc(doc)));
}

/** Bring the display in line with the document. While a drag is in progress
 *  (interactive) only cheap display updates run; worker builds wait for release. */
function sync(interactive: boolean) {
  buildNotes = [];
  const r = expandDoc(doc, buildNotes);
  if (doc.kernel === 'mesh') {
    view.setMode('mesh');
    if (!interactive) builder.request('mesh', r, ui.quality);
    return;
  }
  // SDF: the GPU draws the document straight away; only stale cavity grids rebuild.
  view.setMode('sdf');
  view.setSdfDoc(r, interactive);
  const grids = currentGrids(r);
  view.setSdfGrids(grids);
  const missing: number[] = [];
  const keys: Record<number, string> = {};
  r.groups.forEach((g, i) => {
    const hollow = r.shell.enabled && r.objects.some((o) => o.groupId === g.id && o.mode === 'shell' && !o.hidden);
    if (hollow && !grids[i] && needsGrid(r, i)) { missing.push(i); keys[i] = cavityKey(r, i); }
  });
  if (missing.length && !interactive) builder.request('cavity', r, ui.quality, { groups: missing, tag: keys });
  if (frameOnNext) { view.frame(); frameOnNext = false; }
  renderStatus();
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
  scheduleAutosave();
}

function restore(s: string) {
  doc = loadable(JSON.parse(s));
  committed = s;
  save(doc);
  scheduleAutosave();
  if (!selected()) ui.selectedId = doc.objects[0]?.id ?? null;
  refreshGhost();
  sync(false);
  renderAll();
}

function refreshGhost() {
  ghostOutline();
  const show = ui.tab === 'edit' || ui.tab === 'add' || ui.tab === 'layers' || (ui.tab === 'holes' && !!selected());
  view.setGhost(show ? ghostOf() : null, ui.tab === 'edit' || ui.tab === 'layers' ? ui.gizmo : 'off');
}

// ---------- rendering
function renderTopbar() {
  document.getElementById('piece-name')!.textContent = current.name + (isDirty() ? ' •' : '');
  (document.getElementById('btn-undo') as HTMLButtonElement).disabled = !past.length;
  (document.getElementById('btn-redo') as HTMLButtonElement).disabled = !future.length;
}

/** Where the last build approximated the layer tree (see engine/layers). */
let buildNotes: string[] = [];

function renderStatus() {
  const chips: string[] = [];
  const s = doc.kernel === 'mesh' ? lastResult?.stats : undefined;
  const r = expandDoc(doc);
  if (doc.kernel === 'sdf') {
    const hollow = r.shell.enabled && r.objects.some((o) => o.mode === 'shell');
    // exact once every group that needs a grid has one (the others are exact anyway)
    const grids = currentGrids(r);
    const exact = !hollow || r.groups.every((_, i) => !needsGrid(r, i) || !!grids[i]);
    chips.push(`<span class="chip ${busy ? 'busy' : 'ok'}">SDF · live${hollow ? (exact && !busy ? ' · exact walls' : ' · refining walls') : ''}</span>`);
  } else {
    const kernelName = doc.meshMethod === 'minkowski' ? 'Mesh · Minkowski' : 'Mesh';
    chips.push(`<span class="chip ${busy ? 'busy' : 'ok'}">${kernelName}${busy ? ' · building' : s ? ` · ${fmtMs(s.totalMs)}` : ''}</span>`);
  }
  const bb = view.bounds();
  if (bb) {
    const sz = bb.getSize(new THREE.Vector3());
    chips.push(`<span class="chip">${Math.round(Math.max(sz.x, sz.z))} × ${Math.round(sz.y)} cm</span>`);
  }
  const hollowUnits = r.groups.filter((g) => r.shell.enabled && r.objects.some((o) => o.groupId === g.id && o.mode === 'shell'));
  if (hollowUnits.length === 1) chips.push(`<span class="chip">wall ${hollowUnits[0].thickness.toFixed(2)} cm</span>`);
  for (const n of buildNotes.slice(0, 1)) chips.push(`<span class="chip warn">${escapeHtml(n)}</span>`);
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

/** One slider per axis; ranges widen to fit the current value. */
function xyz(key: 'position' | 'rotation' | 'scale', label: string, v: Vec3, step: number, lock = false) {
  const range = (x: number): [number, number] =>
    key === 'rotation' ? [-180, 180]
      : key === 'scale' ? [0.05, Math.max(4, Math.ceil(x * 1.5))]
        : ((r) => [-r, r])(Math.max(50, Math.ceil(Math.abs(x) * 1.5)));
  return `<div class="xyz-head"><span>${label}</span>${lock ? `<button class="lock" data-act="lock" aria-pressed="${ui.lockScale}" aria-label="Lock uniform scale" title="Uniform scale">⛓ uniform</button>` : ''}</div>
    ${['X', 'Y', 'Z'].map((a, i) => slider(`tf.${key}.${i}`, a, +v[i].toFixed(3), ...range(v[i]), step)).join('')}`;
}

const PARAMS: Record<PrimitiveType, [string, string, number, number, number][]> = {
  sphere: [['r', 'Radius', 0.5, 40, 0.1]],
  box: [['x', 'Width', 0.5, 80, 0.1], ['y', 'Height', 0.5, 80, 0.1], ['z', 'Depth', 0.5, 80, 0.1]],
  cylinder: [['r', 'Radius', 0.2, 40, 0.1], ['h', 'Height', 0.2, 80, 0.1]],
  cone: [['r', 'Radius', 0.2, 40, 0.1], ['h', 'Height', 0.2, 80, 0.1]],
  torus: [['R', 'Ring', 1, 40, 0.1], ['r', 'Tube', 0.2, 20, 0.1]],
  capsule: [['r', 'Radius', 0.2, 25, 0.1], ['h', 'Length', 0, 80, 0.1]],
  prism: [['n', 'Sides', 3, 12, 1], ['r', 'Bottom radius', 0, 40, 0.1], ['r2', 'Top radius', 0, 40, 0.1], ['h', 'Height', 0.2, 80, 0.1]],
  revolve: [],
  sweep: [],
  part: [],
};

function faceLabel(o: SceneObject, fid: string): string {
  const c = compileScene([o])[0];
  return c?.faces.find((f) => f.id === fid)?.label ?? fid;
}

function renderPanel() {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
  panel.hidden = !ui.sheetOpen;
  panel.classList.toggle('tall', !!ui.profileEditing || ui.showGallery);
  profileEditor = null;
  if (ui.showGallery) { panel.innerHTML = galleryPanel(); return; }
  if (ui.profileEditing) { renderProfilePanel(); return; }
  panel.innerHTML = ({ add: addPanel, edit: editPanel, layers: layersPanel, holes: holesPanel, view: viewPanel } as Record<Tab, () => string>)[ui.tab]();
}

function objectChips() {
  if (!doc.objects.length) return '<p class="hint">No objects yet. Add one from the Add tab.</p>';
  return `<div class="chips">${doc.objects.map((o) => `<button class="obj-chip" data-select="${o.id}" aria-pressed="${o.id === ui.selectedId}"><span class="dot ${isCut(o.mode) ? 'cut' : o.mode}"></span>${escapeHtml(o.name)}</button>`).join('')}</div>`;
}

function addPanel() {
  const types: PrimitiveType[] = ['sphere', 'box', 'cylinder', 'cone', 'torus', 'capsule', 'prism', 'revolve', 'sweep'];
  return `<div class="section"><h3>Add a form</h3>
    <div class="grid-add">${types.map((t) => `<button class="add-btn" data-add="${t}">${ICON[t]}${TYPE_LABEL[t]}</button>`).join('')}<button class="add-btn" data-add="coil">${ICON.coil}Coil</button></div>
    <p class="hint">New forms join the piece at the centre. Revolve opens the profile editor: draw half the silhouette and it spins 360° around the axis. Sweep opens its path: draw a line on a plane and a section travels along it. Coil is a sweep round a circle, lifted over three turns.</p></div>
    ${partsLibrary()}`;
}

function partsLibrary() {
  const list = partStore.list();
  const card = (p: LibraryPart) => {
    let extra = '';
    if (ui.libRename === p.id) {
      extra = `<div class="piece-form"><label class="field-col"><span>Name</span><input id="lib-rename-input" value="${escapeHtml(p.name)}" maxlength="80"></label>
        <div class="row"><button class="btn primary" data-lib-rename-save="${p.id}">Rename</button><button class="btn" data-lib-cancel="1">Cancel</button></div></div>`;
    } else if (ui.libDelete === p.id) {
      extra = `<div class="piece-form"><p>Remove "${escapeHtml(p.name)}" from your parts? Pieces that already use it keep their copy.</p>
        <div class="row"><button class="btn danger" data-lib-del-confirm="${p.id}">Remove</button><button class="btn" data-lib-cancel="1">Cancel</button></div></div>`;
    } else if (ui.libMenu === p.id) {
      extra = `<div class="piece-menu" role="menu"><button role="menuitem" data-lib-rename="${p.id}">Rename</button><button role="menuitem" class="danger" data-lib-del="${p.id}">Remove</button></div>`;
    }
    return `<div class="piece">
      <button class="piece-open" data-add-part="${p.id}" aria-label="Add ${escapeHtml(p.name)}">${p.thumb ? `<img src="${p.thumb}" alt="">` : '<span class="piece-empty">No preview</span>'}</button>
      <div class="piece-meta"><div class="piece-title"><b>${escapeHtml(p.name)}</b><button class="piece-more" data-lib-menu="${p.id}" aria-label="More actions for ${escapeHtml(p.name)}" aria-expanded="${ui.libMenu === p.id}">⋯</button></div>
      <small>${partSummary(p)}</small></div>${extra}</div>`;
  };
  return `<div class="section"><h3>Your parts</h3>
    ${list.length ? `<div class="pieces">${list.map(card).join('')}</div>` : '<p class="hint">No parts yet. In the Layers tab, select a group and use "Save as part" to reuse it in any piece.</p>'}
    ${list.length ? '<p class="hint">Tap a part to add a copy of its group. Everything in it stays editable; changing the copy never changes the saved part.</p>' : ''}</div>`;
}

function sweepControls(o: SceneObject) {
  const p = o.params, sec = p.section ?? 'circle';
  const len = buildSweepPath(p).length;
  return `
    <div class="sub">Section</div>
    ${seg<NonNullable<SceneObject['params']['section']>>('section', sec, [['circle', 'Round'], ['square', 'Square'], ['custom', 'Drawn']])}
    ${slider('p.w', sec === 'circle' ? 'Diameter' : 'Width', p.w ?? 2, 0.2, 30, 0.1)}
    ${sec !== 'circle' ? slider('p.d', 'Height', p.d ?? 2, 0.2, 30, 0.1) : ''}
    ${sec === 'custom' ? '<div class="row"><button class="btn" data-act="edit-shape">Draw section</button></div>' : ''}
    <div class="sub">Path</div>
    ${seg<NonNullable<SceneObject['params']['plane']>>('plane', p.plane ?? 'xy', [['xy', 'XY · upright'], ['xz', 'XZ · flat'], ['yz', 'YZ · upright']])}
    <label class="toggle"><input type="checkbox" id="sweep-closed" data-act="sweep-closed" ${p.closed ? 'checked' : ''}> Closed loop</label>
    ${p.closed ? slider('p.turns', 'Turns', p.turns ?? 1, 1, 12, 1) : ''}
    <div class="sub">Sharp corners</div>
    ${seg<NonNullable<SceneObject['params']['join']>>('join', p.join ?? 'round', [['round', 'Round'], ['miter', 'Miter']])}
    ${!p.closed ? `<div class="sub">Ends</div>
    ${seg<NonNullable<SceneObject['params']['cap']>>('cap', p.cap ?? 'flat', [['flat', 'Flat'], ['round', 'Round'], ['square', 'Square']])}` : ''}
    <p class="hint">Round turns the section about the corner (round ends spin it a half turn); miter runs both sides on to a sharp point (turns sharper than 120° are rounded); square ends run on by half the width.</p>
    <div class="row"><button class="btn primary" data-act="edit-path">Edit path (${p.path?.length ?? 0} points)</button><button class="btn" data-act="edit-lift">Edit lift</button></div>
    <p class="hint">${len.toFixed(1)} cm along the path. The lift raises the path off its plane as it goes; on a closed loop with several turns, a rising lift makes a coil.</p>`;
}

/** Objects with edges to round (spheres, tori and capsules are round already). */
const ROUNDABLE = new Set<SceneObject['type']>(['box', 'cylinder', 'cone', 'prism', 'revolve', 'sweep']);

function symmetrySection(id: string, sym: Symmetry | undefined) {
  const own = new Set(subtree(doc, id));
  const others = doc.objects.filter((x) => !own.has(x.id));
  return `<div class="section"><h3>Mirror &amp; repeat</h3>
    ${seg<'off' | 'mirror' | 'radial'>('symkind', sym?.kind ?? 'off', [['off', 'Off'], ['mirror', 'Mirror'], ['radial', 'Radial']])}
    ${sym ? `<div class="sub">About</div>
    <div class="row"><button class="face-chip" data-sym-ref="" aria-pressed="${!sym.ref}">World origin</button>${others.map((x) => `<button class="face-chip" data-sym-ref="${x.id}" aria-pressed="${sym.ref === x.id}">${escapeHtml(x.name)}</button>`).join('')}</div>
    <div class="sub">${sym.kind === 'mirror' ? 'Across the plane square to its axis' : 'Round its axis'}</div>
    ${seg<'x' | 'y' | 'z'>('symaxis', sym.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']])}
    ${sym.kind === 'radial' ? slider('sym.count', 'Copies in all', sym.count, 2, 24, 1) : ''}
    <p class="hint">${sym.kind === 'mirror' ? 'A mirror image across the plane through the centre of the object chosen above, square to its axis.' : 'Copies spaced evenly round the axis through the centre of the object chosen above (a revolve\'s own axis is Y).'} The copies follow every change.</p>` : '<p class="hint">Mirror this layer across a plane, or repeat it round an axis, through another object (say the vase it sits on) or the world origin.</p>'}
  </div>`;
}

function partSummary(p: LibraryPart): string {
  const L = p.layers;
  if (!L) return `${p.objects.length} object${p.objects.length === 1 ? '' : 's'}${p.hollow ? ` · ${p.thickness.toFixed(2)} cm wall` : ' · solid'}`;
  const g = L.groups.find((x) => x.id === L.root[0]);
  return `${L.objects.length} object${L.objects.length === 1 ? '' : 's'}${g?.shell ? ` · ${g.thickness.toFixed(2)} cm wall` : ''}`;
}

/** Where new layers go: the selected group, the selected object's group, else the top group. */
function targetGroup(): string {
  const g = selectedGroup();
  if (g) return g.id;
  const o = selected();
  if (o) return o.groupId;
  const top = [...(doc.root ?? [])].reverse().find((id) => doc.groups.some((x) => x.id === id));
  return top ?? '';
}

/** The group whose body a layer joins when built: the nearest enclosing group with an effect. */
function bodyGroup(id: string): Group | null {
  for (const gid of ancestors(doc, id)) {
    const g = doc.groups.find((x) => x.id === gid)!;
    if (g.shell || (g.blend ?? 0) > 0 || (g.round ?? 0) > 0) return g;
  }
  return null;
}

function groupEditBody(g: Group) {
  const t = g.transform ?? { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 };
  return `
    <div class="section"><h3>Group · ${escapeHtml(g.name)}</h3>
      <p class="hint">${(g.children ?? []).length} layer${(g.children ?? []).length === 1 ? '' : 's'}. Its op, Shell, Blend and Round are in the Layers tab.</p></div>
    ${symmetrySection(g.id, g.sym)}
    <div class="section"><h3>Transform</h3>
      ${seg<GizmoMode>('gizmo', ui.gizmo, [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale'], ['off', 'Hide']])}
      ${xyz('position', 'Position', t.position, 0.1)}
      ${xyz('rotation', 'Rotation°', t.rotation, 1)}
      ${slider('tf.uscale', 'Size ×', +partScale(t).toFixed(3), 0.1, Math.max(4, Math.ceil(partScale(t) * 1.5)), 0.01)}
      <p class="hint">Moves, turns and scales everything in the group together. Groups scale evenly; walls keep their thickness.</p>
    </div>
    <div class="row"><button class="btn" data-act="duplicate">Duplicate</button><button class="btn danger" data-act="delete">Delete</button></div>`;
}

/** The layers of a saved part (parts saved before layers: converted). */
function partLayers(p: LibraryPart): SceneDoc {
  if (p.layers) return { ...emptyDoc(), ...cloneDoc(p.layers as SceneDoc) };
  const old = emptyDoc();
  old.root = undefined;
  old.parts = [{ ...p, thumb: undefined }];
  old.objects.push(makeObject('part', { id: 'placed', name: p.name, params: { part: p.id }, mode: 'solid', groupId: old.groups[0].id }));
  const d = toLayers(old);
  return { ...d, root: ['placed'] };
}

async function savePart(groupId: string) {
  const name = ((document.getElementById('part-name') as HTMLInputElement | null)?.value.trim()) || 'Part';
  ui.partNaming = null;
  const ids = new Set(subtree(doc, groupId));
  const part: SceneDoc = {
    ...cloneDoc(doc), root: [groupId],
    groups: cloneDoc(doc).groups.filter((g) => ids.has(g.id)),
    objects: cloneDoc(doc).objects.filter((o) => ids.has(o.id)),
    pins: cloneDoc(doc).pins.filter((p) => ids.has(p.objectId)),
  };
  // the group sits in part space: centred on its footprint, standing on the ground
  const g = part.groups.find((x) => x.id === groupId)!;
  const w = worldTransform(doc, groupId);
  g.transform = { ...w, scale: [partScale(w), partScale(w), partScale(w)] };
  g.op = 'add';
  g.hidden = false;
  const built = compileGroups(flattenLayers(part));
  if (!built.length) { toast('This group has nothing to save yet'); renderPanel(); return; }
  const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const u of built) for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], u.bounds.min[a]); b.max[a] = Math.max(b.max[a], u.bounds.max[a]); }
  g.transform.position = [w.position[0] - (b.min[0] + b.max[0]) / 2, w.position[1] - b.min[1], w.position[2] - (b.min[2] + b.max[2]) / 2];
  const now = Date.now();
  const lib: LibraryPart = {
    id: newId('part'), name, thickness: g.thickness, blend: g.blend ?? 0, hollow: !!g.shell, objects: [], pins: [],
    layers: { groups: part.groups, objects: part.objects, pins: part.pins, root: [groupId] }, thumb: view.snapshot(), createdAt: now, updatedAt: now,
  };
  try { await partStore.put(lib); toast(`Saved part "${name}". Add it from the Add tab.`); }
  catch (e) { toast(storeError(e)); }
  renderPanel();
}

/** Insert an editable copy of a saved part's group. */
function addPart(id: string) {
  const lib = partStore.get(id);
  if (!lib) return;
  const src = partLayers(lib);
  const target = targetGroup();
  let gid = '';
  update((d) => {
    gid = copyLayer(src, src.root![0], d);
    const g = d.groups.find((x) => x.id === gid)!;
    g.name = lib.name;
    attach(d, gid, target);
    // it stands at the world origin, as saved
    const t = localTransform(d, target, g.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    g.transform = { ...t, scale: [partScale(t), partScale(t), partScale(t)] };
  });
  ui.selectedId = gid;
  ui.tab = 'layers';
  refreshGhost();
  renderPanel();
  toast(`Added "${lib.name}" as a group`);
}

function editPanel() {
  const o = selected();
  let body = '';
  if (o) {
    const t = o.transform;
    body = `
    <div class="section"><h3>${TYPE_LABEL[o.type]}</h3>${opControls(o)}</div>
    <div class="section"><h3>Shape</h3>
      ${PARAMS[o.type].map(([k, l, mn, mx, st]) => slider(`p.${k}`, l, (o.params as Record<string, number>)[k] ?? (k === 'r2' ? o.params.r! : 0), mn, mx, st)).join('')}
      ${o.type === 'revolve' ? `<button class="btn primary" data-act="edit-profile">Edit profile (${o.params.points?.length ?? 0} points)</button>` : ''}
      ${o.type === 'sweep' ? sweepControls(o) : ''}
      ${ROUNDABLE.has(o.type) ? `${slider('p.round', 'Round edges cm', o.params.round ?? 0, 0, 5, 0.05)}
      <p class="hint">Rounds every edge and corner of this object${(bodyGroup(o.id)?.round ?? 0) > 0 ? ' (its group rounds them too; the larger wins)' : ''}. A group's Round does every object in it at once and the rims of its cuts; Blend fillets where objects meet.</p>` : ''}
    </div>
    ${symmetrySection(o.id, o.sym)}
    <div class="section"><h3>Transform</h3>
      ${seg<GizmoMode>('gizmo', ui.gizmo, [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale'], ['off', 'Hide']])}
      ${xyz('position', 'Position', t.position, 0.1)}
      ${xyz('rotation', 'Rotation°', t.rotation, 1)}
      ${xyz('scale', 'Scale', t.scale, 0.01, true)}
      <p class="hint">Scale runs along the object's own axes. Turn on ⛓ uniform to scale all three together.</p>
    </div>
    <div class="row"><button class="btn" data-act="duplicate">Duplicate</button><button class="btn danger" data-act="delete">Delete</button></div>`;
  } else if (selectedGroup()) body = groupEditBody(selectedGroup()!);
  else body = '<p class="hint">Tap the model, or pick an object below, to edit it. Groups are in the Layers tab.</p>';
  return `<div class="section"><h3>Objects</h3>${objectChips()}</div>${body}`;
}

/** An object's op in its group, and whether it is hollowed with its group's body. */
function opControls(o: SceneObject) {
  const body = bodyGroup(o.id);
  const hollow = !!body?.shell;
  const op: LayerOp = isCut(o.mode) ? o.mode as LayerOp : 'add';
  return `${seg<LayerOp>('mode', op, [['add', 'Add'], ['subtract', 'Subtract'], ['cutout', 'Cutout']])}
    ${op === 'add' && hollow ? `<label class="toggle"><input type="checkbox" data-act="keep-solid" ${o.mode === 'solid' ? 'checked' : ''}> Keep solid (not hollowed with "${escapeHtml(body!.name)}")</label>` : ''}
    <p class="hint">${op === 'add' ? (hollow ? (o.mode === 'solid' ? 'Joins the body but is not hollowed itself; the cavity still cuts it where it passes through.' : `Joins "${escapeHtml(body!.name)}", which is hollowed as one body.`) : 'Joins the layers below it in its group.') : op === 'subtract' ? 'Carves the layers below it in its group. In a hollowed group the cut is made before hollowing, so it gets a wall.' : 'Cuts the finished group, walls and all: it opens into the hollow.'}</p>`;
}

// ---------- the Layers tab
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3"/></svg>';
const OP_MARK: Record<LayerOp, string> = { add: '+', subtract: '−', cutout: '⊘' };

function layerRows(gid: string, depth: number): string {
  // children run bottom to top; the list shows the top first, as paint programs do
  return [...childIds(doc, gid)].reverse().map((id) => {
    const l = layerOf(doc, id);
    if (!l) return '';
    const op = layerOp(l);
    const hidden = l.kind === 'object' ? l.o.hidden : l.g.hidden;
    const name = l.kind === 'object' ? l.o.name : l.g.name;
    const g = l.kind === 'group' ? l.g : null;
    const badges = [
      g?.shell ? `Shell ${g.thickness.toFixed(2)}` : '', (g?.blend ?? 0) > 0 ? 'Blend' : '', (g?.round ?? 0) > 0 ? 'Round' : '',
      l.kind === 'object' && l.o.mode === 'solid' && bodyGroup(id)?.shell ? 'Solid' : '',
      (l.kind === 'object' ? l.o.sym : g?.sym) ? ((l.kind === 'object' ? l.o.sym : g?.sym)!.kind === 'mirror' ? 'Mirror' : 'Radial') : '',
    ].filter(Boolean);
    const icon = l.kind === 'group' ? ICON.layers : ICON[l.o.type] ?? '';
    const row = `<div class="layer-row${id === ui.selectedId ? ' on' : ''}${hidden ? ' off' : ''}" style="--depth:${depth}">
      ${g ? `<button class="lr-fold" data-fold="${id}" aria-label="${g.collapsed ? 'Open' : 'Fold'} ${escapeHtml(name)}" aria-expanded="${!g.collapsed}">${g.collapsed ? '▸' : '▾'}</button>` : '<span class="lr-fold"></span>'}
      <button class="lr-main" data-select="${id}" aria-pressed="${id === ui.selectedId}">
        <span class="lr-op op-${op}" title="${op}">${OP_MARK[op]}</span><span class="lr-icon">${icon}</span>
        <span class="lr-name">${escapeHtml(name)}</span>${badges.length ? `<span class="lr-badges">${badges.join(' · ')}</span>` : ''}</button>
      <button class="lr-eye" data-eye="${id}" aria-label="${hidden ? 'Show' : 'Hide'} ${escapeHtml(name)}" aria-pressed="${!hidden}">${hidden ? EYE_OFF : EYE}</button></div>`;
    return row + (g && !g.collapsed ? layerRows(id, depth + 1) : '');
  }).join('');
}

function layersPanel() {
  const id = ui.selectedId && layerOf(doc, ui.selectedId) ? ui.selectedId : null;
  const l = id ? layerOf(doc, id) : null;
  const tool = (act: string, label: string, title: string, on = true) => `<button class="btn" data-act="${act}" title="${title}" ${on ? '' : 'disabled'}>${label}</button>`;
  const parent = id ? parentOf(doc, id) ?? '' : '';
  const sibs = childIds(doc, parent), at = id ? sibs.indexOf(id) : -1;
  const canIn = at >= 0 && (doc.groups.some((g) => g.id === sibs[at - 1]) || doc.groups.some((g) => g.id === sibs[at + 1]));
  let settings = '';
  if (l?.kind === 'group') {
    const g = l.g;
    settings = `<div class="section group-card">
      <input class="group-name" data-layer-name="${g.id}" value="${escapeHtml(g.name)}" aria-label="Group name">
      ${seg<LayerOp>('gop', g.op ?? 'add', [['add', 'Add'], ['subtract', 'Subtract'], ['cutout', 'Cutout']])}
      <p class="hint">${(g.op ?? 'add') === 'add' ? 'The group joins the layers below it.' : g.op === 'subtract' ? 'The group\'s Add layers carve the layers below it (before hollowing, when that is hollowed).' : 'The group\'s Add layers cut the finished layers below it, walls and all.'}</p>
      <label class="toggle"><input type="checkbox" data-act="gshell" ${g.shell ? 'checked' : ''}> Shell: hollow this group as one body</label>
      ${g.shell ? slider('g.wall', 'Wall cm', g.thickness, 0.05, 4, 0.01) : ''}
      ${slider('g.blend', 'Blend cm', g.blend ?? 0, 0, 10, 0.1)}
      ${slider('g.round', 'Round cm', g.round ?? 0, 0, 5, 0.05)}
      <p class="hint">Shell walls grow inward from the outside of the group's Add layers; Subtract layers inside it are cut before hollowing, Cutouts after. Blend fillets where its layers meet. Round rounds every edge of its objects and the rims of its cuts.</p>
      ${ui.partNaming === g.id
        ? `<div class="piece-form"><label class="field-col"><span>Part name</span><input id="part-name" value="${escapeHtml(g.name)}" maxlength="80"></label>
           <div class="row"><button class="btn primary" data-save-part="${g.id}">Save part</button><button class="btn" data-part-cancel="1">Cancel</button></div></div>`
        : `<div class="row"><button class="btn" data-name-part="${g.id}">Save as part</button></div>`}
    </div>`;
  } else if (l?.kind === 'object') {
    settings = `<div class="section group-card">
      <input class="group-name" data-layer-name="${l.o.id}" value="${escapeHtml(l.o.name)}" aria-label="Layer name">
      ${opControls(l.o)}</div>`;
  }
  return `<div class="section"><div class="row"><h3 style="margin-right:auto">Layers</h3>
      <label class="toggle"><input type="checkbox" id="shell-on" data-act="shell-toggle" ${doc.shell.enabled ? 'checked' : ''}> Hollow</label></div>
    <div class="layers" role="tree">${layerRows('', 0) || '<p class="hint">No layers yet. Add a form from the Add tab.</p>'}</div>
    <div class="layer-tools">
      ${tool('layer-new', '+ Group', 'New empty group')}${tool('layer-wrap', 'Group', 'Put the selected layer in a new group', !!l)}${tool('layer-ungroup', 'Ungroup', 'Replace the group by its layers', l?.kind === 'group')}
      ${tool('layer-up', '↑', 'Move up', at >= 0 && at < sibs.length - 1)}${tool('layer-down', '↓', 'Move down', at > 0)}
      ${tool('layer-out', '⇤ Out', 'Move out of its group', !!parent)}${tool('layer-in', 'In ⇥', 'Move into the group next to it', canIn)}
      ${tool('duplicate', 'Duplicate', 'Duplicate', !!l)}${tool('delete', 'Delete', 'Delete', !!l)}
    </div>
    <p class="hint">Layers build bottom to top: Add joins what is below it in its group, Subtract carves it, Cutout cuts it after hollowing. Tap a layer to select it; the Edit tab moves, shapes and mirrors it.</p></div>
    ${settings}`;
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
      ${ui.holeMode === 'pin' ? slider('pin', 'Radius cm', ui.pinRadius, 0.1, 4, 0.05) : ''}
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
      <p class="hint">${doc.kernel === 'sdf' ? 'Distance fields drawn directly on the GPU: exact outer surfaces and joins at any zoom, exact walls, openings on any surface, smooth blends. Quality sets the detail where forms join.' : doc.meshMethod === 'offset' ? 'Exact surfaces and very fast. Each form is hollowed separately, so walls come out thicker where forms meet, narrow joins can stay closed, stretched shapes get uneven walls, and there are no smooth blends.' : 'Exact erosion of the whole union. Correct at joins, but can take minutes.'}</p>
      ${seg<Quality>('quality', ui.quality, [['draft', 'Draft'], ['normal', 'Normal'], ['fine', 'Fine']])}
    </div>
    <div class="section"><h3>Look inside</h3>
      <label class="toggle"><input type="checkbox" id="sec-on" data-act="section-toggle" ${ui.section.on ? 'checked' : ''}> Section cut</label>
      ${ui.section.on ? `${seg('axis', ui.section.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']])}${slider('section', 'Position', ui.section.t, 0, 1, 0.005)}` : ''}
      ${doc.kernel === 'mesh' ? `<label class="toggle"><input type="checkbox" id="wire-on" data-act="wire-toggle" ${ui.wire ? 'checked' : ''}> Show triangles</label>` : ''}
      <label class="toggle"><input type="checkbox" id="hand-on" data-act="hand-toggle" ${ui.hand ? 'checked' : ''}> Hand for scale (adult hand, ${HAND_LENGTH_CM} cm)</label>
    </div>
    ${doc.kernel === 'sdf' ? `<div class="section"><h3>Rendering</h3><div class="stats">${escapeHtml([
      'Raymarched on the GPU: no triangles.',
      ...((r) => currentGrids(r).map((c, i) => c ? `${r.groups[i].name}: cavity grid ${c.dims.join('×')}, ${c.h.toFixed(2)} cm texels` : ''))(expandDoc(doc)),
      cavityMs ? `last cavity build ${fmtMs(cavityMs)}` : '',
    ].filter(Boolean).join('\n'))}</div></div>` : `<div class="section"><h3>Last build</h3><div class="stats">${s ? escapeHtml([
      `kernel     ${s.kernel}`,
      `time       ${fmtMs(s.totalMs)}`,
      `triangles  ${s.triangles.toLocaleString()}`,
      s.cellSize ? `cell       ${s.cellSize.toFixed(3)} cm` : '',
      `open edges ${s.boundaryEdges}   non-manifold ${s.nonManifoldEdges}`,
      ...Object.entries(s.timings).map(([k, v]) => `  ${k.padEnd(10)} ${v} ms`),
      ...s.warnings.map((w) => `! ${w}`),
    ].filter(Boolean).join('\n')) : 'building…'}</div></div>`}
    <div class="section"><h3>Frame rate</h3>
      <p class="hint">Turns the camera once around the piece and times every frame on this device.</p>
      <button class="btn" data-act="measure-fps" ${ui.fps === 'measuring…' ? 'disabled' : ''}>Measure</button>
      ${ui.fps ? `<div class="stats">${escapeHtml(ui.fps)}</div>` : ''}</div>
    <div class="row"><button class="btn danger" data-act="new">New empty scene</button></div>`;
}

function examplesPanel() {
  return `<div class="pieces">${exampleList.map((e) => `<div class="piece">
    <button class="piece-open" data-example="${e.id}" aria-label="Open ${escapeHtml(e.title)}">${EXAMPLE_THUMBS[e.id] ? `<img src="${EXAMPLE_THUMBS[e.id]}" alt="" loading="lazy">` : '<span class="piece-empty">No preview</span>'}</button>
    <div class="piece-meta"><div class="piece-title"><b>${escapeHtml(e.title)}</b></div><small class="clamp2">${escapeHtml(e.notes)}</small></div></div>`).join('')}</div>`;
}

type CurveField = 'points' | 'path' | 'shape' | 'lift';
const PLANE_AXES: Record<string, [string, string]> = { xy: ['X', 'Y'], xz: ['X', 'Z'], yz: ['Z', 'Y'] };

function curveSetup(o: SceneObject, f: CurveField): { mode: CurveMode; title: string; hint: string } {
  const p = o.params;
  const base = 'Tap empty space to add a point, tap a point to select it. Drag near a point to move it, or anywhere else to move the selected one. Squares are sharp corners. Pinch or scroll to zoom, two fingers to pan.';
  if (f === 'path') {
    const plane = p.plane ?? 'xy';
    return { mode: { kind: 'path', closed: !!p.closed, axes: PLANE_AXES[plane] }, title: `Path of ${o.name} · ${plane.toUpperCase()} plane`,
      hint: `${base} The section travels along this curve${p.closed ? ', round the loop' : ' from start to end'}.` };
  }
  if (f === 'shape') return { mode: { kind: 'section', closed: true, axes: ['width', 'height'] }, title: `Section of ${o.name}`, hint: `${base} The outline is fitted to the section's width and height.` };
  if (f === 'lift') {
    const flat = buildSweepPath({ ...p, lift: [{ r: 0, y: 0 }, { r: 1, y: 0 }] }).length;
    return { mode: { kind: 'graph', length: flat }, title: `Lift of ${o.name} along its path`,
      hint: `${base} Left to right is the distance along the path; up and down lifts the path off its plane. A straight rising line on a closed path makes a coil.` };
  }
  return { mode: { kind: 'profile' }, title: `Profile of ${o.name}`, hint: `${base} The curve spins a full 360° around the dashed axis.` };
}

function renderProfilePanel() {
  const o = doc.objects.find((x) => x.id === ui.profileEditing);
  const f = ui.curveField;
  if (!o || (o.type !== 'revolve' && o.type !== 'sweep')) { ui.profileEditing = null; renderPanel(); return; }
  const { mode, title, hint } = curveSetup(o, f);
  const pts = (o.params as Record<string, ProfilePoint[] | undefined>)[f] ?? [];
  panel.innerHTML = `<div class="profile-wrap">
    <div class="row"><h3 style="margin:0 auto 0 0;font:600 11px var(--font-body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">${escapeHtml(title)}</h3>
      <button class="btn" data-act="profile-zoom-out" aria-label="Zoom out">−</button>
      <button class="btn" data-act="profile-fit">Fit</button>
      <button class="btn" data-act="profile-zoom-in" aria-label="Zoom in">+</button>
      <button class="btn primary" data-act="profile-done">Done</button></div>
    <canvas class="profile-canvas" id="profile-canvas"></canvas>
    <label class="field"><span>Smoothness</span>
      <input type="range" id="profile-smooth" min="0" max="1" step="0.01" value="1" ${ui.profilePoint < 0 ? 'disabled' : ''}></label>
    <div class="row">
      <button class="btn danger" data-act="profile-delete" disabled>Delete point</button>
    </div>
    <p class="hint">${escapeHtml(hint)}</p></div>`;
  const ed = new ProfileEditor(document.getElementById('profile-canvas') as HTMLCanvasElement, pts, mode);
  profileEditor = ed;
  const smooth = document.getElementById('profile-smooth') as HTMLInputElement;
  const set = (params: SceneObject['params'], v: ProfilePoint[]) => ({ ...params, [f]: v });
  ed.onChange = (v, done) => {
    // While dragging only the wireframe ghost follows; the shape rebuilds on release.
    if (!done) { view.setGhost({ ...o, params: set(o.params, v), transform: worldTransform(doc, o.id) }, 'off'); return; }
    update((d) => { const t = d.objects.find((x) => x.id === o.id)!; t.params = set(t.params, v); });
    view.setGhost(ghostOf(), 'off');
  };
  ed.onSelect = (i) => {
    ui.profilePoint = i;
    smooth.disabled = i < 0;
    smooth.value = String(ed.smooth());
    panel.querySelectorAll<HTMLButtonElement>('[data-act="profile-delete"]').forEach((b) => { b.disabled = !ed.canDelete(i); });
  };
  smooth.addEventListener('input', () => ed.setSmooth(Number(smooth.value), false));
  smooth.addEventListener('change', () => ed.setSmooth(Number(smooth.value), true));
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
  const gid = selectedGroup()?.id;
  if (key.startsWith('g.') && gid) {
    return update((d) => {
      const g = d.groups.find((x) => x.id === gid)!;
      if (key === 'g.wall') g.thickness = Math.max(0.02, v);
      if (key === 'g.blend') g.blend = Math.max(0, v);
      if (key === 'g.round') g.round = Math.max(0, v);
    }, interactive);
  }
  if (key === 'sym.count') {
    return update((d) => { const s = symOf(d); if (s) s.count = Math.round(v); }, interactive);
  }
  if (key.startsWith('tf.') && gid) {
    return update((d) => {
      const g = d.groups.find((x) => x.id === gid)!;
      const t = g.transform ??= { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
      if (key === 'tf.uscale') { const s = Math.max(0.05, v); t.scale = [s, s, s]; return; }
      const [, field, idx] = key.split('.');
      if (field === 'position' || field === 'rotation') t[field][Number(idx)] = v;
    }, interactive);
  }
  if (key === 'pin') { ui.pinRadius = Math.max(0.02, v); return; }
  if (key === 'section') { ui.section.t = v; view.setSection(true, ui.section.axis, v); return; }
  const o = selected();
  if (!o) return;
  if (key.startsWith('p.')) {
    const k = key.slice(2);
    return update((d) => { (d.objects.find((x) => x.id === o.id)!.params as Record<string, number>)[k] = k === 'n' || k === 'turns' ? Math.round(v) : v; }, interactive);
  }
  if (key === 'tf.uscale') {
    return update((d) => { const s = Math.max(0.05, v); d.objects.find((x) => x.id === o.id)!.transform.scale = [s, s, s]; }, interactive);
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
  if (el.dataset.layerName) {
    const lid = el.dataset.layerName;
    update((d) => { const l = layerOf(d, lid); if (l) (l.kind === 'object' ? l.o : l.g).name = el.value.trim() || (l.kind === 'object' ? TYPE_LABEL[l.o.type] : 'Group'); });
    renderPanel();
    return;
  }
  const act = el.dataset.act;
  if (act === 'shell-toggle') update((d) => { d.shell.enabled = el.checked; });
  if (act === 'gshell') { update((d) => { const g = d.groups.find((x) => x.id === ui.selectedId); if (g) g.shell = el.checked; }); renderPanel(); }
  if (act === 'keep-solid') { update((d) => { const o = d.objects.find((x) => x.id === ui.selectedId); if (o && !isCut(o.mode)) o.mode = el.checked ? 'solid' : 'shell'; }); renderPanel(); }
  if (act === 'sweep-closed') {
    update((d) => {
      const p = d.objects.find((x) => x.id === ui.selectedId)!.params;
      p.closed = el.checked;
      // a loop needs at least three points
      if (p.closed && (p.path?.length ?? 0) < 3 && p.path?.length === 2) {
        const [a, b] = p.path;
        const mx = (a.r + b.r) / 2, my = (a.y + b.y) / 2, dx = b.r - a.r, dy = b.y - a.y;
        p.path.splice(1, 0, { r: mx - dy / 2, y: my + dx / 2 });
      }
    });
    renderPanel();
  }
  if (act === 'section-toggle') { ui.section.on = el.checked; view.setSection(el.checked, ui.section.axis, ui.section.t); renderPanel(); }
  if (act === 'hand-toggle') { ui.hand = el.checked; view.setHandVisible(el.checked); renderStatus(); }
  if (act === 'wire-toggle') { ui.wire = el.checked; if (lastResult) view.setResult(lastResult, ui.wire); }
});

panel.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'rename-input' && e.key === 'Enter' && ui.renameFor) renamePiece(ui.renameFor);
  if (el.id === 'rename-input' && e.key === 'Escape') { closeCards(); renderPanel(); }
});
panel.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!btn) return;
  const d = btn.dataset;
  if (d.add) return d.add === 'coil' ? addObject('sweep', { params: defaultCoil(), name: 'Coil' }) : addObject(d.add as PrimitiveType);
  if (d.select) return selectObject(d.select);
  if (d.addPart) { ui.libMenu = null; return addPart(d.addPart); }
  if (d.namePart) { ui.partNaming = d.namePart; renderPanel(); (document.getElementById('part-name') as HTMLInputElement | null)?.select(); return; }
  if (d.savePart) { savePart(d.savePart); return; }
  if (d.partCancel) { ui.partNaming = null; renderPanel(); return; }
  if (d.libMenu) { const id = d.libMenu; ui.libRename = ui.libDelete = null; ui.libMenu = ui.libMenu === id ? null : id; renderPanel(); return; }
  if (d.libCancel) { ui.libMenu = ui.libRename = ui.libDelete = null; renderPanel(); return; }
  if (d.libRename) { ui.libMenu = null; ui.libRename = d.libRename; renderPanel(); return; }
  if (d.libRenameSave) {
    const id = d.libRenameSave, name = (document.getElementById('lib-rename-input') as HTMLInputElement).value.trim() || 'Part';
    ui.libRename = null;
    partStore.patch(id, { name, updatedAt: Date.now() }).catch((e) => toast(storeError(e)));
    return;
  }
  if (d.libDel) { ui.libMenu = null; ui.libDelete = d.libDel; renderPanel(); return; }
  if (d.libDelConfirm) { const id = d.libDelConfirm; ui.libDelete = null; partStore.remove(id).catch((e) => toast(storeError(e))); return; }
  if (d.example) return loadExample(d.example);
  if (onGalleryClick(d)) return;
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
  if (d.symRef !== undefined) {
    update((doc2) => { const sym = symOf(doc2); if (sym) sym.ref = d.symRef || null; });
    renderPanel();
    return;
  }
  if (d.fold) {
    const g = doc.groups.find((x) => x.id === d.fold);
    if (g) { g.collapsed = !g.collapsed; save(doc); renderPanel(); }
    return;
  }
  if (d.eye) {
    update((doc2) => { const l = layerOf(doc2, d.eye!); if (l) { const h = l.kind === 'object' ? l.o : l.g; h.hidden = !h.hidden; } });
    renderPanel();
    return;
  }
  if (d.unpin) { update((doc2) => { doc2.pins = doc2.pins.filter((p) => p.id !== d.unpin); }); renderPanel(); return; }
  switch (d.act) {
    case 'lock': ui.lockScale = !ui.lockScale; btn.setAttribute('aria-pressed', String(ui.lockScale)); break;
    case 'duplicate': {
      const id = ui.selectedId;
      if (!id || !layerOf(doc, id)) break;
      let copy = '';
      update((doc2) => {
        const parent = parentOf(doc2, id) ?? '';
        copy = copyLayer(doc2, id, doc2);
        attach(doc2, copy, parent, childIds(doc2, parent).indexOf(id) + 1);
        const l = layerOf(doc2, copy)!;
        const h = l.kind === 'object' ? l.o : l.g;
        h.name = `${h.name} copy`;
        const t = h.transform ??= { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        t.position = [t.position[0] + 4, t.position[1], t.position[2]];
      });
      selectObject(copy);
      break;
    }
    case 'delete': {
      const id = ui.selectedId;
      if (!id || !layerOf(doc, id)) break;
      const parent = parentOf(doc, id) ?? '';
      update((doc2) => deleteLayer(doc2, id));
      // select its neighbour, else its group
      const sibs = childIds(doc, parent);
      selectObject(sibs[sibs.length - 1] ?? (parent || null));
      break;
    }
    case 'layer-new': case 'layer-wrap': case 'layer-ungroup': case 'layer-up': case 'layer-down': case 'layer-out': case 'layer-in':
      layerTool(d.act); break;
    case 'edit-profile': case 'edit-path': case 'edit-shape': case 'edit-lift':
      ui.curveField = ({ 'edit-profile': 'points', 'edit-path': 'path', 'edit-shape': 'shape', 'edit-lift': 'lift' } as Record<string, CurveField>)[d.act!];
      ui.profileEditing = ui.selectedId; ui.profilePoint = -1; ghostOutline(); view.setGhost(ghostOf(), 'off'); renderPanel(); break;
    case 'profile-done': ui.profileEditing = null; refreshGhost(); renderPanel(); break;
    case 'profile-delete': profileEditor?.deleteSelected(); break;
    case 'profile-zoom-in': profileEditor?.zoomBy(1.4); break;
    case 'profile-zoom-out': profileEditor?.zoomBy(1 / 1.4); break;
    case 'profile-fit': profileEditor?.fit(); break;
    case 'close-gallery': ui.showGallery = false; renderPanel(); break;
    case 'new-piece': newPiece(); break;
    case 'measure-fps': measureFps(); break;
    case 'save-piece': savePiece(); break;
    case 'new':
      update((doc2) => { Object.assign(doc2, emptyDoc(), { kernel: doc2.kernel }); });
      ui.selectedId = null; ui.tab = 'add'; refreshGhost(); renderPanel();
      break;
  }
});

function onSeg(name: string, value: string) {
  switch (name) {
    case 'mode': update((d) => {
      const o = d.objects.find((x) => x.id === ui.selectedId)!;
      o.mode = value === 'add' ? (o.mode === 'solid' ? 'solid' : 'shell') : value as ObjectMode;
    }); refreshGhost(); break;
    case 'gop': update((d) => { d.groups.find((x) => x.id === ui.selectedId)!.op = value as LayerOp; }); refreshGhost(); break;
    case 'gizmo': ui.gizmo = value as GizmoMode; refreshGhost(); break;
    case 'symkind': update((d) => {
      const l = layerOf(d, ui.selectedId ?? '');
      if (!l) return;
      const host = l.kind === 'object' ? l.o : l.g;
      if (value === 'off') { delete host.sym; return; }
      // about the first revolve outside it (a vase's axis), else the world origin
      const own = new Set(subtree(d, host.id));
      const ref = host.sym?.ref ?? d.objects.find((x) => !own.has(x.id) && x.type === 'revolve')?.id ?? null;
      host.sym = { kind: value as 'mirror' | 'radial', ref, axis: host.sym?.axis ?? (value === 'radial' ? 'y' : 'x'), count: value === 'radial' ? Math.max(host.sym?.count ?? 0, 4) : 2 };
    }); break;
    case 'symaxis': update((d) => { const s = symOf(d); if (s) s.axis = value as 'x' | 'y' | 'z'; }); break;
    case 'holeMode': ui.holeMode = value as 'face' | 'pin'; break;
    case 'kernel': update((d) => { d.kernel = value as SceneDoc['kernel']; }); break;
    case 'meshMethod': update((d) => { d.meshMethod = value as SceneDoc['meshMethod']; }); break;
    case 'quality': ui.quality = value as Quality; sync(false); break;
    case 'section': update((d) => { d.objects.find((x) => x.id === ui.selectedId)!.params.section = value as 'circle' | 'square' | 'custom'; }); break;
    case 'join': update((d) => { d.objects.find((x) => x.id === ui.selectedId)!.params.join = value as 'round' | 'miter'; }); break;
    case 'cap': update((d) => { d.objects.find((x) => x.id === ui.selectedId)!.params.cap = value as 'flat' | 'round' | 'square'; }); break;
    case 'plane': update((d) => { d.objects.find((x) => x.id === ui.selectedId)!.params.plane = value as 'xy' | 'xz' | 'yz'; }); break;
    case 'galleryTab': ui.galleryTab = value as 'mine' | 'examples'; closeCards(); break;
    case 'axis': ui.section.axis = value as 'x' | 'y' | 'z'; view.setSection(true, ui.section.axis, ui.section.t); break;
  }
  renderPanel();
  renderStatus();
}

/** The selected layer's symmetry, in document d. */
function symOf(d: SceneDoc): Symmetry | undefined {
  const l = layerOf(d, ui.selectedId ?? '');
  return l ? (l.kind === 'object' ? l.o.sym : l.g.sym) : undefined;
}

/** Put a layer into group gid at index, keeping it where it is in the world. */
function moveLayer(d: SceneDoc, id: string, gid: string, index?: number) {
  const w = worldTransform(d, id);
  attach(d, id, gid, index);
  const t = localTransform(d, gid, w);
  const l = layerOf(d, id)!;
  if (l.kind === 'object') l.o.transform = t;
  else l.g.transform = { ...t, scale: [partScale(t), partScale(t), partScale(t)] };
}

function layerTool(act: string) {
  const id = ui.selectedId && layerOf(doc, ui.selectedId) ? ui.selectedId : null;
  const parent = id ? parentOf(doc, id) ?? '' : '';
  let select: string | null = id;
  update((d) => {
    const sibs = childIds(d, parent), at = id ? sibs.indexOf(id) : -1;
    switch (act) {
      case 'layer-new': {
        const g = newGroup(newId('g'), `Group ${d.groups.length + 1}`, { shell: false });
        d.groups.push(g);
        const into = id && layerOf(d, id)?.kind === 'group' ? id : parent;
        attach(d, g.id, into, into === parent && at >= 0 ? at + 1 : undefined);
        select = g.id;
        break;
      }
      case 'layer-wrap': if (id) select = groupLayers(d, [id], `Group ${d.groups.length + 1}`); break;
      case 'layer-ungroup': if (id) { select = d.groups.find((g) => g.id === id)?.children?.slice(-1)[0] ?? null; ungroup(d, id); } break;
      case 'layer-up': if (id && at < sibs.length - 1) attach(d, id, parent, at + 1); break;
      case 'layer-down': if (id && at > 0) attach(d, id, parent, at - 1); break;
      case 'layer-out': if (id && parent) { const pp = parentOf(d, parent) ?? ''; moveLayer(d, id, pp, childIds(d, pp).indexOf(parent) + 1); } break;
      case 'layer-in': {
        if (!id) break;
        // into the group just below it (at its top), else the one just above (at its bottom)
        const below = d.groups.find((g) => g.id === sibs[at - 1]), above = d.groups.find((g) => g.id === sibs[at + 1]);
        if (below) { moveLayer(d, id, below.id); below.collapsed = false; }
        else if (above) { moveLayer(d, id, above.id, 0); above.collapsed = false; }
        break;
      }
    }
  });
  ui.selectedId = select;
  refreshGhost();
  renderPanel();
}

function toggleHole(oid: string, fid: string) {
  update((d) => {
    const o = d.objects.find((x) => x.id === oid)!;
    o.holes = o.holes.includes(fid) ? o.holes.filter((h) => h !== fid) : [...o.holes, fid];
  });
  renderPanel();
}

function addObject(type: PrimitiveType, extra: Partial<SceneObject> = {}) {
  const target = targetGroup();
  const o = makeObject(type, { groupId: target, ...extra });
  const n = doc.objects.filter((x) => x.type === type && (x.name.startsWith(o.name))).length;
  if (n) o.name = `${o.name} ${n + 1}`;
  // it appears at the world origin, whatever its group's placement
  if (target) o.transform = localTransform(doc, target, o.transform);
  update((d) => { d.objects.push(o); attach(d, o.id, target); });
  ui.selectedId = o.id;
  ui.tab = 'edit';
  if (type === 'revolve') { ui.profileEditing = o.id; ui.curveField = 'points'; ui.profilePoint = -1; }
  if (type === 'sweep' && !extra.params) { ui.profileEditing = o.id; ui.curveField = 'path'; ui.profilePoint = -1; }
  refreshGhost();
  if (type === 'revolve' || ui.profileEditing === o.id) view.setGhost(ghostOf(), 'off');
  renderPanel();
}

/** Examples open as a new, unsaved piece named after the example. */
async function loadExample(id: string) {
  const ex = exampleList.find((e) => e.id === id)!;
  if (!(await leaveCurrent())) return;
  const d = cloneDoc(ex.doc);
  d.kernel = doc.kernel; d.meshMethod = doc.meshMethod;
  loadDoc(d, { id: null, name: ex.title }, null);
  toast(ex.title);
}

document.querySelector('.tabbar')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
  if (!b) return;
  const t = b.dataset.tab as Tab;
  ui.showGallery = false;
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
document.getElementById('btn-gallery')!.addEventListener('click', () => {
  ui.showGallery = !ui.showGallery;
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
  const id = ui.selectedId;
  if (!id || !layerOf(doc, id)) return;
  update((d) => {
    // the gizmo works in the world; layers keep transforms within their group
    const local = localTransform(d, parentOf(d, id) ?? '', t);
    const l = layerOf(d, id)!;
    if (l.kind === 'object') l.o.transform = local;
    else { const s = partScale(local); l.g.transform = { ...local, scale: [s, s, s] }; }
  }, !done);
  if (done && ui.tab === 'edit') renderPanel();
};

// taps on the model: select, open a face, or drill a pin hole
view.onTap = (hit) => {
  if (!hit) {
    if (ui.tab === 'edit' && !ui.profileEditing) selectObject(null);
    return;
  }
  const objs = compileScene(expandDoc(doc).objects);
  const p = hit.point;
  const c = classifyPoint(objs, p.x, p.y, p.z, ['shell', 'solid', 'subtract', 'cutout']);
  if (!c) return;
  const oid = placedId(c.obj.obj.id);
  if (ui.tab === 'holes' && ui.holeMode === 'face') {
    if (c.obj.obj.mode !== 'shell') { toast('Openings go on Shell objects'); return; }
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
  if (ui.tab !== 'edit' && ui.tab !== 'layers') ui.tab = 'edit';
  ui.sheetOpen = true;
  // unfold its groups so the Layers list shows it
  for (const gid of ancestors(doc, oid)) { const g = doc.groups.find((x) => x.id === gid); if (g) g.collapsed = false; }
  selectObject(oid);
};

let toastTimer = 0;
// ---------- pieces: save, open, new, gallery
function setCurrent(c: Current) {
  current = c;
  try { localStorage.setItem(CURRENT_KEY, JSON.stringify(c)); } catch { /* storage unavailable */ }
  renderTopbar();
}

function isDirty() {
  return committed !== current.saved && doc.objects.length > 0;
}

function viewState(): ViewState {
  return { kernel: doc.kernel, meshMethod: doc.meshMethod, quality: ui.quality, section: { ...ui.section }, camera: view.cameraState() };
}

function storeError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === 'quota_exceeded') return 'Storage is full. Delete a few pieces, then save again.';
  if (code === 'invalid_argument') return 'This piece is too large to save.';
  return 'Couldn\'t save. Check your connection and try again.';
}

/** Save the open piece (a new entry if it was never saved). Resolves false on failure. */
async function savePiece(quiet = false): Promise<boolean> {
  const now = Date.now();
  const existing = store.get(current.id);
  const p: Piece = existing
    ? { ...existing, doc: cloneDoc(doc), thumb: view.snapshot(), view: viewState(), updatedAt: now }
    : { id: newId('p'), name: current.id || current.name !== 'Untitled' ? current.name : untitledName(), doc: cloneDoc(doc), thumb: view.snapshot(), view: viewState(), createdAt: now, updatedAt: now, flag: null };
  setCurrent({ id: p.id, name: p.name, saved: committed });
  try {
    await store.put(p);
    if (!quiet) toast(`Saved "${p.name}"`);
    if (ui.showGallery) renderPanel();
    return true;
  } catch (e) {
    setCurrent({ ...current, saved: '' });
    toast(storeError(e));
    return false;
  }
}

/** Unsaved changes are saved before another piece replaces them (never-saved work becomes "Untitled"). */
async function leaveCurrent(): Promise<boolean> {
  clearTimeout(autosaveTimer);
  if (isDirty()) return savePiece(true);
  return true;
}

// ---------- autosave: every committed change is saved shortly after, and when the page is hidden
let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(autosave, 1500);
}
let autosaving: Promise<boolean> | null = null;
function autosave() {
  clearTimeout(autosaveTimer);
  if (!isDirty() || autosaving) { if (autosaving && isDirty()) scheduleAutosave(); return; }
  autosaving = savePiece(true).finally(() => { autosaving = null; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave(); });
window.addEventListener('pagehide', autosave);

/** A fresh name for never-saved work: Untitled, Untitled 2, ... */
function untitledName(): string {
  const names = new Set(store.list().map((p) => p.name));
  for (let k = 1; ; k++) { const n = k === 1 ? 'Untitled' : `Untitled ${k}`; if (!names.has(n)) return n; }
}

async function openPiece(id: string) {
  const p = store.get(id);
  if (!p) return;
  if (id !== current.id && !(await leaveCurrent())) return;
  loadDoc(p.doc, { id: p.id, name: p.name }, p.view);
  toast(`Opened "${p.name}"`);
}

async function newPiece() {
  if (!(await leaveCurrent())) return;
  const d = emptyDoc();
  d.kernel = doc.kernel; d.meshMethod = doc.meshMethod;
  loadDoc(d, { id: null, name: 'Untitled' }, null);
  ui.tab = 'add';
  renderPanel();
}

/** Replace the document wholesale (no undo across pieces) and restore its view. */
function loadDoc(d: SceneDoc, who: { id: string | null; name: string }, v: ViewState | null) {
  doc = loadable(cloneDoc(d));
  committed = JSON.stringify(doc);
  past.length = 0; future.length = 0;
  save(doc);
  setCurrent({ ...who, saved: committed });
  ui.selectedId = doc.objects[0]?.id ?? null;
  ui.showGallery = false;
  ui.menuFor = ui.renameFor = ui.flagFor = ui.deleteFor = null;
  if (v) {
    ui.quality = v.quality;
    ui.section = { ...v.section };
    view.setSection(ui.section.on, ui.section.axis, ui.section.t);
    view.setCameraState(v.camera);
    frameOnNext = false;
  } else frameOnNext = true;
  sync(false);
  refreshGhost();
  renderAll();
}

async function duplicatePiece(id: string) {
  const p = store.get(id);
  if (!p) return;
  const now = Date.now();
  try { await store.put({ ...JSON.parse(JSON.stringify(p)), id: newId('p'), name: `${p.name} copy`, createdAt: now, updatedAt: now, flag: null }); }
  catch (e) { toast(storeError(e)); }
}

const flagLabel = (f: PieceFlag) => f.kernels.length === 2 ? 'SDF + Mesh problem' : f.kernels[0] === 'sdf' ? 'SDF problem' : f.kernels[0] === 'mesh' ? 'Mesh problem' : 'Problem';

function when(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function pieceCard(p: Piece) {
  const cur = p.id === current.id;
  let extra = '';
  if (ui.renameFor === p.id) {
    extra = `<div class="piece-form"><label class="field-col"><span>Name</span><input id="rename-input" value="${escapeHtml(p.name)}" maxlength="80"></label>
      <div class="row"><button class="btn primary" data-rename-save="${p.id}">Rename</button><button class="btn" data-card-cancel="1">Cancel</button></div></div>`;
  } else if (ui.flagFor === p.id) {
    const f = p.flag;
    extra = `<div class="piece-form"><p class="hint">Which kernel draws this piece wrong? Claude can open flagged pieces to reproduce the problem.</p>
      <label class="toggle"><input type="checkbox" id="flag-sdf" ${!f || f.kernels.includes('sdf') ? 'checked' : ''}> SDF looks wrong</label>
      <label class="toggle"><input type="checkbox" id="flag-mesh" ${f?.kernels.includes('mesh') ? 'checked' : ''}> Mesh looks wrong</label>
      <label class="field-col"><span>What's wrong (optional)</span><textarea id="flag-note" rows="3" maxlength="2000" placeholder="e.g. rim is jagged at Draft; wall tears near the handle">${escapeHtml(f?.note ?? '')}</textarea></label>
      ${cur ? '<p class="hint">The current camera, quality and section are saved with the flag.</p>' : ''}
      <div class="row"><button class="btn primary" data-flag-save="${p.id}">Save flag</button><button class="btn" data-card-cancel="1">Cancel</button></div></div>`;
  } else if (ui.deleteFor === p.id) {
    extra = `<div class="piece-form"><p>Delete "${escapeHtml(p.name)}"? This can't be undone.</p>
      <div class="row"><button class="btn danger" data-del-confirm="${p.id}">Delete</button><button class="btn" data-card-cancel="1">Cancel</button></div></div>`;
  } else if (ui.menuFor === p.id) {
    extra = `<div class="piece-menu" role="menu">
      <button role="menuitem" data-rename="${p.id}">Rename</button>
      <button role="menuitem" data-dup="${p.id}">Duplicate</button>
      <button role="menuitem" data-flag="${p.id}">${p.flag ? 'Edit problem flag' : 'Flag a problem'}</button>
      ${p.flag ? `<button role="menuitem" data-unflag="${p.id}">Clear problem flag</button>` : ''}
      <button role="menuitem" class="danger" data-del="${p.id}">Delete</button></div>`;
  }
  return `<div class="piece${cur ? ' current' : ''}">
    <button class="piece-open" data-open="${p.id}" aria-label="Open ${escapeHtml(p.name)}">${p.thumb ? `<img src="${p.thumb}" alt="">` : '<span class="piece-empty">No preview</span>'}</button>
    <div class="piece-meta">
      <div class="piece-title"><b>${escapeHtml(p.name)}</b><button class="piece-more" data-menu="${p.id}" aria-label="More actions for ${escapeHtml(p.name)}" aria-expanded="${ui.menuFor === p.id}">⋯</button></div>
      <small>${cur ? 'Open now · ' : ''}${when(p.updatedAt)} · ${p.doc.objects.length} object${p.doc.objects.length === 1 ? '' : 's'}</small>
      ${p.flag ? `<span class="flag-badge" title="${escapeHtml(p.flag.note)}">${flagLabel(p.flag)}</span>` : ''}
    </div>${extra}</div>`;
}

function galleryPanel() {
  const pieces = store.list();
  const saveLabel = current.id && !isDirty() ? 'Saved' : 'Save';
  const body = ui.galleryTab === 'examples'
    ? `<p class="hint">Benchmark scenes. Opening one replaces the open piece; your changes are saved first.</p>${examplesPanel()}`
    : pieces.length
      ? `<div class="pieces">${pieces.map(pieceCard).join('')}</div>`
      : '<p class="hint">No saved pieces yet. Your work is saved here automatically once you change something.</p>';
  return `<div class="section">
    <div class="row"><h3 style="margin-right:auto">Pieces</h3>
      <button class="btn" data-act="new-piece">New</button>
      <button class="btn primary" data-act="save-piece" ${saveLabel === 'Saved' ? 'disabled' : ''}>${saveLabel}</button>
      <button class="btn" data-act="close-gallery">Close</button></div>
    ${seg<'mine' | 'examples'>('galleryTab', ui.galleryTab, [['mine', `My pieces (${pieces.length})`], ['examples', 'Examples']])}
    <p class="hint">${store.kind === 'cloud' ? 'Saved with this artifact, on any device you open it on. Claude can read flagged pieces.' : 'Saved in this browser only.'}</p>
    ${body}</div>`;
}

function measureFps() {
  ui.fps = 'measuring…';
  renderPanel();
  // let the panel paint first; the measurement blocks while it runs
  setTimeout(() => {
    const line = (label: string, ms: number[] & { w?: number; h?: number }) => {
      const s = [...ms].sort((a, b) => a - b), med = s[s.length >> 1], slow = s[Math.floor(s.length * 0.9)];
      return `${label.padEnd(8)}${String(Math.round(1000 / med)).padStart(3)} fps · ${med.toFixed(0)} ms (slowest ${slow.toFixed(0)})\n${''.padEnd(8)}${ms.w}×${ms.h} px`;
    };
    ui.fps = [line('moving', view.benchOrbit(24, true)), line('settled', view.benchOrbit(8, false))].join('\n');
    renderPanel();
  }, 60);
}

function closeCards() {
  ui.menuFor = ui.renameFor = ui.flagFor = ui.deleteFor = null;
}

/** Gallery buttons; returns true when the click was one of them. */
function onGalleryClick(d: DOMStringMap): boolean {
  const closeCard = closeCards;
  if (d.open) { closeCard(); openPiece(d.open); return true; }
  if (d.menu) { const id = d.menu; const was = ui.menuFor === id; closeCard(); ui.menuFor = was ? null : id; renderPanel(); return true; }
  if (d.cardCancel) { closeCard(); renderPanel(); return true; }
  if (d.rename) { closeCard(); ui.renameFor = d.rename; renderPanel(); (document.getElementById('rename-input') as HTMLInputElement | null)?.select(); return true; }
  if (d.renameSave) { renamePiece(d.renameSave); return true; }
  if (d.dup) { closeCard(); duplicatePiece(d.dup); return true; }
  if (d.flag) { closeCard(); ui.flagFor = d.flag; renderPanel(); return true; }
  if (d.flagSave) { flagPiece(d.flagSave); return true; }
  if (d.unflag) { closeCard(); store.patch(d.unflag, { flag: null }).catch((e) => toast(storeError(e))); return true; }
  if (d.del) { closeCard(); ui.deleteFor = d.del; renderPanel(); return true; }
  if (d.delConfirm) {
    const id = d.delConfirm, name = store.get(id)?.name ?? 'Piece';
    closeCard();
    if (id === current.id) setCurrent({ id: null, name: current.name, saved: '' });
    store.remove(id).then(() => toast(`Deleted "${name}"`), (e) => toast(storeError(e)));
    return true;
  }
  return false;
}

function renamePiece(id: string) {
  const name = (document.getElementById('rename-input') as HTMLInputElement).value.trim() || 'Untitled';
  ui.renameFor = null;
  if (id === current.id) setCurrent({ ...current, name });
  store.patch(id, { name }).catch((e) => toast(storeError(e)));
}

async function flagPiece(id: string) {
  const kernels: ('sdf' | 'mesh')[] = [];
  if ((document.getElementById('flag-sdf') as HTMLInputElement).checked) kernels.push('sdf');
  if ((document.getElementById('flag-mesh') as HTMLInputElement).checked) kernels.push('mesh');
  const note = (document.getElementById('flag-note') as HTMLTextAreaElement).value.trim();
  ui.flagFor = null;
  // flagging the open piece saves it first, so the flag describes what's on screen
  if (id === current.id && isDirty() && !(await savePiece())) return;
  const p = store.get(id);
  const flag: PieceFlag = { kernels, note, view: id === current.id ? viewState() : p?.view ?? null, at: Date.now() };
  try { await store.patch(id, { flag }); toast('Flagged. Claude can now open this piece.'); }
  catch (e) { toast(storeError(e)); }
}

partStore.onChange = () => { if (ui.tab === 'add' && !ui.showGallery && !document.activeElement?.closest('.piece-form')) renderPanel(); };

/** Browser storage doesn't always survive a reload, so a fresh start reopens the most recently saved piece. */
let reopenChecked = false;
function reopenLatest() {
  if (reopenChecked || store.kind !== 'cloud') return;
  reopenChecked = true;
  const latest = store.list()[0];
  // only when this browser kept nothing and nothing has been touched yet
  if (latest && !restoredDoc && !past.length && !isDirty() && !current.id) {
    loadDoc(latest.doc, { id: latest.id, name: latest.name }, latest.view);
  }
}

// a change left unsaved last time (this browser kept it) is saved again soon
if (isDirty()) scheduleAutosave();

store.onChange = () => {
  reopenLatest();
  if (current.id && !store.get(current.id) && store.kind === 'cloud') setCurrent({ ...current, id: null, saved: '' });
  renderTopbar();
  if (ui.showGallery && !document.activeElement?.closest('.piece-form')) renderPanel();
};

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
sync(false);

// test hook (used by the Playwright checks)
(window as unknown as { __clay: unknown }).__clay = {
  view,
  get doc() { return doc; },
  /** for scripts/example-thumbs.mjs */
  loadExample,
  openDoc: (d: SceneDoc, v: ViewState | null = null) => loadDoc(d, { id: null, name: 'test' }, v),
  exampleIds: () => exampleList.map((e) => e.id),
  setKernel: (k: SceneDoc['kernel']) => { if (doc.kernel !== k) update((d) => { d.kernel = k; }); },
  busy: () => busy || !!document.querySelector('.chip.busy'),
  project(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(view.camera);
    const r = view.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
};
