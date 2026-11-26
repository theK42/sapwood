// The document: a project's state as plain data (DESIGN §8.1). Ops apply to it, and it
// is cheap to copy, so rebase can replay two sides against a base without building
// formula engines. A Project keeps a Doc as its truth and mirrors every op into its
// workbook and engine.
//
// Rows and columns are axes of stable IDs. Deleted IDs stay in the order as tombstones,
// so formulas pointing at them show #REF! and a restore brings them back unchanged.

import { contentKey, stableJson, type Content } from "../formula/content.ts";
import type { ColId, PackId, RowId, SheetId, SheetKind } from "../formula/model.ts";
import type { Schema } from "../schema/model.ts";
import { resolveSchema, type ResolvedSchema } from "../schema/resolve.ts";
import type { Layout } from "../project/layout.ts";
import { forkMap } from "./cowmap.ts";

export type Axis = "row" | "col";

/** An op that can't apply to the document as it is. The document is unchanged. */
export class OpError extends Error {
  override name = "OpError";
}

/** User formatting for one cell (§6.7): fill, text color, bold, number format… Never validated. */
export type Format = { [k: string]: string | number | boolean };

export interface AxisDoc {
  /** Full order, tombstones included. Change it only through the helpers in ops.ts, which reset `index`. */
  order: string[];
  dead: Set<string>;
  /** Cache: ID -> index in `order`. Rebuilt on demand. */
  index?: Map<string, number> | undefined;
}

export interface SheetDoc {
  id: SheetId;
  name: string;
  pack: PackId;
  kind: SheetKind;
  rows: AxisDoc;
  cols: AxisDoc;
  /** `${row}|${col}` -> content. Absent means empty. */
  cells: Map<string, Content>;
  formats: Map<string, Format>;
  /** Custom layouts by type name. Types without one use the default (§6.3). */
  layouts: Map<string, Layout>;
  /** Flags on rows, by stable row ID: `keepHere` is "don't suggest moving" (§7.4). */
  rowFlags: Map<RowId, Set<RowFlag>>;
  /**
   * Its rows, columns, cells, formats, layouts and flags are shared with a copy (cloneDoc):
   * `own` copies them before a write. Not part of the document.
   */
  shared?: boolean;
}

/** A flag a row can carry. */
/**
 * A flag a row can carry: `keepHere`, "don't suggest moving" (§7.4); `wizard:<name>`, made by a
 * run of that wizard (§9.3), so the next run can go after the last one.
 */
export type RowFlag = "keepHere" | `wizard:${string}`;
export const isRowFlag = (x: unknown): x is RowFlag => x === "keepHere" || (typeof x === "string" && /^wizard:[A-Za-z_]\w*$/.test(x));

export interface PackDoc {
  id: PackId;
  name: string;
  parent: PackId | null;
}

export interface Doc {
  schema: Schema;
  packs: Map<PackId, PackDoc>;
  /** In tab order. */
  sheets: Map<SheetId, SheetDoc>;
}

export const cellKey = (row: RowId, col: ColId): string => `${row}|${col}`;
export const splitCellKey = (k: string): [RowId, ColId] => {
  const i = k.indexOf("|");
  return [k.slice(0, i), k.slice(i + 1)];
};

export function emptyDoc(schema: Schema, rootPack = "root"): Doc {
  return { schema, packs: new Map([[rootPack, { id: rootPack, name: rootPack, parent: null }]]), sheets: new Map() };
}

export function rootPack(doc: Doc): PackId {
  for (const p of doc.packs.values()) if (p.parent === null) return p.id;
  throw new Error("no root pack");
}

export const axisOf = (s: SheetDoc, axis: Axis): AxisDoc => (axis === "row" ? s.rows : s.cols);
export const liveIds = (a: AxisDoc): string[] => a.order.filter((id) => !a.dead.has(id));

