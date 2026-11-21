// Cells, the dependency graph and incremental recalculation.
//
// Dependencies are recorded dynamically while a formula evaluates, so ENTITY(),
// INDEX and anything else that decides at run time what it reads is tracked exactly.
//
// Recalc does not recurse. Stale cells are evaluated off a stack; when a formula
// reads precedents that are still stale, evaluation carries on with placeholders and
// collects them all; then it aborts (NotReady), the precedents are pushed, and the
// formula is retried after them. Collecting them all keeps a wide reader
// (SUM(ENTITIES(...)) over 80k rows) linear rather than one retry per precedent.
// A read of a precedent that is itself waiting further down the stack is a cycle. Long chains therefore cost no
// stack depth, and a good order is found without a separate topological sort.

import { bind, BindError, render, shift, type BoundPoint, type Expr } from "./bind.ts";
import type { Content } from "./content.ts";
import { callFunction, type Ctx } from "./functions.ts";
import type { ColId, PackId, RowId, SheetId, Workbook } from "./model.ts";
import { colToNumber, FormulaSyntaxError, parseFormula } from "./parse.ts";
import {
  type ArrayValue, type EntityValue, type Scalar, type Value,
  compare, err, FError, isEntity, isErr, scalar, toNumber, toText,
} from "./values.ts";

type Key = string;
const keyOf = (sheet: SheetId, row: RowId, col: ColId): Key => `${sheet}|${row}|${col}`;

interface RangeDep {
  owner: Key;
  sheet: SheetId;
  a: BoundPoint;
  b: BoundPoint;
}

type State = "fresh" | "stale" | "computing";

interface Cell {
  key: Key;
  sheet: SheetId;
  row: RowId;
  col: ColId;
  formula: Expr | null;
  invalidText: string | null; // formula text that failed to parse/bind
  value: Scalar;
  state: State;
  waiting: boolean;
  deps: Set<Key>;
  ranges: RangeDep[];
  ents: Set<string>;
  types: Set<string>;
  /** The value depends, directly or through other cells, on the entity index. */
  usesIndex: boolean;
}

interface EntityRec {
  id: string;
  type: string;
  sheet: SheetId;
  row: RowId;
}

class NotReady {
  readonly keys: Key[];
  constructor(keys: Key[]) {
    this.keys = keys;
  }
}

interface Collect {
  deps: Set<Key>;
  ranges: RangeDep[];
  ents: Set<string>;
  types: Set<string>;
  usesIndex: boolean;
}

interface EvalScope {
  owner: Key | null;
  hostSheet: SheetId | null;
  /** Pack whose reach applies; null for rules, which may read anything. */
  reachFrom: PackId | null;
  ruleEntity: string | null;
  collect: Collect | null;
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseInput(text: string): Scalar {
  if (text === "") return null;
  if (text.startsWith("'")) return text.slice(1);
  if (NUMBER_RE.test(text.trim())) return Number(text);
  const u = text.toUpperCase();
  if (u === "TRUE" || u === "FALSE") return u === "TRUE";
  return text;
}

export class Engine {
  readonly wb: Workbook;
  private cells = new Map<Key, Cell>();
  /** The same cells, column-major per sheet, for range reads. */
  private grid = new Map<SheetId, Map<ColId, Map<RowId, Cell>>>();
  private rangeCache = new Map<SheetId, Map<string, { v: ArrayValue; usesIndex: boolean }>>();
  private rangeUsesIndex = false;
  private dependents = new Map<Key, Set<Key>>();
  private rowCells = new Map<RowId, Set<Key>>();
  private colCells = new Map<ColId, Set<Key>>();
  // Range watchers: all of them per sheet, plus an index by column (or "*" for whole-row ranges).
  private sheetRanges = new Map<SheetId, Set<RangeDep>>();
  private rangeIndex = new Map<SheetId, Map<ColId | "*", Set<RangeDep>>>();
  private entWatch = new Map<string, Set<Key>>(); // lower-case entity ID -> formulas
  private typeWatch = new Map<string, Set<Key>>(); // type -> formulas using ENTITIES(type)
  private entities = new Map<string, EntityRec[]>(); // lower-case ID -> records
  private byType = new Map<string, string[]>(); // cache of typeIds()
  private typeRows = new Map<string, Set<RowId>>();
  private rowEnt = new Map<RowId, EntityRec>();
  /** sheet -> type -> field -> column; null for a field the sheet has no column for (reads as blank). */
  private layouts = new Map<SheetId, Map<string, Map<string, ColId | null>>>();
  private entitiesDirty = true;
  /** Duplicate IDs -> the row that won at the last rebuild (see rebuildEntities). */
  private dupWinner = new Map<string, string>();
  private dirtyEntityRows = new Map<RowId, SheetId>();

  private batchDepth = 0;
  private pending: Key[] = [];
  /** Stale precedents met during the current cell evaluation; null outside recalc. */
  private missing: Key[] | null = null;
  /** Cells written or recalculated since the last takeChanged(). */
  private changed = new Set<Key>();
  /** Formulas that called ROW() or COLUMN(). */
  private positional = new Set<Key>();
  private scope: EvalScope = { owner: null, hostSheet: null, reachFrom: null, ruleEntity: null, collect: null };

  /** Number of formula evaluations in the last recalc (retries included). */
  lastEvaluations = 0;

  /**
   * Which column-A names are entity types. With a schema, only known keyed types count,
   * so singleton headers, field rows and typos never enter the entity index. Without
   * one (the S1 tests), any name that isn't a comment or a field row counts.
   */
  private entityType: (name: string) => boolean = (name) => !name.startsWith("#") && !name.startsWith(".");

  constructor(wb: Workbook) {
    this.wb = wb;
  }

  /** Set which column-A names are entity types (see `entityType`), and re-read every row. */
  setEntityTypes(isType: (name: string) => boolean): void {
    this.entityType = (name) => name !== "" && isType(name);
    this.entitiesDirty = true;
    if (this.batchDepth === 0) this.flush();
  }

  // ------------------------------------------------------------ public API

