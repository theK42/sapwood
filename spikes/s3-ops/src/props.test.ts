// Property tests for apply, invert and rebase (ROADMAP S3).
//
// The oracle for rebase is a three-way merge of whole states: for every cell, row and
// column, compare base, mine's final state and theirs' final state, and work out what
// the merged result must be. That is computed from states, not from the ops, so it is
// independent of how rebase transforms ops one at a time.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { genOps, genState, int, type Gen } from "./gen.ts";
import { applyAll, canon, equal, order, sheet, splitKey, type Axis, type Op, type State } from "./model.ts";
import { conflictId, rebase, type Conflict, type Side } from "./rebase.ts";

const RUNS = Number(process.env.RUNS ?? 3000);
const prop = (name: string, body: (g: Gen) => void) =>
  it(name, () => fc.assert(fc.property(fc.gen(), body), { numRuns: RUNS }), 600_000);

/** Run `body`; on failure, attach the inputs to the message (fast-check shrinks them first). */
function explain<T>(ctx: Record<string, unknown>, body: () => T): T {
  try {
    return body();
  } catch (e) {
    const show = (v: unknown) => JSON.stringify(v instanceof Map ? canon(v as State) : v);
    const detail = Object.entries(ctx).map(([k, v]) => `  ${k}: ${show(v)}`).join("\n");
    throw new Error(`${(e as Error).message}\n${detail}`);
  }
}

const AXES: Axis[] = ["row", "col"];
const liveIn = (st: State, sh: string, axis: Axis, id: string) => {
  const s = sheet(st, sh);
  return order(s, axis).includes(id) && !(axis === "row" ? s.deadRows : s.deadCols).has(id);
};

/** IDs placed (inserted or moved) by a sequence, per sheet and axis. */
function placedBy(ops: readonly Op[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) if (op.kind === "insert" || op.kind === "move") for (const id of op.ids) out.add(`${op.sheet}/${op.axis}/${id}`);
  return out;
}

/** Names touched by any rename, on either side. Cells holding them are checked by example tests instead. */
function renameNames(...seqs: (readonly Op[])[]): Set<string> {
  const out = new Set<string>();
  for (const ops of seqs) for (const op of ops) if (op.kind === "renameId") (out.add(op.from), out.add(op.to));
  return out;
}
const mentions = (v: string, names: Set<string>) => v.split(",").some((x) => names.has(x.trim()));

/**
 * Check a rebase of `mine` onto `theirs` (both from `base`) against the three-way oracle.
 * Conflicts are resolved by `choose`.
 */
function checkMerge(base: State, theirs: Op[], mine: Op[], choose: (c: Conflict) => Side) {
  const chosen = new Map<string, Side>();
  const r = rebase(base, theirs, mine, (c) => {
    const side = choose(c);
    chosen.set(conflictId(c), side);
    return side;
  });
  const T = applyAll(base, theirs).state;
  const M = applyAll(base, mine).state;
  const head = T;

  // 1. The rebased ops apply to the head and produce the reported state.
  expect(equal(applyAll(head, r.ops).state, r.state)).toBe(true);

  const names = renameNames(theirs, mine);
  const conflicted = new Set(r.conflicts.map((c) => (c.kind === "cell" || c.kind === "rename" ? "" : `${c.sheet}/${c.axis}/${c.id}`)));
  const tPlaced = placedBy(theirs);
  const mPlaced = placedBy(mine);

  // 0. Exactly the conflicts of DESIGN §8.5 are reported, worked out from the states.
  expect(r.conflicts.map((c) => conflictId(c)).sort(), "conflicts").toEqual(expectedConflicts(base, T, M, theirs, mine));

  for (const sh of base.keys()) {
    // 2. Liveness of every row and column.
    const expectLive = new Map<string, boolean>();
    for (const axis of AXES) {
      const ids = new Set([...order(sheet(base, sh), axis), ...order(sheet(T, sh), axis), ...order(sheet(M, sh), axis)]);
      for (const id of ids) {
        const k = `${sh}/${axis}/${id}`;
        const b = liveIn(base, sh, axis, id);
        const t = liveIn(T, sh, axis, id);
        const m = liveIn(M, sh, axis, id);
        let want: boolean;
        if (b === t) want = m;
        else if (b === m) want = t;
        else want = m; // both changed it the same way
        const byTheirs = chosen.get(`deleted ${k} by theirs`);
        const byMine = chosen.get(`deleted ${k} by mine`);
        if (byTheirs) want = byTheirs === "mine";
        if (byMine) want = byMine === "theirs";
        expectLive.set(`${axis}/${id}`, want);
        expect(liveIn(r.state, sh, axis, id), `${k} live`).toBe(want);
      }
    }

    // 3. Every live cell's content and format.
    const bs = sheet(base, sh), ts = sheet(T, sh), ms = sheet(M, sh), rs = sheet(r.state, sh);
    for (const which of ["cells", "formats"] as const) {
      const keys = new Set([...bs[which].keys(), ...ts[which].keys(), ...ms[which].keys()]);
      for (const k of keys) {
        const [row, col] = splitKey(k);
        if (!expectLive.get(`row/${row}`) || !expectLive.get(`col/${col}`)) continue;
        const b = bs[which].get(k) ?? "", t = ts[which].get(k) ?? "", m = ms[which].get(k) ?? "";
        const got = rs[which].get(k) ?? "";
        if (which === "formats") {
          expect(got, `format ${sh}/${k}`).toBe(m !== b ? m : t); // last write wins; mine lands last
          continue;
        }
        if (names.size && [b, t, m].some((v) => mentions(v, names))) continue;
        let want: string;
        if (m === b) want = t;
        else if (t === b || t === m) want = m;
        else {
          const side = chosen.get(`cell ${sh}/${k}`);
          const restored = chosen.get(`deleted ${sh}/row/${row} by theirs`) === "mine" || chosen.get(`deleted ${sh}/col/${col} by theirs`) === "mine";
          want = side ? (side === "mine" ? m : t) : restored ? m : t;
        }
        expect(got, `cell ${sh}/${k} base=${b} theirs=${t} mine=${m}`).toBe(want);
      }
    }

    // 4. Order: the merge keeps each side's order of everything the other side didn't place.
    for (const axis of AXES) {
      const merged = order(rs, axis);
      for (const [side, other] of [[ts, mPlaced], [ms, tPlaced]] as const) {
        // Rows both sides deleted are left out: their tombstones may keep either order.
        const bothGone = (id: string) => !liveIn(T, sh, axis, id) && !liveIn(M, sh, axis, id);
        const keep = (id: string) =>
          !other.has(`${sh}/${axis}/${id}`) && !conflicted.has(`${sh}/${axis}/${id}`) && !bothGone(id) &&
          merged.includes(id) && order(side, axis).includes(id);
        expect(merged.filter(keep), `${sh} ${axis} order`).toEqual(order(side, axis).filter(keep));
      }
    }
  }
  return r;
}

