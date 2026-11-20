// A project: schema + workbook (packs, sheets, cells) + formula engine, and the
// entities derived from them (DESIGN §4.1). Sheets are the truth; entities and
// singletons are a projection, recomputed from the sheets.
//
// This is the in-memory model that validation and export read. Edits go through
// `set` for now; ops (DESIGN §8) arrive in a later slice and will call the same code.

import { Engine } from "../formula/engine.ts";
import { Workbook, type ColId, type PackId, type RowId, type SheetId, type SheetKind } from "../formula/model.ts";
import { formatNumber, isErr, type Scalar } from "../formula/values.ts";
import type { FieldDef, FieldType } from "../schema/model.ts";
import type { ResolvedField, ResolvedSchema, ResolvedType } from "../schema/resolve.ts";
import { buildLayout, defaultSpecs, type Layout, type LayoutColumn } from "./layout.ts";
import { classify, type RowClass } from "./rows.ts";
import { parseCell, type FieldValue } from "./values.ts";

/** Where something is: a sheet, a row, and optionally a column, all by stable ID. */
export interface Location {
  sheet: SheetId;
  row: RowId;
  col?: ColId;
}

export interface Issue {
  level: "error" | "warning";
  /** Stable kind, for tests and filtering: "row.unknown-type", "cell.parse", … */
  code: string;
  message: string;
  /** Absent for issues that aren't about one place, such as a missing required singleton field. */
  at?: Location;
}

/** One field of one entity or singleton, as read from its cells. */
export interface FieldEntry {
  field: FieldDef;
  /** Absent when the cells are blank or don't parse. */
  value?: FieldValue;
  /** The cells it came from (several for split columns). */
  cells: Location[];
  /** Any of its cells holds a formula. */
  formula: boolean;
  /** A cell failed to parse (already reported), so a missing value isn't "blank". */
  invalid?: boolean;
}

export interface Entity {
  type: string;
  /** null when column B is blank or isn't text. */
  id: string | null;
  pack: PackId;
  at: Location;
  active: boolean;
  fields: Map<string, FieldEntry>;
}

export interface SingletonEntry {
  type: string;
  /** Field name, then struct sub-fields. */
  path: string[];
  field: FieldDef;
  at: Location;
  active: boolean;
  qualified: boolean;
  value?: FieldValue;
  formula: boolean;
  invalid?: boolean;
}

export interface Projection {
  entities: Entity[];
  singletons: SingletonEntry[];
  /** Problems found while reading: row classification and cell parsing. */
  issues: Issue[];
}

export class Project {
  readonly schema: ResolvedSchema;
  readonly wb: Workbook;
  readonly engine: Engine;
  /** sheet -> type name -> layout. Missing means the default layout. */
  private layouts = new Map<SheetId, Map<string, Layout>>();

  constructor(schema: ResolvedSchema, rootPack = "root") {
    this.schema = schema;
    this.wb = new Workbook(rootPack);
    this.engine = new Engine(this.wb);
    this.engine.setEntityTypes((name) => {
      const t = schema.types.get(name);
      return t !== undefined && !t.def.singleton;
    });
  }

  // ------------------------------------------------------------ structure

  addPack(name: string, parent: PackId = this.wb.root): PackId {
    return this.wb.addPack(name, parent);
  }

  addSheet(name: string, pack: PackId = this.wb.root, kind: SheetKind = "data"): SheetId {
    const id = this.wb.addSheet(name, pack, kind);
    this.syncLayouts(id);
    return id;
  }

  sheetId(name: string, pack: PackId = this.wb.root): SheetId {
    const s = this.wb.findSheet(pack, name);
    if (!s) throw new Error(`No sheet "${name}" in pack ${pack}`);
    return s.id;
  }

  /** Set the columns (from C) for a type on a sheet, as field specs: `cooldown`, `price.amount`, `projectiles[0]`. */
  setLayout(sheet: SheetId, type: string, specs: readonly string[]): void {
    const t = this.schema.types.get(type);
    if (!t) throw new Error(`Unknown type ${type}`);
    const { layout, errors } = buildLayout(this.schema, t, specs, this.colsFromC(sheet, specs.length));
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
    let bySheet = this.layouts.get(sheet);
    if (!bySheet) this.layouts.set(sheet, (bySheet = new Map()));
    bySheet.set(type, layout);
    this.syncLayouts(sheet);
  }

  layout(sheet: SheetId, type: string): Layout {
    const custom = this.layouts.get(sheet)?.get(type);
    if (custom) return custom;
    const t = this.schema.types.get(type)!;
    return buildLayout(this.schema, t, defaultSpecs(t), this.colsFromC(sheet, t.fields.length)).layout;
  }

  private colsFromC(sheet: SheetId, n: number): ColId[] {
    const cols = this.wb.sheet(sheet).cols;
    return Array.from({ length: n }, (_, i) => cols.idAt(3 + i));
  }

