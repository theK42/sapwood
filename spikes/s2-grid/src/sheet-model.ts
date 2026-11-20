/**
 * The grid-independent side of the spike: our engine, our ops and our validation.
 * Grid adapters only read through `cell()` and write through `apply()`, so the
 * component never owns any data.
 */
import { Engine } from "../../s1-formula/src/engine.ts";
import { Workbook, type ColId, type RowId, type SheetId } from "../../s1-formula/src/model.ts";
import { display, isErr, type Scalar } from "../../s1-formula/src/values.ts";

export type FieldKind = "number" | "text" | { ref: string };
export interface TypeDef {
  name: string;
  color: string;
  fields: { name: string; kind: FieldKind }[];
}

export const TYPES: TypeDef[] = [
  {
    name: "Weapon",
    color: "#d9822b",
    fields: [
      { name: "damage", kind: "number" },
      { name: "cooldown", kind: "number" },
      { name: "projectile", kind: { ref: "Projectile" } },
      { name: "dps", kind: "number" },
      { name: "impact", kind: "number" },
    ],
  },
  {
    name: "Projectile",
    color: "#2b95d9",
    fields: [
      { name: "speed", kind: "number" },
      { name: "lifetime", kind: "number" },
      { name: "sprite", kind: "text" },
    ],
  },
];
const typeByName = new Map(TYPES.map((t) => [t.name, t]));

/** An op names cells by stable IDs, never by position. */
export interface SetOp {
  kind: "set";
  sheet: SheetId;
  cells: { row: RowId; col: ColId; input: string; prev: string }[];
}
export type Op = SetOp;

export interface Issue {
  level: "error" | "warning";
  message: string;
}

export interface CellView {
  /** What the editor and the formula bar show. */
  input: string;
  /** What the cell shows. */
  text: string;
  value: Scalar;
  isFormula: boolean;
  issue: Issue | null;
}

export const COLS = 12;

