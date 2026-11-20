import { describe, expect, it } from "vitest";
import { apply, applyAll, equal, ID_COL, live, newSheet, renameRewrites, sheet, type Op, type State } from "./model.ts";
import { conflictId, rebase } from "./rebase.ts";

/** One sheet: rows r1..r4 holding sword, bolt, axe; c1 is a ref column. Sheet T refers to bolt too. */
function base(): State {
  const s = newSheet(["r1", "r2", "r3", "r4"], ["c1", "c2"]);
  const put = (r: string, c: string, v: string) => s.cells.set(`${r}|${c}`, v);
  put("r1", "type", "Weapon");
  put("r1", ID_COL, "sword");
  put("r1", "c1", "bolt");
  put("r2", "type", "Projectile");
  put("r2", ID_COL, "bolt");
  put("r3", "type", "Weapon");
  put("r3", ID_COL, "axe");
  put("r3", "c1", "bolt, arrow");
  put("r3", "c2", '=ENTITY("bolt").speed');
  const t = newSheet(["t1"], ["c1"]);
  t.cells.set("t1|c1", "bolt");
  return new Map([["S", s], ["T", t]]);
}

const set = (row: string, col: string, content: string, sh = "S"): Op => ({ kind: "setCell", sheet: sh, row, col, content });
const cell = (st: State, row: string, col: string, sh = "S") => sheet(st, sh).cells.get(`${row}|${col}`) ?? "";
const rows = (st: State, sh = "S") => live(sheet(st, sh), "row");

/** Land theirs, then rebase mine onto it. */
function land(theirs: Op[], mine: Op[], resolve?: Parameters<typeof rebase>[3]) {
  const b = base();
  const r = rebase(b, theirs, mine, resolve);
  // The rebased ops really do apply to the head and give the reported state.
  expect(equal(applyAll(applyAll(b, theirs).state, r.ops).state, r.state)).toBe(true);
  return { ...r, ids: r.conflicts.map((c) => conflictId(c)) };
}

describe("apply and invert", () => {
  it("every op's inverse restores the state exactly", () => {
    const ops: Op[] = [
      set("r4", "c1", "x"),
      { kind: "setFormat", sheet: "S", row: "r1", col: "c1", format: "bold" },
      { kind: "insert", sheet: "S", axis: "row", after: "r1", ids: ["n1", "n2"] },
      { kind: "delete", sheet: "S", axis: "row", ids: ["r2", "r4"] },
      { kind: "move", sheet: "S", axis: "row", after: null, ids: ["r3", "r1"] },
      { kind: "insert", sheet: "S", axis: "col", after: "c1", ids: ["k1"] },
      { kind: "move", sheet: "S", axis: "col", after: "c2", ids: ["c1"] },
      { kind: "renameId", from: "bolt", to: "bolt2" },
    ];
    for (const op of ops) {
      const b = base();
      const { state, inverse } = apply(b, op);
      expect(equal(state, b), op.kind).toBe(false);
      expect(equal(applyAll(state, inverse).state, b), op.kind).toBe(true);
    }
  });

  it("a deleted row keeps its cells, and restoring brings them back", () => {
    const { state } = apply(base(), { kind: "delete", sheet: "S", axis: "row", ids: ["r1"] });
    expect(rows(state)).toEqual(["r2", "r3", "r4"]);
    const back = apply(state, { kind: "restore", sheet: "S", axis: "row", ids: ["r1"] }).state;
    expect(cell(back, "r1", "c1")).toBe("bolt");
  });

  it("system columns can't be moved or deleted", () => {
    expect(() => apply(base(), { kind: "delete", sheet: "S", axis: "col", ids: [ID_COL] })).toThrow();
    expect(() => apply(base(), { kind: "move", sheet: "S", axis: "col", after: "c2", ids: ["type"] })).toThrow();
  });
});

