// What changed between two states of a project (DESIGN §8.7: a task's diff, a commit's),
// said the way people think of it: schema definitions and fields; sheets; on each sheet,
// entities added, removed, commented out or back, and their fields before and after; other
// cells by address; and how many rows and columns were added, removed or moved, and how many
// cells' formats changed.
//
// Rows, columns and cells are matched by their stable IDs, so a moved row is a move, not a
// delete and an add, and an entity whose ID changed is that entity, renamed.

import { contentKey, stableJson } from "../formula/content.ts";
import type { ColId, RowId, SheetId } from "../formula/model.ts";
import { cellKey, liveIds, splitCellKey, type AxisDoc, type SheetDoc } from "../ops/doc.ts";
import { schemaNodes } from "../ops/schema.ts";
import { formatType, type FieldType } from "../schema/model.ts";
import { columnSpecs, sheetLayout } from "./layout.ts";
import type { Project } from "./project.ts";
import { classify } from "./rows.ts";
import { numberToCol } from "../formula/parse.ts";

export interface DocDiff {
  /** One line per schema change: "Weapon.range added", "Enemy renamed to Foe". */
  schema: string[];
  sheets: SheetDiff[];
}

export interface SheetDiff {
  /** The sheet's ID, and its name now (or when last seen, if removed). */
  sheet: SheetId;
  name: string;
  status: "added" | "removed" | "changed";
  renamedFrom?: string;
  entities: EntityDiff[];
  /** Cells not on an entity's row, by address now (or before, for a removed row). */
  cells: CellDiff[];
  rows: AxisDiff;
  cols: AxisDiff;
  /** Cells whose format changed. */
  formats: number;
}

export interface AxisDiff {
  added: number;
  removed: number;
  moved: number;
}

export interface EntityDiff {
  type: string;
  /** Its ID now (or before, if removed). */
  id: string;
  change: "added" | "removed" | "changed" | "commented out" | "uncommented";
  /** It was called this before. */
  renamedFrom?: string;
  /** Where it is now (0-based row), or null if removed. */
  row: number | null;
  /** Fields as typed, before and after ("" for blank). For an added entity, the ones it has. */
  fields: { name: string; col: number | null; before: string; after: string }[];
}

export interface CellDiff {
  /** "C4"; row and col 0-based, in the state that has it (after, unless removed). */
  where: string;
  row: number;
  col: number;
  before: string;
  after: string;
  /** On a row that's gone: row is where it was. */
  removed?: true;
}

const NO_AXIS: AxisDiff = { added: 0, removed: 0, moved: 0 };

export function diffProjects(before: Project, after: Project): DocDiff {
  const sheets: SheetDiff[] = [];
  const ids = [...new Set([...after.doc.sheets.keys(), ...before.doc.sheets.keys()])];
  for (const id of ids) {
    const d = diffSheet(before, after, id);
    if (d) sheets.push(d);
  }
  return { schema: diffSchema(before, after), sheets };
}

// ------------------------------------------------------------ sheets

