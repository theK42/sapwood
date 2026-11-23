// One sheet of a project as the grid shows it (DESIGN §6, §9.2), apart from any grid
// component: what each cell shows and holds, what each row is, the column names for a row's
// type (the sticky header), the validation issues by cell, and edits by position.
//
// The grid shows some empty rows and columns past the sheet's end. Typing into one makes the
// rows or columns up to it first, in the same change.

import {
  classify, columnSpecs, defaultSpecs, display, isErr, numberToCol, sheetLayout, validate,
  type ColId, type Edit, type Format, type Issue, type Op, type Project, type RowClass, type RowId, type SheetId,
} from "@thek42/sapwood-core";

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
}

export interface CellEdit {
  /** 0-based row and column, as the grid counts. */
  row: number;
  col: number;
  input: string;
}

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
    return { text: shown(value), input, formula, number: typeof value === "number", error: isErr(value), format, issue };
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
      for (const c of cells) edits.push(p.set(this.sheet, this.address(c.row, c.col), c.input));
    });
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