  /** Tell the engine which column holds each single-cell field, for `ENTITY(id).field`. */
  private syncLayouts(sheet: SheetId): void {
    if (this.wb.sheet(sheet).kind !== "data") return;
    for (const [name, t] of this.schema.types) {
      if (t.def.singleton) continue;
      // Every field is known to formulas; one without a single column of its own reads as blank.
      const cols = new Map<string, ColId | null>(t.fields.map((f) => [f.def.name, null]));
      for (const c of this.layout(sheet, name)) {
        if (c.path.length || c.index !== undefined) continue;
        cols.set(t.fields.find((f) => f.def.id === c.field)!.def.name, c.col);
      }
      this.engine.setLayoutColumns(sheet, name, cols);
    }
  }

  // ------------------------------------------------------------ cells

  /** Set a cell from user input, by A1 address. */
  set(sheet: SheetId, a1: string, input: string): void {
    this.engine.set(sheet, a1, input);
  }

  /** Write rows of inputs starting at row 1 (or `fromRow`). Values are typed as in a cell. */
  setRows(sheet: SheetId, rows: readonly (readonly string[])[], fromRow = 1): void {
    this.engine.batch(() => rows.forEach((r, i) => r.forEach((v, j) => v !== "" && this.engine.setAt(sheet, fromRow + i, j + 1, v))));
  }

  // ------------------------------------------------------------ projection

  /** Read every data sheet into entities and singleton entries. */
  project(): Projection {
    const out: Projection = { entities: [], singletons: [], issues: [] };
    for (const s of this.wb.sheets.values()) if (s.kind === "data") this.projectSheet(s.id, out);
    return out;
  }

  private projectSheet(sheet: SheetId, out: Projection): void {
    const s = this.wb.sheet(sheet);
    if (s.cols.length < 1) return;
    const colA = s.cols.idAt(1);
    const colB = s.cols.length >= 2 ? s.cols.idAt(2) : null;
    let block: { type: string; active: boolean } | null = null;
    const layouts = new Map<string, Map<string, LayoutColumn[]>>(); // per type, by field ID
    const layoutOf = (type: string) => {
      let l = layouts.get(type);
      if (!l) layouts.set(type, (l = groupBy(this.layout(sheet, type), (c) => c.field)));
      return l;
    };
    for (const row of s.rows.liveIds()) {
      const a = this.engine.cellById(sheet, row, colA);
      const at: Location = { sheet, row };
      if (a.formula) {
        out.issues.push({ level: "error", code: "row.formula-type", message: "Column A holds the row type and can't be a formula", at: { ...at, col: colA } });
        continue;
      }
      const text = a.value === null ? "" : typeof a.value === "string" ? a.value : String(a.value);
      const rc: RowClass = classify(this.schema, text);
      switch (rc.kind) {
        case "scratch":
        case "comment":
          break;
        case "error":
          out.issues.push({ level: "error", code: "row.unknown-type", message: rc.message, at: { ...at, col: colA } });
          break;
        case "header":
          block = { type: rc.type, active: rc.active };
          break;
        case "entity":
          block = null;
          out.entities.push(this.readEntity(sheet, row, colB, rc.type, rc.active, layoutOf(rc.type), out.issues));
          break;
        case "field": {
          let type = rc.type;
          let active = rc.active;
          if (type === null) {
            if (!block) {
              out.issues.push({ level: "error", code: "row.field-outside-block", message: `".${rc.path.join(".")}" isn't inside a singleton block: add a header row naming the singleton, or write Type.${rc.path.join(".")}`, at: { ...at, col: colA } });
              break;
            }
            type = block.type;
            active = active && block.active;
          }
          const e = this.readSingletonField(sheet, row, colB, type, rc.path, active, rc.type !== null, out.issues);
          if (e) out.singletons.push(e);
          break;
        }
      }
    }
  }

  private readEntity(
    sheet: SheetId,
    row: RowId,
    colB: ColId | null,
    type: string,
    active: boolean,
    byField: Map<string, LayoutColumn[]>,
    issues: Issue[],
  ): Entity {
    const t = this.schema.types.get(type)!;
    const pack = this.wb.sheet(sheet).pack;
    let id: string | null = null;
    if (colB) {
      const b = this.engine.cellById(sheet, row, colB);
      if (isErr(b.value)) {
        if (active) issues.push({ level: "error", code: "id.error", message: `The ID formula fails: ${b.value.code}${b.value.detail ? " " + b.value.detail : ""}`, at: { sheet, row, col: colB } });
      } else if (typeof b.value === "string" && b.value !== "") id = b.value;
      else if (b.value !== null && b.value !== "" && active)
        issues.push({ level: "error", code: "id.not-text", message: `IDs are text, not ${typeof b.value === "number" ? "numbers" : "TRUE/FALSE"}: type '${display(b.value)} to keep it as text`, at: { sheet, row, col: colB } });
    }
    const fields = new Map<string, FieldEntry>();
    for (const f of t.fields) {
      const cols = byField.get(f.def.id);
      if (!cols) continue;
      const entry = this.readField(sheet, row, f, cols, active, issues);
      fields.set(f.def.name, entry);
    }
    return { type, id, pack, at: { sheet, row }, active, fields };
  }

