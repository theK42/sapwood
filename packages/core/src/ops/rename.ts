// Renames that rewrite cells (DESIGN §8.2). Each is an intent op: it expands into the
// writes it makes on the document as it is, so a rebase re-runs it against the new
// head and it also reaches rows other tasks added.
//
//  - renameId: column B, and every literal reference to the ID.
//  - renameType: a definition's name (type, trait, struct, union or enum), everywhere
//    the schema mentions it, column A for a type, layouts keyed by it, and a struct's
//    name where JSON cells use it as a union variant's tag.
//  - renameField: a field's name, singleton field rows in column A, and a struct
//    field's key in JSON cells. Entity rows need nothing: layouts hold field IDs.
//  - renameEnumMember: the member, field defaults, and every enum cell holding it.
//
// Places are found through the schema, not by matching text: a cell is rewritten only
// where its field's type says the thing goes. So a description that happens to equal an
// ID is left alone. Matching is exact (case-sensitive).
//
// JSON cells are rewritten in place, string token by string token, so the rest of the
// text (spacing, key order) stays exactly as the user wrote it.
//
// Formulas and rule expressions are never rewritten. The `…Mentions` functions list the
// ones that mention the old name, for the user to look at.

import type { Expr } from "../formula/bind.ts";
import type { Content } from "../formula/content.ts";
import type { ColId, RowId, SheetId } from "../formula/model.ts";
import { isValidName, type EnumMember, type FieldDef, type FieldType, type Id } from "../schema/model.ts";
import type { ResolvedSchema } from "../schema/resolve.ts";
import { sheetLayout } from "../project/layout.ts";
import { classify, type RowClass } from "../project/rows.ts";
import { cellKey, liveIds, OpError, resolvedSchema, splitCellKey, type Doc, type SheetDoc } from "./doc.ts";
import type { Op } from "./ops.ts";
import { defByName, isSection, mapTypeNames, schemaNodes, type SchemaDef } from "./schema.ts";

export interface CellWrite {
  sheet: SheetId;
  row: RowId;
  col: ColId;
  content: Content;
}

// ------------------------------------------------------------ walking typed cells

/** A text cell, and what the schema says it holds. */
type Slot = { sheet: SheetDoc; row: RowId; col: ColId; text: string } & (
  /** Column A. `block` is the singleton type of the header block the row is in. */
  | { at: "a"; rc: RowClass; block: string | null }
  /** Column B of an entity row. */
  | { at: "id" }
  /** A field's value (or one element or sub-field of it). */
  | { at: "value"; type: FieldType }
);

/** Cell writes for every text cell `fn` changes. Commented-out rows count, so they stay right if they come back. */
function rewriteCells(doc: Doc, fn: (slot: Slot) => string | null): CellWrite[] {
  const schema = resolvedSchema(doc);
  const out: CellWrite[] = [];
  for (const s of doc.sheets.values()) {
    if (s.kind !== "data") continue;
    const cols = liveIds(s.cols);
    if (cols.length < 2) continue;
    const [colA, colB] = cols as [ColId, ColId];
    let block: string | null = null;
    const text = (row: RowId, col: ColId): string | null => {
      const c = s.cells.get(cellKey(row, col));
      return c && "v" in c && typeof c.v === "string" ? c.v : null;
    };
    const visit = (slot: Slot) => {
      const next = fn(slot);
      if (next !== null && next !== slot.text) out.push({ sheet: s.id, row: slot.row, col: slot.col, content: { v: next } });
    };
    for (const row of liveIds(s.rows)) {
      const a = s.cells.get(cellKey(row, colA));
      const rc = classify(schema, a && "v" in a ? String(a.v) : "");
      if (rc.kind === "header") block = rc.type;
      if (rc.kind === "entity") block = null;
      const aText = text(row, colA);
      if (aText !== null) visit({ sheet: s, row, col: colA, text: aText, at: "a", rc, block });
      if (rc.kind === "entity") {
        const b = text(row, colB);
        if (b !== null) visit({ sheet: s, row, col: colB, text: b, at: "id" });
        for (const lc of sheetLayout(schema, s, rc.type)) {
          const type = layoutType(schema, rc.type, lc);
          const v = type && text(row, lc.col);
          if (type && v !== null && v !== undefined) visit({ sheet: s, row, col: lc.col, text: v, at: "value", type });
        }
      }
      if (rc.kind === "field") {
        const type = rc.type ?? block;
        const def = type ? singletonField(schema, type, rc.path) : null;
        const v = def && text(row, colB);
        if (def && v !== null && v !== undefined) visit({ sheet: s, row, col: colB, text: v, at: "value", type: def.type });
      }
    }
  }
  return out;
}

