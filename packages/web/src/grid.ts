// One sheet of a project as the grid shows it (DESIGN §6, §9.2), apart from any grid
// component: what each cell shows and holds, what each row is, the column names for a row's
// type (the sticky header), the validation issues by cell, and edits by position.
//
// The grid shows some empty rows and columns past the sheet's end. Typing into one makes the
// rows or columns up to it first, in the same change.

import {
  ApiError, canSplit, canSpread, classify, columnSpecs, defaultSpecs, display, fieldColumns, isErr, numberToCol, OpError, Sapwood, sheetLayout, validate,
  type FieldColumns,
  moveFormula, type ColId, type Edit, type FieldDef, type FieldType, type Format, type Issue, type Op, type Project, type RowClass, type RowId, type SheetId,
} from "@thek42/sapwood-core";
import { inPanel, summary, type CellField } from "./panel.ts";
import { refTarget, type RefTarget } from "./suggest.ts";

/** Empty rows and columns shown past the sheet's end. */
export const SPARE_ROWS = 100;
export const SPARE_COLS = 6;

export interface CellView {
  /** As shown. */
  text: string;
  /** As typed: what the formula bar shows. */
  input: string;
  formula: boolean;
  number: boolean;
  error: boolean;
  format: Format | null;
  issue: Issue | null;
  /** A struct, union, list of them or json value: shown as its summary, edited in the panel. */
  panel?: boolean;
}

export interface CellEdit {
  /** 0-based row and column, as the grid counts. */
  row: number;
  col: number;
  input: string;
  /** A format to set too (null clears it); left alone when absent. */
  format?: Format | null;
}

/** A block of cells, 0-based, as the grid counts. */
export interface Rect {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export type Axis = "row" | "col";

const EMPTY: CellView = { text: "", input: "", formula: false, number: false, error: false, format: null, issue: null };

export class SheetGrid {
  readonly project: Project;
  readonly sheet: SheetId;
  private rowIds: readonly RowId[];
  private colIds: readonly ColId[];
  private issues = new Map<string, Issue>();
  /** Issues not on one cell, by row. */
  private rowIssues = new Map<RowId, Issue>();
  private specs = new Map<string, Map<ColId, string>>();
  private classes = new Map<RowId, RowClass>();
  private counts: { errors: number; warnings: number } | null = null;

  constructor(project: Project, sheet: SheetId) {
    this.project = project;
    this.sheet = sheet;
    const s = project.wb.sheet(sheet);
    this.rowIds = s.rows.liveIds();
    this.colIds = s.cols.liveIds();
  }

  /** How many issues on this sheet. */
  get errors(): number {
    return this.check().errors;
  }
  get warnings(): number {
    return this.check().warnings;
  }

  /** Validation, run when first asked for: an edit builds a grid only to write through it. */
  private check(): { errors: number; warnings: number } {
    if (this.counts) return this.counts;
    const counts = { errors: 0, warnings: 0 };
    for (const i of validate(this.project).issues) {
      const at = i.at;
      if (at?.sheet !== this.sheet) continue;
      if (i.level === "error") counts.errors++;
      else counts.warnings++;
      const key = at.col === undefined ? null : `${at.row}|${at.col}`;
      const map = key === null ? this.rowIssues : this.issues;
      const k = key ?? at.row;
      const had = map.get(k);
      if (!had || (had.level === "warning" && i.level === "error")) map.set(k, i);
    }
    return (this.counts = counts);
  }

  /**
   * Each cell that shows an issue, the worst one, where the grid has it now; a row's own
   * issue shows on column A. The key names the cell by ID, so it holds as rows move.
   */
  issueCells(): { row: number; col: number; key: string; issue: Issue }[] {
    this.check();
    const rows = new Map(this.rowIds.map((id, i) => [id, i]));
    const cols = new Map(this.colIds.map((id, i) => [id, i]));
    const out = new Map<string, { row: number; col: number; key: string; issue: Issue }>();
    for (const [k, issue] of this.issues) {
      const [r, c] = k.split("|") as [RowId, ColId];
      const row = rows.get(r);
      const col = cols.get(c);
      if (row !== undefined && col !== undefined) out.set(k, { row, col, key: k, issue });
    }
    const a = this.colIds[0];
    for (const [r, issue] of this.rowIssues) {
      const row = rows.get(r);
      if (row === undefined || a === undefined) continue;
      const k = `${r}|${a}`;
      const had = out.get(k);
      if (!had || (had.issue.level === "warning" && issue.level === "error")) out.set(k, { row, col: 0, key: k, issue });
    }
    return [...out.values()];
  }

