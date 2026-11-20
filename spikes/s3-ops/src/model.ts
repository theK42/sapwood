// A minimal workbook for testing ops: sheets with row and column axes of stable IDs,
// cells and formats keyed by (row ID, column ID), and tombstones for deleted rows and
// columns. Formula text is opaque here: S1 already stores formulas against stable IDs,
// so no op in this spike ever rewrites a formula because of a structural change.
//
// Every op is applied with `apply`, which returns the new state and the exact inverse:
// the ops that take the new state back to the old one, compared with `equal`.

export type SheetId = string;
export type Axis = "row" | "col";

/** The two system columns (DESIGN §6.2). They can't be moved or deleted. */
export const TYPE_COL = "type";
export const ID_COL = "id";

export interface Sheet {
  /** Full order, including tombstones. */
  rows: string[];
  cols: string[];
  deadRows: Set<string>;
  deadCols: Set<string>;
  /** `${row}|${col}` -> literal or formula text. Absent means empty. */
  cells: Map<string, string>;
  formats: Map<string, string>;
}

export type State = Map<SheetId, Sheet>;

export type Op =
  | { kind: "setCell"; sheet: SheetId; row: string; col: string; content: string }
  | { kind: "setFormat"; sheet: SheetId; row: string; col: string; format: string }
  | { kind: "insert"; sheet: SheetId; axis: Axis; after: string | null; ids: string[] }
  | { kind: "delete"; sheet: SheetId; axis: Axis; ids: string[] }
  | { kind: "move"; sheet: SheetId; axis: Axis; after: string | null; ids: string[] }
  | { kind: "renameId"; from: string; to: string }
  // Only produced as inverses: undo an insert, undo a delete.
  | { kind: "purge"; sheet: SheetId; axis: Axis; ids: string[] }
  | { kind: "restore"; sheet: SheetId; axis: Axis; ids: string[] };

export const key = (row: string, col: string): string => `${row}|${col}`;
export const splitKey = (k: string): [string, string] => k.split("|") as [string, string];

export class OpError extends Error {}

// ------------------------------------------------------------ state helpers

export function sheet(state: State, id: SheetId): Sheet {
  const s = state.get(id);
  if (!s) throw new OpError(`no sheet ${id}`);
  return s;
}

export const order = (s: Sheet, axis: Axis): string[] => (axis === "row" ? s.rows : s.cols);
export const dead = (s: Sheet, axis: Axis): Set<string> => (axis === "row" ? s.deadRows : s.deadCols);
export const live = (s: Sheet, axis: Axis): string[] => order(s, axis).filter((id) => !dead(s, axis).has(id));
export const isLive = (s: Sheet, axis: Axis, id: string): boolean =>
  order(s, axis).includes(id) && !dead(s, axis).has(id);

export function newSheet(rows: string[], cols: string[]): Sheet {
  return {
    rows: [...rows],
    cols: [TYPE_COL, ID_COL, ...cols],
    deadRows: new Set(),
    deadCols: new Set(),
    cells: new Map(),
    formats: new Map(),
  };
}

export function clone(state: State): State {
  const out: State = new Map();
  for (const [id, s] of state)
    out.set(id, {
      rows: [...s.rows],
      cols: [...s.cols],
      deadRows: new Set(s.deadRows),
      deadCols: new Set(s.deadCols),
      cells: new Map(s.cells),
      formats: new Map(s.formats),
    });
  return out;
}

