// The project API (DESIGN §9.4): what the CLI, the HTTP API and the MCP server offer,
// over one in-memory project.
//
// Reads give entities as JSON. Writes are entity-level patches: a field is written to
// the cells the sheet's layout gives it (one cell, a struct's sub-columns, or a list's
// repeated columns), and every write is ops applied to the project, so it can be undone,
// recorded in a task, and rebased. A write that would replace a formula fails unless
// forced. Tasks, branches and landing are the server's (Phase 2); this is the layer under them.

import type { Content, Literal } from "../formula/content.ts";
import type { ColId, PackId, RowId, SheetId } from "../formula/model.ts";
import { numberToCol } from "../formula/parse.ts";
import { exportJson, valueJson, type ExportFile, type ExportOptions, type JsonOut } from "../export/json.ts";
import type { Doc } from "../ops/doc.ts";
import { undoAll, type Op } from "../ops/ops.ts";
import { renameIdFormulas } from "../ops/rename.ts";
import { formatSchema } from "../schema/yaml.ts";
import type { FieldDef, FieldType } from "../schema/model.ts";
import type { ResolvedSchema, ResolvedType } from "../schema/resolve.ts";
import type { LayoutColumn } from "../project/layout.ts";
import { loadProject, type ProjectDef } from "../project/load.ts";
import { Project, type Entity, type Issue, type SingletonEntry } from "../project/project.ts";
import { classify } from "../project/rows.ts";
import { validate } from "../project/validate.ts";
import { parseJson } from "../project/values.ts";

export type JsonValue = JsonOut;

/**
 * An entity as JSON (§9.4). Fields follow the schema's order; blank fields are left out.
 * A field computed by a formula is `{ "$value": …, "$formula": "=…" }`; one whose cell
 * doesn't parse is `{ "$invalid": <what the cell holds> }`. Refs are IDs.
 */
export interface EntityJson {
  $type: string;
  $id: string;
  /** Pack and sheet names. */
  $pack: string;
  $sheet: string;
  $active: boolean;
  [field: string]: JsonValue;
}

/**
 * A singleton as JSON: its fields, from their field rows (§6.8), shaped like an entity's.
 * A struct split into rows (`.cost.amount`) reads as one object.
 */
export interface SingletonJson {
  $type: string;
  /** The pack it lives in. */
  $pack: string;
  [field: string]: JsonValue;
}

export type ApiErrorCode =
  | "not-found" // no entity with that ID, or no such sheet or pack
  | "ambiguous" // more than one entity (or sheet) matches
  | "exists" // the ID is taken (IDs are unique regardless of case)
  | "unknown-type"
  | "singleton" // singletons aren't entities: they have no ID
  | "unknown-field"
  | "no-column" // the sheet's layout for the type has no column for the field
  | "formula" // the field is computed by a formula; pass force to replace it
  | "bad-value"
  | "no-sheet"; // a new entity's sheet can't be decided: say which

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** One line of a patch file (`sapwood apply patch.jsonl`). */
export type Patch =
  | { op: "set"; id: string; fields: Record<string, JsonValue>; force?: boolean }
  | { op: "create"; type: string; fields: Record<string, JsonValue>; sheet?: string; pack?: string; after?: string }
  | { op: "commentOut" | "uncomment" | "delete"; id: string }
  | { op: "setSingleton"; type: string; fields: Record<string, JsonValue>; force?: boolean };

/** Where a new entity goes. By default: after the last one of its type, or on the only data sheet. */
export interface Placement {
  /** Sheet name. */
  sheet?: string;
  /** Pack name: the sheet is looked for there. */
  pack?: string;
  /** Put the row right after this entity's. */
  after?: string;
}

export interface Change {
  ops: Op[];
  /** Applying these undoes the change. */
  inverse: Op[];
  /** Formulas that mention an ID the change renamed: left as they are, for the caller to review. */
  formulas: CellAddress[];
}

export interface CellAddress {
  sheet: string;
  /** A1 address, such as "C2". */
  cell: string;
}

/** A validation issue, located by names and an A1 address rather than stable IDs. */
export interface IssueJson {
  level: "error" | "warning";
  code: string;
  message: string;
  sheet?: string;
  /** The cell, or just the row number when the issue is about a whole row. */
  cell?: string;
  row?: number;
  entity?: { type: string; id: string | null };
}

export interface ValidationJson {
  errors: number;
  warnings: number;
  issues: IssueJson[];
}

export interface QueryOptions {
  /** Keep the entities this returns true for. */
  where?: (e: EntityJson) => boolean;
  /** Pack name. */
  pack?: string;
  /** Include commented-out entities too. */
  inactive?: boolean;
}