  /** The worst issue anywhere on a row, for its row number. */
  rowLevel(row: number): "error" | "warning" | null {
    const r = this.rowIds[row];
    if (r === undefined) return null;
    this.check();
    if (!this.levels) {
      this.levels = new Map();
      const worse = (id: RowId, l: "error" | "warning") => this.levels!.get(id) !== "error" && this.levels!.set(id, l);
      for (const [k, i] of this.issues) worse(k.split("|")[0] as RowId, i.level);
      for (const [id, i] of this.rowIssues) worse(id, i.level);
    }
    return this.levels.get(r) ?? null;
  }
  private levels: Map<RowId, "error" | "warning"> | null = null;

  get name(): string {
    return this.project.wb.sheet(this.sheet).name;
  }

  get kind(): "data" | "scratch" {
    return this.project.wb.sheet(this.sheet).kind;
  }

  /** Rows and columns the sheet has. */
  get liveRows(): number {
    return this.rowIds.length;
  }
  get liveCols(): number {
    return this.colIds.length;
  }

  /** Rows and columns to show: the sheet's, then empty ones; at least as many columns as the widest type needs. */
  get rows(): number {
    return this.rowIds.length + SPARE_ROWS;
  }
  get cols(): number {
    let widest = 0;
    if (this.kind === "data") for (const t of this.project.schema.types.values()) if (!t.def.singleton) widest = Math.max(widest, 2 + t.fields.length);
    return Math.max(this.colIds.length + SPARE_COLS, widest + 1, 8);
  }

  cell(row: number, col: number): CellView {
    const r = this.rowIds[row];
    const c = this.colIds[col];
    if (r === undefined || c === undefined) return EMPTY;
    const input = this.project.inputAt(this.sheet, r, c);
    this.check();
    const issue = this.issues.get(`${r}|${c}`) ?? (col === 0 ? (this.rowIssues.get(r) ?? null) : null);
    const format = this.project.format(this.sheet, r, c);
    if (input === "" && !issue && !format) return EMPTY;
    const { value, formula } = this.project.engine.cellById(this.sheet, r, c);
    const view: CellView = { text: shown(value), input, formula, number: typeof value === "number", error: isErr(value), format, issue };
    const f = this.fieldAt(row, col);
    if (f && inPanel(f.type)) {
      view.panel = true;
      // JSON that reads shows as its summary; anything else as it is, so the problem shows.
      if (typeof value === "string" && !formula) {
        try {
          view.text = summary(this.project.schema, f.type, JSON.parse(value));
        } catch {
          // not JSON: shown as typed
        }
      }
    }
    return view;
  }

  /**
   * The field a cell holds whole: on an entity row, a column holding a whole field; on a
   * singleton's field row, column B. Null for anything else (split columns among them).
   */
  /**
   * The field a column holds for rows of `type`, whole or in part, with how it sits in the
   * sheet's columns and what it may become (DESIGN §6.3, §6.4); null for anything else.
   */
  fieldColumnsAt(type: string | null, col: number): { type: string; field: string; form: FieldColumns; split: boolean; spread: boolean; longest: number } | null {
    if (this.kind !== "data" || type === null || col < 2) return null;
    const t = this.project.schema.types.get(type);
    if (!t || t.def.singleton) return null;
    const name = /^[A-Za-z_]\w*/.exec(this.columnName(type, col))?.[0];
    const def = name === undefined ? undefined : t.fieldByName.get(name)?.def;
    if (!def) return null;
    let longest = 0;
    for (const e of this.project.project().entities)
      if (e.type === type && e.at.sheet === this.sheet) {
        const v = e.fields.get(def.name)?.value;
        if (Array.isArray(v)) longest = Math.max(longest, v.length);
      }
    const form = fieldColumns(sheetLayout(this.project.schema, this.project.doc.sheets.get(this.sheet)!, type), def.id);
    return { type, field: def.name, form, split: canSplit(this.project.schema, def), spread: canSpread(def), longest };
  }

  /** Change how a field sits in the columns, moving every row's value (Sapwood.setColumns). */
  setColumns(type: string, field: string, to: FieldColumns): { ops: Op[] } {
    const s = this.project.wb.sheet(this.sheet);
    try {
      return new Sapwood(this.project).setColumns(s.name, type, field, to, { pack: this.project.wb.packName(s.pack) });
    } catch (e) {
      if (e instanceof ApiError) throw new OpError(e.message); // the session says why
      throw e;
    }
  }