/** The type one layout column holds: the field, a struct sub-field, or one list element. */
function layoutType(schema: ResolvedSchema, type: string, lc: { field: string; path: string[]; index?: number }): FieldType | null {
  let def: FieldDef | undefined = schema.types.get(type)?.fields.find((f) => f.def.id === lc.field)?.def;
  for (const id of lc.path) {
    if (def?.type.kind !== "struct") return null;
    def = schema.structs.get(def.type.name)?.fields.find((f) => f.id === id);
  }
  if (!def) return null;
  if (lc.index !== undefined) return def.type.kind === "list" ? def.type.of : null;
  return def.type;
}

/** The field a singleton field row's path names, and each step's field on the way. */
function singletonPath(schema: ResolvedSchema, type: string, path: string[]): FieldDef[] | null {
  const out: FieldDef[] = [];
  let def: FieldDef | undefined = schema.types.get(type)?.fieldByName.get(path[0]!)?.def;
  for (const name of path.slice(1)) {
    if (!def || def.type.kind !== "struct") return null;
    out.push(def);
    def = schema.structs.get(def.type.name)?.fields.find((f) => f.name === name);
  }
  if (!def) return null;
  out.push(def);
  return out;
}

const singletonField = (schema: ResolvedSchema, type: string, path: string[]): FieldDef | null => singletonPath(schema, type, path)?.at(-1) ?? null;

// ------------------------------------------------------------ rewriting JSON in place

/** Where a string in a JSON cell sits, as the schema sees it. */
export type JsonHit =
  /** A value of this type. */
  | { at: "value"; type: FieldType }
  /** The tag naming a union's variant. */
  | { at: "tag"; union: string }
  /** A key of this struct. */
  | { at: "key"; struct: string };

/**
 * A cell's text with strings rewritten by `fn` (null: leave it). A cell holding a single
 * scalar (a ref, an enum) is one value; lists, structs and unions are JSON, rewritten
 * token by token. `needle`, when given, is a quick test: text without it is left alone.
 */
export function rewriteText(schema: ResolvedSchema, type: FieldType, text: string, fn: (s: string, hit: JsonHit) => string | null, needle?: string): string {
  if (type.kind !== "list" && type.kind !== "struct" && type.kind !== "union") return fn(text, { at: "value", type }) ?? text;
  if (needle !== undefined && !text.includes(JSON.stringify(needle).slice(1, -1))) return text;
  const parsed = parseWithSpans(text);
  if (!parsed) return text; // not JSON: a parse error, reported elsewhere
  const edits: { sp: Span; to: string }[] = [];
  for (const sp of parsed.spans) {
    const hit = hitAt(schema, type, parsed.value, sp);
    const to = hit && fn(sp.value, hit);
    if (to !== null && to !== undefined && to !== sp.value) edits.push({ sp, to });
  }
  let out = text;
  for (const { sp, to } of edits.sort((x, y) => y.sp.start - x.sp.start)) out = out.slice(0, sp.start) + JSON.stringify(to) + out.slice(sp.end);
  return out;
}

/** A cell's text with refs to `from` (where `type` puts refs) changed to `to`. */
export function rewriteRefs(schema: ResolvedSchema, type: FieldType, text: string, from: string, to: string): string {
  return rewriteText(schema, type, text, (s, hit) => (hit.at === "value" && hit.type.kind === "ref" && s === from ? to : null), from);
}

/** The struct a value of `t` is, given its JSON (a union's tag picks the variant). */
function structOf(schema: ResolvedSchema, t: FieldType, v: unknown): string | null {
  if (t.kind === "struct") return t.name;
  if (t.kind !== "union") return null;
  const u = schema.unions.get(t.name);
  const tag = u ? (v as Record<string, unknown> | null)?.[u.discriminator] : undefined;
  return u && typeof tag === "string" && u.variants.includes(tag) ? tag : null;
}