const META = new Set(["$type", "$id", "$pack", "$sheet", "$active"]);

export class Sapwood {
  readonly project: Project;
  private done: Change[] = [];
  private undone: Change[] = [];
  /** Columns a write being planned had to add first (see growColumns). */
  private grown: { ops: Op[]; inverses: Op[][] } | null = null;

  constructor(project: Project) {
    this.project = project;
  }

  /** A project from schema YAML and a project definition (see loadProject). */
  static load(schemaYaml: string, def: ProjectDef | string): Sapwood {
    return new Sapwood(loadProject(schemaYaml, def).project);
  }

  static fromDoc(doc: Doc): Sapwood {
    return new Sapwood(Project.fromDoc(doc));
  }

  /** The document: the project's truth, for storing or for rebasing ops against. */
  get doc(): Doc {
    return this.project.doc;
  }

  /** The schema as YAML text. */
  schemaYaml(): string {
    return formatSchema(this.project.doc.schema);
  }

  // ------------------------------------------------------------ reads

  /** One entity by ID (exact, as refs match). Commented-out entities are found too. */
  get(id: string): EntityJson {
    return this.entityJson(this.find(id));
  }

  /** Entities of a type, or of every type with a trait, in document order. Active ones unless `inactive`. */
  query(typeOrTrait: string, opts: QueryOptions = {}): EntityJson[] {
    const schema = this.schema;
    if (!schema.types.has(typeOrTrait) && !schema.traits.has(typeOrTrait)) throw new ApiError("unknown-type", `No type or trait called ${typeOrTrait}`);
    const pack = opts.pack === undefined ? undefined : this.packId(opts.pack);
    const out: EntityJson[] = [];
    for (const e of this.project.project().entities) {
      if (e.id === null || (!e.active && !opts.inactive) || (pack !== undefined && e.pack !== pack)) continue;
      if (e.type !== typeOrTrait && !schema.types.get(e.type)!.traits.has(typeOrTrait)) continue;
      const j = this.entityJson(e);
      if (!opts.where || opts.where(j)) out.push(j);
    }
    return out;
  }

  /**
   * A singleton's fields, read from its active field rows. With two active rows for a field
   * (a validation error), the first is shown.
   */
  singleton(type: string): SingletonJson {
    const t = this.singletonType(type);
    const out: SingletonJson = { $type: type, $pack: this.project.wb.packs.get(t.def.pack ?? this.project.wb.root)!.name };
    const entries = this.singletonEntries(type);
    for (const f of t.fields) {
      const name = f.def.name;
      const mine = entries.filter((e) => e.path[0] === name);
      const whole = mine.find((e) => e.path.length === 1);
      if (whole) {
        const v = this.singletonValue(whole);
        if (v !== undefined) out[name] = v;
        continue;
      }
      // Split into rows: rebuild the struct from its sub-field rows.
      const obj: { [k: string]: JsonValue } = {};
      for (const e of mine) {
        const v = this.singletonValue(e);
        if (v === undefined) continue;
        let o = obj;
        for (const k of e.path.slice(1, -1)) {
          const next = o[k];
          o = isObject(next) && !isFormula(next) ? next : (o[k] = {});
        }
        o[e.path.at(-1)!] ??= v;
      }
      if (Object.keys(obj).length) out[name] = obj;
    }
    return out;
  }

  validate(): ValidationJson {
    const v = validate(this.project);
    const byRow = new Map<string, Entity>();
    for (const e of v.projection.entities) byRow.set(`${e.at.sheet}|${e.at.row}`, e);
    return { errors: v.errors, warnings: v.warnings, issues: v.issues.map((i) => this.issueJson(i, byRow)) };
  }

  /** JSON export (§10). Refuses with validation errors unless `allowInvalid`. */
  export(opts: ExportOptions = {}): ExportFile[] {
    return exportJson(this.project, opts);
  }

  // ------------------------------------------------------------ writes

  /**
   * Set fields of an entity: `{ cooldown: 0.4, projectiles: ["BlasterBolt"] }`. Null clears
   * a field. `{ "$formula": "=…" }` writes a formula. `$id` renames the entity, rewriting
   * refs to it (formulas that mention it are listed, not rewritten); `$active` comments it
   * out or back in. Replacing a formula needs `force`.
   */
  set(id: string, fields: Record<string, JsonValue>, opts: { force?: boolean } = {}): Change {
    return this.write(() => this.setOps(id, fields, opts.force ?? false));
  }

  /** Add an entity: `fields` must include `$id`. See Placement for where it goes. */
  create(type: string, fields: Record<string, JsonValue>, where: Placement = {}): Change {
    return this.write(() => this.createOps(type, fields, where));
  }

