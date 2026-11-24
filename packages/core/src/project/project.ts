// A project: schema + workbook (packs, sheets, cells) + formula engine, and the
// entities derived from them (DESIGN §4.1). Sheets are the truth; entities and
// singletons are a projection, recomputed from the sheets.
//
// The document (ops/doc.ts) is the truth. Every edit is an op (DESIGN §8.1), applied to
// the document and mirrored into the workbook and formula engine, which validation and
// export read. Edits written against positions (`set`, `insert`, …) return the ops
// they made and their inverse, for a task to record and undo.

import { bind, BindError, render, type Host } from "../formula/bind.ts";
import type { Content } from "../formula/content.ts";
import { Engine, parseInput } from "../formula/engine.ts";
import { Workbook, type ColId, type PackId, type RowId, type SheetId, type SheetKind } from "../formula/model.ts";
import { colToNumber, FormulaSyntaxError, parseFormula } from "../formula/parse.ts";
import { formatNumber, isErr, type Scalar } from "../formula/values.ts";
import { cellKey, cloneDoc, emptyDoc, primeResolved, resolvedSchema, rootPack, splitCellKey, type Axis, type Doc, type Format } from "../ops/doc.ts";
import { applyOp, applyPlain, expand, undoAll, type Op } from "../ops/ops.ts";
import {
  renameFieldMentions, renameIdFormulas, renameMemberMentions, renameTypeMentions, type RenameReport,
} from "../ops/rename.ts";
import { defByName, schemaNodes, siblings, type SchemaDef, type Section } from "../ops/schema.ts";
import { parseType, type FieldDef, type FieldType, type Id } from "../schema/model.ts";
import type { ResolvedField, ResolvedSchema, ResolvedType } from "../schema/resolve.ts";
import { buildLayout, sheetLayout, type Layout, type LayoutColumn } from "./layout.ts";
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

/** A row as last read, kept until one of its cells changes (or the schema, layouts or columns do). */
type RowRead =
  | { kind: "skip" }
  | { kind: "issue"; issue: Issue }
  | { kind: "header"; type: string; active: boolean }
  | { kind: "entity"; entity: Entity; issues: Issue[] }
  | { kind: "field"; type: string | null; path: string[]; active: boolean };

export interface Projection {
  entities: Entity[];
  singletons: SingletonEntry[];
  /** Problems found while reading: row classification and cell parsing. */
  issues: Issue[];
}

/** What an edit did: the ops it applied, and the ops that undo it. */
export interface Edit {
  ops: Op[];
  inverse: Op[];
}

/** A field as given to the schema edits: the type may be written as text (`list<ref<Projectile>>`). */
export type FieldInput = Omit<FieldDef, "id" | "type"> & { id?: Id; type: string | FieldType };

export class Project {
  /** The truth: every change is an op applied here, then mirrored into the workbook and engine. */
  readonly doc: Doc;
  readonly wb: Workbook;
  readonly engine: Engine;
  /** Each data sheet's rows as last read (see RowRead). */
  private reads = new Map<SheetId, Map<RowId, RowRead>>();
  /** Every schema ID this project has held, so none is given out again (see freshSchemaId). */
  private heldSchemaIds = new Set<Id>();

  constructor(schema: ResolvedSchema, rootPack = "root") {
    primeResolved(schema);
    this.doc = emptyDoc(schema.schema, rootPack);
    this.wb = new Workbook(rootPack);
    this.engine = new Engine(this.wb);
    this.engine.setEntityTypes((name) => {
      const t = this.schema.types.get(name);
      return t !== undefined && !t.def.singleton;
    });
  }