  rowId(row: number): RowId {
    return this.rowIds[row]!;
  }

  fieldAt(row: number, col: number): CellField | null {
    if (this.kind !== "data") return null;
    const k = this.rowClass(row);
    const schema = this.project.schema;
    if (k.kind === "entity" && col >= 2) {
      const def = schema.types.get(k.type)?.fieldByName.get(this.columnName(k.type, col))?.def;
      return def ? { def, type: def.type, label: def.name } : null;
    }
    if (k.kind === "field" && col === 1) {
      const type = k.type ?? this.blockType(row);
      let def: FieldDef | undefined = type === null ? undefined : schema.types.get(type)?.fieldByName.get(k.path[0]!)?.def;
      for (const name of k.path.slice(1)) def = def?.type.kind === "struct" ? schema.structs.get(def.type.name)?.fields.find((x) => x.name === name) : undefined;
      return def ? { def, type: def.type, label: k.path.join(".") } : null;
    }
    return null;
  }

  /**
   * What a cell accepts if IDs are typed in it: a ref or list-of-refs field held whole, one
   * element of a list spread over columns (`projectiles[0]`), or a ref in a struct's split
   * columns (`price.currency`). Null for anything else.
   */
  refAt(row: number, col: number): RefTarget | null {
    if (this.kind !== "data") return null;
    const from = this.project.wb.sheet(this.sheet).pack;
    const whole = this.fieldAt(row, col);
    if (whole) return refTarget(whole.def, whole.type, from);
    const k = this.rowClass(row);
    if (k.kind !== "entity" || col < 2) return null;
    const m = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)(?:\[(\d+)\])?$/.exec(this.columnName(k.type, col));
    if (!m) return null;
    let def: FieldDef | undefined = this.project.schema.types.get(k.type)?.fieldByName.get(m[1]!)?.def;
    for (const sub of (m[2] ?? "").split(".").filter(Boolean))
      def = def?.type.kind === "struct" ? this.project.schema.structs.get(def.type.name)?.fields.find((f) => f.name === sub) : undefined;
    if (!def) return null;
    const type = m[3] !== undefined && def.type.kind === "list" ? def.type.of : def.type;
    return refTarget(def, type, from);
  }

  /** The singleton a `.field` row belongs to: the nearest header above it, as long as no entity row comes between. */
  private blockType(row: number): string | null {
    for (let r = row - 1; r >= 0; r--) {
      const k = this.rowClass(r);
      if (k.kind === "header") return k.type;
      if (k.kind === "entity") return null;
    }
    return null;
  }

  /** What column A makes the row (§6.2). */
  rowClass(row: number): RowClass {
    const r = this.rowIds[row];
    if (r === undefined || this.kind !== "data") return { kind: "scratch" };
    let k = this.classes.get(r);
    if (!k) {
      const a = this.colIds[0] === undefined ? "" : this.project.inputAt(this.sheet, r, this.colIds[0]);
      k = a.startsWith("=") ? { kind: "error", message: "Column A can't be a formula" } : classify(this.project.schema, a);
      this.classes.set(r, k);
    }
    return k;
  }

  /** The entity or singleton type a row belongs to, or null. */
  rowType(row: number): string | null {
    const k = this.rowClass(row);
    return k.kind === "entity" || k.kind === "header" ? k.type : k.kind === "field" ? k.type : null;
  }

  /** The column's name for rows of `type` (the sticky header): `type`, `id`, then its fields. */
  columnName(type: string | null, col: number): string {
    if (this.kind !== "data") return "";
    if (col === 0) return "type";
    const t = type === null ? undefined : this.project.schema.types.get(type);
    if (t?.def.singleton) return col === 1 ? "value" : "";
    if (col === 1) return "id";
    if (!t) return "";
    const c = this.colIds[col];
    if (c !== undefined) return this.specsFor(type!).get(c) ?? "";
    // A column the sheet doesn't have yet: the default layout's, by position.
    if (this.project.doc.sheets.get(this.sheet)!.layouts.has(type!)) return "";
    return defaultSpecs(t)[col - 2] ?? "";
  }

