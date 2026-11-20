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

export type Axis = "row" | "col";

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
}

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
/** Position in the full order, or -1. */
export const posIn = (a: AxisDoc, id: string): number => indexOf(a).get(id) ?? -1;
export const hasId = (a: AxisDoc, id: string): boolean => indexOf(a).has(id);
export const isLive = (a: AxisDoc, id: string): boolean => !a.dead.has(id) && hasId(a, id);

export function cloneDoc(doc: Doc): Doc {
  const sheets = new Map<SheetId, SheetDoc>();
  for (const [id, s] of doc.sheets)
    sheets.set(id, {
      ...s,
      rows: { order: [...s.rows.order], dead: new Set(s.rows.dead) },
      cols: { order: [...s.cols.order], dead: new Set(s.cols.dead) },
      cells: new Map(s.cells),
      formats: new Map(s.formats),
      layouts: new Map(s.layouts),
    });
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
    })),
  };
}

export function docsEqual(a: Doc, b: Doc): boolean {
  return JSON.stringify(canonDoc(a)) === JSON.stringify(canonDoc(b));
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