function diffSheet(before: Project, after: Project, id: SheetId): SheetDiff | null {
  const s0 = before.doc.sheets.get(id);
  const s1 = after.doc.sheets.get(id);
  if (!s0 && !s1) return null;
  const name = (s1 ?? s0)!.name;
  if (!s1) return { sheet: id, name, status: "removed", entities: [], cells: [], rows: NO_AXIS, cols: NO_AXIS, formats: 0 };

  const rows0 = s0 ? liveIds(s0.rows) : [];
  const rows1 = liveIds(s1.rows);
  const cols0 = s0 ? liveIds(s0.cols) : [];
  const cols1 = liveIds(s1.cols);
  const at0 = new Map(rows0.map((r, i) => [r, i]));
  const at1 = new Map(rows1.map((r, i) => [r, i]));
  const c0 = new Map(cols0.map((c, i) => [c, i]));
  const c1 = new Map(cols1.map((c, i) => [c, i]));

  // Changed cells, grouped by row.
  const live = (rows: Map<RowId, number>, cols: Map<ColId, number>) => (k: string) => {
    const [r, c] = splitCellKey(k);
    return rows.has(r) && cols.has(c);
  };
  const live0 = live(at0, c0);
  const live1 = live(at1, c1);
  const byRow = new Map<RowId, Set<ColId>>();
  const keys = new Set([...(s0 ? [...s0.cells.keys()].filter(live0) : []), ...[...s1.cells.keys()].filter(live1)]);
  for (const k of keys) {
    const a = s0 && live0(k) ? (s0.cells.get(k) ?? null) : null;
    const b = live1(k) ? (s1.cells.get(k) ?? null) : null;
    if (contentKey(a) === contentKey(b)) continue;
    const [r, c] = splitCellKey(k);
    let set = byRow.get(r);
    if (!set) byRow.set(r, (set = new Set()));
    set.add(c);
  }
  // Rows added or removed with nothing in them still count as rows, below.
  for (const r of rows1) if (!at0.has(r) && !byRow.has(r)) byRow.set(r, new Set());
  for (const r of rows0) if (!at1.has(r) && !byRow.has(r)) byRow.set(r, new Set());

  const input = (p: Project, s: SheetDoc | undefined, rows: Map<RowId, number>, cols: Map<ColId, number>, r: RowId, c: ColId) =>
    s && rows.has(r) && cols.has(c) ? p.inputAt(s.id, r, c) : "";
  const in0 = (r: RowId, c: ColId) => input(before, s0, at0, c0, r, c);
  const in1 = (r: RowId, c: ColId) => input(after, s1, at1, c1, r, c);

  const entities: EntityDiff[] = [];
  const cells: CellDiff[] = [];
  const order = [...byRow.keys()].sort((a, b) => (at1.get(a) ?? at0.get(a)! + 0.5) - (at1.get(b) ?? at0.get(b)! + 0.5));
  for (const r of order) {
    const changed = byRow.get(r)!;
    const e = s1.kind === "data" ? entityDiff(before, after, s0, s1, r, changed, at0, at1, c1, in0, in1) : null;
    if (e) {
      if (e.change !== "changed" || e.fields.length || e.renamedFrom) entities.push(e);
      continue;
    }
    const gone = !at1.has(r);
    for (const c of changed) {
      const row = gone ? at0.get(r)! : at1.get(r)!;
      const col = gone ? c0.get(c) : c1.get(c);
      if (col === undefined) continue;
      cells.push({ where: `${numberToCol(col + 1)}${row + 1}`, row, col, before: in0(r, c), after: in1(r, c), ...(gone ? { removed: true as const } : {}) });
    }
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col);

  let formats = 0;
  const fkeys = new Set([...(s0 ? [...s0.formats.keys()].filter(live0) : []), ...[...s1.formats.keys()].filter(live1)]);
  for (const k of fkeys) if (stableJson((s0 && live0(k) ? s0.formats.get(k) : undefined) ?? null) !== stableJson((live1(k) ? s1.formats.get(k) : undefined) ?? null)) formats++;

  const d: SheetDiff = {
    sheet: id,
    name,
    status: s0 ? "changed" : "added",
    ...(s0 && s0.name !== s1.name ? { renamedFrom: s0.name } : {}),
    entities,
    cells,
    rows: axisDiff(s0?.rows, s1.rows),
    cols: axisDiff(s0?.cols, s1.cols),
    formats,
  };
  const empty = !entities.length && !cells.length && !formats && !d.renamedFrom && !d.rows.added && !d.rows.removed && !d.rows.moved && !d.cols.added && !d.cols.removed && !d.cols.moved;
  return s0 && empty ? null : d;
}