  /**
   * Set fields of a singleton, as `set` does for an entity. A field with a row is written in
   * column B; a struct split into rows is written row by row. A field with no row yet gets one,
   * appended to the singleton's block; with no block, a block is added on the pack's only data
   * sheet (unless it's named after another type), or else on the sheet named after the
   * singleton, created if need be. Null clears a field's value.
   */
  setSingleton(type: string, fields: Record<string, JsonValue>, opts: { force?: boolean } = {}): Change {
    return this.write(() => this.singletonOps(type, fields, opts.force ?? false));
  }

  commentOut(id: string): Change {
    return this.set(id, { $active: false });
  }

  uncomment(id: string): Change {
    return this.set(id, { $active: true });
  }

  /** Delete an entity's row. Refs to it break, and validation says where. */
  delete(id: string): Change {
    return this.write(() => {
      const e = this.find(id);
      return { ops: [{ kind: "delete", sheet: e.at.sheet, axis: "row", ids: [e.at.row] }] };
    });
  }

  /** Apply patches in order, all or nothing, as one change (one undo step). */
  apply(patches: readonly Patch[]): Change {
    const changes: Change[] = [];
    try {
      for (const p of patches) changes.push(this.applyOne(p));
    } catch (e) {
      this.project.apply(undoAll(changes.map((c) => c.inverse)));
      this.done.length -= changes.length;
      throw e;
    }
    this.done.length -= changes.length; // recorded below as one step
    const all: Change = {
      ops: changes.flatMap((c) => c.ops),
      inverse: undoAll(changes.map((c) => c.inverse)),
      formulas: changes.flatMap((c) => c.formulas),
    };
    this.done.push(all);
    return all;
  }

  /** Apply ops directly (DESIGN §8.1), as one change. */
  applyOps(ops: readonly Op[]): Change {
    return this.write(() => ({ ops: [...ops] }));
  }

  /** Undo the last change. False when there is nothing to undo. */
  undo(): boolean {
    const c = this.done.pop();
    if (!c) return false;
    this.project.apply(c.inverse);
    this.undone.push(c);
    return true;
  }

  redo(): boolean {
    const c = this.undone.pop();
    if (!c) return false;
    this.done.push({ ...c, inverse: this.project.apply(c.ops) });
    return true;
  }

  private applyOne(p: Patch): Change {
    switch (p.op) {
      case "set":
        return this.set(p.id, p.fields, { force: p.force ?? false });
      case "create": {
        const where: Placement = {};
        if (p.sheet !== undefined) where.sheet = p.sheet;
        if (p.pack !== undefined) where.pack = p.pack;
        if (p.after !== undefined) where.after = p.after;
        return this.create(p.type, p.fields, where);
      }
      case "commentOut":
        return this.commentOut(p.id);
      case "uncomment":
        return this.uncomment(p.id);
      case "delete":
        return this.delete(p.id);
      case "setSingleton":
        return this.setSingleton(p.type, p.fields, { force: p.force ?? false });
      default:
        throw new ApiError("bad-value", `Unknown patch op ${JSON.stringify((p as { op: unknown }).op)}`);
    }
  }

  /** Build ops against the current state, apply them atomically, and record the change. */
  private write(plan: () => { ops: Op[]; renamed?: string }): Change {
    const grown: { ops: Op[]; inverses: Op[][] } = { ops: [], inverses: [] };
    this.grown = grown;
    let planned: { ops: Op[]; renamed?: string };
    let inverse: Op[];
    try {
      planned = plan();
      inverse = this.project.apply(planned.ops);
    } catch (e) {
      this.project.apply(undoAll(grown.inverses));
      throw e;
    } finally {
      this.grown = null;
    }
    const { renamed } = planned;
    const formulas = renamed === undefined ? [] : renameIdFormulas(this.project.doc, renamed).map((l) => this.address(l.sheet, l.row, l.col));
    const change: Change = { ops: [...grown.ops, ...planned.ops], inverse: [...inverse, ...undoAll(grown.inverses)], formulas };
    this.done.push(change);
    this.undone = [];
    return change;
  }