  /** A project showing a document. The engine is built from it, and everything recalculates. */
  static fromDoc(doc: Doc): Project {
    const root = doc.packs.get(rootPack(doc))!;
    const p = new Project(resolvedSchema(doc), root.id);
    const ops: Op[] = [];
    if (root.name !== root.id) ops.push({ kind: "renamePack", pack: root.id, name: root.name });
    const placed = new Set([root.id]);
    while (placed.size < doc.packs.size)
      for (const x of doc.packs.values())
        if (!placed.has(x.id) && x.parent !== null && placed.has(x.parent)) {
          ops.push({ kind: "createPack", pack: x.id, name: x.name, parent: x.parent });
          placed.add(x.id);
        }
    for (const s of doc.sheets.values()) {
      ops.push({ kind: "createSheet", sheet: s.id, name: s.name, pack: s.pack, sheetKind: s.kind });
      for (const axis of ["row", "col"] as const) {
        const a = axis === "row" ? s.rows : s.cols;
        if (a.order.length) ops.push({ kind: "insert", sheet: s.id, axis, after: null, ids: [...a.order] });
      }
      for (const [type, layout] of s.layouts) ops.push({ kind: "setLayout", sheet: s.id, type, layout });
    }
    // Cells on tombstones are written while their rows are live, then deleted.
    for (const s of doc.sheets.values()) {
      for (const [k, content] of s.cells) {
        const [row, col] = splitCellKey(k);
        ops.push({ kind: "setCell", sheet: s.id, row, col, content });
      }
      for (const [k, format] of s.formats) {
        const [row, col] = splitCellKey(k);
        ops.push({ kind: "setFormat", sheet: s.id, row, col, format });
      }
      for (const axis of ["row", "col"] as const) {
        const a = axis === "row" ? s.rows : s.cols;
        if (a.dead.size) ops.push({ kind: "delete", sheet: s.id, axis, ids: [...a.dead] });
      }
    }
    p.apply(ops);
    return p;
  }

  get schema(): ResolvedSchema {
    return resolvedSchema(this.doc);
  }

  // ------------------------------------------------------------ ops

  /**
   * Apply ops: to the document, then to the workbook and engine. Atomic: if one fails,
   * the ones before it are undone and the error is rethrown. Returns the inverse.
   */
  apply(ops: readonly Op[]): Op[] {
    const done: Op[][] = [];
    const schema = this.doc.schema;
    this.engine.batch(() => {
      try {
        for (const op of ops)
          for (const plain of expand(this.doc, op)) {
            done.push(applyPlain(this.doc, plain));
            this.mirror(plain);
          }
      } catch (e) {
        for (const op of undoAll(done)) {
          applyPlain(this.doc, op);
          this.mirror(op);
        }
        throw e;
      } finally {
        if (this.doc.schema !== schema) this.schemaChanged();
      }
    });
    return undoAll(done);
  }

  /** Bring the workbook and engine in line with an op just applied to the document. */
  private mirror(op: Op): void {
    const e = this.engine;
    switch (op.kind) {
      case "setCell":
        return e.setContent(op.sheet, op.row, op.col, op.content);
      case "setFormat":
        return; // formats live in the document only
      case "insert":
        e.insertIds(op.sheet, op.axis, op.after, op.ids);
        break;
      case "purge":
        e.purgeIds(op.sheet, op.axis, op.ids);
        break;
      case "delete":
        e.killIds(op.sheet, op.axis, op.ids);
        break;
      case "restore":
        e.restoreIds(op.sheet, op.axis, op.ids);
        break;
      case "move":
        e.moveIds(op.sheet, op.axis, op.after, op.ids);
        break;
      case "createSheet":
        this.wb.addSheet(op.name, op.pack, op.sheetKind, op.sheet);
        return this.syncLayouts(op.sheet);
      case "removeSheet":
        e.dropSheet(op.sheet);
        this.wb.sheets.delete(op.sheet);
        this.reads.delete(op.sheet);
        return;
      case "renameSheet":
        this.wb.sheet(op.sheet).name = op.name;
        return;
      case "setSheetPack":
        this.reads.delete(op.sheet); // entities carry their pack
        return e.setSheetPack(op.sheet, op.pack);
      case "setLayout":
        return this.syncLayouts(op.sheet);
      case "createPack":
        this.wb.addPack(op.name, op.parent, op.pack);
        return;
      case "removePack":
        this.wb.packs.delete(op.pack);
        return;
      case "renamePack":
        this.wb.packs.get(op.pack)!.name = op.name;
        return;
      case "setPackParent":
        return e.setPackParent(op.pack, op.parent);
      case "addSchema":
      case "removeSchema":
      case "setSchema":
        return; // see schemaChanged, once per apply
      case "renameId":
      case "renameType":
      case "renameField":
      case "renameEnumMember":
        throw new Error(`${op.kind} is expanded before it is mirrored`);
    }
    // Default layouts follow the columns, so a column change can move fields.
    if (op.axis === "col") this.syncLayouts(op.sheet);
    // A row whose cells were all empty has nothing to report; one brought back is read again.
    else if (op.kind === "restore") for (const row of op.ids) this.reads.get(op.sheet)?.delete(row);
  }

