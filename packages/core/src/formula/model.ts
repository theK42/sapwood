// Packs, sheets and row/column axes with stable IDs.
//
// An Axis is the ordered list of row (or column) IDs of a sheet. Deleted IDs stay in
// the list as tombstones: a single-cell reference to one renders and evaluates as
// #REF!, a range whose corner was deleted still spans the same stretch of rows, and
// a revert that restores the row brings every formula back without rewriting text.

export type PackId = string;
export type SheetId = string;
export type RowId = string;
export type ColId = string;

export class Axis {
  private ids: string[] = [];
  private dead = new Set<string>();
  private counter = 0;
  private readonly prefix: string;
  private readonly salt: () => string;
  // Caches, rebuilt lazily after any structural change.
  private dirty = true;
  private live: string[] = [];
  private livePos = new Map<string, number>(); // id -> 1-based live position
  private fullIdx = new Map<string, number>(); // id -> index in `ids`
  private liveBefore: number[] = []; // liveBefore[i] = live ids at full index < i

  /**
   * `salt` goes into every new ID. Writers that may run concurrently (two tasks on one
   * branch) must use different salts, so the rows they insert never share an ID.
   */
  constructor(prefix: string, salt: () => string = () => "") {
    this.prefix = prefix;
    this.salt = salt;
  }

  private fresh(): string {
    this.rebuild();
    for (;;) {
      const id = `${this.prefix}${this.salt()}${++this.counter}`;
      if (!this.fullIdx.has(id)) return id;
    }
  }

  /** New IDs that aren't on this axis yet, without placing them. */
  freshIds(count: number): string[] {
    return Array.from({ length: count }, () => this.fresh());
  }

  /** Every ID in order, tombstones included. */
  order(): readonly string[] {
    return this.ids;
  }

  has(id: string): boolean {
    this.rebuild();
    return this.fullIdx.has(id);
  }

  // ---- by ID, for ops (see insertAfter / moveAfter below for the order rules)

  insertIds(after: string | null, ids: readonly string[]): void {
    insertAfter(this.ids, after, ids);
    this.dirty = true;
  }

  /** Remove IDs entirely (undoing an insert). */
  purgeIds(ids: readonly string[]): void {
    const gone = new Set(ids);
    this.ids = this.ids.filter((id) => !gone.has(id));
    for (const id of ids) this.dead.delete(id);
    this.dirty = true;
  }

  /** Tombstone IDs. */
  killIds(ids: readonly string[]): void {
    for (const id of ids) this.dead.add(id);
    this.dirty = true;
  }

  moveIds(after: string | null, ids: readonly string[]): void {
    moveAfter(this.ids, after, ids);
    this.dirty = true;
  }

  private rebuild(): void {
    if (!this.dirty) return;
    this.live = [];
    this.livePos.clear();
    this.fullIdx.clear();
    this.liveBefore = new Array<number>(this.ids.length + 1);
    let n = 0;
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i]!;
      this.liveBefore[i] = n;
      this.fullIdx.set(id, i);
      if (!this.dead.has(id)) {
        this.live.push(id);
        this.livePos.set(id, ++n);
      }
    }
    this.liveBefore[this.ids.length] = n;
    this.dirty = false;
  }

  get length(): number {
    this.rebuild();
    return this.live.length;
  }

  /** Live IDs in order. */
  liveIds(): readonly string[] {
    this.rebuild();
    return this.live;
  }

  /** ID at a 1-based live position. Grids are unbounded, so positions past the end are materialised. */
  idAt(pos: number): string {
    this.rebuild();
    // Appending is the common case (loading, typing below the data): extend the caches in place.
    for (let n = this.live.length; n < pos; n++) {
      const id = this.fresh();
      this.fullIdx.set(id, this.ids.length);
      this.ids.push(id);
      this.live.push(id);
      this.livePos.set(id, this.live.length);
      this.liveBefore.push(this.live.length);
    }
    return this.live[pos - 1]!;
  }

  /** 1-based live position, or null for a tombstone / unknown ID. */
  posOf(id: string): number | null {
    this.rebuild();
    return this.livePos.get(id) ?? null;
  }

  isDead(id: string): boolean {
    return this.dead.has(id);
  }

  /** Insert `count` new IDs before live position `pos`. Returns the new IDs. */
  insert(pos: number, count: number): string[] {
    this.rebuild();
    if (pos - 1 > this.live.length) this.idAt(pos - 1);
    this.rebuild();
    const at = pos > this.live.length ? this.ids.length : this.fullIdx.get(this.live[pos - 1]!)!;
    const fresh = Array.from({ length: count }, () => this.fresh());
    this.ids.splice(at, 0, ...fresh);
    this.dirty = true;
    return fresh;
  }

  /** Tombstone `count` live IDs starting at live position `pos`. Returns the deleted IDs. */
  delete(pos: number, count: number): string[] {
    this.rebuild();
    const gone = this.live.slice(pos - 1, pos - 1 + count);
    for (const id of gone) this.dead.add(id);
    this.dirty = true;
    return gone;
  }

  /** Undo a delete (what a revert task does). */
  restore(ids: readonly string[]): void {
    for (const id of ids) this.dead.delete(id);
    this.dirty = true;
  }

  /** Move `count` live IDs at `pos` so they start at live position `to` (positions after removal). */
  move(pos: number, count: number, to: number): void {
    this.rebuild();
    const moving = this.live.slice(pos - 1, pos - 1 + count);
    const set = new Set(moving);
    this.ids = this.ids.filter((id) => !set.has(id));
    this.dirty = true;
    this.rebuild();
    const at = to > this.live.length ? this.ids.length : this.fullIdx.get(this.live[to - 1]!)!;
    this.ids.splice(at, 0, ...moving);
    this.dirty = true;
  }

  /**
   * Live positions covered by the span between two corner IDs (either may be a
   * tombstone). Returns null if the span holds no live IDs.
   */
  span(a: string, b: string): { from: number; to: number } | null {
    this.rebuild();
    const ia = this.fullIdx.get(a);
    const ib = this.fullIdx.get(b);
    if (ia === undefined || ib === undefined) return null;
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    const from = this.liveBefore[lo]! + 1;
    const to = this.liveBefore[hi + 1]!;
    return to >= from ? { from, to } : null;
  }
}

