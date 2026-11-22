// Property tests for rebase on the real document (ported from spike S3).
//
// The oracle is a three-way merge of whole documents: for every cell, row and column,
// compare base, mine's final document and theirs', and work out what the merged result
// must be. That is computed from documents, not from the ops, so it is independent of
// how rebase transforms ops one at a time.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contentKey, stableJson, type Content } from "../formula/content.ts";
import { parseSchema } from "../schema/yaml.ts";
import { axisOf, canonDoc, cellKey, cloneDoc, emptyDoc, isLive, liveIds, splitCellKey, type Axis, type Doc, type Format } from "./doc.ts";
import { applyOps, type Op } from "./ops.ts";
import { applyOp } from "./ops.ts";
import { conflictId, rebase, type Conflict, type Side } from "./rebase.ts";
import { reconcile } from "./reconcile.ts";

const RUNS = Number(process.env.RUNS ?? 1000);
type Gen = fc.GeneratorValue;
const int = (g: Gen, max: number): number => g(fc.integer, { min: 0, max });
const pick = <T,>(g: Gen, xs: readonly T[]): T => xs[int(g, xs.length - 1)]!;
const prop = (name: string, body: (g: Gen) => void) => it(name, () => fc.assert(fc.property(fc.gen(), body), { numRuns: RUNS }), 600_000);

// ------------------------------------------------------------ generators

const SCHEMA = parseSchema(`
types:
  Weapon: { fields: { main: "ref<Weapon>", shots: "list<ref<Weapon>>", note: string } }
  Projectile: { fields: { speed: float } }
`).schema;

const IDS = ["a", "b", "c", "d"];
const lit = (v: string | number): Content => ({ v });
const CONTENT: Content[] = [null, lit(1), lit(2), ...IDS.map(lit), lit('["a", "b"]'), lit('[ "c","d" ]'), { f: { k: "str", v: "a" } }, { f: { k: "num", v: 3 } }];
const FORMATS: (Format | null)[] = [null, { bold: true }, { fill: "red" }];
const sys = (sh: string) => [`${sh}_type`, `${sh}_id`];

function genDoc(g: Gen): Doc {
  const doc = emptyDoc(SCHEMA);
  for (const sh of ["S", "T"]) {
    const rows = Array.from({ length: 2 + int(g, 3) }, (_, i) => `${sh}r${i}`);
    const cols = [...sys(sh), `${sh}c1`, `${sh}c2`, `${sh}c3`];
    const cells = new Map<string, Content>();
    for (const r of rows)
      for (const [i, c] of cols.entries()) {
        const v = i === 0 ? pick(g, [null, lit("Weapon")]) : i === 1 ? pick(g, [null, ...IDS.map(lit)]) : pick(g, CONTENT);
        if (v) cells.set(cellKey(r, c), v);
      }
    doc.sheets.set(sh, { id: sh, name: sh, pack: "root", kind: "data", rows: { order: rows, dead: new Set() }, cols: { order: cols, dead: new Set() }, cells, formats: new Map(), layouts: new Map() });
  }
  return doc;
}

/** A sequence of ops, each valid on the document it is applied to. Fresh IDs start with `prefix`. */
function genOps(g: Gen, base: Doc, prefix: string, maxLen = 6): Op[] {
  const doc = cloneDoc(base);
  const ops: Op[] = [];
  let fresh = 0;
  for (let i = int(g, maxLen); i > 0; i--) {
    const op = genOp(g, doc, () => `${prefix}_${++fresh}`);
    if (!op) continue;
    applyOp(doc, op);
    ops.push(op);
  }
  return ops;
}