  private setOps(id: string, fields: Record<string, JsonValue>, force: boolean): { ops: Op[]; renamed?: string } {
    const e = this.find(id);
    const ops: Op[] = [];
    for (const [name, value] of Object.entries(fields)) {
      if (META.has(name)) continue;
      ops.push(...this.fieldOps(e, name, value, force));
    }
    if ("$active" in fields) {
      const active = fields.$active;
      if (typeof active !== "boolean") throw new ApiError("bad-value", "$active is true or false");
      if (active !== e.active) ops.push(this.cellOp(e.at.sheet, e.at.row, this.colAt(e.at.sheet, 1), { v: active ? e.type : `#${e.type}` }));
    }
    for (const k of ["$type", "$pack", "$sheet"]) if (k in fields) throw new ApiError("bad-value", `${k} can't be set: create the entity anew where it should be, and delete this one`);
    if ("$id" in fields && fields.$id !== e.id) {
      const to = this.newId(fields.$id);
      ops.push({ kind: "renameId", from: e.id!, to });
      return { ops, renamed: e.id! };
    }
    return { ops };
  }

  private createOps(type: string, fields: Record<string, JsonValue>, where: Placement): { ops: Op[] } {
    const t = this.schema.types.get(type);
    if (!t) throw new ApiError("unknown-type", `No type called ${type}`);
    if (t.def.singleton) throw new ApiError("singleton", `${type} is a singleton: it has no ID, and is edited as field rows`);
    const id = this.newId(fields.$id);
    const active = fields.$active ?? true;
    if (typeof active !== "boolean") throw new ApiError("bad-value", "$active is true or false");
    for (const k of ["$type", "$pack", "$sheet"]) if (k in fields) throw new ApiError("bad-value", `${k} is set by where the entity goes: use the type, and sheet or pack`);
    const { sheet, after } = this.placement(type, where);
    const row = this.project.wb.sheet(sheet).rows.freshIds(1)[0]!;
    const ops: Op[] = [
      { kind: "insert", sheet, axis: "row", after, ids: [row] },
      this.cellOp(sheet, row, this.colAt(sheet, 1), { v: active ? type : `#${type}` }),
      this.cellOp(sheet, row, this.colAt(sheet, 2), { v: id }),
    ];
    const e: Entity = { type, id, pack: this.project.wb.sheet(sheet).pack, at: { sheet, row }, active, fields: new Map() };
    for (const [name, value] of Object.entries(fields)) if (!META.has(name) && value !== null) ops.push(...this.fieldOps(e, name, value, false));
    return { ops };
  }

  /** Which sheet a new entity goes on, and the row it goes after (null: first). */
  private placement(type: string, where: Placement): { sheet: SheetId; after: RowId | null } {
    const wb = this.project.wb;
    const pack = where.pack === undefined ? undefined : this.packId(where.pack);
    if (where.after !== undefined) {
      const e = this.find(where.after);
      if (where.sheet !== undefined && wb.sheet(e.at.sheet).name !== where.sheet) throw new ApiError("bad-value", `${where.after} isn't on sheet ${where.sheet}`);
      if (pack !== undefined && e.pack !== pack) throw new ApiError("bad-value", `${where.after} isn't in pack ${where.pack}`);
      return { sheet: e.at.sheet, after: e.at.row };
    }
    let sheet: SheetId | undefined;
    if (where.sheet !== undefined) {
      const found = [...wb.sheets.values()].filter((s) => s.name === where.sheet && (pack === undefined || s.pack === pack));
      if (found.length === 0) throw new ApiError("not-found", `No sheet called ${where.sheet}${where.pack ? ` in pack ${where.pack}` : ""}`);
      if (found.length > 1) throw new ApiError("ambiguous", `Several packs have a sheet called ${where.sheet}: say which pack`);
      if (found[0]!.kind !== "data") throw new ApiError("bad-value", `${where.sheet} is a scratch sheet: entities live on data sheets`);
      sheet = found[0]!.id;
    }
    // After the last entity of the type, on the sheet (or anywhere in the pack).
    const same = this.project.project().entities.filter((e) => e.type === type && (sheet === undefined || e.at.sheet === sheet) && (pack === undefined || e.pack === pack));
    const last = same.at(-1);
    if (last) return { sheet: last.at.sheet, after: last.at.row };
    if (sheet === undefined) {
      const data = [...wb.sheets.values()].filter((s) => s.kind === "data" && (pack === undefined || s.pack === pack));
      if (data.length !== 1) throw new ApiError("no-sheet", `No sheet has a ${type} yet${data.length ? ", and there are several data sheets" : ""}: say which sheet`);
      const only = data[0]!;
      // A sheet named after another type is that type's: the new type gets a sheet of its own.
      sheet = only.name !== type && this.schema.types.has(only.name) ? this.newSheet(type, only.pack) : only.id;
    }
    return { sheet, after: this.lastUsedRow(sheet) };
  }

