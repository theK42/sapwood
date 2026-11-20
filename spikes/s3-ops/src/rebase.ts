// Rebase a task's ops ("mine") onto a branch head that has moved on ("theirs").
//
// Both sequences start from the same base. Conflicts are decided on each side's net
// effect, a three-way comparison of base, mine and theirs, so writing a cell and then
// writing it back is not a change. The rebased ops are then produced op by op against
// the head, so a task keeps its own history (undo, per-op blame):
//
//  - Cell writes on cells theirs also changed are dropped, then re-added as a fix-up
//    only where a conflict is resolved for mine.
//  - Inserts and moves keep their anchor row. Rows theirs placed at the same anchor
//    stay first: the earlier-landed side goes first (DESIGN §8.5).
//  - renameId is an intent op (§8.2). It is re-run against the head, so it also
//    rewrites references theirs added.
//  - Formats are last-write-wins, and mine lands last.

import {
  applyInPlace,
  clone,
  dead,
  isLive,
  key,
  order,
  sheet,
  splitKey,
  type Axis,
  type Op,
  type SheetId,
  type State,
} from "./model.ts";

export type Side = "mine" | "theirs";

export type Conflict =
  | { kind: "cell"; sheet: SheetId; row: string; col: string; base: string; mine: string; theirs: string }
  | { kind: "deleted"; sheet: SheetId; axis: Axis; id: string; deletedBy: Side }
  | { kind: "move"; sheet: SheetId; axis: Axis; id: string; mine: string | null; theirs: string | null }
  | { kind: "rename"; from: string; mine: string; theirs: string };

export type Resolve = (c: Conflict) => Side;

/** What one side's ops did, relative to the base. */
export interface Analysis {
  final: State;
  /** Net cell changes: `${sheet}/${row}|${col}` -> final content. */
  cells: Map<string, string>;
  formats: Map<string, string>;
  /** `${sheet}/${axis}/${id}` for base rows and columns that are gone (deleted or purged). */
  deleted: Set<string>;
  /** Base rows and columns with a net cell change, or that were moved. */
  edited: Set<string>;
  /** Moved base rows and columns -> the anchor of their last move. */
  moved: Map<string, string | null>;
  /** Every row or column placed by an insert or move -> the anchor it was placed at. */
  placed: Map<string, string | null>;
  /** Base ID -> what it was finally renamed to. */
  renames: Map<string, string>;
}

const axisKey = (sheet: SheetId, axis: Axis, id: string) => `${sheet}/${axis}/${id}`;
const cellKey = (sheet: SheetId, row: string, col: string) => `${sheet}/${key(row, col)}`;
const START = "^"; // the anchor "before everything"

export function analyze(base: State, ops: readonly Op[]): Analysis {
  const final = clone(base);
  const moved = new Map<string, string | null>();
  const placed = new Map<string, string | null>();
  const renames = new Map<string, string>(); // current name -> base name
  for (const op of ops) {
    if (op.kind === "move" || op.kind === "insert") {
      for (const id of op.ids) {
        placed.set(axisKey(op.sheet, op.axis, id), op.after);
        if (op.kind === "move" && order(sheet(base, op.sheet), op.axis).includes(id))
          moved.set(axisKey(op.sheet, op.axis, id), op.after);
      }
    }
    if (op.kind === "renameId") {
      const origin = renames.get(op.from) ?? op.from;
      renames.delete(op.from);
      renames.set(op.to, origin);
    }
    applyInPlace(final, op);
  }

  const cells = new Map<string, string>();
  const formats = new Map<string, string>();
  const deleted = new Set<string>();
  const edited = new Set<string>();
  for (const [id, b] of base) {
    const f = sheet(final, id);
    for (const axis of ["row", "col"] as const)
      for (const x of order(b, axis))
        if (!dead(b, axis).has(x) && !isLive(f, axis, x)) deleted.add(axisKey(id, axis, x));
    for (const [which, out] of [["cells", cells], ["formats", formats]] as const) {
      const bm = b[which];
      const fm = f[which];
      for (const k of new Set([...bm.keys(), ...fm.keys()])) {
        const v = fm.get(k) ?? "";
        if (v === (bm.get(k) ?? "")) continue;
        out.set(`${id}/${k}`, v);
        if (which === "cells") {
          const [r, c] = splitKey(k);
          edited.add(axisKey(id, "row", r));
          edited.add(axisKey(id, "col", c));
        }
      }
    }
  }
  for (const k of moved.keys()) edited.add(k);
  const finalRenames = new Map<string, string>();
  for (const [to, from] of renames) if (to !== from) finalRenames.set(from, to);
  return { final, cells, formats, deleted, edited, moved, placed, renames: finalRenames };
}