/** The conflicts §8.5 calls for, from base, theirs' and mine's final states (and, for moves and renames, the ops). */
function expectedConflicts(base: State, T: State, M: State, theirs: readonly Op[], mine: readonly Op[]): string[] {
  const out: string[] = [];
  const lastMoves = (ops: readonly Op[]) => {
    const m = new Map<string, string | null>();
    for (const op of ops) if (op.kind === "move") for (const id of op.ids) m.set(`${op.sheet}/${op.axis}/${id}`, op.after);
    return m;
  };
  const tMoves = lastMoves(theirs), mMoves = lastMoves(mine);
  for (const sh of base.keys()) {
    const bs = sheet(base, sh), ts = sheet(T, sh), ms = sheet(M, sh);
    const changed = (s: typeof ts) =>
      [...new Set([...bs.cells.keys(), ...s.cells.keys()])].filter((k) => (bs.cells.get(k) ?? "") !== (s.cells.get(k) ?? ""));
    const tChanged = changed(ts), mChanged = changed(ms);
    const inBoth = (axis: Axis, id: string) => liveIn(T, sh, axis, id) && liveIn(M, sh, axis, id);
    // Both set the same cell (neither deleted its row or column) to different contents.
    for (const k of tChanged) {
      const [row, col] = splitKey(k);
      if (mChanged.includes(k) && ts.cells.get(k) !== ms.cells.get(k) && inBoth("row", row) && inBoth("col", col)) out.push(`cell ${sh}/${k}`);
    }
    for (const axis of AXES)
      for (const id of order(bs, axis)) {
        if (!liveIn(base, sh, axis, id)) continue;
        const k = `${sh}/${axis}/${id}`;
        const touches = (keys: string[]) => keys.some((c) => splitKey(c)[axis === "row" ? 0 : 1] === id);
        // One side deleted a row or column the other edited (a cell in it) or moved.
        const tEdited = touches(tChanged) || tMoves.has(k), mEdited = touches(mChanged) || mMoves.has(k);
        const tLive = liveIn(T, sh, axis, id), mLive = liveIn(M, sh, axis, id);
        if (!tLive && mLive && mEdited) out.push(`deleted ${k} by theirs`);
        if (!mLive && tLive && tEdited) out.push(`deleted ${k} by mine`);
        // Both moved it, to different places (decided in S3; §8.5 doesn't list it).
        if (tMoves.has(k) && mMoves.has(k) && tMoves.get(k) !== mMoves.get(k) && tLive && mLive) out.push(`move ${k}`);
      }
  }
  // Both renamed the same ID to different names.
  const renames = (ops: readonly Op[]) => {
    const origin = new Map<string, string>();
    for (const op of ops)
      if (op.kind === "renameId") {
        const o = origin.get(op.from) ?? op.from;
        origin.delete(op.from);
        origin.set(op.to, o);
      }
    return new Map([...origin].filter(([to, from]) => to !== from).map(([to, from]) => [from, to]));
  };
  const tr = renames(theirs), mr = renames(mine);
  for (const [from, to] of mr) if (tr.has(from) && tr.get(from) !== to) out.push(`rename ${from}`);
  return out.sort();
}

