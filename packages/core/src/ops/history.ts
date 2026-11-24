// History of one entity or one cell (DESIGN §8.7): which of a run of commits changed it.
// The commits' ops are replayed once over the document they start from. An entity is
// followed by its ID (renames followed back from the ID it has at the end) wherever its row
// is, so a move to another sheet or pack is a change, not an end; a cell by its stable sheet,
// row and column IDs. What it was before and after each change is for the caller to read.

import { contentKey } from "../formula/content.ts";
import type { ColId, RowId, SheetId } from "../formula/model.ts";
import { cellKey, cloneDoc, liveIds, type Doc } from "./doc.ts";
import { applyOp, type Op } from "./ops.ts";

export interface HistoryStep {
  /** The commit's ID, passed through. */
  commit: string;
  ops: readonly Op[];
}

/** A step that changed it, with the entity's ID before and after (they differ across a rename). */
export interface Touch {
  index: number;
  commit: string;
  idBefore: string;
  idAfter: string;
}

/** The entity's rows, by its ID in column B: everything about them, as one string to compare. */
function entityKey(doc: Doc, id: string): string {
  const out: unknown[] = [];
  for (const s of doc.sheets.values()) {
    if (s.kind !== "data") continue;
    const cols = liveIds(s.cols);
    const b = cols[1];
    if (b === undefined) continue;
    for (const row of liveIds(s.rows)) {
      const c = s.cells.get(cellKey(row, b));
      if (!c || !("v" in c) || c.v !== id) continue;
      out.push([s.id, s.pack, row, cols.map((col) => contentKey(s.cells.get(cellKey(row, col)) ?? null)), [...(s.rowFlags.get(row) ?? [])].sort()]);
    }
  }
  return JSON.stringify(out);
}

/** The steps that changed the entity whose ID is `id` after the last of them. */
export function entityTouches(start: Doc, steps: readonly HistoryStep[], id: string): Touch[] {
  // Its ID before and after each step: followed back through renames from the end.
  const after: string[] = new Array(steps.length);
  const before: string[] = new Array(steps.length);
  let cur = id;
  for (let i = steps.length - 1; i >= 0; i--) {
    after[i] = cur;
    for (const op of [...steps[i]!.ops].reverse()) if (op.kind === "renameId" && op.to === cur) cur = op.from;
    before[i] = cur;
  }
  const doc = cloneDoc(start);
  const out: Touch[] = [];
  steps.forEach((step, i) => {
    const was = entityKey(doc, before[i]!);
    for (const op of step.ops) applyOp(doc, op);
    if (entityKey(doc, after[i]!) !== was) out.push({ index: i, commit: step.commit, idBefore: before[i]!, idAfter: after[i]! });
  });
  return out;
}

/** A cell's contents, or that it's gone (its row or column deleted). */
function cellState(doc: Doc, sheet: SheetId, row: RowId, col: ColId): string {
  const s = doc.sheets.get(sheet);
  if (!s || s.rows.dead.has(row) || s.cols.dead.has(col) || !s.rows.order.includes(row) || !s.cols.order.includes(col)) return "~gone";
  return contentKey(s.cells.get(cellKey(row, col)) ?? null) + JSON.stringify(s.formats.get(cellKey(row, col)) ?? null);
}

/** The steps that changed a cell (its contents or format), or took it away or brought it back. */
export function cellTouches(start: Doc, steps: readonly HistoryStep[], sheet: SheetId, row: RowId, col: ColId): { index: number; commit: string }[] {
  const doc = cloneDoc(start);
  const out: { index: number; commit: string }[] = [];
  steps.forEach((step, i) => {
    const was = cellState(doc, sheet, row, col);
    for (const op of step.ops) applyOp(doc, op);
    if (cellState(doc, sheet, row, col) !== was) out.push({ index: i, commit: step.commit });
  });
  return out;
}