function indexOf(a: AxisDoc): Map<string, number> {
  if (!a.index) a.index = new Map(a.order.map((id, i) => [id, i]));
  return a.index;
}
/** A sheet that's about to be written: its parts, if shared with a copy, are copied first. */
export function own(s: SheetDoc): SheetDoc {
  if (!s.shared) return s;
  s.rows = { order: [...s.rows.order], dead: new Set(s.rows.dead) };
  s.cols = { order: [...s.cols.order], dead: new Set(s.cols.dead) };
  // Cells and formats can be large: copy-on-write maps, which copy only their recent changes.
  s.cells = forkMap(s.cells);
  s.formats = forkMap(s.formats);
  s.layouts = new Map(s.layouts);
  s.rowFlags = new Map([...s.rowFlags].map(([r, f]) => [r, new Set(f)]));
  s.shared = false;
  return s;
}

/** Position in the full order, or -1. */
export const posIn = (a: AxisDoc, id: string): number => indexOf(a).get(id) ?? -1;
export const hasId = (a: AxisDoc, id: string): boolean => indexOf(a).has(id);
export const isLive = (a: AxisDoc, id: string): boolean => !a.dead.has(id) && hasId(a, id);

/**
 * A copy of a document. Copy-on-write by sheet: each sheet's rows, columns, cells and the
 * rest are shared with the original until either writes to that sheet (ops.ts takes each
 * sheet it writes through `own`), so copying a large document costs little, and a change
 * copies only the sheets it touches.
 */
export function cloneDoc(doc: Doc): Doc {
  const sheets = new Map<SheetId, SheetDoc>();
  for (const [id, s] of doc.sheets) {
    s.shared = true;
    sheets.set(id, { ...s });
  }
  const packs = new Map<PackId, PackDoc>();
  for (const [id, p] of doc.packs) packs.set(id, { ...p });
  return { schema: doc.schema, packs, sheets };
}

/** A plain, ordered form of the document, for comparing and printing. */
export function canonDoc(doc: Doc): unknown {
  const sorted = <V>(m: Map<string, V>, f: (v: V) => unknown) =>
    [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => [k, f(v)]);
  return {
    schema: stableJson(doc.schema),
    packs: sorted(doc.packs, (p) => [p.name, p.parent]),
    sheets: [...doc.sheets.values()].map((s) => ({
      id: s.id,
      name: s.name,
      pack: s.pack,
      kind: s.kind,
      rows: s.rows.order.map((r) => (s.rows.dead.has(r) ? `~${r}` : r)),
      cols: s.cols.order.map((c) => (s.cols.dead.has(c) ? `~${c}` : c)),
      cells: sorted(s.cells, contentKey),
      formats: sorted(s.formats, stableJson),
      layouts: sorted(s.layouts, stableJson),
      rowFlags: sorted(s.rowFlags, (f) => [...f].sort()),
    })),
  };
}

/**
 * Whether two documents are the same: what comparing their canonDoc()s says, without
 * building them. Cells still the same object (cloneDoc keeps them) aren't compared as JSON,
 * and it stops at the first difference, so it costs little more than walking the cells.
 */
export function docsEqual(a: Doc, b: Doc): boolean {
  if (a === b) return true;
  if (a.schema !== b.schema && stableJson(a.schema) !== stableJson(b.schema)) return false;
  if (a.packs.size !== b.packs.size) return false;
  for (const [id, p] of a.packs) {
    const q = b.packs.get(id);
    if (!q || q.name !== p.name || q.parent !== p.parent) return false;
  }
  if (a.sheets.size !== b.sheets.size) return false;
  const others = b.sheets.values();
  for (const s of a.sheets.values()) {
    const t = others.next().value!; // in order, as canonDoc lists them
    if (s.id !== t.id || s.name !== t.name || s.pack !== t.pack || s.kind !== t.kind) return false;
    // Parts still shared between copies (cloneDoc) are the same without looking.
    if ((s.rows !== t.rows && !sameAxis(s.rows, t.rows)) || (s.cols !== t.cols && !sameAxis(s.cols, t.cols))) return false;
    if (s.cells !== t.cells && !sameEntries(s.cells, t.cells, (x, y) => contentKey(x) === contentKey(y))) return false;
    if (s.formats !== t.formats && !sameEntries(s.formats, t.formats, (x, y) => stableJson(x) === stableJson(y))) return false;
    if (s.layouts !== t.layouts && !sameEntries(s.layouts, t.layouts, (x, y) => stableJson(x) === stableJson(y))) return false;
    if (s.rowFlags !== t.rowFlags && !sameEntries(s.rowFlags, t.rowFlags, (x, y) => x.size === y.size && [...x].every((f) => y.has(f)))) return false;
  }
  return true;
}