describe("renameId", () => {
  it("rewrites the ID cell and literal references on every sheet, and reports formulas", () => {
    const b = base();
    const { writes, formulas } = renameRewrites(b, "bolt", "quarrel");
    expect(writes.map((w) => `${w.sheet}/${w.row}|${w.col}=${w.content}`).sort()).toEqual([
      "S/r1|c1=quarrel",
      "S/r2|id=quarrel",
      "S/r3|c1=quarrel, arrow",
      "T/t1|c1=quarrel",
    ]);
    expect(formulas).toEqual([{ sheet: "S", row: "r3", col: "c2" }]);
  });

  it("matches exactly: case and partial matches are left alone (Q3)", () => {
    const st = applyAll(base(), [set("r4", "c1", "Bolt"), set("r4", "c2", "bolts")]).state;
    const after = apply(st, { kind: "renameId", from: "bolt", to: "quarrel" }).state;
    expect([cell(after, "r4", "c1"), cell(after, "r4", "c2")]).toEqual(["Bolt", "bolts"]);
  });

  it("on rebase, also rewrites references that theirs added concurrently (§8.2)", () => {
    const theirs = [set("r4", "c1", "bolt"), { kind: "insert", sheet: "S", axis: "row", after: "r4", ids: ["n1"] } as Op, set("n1", "c1", "bolt")];
    const r = land(theirs, [{ kind: "renameId", from: "bolt", to: "quarrel" }]);
    expect(r.ids).toEqual([]);
    expect([cell(r.state, "r4", "c1"), cell(r.state, "n1", "c1"), cell(r.state, "r2", ID_COL)]).toEqual(["quarrel", "quarrel", "quarrel"]);
  });

  it("two renames of the same ID to different names conflict", () => {
    const r = land([{ kind: "renameId", from: "bolt", to: "dart" }], [{ kind: "renameId", from: "bolt", to: "quarrel" }]);
    expect(r.ids).toContain("rename bolt");
    expect(cell(r.state, "r2", ID_COL)).toBe("dart");
    const mine = land([{ kind: "renameId", from: "bolt", to: "dart" }], [{ kind: "renameId", from: "bolt", to: "quarrel" }], () => "mine");
    expect([cell(mine.state, "r2", ID_COL), cell(mine.state, "t1", "c1", "T")]).toEqual(["quarrel", "quarrel"]);
  });

  it("the same rename on both sides is not a conflict", () => {
    const op: Op = { kind: "renameId", from: "bolt", to: "dart" };
    expect(land([op], [op]).ids).toEqual([]);
  });
});