  private singletonOps(type: string, fields: Record<string, JsonValue>, force: boolean): { ops: Op[] } {
    const t = this.singletonType(type);
    const entries = this.singletonEntries(type);
    const ops: Op[] = [];
    const missing: NewFieldRow[] = [];
    for (const [name, value] of Object.entries(fields)) {
      if (name.startsWith("$")) throw new ApiError("bad-value", `${name} can't be set on a singleton: it has no ID, and its rows are commented out on the sheet`);
      const f = t.fieldByName.get(name);
      if (!f) throw new ApiError("unknown-field", `${type} has no field ${name}`);
      this.singletonFieldOps(type, f.def, [name], value, force, entries, ops, missing);
    }
    if (missing.length) {
      const order = (r: NewFieldRow) => t.fields.findIndex((f) => f.def.name === r.path[0]);
      missing.sort((a, b) => order(a) - order(b));
      ops.push(...this.appendFieldRows(type, missing));
    }
    return { ops };
  }

  private singletonFieldOps(type: string, def: FieldDef, path: string[], value: JsonValue, force: boolean, entries: SingletonEntry[], ops: Op[], missing: NewFieldRow[]): void {
    const key = path.join(".");
    const label = `${type}.${key}`;
    const exact = entries.filter((e) => e.path.join(".") === key);
    if (exact.length > 1) throw new ApiError("ambiguous", `${label} has ${exact.length} active rows (${exact.map((e) => this.rowName(e.at.sheet, e.at.row)).join(", ")}); fix the duplicate first`);
    const e = exact[0];
    if (e) {
      const colB = this.colAt(e.at.sheet, 2);
      if (e.formula && !force && !isFormula(value)) throw new ApiError("formula", `${label} is computed by a formula (${this.formulaAt(e.at.sheet, e.at.row, colB)}); pass force to replace it`);
      ops.push(this.cellOp(e.at.sheet, e.at.row, colB, this.content(e.at.sheet, def.type, value, label)));
      return;
    }
    const below = entries.filter((x) => x.path.length > path.length && x.path.slice(0, path.length).join(".") === key);
    const s = def.type.kind === "struct" ? this.schema.structs.get(def.type.name) : undefined;
    if (below.length && s) {
      // Split into rows (§6.8): each sub-field goes to its own row, as with struct sub-columns.
      if (value !== null && (!isObject(value) || isFormula(value))) throw new ApiError("bad-value", `${label} is split into rows (.${key}.…): write an object`);
      if (value !== null) for (const k of Object.keys(value)) if (!s.fields.some((f) => f.name === k)) throw new ApiError("bad-value", `${label}: ${s.name} has no field ${k}`);
      for (const sub of s.fields) {
        const v = value === null ? null : (value[sub.name] ?? null);
        if (v !== null || below.some((x) => x.path[path.length] === sub.name)) this.singletonFieldOps(type, sub, [...path, sub.name], v, force, entries, ops, missing);
      }
      return;
    }
    if (value === null) return; // no row, so nothing to clear
    missing.push({ path, type: def.type, value, label });
  }

  /** New field rows: after the last row of the singleton's block, or in a new block. */
  private appendFieldRows(type: string, rows: NewFieldRow[]): Op[] {
    const block = this.singletonBlock(type);
    const sheet = block?.sheet ?? this.singletonSheet(type);
    const after = block ? block.after : this.lastUsedRow(sheet);
    const ids = this.project.wb.sheet(sheet).rows.freshIds(rows.length + (block ? 0 : 1));
    const colA = this.colAt(sheet, 1);
    const colB = this.colAt(sheet, 2);
    const ops: Op[] = [{ kind: "insert", sheet, axis: "row", after, ids }];
    if (!block) ops.push(this.cellOp(sheet, ids[0]!, colA, { v: type }));
    rows.forEach((r, i) => {
      const row = ids[i + (block ? 0 : 1)]!;
      ops.push(this.cellOp(sheet, row, colA, { v: `.${r.path.join(".")}` }));
      ops.push(this.cellOp(sheet, row, colB, this.content(sheet, r.type, r.value, r.label)));
    });
    return ops;
  }

  /** The singleton's first active block in its pack, and its last header or field row. */
  private singletonBlock(type: string): { sheet: SheetId; after: RowId } | null {
    const wb = this.project.wb;
    const pack = this.schema.types.get(type)!.def.pack ?? wb.root;
    for (const s of wb.sheets.values()) {
      if (s.kind !== "data" || s.pack !== pack || s.cols.length < 1) continue;
      const colA = s.cols.idAt(1);
      let last: RowId | null = null;
      for (const row of s.rows.liveIds()) {
        const a = this.project.engine.cellById(s.id, row, colA);
        const rc = classify(this.schema, a.value === null || a.formula ? "" : String(a.value));
        if (rc.kind === "entity" || rc.kind === "header") {
          if (last !== null) break;
          if (rc.kind === "header" && rc.type === type && rc.active) last = row;
        } else if (rc.kind === "field" && last !== null) last = row;
      }
      if (last !== null) return { sheet: s.id, after: last };
    }
    return null;
  }