function entityDiff(
  before: Project,
  after: Project,
  s0: SheetDoc | undefined,
  s1: SheetDoc,
  r: RowId,
  changed: Set<ColId>,
  at0: Map<RowId, number>,
  at1: Map<RowId, number>,
  c1: Map<ColId, number>,
  in0: (r: RowId, c: ColId) => string,
  in1: (r: RowId, c: ColId) => string,
): EntityDiff | null {
  const [a0, b0] = s0 ? liveIds(s0.cols) : [];
  const [a1, b1] = liveIds(s1.cols);
  const k0 = a0 && at0.has(r) ? classify(before.schema, in0(r, a0)) : null;
  const k1 = a1 && at1.has(r) ? classify(after.schema, in1(r, a1)) : null;
  const was = k0?.kind === "entity" ? k0 : null;
  const is = k1?.kind === "entity" ? k1 : null;
  if (!was && !is) return null;
  const id0 = was && b0 ? in0(r, b0) : "";
  const id1 = is && b1 ? in1(r, b1) : "";

  if (!is) return { type: was!.type, id: id0, change: "removed", row: null, fields: [] };
  const t = after.schema.types.get(is.type);
  const specs = t ? columnSpecs(after.schema, t, sheetLayout(after.schema, s1, is.type)) : new Map<ColId, string>();
  const fields: EntityDiff["fields"] = [];
  if (!was) {
    for (const [c, name] of specs) {
      const v = in1(r, c);
      if (v !== "") fields.push({ name, col: c1.get(c) ?? null, before: "", after: v });
    }
    return { type: is.type, id: id1, change: "added", row: at1.get(r)!, fields };
  }
  for (const c of changed) {
    if (c === a1 || c === b1) continue;
    fields.push({ name: specs.get(c) ?? `column ${numberToCol((c1.get(c) ?? 0) + 1)}`, col: c1.get(c) ?? null, before: in0(r, c), after: in1(r, c) });
  }
  fields.sort((x, y) => (x.col ?? 0) - (y.col ?? 0));
  const change: EntityDiff["change"] = was.active && !is.active ? "commented out" : !was.active && is.active ? "uncommented" : "changed";
  if (was.type !== is.type) fields.unshift({ name: "type", col: 0, before: was.type, after: is.type });
  return { type: is.type, id: id1, change, ...(id0 !== id1 ? { renamedFrom: id0 } : {}), row: at1.get(r)!, fields };
}

/** Rows (or columns) added, removed, and moved: those not in the longest run kept in order. */
function axisDiff(a: AxisDoc | undefined, b: AxisDoc): AxisDiff {
  const x = a ? liveIds(a) : [];
  const y = liveIds(b);
  const inX = new Set(x);
  const inY = new Set(y);
  const pos = new Map(y.map((id, i) => [id, i]));
  const seq = x.filter((id) => inY.has(id)).map((id) => pos.get(id)!);
  return { added: y.filter((id) => !inX.has(id)).length, removed: x.filter((id) => !inY.has(id)).length, moved: seq.length - lisLength(seq) };
}

function lisLength(xs: readonly number[]): number {
  const tails: number[] = [];
  for (const v of xs) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (tails[m]! < v) lo = m + 1;
      else hi = m;
    }
    tails[lo] = v;
  }
  return tails.length;
}

// ------------------------------------------------------------ schema

const SKIP = new Set(["id", "fields"]);

function diffSchema(before: Project, after: Project): string[] {
  const n0 = schemaNodes(before.doc.schema);
  const n1 = schemaNodes(after.doc.schema);
  const label = (nodes: typeof n0, id: string): string => {
    const n = nodes.get(id)!;
    const name = String(n.def.name ?? n.def.id);
    return typeof n.parent === "string" && nodes.has(n.parent) ? `${label(nodes, n.parent)}.${name}` : name;
  };
  const kind = (nodes: typeof n0, id: string) => {
    const p = nodes.get(id)!.parent;
    return nodes.has(p) ? "field" : ({ types: "type", traits: "trait", structs: "struct", unions: "union", enums: "enum", rules: "rule" } as Record<string, string>)[p] ?? "definition";
  };
  const out: string[] = [];
  for (const [id] of n1) if (!n0.has(id)) out.push(`${kind(n1, id)} ${label(n1, id)} added`);
  for (const [id] of n0) if (!n1.has(id)) out.push(`${kind(n0, id)} ${label(n0, id)} removed`);
  for (const [id, n] of n1) {
    const o = n0.get(id);
    if (!o) continue;
    const was = label(n0, id);
    const keys = new Set([...Object.keys(o.def), ...Object.keys(n.def)].filter((k) => !SKIP.has(k)));
    for (const k of keys) {
      const a = o.def[k];
      const b = n.def[k];
      if (stableJson(a ?? null) === stableJson(b ?? null)) continue;
      if (k === "name") out.push(`${kind(n1, id)} ${was} renamed to ${String(b)}`);
      else out.push(`${label(n1, id)}: ${k} ${show(k, a)} → ${show(k, b)}`);
    }
  }
  return out;
}

function show(key: string, v: unknown): string {
  if (v === undefined || v === null) return "none";
  if (key === "type" && typeof v === "object") return formatType(v as FieldType);
  return typeof v === "string" ? v : JSON.stringify(v);
}