/** The conflicts of DESIGN §8.5, from both sides' net effects. Symmetric in the two sides. */
export function detect(mine: Analysis, theirs: Analysis, base: State): Conflict[] {
  const out: Conflict[] = [];
  const goneEither = (k: string) => mine.deleted.has(k) || theirs.deleted.has(k);

  for (const [k, m] of mine.cells) {
    const t = theirs.cells.get(k);
    if (t === undefined || t === m) continue;
    const [sh, rc] = k.split("/") as [string, string];
    const [row, col] = splitKey(rc);
    if (goneEither(axisKey(sh, "row", row)) || goneEither(axisKey(sh, "col", col))) continue;
    out.push({ kind: "cell", sheet: sh, row, col, base: sheet(base, sh).cells.get(rc) ?? "", mine: m, theirs: t });
  }
  for (const [by, other, side] of [[theirs, mine, "theirs"], [mine, theirs, "mine"]] as const)
    for (const k of by.deleted) {
      if (other.deleted.has(k) || !other.edited.has(k)) continue;
      const [sh, axis, id] = k.split("/") as [string, Axis, string];
      out.push({ kind: "deleted", sheet: sh, axis, id, deletedBy: side });
    }
  for (const [k, m] of mine.moved) {
    if (!theirs.moved.has(k) || goneEither(k)) continue;
    const t = theirs.moved.get(k)!;
    if (t === m) continue;
    const [sh, axis, id] = k.split("/") as [string, Axis, string];
    out.push({ kind: "move", sheet: sh, axis, id, mine: m, theirs: t });
  }
  for (const [from, m] of mine.renames) {
    const t = theirs.renames.get(from);
    if (t !== undefined && t !== m) out.push({ kind: "rename", from, mine: m, theirs: t });
  }
  return out;
}

/** A side-independent name for a conflict, for comparing detections. */
export function conflictId(c: Conflict, swap = false): string {
  const side = (s: Side): Side => (swap ? (s === "mine" ? "theirs" : "mine") : s);
  switch (c.kind) {
    case "cell":
      return `cell ${c.sheet}/${c.row}|${c.col}`;
    case "deleted":
      return `deleted ${c.sheet}/${c.axis}/${c.id} by ${side(c.deletedBy)}`;
    case "move":
      return `move ${c.sheet}/${c.axis}/${c.id}`;
    case "rename":
      return `rename ${c.from}`;
  }
}

export interface RebaseResult {
  /** Mine, rewritten to apply on top of theirs. */
  ops: Op[];
  conflicts: Conflict[];
  /** The head with the rebased ops applied. */
  state: State;
}

/**
 * Rebase `mine` onto `theirs`; both were written against `base`. Each conflict is
 * settled by `resolve` (default: keep theirs, i.e. the head as landed).
 */