  /** Read one field from its column(s): whole, split struct, or repeated list. */
  private readField(sheet: SheetId, row: RowId, f: ResolvedField, cols: LayoutColumn[], active: boolean, issues: Issue[]): FieldEntry {
    const entry: FieldEntry = { field: f.def, cells: cols.map((c) => ({ sheet, row, col: c.col })), formula: false };
    const cell = (col: ColId, type: FieldType) => {
      const c = this.engine.cellById(sheet, row, col);
      if (c.formula) entry.formula = true;
      const r = parseCell(this.schema, type, c.value, c.formula);
      if (r && !r.ok) {
        entry.invalid = true;
        if (active) issues.push({ level: "error", code: "cell.parse", message: `${f.def.name}: ${r.message}`, at: { sheet, row, col } });
      }
      return r;
    };
    const whole = cols.find((c) => !c.path.length && c.index === undefined);
    if (whole) {
      const r = cell(whole.col, f.def.type);
      if (r?.ok) entry.value = r.value;
      return entry;
    }
    if (cols[0]!.index !== undefined) {
      // Repeated columns (§6.4): trailing blanks are trimmed; a blank before a filled one is an error.
      if (f.def.type.kind !== "list") return entry;
      const of = f.def.type.of;
      const sorted = [...cols].sort((x, y) => x.index! - y.index!);
      const items: (FieldValue | undefined)[] = [];
      let bad = false;
      for (const c of sorted) {
        const r = cell(c.col, of);
        if (r && !r.ok) bad = true;
        items[c.index!] = r?.ok ? r.value : undefined;
      }
      while (items.length && items[items.length - 1] === undefined) items.pop();
      const gap = items.findIndex((x) => x === undefined);
      if (gap >= 0) entry.invalid = true;
      if (gap >= 0 && !bad && active)
        issues.push({ level: "error", code: "cell.list-gap", message: `${f.def.name}[${gap}] is blank but a later column is filled`, at: { sheet, row, col: sorted.find((c) => c.index === gap)?.col ?? sorted[0]!.col } });
      if (!bad && gap < 0 && items.length) entry.value = items as FieldValue[];
      return entry;
    }
    // Flattened struct sub-columns (§5.6): build the object from its parts.
    let obj: { [k: string]: FieldValue } | undefined;
    let bad = false;
    for (const c of cols) {
      const defs = this.subFields(f.def, c.path);
      if (!defs) continue;
      const r = cell(c.col, defs[defs.length - 1]!.type);
      if (r && !r.ok) bad = true;
      if (!r?.ok) continue;
      obj ??= {};
      let o = obj;
      for (const d of defs.slice(0, -1)) o = (o[d.name] ??= {}) as { [k: string]: FieldValue };
      o[defs[defs.length - 1]!.name] = r.value;
    }
    if (obj && !bad) entry.value = obj;
    return entry;
  }

  /** The field definitions along a struct path of field IDs. */
  private subFields(top: FieldDef, path: string[]): FieldDef[] | null {
    const out: FieldDef[] = [];
    let def = top;
    for (const id of path) {
      if (def.type.kind !== "struct") return null;
      const f = this.schema.structs.get(def.type.name)?.fields.find((x) => x.id === id);
      if (!f) return null;
      out.push(f);
      def = f;
    }
    return out;
  }

  private readSingletonField(
    sheet: SheetId,
    row: RowId,
    colB: ColId | null,
    type: string,
    path: string[],
    active: boolean,
    qualified: boolean,
    issues: Issue[],
  ): SingletonEntry | null {
    const t: ResolvedType = this.schema.types.get(type)!;
    const colA = this.wb.sheet(sheet).cols.idAt(1);
    const top = t.fieldByName.get(path[0]!);
    if (!top) {
      if (active) issues.push({ level: "error", code: "row.unknown-field", message: `${type} has no field "${path[0]}"`, at: { sheet, row, col: colA } });
      return null;
    }
    let def = top.def;
    for (const name of path.slice(1)) {
      const s = def.type.kind === "struct" ? this.schema.structs.get(def.type.name) : undefined;
      const f = s?.fields.find((x) => x.name === name);
      if (!f) {
        if (active) issues.push({ level: "error", code: "row.unknown-field", message: s ? `${s.name} has no field "${name}"` : `"${def.name}" isn't a struct, so it has no "${name}"`, at: { sheet, row, col: colA } });
        return null;
      }
      def = f;
    }
    const entry: SingletonEntry = { type, path, field: def, at: { sheet, row }, active, qualified, formula: false };
    if (!colB) return entry;
    const c = this.engine.cellById(sheet, row, colB);
    entry.formula = c.formula;
    const r = parseCell(this.schema, def.type, c.value, c.formula);
    if (r && !r.ok) entry.invalid = true;
    if (r && !r.ok && active) issues.push({ level: "error", code: "cell.parse", message: `${path.join(".")}: ${r.message}`, at: { sheet, row, col: colB } });
    if (r?.ok) entry.value = r.value;
    return entry;
  }
}

function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

function display(v: Scalar): string {
  return typeof v === "number" ? formatNumber(v) : String(v);
}
