// A type view (DESIGN §9.2): every entity of one type, from every sheet, as one grid. Each
// row is an entity's home row; each cell is a window on the home cell, so what it shows, its
// issue and its format are the home sheet's, and an edit is written there (as typed on that
// sheet, so a formula's references are the home sheet's).
//
// Columns: the home sheet, the ID, then the type's fields as the default layout names them,
// with any other columns a sheet's layout gives the type (a split list, a struct's parts)
// after them. A field a sheet has no column for shows blank there and can't be typed in.

import { columnSpecs, defaultSpecs, numberToCol, sheetLayout, type Edit, type Op, type Project, type RowId, type SheetId } from "@thek42/sapwood-core";
import { SheetGrid, type CellView } from "./grid.ts";
import { packTree, type PackNode } from "./home.ts";

export interface TypeRow {
  sheet: SheetId;
  sheetName: string;
  /** The home row, by ID and by position. */
  rowId: RowId;
  row: number;
  active: boolean;
}

/** Where a type view's cell lives: 0-based, as the home sheet's grid counts. */
export interface Home {
  sheet: SheetId;
  row: number;
  col: number;
}

const BLANK: CellView = { text: "", input: "", formula: false, number: false, error: false, format: null, issue: null };

export class TypeGrid {
  readonly project: Project;
  readonly type: string;
  readonly rows: TypeRow[];
  /** Column names after Sheet and id. */
  readonly specs: string[];
  private grids = new Map<SheetId, SheetGrid>();
  /** Per sheet: field spec to column position. */
  private colsBySheet = new Map<SheetId, Map<string, number>>();

  constructor(project: Project, type: string) {
    this.project = project;
    this.type = type;
    const t = project.schema.types.get(type);
    if (!t || t.def.singleton) throw new Error(`${type} isn't an entity type`);

    // Sheets in pack-tree order, rows down each.
    const order = new Map<string, number>();
    const walk = (p: PackNode) => {
      for (const s of p.sheets) order.set(s.id, order.size);
      p.packs.forEach(walk);
    };
    walk(packTree(project.doc, []).root);
    const pos = new Map<SheetId, Map<RowId, number>>();
    const rowPos = (s: SheetId, r: RowId) => {
      let m = pos.get(s);
      if (!m) pos.set(s, (m = new Map(project.wb.sheet(s).rows.liveIds().map((id, i) => [id, i]))));
      return m.get(r) ?? -1;
    };
    this.rows = project
      .project()
      .entities.filter((e) => e.type === type)
      .map((e) => ({ sheet: e.at.sheet, sheetName: project.wb.sheet(e.at.sheet).name, rowId: e.at.row, row: rowPos(e.at.sheet, e.at.row), active: e.active }))
      .sort((a, b) => (order.get(a.sheet) ?? 0) - (order.get(b.sheet) ?? 0) || a.row - b.row);

    const specs = defaultSpecs(t);
    for (const s of new Set(this.rows.map((r) => r.sheet))) {
      const colIndex = new Map(project.wb.sheet(s).cols.liveIds().map((id, i) => [id, i]));
      const bySpec = new Map<string, number>();
      for (const [col, spec] of columnSpecs(project.schema, t, sheetLayout(project.schema, project.doc.sheets.get(s)!, type))) {
        const i = colIndex.get(col);
        if (i === undefined) continue;
        bySpec.set(spec, i);
        if (!specs.includes(spec)) specs.push(spec);
      }
      this.colsBySheet.set(s, bySpec);
    }
    this.specs = specs;
  }

  get cols(): number {
    return 2 + this.specs.length;
  }

  columnName(col: number): string {
    return col === 0 ? "Sheet" : col === 1 ? "id" : (this.specs[col - 2] ?? "");
  }

  /** The home cell, or null: the Sheet column, past the end, or a field the sheet has no column for. */
  home(row: number, col: number): Home | null {
    const r = this.rows[row];
    if (!r || col < 1) return null;
    const c = col === 1 ? 1 : this.colsBySheet.get(r.sheet)?.get(this.specs[col - 2] ?? "");
    return c === undefined ? null : { sheet: r.sheet, row: r.row, col: c };
  }

  private grid(sheet: SheetId): SheetGrid {
    let g = this.grids.get(sheet);
    if (!g) this.grids.set(sheet, (g = new SheetGrid(this.project, sheet)));
    return g;
  }

  cell(row: number, col: number): CellView {
    const r = this.rows[row];
    if (!r) return BLANK;
    if (col === 0) return { ...BLANK, text: r.sheetName, input: r.sheetName };
    const h = this.home(row, col);
    return h ? this.grid(h.sheet).cell(h.row, h.col) : BLANK;
  }

  /** "Weapons!F2". */
  address(row: number, col: number): string {
    const h = this.home(row, col);
    if (!h) return "";
    return `${this.project.wb.sheet(h.sheet).name}!${numberToCol(h.col + 1)}${h.row + 1}`;
  }

  /** Errors and warnings on the type's rows. */
  get counts(): { errors: number; warnings: number } {
    const c = { errors: 0, warnings: 0 };
    for (const r of this.rows)
      for (const x of this.grid(r.sheet).issueCells())
        if (x.row === r.row) x.issue.level === "error" ? c.errors++ : c.warnings++;
    return c;
  }

  /** The worst issue on a row, for its marker. */
  rowLevel(row: number): "error" | "warning" | null {
    const r = this.rows[row];
    return r ? this.grid(r.sheet).rowLevel(r.row) : null;
  }

  /** Type these inputs into their home cells, all or nothing. Cells with no home are skipped. */
  edit(cells: readonly { row: number; col: number; input: string }[]): { ops: Op[] } {
    const edits: Edit[] = [];
    try {
      for (const c of cells) {
        const h = this.home(c.row, c.col);
        if (h) edits.push(this.project.set(h.sheet, `${numberToCol(h.col + 1)}${h.row + 1}`, this.grid(h.sheet).typed(h.row, h.col, c.input)));
      }
    } catch (e) {
      for (const x of edits.reverse()) this.project.apply(x.inverse);
      throw e;
    }
    return { ops: edits.flatMap((x) => x.ops) };
  }
}