export function rebase(base: State, theirs: readonly Op[], mine: readonly Op[], resolve: Resolve = () => "theirs"): RebaseResult {
  const T = analyze(base, theirs);
  const M = analyze(base, mine);
  const conflicts = detect(M, T, base);
  const cur = clone(T.final);
  const out: Op[] = [];
  const emit = (op: Op) => {
    applyInPlace(cur, op);
    out.push(op);
  };

  const noDelete = new Set<string>(); // rows and columns mine must not delete or purge
  const noMove = new Set<string>(); // ... or move
  const restore: { sheet: SheetId; axis: Axis; id: string }[] = [];
  const renameSwap = new Map<string, Op | null>(); // mine's renames: replaced or dropped
  const swapped = new Set<string>();
  const fixups: Conflict[] = [];
  for (const c of conflicts) {
    const side = resolve(c);
    if (c.kind === "cell") fixups.push(side === "mine" ? c : { ...c, mine: c.theirs });
    else if (c.kind === "deleted") {
      const k = axisKey(c.sheet, c.axis, c.id);
      if (c.deletedBy === "theirs" && side === "mine") restore.push(c);
      if (c.deletedBy === "mine" && side === "theirs") noDelete.add(k); // keep the row
    } else if (c.kind === "move") {
      if (side === "theirs") noMove.add(axisKey(c.sheet, c.axis, c.id));
    } else if (c.kind === "rename")
      renameSwap.set(c.from, side === "theirs" ? null : { kind: "renameId", from: c.theirs, to: c.mine });
  }
  // Both moved it to the same place: nothing left for mine to do.
  for (const [k, m] of M.moved) if (T.moved.has(k) && T.moved.get(k) === m) noMove.add(k);

  // Rows theirs deleted that mine resolved to keep come back first, with their cells.
  for (const r of restore) if (dead(sheet(cur, r.sheet), r.axis).has(r.id)) emit({ kind: "restore", sheet: r.sheet, axis: r.axis, ids: [r.id] });

  const baseName = new Map<string, string>(); // mine's current name -> base name, for renames
  const ctx = clone(base); // the sheet as mine saw it when writing each op
  const mineMoved = new Set<string>(); // rows mine' really moved on the head
  const ctxMoved = new Set<string>(); // rows mine moved as written
  const place = (sh: SheetId, axis: Axis, after: string | null, moving: string[]) => {
    const at = anchor(cur, ctx, T, (k) => (T.moved.has(k) || ctxMoved.has(k)) && !mineMoved.has(k), sh, axis, after, moving);
    for (const id of moving) mineMoved.add(axisKey(sh, axis, id));
    return at;
  };
  for (const op of mine) {
    switch (op.kind) {
      case "setCell": {
        // Cells theirs changed are settled by the fix-ups, unless theirs deleted the row or
        // column and mine chose to keep it: then mine's writes apply as made.
        const restored = T.deleted.has(axisKey(op.sheet, "row", op.row)) || T.deleted.has(axisKey(op.sheet, "col", op.col));
        const k = cellKey(op.sheet, op.row, op.col);
        if (T.cells.has(k) && !(restored && M.cells.has(k))) break;
        const s = sheet(cur, op.sheet);
        if (isLive(s, "row", op.row) && isLive(s, "col", op.col)) emit(op);
        break;
      }
      case "setFormat": {
        // Last write wins, but only for a real change: a format set and then cleared
        // must not wipe theirs.
        if (!M.formats.has(cellKey(op.sheet, op.row, op.col))) break;
        const s = sheet(cur, op.sheet);
        if (isLive(s, "row", op.row) && isLive(s, "col", op.col)) emit(op);
        break;
      }
      case "insert":
        emit({ ...op, after: place(op.sheet, op.axis, op.after, []) });
        break;
      case "move": {
        const s = sheet(cur, op.sheet);
        const ids = op.ids.filter((id) => isLive(s, op.axis, id) && !noMove.has(axisKey(op.sheet, op.axis, id)));
        if (ids.length) emit({ ...op, ids, after: place(op.sheet, op.axis, op.after, ids) });
        break;
      }
      case "delete": {
        const s = sheet(cur, op.sheet);
        const ids = op.ids.filter((id) => isLive(s, op.axis, id) && !noDelete.has(axisKey(op.sheet, op.axis, id)));
        if (ids.length) emit({ ...op, ids });
        break;
      }
      case "purge": {
        const s = sheet(cur, op.sheet);
        const present = op.ids.filter((id) => order(s, op.axis).includes(id) && !noDelete.has(axisKey(op.sheet, op.axis, id)));
        // Rows theirs wrote into can't be purged without losing data: delete them instead.
        const busy = (id: string) =>
          [...s.cells.keys(), ...s.formats.keys()].some((k) => splitKey(k)[op.axis === "row" ? 0 : 1] === id);
        const purge = present.filter((id) => !busy(id) && !dead(s, op.axis).has(id));
        const del = present.filter((id) => busy(id) && !dead(s, op.axis).has(id));
        if (purge.length) emit({ ...op, ids: purge });
        if (del.length) emit({ kind: "delete", sheet: op.sheet, axis: op.axis, ids: del });
        break;
      }
      case "restore": {
        const s = sheet(cur, op.sheet);
        const ids = op.ids.filter((id) => dead(s, op.axis).has(id));
        if (ids.length) emit({ ...op, ids });
        break;
      }
      case "renameId": {
        const origin = baseName.get(op.from) ?? op.from;
        baseName.delete(op.from);
        baseName.set(op.to, origin);
        const swap = renameSwap.get(origin);
        if (swap === undefined) emit(op);
        else if (swap !== null && !swapped.has(origin)) {
          emit(swap); // once for the whole chain a -> b -> c
          swapped.add(origin);
        }
        break;
      }
    }
    if (op.kind === "move") for (const id of op.ids) ctxMoved.add(axisKey(op.sheet, op.axis, id));
    applyInPlace(ctx, op);
  }

  // Settle conflicted cells explicitly: a re-run rename may have touched them.
  for (const c of fixups) {
    if (c.kind !== "cell") continue;
    const s = sheet(cur, c.sheet);
    if (!isLive(s, "row", c.row) || !isLive(s, "col", c.col)) continue;
    if ((s.cells.get(key(c.row, c.col)) ?? "") !== c.mine) emit({ kind: "setCell", sheet: c.sheet, row: c.row, col: c.col, content: c.mine });
  }
  return { ops: out, conflicts, state: cur };
}