export function equal(a: State, b: State): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** A plain, ordered form of the state, for comparing and printing. */
export function canon(state: State): unknown {
  return [...state.keys()].sort().map((id) => {
    const s = state.get(id)!;
    const sorted = (m: Map<string, string>) => [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return {
      id,
      rows: s.rows.map((r) => (s.deadRows.has(r) ? `~${r}` : r)),
      cols: s.cols.map((c) => (s.deadCols.has(c) ? `~${c}` : c)),
      cells: sorted(s.cells),
      formats: sorted(s.formats),
    };
  });
}

// ------------------------------------------------------------ renameId (DESIGN §8.2)

/**
 * The cells a rename rewrites in `state`: column B cells equal to the old ID, and every
 * literal cell equal to it or holding it as an item of a comma-separated list (§6.4).
 * Matching is exact (Q3: references are case-sensitive). Formulas are never rewritten;
 * the ones that mention the old ID as a string literal are reported instead.
 */
export function renameRewrites(state: State, from: string, to: string): {
  writes: { sheet: SheetId; row: string; col: string; prev: string; content: string }[];
  formulas: { sheet: SheetId; row: string; col: string }[];
} {
  const writes: { sheet: SheetId; row: string; col: string; prev: string; content: string }[] = [];
  const formulas: { sheet: SheetId; row: string; col: string }[] = [];
  const quoted = `"${from.replace(/"/g, '""')}"`;
  for (const [id, s] of state) {
    for (const [k, v] of s.cells) {
      const [row, col] = splitKey(k);
      if (s.deadRows.has(row) || s.deadCols.has(col) || col === TYPE_COL) continue;
      if (v.startsWith("=")) {
        if (v.includes(quoted)) formulas.push({ sheet: id, row, col });
        continue;
      }
      const next = rewriteLiteral(v, from, to);
      if (next !== v) writes.push({ sheet: id, row, col, prev: v, content: next });
    }
  }
  return { writes, formulas };
}

function rewriteLiteral(v: string, from: string, to: string): string {
  if (v === from) return to;
  if (!v.includes(",")) return v;
  const items = v.split(",");
  let changed = false;
  const out = items.map((item) => {
    const t = item.trim();
    if (t !== from) return item;
    changed = true;
    return item.replace(t, to);
  });
  return changed ? out.join(",") : v;
}

// ------------------------------------------------------------ apply

/** Apply one op. Returns the new state and the ops that undo it exactly. */
export function apply(state: State, op: Op): { state: State; inverse: Op[] } {
  const next = clone(state);
  const inverse = applyInPlace(next, op);
  return { state: next, inverse };
}

/** Apply a sequence. The inverse undoes all of it (it is already in reverse order). */
export function applyAll(state: State, ops: readonly Op[]): { state: State; inverse: Op[] } {
  const next = clone(state);
  const inverse: Op[] = [];
  for (const op of ops) inverse.unshift(...applyInPlace(next, op));
  return { state: next, inverse };
}

export function applyInPlace(state: State, op: Op): Op[] {
  switch (op.kind) {
    case "setCell":
    case "setFormat": {
      const s = sheet(state, op.sheet);
      if (!isLive(s, "row", op.row) || !isLive(s, "col", op.col))
        throw new OpError(`${op.kind} on a missing or deleted cell ${key(op.row, op.col)}`);
      const map = op.kind === "setCell" ? s.cells : s.formats;
      const value = op.kind === "setCell" ? op.content : op.format;
      const k = key(op.row, op.col);
      const prev = map.get(k) ?? "";
      if (value === "") map.delete(k);
      else map.set(k, value);
      return op.kind === "setCell"
        ? [{ ...op, content: prev }]
        : [{ ...op, format: prev }];
    }
    case "insert": {
      const s = sheet(state, op.sheet);
      const ord = order(s, op.axis);
      for (const id of op.ids) if (ord.includes(id)) throw new OpError(`insert: ${id} already exists`);
      ord.splice(anchorIndex(ord, op.after) + 1, 0, ...op.ids);
      return [{ kind: "purge", sheet: op.sheet, axis: op.axis, ids: [...op.ids] }];
    }
    case "purge": {
      const s = sheet(state, op.sheet);
      const ids = new Set(op.ids);
      for (const id of ids) if (!order(s, op.axis).includes(id)) throw new OpError(`purge: no ${id}`);
      for (const m of [s.cells, s.formats])
        for (const k of [...m.keys()]) {
          const [r, c] = splitKey(k);
          if (ids.has(op.axis === "row" ? r : c))
            throw new OpError(`purge: ${k} is not empty`); // inverses clear cells first
        }
      if (op.ids.some((id) => dead(s, op.axis).has(id))) throw new OpError("purge: restore first");
      // The purged IDs need not be contiguous (another task may have inserted between
      // them), so the inverse re-inserts each one after its own predecessor.
      const ord = order(s, op.axis);
      const inverse: Op[] = [];
      for (const id of op.ids) {
        const i = ord.indexOf(id);
        inverse.unshift({ kind: "insert", sheet: op.sheet, axis: op.axis, after: i > 0 ? ord[i - 1]! : null, ids: [id] });
        ord.splice(i, 1);
      }
      return inverse;
    }
    case "delete": {
      const s = sheet(state, op.sheet);
      for (const id of op.ids) {
        if (!isLive(s, op.axis, id)) throw new OpError(`delete: ${id} is not live`);
        if (op.axis === "col" && (id === TYPE_COL || id === ID_COL)) throw new OpError("system column");
      }
      for (const id of op.ids) dead(s, op.axis).add(id);
      return [{ kind: "restore", sheet: op.sheet, axis: op.axis, ids: [...op.ids] }];
    }
    case "restore": {
      const s = sheet(state, op.sheet);
      for (const id of op.ids) if (!dead(s, op.axis).has(id)) throw new OpError(`restore: ${id} is not deleted`);
      for (const id of op.ids) dead(s, op.axis).delete(id);
      return [{ kind: "delete", sheet: op.sheet, axis: op.axis, ids: [...op.ids] }];
    }
    case "move": {
      const s = sheet(state, op.sheet);
      const ord = order(s, op.axis);
      const ids = new Set(op.ids);
      for (const id of op.ids) {
        if (!isLive(s, op.axis, id)) throw new OpError(`move: ${id} is not live`);
        if (op.axis === "col" && (id === TYPE_COL || id === ID_COL)) throw new OpError("system column");
      }
      if (op.after !== null && ids.has(op.after)) throw new OpError("move: anchor is being moved");
      // The inverse moves each ID back after its old predecessor, last-moved first.
      const inverse: Op[] = [];
      for (const id of op.ids) {
        const i = ord.indexOf(id);
        inverse.unshift({ kind: "move", sheet: op.sheet, axis: op.axis, after: i > 0 ? ord[i - 1]! : null, ids: [id] });
        ord.splice(i, 1);
        ord.splice(anchorIndex(ord, op.after) + 1 + op.ids.indexOf(id), 0, id);
      }
      return inverse;
    }
    case "renameId": {
      const { writes } = renameRewrites(state, op.from, op.to);
      const inverse: Op[] = [];
      for (const w of writes) {
        const s = sheet(state, w.sheet);
        s.cells.set(key(w.row, w.col), w.content);
        inverse.unshift({ kind: "setCell", sheet: w.sheet, row: w.row, col: w.col, content: w.prev });
      }
      // The exact inverse is the cell writes, not renameId(to, from): cells that already
      // held `to` must stay as they were.
      return inverse;
    }
  }
}

/** Index of the anchor in the full order; -1 means "at the start". */
function anchorIndex(ord: string[], after: string | null): number {
  if (after === null) return -1;
  const i = ord.indexOf(after);
  if (i < 0) throw new OpError(`no anchor ${after}`);
  return i;
}