  /** Where a singleton's first block goes (see setSingleton). */
  private singletonSheet(type: string): SheetId {
    const wb = this.project.wb;
    const pack = this.schema.types.get(type)!.def.pack ?? wb.root;
    const data = [...wb.sheets.values()].filter((s) => s.kind === "data" && s.pack === pack);
    const only = data.length === 1 ? data[0]! : undefined;
    if (only && (only.name === type || !this.schema.types.has(only.name))) return only.id;
    const named = data.find((s) => s.name === type);
    return named ? named.id : this.newSheet(type, pack);
  }

  /** The last row of a sheet with anything in it, so a new row doesn't go below blank ones. */
  private lastUsedRow(sheet: SheetId): RowId | null {
    const d = this.project.doc.sheets.get(sheet)!;
    const used = new Set<string>();
    for (const k of d.cells.keys()) used.add(k.slice(0, k.indexOf("|")));
    const live = this.project.wb.sheet(sheet).rows.liveIds();
    for (let i = live.length - 1; i >= 0; i--) if (used.has(live[i]!)) return live[i]!;
    return null;
  }

  /** Ops writing one field of an entity into the cells its layout gives it. */
  private fieldOps(e: Entity, name: string, value: JsonValue, force: boolean): Op[] {
    const t = this.schema.types.get(e.type)!;
    const f = t.fieldByName.get(name);
    if (!f) throw new ApiError("unknown-field", `${e.type} has no field ${name}`);
    const def = f.def;
    const { sheet, row } = e.at;
    let cols = this.project.layout(sheet, e.type).filter((c) => c.field === def.id);
    if (!cols.length && !this.project.doc.sheets.get(sheet)!.layouts.has(e.type)) {
      // The default layout runs past the sheet's last column: add columns up to this field's.
      this.growColumns(sheet, 3 + t.fields.indexOf(f));
      cols = this.project.layout(sheet, e.type).filter((c) => c.field === def.id);
    }
    if (!cols.length) throw new ApiError("no-column", `${this.project.wb.sheet(sheet).name}'s ${e.type} layout has no column for ${name}`);
    if (!force && !isFormula(value))
      for (const c of cols)
        if (this.project.engine.cellById(sheet, row, c.col).formula)
          throw new ApiError("formula", `${e.id}.${name} is computed by a formula (${this.formulaAt(sheet, row, c.col)}); pass force to replace it`);
    const write = (c: LayoutColumn, type: FieldType, v: JsonValue | undefined, label: string): Op =>
      this.cellOp(sheet, row, c.col, this.content(sheet, type, v ?? null, label));

    const whole = cols.find((c) => !c.path.length && c.index === undefined);
    if (whole) return [write(whole, def.type, value, name)];

    if (cols[0]!.index !== undefined) {
      // Repeated columns (§6.4): one item per column.
      if (def.type.kind !== "list") return [];
      const of = def.type.of;
      if (value !== null && !Array.isArray(value)) throw new ApiError("bad-value", `${name} is a list`);
      const items = value ?? [];
      if (items.length > cols.length) throw new ApiError("bad-value", `${name} has ${items.length} items, but the layout has ${cols.length} columns for it`);
      return cols.map((c) => write(c, of, items[c.index!], `${name}[${c.index}]`));
    }

    // Struct sub-columns (§5.6): each column holds one sub-field.
    if (value !== null && !isObject(value)) throw new ApiError("bad-value", `${name} is a struct: write an object`);
    const ops: Op[] = [];
    const covered = new Set<string>();
    for (const c of cols) {
      const defs = this.subFields(def, c.path);
      if (!defs) continue;
      const names = defs.map((d) => d.name);
      covered.add(names.join("."));
      let v: JsonValue | undefined = value ?? undefined;
      for (const n of names) v = isObject(v) ? v[n] : undefined;
      ops.push(write(c, defs.at(-1)!.type, v, `${name}.${names.join(".")}`));
    }
    if (value !== null) this.checkCovered(def, value, [], covered, name);
    return ops;
  }

