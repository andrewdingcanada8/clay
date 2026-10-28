// Saved pieces. In the published artifact they live in the artifact's database
// (collection `pieces`), so they survive across devices and Claude can read them,
// including the ones flagged as problems. Anywhere the database isn't available
// (local dev, the bench, signed out) they fall back to this browser's storage.

import { type PartDef, type Quality, type SceneDoc, normalizeDoc } from '../engine/document';

export type Vec3 = [number, number, number];

/** What the viewer was looking at, so a problem can be reproduced exactly. */
export interface ViewState {
  kernel: SceneDoc['kernel'];
  meshMethod: SceneDoc['meshMethod'];
  quality: Quality;
  section: { on: boolean; axis: 'x' | 'y' | 'z'; t: number };
  camera: { pos: Vec3; target: Vec3 };
}

export interface PieceFlag {
  /** Which kernels look wrong. */
  kernels: ('sdf' | 'mesh')[];
  note: string;
  /** View at the time of flagging (or of the last save, when flagged from the gallery). */
  view: ViewState | null;
  at: number;
}

export interface Piece {
  id: string;
  name: string;
  doc: SceneDoc;
  thumb: string;
  view: ViewState | null;
  createdAt: number;
  updatedAt: number;
  flag: PieceFlag | null;
}

/** A part in the library (available to every piece). */
export interface LibraryPart extends PartDef {
  createdAt: number;
  updatedAt: number;
}

interface DocRef { set(d: Record<string, unknown>): Promise<void>; update(d: Record<string, unknown>): Promise<void>; delete(): Promise<void> }
interface DbLike {
  collection(p: string): {
    doc(id: string): DocRef;
    onSnapshot(next: (s: { docs: { id: string; data(): Record<string, unknown> | undefined }[] }) => void, err?: (e: { code: string }) => void): () => void;
  };
}

function pieceFromRow(id: string, d: Record<string, unknown>): Piece | null {
  try {
    return {
      id,
      name: String(d.name ?? 'Untitled'),
      doc: normalizeDoc(d.doc as SceneDoc),
      thumb: typeof d.thumb === 'string' ? d.thumb : '',
      view: (d.view as ViewState) ?? null,
      createdAt: Number(d.createdAt ?? 0),
      updatedAt: Number(d.updatedAt ?? 0),
      flag: (d.flag as PieceFlag) ?? null,
    };
  } catch {
    return null; // a row this version can't read
  }
}

function partFromRow(id: string, d: Record<string, unknown>): LibraryPart | null {
  if (!Array.isArray(d.objects)) return null;
  return { ...(d as unknown as LibraryPart), id, name: String(d.name ?? 'Part'), createdAt: Number(d.createdAt ?? 0), updatedAt: Number(d.updatedAt ?? 0) };
}

const toRow = (p: { id: string }): Record<string, unknown> => JSON.parse(JSON.stringify({ ...p, id: undefined }));

/** Rows of one collection, in the artifact database or (fallback) this browser. */
class RowStore<T extends { id: string; updatedAt: number }> {
  /** 'cloud' once the artifact database answers; 'local' until then (or for good). */
  kind: 'cloud' | 'local' = 'local';
  private pieces = new Map<string, T>();
  private db: DbLike | null = null;
  onChange: () => void = () => {};

  constructor(private collection: string, private localKey: string, private fromRow: (id: string, d: Record<string, unknown>) => T | null) {
    this.readLocal();
    this.connect();
  }

  list(): T[] {
    return [...this.pieces.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string | null | undefined): T | null {
    return id ? this.pieces.get(id) ?? null : null;
  }

  async put(p: T): Promise<void> {
    this.pieces.set(p.id, p);
    this.onChange();
    if (this.db) await this.db.collection(this.collection).doc(p.id).set(toRow(p));
    else this.writeLocal();
  }

  async patch(id: string, fields: Partial<Omit<T, 'id'>>): Promise<void> {
    const p = this.pieces.get(id);
    if (!p) return;
    Object.assign(p, fields);
    this.onChange();
    if (this.db) await this.db.collection(this.collection).doc(id).set(toRow(p));
    else this.writeLocal();
  }

  async remove(id: string): Promise<void> {
    this.pieces.delete(id);
    this.onChange();
    if (this.db) await this.db.collection(this.collection).doc(id).delete();
    else this.writeLocal();
  }

  private async connect() {
    const claude = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
    if (!claude?.use) return;
    let db: DbLike | null = null;
    try { db = (await claude.use('db')) as DbLike | null; } catch { db = null; }
    if (!db) return;
    db.collection(this.collection).onSnapshot((snap) => {
      const first = !this.db;
      this.db = db;
      this.kind = 'cloud';
      const next = new Map<string, T>();
      for (const d of snap.docs) {
        const row = d.data();
        const p = row && this.fromRow(d.id, row);
        if (p) next.set(p.id, p);
      }
      // pieces saved in this browser before the database was reachable move over
      // once; the local copy goes only after every one of them is stored
      if (first) {
        const moving = [...this.pieces.values()].filter((p) => !next.has(p.id));
        for (const p of moving) next.set(p.id, p);
        Promise.all(moving.map((p) => db!.collection(this.collection).doc(p.id).set(toRow(p))))
          .then(() => this.clearLocal(), () => { /* keep the local copy; retried next load */ });
      }
      this.pieces = next;
      this.onChange();
    }, () => { this.db = null; this.kind = 'local'; this.onChange(); });
  }

  private readLocal() {
    try {
      const rows = JSON.parse(localStorage.getItem(this.localKey) ?? '[]') as (Record<string, unknown> & { id: string })[];
      for (const r of rows) { const p = this.fromRow(r.id, r); if (p) this.pieces.set(p.id, p); }
    } catch { /* storage unavailable */ }
  }

  private writeLocal() {
    try { localStorage.setItem(this.localKey, JSON.stringify(this.list())); } catch { /* storage full or unavailable */ }
  }

  private clearLocal() {
    try { localStorage.removeItem(this.localKey); } catch { /* storage unavailable */ }
  }
}

export class PieceStore extends RowStore<Piece> {
  constructor() { super('pieces', 'clay.pieces.v1', pieceFromRow); }
}

export class PartStore extends RowStore<LibraryPart> {
  constructor() { super('parts', 'clay.parts.v1', partFromRow); }
}