/**
 * Where an insert or move anchored after `after` goes on the head.
 *
 * - If the anchor is still where mine saw it, the rows go right after it.
 * - If the anchor is no longer where mine saw it (or is gone), they stay put: the anchor becomes
 *   its predecessor as mine saw the sheet, repeatedly. Following the moved anchor
 *   instead would make the result depend on which side landed first.
 * - Then they skip past rows theirs placed at the same spot (recursively), so the
 *   earlier-landed side comes first (DESIGN §8.5).
 */
function anchor(
  cur: State,
  ctx: State,
  T: Analysis,
  /** The row is not where mine saw it: theirs moved it, or mine's own move of it was dropped. */
  movedAway: (k: string) => boolean,
  sh: SheetId,
  axis: Axis,
  after: string | null,
  moving: string[],
): string | null {
  const ord = order(sheet(cur, sh), axis);
  const ctxOrd = order(sheet(ctx, sh), axis);
  const displaced = (id: string) => {
    const k = axisKey(sh, axis, id);
    return !ord.includes(id) || moving.includes(id) || movedAway(k);
  };
  let a = after;
  while (a !== null && displaced(a)) {
    const i = ctxOrd.indexOf(a);
    a = i > 0 ? ctxOrd[i - 1]! : null;
  }
  const skipped = new Set<string>([a ?? START]);
  let i = a === null ? -1 : ord.indexOf(a);
  for (;;) {
    const next = ord[i + 1];
    if (next === undefined || moving.includes(next)) break;
    const k = axisKey(sh, axis, next);
    if (!T.placed.has(k) || !skipped.has(T.placed.get(k) ?? START)) break;
    skipped.add(next);
    i++;
  }
  return i < 0 ? null : ord[i]!;
}