/** How often each kind of conflict comes up, so we know the generator reaches them. */
const seen = new Map<string, number>();
const tally = (r: { conflicts: Conflict[] }) => {
  for (const c of r.conflicts) seen.set(c.kind, (seen.get(c.kind) ?? 0) + 1);
  if (!r.conflicts.length) seen.set("none", (seen.get("none") ?? 0) + 1);
};

const randomChoice =(g: Gen) => (): Side => (int(g, 1) === 0 ? "mine" : "theirs");

describe("properties", () => {
  prop("every op sequence's inverse restores the state exactly", (g) => {
    const base = genState(g);
    const ops = genOps(g, base, "x", 10);
    const { state, inverse } = applyAll(base, ops);
    expect(canon(applyAll(state, inverse).state)).toEqual(canon(base));
  });

  prop("rebase agrees with a three-way merge of states, however conflicts are resolved", (g) => {
    const base = genState(g);
    const theirs = genOps(g, base, "t"), mine = genOps(g, base, "m");
    tally(explain({ base, theirs, mine }, () => checkMerge(base, theirs, mine, randomChoice(g))));
  });

  it("the generator reaches every kind of conflict", () => {
    console.log("conflicts seen:", Object.fromEntries(seen));
    for (const kind of ["cell", "deleted", "move", "rename", "none"]) expect(seen.get(kind) ?? 0, kind).toBeGreaterThan(RUNS / 200);
  });

  prop("conflict detection is symmetric: landing order doesn't change what conflicts", (g) => {
    const base = genState(g);
    const a = genOps(g, base, "a");
    const b = genOps(g, base, "b");
    const ab = rebase(base, a, b).conflicts.map((c) => conflictId(c)).sort();
    const ba = rebase(base, b, a).conflicts.map((c) => conflictId(c, true)).sort();
    expect(ba).toEqual(ab);
  });

  prop("without conflicts, both landing orders give the same sheet", (g) => {
    const base = genState(g);
    const a = genOps(g, base, "a");
    const b = genOps(g, base, "b");
    explain({ base, a, b }, () => converge(base, a, b));
  });

  prop("reverting a commit after later commits agrees with the three-way merge", (g) => {
    const base = genState(g);
    const commit = genOps(g, base, "c");
    const c = applyAll(base, commit);
    const later = genOps(g, c.state, "l");
    // The revert is a task containing the inverse ops, rebased onto the head (§8.7).
    explain({ base: c.state, commit, later, revert: c.inverse }, () => checkMerge(c.state, later, c.inverse, randomChoice(g)));
  });
});

function converge(base: State, a: Op[], b: Op[]) {
    const x = rebase(base, a, b);
    if (x.conflicts.length) return;
    const y = rebase(base, b, a);
    const names = renameNames(a, b);
    const aPlaced = placedBy(a), bPlaced = placedBy(b);
    for (const sh of base.keys()) {
      const xs = sheet(x.state, sh), ys = sheet(y.state, sh);
      expect([...xs.deadRows].sort(), "dead rows").toEqual([...ys.deadRows].sort());
      expect([...xs.deadCols].sort(), "dead cols").toEqual([...ys.deadCols].sort());
      // Cells on deleted rows and columns may differ: a write after the delete is dropped.
      const keys = [...new Set([...xs.cells.keys(), ...ys.cells.keys()])].filter((k) => {
        const [r, c] = splitKey(k);
        return liveIn(x.state, sh, "row", r) && liveIn(x.state, sh, "col", c);
      });
      for (const k of keys) {
        const v = xs.cells.get(k) ?? "", w = ys.cells.get(k) ?? "";
        if (names.size && (mentions(v, names) || mentions(w, names))) continue; // expected: renames are intent
        expect(v, `cell ${sh}/${k}`).toBe(w);
      }
      // Expected differences: rows both sides placed at the same anchor go in landing
      // order, and tombstones both sides deleted may sit in either side's order.
      for (const axis of AXES)
        for (const placed of [aPlaced, bPlaced]) {
          const keep = (id: string) => !placed.has(`${sh}/${axis}/${id}`) && liveIn(x.state, sh, axis, id);
          expect(order(xs, axis).filter(keep)).toEqual(order(ys, axis).filter(keep));
        }
    }
}
