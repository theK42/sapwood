// renameId (DESIGN §8.2): rewrite column B and every literal reference to an ID.
//
// References are found through the schema, not by matching text: a cell is rewritten
// only where its field's type says a ref goes (`ref<…>`, a list of them, or a ref inside
// a struct or union held as JSON). So a description that happens to equal the ID is
// left alone. Matching is exact: references are case-sensitive.
//
// JSON cells are rewritten in place, string token by string token, so the rest of the
// text (spacing, key order) stays exactly as the user wrote it.
//
// Formulas are never rewritten. `renameIdFormulas` lists the ones that mention the old
// ID as a string literal, for the user to look at.

import type { Expr } from "../formula/bind.ts";
import type { Content } from "../formula/content.ts";
import type { ColId, RowId, SheetId } from "../formula/model.ts";
import type { FieldDef, FieldType } from "../schema/model.ts";
import type { ResolvedSchema } from "../schema/resolve.ts";
import { sheetLayout } from "../project/layout.ts";
import { classify } from "../project/rows.ts";
import { cellKey, liveIds, resolvedSchema, splitCellKey, type Doc, type SheetDoc } from "./doc.ts";

export interface CellWrite {
  sheet: SheetId;
  row: RowId;
  col: ColId;
  content: Content;
}

/** The cell writes renaming `from` to `to` makes on this document. */
export function renameIdWrites(doc: Doc, from: string, to: string): CellWrite[] {
  const schema = resolvedSchema(doc);
  const out: CellWrite[] = [];
  for (const s of doc.sheets.values()) {
    if (s.kind !== "data") continue;
    const cols = liveIds(s.cols);
    if (cols.length < 2) continue;
    const [colA, colB] = cols as [ColId, ColId];
    let block: string | null = null; // the singleton type of the current header block
    const write = (row: RowId, col: ColId, type: FieldType) => {
      const c = s.cells.get(cellKey(row, col));
      if (!c || !("v" in c) || typeof c.v !== "string") return;
      const next = rewriteRefs(schema, type, c.v, from, to);
      if (next !== c.v) out.push({ sheet: s.id, row, col, content: { v: next } });
    };
    for (const row of liveIds(s.rows)) {
      const a = s.cells.get(cellKey(row, colA));
      const text = a && "v" in a ? String(a.v) : "";
      const rc = classify(schema, text);
      if (rc.kind === "header") block = rc.type;
      if (rc.kind === "entity") {
        block = null;
        // Commented-out rows are rewritten too, so they stay right if they come back.
        const b = s.cells.get(cellKey(row, colB));
        if (b && "v" in b && b.v === from) out.push({ sheet: s.id, row, col: colB, content: { v: to } });
        for (const lc of sheetLayout(schema, s, rc.type)) {
          const type = layoutType(schema, rc.type, lc);
          if (type) write(row, lc.col, type);
        }
      }
      if (rc.kind === "field") {
        const type = rc.type ?? block;
        const def = type ? singletonField(schema, type, rc.path) : null;
        if (def) write(row, colB, def.type);
      }
    }
  }
  return out;
}

/** Cells whose formulas mention `id` as a string literal (`ENTITY("Blaster")`), which a rename leaves alone. */
export function renameIdFormulas(doc: Doc, id: string): { sheet: SheetId; row: RowId; col: ColId }[] {
  const out: { sheet: SheetId; row: RowId; col: ColId }[] = [];
  for (const s of doc.sheets.values())
    for (const [k, c] of s.cells) {
      if (!c || !("f" in c) || !mentions(c.f, id)) continue;
      const [row, col] = splitCellKey(k);
      if (!s.rows.dead.has(row) && !s.cols.dead.has(col)) out.push({ sheet: s.id, row, col });
    }
  return out;
}

function mentions(e: Expr, s: string): boolean {
  switch (e.k) {
    case "str":
      return e.v === s;
    case "call":
      return e.args.some((a) => mentions(a, s));
    case "bin":
      return mentions(e.l, s) || mentions(e.r, s);
    case "neg":
    case "pct":
    case "field":
      return mentions(e.e, s);
    default:
      return false;
  }
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

function singletonField(schema: ResolvedSchema, type: string, path: string[]): FieldDef | null {
  let def: FieldDef | undefined = schema.types.get(type)?.fieldByName.get(path[0]!)?.def;
  for (const name of path.slice(1)) {
    if (def?.type.kind !== "struct") return null;
    def = schema.structs.get(def.type.name)?.fields.find((f) => f.name === name);
  }
  return def ?? null;
}

const mayHoldRef = (schema: ResolvedSchema, t: FieldType, seen = new Set<string>()): boolean => {
  switch (t.kind) {
    case "ref":
      return true;
    case "list":
      return mayHoldRef(schema, t.of, seen);
    case "struct":
    case "union": {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      const structs = t.kind === "struct" ? [t.name] : (schema.unions.get(t.name)?.variants ?? []);
      return structs.some((n) => schema.structs.get(n)?.fields.some((f) => mayHoldRef(schema, f.type, seen)));
    }
    default:
      return false;
  }
};

/** A cell's text with refs to `from` (where `type` puts refs) changed to `to`. */
export function rewriteRefs(schema: ResolvedSchema, type: FieldType, text: string, from: string, to: string): string {
  if (type.kind === "ref") return text === from ? to : text;
  if (!mayHoldRef(schema, type) || !text.includes(JSON.stringify(from).slice(1, -1))) return text;
  const parsed = parseWithSpans(text);
  if (!parsed) return text; // not JSON: a parse error, reported elsewhere
  const hits = parsed.spans.filter((sp) => sp.value === from && refAt(schema, type, parsed.value, sp.path));
  let out = text;
  for (const sp of hits.reverse()) out = out.slice(0, sp.start) + JSON.stringify(to) + out.slice(sp.end);
  return out;
}

/** Whether `path` inside a value of `type` is a place a ref goes. */
function refAt(schema: ResolvedSchema, type: FieldType, value: unknown, path: (string | number)[]): boolean {
  let t: FieldType = type;
  let v: unknown = value;
  for (const step of path) {
    if (t.kind === "list" && typeof step === "number") {
      t = t.of;
    } else if ((t.kind === "struct" || t.kind === "union") && typeof step === "string") {
      let structName = t.kind === "struct" ? t.name : null;
      if (t.kind === "union") {
        const u = schema.unions.get(t.name);
        if (!u || step === u.discriminator) return false;
        const tag = (v as Record<string, unknown> | null)?.[u.discriminator];
        structName = typeof tag === "string" && u.variants.includes(tag) ? tag : null;
      }
      const f = structName ? schema.structs.get(structName)?.fields.find((x) => x.name === step) : undefined;
      if (!f) return false;
      t = f.type;
    } else return false;
    v = (v as Record<string | number, unknown> | null)?.[step];
  }
  return t.kind === "ref";
}

// ---- a small JSON parser that records where each string value is

interface Span {
  path: (string | number)[];
  start: number;
  end: number;
  value: string;
}

function parseWithSpans(text: string): { value: unknown; spans: Span[] } | null {
  const spans: Span[] = [];
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
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
      spans.push({ path, start, end: i, value: s });
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
        const k = str();
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

export type { SheetDoc };