/** The same order, with the same of it deleted (what canonDoc writes as `~id`). */
function sameAxis(a: AxisDoc, b: AxisDoc): boolean {
  if (a.order.length !== b.order.length) return false;
  for (let i = 0; i < a.order.length; i++) {
    const x = a.order[i]!;
    if (x !== b.order[i] || a.dead.has(x) !== b.dead.has(x)) return false;
  }
  return true;
}

function sameEntries<V>(a: Map<string, V>, b: Map<string, V>, same: (x: V, y: V) => boolean): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k)) return false;
    const w = b.get(k)!;
    if (v !== w && !same(v, w)) return false;
  }
  return true;
}

const resolved = new WeakMap<Schema, ResolvedSchema>();
/** The resolved form of a doc's schema, cached per schema object (schemas are replaced, never mutated). */
export function resolvedSchema(doc: Doc): ResolvedSchema {
  let r = resolved.get(doc.schema);
  if (!r) resolved.set(doc.schema, (r = resolveSchema(doc.schema)));
  return r;
}

/** Seed the cache with a schema that was resolved elsewhere (it may carry parse issues). */
export function primeResolved(schema: ResolvedSchema): void {
  resolved.set(schema.schema, schema);
}

// ------------------------------------------------------------ as JSON

/**
 * A document as JSON, exactly: tombstones, cell contents (formulas as bound expressions,
 * over stable row and column IDs), formats and layouts. For a project kept in a file.
 */
export interface DocJson {
  format: "sapwood-doc";
  version: 1;
  schema: Schema;
  packs: PackDoc[];
  sheets: {
    id: SheetId;
    name: string;
    pack: PackId;
    kind: SheetKind;
    rows: { order: string[]; dead: string[] };
    cols: { order: string[]; dead: string[] };
    /** [row|col key, content], in key order. */
    cells: [string, Content][];
    formats: [string, Format][];
    layouts: [string, Layout][];
    /** [row, flags]; absent in documents from before row flags. */
    rowFlags?: [string, RowFlag[]][];
  }[];
}

export function docToJson(doc: Doc): DocJson {
  const sorted = <V>(m: Map<string, V>): [string, V][] => [...m].filter(([, v]) => v !== null).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const axis = (a: AxisDoc) => ({ order: [...a.order], dead: a.order.filter((id) => a.dead.has(id)) });
  return {
    format: "sapwood-doc",
    version: 1,
    schema: doc.schema,
    packs: [...doc.packs.values()].map((p) => ({ ...p })),
    sheets: [...doc.sheets.values()].map((s) => ({
      id: s.id,
      name: s.name,
      pack: s.pack,
      kind: s.kind,
      rows: axis(s.rows),
      cols: axis(s.cols),
      cells: sorted(s.cells),
      formats: sorted(s.formats),
      layouts: sorted(s.layouts),
      rowFlags: [...s.rowFlags].filter(([, f]) => f.size).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([r, f]) => [r, [...f].sort()]),
    })),
  };
}

export function docFromJson(json: unknown): Doc {
  const j = json as Partial<DocJson> | null;
  if (!j || typeof j !== "object" || j.format !== "sapwood-doc") throw new Error("Not a Sapwood document");
  if (j.version !== 1) throw new Error(`Unsupported Sapwood document version ${String(j.version)}`);
  const axis = (a: { order: string[]; dead: string[] }): AxisDoc => ({ order: [...a.order], dead: new Set(a.dead) });
  return {
    schema: j.schema!,
    packs: new Map(j.packs!.map((p) => [p.id, { ...p }])),
    sheets: new Map(
      j.sheets!.map((s) => [
        s.id,
        { id: s.id, name: s.name, pack: s.pack, kind: s.kind, rows: axis(s.rows), cols: axis(s.cols), cells: new Map(s.cells), formats: new Map(s.formats), layouts: new Map(s.layouts), rowFlags: new Map((s.rowFlags ?? []).map(([r, f]) => [r, new Set(f)])) },
      ]),
    ),
  };
}
