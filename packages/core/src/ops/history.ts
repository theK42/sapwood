// History of one entity or one cell (DESIGN §8.7): which of a run of commits changed it.
// The commits' ops are replayed once over the document they start from. An entity is
// followed by its ID (renames followed back from the ID it has at the end) wherever its row
// is, so a move to another sheet or pack is a change, not an end; a cell by its stable sheet,
// row and column IDs. What it was before and after each change is for the caller to read.
//
// Comparing an entity's rows means finding them, a scan of every data sheet; so it's done
// only after a commit that could have changed them (`mayTouch`): one that mentions one of its
// rows, writes an ID cell, renames its ID, or changes a sheet's columns or the schema.

import { contentKey } from "../formula/content.ts";
import type { ColId, RowId, SheetId } from "../formula/model.ts";
import { cellKey, cloneDoc, hasId, liveIds, type Doc } from "./doc.ts";
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

interface Found {
  key: string;
  /** `sheet|row` of each of its rows. */
  rows: Set<string>;
}

/** The entity's rows, by its ID in column B: everything about them, as one string to compare. */
function findEntity(doc: Doc, id: string): Found {
  const out: unknown[] = [];
  const rows = new Set<string>();
  for (const s of doc.sheets.values()) {
    if (s.kind !== "data") continue;
    const cols = liveIds(s.cols);
    const b = cols[1];
    if (b === undefined) continue;
    for (const row of liveIds(s.rows)) {
      const c = s.cells.get(cellKey(row, b));
      if (!c || !("v" in c) || c.v !== id) continue;
      rows.add(`${s.id}|${row}`);
      out.push([s.id, s.pack, row, cols.map((col) => contentKey(s.cells.get(cellKey(row, col)) ?? null)), [...(s.rowFlags.get(row) ?? [])].sort()]);
    }
  }
  return { key: JSON.stringify(out), rows };
}

/** Whether a step could change the entity with these rows and IDs (a superset: false means it didn't). */
function mayTouch(doc: Doc, ops: readonly Op[], rows: Set<string>, ids: Set<string>): boolean {
  const sheets = new Set([...rows].map((r) => r.slice(0, r.indexOf("|"))));
  const colB = (sheet: SheetId) => liveIds(doc.sheets.get(sheet)?.cols ?? { order: [], dead: new Set() })[1];
  for (const op of ops)
    switch (op.kind) {
      case "setCell":
        if (rows.has(`${op.sheet}|${op.row}`) || op.col === colB(op.sheet)) return true; // its row, or an ID cell anywhere
        break;
      case "setFormat":
      case "setRowFlag":
        if (rows.has(`${op.sheet}|${op.row}`)) return true;
        break;
      case "insert":
      case "delete":
      case "move":
      case "purge":
      case "restore":
        if (op.axis === "col" ? sheets.has(op.sheet) : op.ids.some((r) => rows.has(`${op.sheet}|${r}`))) return true;
        if (op.axis === "row" && (op.kind === "restore" || op.kind === "insert")) return true; // a row coming back may hold the ID
        break;
      case "renameId":
        if (ids.has(op.from) || ids.has(op.to)) return true;
        break;
      case "setLayout":
      case "setSheetPack":
      case "setPackParent":
      case "renameSheet":
      case "removeSheet":
        if (!("sheet" in op) || sheets.has(op.sheet)) return true;
        break;
      default:
        return true; // schema changes and anything else: look
    }
  return false;
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
  let found: Found | null = findEntity(doc, before[0] ?? id);
  steps.forEach((step, i) => {
    if (found === null) found = findEntity(doc, before[i]!);
    const may = mayTouch(doc, step.ops, found.rows, new Set([before[i]!, after[i]!]));
    for (const op of step.ops) applyOp(doc, op);
    if (!may && before[i] === after[i]) return;
    const now = findEntity(doc, after[i]!);
    if (now.key !== found.key) out.push({ index: i, commit: step.commit, idBefore: before[i]!, idAfter: after[i]! });
    found = before[i + 1] === after[i] ? now : null;
  });
  return out;
}

/** A cell's contents, or that it's gone (its row or column deleted). */
function cellState(doc: Doc, sheet: SheetId, row: RowId, col: ColId): string {
  const s = doc.sheets.get(sheet);
  if (!s || s.rows.dead.has(row) || s.cols.dead.has(col) || !hasId(s.rows, row) || !hasId(s.cols, col)) return "~gone";
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