function hitAt(schema: ResolvedSchema, type: FieldType, value: unknown, sp: Span): JsonHit | null {
  let t: FieldType = type;
  let v: unknown = value;
  const steps = sp.path;
  for (const [i, step] of steps.entries()) {
    if (t.kind === "list" && typeof step === "number") t = t.of;
    else if ((t.kind === "struct" || t.kind === "union") && typeof step === "string") {
      if (t.kind === "union") {
        const u = schema.unions.get(t.name);
        if (!u) return null;
        if (step === u.discriminator) return !sp.key && i === steps.length - 1 ? { at: "tag", union: t.name } : null;
      }
      const name = structOf(schema, t, v);
      const f = name ? schema.structs.get(name)?.fields.find((x) => x.name === step) : undefined;
      if (!f) return null;
      t = f.type;
    } else return null;
    v = (v as Record<string | number, unknown> | null)?.[step];
  }
  if (!sp.key) return { at: "value", type: t };
  const u = t.kind === "union" ? schema.unions.get(t.name) : undefined;
  if (u && sp.value === u.discriminator) return null;
  const name = structOf(schema, t, v);
  return name ? { at: "key", struct: name } : null;
}

// ------------------------------------------------------------ renameId

/** The cell writes renaming the ID `from` to `to` makes on this document. */
export function renameIdWrites(doc: Doc, from: string, to: string): CellWrite[] {
  const schema = resolvedSchema(doc);
  return rewriteCells(doc, (slot) => {
    if (slot.at === "id") return slot.text === from ? to : null;
    if (slot.at === "value") return rewriteRefs(schema, slot.type, slot.text, from, to);
    return null;
  });
}

/** Cells whose formulas mention `s` as a string literal (`ENTITY("Blaster")`), which a rename leaves alone. */
export function renameIdFormulas(doc: Doc, s: string): Mention[] {
  return formulaMentions(doc, (e) => mentions(e, (x) => x.k === "str" && x.v === s));
}

// ------------------------------------------------------------ renameType

const write = (w: CellWrite): Op => ({ kind: "setCell", sheet: w.sheet, row: w.row, col: w.col, content: w.content });
const setProp = (id: Id, key: string, value: unknown): Op => ({ kind: "setSchema", id, key, value });

const renameInType = (t: FieldType, from: string, to: string): FieldType => mapTypeNames(t, (n) => (n === from ? to : n));

