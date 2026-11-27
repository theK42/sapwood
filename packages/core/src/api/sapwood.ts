// The project API (DESIGN §9.4): what the CLI, the HTTP API and the MCP server offer,
// over one in-memory project.
//
// Reads give entities as JSON. Writes are entity-level patches: a field is written to
// the cells the sheet's layout gives it (one cell, a struct's sub-columns, or a list's
// repeated columns), and every write is ops applied to the project, so it can be undone,
// recorded in a task, and rebased. A write that would replace a formula fails unless
// forced. Tasks, branches and landing are the server's (Phase 2); this is the layer under them.

import type { Content, Literal } from "../formula/content.ts";
import type { ColId, PackId, RowId, SheetId, SheetKind } from "../formula/model.ts";
import { numberToCol } from "../formula/parse.ts";
import { exportJson, valueJson, type ExportFile, type ExportOptions, type JsonOut } from "../export/json.ts";
import type { Doc } from "../ops/doc.ts";
import { cellKey, cloneDoc, isLive, OpError, siblingBefore, splitCellKey } from "../ops/doc.ts";
import type { Expr } from "../formula/bind.ts";
import { followMove, moveReach, type Moved, type ReachBreak } from "./move.ts";
import { suggestMoves, type MoveSuggestion } from "./suggest.ts";
import { planWizard } from "./wizard.ts";
import { applyOp, undoAll, type Op } from "../ops/ops.ts";
import { renameFieldMentions, renameIdFormulas, renameMemberMentions, renameTypeMentions, type Mention } from "../ops/rename.ts";
import { isSection, schemaNodes } from "../ops/schema.ts";
import { schemaChanges, schemaRemovals, schemaRenames } from "../ops/schemaDiff.ts";
import { formatSchema, parseSchema } from "../schema/yaml.ts";
import type { FieldDef, FieldType } from "../schema/model.ts";
import { resolveSchema, type ResolvedSchema, type ResolvedType } from "../schema/resolve.ts";
import { canSplit, canSpread, fieldColumns, type FieldColumns, type Layout, type LayoutColumn } from "../project/layout.ts";
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
  /** Marked "don't suggest moving" (§7.4); absent when not. */
  $keepHere?: true;
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
  | "no-sheet" // a new entity's sheet can't be decided: say which
  | "bad-schema" // schema text that doesn't parse or resolve
  | "confirm" // the change turns cells holding data into scratch; pass force
  | "in-use"; // formulas elsewhere read what would be deleted: change them first

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
  | { op: "setSingleton"; type: string; fields: Record<string, JsonValue>; force?: boolean }
  | { op: "createPack"; name: string; parent?: string }
  | { op: "createSheet"; name: string; pack?: string; kind?: SheetKind }
  | { op: "renamePack"; name: string; to: string }
  | { op: "movePack"; name: string; parent: string }
  | { op: "renameSheet"; name: string; to: string; pack?: string }
  | { op: "moveSheet"; name: string; to: string; pack?: string }
  | { op: "deleteSheet"; name: string; pack?: string }
  | { op: "deletePack"; name: string }
  | { op: "orderSheet"; name: string; after: string | null; pack?: string }
  | { op: "orderPack"; name: string; after: string | null }
  | { op: "moveEntities"; ids: string[]; pack: string; sheet?: string }
  | { op: "runWizard"; wizard: string; params: Record<string, JsonValue>; cursor?: WizardCursor };

/** Where a wizard launched from a sheet inserts (`position: cursor`): the selected row, 1-based. */
export interface WizardCursor {
  sheet: string;
  pack?: string;
  row: number;
}

/** What a wizard's run made (DESIGN §9.3). */
export interface WizardReport {
  made: { id: string; type: string; sheet: string; cell: string }[];
  /** Sheets and packs it made first. */
  sheets: string[];
  packs: string[];
  /** Issues the run adds. */
  issues: IssueJson[];
}

/**
 * Where a new entity goes (DESIGN §9.3). The pack is the root unless given. With no sheet:
 * the only data sheet in the pack with a row of the type; with none or several, the sheet
 * named after the type, made if need be. It goes after the last row of its type there.
 */
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

/** What `applySchema` did, beyond the change itself. `formulas` are those a rename left alone. */
export interface SchemaChange extends Change {
  /** Rules (by ID) whose expressions mention a renamed name: left as they are, for review. */
  rules: string[];
  /** Cells of removed fields that held data, scratch now (§5.9). */
  scratch: CellAddress[];
  /** What the text asked for that isn't applied, such as reordering. */
  notes: string[];
}

/** What moving entities to another pack does, or would do (DESIGN §7.4). */
export interface MoveReport {
  /** Each entity moved, and where it went. Ones already there are left out. */
  moved: { id: string; sheet: string; pack: string }[];
  /** Refs in the moved entities to entities the new pack can't reach: moving those along mends them. */
  needs: ReachBreak[];
  /** Refs to the moved entities from entities that won't reach them there: moving those along mends them. */
  breaks: ReachBreak[];
  /** Formulas that couldn't follow the move, and why. The rest were pointed at the new cells. */
  formulas: { cell: CellAddress; why: string }[];
  /** Cells of the moved rows outside any field, such as notes: they go with the old rows. */
  lost: CellAddress[];
  /** Issues the move adds. */
  issues: IssueJson[];
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

const META = new Set(["$type", "$id", "$pack", "$sheet", "$active", "$keepHere"]);

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