  /**
   * What typing `input` in a cell writes. In a cell holding a whole list of plain values or
   * IDs, a plain list is written as the JSON the cell holds, as the CLI reads it:
   * `HeavyBolt` is `["HeavyBolt"]`, `a, b` is `["a","b"]`, `1, 2` is `[1,2]`. Anything else
   * is written as typed.
   */
  typed(row: number, col: number, input: string): string {
    const k = this.kind === "data" && col >= 2 ? this.rowClass(row) : null;
    if (k?.kind !== "entity") return input;
    const spec = this.columnName(k.type, col);
    const field = this.project.schema.types.get(k.type)?.fieldByName.get(spec)?.def;
    return field ? listText(field.type, input) : input;
  }

  private specsFor(type: string): Map<ColId, string> {
    let m = this.specs.get(type);
    if (!m) {
      const t = this.project.schema.types.get(type)!;
      m = columnSpecs(this.project.schema, t, sheetLayout(this.project.schema, this.project.doc.sheets.get(this.sheet)!, type));
      this.specs.set(type, m);
    }
    return m;
  }

  /** The A1 address of a cell, as the grid counts it. */
  address(row: number, col: number): string {
    return `${numberToCol(col + 1)}${row + 1}`;
  }

  /**
   * Type these inputs, applying them to the project: the rows and columns they need first,
   * then the cells, all or nothing. The ops, for the task.
   */
  edit(cells: readonly CellEdit[]): { ops: Op[] } {
    const p = this.project;
    return this.all(() => {
      const edits: Edit[] = [];
      const maxRow = Math.max(...cells.map((c) => c.row));
      const maxCol = Math.max(...cells.map((c) => c.col));
      if (maxRow >= this.rowIds.length) edits.push(p.insert(this.sheet, "row", this.rowIds.length + 1, maxRow + 1 - this.rowIds.length));
      if (maxCol >= this.colIds.length) edits.push(p.insert(this.sheet, "col", this.colIds.length + 1, maxCol + 1 - this.colIds.length));
      return edits;
    }, (edits) => {
      for (const c of cells) {
        const a1 = this.address(c.row, c.col);
        edits.push(p.set(this.sheet, a1, this.typed(c.row, c.col, c.input)));
        if (c.format !== undefined) edits.push(p.setFormat(this.sheet, a1, c.format));
      }
    });
  }

  /** On a data sheet, columns A and B are the type and ID: they stay first (§6.2). */
  private fixedCols(): number {
    return this.kind === "data" ? Math.min(2, this.colIds.length) : 0;
  }

  /** Whether rows or columns at [from, from+count) may be deleted or moved. */
  canChange(axis: Axis, from: number, count: number): boolean {
    const len = axis === "row" ? this.rowIds.length : this.colIds.length;
    if (count < 1 || from < 0 || from >= len) return false;
    return axis === "row" || from >= this.fixedCols();
  }

  /** Insert `count` rows or columns before `at` (0-based; at the end is fine). Not before A or B on a data sheet. */
  insert(axis: Axis, at: number, count: number): { ops: Op[] } {
    const len = axis === "row" ? this.rowIds.length : this.colIds.length;
    if (count < 1 || at > len || (axis === "col" && at < this.fixedCols())) return { ops: [] };
    return this.all(() => [...this.pins(axis, at < len), this.project.insert(this.sheet, axis, at + 1, count)]);
  }

  /** Delete rows or columns. Formulas that pointed into them show #REF!. */
  remove(axis: Axis, from: number, count: number): { ops: Op[] } {
    const len = axis === "row" ? this.rowIds.length : this.colIds.length;
    if (!this.canChange(axis, from, count)) return { ops: [] };
    const n = Math.min(count, len - from);
    return this.all(() => [...this.pins(axis, true), this.project.remove(this.sheet, axis, from + 1, n)]);
  }

  /** Move `count` rows or columns at `from` so the first ends up at `to` (0-based), as Glide reports a drag. */
  move(axis: Axis, from: number, count: number, to: number): { ops: Op[] } {
    const len = axis === "row" ? this.rowIds.length : this.colIds.length;
    if (!this.canChange(axis, from, count) || to < 0 || to >= len || (axis === "col" && to < this.fixedCols()) || to === from) return { ops: [] };
    const n = Math.min(count, len - from);
    // Where they end up is where they go once taken out: Project.move counts the same way, 1-based.
    return this.all(() => [...this.pins(axis, true), this.project.move(this.sheet, axis, from + 1, n, to + 1)]);
  }

  /**
   * What a drag of these rows or columns moves: the ones the sheet has, less A and B on a
   * data sheet, in order. Empty if nothing can go.
   */
  movable(axis: Axis, indices: Iterable<number>): number[] {
    const len = axis === "row" ? this.rowIds.length : this.colIds.length;
    const from = axis === "col" ? this.fixedCols() : 0;
    return [...new Set(indices)].filter((i) => i >= from && i < len).sort((a, b) => a - b);
  }

