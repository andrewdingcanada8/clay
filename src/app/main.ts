import './styles.css';
import * as THREE from 'three';
import {
  type ObjectMode, type PrimitiveType, type Quality, type SceneDoc, type SceneObject,
  TYPE_LABEL, cloneDoc, emptyDoc, makeObject, newId, normalizeDoc,
} from '../engine/document';
import type { BuildResult } from '../engine/kernel';
import type { CavityGrid } from '../engine/cavity';
import { DEFAULT_WALL, type Group } from '../engine/document';
import type { Vec3 } from '../engine/math';
import { classifyPoint, compileScene, sdfWorld, toLocal } from '../engine/primitives';
import { compileGroups } from '../engine/scene';
import { examples } from '../examples';
import { Builder } from './builder';
import { ProfileEditor } from './profileEditor';
import { HAND_LENGTH_CM } from './hand';
import { type LibraryPart, PartStore, type Piece, type PieceFlag, PieceStore, type ViewState } from './pieces';
import { expandParts, makePartDef, partScale, placedId } from '../engine/parts';
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
  hand: boolean;
  lockScale: boolean;
  profileEditing: string | null;
  profilePoint: number;
  showGallery: boolean;
  galleryTab: 'mine' | 'examples';
  /** gallery card states (piece id): open ⋯ menu, renaming, flagging, confirming delete */
  menuFor: string | null;
  renameFor: string | null;
  flagFor: string | null;
  deleteFor: string | null;
  /** waiting on "save or discard" before opening another piece or starting a new one */
  pending: { open: string } | { example: string } | 'new' | null;
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
  tab: 'edit', sheetOpen: true, selectedId: doc.objects[0]?.id ?? null, gizmo: 'translate', holeMode: 'face', pinRadius: 0.5,
  quality: 'normal', section: { on: false, axis: 'z', t: 0.5 }, wire: false, hand: true, lockScale: false,
  profileEditing: null, profilePoint: -1, showGallery: false, galleryTab: 'mine',
  menuFor: null, renameFor: null, flagFor: null, deleteFor: null, pending: null,
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

/** Apply a change. interactive = still dragging (draft build, no history entry). */
function update(mut: (d: SceneDoc) => void, interactive = false) {
  const next = cloneDoc(doc);
  mut(next);
  doc = next;
  if (!interactive) commit();
  const sel = selected();
  if (sel) view.syncGhost(sel);
  sync(interactive);
}

// ---------- display / builds
// Everything is built and drawn from the expanded document: each placed part
// becomes its own group (see engine/parts). Group indices below refer to it.
function cavityKey(r: SceneDoc, gi: number): string {
  const g = r.groups[gi];
  const shells = r.objects.filter((o) => o.groupId === g.id && o.mode === 'shell' && !o.hidden);
  return JSON.stringify([ui.quality, g.blend ?? 0, shells.map((o) => [o.type, o.params, o.transform, o.holes])]);
}

function currentGrids(r: SceneDoc): (CavityGrid | null)[] {
  return r.groups.map((g, i) => {
    const c = gridCache[i];
    return c && c.key === cavityKey(r, i) && g.thickness <= c.grid.tMax ? c.grid : null;
  });
}

function applyGrids() {
  if (doc.kernel === 'sdf') view.setSdfGrids(currentGrids(expandParts(doc)));
}

/** Bring the display in line with the document. While a drag is in progress
 *  (interactive) only cheap display updates run; worker builds wait for release. */