/** Replace one name in column A's text (`Weapon`, `#Weapon`, `GameConfig.lives`), keeping the rest. */
function replaceTypeName(text: string, from: string, to: string): string | null {
  const m = /^(\s*#?)([A-Za-z_]\w*)(.*)$/s.exec(text);
  return m && m[2] === from ? m[1] + to + m[3] : null;
}

/** The ops renaming the definition `id` (type, trait, struct, union or enum) to `name`. */
export function renameTypeOps(doc: Doc, id: Id, name: string): Op[] {
  const node = schemaNodes(doc.schema).get(id);
  if (!node || !isSection(node.parent) || node.parent === "rules") throw new OpError(`renameType: no type ${id}`);
  const from = node.def.name as string;
  if (from === name) throw new OpError("renameType: the new name is the same as the old one");
  if (!isValidName(name)) throw new OpError(`renameType: "${name}" isn't a valid name: use letters, digits and _, not starting with a digit`);
  if (defByName(doc.schema, name)) throw new OpError(`renameType: the name "${name}" is already used`);
  const ops: Op[] = [setProp(id, "name", name)];

  // Every place the schema names it.
  const rename = (xs: unknown) => (xs as string[]).map((x) => (x === from ? name : x));
  for (const n of schemaNodes(doc.schema).values()) {
    const d = n.def;
    if (!isSection(n.parent)) {
      const t = renameInType(d.type as FieldType, from, name);
      if (t !== d.type) ops.push(setProp(n.id, "type", t));
    } else if ((n.parent === "types" || n.parent === "traits") && (d.traits as string[]).includes(from)) ops.push(setProp(n.id, "traits", rename(d.traits)));
    else if (n.parent === "unions" && (d.variants as string[]).includes(from)) ops.push(setProp(n.id, "variants", rename(d.variants)));
    else if (n.parent === "rules" && d.type === from) ops.push(setProp(n.id, "type", name));
  }

  const schema = resolvedSchema(doc);
  if (node.parent === "types") {
    // Column A: entity rows, singleton headers and qualified field rows.
    for (const w of rewriteCells(doc, (slot) => {
      if (slot.at !== "a") return null;
      const rc = slot.rc;
      const named = rc.kind === "entity" || rc.kind === "header" || (rc.kind === "field" && rc.type !== null); // qualified field rows only
      return named && "type" in rc && rc.type === from ? replaceTypeName(slot.text, from, name) : null;
    }))
      ops.push(write(w));
    // Layouts are kept per type name.
    for (const s of doc.sheets.values()) {
      const l = s.layouts.get(from);
      if (!l) continue;
      ops.push({ kind: "setLayout", sheet: s.id, type: from, layout: null });
      ops.push({ kind: "setLayout", sheet: s.id, type: name, layout: l });
    }
  }
  if (node.parent === "structs" && [...schema.unions.values()].some((u) => u.variants.includes(from)))
    // A union variant's name is its tag in JSON cells.
    for (const w of rewriteCells(doc, (slot) =>
      slot.at === "value" ? rewriteText(schema, slot.type, slot.text, (s, hit) => (hit.at === "tag" && s === from && schema.unions.get(hit.union)!.variants.includes(from) ? name : null), from) : null,
    ))
      ops.push(write(w));
  return ops;
}

// ------------------------------------------------------------ renameField

/** The ops renaming the field `id` (of a type, trait or struct) to `name`. */
export function renameFieldOps(doc: Doc, id: Id, name: string): Op[] {
  const node = schemaNodes(doc.schema).get(id);
  if (!node || isSection(node.parent)) throw new OpError(`renameField: no field ${id}`);
  const owner = schemaNodes(doc.schema).get(node.parent)!;
  const from = node.def.name as string;
  if (from === name) throw new OpError("renameField: the new name is the same as the old one");
  if (!isValidName(name)) throw new OpError(`renameField: "${name}" isn't a valid field name`);
  if ((owner.def.fields as SchemaDef[]).some((f) => f.name === name)) throw new OpError(`renameField: ${owner.def.name as string} already has a field "${name}"`);
  const ops: Op[] = [setProp(id, "name", name)];
  const schema = resolvedSchema(doc);
  const isStructField = owner.parent === "structs";
  for (const w of rewriteCells(doc, (slot) => {
    if (slot.at === "a") {
      // Singleton field rows: `.lives`, `GameConfig.lives`, `.cost.amount`.
      const rc = slot.rc;
      if (rc.kind !== "field") return null;
      const type = rc.type ?? slot.block;
      const defs = type ? singletonPath(schema, type, rc.path) : null;
      const i = defs ? defs.findIndex((d) => d.id === id) : -1;
      if (i < 0) return null;
      const m = /^(\s*#?(?:[A-Za-z_]\w*)?)((?:\.[A-Za-z_]\w*)+)(\s*)$/.exec(slot.text);
      if (!m) return null;
      const segs = m[2]!.slice(1).split(".");
      segs[i] = name;
      return `${m[1]}.${segs.join(".")}${m[3]}`;
    }
    if (slot.at === "value" && isStructField)
      return rewriteText(schema, slot.type, slot.text, (s, hit) => (hit.at === "key" && s === from && schema.structs.get(hit.struct)?.fields.find((f) => f.name === s)?.id === id ? name : null), from);
    return null;
  }))
    ops.push(write(w));
  return ops;
}

// ------------------------------------------------------------ renameEnumMember

/** The ops renaming member `from` of enum `id` to `to`. */
export function renameEnumMemberOps(doc: Doc, id: Id, from: string, to: string): Op[] {
  const node = schemaNodes(doc.schema).get(id);
  if (!node || node.parent !== "enums") throw new OpError(`renameEnumMember: no enum ${id}`);
  const members = node.def.members as EnumMember[];
  const enumName = node.def.name as string;
  if (from === to) throw new OpError("renameEnumMember: the new name is the same as the old one");
  if (!members.some((m) => m.name === from)) throw new OpError(`renameEnumMember: ${enumName} has no member "${from}"`);
  if (members.some((m) => m.name === to)) throw new OpError(`renameEnumMember: ${enumName} already has a member "${to}"`);
  if (to === "" || to !== to.trim() || to.includes(",")) throw new OpError(`renameEnumMember: "${to}" isn't a valid member name: no commas or surrounding spaces`);
  const ops: Op[] = [setProp(id, "members", members.map((m) => (m.name === from ? { ...m, name: to } : m)))];
  for (const n of schemaNodes(doc.schema).values()) {
    const t = n.def.type as FieldType | undefined;
    if (!isSection(n.parent) && t?.kind === "enum" && t.name === enumName && n.def.default === from) ops.push(setProp(n.id, "default", to));
  }
  const schema = resolvedSchema(doc);
  const isIt = (t: FieldType) => t.kind === "enum" && t.name === enumName;
  for (const w of rewriteCells(doc, (slot) =>
    slot.at === "value" ? rewriteText(schema, slot.type, slot.text, (s, hit) => (hit.at === "value" && isIt(hit.type) && s === from ? to : null), from) : null,
  ))
    ops.push(write(w));
  return ops;
}

// ------------------------------------------------------------ what a rename leaves alone

export interface Mention {
  sheet: SheetId;
  row: RowId;
  col: ColId;
}

function formulaMentions(doc: Doc, test: (e: Expr) => boolean): Mention[] {
  const out: Mention[] = [];
  for (const s of doc.sheets.values())
    for (const [k, c] of s.cells) {
      if (!c || !("f" in c) || !test(c.f)) continue;
      const [row, col] = splitCellKey(k);
      if (!s.rows.dead.has(row) && !s.cols.dead.has(col)) out.push({ sheet: s.id, row, col });
    }
  return out;
}

function mentions(e: Expr, test: (e: Expr) => boolean): boolean {
  if (test(e)) return true;
  switch (e.k) {
    case "call":
      return e.args.some((a) => mentions(a, test));
    case "bin":
      return mentions(e.l, test) || mentions(e.r, test);
    case "neg":
    case "pct":
    case "field":
      return mentions(e.e, test);
    default:
      return false;
  }
}

/** Rules whose expression mentions `word`: as a name (a field), or in quotes (a type, an enum member). */
function ruleMentions(doc: Doc, word: string, quoted: boolean): Id[] {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = quoted ? new RegExp(`"${esc}"`) : new RegExp(`(?<![\\w"])${esc}(?![\\w"])`);
  return doc.schema.rules.filter((r) => re.test(r.expr)).map((r) => r.id);
}

/** Formulas and rules a schema rename can't rewrite, for the user to check (§8.2). */
export interface RenameReport {
  formulas: Mention[];
  rules: Id[];
}

/** What renaming a type leaves alone: `ENTITIES("Weapon")`, `SINGLETON("GameConfig")`. Call before renaming. */
export function renameTypeMentions(doc: Doc, id: Id): RenameReport {
  const name = schemaNodes(doc.schema).get(id)?.def.name as string;
  return { formulas: renameIdFormulas(doc, name), rules: ruleMentions(doc, name, true) };
}

/** What renaming a field leaves alone: `ENTITY(x).cooldown`, and rules using it by name. Call before renaming. */
export function renameFieldMentions(doc: Doc, id: Id): RenameReport {
  const name = schemaNodes(doc.schema).get(id)?.def.name as string;
  return { formulas: formulaMentions(doc, (e) => mentions(e, (x) => x.k === "field" && x.field === name)), rules: ruleMentions(doc, name, false) };
}

/** What renaming an enum member leaves alone: `=damageType="fire"`. Call before renaming. */
export function renameMemberMentions(doc: Doc, from: string): RenameReport {
  return { formulas: renameIdFormulas(doc, from), rules: ruleMentions(doc, from, true) };
}

// ------------------------------------------------------------ a small JSON parser that records where each string is

interface Span {
  /** For a value, where it is; for a key, the object it is in. */
  path: (string | number)[];
  key: boolean;
  start: number;
  end: number;
  value: string;
}

const WS = " \t\n\r";

function parseWithSpans(text: string): { value: unknown; spans: Span[] } | null {
  const spans: Span[] = [];
  let i = 0;
  const ws = () => {
    while (i < text.length && WS.includes(text[i]!)) i++;
  };
  const str = (): string => {
    const start = i;
    i++; // opening quote
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) throw new SyntaxError("unterminated string");
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const val = (path: (string | number)[]): unknown => {
    ws();
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      const s = str();
      spans.push({ path, key: false, start, end: i, value: s });
      return s;
    }
    if (ch === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") return i++, arr;
      for (;;) {
        arr.push(val([...path, arr.length]));
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return i++, arr;
        else throw new SyntaxError("expected , or ]");
      }
    }
    if (ch === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") return i++, obj;
      for (;;) {
        ws();
        if (text[i] !== '"') throw new SyntaxError("expected a key");
        const start = i;
        const k = str();
        spans.push({ path, key: true, start, end: i, value: k });
        ws();
        if (text[i++] !== ":") throw new SyntaxError("expected :");
        obj[k] = val([...path, k]);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return i++, obj;
        else throw new SyntaxError("expected , or }");
      }
    }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new SyntaxError("unexpected token");
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  try {
    const value = val([]);
    ws();
    return i === text.length ? { value, spans } : null;
  } catch {
    return null;
  }
}
