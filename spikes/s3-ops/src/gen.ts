// Random states and valid op sequences for the property tests. Values come from a
// small vocabulary on purpose, so that concurrent edits collide often: the same cells,
// the same anchors, and IDs that renames will hit.

import fc from "fast-check";
import { applyInPlace, clone, ID_COL, live, newSheet, order, sheet, TYPE_COL, type Axis, type Op, type State } from "./model.ts";

export type Gen = fc.GeneratorValue;

const IDS = ["a", "b", "c", "d"];
const CONTENT = ["", "1", "2", ...IDS, "a, b", "c,d", '=ENTITY("a").x', "=1+2"];
const FORMATS = ["", "bold", "red"];

export const int = (g: Gen, max: number): number => g(fc.integer, { min: 0, max });
export const pick = <T>(g: Gen, xs: readonly T[]): T => xs[int(g, xs.length - 1)]!;

export function genState(g: Gen): State {
  const st: State = new Map();
  for (const id of ["S", "T"]) {
    const rows = Array.from({ length: 2 + int(g, 3) }, (_, i) => `${id}r${i}`);
    const s = newSheet(rows, ["c1", "c2"]);
    for (const r of rows)
      for (const c of s.cols) {
        const v = c === TYPE_COL ? pick(g, ["", "Weapon"]) : c === ID_COL ? pick(g, ["", ...IDS]) : pick(g, CONTENT);
        if (v) s.cells.set(`${r}|${c}`, v);
      }
    st.set(id, s);
  }
  return st;
}

/** A sequence of ops, each valid on the state it is applied to. Fresh IDs start with `prefix`. */
export function genOps(g: Gen, base: State, prefix: string, maxLen = 6): Op[] {
  const st = clone(base);
  const ops: Op[] = [];
  let fresh = 0;
  const n = int(g, maxLen);
  for (let i = 0; i < n; i++) {
    const op = genOp(g, st, () => `${prefix}_${++fresh}`);
    if (!op) continue;
    applyInPlace(st, op);
    ops.push(op);
  }
  return ops;
}

function genOp(g: Gen, st: State, freshId: () => string): Op | null {
  const sh = pick(g, ["S", "S", "T"]);
  const s = sheet(st, sh);
  const axis: Axis = int(g, 3) === 0 ? "col" : "row";
  const movable = live(s, axis).filter((id) => id !== TYPE_COL && id !== ID_COL);
  const kind = pick(g, ["setCell", "setCell", "setCell", "setCell", "setFormat", "insert", "insert", "delete", "move", "move", "renameId"] as const);
  switch (kind) {
    case "setCell":
    case "setFormat": {
      const rows = live(s, "row");
      if (!rows.length) return null;
      const row = pick(g, rows);
      const col = pick(g, live(s, "col"));
      if (kind === "setFormat") return { kind, sheet: sh, row, col, format: pick(g, FORMATS) };
      const content = col === TYPE_COL ? pick(g, ["", "Weapon", "Projectile"]) : col === ID_COL ? pick(g, ["", ...IDS, "e"]) : pick(g, CONTENT);
      return { kind, sheet: sh, row, col, content };
    }
    case "insert": {
      const ids = Array.from({ length: 1 + int(g, 1) }, freshId);
      return { kind, sheet: sh, axis, after: anchorFor(g, order(s, axis), []), ids };
    }
    case "delete": {
      if (!movable.length) return null;
      return { kind, sheet: sh, axis, ids: some(g, movable) };
    }
    case "move": {
      if (!movable.length) return null;
      const ids = some(g, movable);
      return { kind, sheet: sh, axis, after: anchorFor(g, order(s, axis), ids), ids };
    }
    case "renameId": {
      const from = pick(g, IDS);
      return { kind, from, to: pick(g, [...IDS, "e"].filter((x) => x !== from)) };
    }
  }
}

function some(g: Gen, xs: string[]): string[] {
  const first = pick(g, xs);
  const rest = xs.filter((x) => x !== first);
  return rest.length && int(g, 2) === 0 ? [first, pick(g, rest)] : [first];
}

/** Any position, tombstones included; the system columns stay first. */
function anchorFor(g: Gen, ord: string[], moving: string[]): string | null {
  const candidates = ord.filter((id) => !moving.includes(id) && id !== TYPE_COL);
  if (ord.includes(ID_COL)) return pick(g, candidates); // columns: never before `id`
  return int(g, candidates.length) === 0 ? null : pick(g, candidates);
}