  /**
   * How a field of a type sits in a sheet's columns (§6.3, §6.4): one whole cell, a struct
   * split into a column per sub-field, or a list spread over N columns. Every row of the type
   * on the sheet, commented out or not, keeps its value, moved to the new columns. Columns
   * are added after the field's last one as needed; ones it no longer uses are deleted when
   * nothing else is in them, and left as they are otherwise. Refused when a row's value is a
   * formula or doesn't read (fix those first), or a list is longer than the columns asked for.
   */
  setColumns(sheet: string, type: string, field: string, to: FieldColumns, where: { pack?: string } = {}): Change {
    return this.write(() => this.columnsOps(sheet, type, field, to, where.pack));
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

  /**
   * Apply an edited schema file (`sapwood schema apply`, §5.8): the differences from the
   * current schema become schema ops, in one change. Items are matched by ID; one written
   * without an ID matches the item of the same name in the same place. A name changed under
   * the same ID is a rename that rewrites cells (§8.2), as is an enum member renamed in
   * place. Removing fields whose cells hold data needs `force`.
   */
  applySchema(yaml: string, opts: { force?: boolean } = {}): SchemaChange {
    const extra = { rules: [] as string[], scratch: [] as CellAddress[], notes: [] as string[] };
    const change = this.write(() => {
      try {
        return this.schemaPlan(yaml, opts.force ?? false, extra);
      } catch (e) {
        if (e instanceof OpError) throw new ApiError("bad-schema", e.message);
        throw e;
      }
    });
    return { ...change, ...extra };
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

  /**
   * Make a pack (DESIGN §7.1) under root, or under the pack `parent` names. Pack names are
   * unique. Its sheets' entities may refer to its own and its ancestors' (§7.2).
   */
  createPack(name: string, parent?: string): Change {
    return this.write(() => {
      const n = typeof name === "string" ? name.trim() : "";
      if (n === "" || n.includes("/")) throw new ApiError("bad-value", "A pack's name is non-empty text without a /");
      if ([...this.project.wb.packs.values()].some((p) => p.name === n)) throw new ApiError("exists", `There's a pack called ${n} already`);
      const under = parent === undefined ? this.project.wb.root : this.packId(parent);
      let id = n;
      for (let i = 1; this.project.doc.packs.has(id); i++) id = `p${this.project.wb.idSalt}${i}`;
      return { ops: [{ kind: "createPack", pack: id, name: n, parent: under }] };
    });
  }

  /** Rename a pack. Formulas name packs by stable ID, so they keep working, shown with the new name. */
  renamePack(name: string, to: string): Change {
    return this.write(() => {
      const id = this.packId(name);
      const n = this.packName(to);
      if (n === name) return { ops: [] };
      if ([...this.project.wb.packs.values()].some((p) => p.name === n && p.id !== id)) throw new ApiError("exists", `There's a pack called ${n} already`);
      return { ops: [{ kind: "renamePack", pack: id, name: n }] };
    });
  }

  /**
   * Move a pack, with its sheets and sub-packs, under another pack (§7.1). What its entities
   * and formulas may refer to changes with it (§7.2): refs or formulas that no longer reach
   * show as issues.
   */
  movePack(name: string, parent: string): Change {
    return this.write(() => {
      const id = this.packId(name);
      if (id === this.project.wb.root) throw new ApiError("bad-value", "The root pack stays where it is");
      const to = this.packId(parent);
      if (this.project.wb.packs.get(id)!.parent === to) return { ops: [] };
      if (this.project.wb.canReach(to, id)) throw new ApiError("bad-value", `${parent} is ${to === id ? "" : "inside "}${name}: a pack can't go inside itself`);
      return { ops: [{ kind: "setPackParent", pack: id, parent: to }] };
    });
  }

  /** Rename a sheet. Formulas refer to it by stable ID, so they keep working, shown with the new name. */
  renameSheet(name: string, to: string, where: { pack?: string } = {}): Change {
    return this.write(() => {
      const sheet = this.anySheet(name, where.pack);
      const s = this.project.wb.sheet(sheet);
      const n = this.sheetName(to);
      if (n === s.name) return { ops: [] };
      const other = this.project.wb.findSheet(s.pack, n);
      if (other && other.id !== sheet) throw new ApiError("exists", `Pack ${this.project.wb.packName(s.pack)} has a sheet called ${n} already`);
      return { ops: [{ kind: "renameSheet", sheet, name: n }] };
    });
  }

  /**
   * Move a sheet to another pack. Its entities are then that pack's (§7.2): refs to them, and
   * formulas reading the sheet, that no longer reach show as issues.
   */
  moveSheet(name: string, to: string, where: { pack?: string } = {}): Change {
    return this.write(() => {
      const sheet = this.anySheet(name, where.pack);
      const s = this.project.wb.sheet(sheet);
      const pack = this.packId(to);
      if (s.pack === pack) return { ops: [] };
      if (this.project.wb.findSheet(pack, s.name)) throw new ApiError("exists", `Pack ${to} has a sheet called ${s.name} already: rename one first`);
      return { ops: [{ kind: "setSheetPack", sheet, pack }] };
    });
  }

  /**
   * Delete a sheet and everything on it, as one change (undo brings it all back). Refused while
   * formulas on other sheets read it: those would have nothing to read, so change them first.
   * Refs to its entities from elsewhere show as issues.
   */
  deleteSheet(name: string, where: { pack?: string } = {}): Change {
    return this.write(() => {
      const sheet = this.anySheet(name, where.pack);
      this.refuseReaders(new Set([sheet]), `${name} is read by formulas elsewhere`);
      return { ops: [{ kind: "removeSheet", sheet }] };
    });
  }

  /**
   * Delete a pack with its sheets and its packs, as one change (undo brings them back). Not
   * the root. Refused while formulas outside it read its sheets.
   */
  deletePack(name: string): Change {
    return this.write(() => {
      const wb = this.project.wb;
      const id = this.packId(name);
      if (id === wb.root) throw new ApiError("bad-value", "The root pack can't be deleted");
      // The pack and those inside it, deepest last, so they're removed deepest first.
      const packs: PackId[] = [id];
      for (let i = 0; i < packs.length; i++) for (const p of wb.packs.values()) if (p.parent === packs[i]) packs.push(p.id);
      const inside = new Set(packs);
      const sheets = [...wb.sheets.values()].filter((s) => inside.has(s.pack)).map((s) => s.id);
      this.refuseReaders(new Set(sheets), `Sheets in ${name} are read by formulas outside it`);
      return { ops: [...sheets.map((sheet): Op => ({ kind: "removeSheet", sheet })), ...packs.reverse().map((pack): Op => ({ kind: "removePack", pack }))] };
    });
  }

  /** Formulas on other sheets that read these: a refusal naming them, if there are any. */
  private refuseReaders(sheets: Set<SheetId>, what: string): void {
    const readers = this.formulasReading(sheets);
    if (!readers.length) return;
    const shown = readers.slice(0, 5).map((a) => `${a.sheet}!${a.cell}`);
    throw new ApiError("in-use", `${what}: ${shown.join(", ")}${readers.length > 5 ? ` and ${readers.length - 5} more` : ""}. Change those formulas first.`);
  }

  /** Cells outside `sheets` whose formulas read a cell or range on one of them. */
  formulasReading(sheets: Set<SheetId>): CellAddress[] {
    const out: CellAddress[] = [];
    const reads = (e: Expr): boolean => {
      switch (e.k) {
        case "ref":
        case "range":
          return sheets.has(e.sheet);
        case "call":
          return e.args.some(reads);
        case "bin":
          return reads(e.l) || reads(e.r);
        case "neg":
        case "pct":
        case "field":
          return reads(e.e);
        default:
          return false;
      }
    };
    for (const s of this.project.doc.sheets.values()) {
      if (sheets.has(s.id)) continue;
      for (const [k, c] of s.cells) {
        if (c === null || !("f" in c) || !reads(c.f)) continue;
        const [row, col] = splitCellKey(k);
        if (isLive(s.rows, row) && isLive(s.cols, col)) out.push(this.address(s.id, row, col));
      }
    }
    return out;
  }

  /** Put a sheet right after another of its pack (by name), or first with `after: null`. */
  orderSheet(name: string, after: string | null, where: { pack?: string } = {}): Change {
    return this.write(() => {
      const sheet = this.anySheet(name, where.pack);
      const pack = this.project.wb.sheet(sheet).pack;
      let a: SheetId | null = null;
      if (after !== null) {
        const found = this.project.wb.findSheet(pack, after);
        if (!found) throw new ApiError("not-found", `Pack ${this.project.wb.packName(pack)} has no sheet called ${after}`);
        if (found.id === sheet) return { ops: [] };
        a = found.id;
      }
      if (siblingBefore(this.project.doc.sheets, sheet, (x) => x.pack === pack) === a) return { ops: [] };
      return { ops: [{ kind: "orderSheet", sheet, after: a }] };
    });
  }

  /** Put a pack right after another with the same parent (by name), or first with `after: null`. */
  orderPack(name: string, after: string | null): Change {
    return this.write(() => {
      const id = this.packId(name);
      const p = this.project.wb.packs.get(id)!;
      if (p.parent === null) throw new ApiError("bad-value", "The root pack has no place to change");
      let a: PackId | null = null;
      if (after !== null) {
        a = this.packId(after);
        if (a === id) return { ops: [] };
        if (this.project.wb.packs.get(a)!.parent !== p.parent) throw new ApiError("bad-value", `${after} isn't in the same pack as ${name}`);
      }
      if (siblingBefore(this.project.doc.packs, id, (x) => x.parent === p.parent) === a) return { ops: [] };
      return { ops: [{ kind: "orderPack", pack: id, after: a }] };
    });
  }

  private packName(to: string): string {
    const n = typeof to === "string" ? to.trim() : "";
    if (n === "" || n.includes("/")) throw new ApiError("bad-value", "A pack's name is non-empty text without a /");
    return n;
  }

  private sheetName(to: string): string {
    const n = typeof to === "string" ? to.trim() : "";
    if (n === "" || n.includes("!") || n.includes("/")) throw new ApiError("bad-value", "A sheet's name is non-empty text without ! or /");
    return n;
  }

  /** A sheet by name, data or scratch: in the pack given, or the only one of that name. */
  private anySheet(name: string, pack: string | undefined): SheetId {
    const p = pack === undefined ? undefined : this.packId(pack);
    const found = [...this.project.wb.sheets.values()].filter((s) => s.name === name && (p === undefined || s.pack === p));
    if (found.length === 0) throw new ApiError("not-found", `No sheet called ${name}${pack ? ` in pack ${pack}` : ""}`);
    if (found.length > 1) throw new ApiError("ambiguous", `Several packs have a sheet called ${name}: say which pack`);
    return found[0]!.id;
  }

  /**
   * Move entities to another pack (DESIGN §7.4), each onto the sheet there that a new entity
   * of its type would go on (§9.3), or the sheet named, after the last of its type. One change.
   * Every cell of a field goes with it, formats too; formulas pointing at those cells, here or
   * anywhere, are pointed at the new ones, and formulas in the moved rows likewise. The report
   * says what didn't follow, and what the move puts out of reach. An entity already on the
   * sheet it would go to is left as it is.
   */
  moveEntities(ids: readonly string[], pack: string, opts: { sheet?: string } = {}): Change & { report: MoveReport } {
    const before = this.validate().issues;
    let report!: Omit<MoveReport, "issues" | "formulas">;
    let formulas: { sheet: SheetId; row: RowId; col: ColId; why: string }[] = [];
    const change = this.write(() => {
      const r = this.moveOps(ids, pack, opts);
      report = r.report;
      formulas = r.formulas;
      return { ops: r.ops, formulas: [] };
    });
    // Formula cells as they are now the old rows are gone.
    const where = formulas.map((f) => ({ cell: this.address(f.sheet, f.row, f.col), why: f.why }));
    return { ...change, report: { ...report, formulas: where, issues: newIssues(before, this.validate().issues) } };
  }

  /**
   * Entities that could move down the pack tree (DESIGN §7.4): everything using them is in
   * one branch below them. Each with the lowest pack all its users reach. Ones marked
   * `$keepHere` aren't suggested. `pack` limits it to that pack and its sub-packs.
   */
  suggestMoves(opts: { pack?: string } = {}): MoveSuggestion[] {
    return suggestMoves(this.project, opts.pack === undefined ? undefined : this.packId(opts.pack));
  }

  /**
   * Run a wizard (DESIGN §9.3) with these parameters: the packs and sheets its steps make (if
   * they aren't there), then its rows, contiguous, on its sheet (made if it says `create`): at
   * the end, after its last run there (`afterLastGroup`), or at the selected row (`cursor`, with
   * `opts.cursor`), with `spacing` blank rows before them. One change. Refused, saying why, when
   * a parameter doesn't do, or an ID it would make exists.
   */
  runWizard(name: string, params: Record<string, unknown>, opts: { cursor?: WizardCursor } = {}): Change & { report: WizardReport } {
    const before = this.validate().issues;
    let made: { sheet: SheetId; row: RowId; id: string; type: string }[] = [];
    let sheets: string[] = [];
    let packs: string[] = [];
    const change = this.write(() => {
      const r = this.wizardOps(name, params, opts.cursor);
      ({ made, sheets, packs } = r);
      return { ops: r.ops, formulas: [] };
    });
    const report: WizardReport = {
      made: made.map((m) => ({ id: m.id, type: m.type, sheet: this.project.wb.sheet(m.sheet).name, cell: this.address(m.sheet, m.row, this.colAt(m.sheet, 1)).cell })),
      sheets,
      packs,
      issues: newIssues(before, this.validate().issues),
    };
    return { ...change, report };
  }

  /** What runWizard would make, without making it. */
  previewWizard(name: string, params: Record<string, unknown>, opts: { cursor?: WizardCursor } = {}): WizardReport {
    const copy = Sapwood.fromDoc(cloneDoc(this.project.doc));
    copy.project.wb.idSalt = this.project.wb.idSalt;
    return copy.runWizard(name, params, opts).report;
  }

  private wizardOps(name: string, params: Record<string, unknown>, cursor: WizardCursor | undefined) {
    const wb = this.project.wb;
    const w = this.schema.schema.wizards.find((x) => x.name === name);
    if (!w) throw new ApiError("not-found", `No wizard called ${name}`);
    const { plan, problems } = planWizard(w, params);
    if (!plan) throw new ApiError("bad-value", `${w.title ?? name} can't run: ${problems.join("; ")}`);
    const packs: string[] = [];
    const sheets: string[] = [];
    // The steps: packs, then sheets, each only if it isn't there.
    for (const p of plan.packs) {
      if ([...wb.packs.values()].some((x) => x.name === p.name)) continue;
      if (p.name === "" || p.name.includes("/")) throw new ApiError("bad-value", `A pack's name is non-empty text without a / (got "${p.name}")`);
      let id = p.name;
      for (let i = 1; this.project.doc.packs.has(id); i++) id = `p${wb.idSalt}${i}`;
      this.stage({ kind: "createPack", pack: id, name: p.name, parent: this.packId(p.parent) });
      packs.push(p.name);
    }
    for (const s of plan.sheets) {
      const pack = this.packId(s.pack);
      if (wb.findSheet(pack, s.name)) continue;
      this.stage({ kind: "createSheet", sheet: wb.freshSheetId(), name: s.name, pack, sheetKind: "data" });
      sheets.push(s.name);
    }
    // Where the rows go: each sheet's rows together, in template order. The wizard's own sheet
    // takes the cursor; other sheets (and it, with no cursor) the wizard's position.
    const groups = new Map<string, { at: { name: string; pack: string }; rows: typeof plan.rows }>();
    for (const pr of plan.rows) {
      const key = `${pr.sheet.pack}\u0000${pr.sheet.name}`;
      if (!groups.has(key)) groups.set(key, { at: pr.sheet, rows: [] });
      groups.get(key)!.rows.push(pr);
    }
    const ops: Op[] = [];
    const made: { sheet: SheetId; row: RowId; id: string; type: string }[] = [];
    for (const g of groups.values()) {
      let sheet: SheetId;
      let after: RowId | null;
      let spacing = w.spacing ?? 0;
      const own = g.at.name === plan.sheet.name && g.at.pack === plan.sheet.pack;
      if (w.position === "cursor" && cursor && own) {
        sheet = this.dataSheet(cursor.sheet, cursor.pack);
        const live = wb.sheet(sheet).rows.liveIds();
        if (!Number.isInteger(cursor.row) || cursor.row < 1) throw new ApiError("bad-value", "The cursor is a row number, from 1");
        after = cursor.row > 1 ? (live[Math.min(cursor.row, live.length + 1) - 2] ?? null) : null;
        if (cursor.row > live.length + 1) this.growRows(sheet, cursor.row - 1);
        spacing = 0;
      } else {
        const pack = this.packId(g.at.pack);
        const found = wb.findSheet(pack, g.at.name);
        if (!found) {
          if (!plan.sheet.create) throw new ApiError("not-found", `No sheet called ${g.at.name} in pack ${g.at.pack}: the wizard doesn't make it`);
          sheet = this.newSheet(g.at.name, pack);
          sheets.push(g.at.name);
        } else {
          if (found.kind !== "data") throw new ApiError("bad-value", `${g.at.name} is a scratch sheet: entities live on data sheets`);
          sheet = found.id;
        }
        after = this.lastUsedRow(sheet);
        if (w.position === "afterLastGroup") {
          const flags = this.project.doc.sheets.get(sheet)!.rowFlags;
          const last = [...wb.sheet(sheet).rows.liveIds()].reverse().find((r) => flags.get(r)?.has(`wizard:${name}`));
          if (last !== undefined) after = last;
        }
      }
      if (after === null) spacing = 0;
      this.growColumns(sheet, 2);
      const ids = wb.sheet(sheet).rows.freshIds(spacing + g.rows.length);
      if (ids.length) this.stage({ kind: "insert", sheet, axis: "row", after, ids });
      g.rows.forEach((pr, i) => {
        const row = ids[spacing + i]!;
        const t = this.schema.types.get(pr.type);
        if (!t || t.def.singleton) throw new ApiError("unknown-type", `No entity type called ${pr.type}`);
        const id = this.newId(pr.id);
        ops.push(
          this.cellOp(sheet, row, this.colAt(sheet, 1), { v: pr.type }),
          this.cellOp(sheet, row, this.colAt(sheet, 2), { v: id }),
          { kind: "setRowFlag", sheet, row, flag: `wizard:${name}`, on: true },
        );
        const e: Entity = { type: pr.type, id, pack: wb.sheet(sheet).pack, at: { sheet, row }, active: true, fields: new Map() };
        for (const [k, v] of Object.entries(pr.fields)) {
          // Text for a field that isn't text is read as it would be typed: JSON, a number, TRUE.
          const kind = t.fieldByName.get(k)?.def.type.kind;
          let value: JsonValue = v;
          if (typeof v === "string" && kind && ["list", "struct", "union", "json", "int", "float", "bool"].includes(kind))
            try {
              value = JSON.parse(kind === "bool" ? v.toLowerCase() : v) as JsonValue;
            } catch {
              // left as text: the field says what's wrong
            }
          ops.push(...this.fieldOps(e, k, value, false));
        }
        made.push({ sheet, row, id, type: pr.type });
      });
    }
    return { ops, made, sheets, packs };
  }

  /** Rows up to `count`, made now if the sheet is shorter, as growColumns does columns. */
  private growRows(sheet: SheetId, count: number): void {
    const rows = this.project.wb.sheet(sheet).rows;
    if (rows.length >= count) return;
    this.stage({ kind: "insert", sheet, axis: "row", after: this.project.doc.sheets.get(sheet)!.rows.order.at(-1) ?? null, ids: rows.freshIds(count - rows.length) });
  }

  /** What moveEntities would do, without doing it. */
  previewMove(ids: readonly string[], pack: string, opts: { sheet?: string } = {}): MoveReport {
    const copy = Sapwood.fromDoc(cloneDoc(this.project.doc));
    copy.project.wb.idSalt = this.project.wb.idSalt;
    return copy.moveEntities(ids, pack, opts).report;
  }

  private moveOps(ids: readonly string[], packName: string, opts: { sheet?: string }): { ops: Op[]; report: Omit<MoveReport, "issues" | "formulas">; formulas: { sheet: SheetId; row: RowId; col: ColId; why: string }[] } {
    if (!Array.isArray(ids) || ids.length === 0) throw new ApiError("bad-value", "Say which entities to move");
    const pack = this.packId(packName);
    const wb = this.project.wb;
    const doc = this.project.doc;
    const seen = new Set<string>();
    const ents = ids.map((id) => this.find(id)).filter((e) => !seen.has(`${e.at.sheet}|${e.at.row}`) && seen.add(`${e.at.sheet}|${e.at.row}`));
    const { needs, breaks } = moveReach(this.project, ents, pack);
    const moved = new Map<string, Moved>();
    const rows = new Set<string>();
    const lk = (c: LayoutColumn) => `${c.field}|${c.path.join(".")}|${c.index ?? ""}`;
    const plans: { e: Entity; to: SheetId; row: RowId; whole: Set<string>; layout: Layout }[] = [];
    const report: Omit<MoveReport, "issues" | "formulas"> = { moved: [], needs, breaks, lost: [] };
    const formulas: { sheet: SheetId; row: RowId; col: ColId; why: string }[] = [];

    // Each entity's new row, made now (with its type and ID), so the next of its type goes after it.
    for (const e of ents) {
      const where: Placement = { pack: packName };
      if (opts.sheet !== undefined) where.sheet = opts.sheet;
      const { sheet: to, after } = this.placement(e.type, where);
      if (to === e.at.sheet) continue;
      const from = wb.sheet(e.at.sheet);
      const row = wb.sheet(to).rows.freshIds(1)[0]!;
      this.stage({ kind: "insert", sheet: to, axis: "row", after, ids: [row] });
      this.growColumns(to, 2);
      rows.add(`${e.at.sheet}|${e.at.row}`);
      // Its row's flags go with it.
      for (const flag of doc.sheets.get(e.at.sheet)!.rowFlags.get(e.at.row) ?? []) this.stage({ kind: "setRowFlag", sheet: to, row, flag, on: true });
      for (const pos of [1, 2]) {
        const col = from.cols.idAt(pos);
        const dest = wb.sheet(to).cols.idAt(pos);
        moved.set(`${e.at.sheet}|${e.at.row}|${col}`, { sheet: to, row, col: dest });
        this.stage(this.cellOp(to, row, dest, doc.sheets.get(e.at.sheet)!.cells.get(cellKey(e.at.row, col)) ?? null));
      }
      // Each field's column there: the same one (by field, sub-field and index), added if the
      // sheet's default layout runs short. One it lacks (split there, say) is written as a value.
      const t = this.schema.types.get(e.type)!;
      const old = this.project.layout(e.at.sheet, e.type);
      let there = this.project.layout(to, e.type);
      const whole = new Set<string>();
      for (const c of old) {
        let dest = there.find((x) => lk(x) === lk(c));
        if (!dest && !doc.sheets.get(to)!.layouts.has(e.type) && !c.path.length && c.index === undefined) {
          this.growColumns(to, 3 + t.fields.findIndex((f) => f.def.id === c.field));
          there = this.project.layout(to, e.type);
          dest = there.find((x) => lk(x) === lk(c));
        }
        if (dest) moved.set(`${e.at.sheet}|${e.at.row}|${c.col}`, { sheet: to, row, col: dest.col });
        else whole.add(c.field);
      }
      plans.push({ e, to, row, whole, layout: old });
      report.moved.push({ id: e.id!, sheet: wb.sheet(to).name, pack: packName });
    }

    // The cells, each to its new place; formulas in them follow too.
    const ops: Op[] = [];
    for (const { e, to, row, whole, layout } of plans) {
      const s = doc.sheets.get(e.at.sheet)!;
      const fieldCols = new Map(layout.map((c) => [c.col, c.field]));
      for (const [k, content] of s.cells) {
        const [r, col] = splitCellKey(k);
        if (r !== e.at.row) continue;
        const dest = moved.get(`${e.at.sheet}|${r}|${col}`);
        const format = s.formats.get(k);
        if (dest && format) ops.push({ kind: "setFormat", sheet: to, row, col: dest.col, format });
        if (content === null) continue;
        if (!dest) {
          if (!whole.has(fieldCols.get(col) ?? "")) report.lost.push(this.address(e.at.sheet, r, col));
          continue;
        }
        if (dest.col === wb.sheet(to).cols.idAt(1) || dest.col === wb.sheet(to).cols.idAt(2)) continue; // made already
        let c = content;
        if ("f" in c) {
          const f = followMove(c.f, to, moved, rows, wb, pack, true);
          c = { f: f.expr };
          for (const why of f.problems) formulas.push({ sheet: to, row, col: dest.col, why });
        }
        ops.push(this.cellOp(to, row, dest.col, c));
      }
      // Fields the sheet there holds differently: written as values.
      const here: Entity = { ...e, at: { sheet: to, row } };
      for (const id of whole) {
        const entry = [...e.fields.values()].find((x) => x.field.id === id);
        if (!entry || entry.value === undefined) continue;
        const first = this.project.layout(to, e.type).find((c) => c.field === id);
        if (entry.formula && first) formulas.push({ sheet: to, row, col: first.col, why: `${entry.field.name} is laid out differently on ${wb.sheet(to).name}, so it's written there as its value` });
        ops.push(...this.fieldOps(here, entry.field.name, valueJson(this.schema, entry.field.type, entry.value, { ref: (id) => id, defaults: false }) as JsonValue, true));
      }
    }

    // Formulas anywhere else that read the moved cells.
    for (const s of doc.sheets.values())
      for (const [k, content] of s.cells) {
        if (content === null || !("f" in content)) continue;
        const [r, col] = splitCellKey(k);
        if (rows.has(`${s.id}|${r}`)) continue;
        const f = followMove(content.f, s.id, moved, rows, wb, s.pack, false);
        if (f.changed) ops.push(this.cellOp(s.id, r, col, { f: f.expr }));
        for (const why of f.problems) formulas.push({ sheet: s.id, row: r, col, why });
      }

    // Then the old rows go.
    const gone = new Map<SheetId, RowId[]>();
    for (const { e } of plans) gone.set(e.at.sheet, [...(gone.get(e.at.sheet) ?? []), e.at.row]);
    for (const [sheet, ids2] of gone) ops.push({ kind: "delete", sheet, axis: "row", ids: ids2 });
    return { ops, report, formulas };
  }

  /** Make an empty sheet in a pack (root unless named): a data sheet, or a scratch one. Names are unique in a pack. */
  createSheet(name: string, opts: { pack?: string; kind?: SheetKind } = {}): Change {
    return this.write(() => {
      const n = typeof name === "string" ? name.trim() : "";
      if (n === "" || n.includes("!") || n.includes("/")) throw new ApiError("bad-value", "A sheet's name is non-empty text without ! or /");
      if (opts.kind !== undefined && opts.kind !== "data" && opts.kind !== "scratch") throw new ApiError("bad-value", "A sheet's kind is data or scratch");
      const pack = opts.pack === undefined ? this.project.wb.root : this.packId(opts.pack);
      if (this.project.wb.findSheet(pack, n)) throw new ApiError("exists", `Pack ${this.project.wb.packName(pack)} has a sheet called ${n} already`);
      return { ops: [{ kind: "createSheet", sheet: this.project.wb.freshSheetId(), name: n, pack, sheetKind: opts.kind ?? "data" }] };
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
      case "createPack":
        return this.createPack(p.name, p.parent);
      case "renamePack":
        return this.renamePack(p.name, p.to);
      case "runWizard":
        return this.runWizard(p.wizard, p.params ?? {}, p.cursor === undefined ? {} : { cursor: p.cursor });
      case "moveEntities":
        return this.moveEntities(p.ids, p.pack, p.sheet === undefined ? {} : { sheet: p.sheet });
      case "movePack":
        return this.movePack(p.name, p.parent);
      case "renameSheet":
        return this.renameSheet(p.name, p.to, p.pack === undefined ? {} : { pack: p.pack });
      case "moveSheet":
        return this.moveSheet(p.name, p.to, p.pack === undefined ? {} : { pack: p.pack });
      case "deleteSheet":
        return this.deleteSheet(p.name, p.pack === undefined ? {} : { pack: p.pack });
      case "deletePack":
        return this.deletePack(p.name);
      case "orderSheet":
        return this.orderSheet(p.name, p.after ?? null, p.pack === undefined ? {} : { pack: p.pack });
      case "orderPack":
        return this.orderPack(p.name, p.after ?? null);
      case "createSheet": {
        const opts: { pack?: string; kind?: SheetKind } = {};
        if (p.pack !== undefined) opts.pack = p.pack;
        if (p.kind !== undefined) opts.kind = p.kind;
        return this.createSheet(p.name, opts);
      }
      default:
        throw new ApiError("bad-value", `Unknown patch op ${JSON.stringify((p as { op: unknown }).op)}`);
    }
  }

  /** Build ops against the current state, apply them atomically, and record the change. */
  private write(plan: () => Planned): Change {
    const grown: { ops: Op[]; inverses: Op[][] } = { ops: [], inverses: [] };
    this.grown = grown;
    let planned: Planned;
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
    const formulas = planned.formulas ?? (renamed === undefined ? [] : renameIdFormulas(this.project.doc, renamed).map((l) => this.address(l.sheet, l.row, l.col)));
    const change: Change = { ops: [...grown.ops, ...planned.ops], inverse: [...inverse, ...undoAll(grown.inverses)], formulas };
    this.done.push(change);
    this.undone = [];
    return change;
  }

  private schemaPlan(yaml: string, force: boolean, extra: { rules: string[]; scratch: CellAddress[]; notes: string[] }): Planned {
    const doc = this.project.doc;
    const cur = doc.schema;
    const { schema: next, issues } = parseSchema(yaml, { existing: cur });
    const bad = issues.length ? issues : resolveSchema(next).issues;
    if (bad.length) throw new ApiError("bad-schema", `The schema has problems:\n${bad.map((i) => `- ${i.path ? `${i.path}: ` : ""}${i.message}`).join("\n")}`);

    // Removals, then renames, then the rest, each against what the ones before leave.
    const work = cloneDoc(doc);
    const removals = schemaRemovals(cur, next);
    for (const op of removals) applyOp(work, op);
    const renames = schemaRenames(work.schema, next);
    const mentions = new Map<string, Mention>();
    const rules = new Set<string>();
    for (const op of renames) {
      const r =
        op.kind === "renameType" ? renameTypeMentions(work, op.id)
        : op.kind === "renameField" ? renameFieldMentions(work, op.id)
        : renameMemberMentions(work, (op as { from: string }).from);
      for (const m of r.formulas) mentions.set(`${m.sheet}|${m.row}|${m.col}`, m);
      for (const id of r.rules) rules.add(id);
      applyOp(work, op);
    }
    const rest = schemaChanges(work.schema, next);

    // Removed fields' cells become scratch: with data in them, that needs confirming.
    const nodes = schemaNodes(cur);
    const gone = new Set(removals.map((op) => (op as { id: string }).id).filter((id) => !isSection(nodes.get(id)!.parent)));
    const cells: { sheet: SheetId; row: RowId; col: ColId }[] = [];
    const p = this.project.project();
    for (const e of p.entities)
      for (const entry of e.fields.values())
        if (gone.has(entry.field.id) && (entry.value !== undefined || entry.formula || entry.invalid)) for (const c of entry.cells) if (c.col) cells.push({ sheet: c.sheet, row: c.row, col: c.col });
    for (const s of p.singletons)
      if (gone.has(s.field.id)) {
        const sh = this.project.wb.sheet(s.at.sheet);
        if (sh.cols.length >= 2) cells.push({ sheet: s.at.sheet, row: s.at.row, col: sh.cols.idAt(2) });
      }
    extra.scratch = cells.map((c) => this.address(c.sheet, c.row, c.col));
    if (cells.length && !force) {
      const names = [...gone].map((id) => `${nodes.get(nodes.get(id)!.parent)!.def.name as string}.${nodes.get(id)!.def.name as string}`);
      const list = extra.scratch.slice(0, 5).map((a) => `${a.sheet}!${a.cell}`).join(", ");
      throw new ApiError("confirm", `Removing ${names.join(", ")} turns ${cells.length} cell${cells.length === 1 ? "" : "s"} holding data into scratch (${list}${cells.length > 5 ? ", …" : ""}); pass force to go ahead`);
    }
    extra.rules = [...rules];
    extra.notes = rest.notes;
    return {
      ops: this.project.withPinnedLayouts([...removals, ...renames, ...rest.ops]),
      formulas: [...mentions.values()].map((m) => this.address(m.sheet, m.row, m.col)),
    };
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
    if ("$keepHere" in fields) {
      const keep = fields.$keepHere;
      if (typeof keep !== "boolean") throw new ApiError("bad-value", "$keepHere is true or false");
      const now = this.project.doc.sheets.get(e.at.sheet)!.rowFlags.get(e.at.row)?.has("keepHere") ?? false;
      if (keep !== now) ops.push({ kind: "setRowFlag", sheet: e.at.sheet, row: e.at.row, flag: "keepHere", on: keep });
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
    // DESIGN §9.3. The pack is the one given, or the root.
    const home = pack ?? wb.root;
    if (sheet === undefined) {
      // Data sheets in the pack with a row of the type, active or commented out.
      const has = new Set(this.project.project().entities.filter((e) => e.type === type && e.pack === home).map((e) => e.at.sheet));
      const found = [...wb.sheets.values()].filter((s) => s.pack === home && s.kind === "data" && has.has(s.id));
      if (found.length === 1) sheet = found[0]!.id;
      else {
        // None, or several: the sheet named after the type (made if it isn't there). Never a guess between sheets.
        const named = wb.findSheet(home, type);
        if (named === undefined) return { sheet: this.newSheet(type, home), after: null };
        if (named.kind !== "data") throw new ApiError("no-sheet", `${type} would go on the sheet named after it, but ${type} is a scratch sheet: say which sheet`);
        sheet = named.id;
      }
    }
    // After the last row of the type on the sheet, active or commented out; else at the end.
    const last = this.project.project().entities.filter((e) => e.type === type && e.at.sheet === sheet).at(-1);
    if (last) return { sheet, after: last.at.row };
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

  /** An op applied now and recorded in the change being written, like growColumns. */
  private stage(op: Op): void {
    const inverse = this.project.apply([op]);
    this.grown!.ops.push(op);
    this.grown!.inverses.push(inverse);
  }

  private dataSheet(name: string, pack: string | undefined): SheetId {
    const p = pack === undefined ? undefined : this.packId(pack);
    const found = [...this.project.wb.sheets.values()].filter((s) => s.name === name && (p === undefined || s.pack === p));
    if (found.length === 0) throw new ApiError("not-found", `No sheet called ${name}${pack ? ` in pack ${pack}` : ""}`);
    if (found.length > 1) throw new ApiError("ambiguous", `Several packs have a sheet called ${name}: say which pack`);
    if (found[0]!.kind !== "data") throw new ApiError("bad-value", `${name} is a scratch sheet: it has no layouts`);
    return found[0]!.id;
  }

  private columnsOps(sheetName: string, type: string, field: string, to: FieldColumns, pack: string | undefined): { ops: Op[] } {
    const sheet = this.dataSheet(sheetName, pack);
    const t = this.schema.types.get(type);
    if (!t) throw new ApiError("unknown-type", `No type called ${type}`);
    if (t.def.singleton) throw new ApiError("singleton", `${type} is a singleton: its fields are rows, not columns`);
    const def = t.fieldByName.get(field)?.def;
    if (!def) throw new ApiError("unknown-field", `${type} has no field ${field}`);
    const label = `${type}.${field}`;
    if (to.kind === "none") throw new ApiError("bad-value", "A field's columns can be whole, split or spread");
    if (to.kind === "split" && !canSplit(this.schema, def)) throw new ApiError("bad-value", `${label} isn't a struct, so it can't be split into columns`);
    if (to.kind === "spread") {
      if (!canSpread(def)) throw new ApiError("bad-value", `${label} isn't a list of simple values, so it can't be spread over columns`);
      if (!Number.isInteger(to.columns) || to.columns < 1 || to.columns > 100) throw new ApiError("bad-value", "A list is spread over 1 to 100 columns");
    }
    const layout = this.project.layout(sheet, type);
    const now = fieldColumns(layout, def.id);
    if (now.kind === to.kind && (to.kind !== "spread" || (now as { columns: number }).columns === to.columns)) return { ops: [] };

    // Every row's value, read before anything moves.
    const rows = this.project.project().entities.filter((e) => e.type === type && e.at.sheet === sheet);
    const values: [Entity, JsonValue][] = [];
    const bad: string[] = [];
    for (const e of rows) {
      const entry = e.fields.get(def.name);
      const where = `${e.id ?? "(no ID)"} (${this.rowName(sheet, e.at.row)})`;
      if (entry?.formula) bad.push(`${where} is a formula`);
      else if (entry?.invalid) bad.push(`${where} doesn't read`);
      else if (entry?.value !== undefined) {
        const v = valueJson(this.schema, def.type, entry.value, { ref: (id) => id, defaults: false }) as JsonValue;
        if (to.kind === "spread" && Array.isArray(v) && v.length > to.columns) bad.push(`${where} has ${v.length} items`);
        if (v !== null) values.push([e, v]);
      }
    }
    if (bad.length) throw new ApiError("bad-value", `${label} on ${sheetName} can't change columns: ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? "; …" : ""}`);

    // The field's new columns, in place of its old ones.
    const s = to.kind === "split" ? this.schema.structs.get((def.type as { name: string }).name)! : null;
    const made: Omit<LayoutColumn, "col">[] =
      to.kind === "whole" ? [{ field: def.id, path: [] }]
      : s ? s.fields.map((f) => ({ field: def.id, path: [f.id] }))
      : Array.from({ length: (to as { columns: number }).columns }, (_, i) => ({ field: def.id, path: [], index: i }));
    const old = layout.filter((c) => c.field === def.id).map((c) => c.col);
    const sh = this.project.wb.sheet(sheet);
    const more = Math.max(0, made.length - old.length);
    const leftover = old.slice(made.length);
    if (more || leftover.length) {
      // Columns come and go: every other type's layout here is pinned first, so none shifts.
      const types = new Set(this.project.project().entities.filter((e) => e.at.sheet === sheet).map((e) => e.type));
      for (const name of types)
        if (name !== type && !this.project.doc.sheets.get(sheet)!.layouts.has(name)) this.stage({ kind: "setLayout", sheet, type: name, layout: this.project.layout(sheet, name) });
    }
    let fresh: ColId[] = [];
    if (more) {
      // After the field's last column; with none, after the sheet's last column.
      if (sh.cols.length < 2) this.growColumns(sheet, 2);
      const pos = (c: ColId) => sh.cols.posOf(c) ?? 0;
      const after = old.length ? old.reduce((a, b) => (pos(a) > pos(b) ? a : b)) : (this.project.doc.sheets.get(sheet)!.cols.order.at(-1) ?? null);
      fresh = sh.cols.freshIds(more);
      this.stage({ kind: "insert", sheet, axis: "col", after, ids: fresh });
    }
    const cols = [...old.slice(0, made.length), ...fresh];
    const placed: LayoutColumn[] = made.map((m, i) => ({ ...m, col: cols[i]! }));
    const at = layout.findIndex((c) => c.field === def.id);
    const rest = layout.filter((c) => c.field !== def.id);
    const next: Layout = at < 0 ? [...rest, ...placed] : [...rest.slice(0, at), ...placed, ...rest.slice(at)];
    this.stage({ kind: "setLayout", sheet, type, layout: next });

    // Clear the old cells, then write each value to the new ones.
    const ops: Op[] = [];
    for (const e of rows)
      for (const c of old) {
        const cell = this.project.engine.cellById(sheet, e.at.row, c);
        if (cell.value !== null || cell.formula) ops.push(this.cellOp(sheet, e.at.row, c, null));
      }
    for (const [e, v] of values) ops.push(...this.fieldOps(e, def.name, v, true));
    // Columns no longer used: deleted when no other layout here uses them and no other row has anything in them.
    const mine = new Set(rows.map((e) => e.at.row));
    const usedElsewhere = new Set<ColId>();
    for (const [name, l] of this.project.doc.sheets.get(sheet)!.layouts) if (name !== type) for (const c of l) usedElsewhere.add(c.col);
    const empty = (r: RowId, c: ColId) => {
      const cell = this.project.engine.cellById(sheet, r, c);
      return cell.value === null && !cell.formula;
    };
    const gone = leftover.filter((c) => !usedElsewhere.has(c) && sh.rows.liveIds().every((r) => mine.has(r) || empty(r, c)));
    if (gone.length) ops.push({ kind: "delete", sheet, axis: "col", ids: gone });
    return { ops };
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
    if (this.project.doc.sheets.get(e.at.sheet)?.rowFlags.get(e.at.row)?.has("keepHere")) out.$keepHere = true;
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

  /** A cell by its sheet's name and A1 address, from stable IDs. */
  address(sheet: SheetId, row: RowId, col: ColId): CellAddress {
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

/** Issues in `after` that `before` hasn't (as many times), by code, message and entity. */
function newIssues(before: readonly IssueJson[], after: readonly IssueJson[]): IssueJson[] {
  const key = (i: IssueJson) => `${i.code}|${i.message}|${i.entity?.type ?? ""}|${i.entity?.id ?? ""}`;
  const count = new Map<string, number>();
  for (const i of before) count.set(key(i), (count.get(key(i)) ?? 0) + 1);
  return after.filter((i) => {
    const n = count.get(key(i)) ?? 0;
    if (n > 0) count.set(key(i), n - 1);
    return n === 0;
  });
}

interface Planned {
  ops: Op[];
  /** An entity ID the change renames: the formulas mentioning it are reported. */
  renamed?: string;
  /** Or the formulas to report, worked out by the plan. */
  formulas?: CellAddress[];
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