function genOp(g: Gen, doc: Doc, freshId: () => string): Op | null {
  const sh = pick(g, ["S", "S", "T"]);
  const s = doc.sheets.get(sh)!;
  const axis: Axis = int(g, 3) === 0 ? "col" : "row";
  const movable = liveIds(axisOf(s, axis)).filter((id) => !sys(sh).includes(id));
  const kind = pick(g, ["setCell", "setCell", "setCell", "setCell", "setFormat", "insert", "insert", "delete", "move", "move", "renameId"] as const);
  switch (kind) {
    case "setCell":
    case "setFormat": {
      const rows = liveIds(s.rows);
      if (!rows.length) return null;
      const row = pick(g, rows);
      const col = pick(g, liveIds(s.cols));
      if (kind === "setFormat") return { kind, sheet: sh, row, col, format: pick(g, FORMATS) };
      const [tCol, idCol] = sys(sh);
      const content = col === tCol ? pick(g, [null, lit("Weapon"), lit("Projectile")]) : col === idCol ? pick(g, [null, ...[...IDS, "e"].map(lit)]) : pick(g, CONTENT);
      return { kind, sheet: sh, row, col, content };
    }
    case "insert":
      return { kind, sheet: sh, axis, after: anchorFor(g, sh, axis, axisOf(s, axis).order, []), ids: Array.from({ length: 1 + int(g, 1) }, freshId) };
    case "delete":
      return movable.length ? { kind, sheet: sh, axis, ids: some(g, movable) } : null;
    case "move": {
      if (!movable.length) return null;
      const ids = some(g, movable);
      return { kind, sheet: sh, axis, after: anchorFor(g, sh, axis, axisOf(s, axis).order, ids), ids };
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

/** Any position, tombstones included; columns never before B. */
function anchorFor(g: Gen, sh: string, axis: Axis, ord: readonly string[], moving: string[]): string | null {
  const candidates = ord.filter((id) => !moving.includes(id) && (axis === "row" || id !== sys(sh)[0]));
  if (axis === "col") return pick(g, candidates);
  return int(g, candidates.length) === 0 ? null : pick(g, candidates);
}

// ------------------------------------------------------------ the oracle

const AXES: Axis[] = ["row", "col"];
const liveIn = (d: Doc, sh: string, axis: Axis, id: string) => isLive(axisOf(d.sheets.get(sh)!, axis), id);
const orderOf = (d: Doc, sh: string, axis: Axis) => axisOf(d.sheets.get(sh)!, axis).order;
const final = (base: Doc, ops: readonly Op[]) => {
  const d = cloneDoc(base);
  applyOps(d, ops);
  return d;
};

function placedBy(ops: readonly Op[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) if (op.kind === "insert" || op.kind === "move") for (const id of op.ids) out.add(`${op.sheet}/${op.axis}/${id}`);
  return out;
}

function renameNames(...seqs: (readonly Op[])[]): string[] {
  const out = new Set<string>();
  for (const ops of seqs) for (const op of ops) if (op.kind === "renameId") (out.add(op.from), out.add(op.to));
  return [...out];
}
const mentions = (c: Content | undefined, names: string[]) =>
  !!c && "v" in c && typeof c.v === "string" && names.some((n) => c.v === n || (c.v as string).includes(JSON.stringify(n)));

const ck = (c: Content | undefined) => contentKey(c ?? null);
const fk = (f: Format | undefined | null) => (f ? stableJson(f) : "");

function explain<T>(ctx: Record<string, unknown>, body: () => T): T {
  try {
    return body();
  } catch (e) {
    const show = (v: unknown) => JSON.stringify(v && typeof v === "object" && "sheets" in v ? canonDoc(v as Doc) : v);
    throw new Error(`${(e as Error).message}\n${Object.entries(ctx).map(([k, v]) => `  ${k}: ${show(v)}`).join("\n")}`);
  }
}

function checkMerge(base: Doc, theirs: Op[], mine: Op[], choose: (c: Conflict) => Side) {
  const chosen = new Map<string, Side>();
  const r = rebase(base, theirs, mine, (c) => {
    const side = choose(c);
    chosen.set(conflictId(c), side);
    return side;
  });
  const T = final(base, theirs);
  const M = final(base, mine);

  // 1. The rebased ops apply to the head and produce the reported document.
  expect(canonDoc(final(T, r.ops))).toEqual(canonDoc(r.state));

  // 0. Exactly the conflicts of DESIGN §8.5 are reported, worked out from the documents.
  expect(r.conflicts.map((c) => conflictId(c)).sort(), "conflicts").toEqual(expectedConflicts(base, T, M, theirs, mine));

  const names = renameNames(theirs, mine);
  const conflicted = new Set(r.conflicts.map((c) => ("axis" in c ? `${c.sheet}/${c.axis}/${c.id}` : "")));
  const tPlaced = placedBy(theirs);
  const mPlaced = placedBy(mine);

  for (const sh of base.sheets.keys()) {
    // 2. Liveness of every row and column.
    const expectLive = new Map<string, boolean>();
    for (const axis of AXES) {
      const ids = new Set([...orderOf(base, sh, axis), ...orderOf(T, sh, axis), ...orderOf(M, sh, axis)]);
      for (const id of ids) {
        const k = `${sh}/${axis}/${id}`;
        const b = liveIn(base, sh, axis, id), t = liveIn(T, sh, axis, id), m = liveIn(M, sh, axis, id);
        let want = b === t ? m : b === m ? t : m;
        const byTheirs = chosen.get(`deleted ${k} by theirs`);
        const byMine = chosen.get(`deleted ${k} by mine`);
        if (byTheirs) want = byTheirs === "mine";
        if (byMine) want = byMine === "theirs";
        expectLive.set(`${axis}/${id}`, want);
        expect(liveIn(r.state, sh, axis, id), `${k} live`).toBe(want);
      }
    }

    // 3. Every live cell's content and format.
    const bs = base.sheets.get(sh)!, ts = T.sheets.get(sh)!, ms = M.sheets.get(sh)!, rs = r.state.sheets.get(sh)!;
    const liveCell = (k: string) => {
      const [row, col] = splitCellKey(k);
      return expectLive.get(`row/${row}`) && expectLive.get(`col/${col}`);
    };
    for (const k of new Set([...bs.formats.keys(), ...ts.formats.keys(), ...ms.formats.keys()])) {
      if (!liveCell(k)) continue;
      const b = fk(bs.formats.get(k)), t = fk(ts.formats.get(k)), m = fk(ms.formats.get(k));
      expect(fk(rs.formats.get(k)), `format ${sh}/${k}`).toBe(m !== b ? m : t); // last write wins; mine lands last
    }
    for (const k of new Set([...bs.cells.keys(), ...ts.cells.keys(), ...ms.cells.keys()])) {
      if (!liveCell(k)) continue;
      const [row, col] = splitCellKey(k);
      if (names.length && [bs, ts, ms].some((s) => mentions(s.cells.get(k), names))) continue; // renames are intent: see the example tests
      const b = ck(bs.cells.get(k)), t = ck(ts.cells.get(k)), m = ck(ms.cells.get(k));
      let want: string;
      if (m === b) want = t;
      else if (t === b || t === m) want = m;
      else {
        const side = chosen.get(`cell ${sh}/${k}`);
        const restored = chosen.get(`deleted ${sh}/row/${row} by theirs`) === "mine" || chosen.get(`deleted ${sh}/col/${col} by theirs`) === "mine";
        want = side ? (side === "mine" ? m : t) : restored ? m : t;
      }
      expect(ck(rs.cells.get(k)), `cell ${sh}/${k} base=${b} theirs=${t} mine=${m}`).toBe(want);
    }

    // 4. Order: the merge keeps each side's order of everything the other side didn't place.
    for (const axis of AXES) {
      const merged = orderOf(r.state, sh, axis);
      for (const [side, other] of [[T, mPlaced], [M, tPlaced]] as const) {
        const bothGone = (id: string) => !liveIn(T, sh, axis, id) && !liveIn(M, sh, axis, id);
        const keep = (id: string) =>
          !other.has(`${sh}/${axis}/${id}`) && !conflicted.has(`${sh}/${axis}/${id}`) && !bothGone(id) &&
          merged.includes(id) && orderOf(side, sh, axis).includes(id);
        expect(merged.filter(keep), `${sh} ${axis} order`).toEqual(orderOf(side, sh, axis).filter(keep));
      }
      // 5. Columns A and B stay first.
      if (axis === "col") expect(merged.slice(0, 2)).toEqual(sys(sh));
    }
  }
  return r;
}

function expectedConflicts(base: Doc, T: Doc, M: Doc, theirs: readonly Op[], mine: readonly Op[]): string[] {
  const out: string[] = [];
  const lastMoves = (ops: readonly Op[]) => {
    const m = new Map<string, string | null>();
    for (const op of ops) if (op.kind === "move") for (const id of op.ids) m.set(`${op.sheet}/${op.axis}/${id}`, op.after);
    return m;
  };
  const tMoves = lastMoves(theirs), mMoves = lastMoves(mine);
  for (const sh of base.sheets.keys()) {
    const bs = base.sheets.get(sh)!, ts = T.sheets.get(sh)!, ms = M.sheets.get(sh)!;
    const changed = (s: typeof ts) => [...new Set([...bs.cells.keys(), ...s.cells.keys()])].filter((k) => ck(bs.cells.get(k)) !== ck(s.cells.get(k)));
    const tChanged = changed(ts), mChanged = changed(ms);
    const inBoth = (axis: Axis, id: string) => liveIn(T, sh, axis, id) && liveIn(M, sh, axis, id);
    for (const k of tChanged) {
      const [row, col] = splitCellKey(k);
      if (mChanged.includes(k) && ck(ts.cells.get(k)) !== ck(ms.cells.get(k)) && inBoth("row", row) && inBoth("col", col)) out.push(`cell ${sh}/${k}`);
    }
    for (const axis of AXES)
      for (const id of orderOf(base, sh, axis)) {
        if (!liveIn(base, sh, axis, id)) continue;
        const k = `${sh}/${axis}/${id}`;
        const touches = (keys: string[]) => keys.some((c) => splitCellKey(c)[axis === "row" ? 0 : 1] === id);
        const tEdited = touches(tChanged) || tMoves.has(k), mEdited = touches(mChanged) || mMoves.has(k);
        const tLive = liveIn(T, sh, axis, id), mLive = liveIn(M, sh, axis, id);
        if (!tLive && mLive && mEdited) out.push(`deleted ${k} by theirs`);
        if (!mLive && tLive && tEdited) out.push(`deleted ${k} by mine`);
        if (tMoves.has(k) && mMoves.has(k) && tMoves.get(k) !== mMoves.get(k) && tLive && mLive) out.push(`move ${k}`);
      }
  }
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

const randomChoice = (g: Gen) => (): Side => (int(g, 1) === 0 ? "mine" : "theirs");

describe("rebase (properties)", () => {
  prop("every op sequence's inverse restores the document exactly", (g) => {
    const base = genDoc(g);
    const d = cloneDoc(base);
    const inverse = applyOps(d, genOps(g, base, "x", 10));
    applyOps(d, inverse);
    expect(canonDoc(d)).toEqual(canonDoc(base));
  });

  prop("rebase agrees with a three-way merge of documents, however conflicts are resolved", (g) => {
    const base = genDoc(g);
    const theirs = genOps(g, base, "t"), mine = genOps(g, base, "m");
    explain({ base, theirs, mine }, () => checkMerge(base, theirs, mine, randomChoice(g)));
  });

  // A fixed seed: this checks the generator's reach, so it should measure the same cases every
  // time rather than sit in the tail of a random count. The properties above stay random.
  it("the generator reaches every kind of conflict", () => {
    const seen = new Map<string, number>();
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const base = genDoc(g);
        const { conflicts } = rebase(base, genOps(g, base, "t"), genOps(g, base, "m"));
        for (const c of conflicts) seen.set(c.kind, (seen.get(c.kind) ?? 0) + 1);
        if (!conflicts.length) seen.set("none", (seen.get("none") ?? 0) + 1);
      }),
      { numRuns: 1000, seed: 1 },
    );
    for (const kind of ["cell", "deleted", "move", "rename", "none"]) expect(seen.get(kind) ?? 0, kind).toBeGreaterThan(5);
  });

  prop("conflict detection is symmetric: landing order doesn't change what conflicts", (g) => {
    const base = genDoc(g);
    const a = genOps(g, base, "a"), b = genOps(g, base, "b");
    expect(rebase(base, b, a).conflicts.map((c) => conflictId(c, true)).sort()).toEqual(rebase(base, a, b).conflicts.map((c) => conflictId(c)).sort());
  });

  prop("without conflicts, both landing orders give the same document", (g) => {
    const base = genDoc(g);
    const a = genOps(g, base, "a"), b = genOps(g, base, "b");
    explain({ base, a, b }, () => converge(base, a, b));
  });

  prop("rebasing the earlier side over the later, with mineFirst, gives the same document", (g) => {
    const base = genDoc(g);
    const a = genOps(g, base, "a"), b = genOps(g, base, "b");
    const chosen = new Map<string, Side>();
    const choose = (id: string): Side => {
      if (!chosen.has(id)) chosen.set(id, int(g, 1) === 0 ? "mine" : "theirs");
      return chosen.get(id)!;
    };
    const flip = (s: Side): Side => (s === "mine" ? "theirs" : "mine");
    // a landed first and b rebased onto it; and from b's head, a rebased onto it, still first.
    const x = rebase(base, a, b, (c) => choose(conflictId(c)));
    const y = rebase(base, b, a, (c) => flip(choose(conflictId(c, true))), { mineFirst: true });
    const ctx = () => JSON.stringify({ base: canonDoc(base), a, b, chosen: [...chosen], xOps: x.ops, yOps: y.ops });
    // Ties (rows placed at one spot, last-write-wins, what a deleted row keeps) agree exactly.
    // Moves and renames can still differ a little: reconcile says what's left, exactly.
    const plain = ![...a, ...b].some((op) => op.kind === "move" || op.kind === "renameId");
    if (plain) expect(docDiff(x.state, y.state), ctx()).toEqual([]);
    const rc = reconcile(y.state, x.state);
    expect(rc, ctx()).not.toBeNull();
    const after = cloneDoc(y.state);
    applyOps(after, rc!);
    expect(docDiff(after, x.state), ctx()).toEqual([]);
  });

  prop("reconcile takes any document to another made from the same base, exactly", (g) => {
    const base = genDoc(g);
    const x = final(base, genOps(g, base, "x", 10)), y = final(base, genOps(g, base, "y", 10));
    const rc = reconcile(x, y);
    expect(rc).not.toBeNull();
    applyOps(x, rc!);
    expect(docDiff(x, y)).toEqual([]);
  });

  prop("reverting a commit after later commits agrees with the three-way merge", (g) => {
    const base = genDoc(g);
    const commit = genOps(g, base, "c");
    const c = cloneDoc(base);
    const inverse = applyOps(c, commit);
    const later = genOps(g, c, "l");
    explain({ base: c, commit, later, revert: inverse }, () => checkMerge(c, later, inverse, randomChoice(g)));
  });
});

/** Where two documents differ, briefly: the order of each axis, then each cell and format. */
function docDiff(x: Doc, y: Doc): string[] {
  const out: string[] = [];
  const cx = canonDoc(x) as { sheets: { id: string; [k: string]: unknown }[] }, cy = canonDoc(y) as typeof cx;
  if (JSON.stringify({ ...cx, sheets: 0 }) !== JSON.stringify({ ...cy, sheets: 0 })) out.push("schema or packs");
  for (const sx of cx.sheets) {
    const sy = cy.sheets.find((s) => s.id === sx.id);
    if (!sy) { out.push(`sheet ${sx.id} only in x`); continue; }
    for (const k of ["name", "pack", "rows", "cols"]) if (JSON.stringify(sx[k]) !== JSON.stringify(sy[k])) out.push(`${sx.id}.${k}: ${JSON.stringify(sx[k])} vs ${JSON.stringify(sy[k])}`);
    for (const k of ["cells", "formats", "layouts"]) {
      const mx = new Map(sx[k] as [string, unknown][]), my = new Map(sy[k] as [string, unknown][]);
      for (const key of new Set([...mx.keys(), ...my.keys()]))
        if (JSON.stringify(mx.get(key)) !== JSON.stringify(my.get(key))) out.push(`${sx.id}.${k} ${key}: ${JSON.stringify(mx.get(key))} vs ${JSON.stringify(my.get(key))}`);
    }
  }
  return out;
}

function converge(base: Doc, a: Op[], b: Op[]) {
  const x = rebase(base, a, b);
  if (x.conflicts.length) return;
  const y = rebase(base, b, a);
  const names = renameNames(a, b);
  const aPlaced = placedBy(a), bPlaced = placedBy(b);
  for (const sh of base.sheets.keys()) {
    const xs = x.state.sheets.get(sh)!, ys = y.state.sheets.get(sh)!;
    for (const axis of AXES) expect([...axisOf(xs, axis).dead].sort(), `dead ${axis}`).toEqual([...axisOf(ys, axis).dead].sort());
    const keys = [...new Set([...xs.cells.keys(), ...ys.cells.keys()])].filter((k) => {
      const [r, c] = splitCellKey(k);
      return liveIn(x.state, sh, "row", r) && liveIn(x.state, sh, "col", c);
    });
    for (const k of keys) {
      if (names.length && (mentions(xs.cells.get(k), names) || mentions(ys.cells.get(k), names))) continue;
      expect(ck(xs.cells.get(k)), `cell ${sh}/${k}`).toBe(ck(ys.cells.get(k)));
    }
    for (const axis of AXES)
      for (const placed of [aPlaced, bPlaced]) {
        const keep = (id: string) => !placed.has(`${sh}/${axis}/${id}`) && liveIn(x.state, sh, axis, id);
        expect(orderOf(x.state, sh, axis).filter(keep)).toEqual(orderOf(y.state, sh, axis).filter(keep));
      }
  }
}