function sync(interactive: boolean) {
  const r = expandParts(doc);
  view.partDefs = doc.parts ?? [];
  if (doc.kernel === 'mesh') {
    view.setMode('mesh');
    if (!interactive) builder.request('mesh', r, ui.quality);
    return;
  }
  // SDF: the GPU draws the document straight away; only stale cavity grids rebuild.
  view.setMode('sdf');
  view.setSdfDoc(r);
  const grids = currentGrids(r);
  view.setSdfGrids(grids);
  const missing: number[] = [];
  const keys: Record<number, string> = {};
  r.groups.forEach((g, i) => {
    const hollow = r.shell.enabled && r.objects.some((o) => o.groupId === g.id && o.mode === 'shell' && !o.hidden);
    if (hollow && !grids[i]) { missing.push(i); keys[i] = cavityKey(r, i); }
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
}

function restore(s: string) {
  doc = normalizeDoc(JSON.parse(s));
  committed = s;
  save(doc);
  if (!selected()) ui.selectedId = doc.objects[0]?.id ?? null;
  refreshGhost();
  sync(false);
  renderAll();
}

function refreshGhost() {
  view.setGhost(ui.tab === 'edit' || ui.tab === 'add' ? selected() : selected() && ui.tab === 'holes' ? selected() : null,
    ui.tab === 'edit' ? ui.gizmo : 'off');
}

// ---------- rendering
function renderTopbar() {
  document.getElementById('piece-name')!.textContent = current.name + (isDirty() ? ' •' : '');
  (document.getElementById('btn-undo') as HTMLButtonElement).disabled = !past.length;
  (document.getElementById('btn-redo') as HTMLButtonElement).disabled = !future.length;
}

function renderStatus() {
  const chips: string[] = [];
  const s = doc.kernel === 'mesh' ? lastResult?.stats : undefined;
  if (doc.kernel === 'sdf') {
    const hollow = doc.groups.some((g) => doc.shell.enabled && doc.objects.some((o) => o.groupId === g.id && o.mode === 'shell'));
    const exact = currentGrids(expandParts(doc)).some(Boolean) || !hollow;
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
  if (doc.shell.enabled && doc.groups.length === 1) chips.push(`<span class="chip">wall ${doc.groups[0].thickness.toFixed(2)} cm</span>`);
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
    <p class="hint">New forms join the piece at the centre. Revolve opens the profile editor: draw half the silhouette and it spins 360° around the axis.</p></div>
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
      <small>${p.objects.length} object${p.objects.length === 1 ? '' : 's'}${p.hollow ? ` · ${p.thickness.toFixed(2)} cm wall` : ' · solid'}</small></div>${extra}</div>`;
  };
  return `<div class="section"><h3>Your parts</h3>
    ${list.length ? `<div class="pieces">${list.map(card).join('')}</div>` : '<p class="hint">No parts yet. In the Shell tab, use "Save as part" on a group to reuse it in any piece.</p>'}
    ${list.length ? '<p class="hint">Tap a part to add it. A part is finished geometry: its own hollow, openings and subtractions stay inside it.</p>' : ''}</div>`;
}

function partEditBody(o: SceneObject) {
  const t = o.transform;
  const def = (doc.parts ?? []).find((d) => d.id === o.params.part);
  return `
    <div class="section"><h3>Part · ${escapeHtml(def?.name ?? 'missing')}</h3>
      ${seg<ObjectMode>('mode', o.mode === 'subtract' ? 'subtract' : 'solid', [['solid', 'Finished'], ['subtract', 'Cut']])}
      <p class="hint">${o.mode === 'subtract' ? 'Its outer shape is carved from the group it sits in.' : 'Placed as finished geometry: its own hollow and subtractions stay inside it, and nothing else cuts it.'}</p>
      ${doc.groups.length > 1 && o.mode === 'subtract' ? `<div class="row">${doc.groups.map((g) => `<button class="face-chip" data-move-group="${g.id}" aria-pressed="${g.id === o.groupId}">${escapeHtml(g.name)}</button>`).join('')}</div>` : ''}
      <div class="row"><button class="btn" data-act="unpack-part">Unpack into a group</button></div>
      <p class="hint">Unpacking turns it back into editable objects in a new group of this piece.</p>
    </div>
    <div class="section"><h3>Transform</h3>
      ${seg<GizmoMode>('gizmo', ui.gizmo, [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale'], ['off', 'Hide']])}
      ${xyz('position', 'Position', t.position, 0.1)}
      ${xyz('rotation', 'Rotation°', t.rotation, 1)}
      ${slider('tf.uscale', 'Size ×', +partScale(t).toFixed(3), 0.1, Math.max(4, Math.ceil(partScale(t) * 1.5)), 0.01)}
      <p class="hint">Parts scale evenly; the wall scales with them.</p>
    </div>
    <div class="row"><button class="btn" data-act="duplicate">Duplicate</button><button class="btn danger" data-act="delete">Delete</button></div>`;
}

async function savePart(groupId: string) {
  const name = ((document.getElementById('part-name') as HTMLInputElement | null)?.value.trim()) || 'Part';
  ui.partNaming = null;
  const r = expandParts(doc);
  const g = compileGroups(r).find((x) => x.id === groupId);
  if (!g) { toast('This group has nothing to save yet'); renderPanel(); return; }
  const def = makePartDef(doc, groupId, name, g.bounds);
  def.thumb = view.snapshot();
  const now = Date.now();
  try { await partStore.put({ ...def, createdAt: now, updatedAt: now }); toast(`Saved part "${name}". Add it from the Add tab.`); }
  catch (e) { toast(storeError(e)); }
  renderPanel();
}

function addPart(id: string) {
  const lib = partStore.get(id);
  if (!lib) return;
  const { createdAt: _c, updatedAt: _u, ...def } = lib;
  const o = makeObject('part', { params: { part: def.id }, mode: 'solid', name: def.name, groupId: selected()?.groupId ?? doc.groups[0].id });
  update((d) => {
    d.parts = d.parts ?? [];
    if (!d.parts.some((x) => x.id === def.id)) d.parts.push(JSON.parse(JSON.stringify({ ...def, thumb: undefined })));
    d.objects.push(o);
  });
  ui.selectedId = o.id;
  ui.tab = 'edit';
  refreshGhost();
  renderPanel();
}

/** Replace a placed part by its objects, as a new group of this piece. */
function unpackPart(o: SceneObject) {
  const x = expandParts({ ...doc, objects: [o], pins: [], groups: doc.groups.map((g) => ({ ...g })) });
  const fresh = new Map<string, string>();
  const idFor = (old: string) => { if (!fresh.has(old)) fresh.set(old, newId(old.endsWith('~g') ? 'g' : 'o')); return fresh.get(old)!; };
  const newGroups = x.groups.filter((g) => !doc.groups.some((dg) => dg.id === g.id)).map((g) => ({ ...g, id: idFor(g.id) }));
  const objs = x.objects.map((c) => ({ ...c, id: idFor(c.id), groupId: fresh.get(c.groupId) ?? c.groupId }));
  const pins = x.pins.map((p) => ({ ...p, id: newId('p'), objectId: fresh.get(p.objectId) ?? p.objectId }));
  update((d) => {
    d.objects = d.objects.filter((y) => y.id !== o.id).concat(objs);
    d.groups.push(...newGroups);
    d.pins.push(...pins);
    // drop definitions nothing uses any more
    const used = new Set(d.objects.filter((y) => y.type === 'part').map((y) => y.params.part));
    d.parts = (d.parts ?? []).filter((p) => used.has(p.id));
  });
  ui.selectedId = objs[0]?.id ?? null;
  toast(newGroups.length ? `Unpacked into "${newGroups[0].name}"` : 'Unpacked');
  refreshGhost();
  renderAll();
}

function editPanel() {
  const o = selected();
  let body = '';
  if (o) {
    const t = o.transform;
    if (o.type === 'part') body = partEditBody(o);
    else body = `
    <div class="section"><h3>${TYPE_LABEL[o.type]} · role in its group</h3>
      ${seg<ObjectMode>('mode', o.mode, [['shell', 'Shell'], ['solid', 'Solid'], ['subtract', 'Subtract']])}
      <p class="hint">${o.mode === 'shell' ? 'Forms the hollow body. The cavity grows inward from the outside of all Shell objects in the group.' : o.mode === 'solid' ? 'Never hollowed itself, but cut where the group\'s cavity passes through it.' : 'Carved out of its group together with the cavity. No wall forms around it.'}</p>
      ${doc.groups.length > 1 ? `<div class="row">${doc.groups.map((g) => `<button class="face-chip" data-move-group="${g.id}" aria-pressed="${g.id === o.groupId}">${escapeHtml(g.name)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="section"><h3>Shape</h3>
      ${PARAMS[o.type].map(([k, l, mn, mx, st]) => slider(`p.${k}`, l, (o.params as Record<string, number>)[k] ?? (k === 'r2' ? o.params.r! : 0), mn, mx, st)).join('')}
      ${o.type === 'revolve' ? `<button class="btn primary" data-act="edit-profile">Edit profile (${o.params.points?.length ?? 0} points)</button>` : ''}
    </div>
    <div class="section"><h3>Transform</h3>
      ${seg<GizmoMode>('gizmo', ui.gizmo, [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale'], ['off', 'Hide']])}
      ${xyz('position', 'Position', t.position, 0.1)}
      ${xyz('rotation', 'Rotation°', t.rotation, 1)}
      ${xyz('scale', 'Scale', t.scale, 0.01, true)}
      <p class="hint">Scale runs along the object's own axes. Turn on ⛓ uniform to scale all three together.</p>
    </div>
    <div class="row"><button class="btn" data-act="duplicate">Duplicate</button><button class="btn danger" data-act="delete">Delete</button></div>`;
  } else body = '<p class="hint">Tap the model, or pick an object below, to edit it.</p>';
  return `<div class="section"><h3>Objects</h3>${objectChips()}</div>${body}`;
}

function shellPanel() {
  const holes = doc.objects.flatMap((o) => o.holes.map((h) => ({ o, h })));
  const groupRows = doc.groups.map((g: Group, i) => {
    const members = doc.objects.filter((o) => o.groupId === g.id);
    const count = (m: ObjectMode) => members.filter((o) => o.mode === m).length;
    return `<div class="section group-card">
      <div class="row"><input class="group-name" id="gname-${g.id}" data-group-name="${g.id}" value="${escapeHtml(g.name)}" aria-label="Group name">
        ${doc.groups.length > 1 ? `<button class="btn danger" data-del-group="${g.id}" aria-label="Delete group">Delete</button>` : ''}</div>
      ${slider(`wall.${i}`, 'Wall cm', g.thickness, 0.05, 4, 0.01)}
      ${slider(`blend.${i}`, 'Blend cm', g.blend ?? 0, 0, 10, 0.1)}
      <p class="hint">${count('shell')} shell · ${count('solid')} solid · ${count('subtract')} subtract</p>
      ${ui.partNaming === g.id
        ? `<div class="piece-form"><label class="field-col"><span>Part name</span><input id="part-name" value="${escapeHtml(g.name)}" maxlength="80"></label>
           <div class="row"><button class="btn primary" data-save-part="${g.id}">Save part</button><button class="btn" data-part-cancel="1">Cancel</button></div></div>`
        : members.length ? `<div class="row"><button class="btn" data-name-part="${g.id}">Save as part</button></div>` : ''}
    </div>`;
  }).join('');
  return `<div class="section"><h3>Hollowing</h3>
      <label class="toggle"><input type="checkbox" id="shell-on" data-act="shell-toggle" ${doc.shell.enabled ? 'checked' : ''}> Hollow Shell objects</label>
      <p class="hint">In each group, walls grow inward from the outside of the Shell objects. The cavity and any Subtract objects are carved from the whole group, Solid objects included. Groups never cut each other.</p>
    </div>
    ${groupRows}
    <div class="row"><button class="btn" data-act="add-group">Add group</button></div>
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
      ...((r) => currentGrids(r).map((c, i) => c ? `${r.groups[i].name}: cavity grid ${c.dims.join('×')}, ${c.h.toFixed(2)} cm texels` : ''))(expandParts(doc)),
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
    <div class="row"><button class="btn danger" data-act="new">New empty scene</button></div>`;
}

function examplesPanel() {
  return `<div class="examples">${exampleList.map((e) => `<button class="example" data-example="${e.id}"><b>${escapeHtml(e.title)}</b><small>${escapeHtml(e.notes)}</small></button>`).join('')}</div>`;
}

function renderProfilePanel() {
  const o = doc.objects.find((x) => x.id === ui.profileEditing);
  if (!o || o.type !== 'revolve') { ui.profileEditing = null; renderPanel(); return; }
  panel.innerHTML = `<div class="profile-wrap">
    <div class="row"><h3 style="margin:0 auto 0 0;font:600 11px var(--font-body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Profile of ${escapeHtml(o.name)}</h3>
      <button class="btn" data-act="profile-zoom-out" aria-label="Zoom out">−</button>
      <button class="btn" data-act="profile-fit">Fit</button>
      <button class="btn" data-act="profile-zoom-in" aria-label="Zoom in">+</button>
      <button class="btn primary" data-act="profile-done">Done</button></div>
    <canvas class="profile-canvas" id="profile-canvas"></canvas>
    <label class="field"><span>Smoothness</span>
      <input type="range" id="profile-smooth" min="0" max="1" step="0.01" value="1" ${ui.profilePoint < 0 ? 'disabled' : ''}></label>
    <div class="row">
      <button class="btn danger" data-act="profile-delete" ${ui.profilePoint < 0 ? 'disabled' : ''}>Delete point</button>
    </div>
    <p class="hint">Tap empty space to add a point, tap a point to select it. Drag near a point to move it, or anywhere else to move the selected one. Squares are sharp corners. Pinch or scroll to zoom, two fingers to pan. The curve spins a full 360° around the dashed axis.</p></div>`;
  const ed = new ProfileEditor(document.getElementById('profile-canvas') as HTMLCanvasElement, o.params.points ?? []);
  profileEditor = ed;
  const smooth = document.getElementById('profile-smooth') as HTMLInputElement;
  ed.onChange = (pts, done) => {
    // While dragging only the wireframe ghost follows; the shape rebuilds on release.
    if (!done) { view.setGhost({ ...o, params: { ...o.params, points: pts } }, 'off'); return; }
    update((d) => { d.objects.find((x) => x.id === o.id)!.params.points = pts; });
    view.setGhost(selected(), 'off');
  };
  ed.onSelect = (i) => {
    ui.profilePoint = i;
    smooth.disabled = i < 0;
    smooth.value = String(ed.smooth());
    panel.querySelectorAll<HTMLButtonElement>('[data-act="profile-delete"]').forEach((b) => { b.disabled = i < 0; });
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
  if (key.startsWith('wall.')) {
    const gi = Number(key.slice(5));
    return update((d) => { d.groups[gi].thickness = Math.max(0.02, v); }, interactive);
  }
  if (key.startsWith('blend.')) {
    const gi = Number(key.slice(6));
    return update((d) => { d.groups[gi].blend = Math.max(0, v); }, interactive);
  }
  if (key === 'pin') { ui.pinRadius = Math.max(0.02, v); return; }
  if (key === 'section') { ui.section.t = v; view.setSection(true, ui.section.axis, v); return; }
  const o = selected();
  if (!o) return;
  if (key.startsWith('p.')) {
    const k = key.slice(2);
    return update((d) => { (d.objects.find((x) => x.id === o.id)!.params as Record<string, number>)[k] = k === 'n' ? Math.round(v) : v; }, interactive);
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
  if (el.dataset.groupName) {
    const gid = el.dataset.groupName;
    update((d) => { d.groups.find((g) => g.id === gid)!.name = el.value.trim() || 'Group'; });
    return;
  }
  const act = el.dataset.act;
  if (act === 'shell-toggle') update((d) => { d.shell.enabled = el.checked; });
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
  if (d.add) return addObject(d.add as PrimitiveType);
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
  if (d.moveGroup) {
    update((doc2) => { doc2.objects.find((x) => x.id === ui.selectedId)!.groupId = d.moveGroup!; });
    renderPanel();
    return;
  }
  if (d.delGroup) {
    update((doc2) => {
      const keepId = doc2.groups.find((g) => g.id !== d.delGroup)!.id;
      doc2.groups = doc2.groups.filter((g) => g.id !== d.delGroup);
      for (const o of doc2.objects) if (o.groupId === d.delGroup) o.groupId = keepId;
    });
    renderPanel();
    return;
  }
  if (d.unpin) { update((doc2) => { doc2.pins = doc2.pins.filter((p) => p.id !== d.unpin); }); renderPanel(); return; }
  switch (d.act) {
    case 'lock': ui.lockScale = !ui.lockScale; btn.setAttribute('aria-pressed', String(ui.lockScale)); break;
    case 'unpack-part': { const o = selected(); if (o?.type === 'part') unpackPart(o); break; }
    case 'duplicate': {
      const o = selected();
      if (!o) break;
      const c: SceneObject = JSON.parse(JSON.stringify(o));
      c.id = newId();
      c.name = `${o.name} copy`;
      c.transform.position = [o.transform.position[0] + 4, o.transform.position[1], o.transform.position[2]];
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
    case 'profile-delete': profileEditor?.deleteSelected(); break;
    case 'profile-zoom-in': profileEditor?.zoomBy(1.4); break;
    case 'profile-zoom-out': profileEditor?.zoomBy(1 / 1.4); break;
    case 'profile-fit': profileEditor?.fit(); break;
    case 'close-gallery': ui.showGallery = false; ui.pending = null; renderPanel(); break;
    case 'new-piece': newPiece(); break;
    case 'save-piece': savePiece(); break;
    case 'pending-save': resolvePending('save'); break;
    case 'pending-discard': resolvePending('discard'); break;
    case 'pending-cancel': ui.pending = null; renderPanel(); break;
    case 'add-group': {
      const id = newId('g');
      update((doc2) => { doc2.groups.push({ id, name: `Group ${doc2.groups.length + 1}`, thickness: DEFAULT_WALL }); });
      toast('Group added. Move objects into it from the Edit tab.');
      renderPanel();
      break;
    }
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
    case 'quality': ui.quality = value as Quality; sync(false); break;
    case 'galleryTab': ui.galleryTab = value as 'mine' | 'examples'; closeCards(); break;
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
  const o = makeObject(type, { groupId: selected()?.groupId ?? doc.groups[0].id });
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

/** Examples open as a new, unsaved piece named after the example. */
async function loadExample(id: string) {
  const ex = exampleList.find((e) => e.id === id)!;
  if (needsConfirm()) { ui.pending = { example: id }; renderPanel(); return; }
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
  ui.pending = null;
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
  update((d) => {
    const tr = d.objects.find((x) => x.id === o.id)!.transform;
    Object.assign(tr, t);
    if (o.type === 'part') { const s = partScale(tr); tr.scale = [s, s, s]; }
  }, !done);
  if (done && ui.tab === 'edit') renderPanel();
};

// taps on the model: select, open a face, or drill a pin hole
view.onTap = (hit) => {
  if (!hit) {
    if (ui.tab === 'edit' && !ui.profileEditing) selectObject(null);
    return;
  }
  const objs = compileScene(expandParts(doc).objects);
  const p = hit.point;
  const c = classifyPoint(objs, p.x, p.y, p.z, ['shell', 'solid', 'subtract']);
  if (!c) return;
  const oid = placedId(c.obj.obj.id);
  if (oid !== c.obj.obj.id && ui.tab === 'holes') { toast('A part is finished geometry: its openings are set inside the part'); return; }
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
  if (ui.tab !== 'edit') ui.tab = 'edit';
  ui.sheetOpen = true;
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
async function savePiece(): Promise<boolean> {
  const now = Date.now();
  const existing = store.get(current.id);
  const p: Piece = existing
    ? { ...existing, doc: cloneDoc(doc), thumb: view.snapshot(), view: viewState(), updatedAt: now }
    : { id: newId('p'), name: current.id || current.name !== 'Untitled' ? current.name : `Piece ${store.list().length + 1}`, doc: cloneDoc(doc), thumb: view.snapshot(), view: viewState(), createdAt: now, updatedAt: now, flag: null };
  setCurrent({ id: p.id, name: p.name, saved: committed });
  try {
    await store.put(p);
    toast(`Saved "${p.name}"`);
    if (ui.showGallery) renderPanel();
    return true;
  } catch (e) {
    setCurrent({ ...current, saved: '' });
    toast(storeError(e));
    return false;
  }
}

/** Unsaved work that was never saved needs an answer before it's replaced. */
function needsConfirm() {
  return !current.id && isDirty();
}

async function leaveCurrent(): Promise<boolean> {
  if (current.id && isDirty()) return savePiece();
  return true;
}

async function openPiece(id: string) {
  const p = store.get(id);
  if (!p) return;
  if (needsConfirm()) { ui.pending = { open: id }; renderPanel(); return; }
  if (!(await leaveCurrent())) return;
  loadDoc(p.doc, { id: p.id, name: p.name }, p.view);
  toast(`Opened "${p.name}"`);
}

async function newPiece() {
  if (needsConfirm()) { ui.pending = 'new'; renderPanel(); return; }
  if (!(await leaveCurrent())) return;
  const d = emptyDoc();
  d.kernel = doc.kernel; d.meshMethod = doc.meshMethod;
  loadDoc(d, { id: null, name: 'Untitled' }, null);
  ui.tab = 'add';
  renderPanel();
}

async function resolvePending(how: 'save' | 'discard') {
  const p = ui.pending;
  ui.pending = null;
  if (how === 'save' && !(await savePiece())) return;
  if (how === 'discard') setCurrent({ ...current, saved: committed }); // nothing left to ask about
  if (p === 'new') newPiece();
  else if (p && 'open' in p) openPiece(p.open);
  else if (p) loadExample(p.example);
}

/** Replace the document wholesale (no undo across pieces) and restore its view. */
function loadDoc(d: SceneDoc, who: { id: string | null; name: string }, v: ViewState | null) {
  doc = normalizeDoc(cloneDoc(d));
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
  const pending = ui.pending
    ? `<div class="pending"><p>"${escapeHtml(current.name)}" has never been saved.</p>
       <div class="row"><button class="btn primary" data-act="pending-save">Save it</button><button class="btn danger" data-act="pending-discard">Discard</button><button class="btn" data-act="pending-cancel">Cancel</button></div></div>` : '';
  const saveLabel = current.id && !isDirty() ? 'Saved' : 'Save';
  const body = ui.galleryTab === 'examples'
    ? `<p class="hint">Benchmark scenes. Opening one replaces the open piece; save first if you want to keep it.</p>${examplesPanel()}`
    : pieces.length
      ? `<div class="pieces">${pieces.map(pieceCard).join('')}</div>`
      : '<p class="hint">No saved pieces yet. Save the open piece to start your gallery.</p>';
  return `<div class="section">
    <div class="row"><h3 style="margin-right:auto">Pieces</h3>
      <button class="btn" data-act="new-piece">New</button>
      <button class="btn primary" data-act="save-piece" ${saveLabel === 'Saved' ? 'disabled' : ''}>${saveLabel}</button>
      <button class="btn" data-act="close-gallery">Close</button></div>
    ${pending}
    ${seg<'mine' | 'examples'>('galleryTab', ui.galleryTab, [['mine', `My pieces (${pieces.length})`], ['examples', 'Examples']])}
    <p class="hint">${store.kind === 'cloud' ? 'Saved with this artifact, on any device you open it on. Claude can read flagged pieces.' : 'Saved in this browser only.'}</p>
    ${body}</div>`;
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

store.onChange = () => {
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
  project(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(view.camera);
    const r = view.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
};