  /** Every sub-field given in a struct value must have a column. */
  private checkCovered(def: FieldDef, v: JsonValue, path: string[], covered: Set<string>, top: string): void {
    if (path.length && covered.has(path.join("."))) return;
    const s = def.type.kind === "struct" ? this.schema.structs.get(def.type.name) : undefined;
    if (!s || !isObject(v) || isFormula(v)) {
      if (path.length) throw new ApiError("no-column", `The layout has no column for ${top}.${path.join(".")}`);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      const f = s.fields.find((y) => y.name === k);
      if (!f) throw new ApiError("bad-value", `${top}${path.length ? "." + path.join(".") : ""}: ${s.name} has no field ${k}`);
      if (x !== null) this.checkCovered(f, x, [...path, k], covered, top);
    }
  }

  /** What a cell holds for a JSON value of a field type: checked as a cell would be read. */
  private content(sheet: SheetId, type: FieldType, v: JsonValue, label: string): Content {
    if (v === null) return null;
    if (isFormula(v)) {
      const text = v.$formula;
      if (typeof text !== "string" || !text.startsWith("=")) throw new ApiError("bad-value", `${label}: $formula is text starting with =`);
      return this.project.parseInput(sheet, text);
    }
    const r = parseJson(this.schema, type, v);
    if (!r.ok) throw new ApiError("bad-value", `${label}: ${r.message}`);
    switch (type.kind) {
      case "list":
      case "struct":
      case "union":
      case "json":
        return { v: JSON.stringify(v) }; // one cell holds JSON (§6.4)
      case "datetime":
        return { v: r.value as string }; // normalised to UTC
      case "duration":
        return { v: typeof v === "number" ? `${v}s` : (v as string) }; // a bare number in a cell has no unit
      default:
        return { v: v as Literal };
    }
  }

  private cellOp(sheet: SheetId, row: RowId, col: ColId, content: Content): Op {
    return { kind: "setCell", sheet, row, col, content };
  }

  /** A live column by position, added if the sheet doesn't have it yet. */
  private colAt(sheet: SheetId, pos: number): ColId {
    this.growColumns(sheet, pos);
    return this.project.wb.sheet(sheet).cols.idAt(pos);
  }

  /**
   * Give a sheet at least `count` columns, as insert ops applied now (later ops in the
   * write are built against them) and recorded in the change being written.
   */
  private growColumns(sheet: SheetId, count: number): void {
    const cols = this.project.wb.sheet(sheet).cols;
    if (cols.length >= count) return;
    const op: Op = { kind: "insert", sheet, axis: "col", after: this.project.doc.sheets.get(sheet)!.cols.order.at(-1) ?? null, ids: cols.freshIds(count - cols.length) };
    const inverse = this.project.apply([op]);
    this.grown!.ops.push(op);
    this.grown!.inverses.push(inverse);
  }

  /** A new data sheet, applied now and recorded in the change being written, like growColumns. */
  private newSheet(name: string, pack: PackId): SheetId {
    const wb = this.project.wb;
    if (wb.findSheet(pack, name)) throw new ApiError("no-sheet", `No data sheet has a ${name} yet, and a sheet called ${name} already exists: say which sheet`);
    const op: Op = { kind: "createSheet", sheet: wb.freshSheetId(), name, pack, sheetKind: "data" };
    const inverse = this.project.apply([op]);
    this.grown!.ops.push(op);
    this.grown!.inverses.push(inverse);
    return op.sheet;
  }

  private newId(v: JsonValue | undefined): string {
    if (typeof v !== "string" || v.trim() === "") throw new ApiError("bad-value", "$id is non-empty text");
    const lower = v.toLowerCase();
    const taken = this.project.project().entities.find((e) => e.id?.toLowerCase() === lower);
    if (taken) throw new ApiError("exists", `ID "${v}" is taken by a ${taken.type} on ${this.project.wb.sheet(taken.at.sheet).name}${taken.id !== v ? ` ("${taken.id}": IDs are unique regardless of case)` : ""}`);
    return v;
  }

  // ------------------------------------------------------------ helpers

  private get schema(): ResolvedSchema {
    return this.project.schema;
  }

  /**
   * The entity with this ID. With duplicates (a validation error), the active one; more than
   * one active, or several commented out, is ambiguous.
   */
  private find(id: string): Entity {
    const all = this.project.project().entities.filter((e) => e.id === id);
    const active = all.filter((e) => e.active);
    if (active.length === 1) return active[0]!;
    if (active.length === 0 && all.length === 1) return all[0]!;
    if (all.length === 0) {
      const near = this.project.project().entities.find((e) => e.id?.toLowerCase() === id.toLowerCase());
      if (this.schema.types.get(id)?.def.singleton) throw new ApiError("singleton", `${id} is a singleton, not an entity: read it with singleton("${id}")`);
      throw new ApiError("not-found", `No entity "${id}"${near ? ` (IDs are case-sensitive: did you mean "${near.id}"?)` : ""}`);
    }
    const where = (active.length ? active : all).map((e) => `${this.project.wb.sheet(e.at.sheet).name} row ${this.project.wb.sheet(e.at.sheet).rows.posOf(e.at.row)}`);
    throw new ApiError("ambiguous", `Several entities have the ID "${id}" (${where.join(", ")}); fix the duplicate first`);
  }