  /**
   * Where a dragged set may land: a boundary between `min` and `max` (before that index).
   * Past the sheet's last row or column is fine, out among the blank ones the grid shows.
   */
  landing(axis: Axis): { min: number; max: number } {
    return { min: axis === "col" ? this.fixedCols() : 0, max: axis === "row" ? this.rows : this.cols };
  }

  /**
   * Move these rows or columns (0-based; any, not only side by side) so they land together
   * just before `before`, as the sheet is now (a drag's landing line). Landing past the
   * sheet's end, the blank rows or columns up to there are made first, in the same change.
   * Where the first of them ends up, or null when nothing moves.
   */
  moveTo(axis: Axis, indices: Iterable<number>, before: number): { ops: Op[]; at: number | null } {
    const set = this.movable(axis, indices);
    const { min, max } = this.landing(axis);
    if (set.length === 0 || before < min || before > max) return { ops: [], at: null };
    const at = before - set.filter((i) => i < before).length;
    // The fields are pinned to their columns first; if nothing then moves, that's undone.
    const res = this.all(() => {
      const pins = this.pins(axis, true);
      const len = axis === "row" ? this.rowIds.length : this.colIds.length;
      const room = before > len ? [this.project.insert(this.sheet, axis, len + 1, before - len)] : [];
      const e = this.project.moveSet(this.sheet, axis, set.map((i) => i + 1), before + 1);
      if (e.ops.length) return [...pins, ...room, e];
      for (const x of [...pins, ...room].reverse()) this.project.apply(x.inverse);
      return [];
    });
    return { ...res, at: res.ops.length ? at : null };
  }

  /** Before columns change on a data sheet, each type's fields are fixed to their columns. */
  private pins(axis: Axis, shifts: boolean): Edit[] {
    if (axis !== "col" || !shifts || this.kind !== "data") return [];
    const e = this.project.pinColumns(this.sheet);
    return e.ops.length ? [e] : [];
  }

  /**
   * Fill `to` from `from` (the fill handle, Ctrl+D, Ctrl+R), as Excel and Sheets do. Along
   * the fill, each line of the source (a column when filling down or up, a row when filling
   * across) carries on as a series when it is two or more numbers with a steady step (1, 2
   * gives 3, 4…), or text ending in such numbers ("Wave 1", "Wave 2" gives "Wave 3"). Anything
   * else repeats, formulas moving with each copy. A single cell is never taken for a series.
   * Formats repeat.
   */
  fill(from: Rect, to: Rect): { ops: Op[] } {
    const down = to.col === from.col && to.cols === from.cols && (to.row < from.row || to.row + to.rows > from.row + from.rows);
    const across = to.row === from.row && to.rows === from.rows && (to.col < from.col || to.col + to.cols > from.col + from.cols);
    // Each line along the fill: its series, if it is one.
    const series = new Map<number, Series | null>();
    const seriesOf = (line: number): Series | null => {
      if (!down && !across) return null;
      if (!series.has(line)) {
        const n = down ? from.rows : from.cols;
        const inputs = Array.from({ length: n }, (_, i) => (down ? this.cell(from.row + i, line) : this.cell(line, from.col + i)).input);
        series.set(line, seriesIn(inputs));
      }
      return series.get(line)!;
    };
    const cells: CellEdit[] = [];
    for (let r = to.row; r < to.row + to.rows; r++)
      for (let c = to.col; c < to.col + to.cols; c++) {
        if (r >= from.row && r < from.row + from.rows && c >= from.col && c < from.col + from.cols) continue;
        const sr = from.row + mod(r - from.row, from.rows);
        const sc = from.col + mod(c - from.col, from.cols);
        const src = this.cell(sr, sc);
        const s = seriesOf(down ? c : r);
        const input = s ? s.at(down ? r - from.row : c - from.col) : moveFormula(src.input, r - sr, c - sc);
        cells.push({ row: r, col: c, input, format: src.format });
      }
    return cells.length ? this.edit(cells) : { ops: [] };
  }

  /** Edits made one after another, as one: if one fails, those before it are taken back. */
  private all(first: () => Edit[], rest: (edits: Edit[]) => void = () => {}): { ops: Op[] } {
    const edits: Edit[] = [];
    try {
      edits.push(...first());
      rest(edits);
    } catch (e) {
      for (const x of edits.reverse()) this.project.apply(x.inverse);
      throw e;
    }
    return { ops: edits.flatMap((x) => x.ops) };
  }