  /** Run several edits and recalculate once at the end. */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      if (--this.batchDepth === 0) this.flush();
    }
  }

  /** Set a cell from user input ("=A1+1", "42", "TRUE", "text", "" to clear). */
  set(sheet: SheetId, a1: string, input: string): void {
    const { row, col } = this.locate(sheet, a1);
    this.setById(sheet, row, col, input);
  }

  setAt(sheet: SheetId, rowPos: number, colPos: number, input: string): void {
    const s = this.wb.sheet(sheet);
    this.setById(sheet, s.rows.idAt(rowPos), s.cols.idAt(colPos), input);
  }

  get(sheet: SheetId, a1: string): Scalar {
    const { row, col } = this.locate(sheet, a1);
    return this.cells.get(keyOf(sheet, row, col))?.value ?? null;
  }

  getAt(sheet: SheetId, rowPos: number, colPos: number): Scalar {
    const s = this.wb.sheet(sheet);
    return this.cells.get(keyOf(sheet, s.rows.idAt(rowPos), s.cols.idAt(colPos)))?.value ?? null;
  }

  /** A cell by stable IDs, without materialising rows or columns. */
  cellById(sheet: SheetId, row: RowId, col: ColId): { value: Scalar; formula: boolean } {
    this.flush();
    const c = this.cells.get(keyOf(sheet, row, col));
    return { value: c?.value ?? null, formula: c?.formula != null || c?.invalidText != null };
  }

  /**
   * Cells written or recalculated since the last call, for grids to repaint just those.
   * A value may be unchanged; structure changes are not covered (repaint everything).
   */
  takeChanged(): { sheet: SheetId; row: RowId; col: ColId }[] {
    this.flush();
    const out = [...this.changed].map((k) => {
      const [sheet, row, col] = k.split("|") as [SheetId, RowId, ColId];
      return { sheet, row, col };
    });
    this.changed.clear();
    return out;
  }

  /** Formula text as the grid would show it now, or null for a constant. */
  formula(sheet: SheetId, a1: string): string | null {
    const { row, col } = this.locate(sheet, a1);
    const c = this.cells.get(keyOf(sheet, row, col));
    if (!c) return null;
    if (c.invalidText !== null) return c.invalidText;
    return c.formula ? render(c.formula, { wb: this.wb, sheet }) : null;
  }

  /** Copy a cell's formula, shifting relative references (copy-paste / fill). */
  copy(sheet: SheetId, fromA1: string, toSheet: SheetId, toA1: string): void {
    const text = this.formula(sheet, fromA1);
    if (text === null) {
      const v = this.get(sheet, fromA1);
      this.set(toSheet, toA1, v === null ? "" : typeof v === "string" ? `'${v}` : String(toText(v)));
      return;
    }
    const s = this.wb.sheet(sheet);
    const t = this.wb.sheet(toSheet);
    const from = this.locate(sheet, fromA1);
    const to = this.locate(toSheet, toA1);
    const dRow = t.rows.posOf(to.row)! - s.rows.posOf(from.row)!;
    const dCol = t.cols.posOf(to.col)! - s.cols.posOf(from.col)!;
    try {
      const shifted = shift(parseFormula(text), dRow, dCol);
      this.setFormula(toSheet, to.row, to.col, text, () => bind(shifted, { wb: this.wb, sheet: toSheet }));
    } catch (e) {
      if (!(e instanceof BindError)) throw e;
      this.setById(toSheet, to.row, to.col, "=#REF!");
    }
  }

  insertRows(sheet: SheetId, pos: number, count = 1): RowId[] {
    const ids = this.wb.sheet(sheet).rows.insert(pos, count);
    this.structureChanged(sheet, false, []);
    return ids;
  }

  deleteRows(sheet: SheetId, pos: number, count = 1): RowId[] {
    const ids = this.wb.sheet(sheet).rows.delete(pos, count);
    this.structureChanged(sheet, false, [...this.cellsIn(this.rowCells, ids), ...this.readersOf(sheet, "row", ids)]);
    return ids;
  }

  /** Bring deleted rows back (the inverse op a revert would apply). */
  restoreRows(sheet: SheetId, ids: readonly RowId[]): void {
    this.wb.sheet(sheet).rows.restore(ids);
    this.structureChanged(sheet, false, [...this.cellsIn(this.rowCells, ids), ...this.readersOf(sheet, "row", ids)]);
  }

  moveRows(sheet: SheetId, pos: number, count: number, to: number): void {
    this.wb.sheet(sheet).rows.move(pos, count, to);
    this.structureChanged(sheet, false, []);
  }

  insertCols(sheet: SheetId, pos: number, count = 1): ColId[] {
    const ids = this.wb.sheet(sheet).cols.insert(pos, count);
    this.structureChanged(sheet, true, []);
    return ids;
  }

  deleteCols(sheet: SheetId, pos: number, count = 1): ColId[] {
    const ids = this.wb.sheet(sheet).cols.delete(pos, count);
    this.structureChanged(sheet, true, [...this.cellsIn(this.colCells, ids), ...this.readersOf(sheet, "col", ids)]);
    return ids;
  }

  // ------------------------------------------------------------ by stable ID (ops)

  /** Set a cell's stored content (see content.ts). */
  setContent(sheet: SheetId, row: RowId, col: ColId, content: Content): void {
    if (content === null || "v" in content) return this.setValue(sheet, row, col, content === null ? null : content.v);
    this.changed.add(keyOf(sheet, row, col));
    if ("f" in content) return this.setFormula(sheet, row, col, "", () => content.f);
    const k = keyOf(sheet, row, col);
    const c = this.cells.get(k) ?? this.newCell(sheet, row, col);
    this.commitDeps(c, null);
    c.formula = null;
    c.invalidText = content.bad;
    c.value = new FError(content.code, content.message);
    c.state = "fresh";
    this.touchedCell(sheet, row, col);
    this.pending.push(k);
    if (this.batchDepth === 0) this.flush();
  }

  /** A cell's stored content. */
  content(sheet: SheetId, row: RowId, col: ColId): Content {
    const c = this.cells.get(keyOf(sheet, row, col));
    if (!c) return null;
    if (c.invalidText !== null) {
      const e = c.value as FError;
      return { bad: c.invalidText, code: e.code, message: e.detail ?? "" };
    }
    if (c.formula) return { f: c.formula };
    return c.value === null || isErr(c.value) ? null : { v: c.value };
  }

  insertIds(sheet: SheetId, axis: "row" | "col", after: string | null, ids: readonly string[]): void {
    this.axis(sheet, axis).insertIds(after, ids);
    this.structureChanged(sheet, axis === "col", []);
  }

  /** Remove IDs entirely. Their cells must already be empty. */
  purgeIds(sheet: SheetId, axis: "row" | "col", ids: readonly string[]): void {
    this.axis(sheet, axis).purgeIds(ids);
    this.structureChanged(sheet, axis === "col", []);
  }

  killIds(sheet: SheetId, axis: "row" | "col", ids: readonly string[]): void {
    this.axis(sheet, axis).killIds(ids);
    this.structureChanged(sheet, axis === "col", [...this.cellsIn(axis === "row" ? this.rowCells : this.colCells, ids), ...this.readersOf(sheet, axis, ids)]);
  }

  restoreIds(sheet: SheetId, axis: "row" | "col", ids: readonly string[]): void {
    this.axis(sheet, axis).restore(ids);
    this.structureChanged(sheet, axis === "col", [...this.cellsIn(axis === "row" ? this.rowCells : this.colCells, ids), ...this.readersOf(sheet, axis, ids)]);
  }

  /**
   * Formulas that read a position in these rows or columns, even an empty one (it has
   * no cell, so nothing else would tell them): a delete turns the read into #REF!.
   */
  private readersOf(sheet: SheetId, axis: "row" | "col", ids: readonly string[]): Key[] {
    const gone = new Set(ids);
    const out: Key[] = [];
    for (const [k, readers] of this.dependents) {
      const [s, row, col] = k.split("|") as [SheetId, RowId, ColId];
      if (s === sheet && gone.has(axis === "row" ? row : col)) out.push(...readers);
    }
    return out;
  }

  moveIds(sheet: SheetId, axis: "row" | "col", after: string | null, ids: readonly string[]): void {
    this.axis(sheet, axis).moveIds(after, ids);
    this.structureChanged(sheet, axis === "col", []);
  }

  /** Forget a sheet's layouts (the sheet is being removed; it must be empty). */
  dropSheet(sheet: SheetId): void {
    this.layouts.delete(sheet);
    this.grid.delete(sheet);
    this.rangeCache.delete(sheet);
    this.entitiesDirty = true;
    if (this.batchDepth === 0) this.flush();
  }

  /** Forget a sheet's entity layouts (set them again with setLayoutColumns). */
  clearLayouts(sheet: SheetId): void {
    this.layouts.delete(sheet);
    this.entitiesDirty = true;
  }

  /** Everything recalculates: a sheet or pack was renamed or moved, so names and reach may differ. */
  recalcAll(): void {
    this.entitiesDirty = true;
    for (const c of this.cells.values()) if (c.formula) this.pending.push(c.key);
    if (this.batchDepth === 0) this.flush();
  }

  private axis(sheet: SheetId, axis: "row" | "col") {
    const s = this.wb.sheet(sheet);
    return axis === "row" ? s.rows : s.cols;
  }

  /** Move a sheet to another pack. Reach may change anywhere, so everything recalculates. */
  setSheetPack(sheet: SheetId, pack: PackId): void {
    this.wb.sheet(sheet).pack = pack;
    this.entitiesDirty = true;
    for (const c of this.cells.values()) if (c.formula) this.pending.push(c.key);
    if (this.batchDepth === 0) this.flush();
  }

  /**
   * Column layout for entity rows of `type` on a sheet: fields in order, starting at
   * column C (A is the type, B the ID). Stored against column IDs, so it survives
   * column moves.
   */
  setLayout(sheet: SheetId, type: string, fields: readonly string[], firstCol = 3): void {
    const cols = this.wb.sheet(sheet).cols;
    this.setLayoutColumns(sheet, type, new Map(fields.map((f, i) => [f, cols.idAt(firstCol + i)])));
  }

  /**
   * The same, with each field's column given directly. Only fields held in one cell are
   * listed: `ENTITY(id).field` reads exactly one cell.
   */
  setLayoutColumns(sheet: SheetId, type: string, fields: ReadonlyMap<string, ColId | null>): void {
    let bySheet = this.layouts.get(sheet);
    if (!bySheet) this.layouts.set(sheet, (bySheet = new Map()));
    bySheet.set(type, new Map(fields));
    // Formulas reading these entities' fields must re-resolve their columns.
    for (const [lower, recs] of this.entities) {
      if (recs.some((r) => r.sheet === sheet && r.type === type)) this.pending.push(...(this.entWatch.get(lower) ?? []));
    }
    this.entitiesDirty = true;
    if (this.batchDepth === 0) this.flush();
  }

  /** Evaluate a validation rule (§5.7) for one entity, or globally when `entity` is null. */
  evalRule(text: string, entity: string | null = null): Value {
    this.flush();
    const raw = parseFormula(text, { mode: "rule" });
    // Rules contain no cell references, so binding needs no real host.
    const expr = bind(raw, { wb: this.wb, sheet: "" });
    const saved = this.scope;
    this.scope = { owner: null, hostSheet: null, reachFrom: null, ruleEntity: entity, collect: null };
    try {
      return this.eval(expr);
    } finally {
      this.scope = saved;
    }
  }

  // ------------------------------------------------------------ editing internals

  private locate(sheet: SheetId, a1: string): { row: RowId; col: ColId } {
    const m = /^([A-Za-z]{1,3})([0-9]+)$/.exec(a1);
    if (!m) throw new Error(`bad cell address ${a1}`);
    const s = this.wb.sheet(sheet);
    return { row: s.rows.idAt(Number(m[2])), col: s.cols.idAt(colToNumber(m[1]!)) };
  }

  private setById(sheet: SheetId, row: RowId, col: ColId, input: string): void {
    this.changed.add(keyOf(sheet, row, col));
    if (input.startsWith("=") && input.length > 1) {
      this.setFormula(sheet, row, col, input, () => bind(parseFormula(input), { wb: this.wb, sheet }));
      return;
    }
    this.setValue(sheet, row, col, parseInput(input));
  }

  private setValue(sheet: SheetId, row: RowId, col: ColId, value: Scalar): void {
    this.changed.add(keyOf(sheet, row, col));
    const k = keyOf(sheet, row, col);
    let c = this.cells.get(k);
    if (value === null && c) {
      this.commitDeps(c, null);
      this.forget(c);
    } else if (value !== null) {
      c ??= this.newCell(sheet, row, col);
      this.commitDeps(c, null);
      c.formula = null;
      c.invalidText = null;
      c.value = value;
      c.state = "fresh";
    }
    this.touchedCell(sheet, row, col);
    this.pending.push(k);
    if (this.batchDepth === 0) this.flush();
  }

  private setFormula(sheet: SheetId, row: RowId, col: ColId, text: string, make: () => Expr): void {
    const k = keyOf(sheet, row, col);
    const c = this.cells.get(k) ?? this.newCell(sheet, row, col);
    try {
      c.formula = make();
      c.invalidText = null;
      c.state = "stale";
    } catch (e) {
      if (!(e instanceof FormulaSyntaxError) && !(e instanceof BindError)) throw e;
      this.commitDeps(c, null);
      c.formula = null;
      c.invalidText = text;
      c.value = new FError(e instanceof BindError ? e.code : "#ERROR!", e.message);
      c.state = "fresh";
    }
    this.touchedCell(sheet, row, col);
    this.pending.push(k);
    if (this.batchDepth === 0) this.flush();
  }

  private newCell(sheet: SheetId, row: RowId, col: ColId): Cell {
    const k = keyOf(sheet, row, col);
    const c: Cell = {
      key: k, sheet, row, col, formula: null, invalidText: null, value: null, state: "fresh",
      waiting: false, deps: new Set(), ranges: [], ents: new Set(), types: new Set(), usesIndex: false,
    };
    this.cells.set(k, c);
    let r = this.rowCells.get(row);
    if (!r) this.rowCells.set(row, (r = new Set()));
    r.add(k);
    let cs = this.colCells.get(col);
    if (!cs) this.colCells.set(col, (cs = new Set()));
    cs.add(k);
    let g = this.grid.get(sheet);
    if (!g) this.grid.set(sheet, (g = new Map()));
    let gc = g.get(col);
    if (!gc) g.set(col, (gc = new Map()));
    gc.set(row, c);
    return c;
  }

  private forget(c: Cell): void {
    this.cells.delete(c.key);
    this.grid.get(c.sheet)?.get(c.col)?.delete(c.row);
    this.rowCells.get(c.row)?.delete(c.key);
    this.colCells.get(c.col)?.delete(c.key);
  }

  /** Edits in column A or B can change the entity index. */
  private touchedCell(sheet: SheetId, row: RowId, col: ColId): void {
    if (this.wb.sheet(sheet).kind !== "data") return;
    const pos = this.wb.sheet(sheet).cols.posOf(col);
    if (pos === 1 || pos === 2) this.dirtyEntityRows.set(row, sheet);
    if (pos === 1) {
      // Whether column B is an ID (with the ID rules) depends on column A.
      const b = this.grid.get(sheet)?.get(this.wb.sheet(sheet).cols.idAt(2))?.get(row);
      if (b?.formula) this.pending.push(b.key);
    }
  }

  private cellsIn(index: Map<string, Set<Key>>, ids: readonly string[]): Key[] {
    const out: Key[] = [];
    for (const id of ids) for (const k of index.get(id) ?? []) out.push(k);
    return out;
  }

  private structureChanged(sheet: SheetId, cols: boolean, changed: Key[]): void {
    this.pending.push(...changed);
    for (const k of changed) {
      const c = this.cells.get(k);
      if (c?.formula) this.pending.push(k); // a restored formula cell must re-evaluate
    }
    for (const rd of this.sheetRanges.get(sheet) ?? []) this.pending.push(rd.owner);
    for (const k of this.positional) if (this.cells.get(k)?.sheet === sheet) this.pending.push(k);
    if (cols) this.reindexRanges(sheet);
    this.entitiesDirty = true;
    if (this.batchDepth === 0) this.flush();
  }

  // ------------------------------------------------------------ dependency bookkeeping

  private sameDeps(c: Cell, next: Collect): boolean {
    if (c.deps.size !== next.deps.size || c.ranges.length !== next.ranges.length) return false;
    if (c.ents.size !== next.ents.size || c.types.size !== next.types.size) return false;
    for (const d of next.deps) if (!c.deps.has(d)) return false;
    for (let i = 0; i < c.ranges.length; i++) {
      const x = c.ranges[i]!;
      const y = next.ranges[i]!;
      if (x.sheet !== y.sheet || x.a !== y.a || x.b !== y.b) return false; // same bound points
    }
    for (const id of next.ents) if (!c.ents.has(id)) return false;
    for (const t of next.types) if (!c.types.has(t)) return false;
    return true;
  }

  private commitDeps(c: Cell, next: Collect | null): void {
    if (next && this.sameDeps(c, next)) return; // the common case: nothing to re-index
    for (const d of c.deps) this.dependents.get(d)?.delete(c.key);
    for (const rd of c.ranges) {
      this.sheetRanges.get(rd.sheet)?.delete(rd);
      for (const set of this.rangeIndex.get(rd.sheet)?.values() ?? []) set.delete(rd);
    }
    for (const id of c.ents) this.entWatch.get(id)?.delete(c.key);
    for (const t of c.types) this.typeWatch.get(t)?.delete(c.key);
    c.deps = next?.deps ?? new Set();
    c.ranges = next?.ranges ?? [];
    c.ents = next?.ents ?? new Set();
    c.types = next?.types ?? new Set();
    for (const d of c.deps) {
      let s = this.dependents.get(d);
      if (!s) this.dependents.set(d, (s = new Set()));
      s.add(c.key);
    }
    for (const rd of c.ranges) {
      let s = this.sheetRanges.get(rd.sheet);
      if (!s) this.sheetRanges.set(rd.sheet, (s = new Set()));
      s.add(rd);
      this.indexRange(rd);
    }
    for (const id of c.ents) {
      let s = this.entWatch.get(id);
      if (!s) this.entWatch.set(id, (s = new Set()));
      s.add(c.key);
    }
    for (const t of c.types) {
      let s = this.typeWatch.get(t);
      if (!s) this.typeWatch.set(t, (s = new Set()));
      s.add(c.key);
    }
  }

  private indexRange(rd: RangeDep): void {
    let idx = this.rangeIndex.get(rd.sheet);
    if (!idx) this.rangeIndex.set(rd.sheet, (idx = new Map()));
    const add = (k: ColId | "*"): void => {
      let s = idx.get(k);
      if (!s) idx.set(k, (s = new Set()));
      s.add(rd);
    };
    if (rd.a.col === null || rd.b.col === null) return add("*");
    const cols = this.wb.sheet(rd.sheet).cols;
    const span = cols.span(rd.a.col, rd.b.col);
    if (!span) return;
    const live = cols.liveIds();
    for (let p = span.from; p <= span.to; p++) add(live[p - 1]!);
  }

  private reindexRanges(sheet: SheetId): void {
    this.rangeIndex.delete(sheet);
    for (const rd of this.sheetRanges.get(sheet) ?? []) this.indexRange(rd);
  }

  private rangeCoversRow(rd: RangeDep, row: RowId): boolean {
    if (rd.a.row === null || rd.b.row === null) return true;
    const rows = this.wb.sheet(rd.sheet).rows;
    const p = rows.posOf(row);
    if (p === null) return true; // deleted row: be conservative
    const span = rows.span(rd.a.row, rd.b.row);
    return span !== null && p >= span.from && p <= span.to;
  }

  // ------------------------------------------------------------ recalc

  private flush(): void {
    if (this.batchDepth > 0) return;
    const seeds = this.pending;
    this.pending = [];
    if (this.entitiesDirty) seeds.push(...this.rebuildEntities());
    else if (this.dirtyEntityRows.size > 0) {
      seeds.push(...this.updateEntityRows(this.dirtyEntityRows));
      this.dirtyEntityRows = new Map();
    }
    if (seeds.length === 0) return;
    this.rangeCache.clear();
    this.recalc(this.markStale(seeds));
    this.rangeCache.clear();
  }

  /** Breadth-first from the changed cells: every formula downstream becomes stale. */
  private markStale(seeds: Key[]): Key[] {
    const order: Key[] = [];
    const ordered = new Set<Key>();
    const queue: Key[] = [];
    const visit = (k: Key): void => {
      const c = this.cells.get(k);
      if (!c?.formula || c.state === "computing" || ordered.has(k)) return;
      c.state = "stale"; // fresh ones become stale; new formulas already are
      ordered.add(k);
      order.push(k);
    };
    for (const k of seeds) {
      visit(k);
      queue.push(k);
    }
    const seen = new Set<Key>(queue);
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i]!;
      const cell = this.cells.get(k);
      const [sheet, row, col] = cell ? [cell.sheet, cell.row, cell.col] : (k.split("|") as [SheetId, RowId, ColId]);
      const next = (d: Key): void => {
        if (seen.has(d)) return;
        seen.add(d);
        visit(d);
        queue.push(d);
      };
      for (const d of this.dependents.get(k) ?? []) next(d);
      const idx = this.rangeIndex.get(sheet);
      if (idx) {
        for (const bucket of [idx.get(col), idx.get("*")]) {
          if (!bucket) continue;
          for (const rd of bucket) if (!seen.has(rd.owner) && this.rangeCoversRow(rd, row)) next(rd.owner);
        }
      }
    }
    return order;
  }

  private recalc(order: Key[]): void {
    let evaluations = 0;
    let stack = order.reverse();
    // Formulas re-dirtied by an ID change wait until the current work is done, so a
    // batch of ID changes (one prefix edit renaming 10k entities) recomputes each reader once.
    let deferred: Key[] = [];
    while (stack.length > 0 || deferred.length > 0) {
      if (stack.length === 0) {
        stack = deferred.reverse();
        deferred = [];
        continue;
      }
      const k = stack[stack.length - 1]!;
      const c = this.cells.get(k);
      if (!c || c.state !== "stale" || !c.formula) {
        stack.pop();
        continue;
      }
      const collect: Collect = { deps: new Set(), ranges: [], ents: new Set(), types: new Set(), usesIndex: false };
      const hostPack = this.wb.sheet(c.sheet).pack;
      this.scope = { owner: k, hostSheet: c.sheet, reachFrom: hostPack, ruleEntity: null, collect };
      c.state = "computing";
      evaluations++;
      this.changed.add(k);
      this.missing = [];
      try {
        const raw = this.eval(c.formula);
        if (this.missing.length > 0) throw new NotReady(this.missing);
        c.value = this.classifyColumns(c, this.toCellValue(raw), collect);
        c.usesIndex = collect.usesIndex;
        this.rangeCache.get(c.sheet)?.clear(); // a value on this sheet changed
        c.state = "fresh";
        c.waiting = false;
        this.commitDeps(c, collect);
        stack.pop();
        if (this.isIdColumn(c)) {
          // The ID is known only now: update this row of the index and re-dirty its readers.
          const affected = this.updateEntityRows([[c.row, c.sheet]]);
          if (affected.length > 0) deferred.push(...this.markStale(affected));
        }
      } catch (e) {
        if (!(e instanceof NotReady)) throw e;
        if (e.keys.some((key) => this.cells.get(key)!.waiting)) {
          // p is further down the stack, waiting on a chain that leads back here.
          c.value = new FError("#CYCLE!", "Circular reference");
          c.state = "fresh";
          c.waiting = false;
          this.commitDeps(c, collect);
          stack.pop();
        } else {
          c.state = "stale";
          c.waiting = true;
          this.commitDeps(c, collect); // keep what we learned, so later edits still reach us
          for (let i = e.keys.length - 1; i >= 0; i--) stack.push(e.keys[i]!);
        }
      } finally {
        this.missing = null;
        this.scope = { owner: null, hostSheet: null, reachFrom: null, ruleEntity: null, collect: null };
      }
    }
    this.lastEvaluations = evaluations;
  }

  private isIdColumn(c: Cell): boolean {
    const s = this.wb.sheet(c.sheet);
    return s.kind === "data" && s.cols.posOf(c.col) === 2;
  }

  /** Is this row an entity row (active type in column A)? */
  private isEntityRow(sheet: SheetId, row: RowId): boolean {
    const s = this.wb.sheet(sheet);
    const type = this.grid.get(sheet)?.get(s.cols.idAt(1))?.get(row)?.value;
    return typeof type === "string" && type !== "" && this.entityType(type);
  }

  /**
   * Column rules for formulas: column A (the type) is never a formula; an entity's ID
   * (column B) may be, but must not depend on the entity index. That rules out every
   * cycle through the index (an ID that changes which entities exist, which changes the ID).
   */
  private classifyColumns(c: Cell, v: Scalar, collect: Collect): Scalar {
    const s = this.wb.sheet(c.sheet);
    if (s.kind !== "data") return v;
    const pos = s.cols.posOf(c.col);
    if (pos === 1) return new FError("#VALUE!", "Column A holds the row type and can't be a formula");
    if (pos === 2 && collect.usesIndex && this.isEntityRow(c.sheet, c.row)) {
      return new FError("#CYCLE!", "An ID can't depend on ENTITY() or ENTITIES(), directly or through other cells");
    }
    return v;
  }

  private toCellValue(v: Value): Scalar {
    if (isEntity(v)) return err("#VALUE!");
    return scalar(v);
  }

  // ------------------------------------------------------------ evaluation

  private readCell(sheet: SheetId, row: RowId, col: ColId): Scalar {
    const k = keyOf(sheet, row, col);
    this.scope.collect?.deps.add(k); // even when dead, so a restore reaches us
    const s = this.wb.sheet(sheet);
    if (s.rows.isDead(row) || s.cols.isDead(col)) return err("#REF!");
    const c = this.cells.get(k);
    if (!c) return null;
    if (c.state === "computing") return new FError("#CYCLE!", "Circular reference");
    if (c.state === "stale") return this.notReady(c);
    if (c.usesIndex && this.scope.collect) this.scope.collect.usesIndex = true;
    return c.value;
  }

  private checkReach(sheet: SheetId): FError | null {
    const from = this.scope.reachFrom;
    if (from === null) return null;
    const to = this.wb.sheet(sheet).pack;
    return this.wb.canReach(from, to) ? null : new FError("#REACH!", `Pack '${this.wb.packName(from)}' cannot read pack '${this.wb.packName(to)}'`);
  }

  private readRange(e: Extract<Expr, { k: "range" }>): Value {
    const reach = this.checkReach(e.sheet);
    if (reach) return reach;
    this.scope.collect?.ranges.push({ owner: this.scope.owner!, sheet: e.sheet, a: e.a, b: e.b });
    // Many formulas often read the same range (a lookup table). Within one recalc the
    // array is shared until some cell on that sheet is recomputed. Functions never mutate it.
    const ck = `${e.a.row}|${e.a.col}|${e.b.row}|${e.b.col}`;
    let bySheet = this.rangeCache.get(e.sheet);
    let hit = bySheet?.get(ck);
    if (!hit) {
      this.rangeUsesIndex = false;
      this.rangeIncomplete = false;
      const v = this.buildRange(e);
      if (isErr(v)) return v;
      if (this.rangeIncomplete) return v; // has placeholders: never cache it
      hit = { v, usesIndex: this.rangeUsesIndex };
      if (!bySheet) this.rangeCache.set(e.sheet, (bySheet = new Map()));
      bySheet.set(ck, hit);
    }
    if (hit.usesIndex && this.scope.collect) this.scope.collect.usesIndex = true;
    return hit.v;
  }

  private buildRange(e: Extract<Expr, { k: "range" }>): ArrayValue | FError {
    const s = this.wb.sheet(e.sheet);
    const rows = e.a.row === null || e.b.row === null ? { from: 1, to: s.rows.length } : s.rows.span(e.a.row, e.b.row);
    const cols = e.a.col === null || e.b.col === null ? { from: 1, to: s.cols.length } : s.cols.span(e.a.col, e.b.col);
    if (!rows || !cols) return err("#REF!");
    const rowIds = s.rows.liveIds();
    const colIds = s.cols.liveIds();
    const width = cols.to - cols.from + 1;
    const out: Scalar[][] = [];
    for (let r = rows.from; r <= rows.to; r++) out.push(new Array<Scalar>(width).fill(null));
    // Column-major over the grid index: no string keys on this path.
    const sheetGrid = this.grid.get(e.sheet);
    if (sheetGrid) {
      for (let c = cols.from; c <= cols.to; c++) {
        const colMap = sheetGrid.get(colIds[c - 1]!);
        if (!colMap) continue;
        const ci = c - cols.from;
        const sparse = colMap.size < (rows.to - rows.from + 1) / 4;
        if (sparse) {
          for (const [rid, cell] of colMap) {
            const r = s.rows.posOf(rid);
            if (r !== null && r >= rows.from && r <= rows.to) out[r - rows.from]![ci] = this.rangeCellValue(cell);
          }
        } else {
          for (let r = rows.from; r <= rows.to; r++) {
            const cell = colMap.get(rowIds[r - 1]!);
            if (cell) out[r - rows.from]![ci] = this.rangeCellValue(cell);
          }
        }
      }
    }
    return { kind: "array", rows: out };
  }

  /**
   * A stale precedent: remember it and carry on with a placeholder, so one pass finds
   * every precedent. A waiting one is on the stack below us, so stop now (a cycle).
   */
  private notReady(c: Cell): Scalar {
    if (this.missing === null || c.waiting) throw new NotReady([c.key]);
    this.missing.push(c.key);
    return null;
  }

  private rangeIncomplete = false;

  private rangeCellValue(cell: Cell): Scalar {
    if (cell.state === "stale") {
      this.rangeIncomplete = true;
      return this.notReady(cell);
    }
    if (cell.state === "computing") return new FError("#CYCLE!", "Circular reference");
    if (cell.usesIndex) this.rangeUsesIndex = true;
    return cell.value;
  }

  private readonly ctx: Ctx = {
    eval: (e) => this.eval(e),
    entity: (id) => this.entity(id),
    entityField: (id, field) => this.entityField(id, field),
    position: (e) => {
      // Position functions must re-run after any row or column change on their sheet.
      if (this.scope.owner) this.positional.add(this.scope.owner);
      let sheet: SheetId, row: RowId | null, col: ColId | null;
      if (e === undefined) {
        const c = this.scope.owner ? this.cells.get(this.scope.owner) : undefined;
        if (!c) return new FError("#VALUE!", "ROW() and COLUMN() need a cell");
        ({ sheet, row, col } = c);
      } else if (e.k === "ref" || e.k === "range") {
        const p = e.k === "ref" ? e.p : e.a;
        sheet = e.sheet;
        ({ row, col } = p);
      } else return new FError("#VALUE!", "ROW() and COLUMN() take a reference");
      const s = this.wb.sheet(sheet);
      const r = row === null ? 1 : s.rows.posOf(row);
      const cc = col === null ? 1 : s.cols.posOf(col);
      return r === null || cc === null ? err("#REF!") : { row: r, col: cc };
    },
    entitiesOfType: (type) => {
      this.scope.collect?.types.add(type);
      if (this.scope.collect) this.scope.collect.usesIndex = true;
      const ids = this.typeIds(type);
      const from = this.scope.reachFrom;
      if (from === null) return ids;
      // In a cell, only entities the formula's pack can reach are listed.
      return ids.filter((id) => {
        const rec = this.entities.get(id.toLowerCase())?.find((r) => r.id === id);
        return rec !== undefined && this.wb.canReach(from, this.wb.sheet(rec.sheet).pack);
      });
    },
  };

  private eval(e: Expr): Value {
    switch (e.k) {
      case "num":
      case "str":
      case "bool":
        return e.v;
      case "err":
        return err(e.v);
      case "ref":
        return this.checkReach(e.sheet) ?? this.readCell(e.sheet, e.p.row!, e.p.col!);
      case "range":
        return this.readRange(e);
      case "name":
        return this.scope.ruleEntity !== null
          ? this.entityField(this.scope.ruleEntity, e.name)
          : new FError("#NAME?", `Unknown name '${e.name}'`);
      case "call":
        return callFunction(e.fn, e.args, this.ctx);
      case "field": {
        const base = this.eval(e.e);
        if (isErr(base)) return base;
        return isEntity(base) ? this.entityField(base.id, e.field) : err("#VALUE!");
      }
      case "neg": {
        const n = toNumber(this.eval(e.e));
        return isErr(n) ? n : -n;
      }
      case "pct": {
        const n = toNumber(this.eval(e.e));
        return isErr(n) ? n : n / 100;
      }
      case "bin":
        return this.binary(e.op, this.eval(e.l), this.eval(e.r));
    }
  }

  private binary(op: string, l: Value, r: Value): Value {
    if (op === "&") {
      const a = toText(l);
      if (isErr(a)) return a;
      const b = toText(r);
      return isErr(b) ? b : a + b;
    }
    if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      const c = compare(scalar(l), scalar(r));
      if (isErr(c)) return c;
      switch (op) {
        case "=": return c === 0;
        case "<>": return c !== 0;
        case "<": return c < 0;
        case ">": return c > 0;
        case "<=": return c <= 0;
        default: return c >= 0;
      }
    }
    const a = toNumber(l);
    if (isErr(a)) return a;
    const b = toNumber(r);
    if (isErr(b)) return b;
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? err("#DIV/0!") : a / b;
      default: {
        const p = a ** b;
        return Number.isFinite(p) ? p : err("#NUM!");
      }
    }
  }

  // ------------------------------------------------------------ entities (simplified §6.2)

  /** The entity on a row, from columns A (type) and B (ID), or null. */
  private readEntityRow(sheet: SheetId, row: RowId): EntityRec | null {
    const s = this.wb.sheet(sheet);
    if (s.kind !== "data" || s.cols.length < 2 || s.rows.isDead(row)) return null;
    const g = this.grid.get(sheet);
    const typeCell = g?.get(s.cols.idAt(1))?.get(row);
    if (typeCell?.formula || typeCell?.invalidText) return null; // column A must be literal
    const type = typeCell?.value;
    const idCell = g?.get(s.cols.idAt(2))?.get(row);
    if (typeof type !== "string" || type === "" || !this.entityType(type)) return null;
    if (idCell?.formula && idCell.state !== "fresh") {
      // A formula ID not computed yet: keep what we had; recalc updates the row when it is.
      const old = this.rowEnt.get(row);
      return old ? { ...old, type } : null;
    }
    const id = idCell?.value;
    if (typeof id !== "string" || id === "") return null;
    return { id, type, sheet, row };
  }

  /** IDs of a type in sheet and row order (cached until the type's membership or order changes). */
  private typeIds(type: string): string[] {
    let ids = this.byType.get(type);
    if (ids) return ids;
    const recs = [...(this.typeRows.get(type) ?? [])].map((r) => this.rowEnt.get(r)!);
    const sheetOrder = [...this.wb.sheets.keys()];
    recs.sort((a, b) =>
      a.sheet === b.sheet
        ? this.wb.sheet(a.sheet).rows.posOf(a.row)! - this.wb.sheet(b.sheet).rows.posOf(b.row)!
        : sheetOrder.indexOf(a.sheet) - sheetOrder.indexOf(b.sheet));
    this.byType.set(type, (ids = recs.map((r) => r.id)));
    return ids;
  }

  /** Re-read the entity on each row; returns formulas affected by what changed. */
  private updateEntityRows(rows: Iterable<[RowId, SheetId]>): Key[] {
    const affected: Key[] = [];
    const touch = (rec: EntityRec): void => {
      affected.push(...(this.entWatch.get(rec.id.toLowerCase()) ?? []), ...(this.typeWatch.get(rec.type) ?? []));
      this.byType.delete(rec.type);
    };
    for (const [row, sheet] of rows) {
      const old = this.rowEnt.get(row) ?? null;
      const now = this.readEntityRow(sheet, row);
      if (old?.id === now?.id && old?.type === now?.type) continue;
      if (old) {
        const lower = old.id.toLowerCase();
        const list = (this.entities.get(lower) ?? []).filter((r) => r.row !== row);
        if (list.length) this.entities.set(lower, list);
        else this.entities.delete(lower);
        this.typeRows.get(old.type)?.delete(row);
        this.rowEnt.delete(row);
        touch(old);
      }
      if (now) {
        const lower = now.id.toLowerCase();
        this.entities.set(lower, [...(this.entities.get(lower) ?? []), now]);
        let t = this.typeRows.get(now.type);
        if (!t) this.typeRows.set(now.type, (t = new Set()));
        t.add(row);
        this.rowEnt.set(row, now);
        touch(now);
      }
    }
    return affected;
  }

  /**
   * Full rebuild, after structural changes. Returns formulas affected by changes,
   * including entities whose pack (and so reach) changed and types whose order changed.
   */
  private rebuildEntities(): Key[] {
    this.entitiesDirty = false;
    this.dirtyEntityRows.clear();
    // With a duplicate ID, which one wins depends on document order (firstInDocument), and a
    // move can change that without changing the records: so the winner, as recorded at the
    // last rebuild, is part of the signature.
    const before = new Map([...this.entities].map(([k, l]) => [k, this.entitySig(l) + (this.dupWinner.get(k) ?? "")]));
    const typesBefore = new Map([...this.typeRows.keys()].map((t) => [t, this.typeIds(t).join("\n")]));
    this.entities = new Map();
    this.rowEnt = new Map();
    this.typeRows = new Map();
    this.byType = new Map();
    const all: [RowId, SheetId][] = [];
    for (const s of this.wb.sheets.values()) for (const row of s.rows.liveIds()) all.push([row, s.id]);
    this.updateEntityRows(all);
    this.dupWinner = new Map();
    for (const [k, l] of this.entities) if (l.length > 1) this.dupWinner.set(k, `>${this.firstInDocument(l).row}`);
    const affected: Key[] = [];
    for (const id of new Set([...before.keys(), ...this.entities.keys()])) {
      if (before.get(id) !== this.entitySig(this.entities.get(id)) + (this.dupWinner.get(id) ?? "")) affected.push(...(this.entWatch.get(id) ?? []));
    }
    for (const t of new Set([...typesBefore.keys(), ...this.typeRows.keys()])) {
      if (typesBefore.get(t) !== (this.typeRows.has(t) ? this.typeIds(t).join("\n") : undefined)) {
        affected.push(...(this.typeWatch.get(t) ?? []));
      }
    }
    return affected;
  }

  private entitySig(l: EntityRec[] | undefined): string {
    return (l ?? []).map((r) => `${r.id}|${r.type}|${r.sheet}|${r.row}|${this.wb.sheet(r.sheet).pack}`).join(";");
  }

  private findEntity(id: string): EntityRec | FError {
    this.scope.collect?.ents.add(id.toLowerCase());
    if (this.scope.collect) this.scope.collect.usesIndex = true;
    const list = this.entities.get(id.toLowerCase()) ?? [];
    const exact = list.filter((r) => r.id === id);
    if (exact.length === 0) {
      const hint = list[0] ? ` (did you mean "${list[0].id}"?)` : "";
      return new FError("#REF!", `No entity "${id}"${hint}`);
    }
    // A duplicate ID is a validation error; until it's fixed, the first in document order
    // (sheet tabs, then rows) wins, however the index was built.
    const rec = exact.length === 1 ? exact[0]! : this.firstInDocument(exact);
    return this.checkReach(rec.sheet) ?? rec;
  }

  private firstInDocument(recs: EntityRec[]): EntityRec {
    const tabs = [...this.wb.sheets.keys()];
    const key = (r: EntityRec): [number, number] => [tabs.indexOf(r.sheet), this.wb.sheet(r.sheet).rows.posOf(r.row) ?? Infinity];
    return recs.reduce((best, r) => {
      const [a, b] = key(r), [c, d] = key(best);
      return a < c || (a === c && b < d) ? r : best;
    });
  }

  private entity(id: string): EntityValue | FError {
    const rec = this.findEntity(id);
    return isErr(rec) ? rec : { kind: "entity", id: rec.id };
  }

  private entityField(id: string, field: string): Value {
    const rec = this.findEntity(id);
    if (isErr(rec)) return rec;
    if (field === "id") return rec.id;
    const col = this.layouts.get(rec.sheet)?.get(rec.type)?.get(field);
    if (col === undefined) return new FError("#NAME?", `${rec.type} has no field '${field}'`);
    if (col === null) return null; // a field with no column on this sheet is blank
    return this.readCell(rec.sheet, rec.row, col);
  }

  // ------------------------------------------------------------ ID changes (formula IDs)

  /** Entity ID per row. An entity's identity is its row; the ID is a value on it. */
  entityIds(): Map<RowId, { type: string; id: string }> {
    this.flush();
    return new Map([...this.rowEnt].map(([row, r]) => [row, { type: r.type, id: r.id }]));
  }

  /**
   * Rows whose ID changed between two snapshots. When an ID is computed, editing an
   * input renames the entity as a side effect. Landing can detect that and offer to
   * update references.
   */
  static idChanges(
    before: Map<RowId, { type: string; id: string }>,
    after: Map<RowId, { type: string; id: string }>,
  ): { row: RowId; type: string; from: string; to: string }[] {
    const out: { row: RowId; type: string; from: string; to: string }[] = [];
    for (const [row, b] of before) {
      const a = after.get(row);
      if (a && a.type === b.type && a.id !== b.id) out.push({ row, type: a.type, from: b.id, to: a.id });
    }
    return out;
  }

  /**
   * Point `ENTITY("from")` literals at `to`. In Phase 1 this also covers ref fields
   * (known from the schema). Returns the number of formulas changed.
   */
  rewriteEntityRefs(from: string, to: string): number {
    const walk = (e: Expr): Expr => {
      switch (e.k) {
        case "call": {
          const args = e.args.map(walk);
          const a0 = args[0];
          if (e.fn === "ENTITY" && a0?.k === "str" && a0.v === from) args[0] = { k: "str", v: to };
          return { ...e, args };
        }
        case "bin":
          return { ...e, l: walk(e.l), r: walk(e.r) };
        case "neg":
        case "pct":
        case "field":
          return { ...e, e: walk(e.e) };
        default:
          return e;
      }
    };
    let n = 0;
    this.batch(() => {
      for (const c of [...this.cells.values()]) {
        if (!c.formula) continue;
        const next = walk(c.formula);
        if (render(next, { wb: this.wb, sheet: c.sheet }) === render(c.formula, { wb: this.wb, sheet: c.sheet })) continue;
        this.setFormula(c.sheet, c.row, c.col, "", () => next);
        n++;
      }
    });
    return n;
  }

  // ------------------------------------------------------------ debugging

  /** All formula cells with values, for tests. */
  dump(sheet: SheetId): Record<string, string> {
    const out: Record<string, string> = {};
    const s = this.wb.sheet(sheet);
    for (const c of this.cells.values()) {
      if (c.sheet !== sheet) continue;
      const r = s.rows.posOf(c.row);
      const col = s.cols.posOf(c.col);
      if (r === null || col === null) continue;
      const v = c.value;
      out[`${String.fromCharCode(64 + col)}${r}`] = isErr(v) ? v.code : String(v);
    }
    return out;
  }
}