export function colName(c: number): string {
  let s = "";
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export class SheetModel {
  readonly wb = new Workbook();
  readonly engine = new Engine(this.wb);
  readonly sheet: SheetId;
  readonly undo: Op[] = [];
  readonly redo: Op[] = [];
  /** Bumped by every applied op; adapters use it to know when to repaint. */
  version = 0;
  lastEditMs = 0;
  lastEvaluations = 0;
  /** 1-based [row, col] of cells written or recalculated by the last op. */
  lastChanged: [number, number][] = [];
  private listeners = new Set<() => void>();
  private idCache: { version: number; counts: Map<string, number>; byType: Map<string, Set<string>> } | null = null;

  constructor(rows: number) {
    this.sheet = this.wb.addSheet("Arsenal");
    const t0 = performance.now();
    this.engine.batch(() => {
      for (const t of TYPES) this.engine.setLayout(this.sheet, t.name, t.fields.map((f) => f.name));
      fillDemo(this.engine, this.sheet, rows);
    });
    this.loadMs = performance.now() - t0;
    this.engine.takeChanged();
  }
  readonly loadMs: number;

  get rowCount(): number {
    return this.wb.sheet(this.sheet).rows.length;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------ reading

  /** 1-based row/col. Reading never materialises rows or columns. */
  private ids(r: number, c: number): { row: RowId; col: ColId } | null {
    const s = this.wb.sheet(this.sheet);
    if (r > s.rows.length || c > s.cols.length) return null;
    return { row: s.rows.idAt(r), col: s.cols.idAt(c) };
  }

  rowType(r: number): TypeDef | null {
    const a = this.engine.getAt(this.sheet, r, 1);
    return typeof a === "string" ? (typeByName.get(a) ?? null) : null;
  }

  /** Input text for a cell, i.e. what typing it back in would reproduce. */
  input(r: number, c: number): string {
    if (!this.ids(r, c)) return "";
    const f = this.engine.formula(this.sheet, colName(c) + r);
    if (f !== null) return f;
    const v = this.engine.getAt(this.sheet, r, c);
    if (v === null) return "";
    if (typeof v === "string" && /^[+-]?(\d|\.\d)|^(true|false)$|^=/i.test(v)) return "'" + v;
    return display(v);
  }

  cell(r: number, c: number): CellView {
    if (!this.ids(r, c)) return { input: "", text: "", value: null, isFormula: false, issue: null };
    const value = this.engine.getAt(this.sheet, r, c);
    const input = this.input(r, c);
    return {
      input,
      text: value === null ? "" : display(value),
      value,
      isFormula: input.startsWith("="),
      issue: this.validate(r, c, value, input),
    };
  }

  /** Field name for a column of a row's type, if the column is in the layout. */
  fieldAt(type: TypeDef | null, c: number): TypeDef["fields"][number] | null {
    return type ? (type.fields[c - 3] ?? null) : null;
  }

  // ------------------------------------------------------------ validation (a stand-in for DESIGN §5.7)

  private idIndex() {
    if (this.idCache?.version === this.version) return this.idCache;
    const counts = new Map<string, number>();
    const byType = new Map<string, Set<string>>();
    for (const { type, id } of this.engine.entityIds().values()) {
      const k = id.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
      let s = byType.get(type);
      if (!s) byType.set(type, (s = new Set()));
      s.add(k);
    }
    return (this.idCache = { version: this.version, counts, byType });
  }

  validate(r: number, c: number, value: Scalar, input: string): Issue | null {
    const a = this.engine.getAt(this.sheet, r, 1);
    if (c === 1) {
      if (typeof a !== "string" || a === "" || a.startsWith("#") || typeByName.has(a)) return null;
      return { level: "error", message: `Unknown type '${a}'. Use #… to comment a row out.` };
    }
    const type = this.rowType(r);
    if (!type) return null;
    if (isErr(value)) return { level: "error", message: `${value.code} ${value.detail ?? ""}`.trim() };
    if (c === 2) {
      if (value === null || value === "") return { level: "error", message: "Missing ID" };
      if ((this.idIndex().counts.get(String(value).toLowerCase()) ?? 0) > 1)
        return { level: "error", message: `Duplicate ID '${display(value)}'` };
      if (/\b(ROW|COLUMN)\s*\(/i.test(input))
        return { level: "warning", message: "This ID uses ROW()/COLUMN(): moving the row renames the entity" };
      return null;
    }
    const field = this.fieldAt(type, c);
    if (!field) return null;
    if (value === null || value === "") return null;
    if (field.kind === "number" && typeof value !== "number")
      return { level: "error", message: `${field.name} must be a number` };
    if (typeof field.kind === "object" && !this.idIndex().byType.get(field.kind.ref)?.has(String(value).toLowerCase()))
      return { level: "error", message: `No ${field.kind.ref} named '${display(value)}'` };
    return null;
  }

  // ------------------------------------------------------------ writing: ops are the truth

  /** Turn a positional edit from a grid into an op on stable IDs. */
  setOp(cells: { r: number; c: number; input: string }[]): SetOp {
    const s = this.wb.sheet(this.sheet);
    return {
      kind: "set",
      sheet: this.sheet,
      cells: cells.map(({ r, c, input }) => ({ row: s.rows.idAt(r), col: s.cols.idAt(c), input, prev: this.input(r, c) })),
    };
  }

  apply(op: Op, from: "edit" | "undo" | "redo" = "edit"): void {
    const s = this.wb.sheet(op.sheet);
    const t0 = performance.now();
    this.engine.batch(() => {
      for (const x of op.cells) {
        const r = s.rows.posOf(x.row);
        const c = s.cols.posOf(x.col);
        if (r !== null && c !== null) this.engine.setAt(op.sheet, r, c, x.input);
      }
    });
    this.lastEditMs = performance.now() - t0;
    this.lastEvaluations = this.engine.lastEvaluations;
    this.lastChanged = [];
    for (const x of this.engine.takeChanged()) {
      if (x.sheet !== op.sheet) continue;
      const r = s.rows.posOf(x.row);
      const c = s.cols.posOf(x.col);
      if (r !== null && c !== null) this.lastChanged.push([r, c]);
    }
    if (from === "edit") {
      this.undo.push(op);
      this.redo.length = 0;
    }
    this.version++;
    for (const l of this.listeners) l();
  }

  edit(cells: { r: number; c: number; input: string }[]): void {
    const op = this.setOp(cells);
    if (op.cells.some((x) => x.input !== x.prev)) this.apply(op);
  }

  undoLast(): void {
    const op = this.undo.pop();
    if (!op) return;
    this.redo.push(op);
    this.apply({ ...op, cells: op.cells.map((x) => ({ ...x, input: x.prev, prev: x.input })).reverse() }, "undo");
  }

  redoLast(): void {
    const op = this.redo.pop();
    if (!op) return;
    this.undo.push(op);
    this.apply(op, "redo");
  }
}

// ------------------------------------------------------------ demo content

function fillDemo(e: Engine, sh: SheetId, rows: number): void {
  const put = (r: number, vals: string[]) => vals.forEach((v, i) => v !== "" && e.setAt(sh, r, i + 1, v));
  // A hand-written showcase at the top, then bulk rows.
  put(1, ["# Showcase. Try: edit C2 (the prefix), C5 (damage), or type Weapn in A6."]);
  put(2, ["", "prefix", "mk"]);
  put(3, ["Projectile", "bolt", "900", "2", "bolt.png"]);
  put(4, ["Projectile", "plasma", "600", "3", "plasma.png"]);
  put(5, ["Weapon", '=$C$2&"_blaster"', "10", "0.5", "bolt", "=C5/D5", "=ENTITY(E5).speed*C5"]);
  put(6, ["Weapon", "rifle", '=ENTITY("mk_blaster").damage*2', "1.2", "bolt", "=C6/D6", "=ENTITY(E6).speed*C6"]);
  put(7, ["Weapon", "cannon", "fifty", "3", "plasma", "=C7/D7", "=ENTITY(E7).speed*C7"]);
  put(8, ["Weapon", "rifle", "12", "1", "rocket", "=C8/D8", "=ENTITY(E8).speed*C8"]);
  put(9, ["Weapon", '="auto_"&ROW()', "4", "0.1", "bolt", "=C9/D9", "=ENTITY(E9).speed*C9"]);
  put(10, ["#Weapon", "retired_gun", "1", "1", "bolt", "=C10/D10"]);
  put(11, ["", "Total dps", '=SUM(ENTITIES("Weapon", "dps"))', "", "Weapons", '=ROWS(ENTITIES("Weapon"))']);
  put(12, ["# Bulk rows: one Projectile, then four Weapons that use it."]);
  for (let r = 13, g = 0; r <= rows; g++) {
    const p = `p${g}`;
    put(r++, ["Projectile", p, String(300 + (g % 700)), String(1 + (g % 4)), `${p}.png`]);
    for (let k = 0; k < 4 && r <= rows; k++, r++) {
      put(r, ["Weapon", `w${g}_${k}`, String(5 + ((g * 7 + k * 3) % 90)), String(0.25 * (1 + ((g + k) % 8))), p, `=C${r}/D${r}`, `=ENTITY(E${r}).speed*C${r}`]);
    }
  }
}
