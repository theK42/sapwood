// The ops that take one document to another with the same schema shape, packs and sheets:
// schema properties (names, types, enum members), rows and columns (added, removed, moved,
// deleted), cells, formats, layouts, row flags, sheet names and packs, and the order of sheets
// and packs. The difference, said plainly:
// for when two ways of getting to one state disagree a little (a rebase in each direction
// around a move or a rename), and for restoring an earlier state without undoing every
// change since, one by one.

import { contentKey, stableJson } from "../formula/content.ts";
import { axisOf, cloneDoc, isLive, siblingBefore, splitCellKey, type Doc } from "./doc.ts";
import { applyOp, OpError, type Op } from "./ops.ts";
import { propsOf, schemaNodes, siblings, type SchemaParent } from "./schema.ts";

/**
 * Ops taking `from` to exactly `to`, or null when they differ in which schema nodes there
 * are or their order, in packs, or in which sheets there are.
 */
export function reconcile(from: Doc, to: Doc): Op[] | null {
  const fromNodes = schemaNodes(from.schema), toNodes = schemaNodes(to.schema);
  const shape = (d: Doc, nodes: Map<string, { parent: SchemaParent }>) =>
    JSON.stringify([...nodes.values()].map((n) => [n.parent, siblings(d.schema, n.parent).map((x) => x.id)]).sort());
  if (fromNodes.size !== toNodes.size || shape(from, fromNodes) !== shape(to, toNodes)) return null;
  // In any order: the order is set below.
  const packs = (d: Doc) => stableJson([...d.packs].sort(([a], [b]) => (a < b ? -1 : 1)));
  if (packs(from) !== packs(to)) return null;
  const ids = (d: Doc) => [...d.sheets.values()].map((s) => `${s.id}:${s.kind}`).sort().join(",");
  if (ids(from) !== ids(to)) return null;

  const doc = cloneDoc(from);
  const ops: Op[] = [];
  const emit = (op: Op) => {
    applyOp(doc, op);
    ops.push(op);
  };
  try {
    // Schema properties, set as values: a name written this way rewrites nothing.
    for (const [id, n] of toNodes) {
      const want = propsOf(n.def), have = propsOf(fromNodes.get(id)!.def);
      for (const key of new Set([...Object.keys(have), ...Object.keys(want)]))
        if (stableJson(have[key]) !== stableJson(want[key]))
          emit(want[key] === undefined ? { kind: "setSchema", id, key } : { kind: "setSchema", id, key, value: want[key] });
    }
    if (stableJson(doc.schema) !== stableJson(to.schema)) return null;
    // Packs, then sheets, in `to`'s order, each after the sibling it follows there.
    for (const p of to.packs.values()) {
      if (p.parent === null) continue;
      const want = siblingBefore(to.packs, p.id, (x) => x.parent === p.parent);
      if (siblingBefore(doc.packs, p.id, (x) => x.parent === p.parent) !== want) emit({ kind: "orderPack", pack: p.id, after: want });
    }
    for (const t of to.sheets.values()) {
      const sh = t.id;
      const s = () => doc.sheets.get(sh)!;
      if (s().name !== t.name) emit({ kind: "renameSheet", sheet: sh, name: t.name });
      if (s().pack !== t.pack) emit({ kind: "setSheetPack", sheet: sh, pack: t.pack });
      // Rows and columns `to` has that this doesn't come back with their own IDs; ones it
      // doesn't have are removed at the end, once they're empty.
      const extra = { row: new Set<string>(), col: new Set<string>() };
      for (const axis of ["row", "col"] as const) {
        const want = axisOf(t, axis).order;
        const wanted = new Set(want);
        want.forEach((id, i) => {
          if (!axisOf(s(), axis).order.includes(id)) emit({ kind: "insert", sheet: sh, axis, after: i ? want[i - 1]! : null, ids: [id] });
        });
        for (const id of axisOf(s(), axis).order) if (!wanted.has(id)) extra[axis].add(id);
        // Keep the longest run already in order; move the rest, each after its predecessor.
        const have = axisOf(s(), axis).order.filter((id) => wanted.has(id));
        const pos = new Map(want.map((id, i) => [id, i]));
        const keep = new Set(longestRising(have.map((id) => pos.get(id)!)).map((i) => want[i]!));
        want.forEach((id, i) => {
          if (!keep.has(id)) emit({ kind: "move", sheet: sh, axis, after: i ? want[i - 1]! : null, ids: [id] });
        });
      }
      // Restores and deletes before cell writes, so they know whether they are seen. Extra
      // rows come back too, to be emptied and removed.
      for (const axis of ["row", "col"] as const) {
        const a = axisOf(t, axis);
        const back = axisOf(s(), axis).order.filter((id) => axisOf(s(), axis).dead.has(id) && (extra[axis].has(id) || !a.dead.has(id)));
        if (back.length) emit({ kind: "restore", sheet: sh, axis, ids: back });
      }
      for (const axis of ["row", "col"] as const) {
        const a = axisOf(t, axis);
        const gone = axisOf(s(), axis).order.filter((id) => !axisOf(s(), axis).dead.has(id) && a.dead.has(id));
        if (gone.length) emit({ kind: "delete", sheet: sh, axis, ids: gone });
      }
      const seen = (k: string) => {
        const [r, c] = splitCellKey(k);
        return isLive(s().rows, r) && isLive(s().cols, c);
      };
      for (const k of new Set([...s().cells.keys(), ...t.cells.keys()])) {
        const want = t.cells.get(k) ?? null;
        if (contentKey(s().cells.get(k) ?? null) === contentKey(want)) continue;
        const [row, col] = splitCellKey(k);
        emit(seen(k) ? { kind: "setCell", sheet: sh, row, col, content: want } : { kind: "setCell", sheet: sh, row, col, content: want, hidden: true });
      }
      for (const k of new Set([...s().formats.keys(), ...t.formats.keys()])) {
        const want = t.formats.get(k) ?? null;
        if (stableJson(s().formats.get(k) ?? null) === stableJson(want)) continue;
        const [row, col] = splitCellKey(k);
        emit(seen(k) ? { kind: "setFormat", sheet: sh, row, col, format: want } : { kind: "setFormat", sheet: sh, row, col, format: want, hidden: true });
      }
      for (const type of new Set([...s().layouts.keys(), ...t.layouts.keys()])) {
        const want = t.layouts.get(type) ?? null;
        if (stableJson(s().layouts.get(type) ?? null) !== stableJson(want)) emit({ kind: "setLayout", sheet: sh, type, layout: want });
      }
      // Row flags, before rows go.
      for (const row of new Set([...s().rowFlags.keys(), ...t.rowFlags.keys()]))
        for (const flag of new Set([...(s().rowFlags.get(row) ?? []), ...(t.rowFlags.get(row) ?? [])])) {
          const want = t.rowFlags.get(row)?.has(flag) ?? false;
          if ((s().rowFlags.get(row)?.has(flag) ?? false) !== want) emit({ kind: "setRowFlag", sheet: sh, row, flag, on: want });
        }
      for (const axis of ["row", "col"] as const) if (extra[axis].size) emit({ kind: "purge", sheet: sh, axis, ids: [...extra[axis]] });
    }
    // Sheets in `to`'s order, now each is in its pack.
    for (const t of to.sheets.values()) {
      const want = siblingBefore(to.sheets, t.id, (x) => x.pack === t.pack);
      if (siblingBefore(doc.sheets, t.id, (x) => x.pack === t.pack) !== want) emit({ kind: "orderSheet", sheet: t.id, after: want });
    }
  } catch (e) {
    if (e instanceof OpError) return null; // a move the sheet doesn't allow, say
    throw e;
  }
  return ops;
}

/** The values (not indices) of a longest strictly rising subsequence. */
function longestRising(xs: number[]): number[] {
  const tails: number[] = []; // index into xs of the smallest tail of a run of each length
  const prev: number[] = new Array(xs.length).fill(-1);
  xs.forEach((x, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]!]! < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) out.unshift(xs[i]!);
  return out;
}