describe("DESIGN §8.5 conflicts", () => {
  it("both sides set the same cell to different contents: conflict", () => {
    const r = land([set("r1", "c2", "10")], [set("r1", "c2", "20")]);
    expect(r.ids).toEqual(["cell S/r1|c2"]);
    expect(cell(r.state, "r1", "c2")).toBe("10");
    expect(cell(land([set("r1", "c2", "10")], [set("r1", "c2", "20")], () => "mine").state, "r1", "c2")).toBe("20");
  });

  it("the same contents on both sides, or a write and write-back, is not a conflict", () => {
    expect(land([set("r1", "c2", "10")], [set("r1", "c2", "10")]).ids).toEqual([]);
    const r = land([set("r1", "c2", "10")], [set("r1", "c2", "20"), set("r1", "c2", "")]);
    expect(r.ids).toEqual([]);
    expect(cell(r.state, "r1", "c2")).toBe("10"); // mine's net effect on the cell is nothing
  });

  it("one side edits a row the other deleted: conflict, either way round", () => {
    const del: Op = { kind: "delete", sheet: "S", axis: "row", ids: ["r1"] };
    const edit = set("r1", "c2", "10");
    expect(land([del], [edit]).ids).toEqual(["deleted S/row/r1 by theirs"]);
    expect(land([edit], [del]).ids).toEqual(["deleted S/row/r1 by mine"]);
    // Keep mine: the row comes back with the edit.
    const kept = land([del], [edit], () => "mine");
    expect(rows(kept.state)).toContain("r1");
    expect(cell(kept.state, "r1", "c2")).toBe("10");
    // Keep theirs: the edit is dropped with the row.
    expect(rows(land([del], [edit]).state)).not.toContain("r1");
  });

  it("moving a row the other deleted counts as editing it", () => {
    const r = land([{ kind: "delete", sheet: "S", axis: "row", ids: ["r1"] }], [{ kind: "move", sheet: "S", axis: "row", after: "r4", ids: ["r1"] }]);
    expect(r.ids).toEqual(["deleted S/row/r1 by theirs"]);
  });

  it("editing a cell in a column the other deleted: conflict", () => {
    const r = land([{ kind: "delete", sheet: "S", axis: "col", ids: ["c2"] }], [set("r1", "c2", "10")]);
    expect(r.ids).toEqual(["deleted S/col/c2 by theirs"]);
  });

  it("both delete the same row: not a conflict", () => {
    const del: Op = { kind: "delete", sheet: "S", axis: "row", ids: ["r1"] };
    const r = land([del], [del]);
    expect(r.ids).toEqual([]);
    expect(r.ops).toEqual([]);
  });

  it("both insert after the same anchor: no conflict, the earlier-landed side goes first", () => {
    const ins = (ids: string[]): Op => ({ kind: "insert", sheet: "S", axis: "row", after: "r1", ids });
    const r = land([ins(["t1", "t2"])], [ins(["m1"]), { kind: "insert", sheet: "S", axis: "row", after: "m1", ids: ["m2"] }]);
    expect(r.ids).toEqual([]);
    expect(rows(r.state)).toEqual(["r1", "t1", "t2", "m1", "m2", "r2", "r3", "r4"]);
  });

  it("inserting after a row the other deleted: no conflict, the tombstone still anchors it", () => {
    const r = land([{ kind: "delete", sheet: "S", axis: "row", ids: ["r2"] }], [{ kind: "insert", sheet: "S", axis: "row", after: "r2", ids: ["m1"] }]);
    expect(r.ids).toEqual([]);
    expect(rows(r.state)).toEqual(["r1", "m1", "r3", "r4"]);
  });

  it("valid alone but invalid together (duplicate ID): not a conflict, left to validation", () => {
    const ins = (id: string): Op[] => [{ kind: "insert", sheet: "S", axis: "row", after: "r4", ids: [id] }, set(id, ID_COL, "spear")];
    const r = land(ins("t1"), ins("m1"));
    expect(r.ids).toEqual([]);
    expect([cell(r.state, "t1", ID_COL), cell(r.state, "m1", ID_COL)]).toEqual(["spear", "spear"]);
  });

  it("formatting the same cell: last write wins, no conflict", () => {
    const fmt = (f: string): Op => ({ kind: "setFormat", sheet: "S", row: "r1", col: "c1", format: f });
    const r = land([fmt("bold")], [fmt("italic")]);
    expect(r.ids).toEqual([]);
    expect(sheet(r.state, "S").formats.get("r1|c1")).toBe("italic");
  });

  it("both move the same row to different places: conflict (not in §8.5; decided here)", () => {
    const mv = (after: string): Op => ({ kind: "move", sheet: "S", axis: "row", after, ids: ["r1"] });
    expect(land([mv("r3")], [mv("r4")]).ids).toEqual(["move S/row/r1"]);
    expect(land([mv("r3")], [mv("r3")]).ids).toEqual([]);
  });
});

describe("revert", () => {
  it("a commit's inverse rebases over later commits and removes only its own change", () => {
    const b = base();
    const c1: Op[] = [{ kind: "insert", sheet: "S", axis: "row", after: "r1", ids: ["n1"] }, set("n1", ID_COL, "spear"), set("r2", "c2", "5")];
    const s1 = applyAll(b, c1);
    const c2: Op[] = [set("r3", "c2", "7"), { kind: "insert", sheet: "S", axis: "row", after: "n1", ids: ["n2"] }];
    const r = rebase(s1.state, c2, s1.inverse);
    expect(r.conflicts).toEqual([]);
    expect(rows(r.state)).toEqual(["r1", "n2", "r2", "r3", "r4"]); // n2 survives, anchored where n1 was
    expect([cell(r.state, "r2", "c2"), cell(r.state, "r3", "c2")]).toEqual(["", "7"]);
  });
});