  /** Ops setting (or, with null, clearing) format keys over a range; only cells the sheet has. */
  format(range: { row: number; col: number; rows: number; cols: number }, change: Format | null): { ops: Op[] } {
    return this.all(() => {
      const edits: Edit[] = [];
        for (let r = range.row; r < Math.min(range.row + range.rows, this.rowIds.length); r++)
        for (let c = range.col; c < Math.min(range.col + range.cols, this.colIds.length); c++) {
          const a1 = this.address(r, c);
          const had = this.project.format(this.sheet, this.rowIds[r]!, this.colIds[c]!);
          let next: Format | null = null;
          if (change !== null) {
            next = { ...had };
            for (const [k, v] of Object.entries(change)) if (v === false || v === "") delete next[k];
            else next[k] = v;
            if (Object.keys(next).length === 0) next = null;
          }
          if (JSON.stringify(next) !== JSON.stringify(had)) edits.push(this.project.setFormat(this.sheet, a1, next));
        }
      return edits;
    });
  }
}

/** A value as a cell shows it: numbers to 12 significant digits, so 50/3 doesn't run on. */
function shown(v: ReturnType<Project["engine"]["cellById"]>["value"]): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  return display(v);
}

/** A steady color per type, for the type gutter and the header tint. */
export function typeColor(type: string): string {
  let h = 0;
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 50%)`;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** A series a fill carries on: the value at index `i` along it (0 is the source's first). */
interface Series {
  at(i: number): string;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
/** Text around its last number: "star1.png" is "star", "1", ".png". */
const NUMBERED = /^(.*\D|)(\d+)(\D*)$/;

/**
 * The series in a line of typed inputs, or null: two or more plain numbers with a steady step,
 * or text that's the same around its last number, with a steady step in that number.
 * Formulas, blanks and anything uneven are no series.
 */
export function seriesIn(inputs: readonly string[]): Series | null {
  if (inputs.length < 2) return null;
  if (inputs.every((x) => NUMBER.test(x.trim()))) {
    const ns = inputs.map(Number);
    const step = steady(ns);
    if (step === null) return null;
    return { at: (i) => tidy(ns[0]! + i * step) };
  }
  const parts = inputs.map((x) => NUMBERED.exec(x));
  if (parts.every((m) => m !== null) && !inputs.some((x) => x.startsWith("=") || x.startsWith("'"))) {
    const stem = parts[0]![1]!;
    const tail = parts[0]![3]!;
    if (!parts.every((m) => m![1] === stem && m![3] === tail)) return null;
    const ns = parts.map((m) => Number(m![2]));
    const step = steady(ns);
    if (step === null) return null;
    const width = parts[0]![2]!.startsWith("0") ? parts[0]![2]!.length : 0; // "Wave 01" stays two digits
    return {
      at: (i) => {
        const n = ns[0]! + i * step;
        return n < 0 ? inputs[mod(i, inputs.length)]! : stem + String(n).padStart(width, "0") + tail;
      },
    };
  }
  return null;
}

/** The step between successive numbers, if it never changes. */
function steady(ns: readonly number[]): number | null {
  const step = ns[1]! - ns[0]!;
  for (let i = 2; i < ns.length; i++) if (Math.abs(ns[i]! - ns[i - 1]! - step) > 1e-9 * Math.max(1, Math.abs(step))) return null;
  return step;
}

/** 0.1 + 0.2 shows as 0.3. */
const tidy = (n: number): string => String(Number(n.toPrecision(15)));

const PLAIN = new Set<FieldType["kind"]>(["string", "ref", "enum", "int", "float", "duration", "bool", "datetime"]);

/** A plain list typed for a list of plain values or IDs, as its JSON (`a, b` is `["a","b"]`); anything else as it is. */
export function listText(type: FieldType, input: string): string {
  if (type.kind !== "list" || !PLAIN.has(type.of.kind)) return input;
  const t = input.trim();
  if (t === "" || /^[[=']/.test(t)) return input;
  const number = type.of.kind === "int" || type.of.kind === "float" || type.of.kind === "duration";
  const items = t.split(",").map((x) => x.trim()).filter((x) => x !== "");
  return JSON.stringify(
    items.map((x) => {
      if (number && x !== "" && Number.isFinite(Number(x))) return Number(x);
      if (type.of.kind === "bool" && /^(true|false)$/i.test(x)) return x.toLowerCase() === "true";
      return x;
    }),
  );
}