  /**
   * The schema changed: cells are read under the new one (§5.9). Default layouts follow
   * the fields, column A may name different types, and formulas reading fields by name
   * may see different columns, so everything recalculates.
   */
  private schemaChanged(): void {
    for (const id of schemaNodes(this.doc.schema).keys()) this.heldSchemaIds.add(id);
    this.reads.clear();
    for (const s of this.wb.sheets.values()) {
      if (s.kind !== "data") continue;
      this.engine.clearLayouts(s.id);
      this.syncLayouts(s.id);
    }
    this.engine.recalcAll();
  }

  /**
   * Run an edit written against positions. Reading a position past the end of a sheet
   * creates its rows or columns in the workbook (grids are unbounded); those become
   * insert ops, ahead of the edit's own.
   */
  private edit(fn: () => Op[]): Edit {
    const appendInverse: Op[] = [];
    const appends = this.syncAppends(appendInverse);
    let own: Op[];
    try {
      own = fn();
      appends.push(...this.syncAppends(appendInverse));
    } catch (e) {
      this.dropAppends(appendInverse);
      throw e;
    }
    try {
      const inverse = this.apply(own);
      return { ops: [...appends, ...own], inverse: [...inverse, ...appendInverse] };
    } catch (e) {
      this.dropAppends(appendInverse);
      throw e;
    }
  }

  /**
   * Rows and columns the workbook created past the end of a sheet, added to the
   * document as insert ops. The workbook already has them, so they aren't mirrored.
   */
  private syncAppends(inverse: Op[]): Op[] {
    const out: Op[] = [];
    for (const s of this.wb.sheets.values()) {
      const d = this.doc.sheets.get(s.id)!;
      for (const axis of ["row", "col"] as const) {
        const have = (axis === "row" ? d.rows : d.cols).order;
        const all = (axis === "row" ? s.rows : s.cols).order();
        if (all.length <= have.length) continue;
        const op: Op = { kind: "insert", sheet: s.id, axis, after: have.at(-1) ?? null, ids: all.slice(have.length) };
        inverse.unshift(...applyPlain(this.doc, op));
        out.push(op);
        if (axis === "col") this.syncLayouts(s.id);
      }
    }
    return out;
  }

  private dropAppends(inverse: Op[]): void {
    if (inverse.length) this.apply(inverse);
    inverse.length = 0;
  }

  // ------------------------------------------------------------ structure

  addPack(name: string, parent: PackId = this.wb.root): PackId {
    let id = name;
    for (let n = 1; this.doc.packs.has(id); n++) id = `p${this.wb.idSalt}${n}`;
    this.apply([{ kind: "createPack", pack: id, name, parent }]);
    return id;
  }

  addSheet(name: string, pack: PackId = this.wb.root, kind: SheetKind = "data"): SheetId {
    const id = this.wb.freshSheetId();
    this.apply([{ kind: "createSheet", sheet: id, name, pack, sheetKind: kind }]);
    return id;
  }

  sheetId(name: string, pack: PackId = this.wb.root): SheetId {
    const s = this.wb.findSheet(pack, name);
    if (!s) throw new Error(`No sheet "${name}" in pack ${pack}`);
    return s.id;
  }

  /** Set the columns (from C) for a type on a sheet, as field specs: `cooldown`, `price.amount`, `projectiles[0]`. */
  setLayout(sheet: SheetId, type: string, specs: readonly string[]): Edit {
    return this.edit(() => {
      const t = this.schema.types.get(type);
      if (!t) throw new Error(`Unknown type ${type}`);
      const cols = this.wb.sheet(sheet).cols;
      const ids = Array.from({ length: specs.length }, (_, i) => cols.idAt(3 + i));
      const { layout, errors } = buildLayout(this.schema, t, specs, ids);
      if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
      return [{ kind: "setLayout", sheet, type, layout }];
    });
  }

  layout(sheet: SheetId, type: string): Layout {
    return sheetLayout(this.schema, this.doc.sheets.get(sheet)!, type);
  }