/** Index of `after` in a full order; -1 means "at the start". */
export function anchorIndex(ord: readonly string[], after: string | null): number {
  if (after === null) return -1;
  const i = ord.indexOf(after);
  if (i < 0) throw new Error(`no anchor ${after}`);
  return i;
}

/** Insert `ids` right after `after` (null: at the start), in order. */
export function insertAfter(ord: string[], after: string | null, ids: readonly string[]): void {
  ord.splice(anchorIndex(ord, after) + 1, 0, ...ids);
}

/** Take `ids` out and put them right after `after`, in the order given. */
export function moveAfter(ord: string[], after: string | null, ids: readonly string[]): void {
  ids.forEach((id, j) => {
    ord.splice(ord.indexOf(id), 1);
    ord.splice(anchorIndex(ord, after) + 1 + j, 0, id);
  });
}

export interface Pack {
  id: PackId;
  name: string;
  parent: PackId | null;
}

/** DESIGN §6.1: data sheets have bound rows (column A type, column B ID); scratch sheets don't. */
export type SheetKind = "data" | "scratch";

export interface Sheet {
  id: SheetId;
  name: string;
  pack: PackId;
  kind: SheetKind;
  rows: Axis;
  cols: Axis;
}

export class Workbook {
  readonly packs = new Map<PackId, Pack>();
  readonly sheets = new Map<SheetId, Sheet>();
  private sheetCounter = 0;
  /** Goes into new row, column and sheet IDs; see Axis. */
  idSalt = "";

  constructor(rootName = "root") {
    this.packs.set(rootName, { id: rootName, name: rootName, parent: null });
  }

  get root(): PackId {
    for (const p of this.packs.values()) if (p.parent === null) return p.id;
    throw new Error("no root pack");
  }

  /** A pack's ID is stable; renaming it changes only its name. The ID defaults to the name. */
  addPack(name: string, parent: PackId, id: PackId = name): PackId {
    if (this.packs.has(id)) throw new Error(`pack ${id} exists`);
    if (this.packByName(name)) throw new Error(`a pack is already called ${name}`);
    if (!this.packs.has(parent)) throw new Error(`no pack ${parent}`);
    this.packs.set(id, { id, name, parent });
    return id;
  }

  packByName(name: string): Pack | undefined {
    for (const p of this.packs.values()) if (p.name === name) return p;
    return undefined;
  }

  packName(id: PackId): string {
    return this.packs.get(id)?.name ?? id;
  }

  /** A sheet ID that isn't taken. */
  freshSheetId(): SheetId {
    for (;;) {
      const id = `s${this.idSalt}${++this.sheetCounter}`;
      if (!this.sheets.has(id)) return id;
    }
  }

  addSheet(name: string, pack: PackId = this.root, kind: SheetKind = "data", id: SheetId = this.freshSheetId()): SheetId {
    if (this.findSheet(pack, name)) throw new Error(`sheet ${name} exists in ${pack}`);
    if (this.sheets.has(id)) throw new Error(`sheet ${id} exists`);
    const salt = () => this.idSalt;
    this.sheets.set(id, { id, name, pack, kind, rows: new Axis(`${id}r`, salt), cols: new Axis(`${id}c`, salt) });
    return id;
  }

  sheet(id: SheetId): Sheet {
    const s = this.sheets.get(id);
    if (!s) throw new Error(`no sheet ${id}`);
    return s;
  }

  findSheet(pack: PackId, name: string): Sheet | undefined {
    const lower = name.toLowerCase();
    for (const s of this.sheets.values()) if (s.pack === pack && s.name.toLowerCase() === lower) return s;
    return undefined;
  }

  /** The pack itself, then its parent, up to root. */
  ancestors(pack: PackId): PackId[] {
    const out: PackId[] = [];
    for (let p: PackId | null = pack; p !== null; p = this.packs.get(p)?.parent ?? null) out.push(p);
    return out;
  }

  /** The formula/ref reach rule: own pack or an ancestor. */
  canReach(from: PackId, to: PackId): boolean {
    return this.ancestors(from).includes(to);
  }

  /** Resolve a sheet name as written in a formula hosted in `hostPack`. `pack` is a pack name. */
  resolveSheet(hostPack: PackId, pack: string | null, name: string): Sheet | undefined {
    if (pack !== null) {
      const p = this.packByName(pack);
      return p && this.findSheet(p.id, name);
    }
    for (const p of this.ancestors(hostPack)) {
      const s = this.findSheet(p, name);
      if (s) return s;
    }
    return undefined;
  }
}