  private singletonType(type: string): ResolvedType {
    const t = this.schema.types.get(type);
    if (!t) throw new ApiError("unknown-type", `No type called ${type}`);
    if (!t.def.singleton) throw new ApiError("unknown-type", `${type} isn't a singleton: use get or query`);
    return t;
  }

  /** A singleton's active field rows, in document order. */
  private singletonEntries(type: string): SingletonEntry[] {
    return this.project.project().singletons.filter((s) => s.active && s.type === type);
  }

  /** A field row's value as JSON, as entityJson shows a field; undefined when blank. */
  private singletonValue(e: SingletonEntry): JsonValue | undefined {
    const v = e.value === undefined ? null : valueJson(this.schema, e.field.type, e.value, { ref: (id) => id, defaults: false });
    const s = this.project.wb.sheet(e.at.sheet);
    const colB = s.cols.length >= 2 ? s.cols.idAt(2) : null;
    if (e.formula && colB) return { $value: v, $formula: this.formulaAt(e.at.sheet, e.at.row, colB) };
    if (e.invalid && v === null && colB) {
      const raw = this.project.engine.cellById(e.at.sheet, e.at.row, colB).value;
      return { $invalid: raw === null || typeof raw === "object" ? null : raw };
    }
    return v === null ? undefined : v;
  }

  private rowName(sheet: SheetId, row: RowId): string {
    const s = this.project.wb.sheet(sheet);
    return `${s.name} row ${s.rows.posOf(row)}`;
  }

  private packId(name: string): PackId {
    const found = [...this.project.wb.packs.entries()].filter(([, p]) => p.name === name);
    if (!found.length) throw new ApiError("not-found", `No pack called ${name}`);
    return found[0]![0];
  }

  private entityJson(e: Entity): EntityJson {
    const wb = this.project.wb;
    const out: EntityJson = { $type: e.type, $id: e.id!, $pack: wb.packs.get(e.pack)!.name, $sheet: wb.sheet(e.at.sheet).name, $active: e.active };
    const schema = this.schema;
    const ref = (id: string): JsonOut => id;
    for (const f of schema.types.get(e.type)!.fields) {
      const entry = e.fields.get(f.def.name);
      if (!entry) continue;
      const v = entry.value === undefined ? null : valueJson(schema, f.def.type, entry.value, { ref, defaults: false });
      if (entry.formula && entry.cells.length === 1) {
        const c = entry.cells[0]!;
        out[f.def.name] = { $value: v, $formula: this.formulaAt(c.sheet, c.row, c.col!) };
      } else if (entry.invalid && v === null) {
        const raw = entry.cells.map((c) => this.project.engine.cellById(c.sheet, c.row, c.col!).value).find((x) => x !== null);
        out[f.def.name] = { $invalid: raw === undefined || typeof raw === "object" ? null : raw };
      } else if (v !== null) out[f.def.name] = v;
    }
    return out;
  }

  private formulaAt(sheet: SheetId, row: RowId, col: ColId): string {
    return this.project.engine.formula(sheet, this.address(sheet, row, col).cell) ?? "";
  }

  private address(sheet: SheetId, row: RowId, col: ColId): CellAddress {
    const s = this.project.wb.sheet(sheet);
    return { sheet: s.name, cell: `${numberToCol(s.cols.posOf(col) ?? 0)}${s.rows.posOf(row) ?? 0}` };
  }

  private issueJson(i: Issue, byRow: Map<string, Entity>): IssueJson {
    const out: IssueJson = { level: i.level, code: i.code, message: i.message };
    if (!i.at) return out;
    const s = this.project.wb.sheet(i.at.sheet);
    out.sheet = s.name;
    const r = s.rows.posOf(i.at.row);
    if (r !== null) out.row = r;
    const c = i.at.col ? s.cols.posOf(i.at.col) : null;
    if (c !== null && r !== null) out.cell = `${numberToCol(c)}${r}`;
    const e = byRow.get(`${i.at.sheet}|${i.at.row}`);
    if (e) out.entity = { type: e.type, id: e.id };
    return out;
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
}

interface NewFieldRow {
  path: string[];
  type: FieldType;
  value: JsonValue;
  label: string;
}

function isObject(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFormula(v: JsonValue | undefined): v is { $formula: JsonValue } {
  return isObject(v) && "$formula" in v;
}