  /** Tell the engine which column holds each single-cell field, for `ENTITY(id).field`. */
  private syncLayouts(sheet: SheetId): void {
    if (this.wb.sheet(sheet).kind !== "data") return;
    this.reads.delete(sheet); // rows are read through the layouts
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

  // ------------------------------------------------------------ edits by position

  // ------------------------------------------------------------ schema edits (§5.9)

  /** A schema ID no node uses yet, with this project's salt: `f1`, `t2`… */
  /**
   * A schema ID that isn't in use, numbered past the highest in use, and never one this
   * project has held before: a removed field's ID given to a new field would make any copy
   * of the old state read the new field as the old one.
   */
  freshSchemaId(prefix: string, taken: ReadonlySet<Id> = new Set()): Id {
    const nodes = schemaNodes(this.doc.schema);
    for (const id of nodes.keys()) this.heldSchemaIds.add(id);
    const stem = `${prefix}${this.wb.idSalt}`;
    let n = 0;
    for (const id of this.heldSchemaIds) {
      if (!id.startsWith(stem)) continue;
      const k = Number(id.slice(stem.length));
      if (Number.isInteger(k) && k > n) n = k;
    }
    for (;;) {
      const id = `${stem}${++n}`;
      if (!this.heldSchemaIds.has(id) && !taken.has(id)) return id;
    }
  }

  private fieldDef(f: FieldInput, taken: Set<Id>): SchemaDef {
    const id = f.id ?? this.freshSchemaId("f", taken);
    taken.add(id);
    return { ...f, id, type: typeof f.type === "string" ? parseType(f.type) : f.type };
  }

  /**
   * A schema edit. Default layouts follow the schema's field order, so adding or removing
   * a field (or a trait) would shift every later column on sheets already holding rows of
   * the type. On those sheets the layout is pinned first, as it is: removed fields' columns
   * drop out of it (their cells become scratch) and new fields are appended (§5.9). Where
   * the result is just the new default, nothing is pinned. Custom layouts get new fields
   * appended too.
   */
  private schemaEdit(make: () => Op[]): Edit {
    return this.edit(() => this.withPinnedLayouts(make()));
  }

  /** Schema ops (renames included), preceded by the layout pins they need here (see schemaEdit). */
  withPinnedLayouts(ops: Op[]): Op[] {
    const after = cloneDoc(this.doc);
    for (const op of ops) applyOp(after, op);
    return [...this.pinLayouts(resolvedSchema(after)), ...ops];
  }

  private pinLayouts(next: ResolvedSchema): Op[] {
    const out: Op[] = [];
    const now = this.schema;
    // By ID: a type renamed in the same edit is still the same type. Pins use the name it has
    // now; the rename moves them.
    const byId = new Map([...next.types.values()].map((t) => [t.def.id, t]));
    for (const s of this.wb.sheets.values()) {
      if (s.kind !== "data" || s.cols.length < 1) continue;
      const doc = this.doc.sheets.get(s.id)!;
      // Each type to pin, by the name its layout is kept under: the type's name now, or, for
      // rows that only become it in this edit (their type removed, and another renamed to its
      // name), its new name, as the rows' layout is found once the edit is done.
      const types = new Map<string, string>(); // layout key → the type's name now
      const colA = s.cols.idAt(1);
      for (const row of s.rows.liveIds()) {
        const text = String(this.engine.cellById(s.id, row, colA).value ?? "");
        const rc = classify(now, text);
        if (rc.kind === "entity") types.set(rc.type, rc.type);
        const rn = classify(next, text);
        if (rn.kind !== "entity") continue;
        const id = next.types.get(rn.type)!.def.id;
        if (rc.kind === "entity" && byId.has(now.types.get(rc.type)!.def.id)) continue; // their type stays theirs
        const name = [...now.types.values()].find((x) => x.def.id === id)?.def.name;
        if (name !== undefined && !doc.layouts.has(rn.type) && !doc.layouts.has(name)) types.set(rn.type, name);
      }
      const extra: ColId[] = [];
      const pins: Op[] = [];
      // A removed type's layouts go with it: left behind, they'd apply to a type given its
      // name later (in this edit or another), with columns for fields it doesn't have.
      for (const t of now.types.values()) if (!byId.has(t.def.id) && doc.layouts.has(t.def.name)) pins.push({ kind: "setLayout", sheet: s.id, type: t.def.name, layout: null });
      for (const [key, type] of types) {
        const old = now.types.get(type)!;
        const t = byId.get(old.def.id);
        if (!t) continue;
        const custom = doc.layouts.has(key);
        const ids = new Set(t.fields.map((f) => f.def.id));
        // Rows that become the type here take it as removals have left it (they come before
        // renames): its default layout, of the fields it keeps.
        const layout = key === type
          ? this.layout(s.id, type).filter((c) => ids.has(c.field))
          : old.fields.filter((f) => ids.has(f.def.id)).flatMap((f, i): LayoutColumn[] => (3 + i <= s.cols.length ? [{ col: s.cols.idAt(3 + i), field: f.def.id, path: [] }] : []));
        // New fields go after the last column. A custom layout keeps hiding the fields it hid.
        const known = custom ? new Set(old.fields.map((f) => f.def.id)) : new Set(layout.map((c) => c.field));
        const fresh = t.fields.filter((f) => !known.has(f.def.id));
        const live = s.cols.liveIds();
        const at = (c: LayoutColumn) => live.indexOf(c.col) + 1;
        let pos = Math.max(2, ...layout.map(at)) + 1;
        const freshAt = fresh.map(() => pos++);
        if (custom && !fresh.length) continue; // removed fields already drop out of custom layouts
        // Already the new default: fields in order, one whole column each, from C.
        const slots = [...layout.map((c) => ({ field: c.field, whole: !c.path.length && c.index === undefined, pos: at(c) })), ...fresh.map((f, i) => ({ field: f.def.id, whole: true, pos: freshAt[i]! }))];
        const isDefault = !custom && slots.length === t.fields.length && slots.every((c, i) => c.field === t.fields[i]!.def.id && c.whole && c.pos === 3 + i);
        if (isDefault) continue;
        // Past the sheet's last column, new fields get columns of their own.
        fresh.forEach((f, i) => {
          const p = freshAt[i]!;
          while (s.cols.length + extra.length < p) extra.push(...s.cols.freshIds(1));
          layout.push({ col: p <= s.cols.length ? s.cols.idAt(p) : extra[p - s.cols.length - 1]!, field: f.def.id, path: [] });
        });
        pins.push({ kind: "setLayout", sheet: s.id, type: key, layout });
      }
      if (extra.length) out.push({ kind: "insert", sheet: s.id, axis: "col", after: doc.cols.order.at(-1) ?? null, ids: extra });
      out.push(...pins);
    }
    return out;
  }

  /** A definition by name, or a rule by ID. */
  private defNode(name: string): { section: Section; def: SchemaDef } {
    const d = defByName(this.doc.schema, name);
    if (d) return d;
    const rule = siblings(this.doc.schema, "rules").find((r) => r.id === name);
    if (rule) return { section: "rules", def: rule };
    throw new Error(`No type, trait, struct, union, enum or rule called ${name}`);
  }

  private fieldNode(owner: string, field: string): SchemaDef {
    const f = (this.defNode(owner).def.fields as SchemaDef[] | undefined)?.find((x) => x.name === field);
    if (!f) throw new Error(`${owner} has no field ${field}`);
    return f;
  }

  /**
   * Add a type, trait, struct, union, enum or rule, after the one named `after` (default:
   * last). Fields may be given with it.
   */
  addDef(section: Section, def: { id?: Id; fields?: FieldInput[]; [k: string]: unknown }, after?: string): Edit & { id: Id } {
    const prefix = { enums: "e", traits: "tr", structs: "s", unions: "u", types: "t", rules: "r" }[section];
    const id = def.id ?? this.freshSchemaId(prefix);
    const taken = new Set([id]);
    const full: SchemaDef = { ...def, id };
    if (def.fields) full.fields = def.fields.map((f) => this.fieldDef(f, taken));
    const list = siblings(this.doc.schema, section);
    const anchor = after === undefined ? (list.at(-1)?.id ?? null) : this.defNode(after).def.id;
    return { ...this.schemaEdit(() => [{ kind: "addSchema", parent: section, def: full, after: anchor }]), id };
  }

  /** Add a field to a type, trait or struct, after the field named `after` (default: last). */
  addField(owner: string, field: FieldInput, after?: string): Edit & { id: Id } {
    const o = this.defNode(owner).def;
    const fields = o.fields as SchemaDef[] | undefined;
    if (!fields) throw new Error(`${owner} can't have fields`);
    if (fields.some((f) => f.name === field.name)) throw new Error(`${owner} already has a field ${field.name}`);
    const def = this.fieldDef(field, new Set());
    const anchor = after === undefined ? (fields.at(-1)?.id ?? null) : this.fieldNode(owner, after).id;
    return { ...this.schemaEdit(() => [{ kind: "addSchema", parent: o.id, def, after: anchor }]), id: def.id };
  }

  /** Set properties of a definition; `null` clears one. Use renameType for the name. */
  setDef(name: string, props: Record<string, unknown>): Edit {
    return this.setProps(this.defNode(name).def.id, props, "renameType");
  }

  /** Set properties of a field (`type` may be text); `null` clears one. Use renameField for the name. */
  setField(owner: string, field: string, props: Record<string, unknown>): Edit {
    const p: Record<string, unknown> = { ...props };
    if (typeof p.type === "string") p.type = parseType(p.type);
    return this.setProps(this.fieldNode(owner, field).id, p, "renameField");
  }

  private setProps(id: Id, props: Record<string, unknown>, rename: string): Edit {
    if ("name" in props) throw new Error(`Use ${rename} to change a name`);
    return this.schemaEdit(() =>
      Object.entries(props).map(([key, value]): Op => (value === null || value === undefined ? { kind: "setSchema", id, key } : { kind: "setSchema", id, key, value })),
    );
  }

  /**
   * Remove a definition. Rows of a removed type become invalid until deleted or commented
   * out (§5.9); `affected` lists them, for the user to confirm first.
   */
  removeDef(name: string): Edit & { affected: Location[] } {
    const d = this.defNode(name);
    const affected = d.section === "types" ? this.project().entities.filter((e) => e.type === name).map((e) => e.at) : [];
    return { ...this.schemaEdit(() => [{ kind: "removeSchema", id: d.def.id }]), affected };
  }

  /**
   * Remove a field. Its cells stay, as scratch (§5.9). `affected` lists the ones holding
   * data in entity and singleton rows, for the user to confirm first.
   */
  removeField(owner: string, field: string): Edit & { affected: Location[] } {
    const f = this.fieldNode(owner, field);
    const p = this.project();
    const affected: Location[] = [];
    for (const e of p.entities)
      for (const entry of e.fields.values())
        if (entry.field.id === f.id && (entry.value !== undefined || entry.formula || entry.invalid)) affected.push(...entry.cells);
    for (const s of p.singletons) if (s.field.id === f.id) affected.push(s.at);
    return { ...this.schemaEdit(() => [{ kind: "removeSchema", id: f.id }]), affected };
  }

  /** Rename a type, trait, struct, union or enum (§8.2). Reports the formulas and rules it can't rewrite. */
  renameType(name: string, to: string): Edit & RenameReport {
    const id = this.defNode(name).def.id;
    const report = renameTypeMentions(this.doc, id);
    return { ...this.edit(() => [{ kind: "renameType", id, name: to }]), ...report };
  }

  /** Rename a field of a type, trait or struct (§8.2). Reports the formulas and rules it can't rewrite. */
  renameField(owner: string, field: string, to: string): Edit & RenameReport {
    const id = this.fieldNode(owner, field).id;
    const report = renameFieldMentions(this.doc, id);
    return { ...this.edit(() => [{ kind: "renameField", id, name: to }]), ...report };
  }

  /** Rename an enum member, rewriting every cell that holds it (§8.2). */
  renameEnumMember(enumName: string, from: string, to: string): Edit & RenameReport {
    const id = this.defNode(enumName).def.id;
    const report = renameMemberMentions(this.doc, from);
    return { ...this.edit(() => [{ kind: "renameEnumMember", enum: id, from, to }]), ...report };
  }

  /** Set a cell from user input, by A1 address. */
  set(sheet: SheetId, a1: string, input: string): Edit {
    return this.edit(() => {
      const { row, col } = this.locate(sheet, a1);
      return [{ kind: "setCell", sheet, row, col, content: this.parseInput(sheet, input) }];
    });
  }

  /** Write rows of inputs starting at row 1 (or `fromRow`). Values are typed as in a cell. */
  setRows(sheet: SheetId, rows: readonly (readonly string[])[], fromRow = 1): Edit {
    return this.edit(() => {
      const s = this.wb.sheet(sheet);
      const ops: Op[] = [];
      rows.forEach((r, i) =>
        r.forEach((v, j) => {
          if (v !== "") ops.push({ kind: "setCell", sheet, row: s.rows.idAt(fromRow + i), col: s.cols.idAt(j + 1), content: this.parseInput(sheet, v) });
        }),
      );
      return ops;
    });
  }

  /** Set a cell's format (null clears it). */
  setFormat(sheet: SheetId, a1: string, format: Format | null): Edit {
    return this.edit(() => {
      const { row, col } = this.locate(sheet, a1);
      return [{ kind: "setFormat", sheet, row, col, format }];
    });
  }

  /** What a formula bar shows for a cell: the text that, typed in, gives what it holds. */
  inputAt(sheet: SheetId, row: RowId, col: ColId): string {
    return contentInput(this.doc.sheets.get(sheet)?.cells.get(cellKey(row, col)) ?? null, { wb: this.wb, sheet });
  }

  format(sheet: SheetId, row: RowId, col: ColId): Format | null {
    return this.doc.sheets.get(sheet)?.formats.get(cellKey(row, col)) ?? null;
  }

  /** Insert `count` rows (or columns) before position `pos`. */
  insert(sheet: SheetId, axis: Axis, pos: number, count = 1): Edit {
    return this.edit(() => {
      const a = this.axisOf(sheet, axis);
      const after = pos > 1 ? a.idAt(pos - 1) : null;
      return [{ kind: "insert", sheet, axis, after, ids: a.freshIds(count) }];
    });
  }

  /**
   * Keep every type's columns where they are on a data sheet, before columns are inserted,
   * deleted or moved: a type with no custom layout maps its fields by position from C
   * (§6.3), so a column put before them would move each field to the next column's data.
   * Each such type used on the sheet gets its default layout as a custom one, by column ID.
   */
  pinColumns(sheet: SheetId): Edit {
    return this.edit(() => {
      const s = this.wb.sheet(sheet);
      if (s.kind !== "data" || s.cols.length < 1) return [];
      const doc = this.doc.sheets.get(sheet)!;
      const colA = s.cols.idAt(1);
      const types = new Set<string>();
      for (const row of s.rows.liveIds()) {
        const rc = classify(this.schema, String(this.engine.cellById(sheet, row, colA).value ?? ""));
        if (rc.kind === "entity" && !doc.layouts.has(rc.type)) types.add(rc.type);
      }
      return [...types].map((type): Op => ({ kind: "setLayout", sheet, type, layout: this.layout(sheet, type) }));
    });
  }

  /** Delete `count` rows (or columns) from position `pos`. */
  remove(sheet: SheetId, axis: Axis, pos: number, count = 1): Edit {
    return this.edit(() => [{ kind: "delete", sheet, axis, ids: this.axisOf(sheet, axis).liveIds().slice(pos - 1, pos - 1 + count) }]);
  }

  /** Move `count` rows (or columns) at `pos` so they start at position `to` (counted once they're taken out). */
  move(sheet: SheetId, axis: Axis, pos: number, count: number, to: number): Edit {
    return this.edit(() => {
      const live = this.axisOf(sheet, axis).liveIds();
      const ids = live.slice(pos - 1, pos - 1 + count);
      const rest = live.filter((id) => !ids.includes(id));
      const at = Math.min(to - 1, rest.length);
      return [{ kind: "move", sheet, axis, after: at > 0 ? rest[at - 1]! : null, ids }];
    });
  }

  /**
   * Move the rows (or columns) at these positions, in their order, so they land just before
   * position `before` (as they are now; one past the last for the end). They needn't be
   * next to each other: they come together. No ops if nothing would move.
   */
  moveSet(sheet: SheetId, axis: Axis, positions: readonly number[], before: number): Edit {
    return this.edit(() => {
      const live = this.axisOf(sheet, axis).liveIds();
      const at = new Set(positions.filter((x) => x >= 1 && x <= live.length));
      if (at.size === 0) return [];
      const ids = live.filter((_, i) => at.has(i + 1));
      let after: string | null = null;
      for (let i = Math.min(before, live.length + 1) - 2; i >= 0; i--)
        if (!at.has(i + 1)) {
          after = live[i]!;
          break;
        }
      const rest = live.filter((_, i) => !at.has(i + 1));
      const k = after === null ? 0 : rest.indexOf(after) + 1;
      const result = [...rest.slice(0, k), ...ids, ...rest.slice(k)];
      if (result.every((id, i) => id === live[i])) return [];
      return [{ kind: "move", sheet, axis, after, ids }];
    });
  }

  /** Rename an entity ID and every literal reference to it (§8.2). Lists the formulas that mention it, which it leaves alone. */
  renameId(from: string, to: string): Edit & { formulas: { sheet: SheetId; row: RowId; col: ColId }[] } {
    const e = this.edit(() => [{ kind: "renameId", from, to }]);
    return { ...e, formulas: renameIdFormulas(this.doc, from) };
  }

  /** User input as stored content: a formula bound against stable IDs, or a literal. */
  parseInput(sheet: SheetId, input: string): Content {
    if (input.startsWith("=") && input.length > 1) {
      try {
        return { f: bind(parseFormula(input), { wb: this.wb, sheet }) };
      } catch (e) {
        if (e instanceof FormulaSyntaxError) return { bad: input, code: "#ERROR!", message: e.message };
        if (e instanceof BindError) return { bad: input, code: e.code, message: e.message };
        throw e;
      }
    }
    const v = parseInput(input);
    return v === null || isErr(v) ? null : { v };
  }

  private locate(sheet: SheetId, a1: string): { row: RowId; col: ColId } {
    const m = /^([A-Za-z]{1,3})([0-9]+)$/.exec(a1);
    if (!m) throw new Error(`bad cell address ${a1}`);
    const s = this.wb.sheet(sheet);
    return { row: s.rows.idAt(Number(m[2])), col: s.cols.idAt(colToNumber(m[1]!)) };
  }

  private axisOf(sheet: SheetId, axis: Axis) {
    const s = this.wb.sheet(sheet);
    return axis === "row" ? s.rows : s.cols;
  }

  // ------------------------------------------------------------ projection

  /**
   * Read every data sheet into entities and singleton entries. Rows are read once and kept
   * until one of their cells changes, so after an edit only its rows are read again. An
   * entity that wasn't re-read is the same object as last time.
   */
  project(): Projection {
    const changed = this.engine.takeChangedRows();
    if (changed === "all") this.reads.clear();
    else for (const [row, sheet] of changed) this.reads.get(sheet)?.delete(row);
    const out: Projection = { entities: [], singletons: [], issues: [] };
    for (const s of this.wb.sheets.values()) if (s.kind === "data") this.projectSheet(s.id, out);
    return out;
  }

  private projectSheet(sheet: SheetId, out: Projection): void {
    const s = this.wb.sheet(sheet);
    if (s.cols.length < 1) return;
    const colA = s.cols.idAt(1);
    const colB = s.cols.length >= 2 ? s.cols.idAt(2) : null;
    let reads = this.reads.get(sheet);
    if (!reads) this.reads.set(sheet, (reads = new Map()));
    let block: { type: string; active: boolean } | null = null;
    const layouts = new Map<string, Map<string, LayoutColumn[]>>(); // per type, by field ID
    const layoutOf = (type: string) => {
      let l = layouts.get(type);
      if (!l) layouts.set(type, (l = groupBy(this.layout(sheet, type), (c) => c.field)));
      return l;
    };
    for (const row of s.rows.liveIds()) {
      let r = reads.get(row);
      if (!r) reads.set(row, (r = this.readRow(sheet, row, colA, colB, layoutOf)));
      const at: Location = { sheet, row };
      switch (r.kind) {
        case "skip":
          break;
        case "issue":
          out.issues.push(r.issue);
          break;
        case "header":
          block = { type: r.type, active: r.active };
          break;
        case "entity":
          block = null;
          out.entities.push(r.entity);
          for (const i of r.issues) out.issues.push(i);
          break;
        case "field": {
          const rc = r;
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

  /**
   * Classify a row and read what doesn't depend on the rows around it: an entity, or the
   * class of a singleton row (which block a field row belongs to is the walk's business).
   */
  private readRow(sheet: SheetId, row: RowId, colA: ColId, colB: ColId | null, layoutOf: (type: string) => Map<string, LayoutColumn[]>): RowRead {
    const a = this.engine.cellById(sheet, row, colA);
    const at: Location = { sheet, row, col: colA };
    if (a.formula) return { kind: "issue", issue: { level: "error", code: "row.formula-type", message: "Column A holds the row type and can't be a formula", at } };
    const text = a.value === null ? "" : typeof a.value === "string" ? a.value : String(a.value);
    const rc: RowClass = classify(this.schema, text);
    switch (rc.kind) {
      case "scratch":
      case "comment":
        return { kind: "skip" };
      case "error":
        return { kind: "issue", issue: { level: "error", code: "row.unknown-type", message: rc.message, at } };
      case "header":
        return { kind: "header", type: rc.type, active: rc.active };
      case "entity": {
        const issues: Issue[] = [];
        return { kind: "entity", entity: this.readEntity(sheet, row, colB, rc.type, rc.active, layoutOf(rc.type), issues), issues };
      }
      case "field":
        return { kind: "field", type: rc.type, path: rc.path, active: rc.active };
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

/**
 * A cell's content as a person would type it: a formula as A1 text from `host`, a literal as
 * written, with a leading ' when text would otherwise read as a number, TRUE or a formula.
 */
export function contentInput(c: Content, host: Host): string {
  if (c === null) return "";
  if ("f" in c) return render(c.f, host);
  if ("bad" in c) return c.bad;
  const v = c.v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return v.startsWith("=") || v.startsWith("'") || parseInput(v) !== v ? `'${v}` : v;
}
