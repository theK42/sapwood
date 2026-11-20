import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Content } from "../formula/content.ts";
import { exportJson } from "../export/json.ts";
import { loadProject } from "../project/load.ts";
import { Project } from "../project/project.ts";
import { validate } from "../project/validate.ts";
import { parseSchema } from "../schema/yaml.ts";
import { canonDoc, cellKey, cloneDoc, emptyDoc, liveIds, type Doc } from "./doc.ts";
import { applyOps, type Op } from "./ops.ts";
import { conflictId, rebase } from "./rebase.ts";

const SCHEMA = parseSchema(`
types:
  Weapon: { fields: { main: "ref<Projectile>", shots: "list<ref<Projectile>>", note: string } }
  Projectile: { fields: { speed: float } }
`).schema;

const A = "S_type", B = "S_id";
const lit = (v: string): Content => ({ v });

/** Sheet S: rows r1..r4 holding sword, bolt, axe; c1 is a ref column, c2 a list of refs. Sheet T refers to bolt too. */
function base(): Doc {
  const doc = emptyDoc(SCHEMA);
  const sheet = (id: string, rows: string[], cols: string[], cells: [string, string, Content][]) =>
    doc.sheets.set(id, {
      id, name: id, pack: "root", kind: "data",
      rows: { order: rows, dead: new Set() }, cols: { order: cols, dead: new Set() },
      cells: new Map(cells.map(([r, c, v]) => [cellKey(r, c), v])), formats: new Map(), layouts: new Map(),
    });
  sheet("S", ["r1", "r2", "r3", "r4"], [A, B, "c1", "c2", "c3"], [
    ["r1", A, lit("Weapon")], ["r1", B, lit("sword")], ["r1", "c1", lit("bolt")],
    ["r2", A, lit("Projectile")], ["r2", B, lit("bolt")],
    ["r3", A, lit("Weapon")], ["r3", B, lit("axe")], ["r3", "c2", lit('["bolt", "arrow"]')], ["r3", "c3", { f: { k: "str", v: "bolt" } }],
  ]);
  sheet("T", ["t1"], ["T_type", "T_id", "tc1"], [["t1", "T_type", lit("Weapon")], ["t1", "T_id", lit("spear")], ["t1", "tc1", lit("bolt")]]);
  return doc;
}

const set = (row: string, col: string, content: string | null, sh = "S"): Op => ({ kind: "setCell", sheet: sh, row, col, content: content === null ? null : lit(content) });
const cell = (d: Doc, row: string, col: string, sh = "S") => {
  const c = d.sheets.get(sh)!.cells.get(cellKey(row, col));
  return c && "v" in c ? String(c.v) : "";
};
const rows = (d: Doc, sh = "S") => liveIds(d.sheets.get(sh)!.rows);
const final = (b: Doc, ops: readonly Op[]) => {
  const d = cloneDoc(b);
  applyOps(d, ops);
  return d;
};

/** Land theirs, then rebase mine onto it. */
function land(theirs: Op[], mine: Op[], resolve?: Parameters<typeof rebase>[3]) {
  const b = base();
  const r = rebase(b, theirs, mine, resolve);
  // The rebased ops really do apply to the head and give the reported document.
  expect(canonDoc(final(final(b, theirs), r.ops))).toEqual(canonDoc(r.state));
  return { ...r, ids: r.conflicts.map((c) => conflictId(c)) };
}

describe("renameId on rebase", () => {
  it("also rewrites references theirs added concurrently (§8.2)", () => {
    const theirs = [set("r4", A, "Weapon"), set("r4", "c1", "bolt"), { kind: "insert", sheet: "S", axis: "row", after: "r4", ids: ["n1"] } as Op, set("n1", A, "Weapon"), set("n1", "c2", '["bolt"]')];
    const r = land(theirs, [{ kind: "renameId", from: "bolt", to: "quarrel" }]);
    expect(r.ids).toEqual([]);
    expect([cell(r.state, "r4", "c1"), cell(r.state, "n1", "c2"), cell(r.state, "r2", B), cell(r.state, "r3", "c2"), cell(r.state, "t1", "tc1", "T")])
      .toEqual(["quarrel", '["quarrel"]', "quarrel", '["quarrel", "arrow"]', "quarrel"]);
  });

  it("two renames of the same ID to different names conflict", () => {
    const r = land([{ kind: "renameId", from: "bolt", to: "dart" }], [{ kind: "renameId", from: "bolt", to: "quarrel" }]);
    expect(r.ids).toContain("rename bolt");
    expect(cell(r.state, "r2", B)).toBe("dart");
    const mine = land([{ kind: "renameId", from: "bolt", to: "dart" }], [{ kind: "renameId", from: "bolt", to: "quarrel" }], () => "mine");
    expect([cell(mine.state, "r2", B), cell(mine.state, "t1", "tc1", "T")]).toEqual(["quarrel", "quarrel"]);
  });

  it("the same rename on both sides is not a conflict", () => {
    const op: Op = { kind: "renameId", from: "bolt", to: "dart" };
    expect(land([op], [op]).ids).toEqual([]);
  });
});

describe("DESIGN §8.5 conflicts", () => {
  it("both sides set the same cell to different contents: conflict", () => {
    const r = land([set("r1", "c3", "10")], [set("r1", "c3", "20")]);
    expect(r.ids).toEqual(["cell S/r1|c3"]);
    expect(r.conflicts[0]).toMatchObject({ base: null, theirs: { v: "10" }, mine: { v: "20" } });
    expect(cell(r.state, "r1", "c3")).toBe("10");
    expect(cell(land([set("r1", "c3", "10")], [set("r1", "c3", "20")], () => "mine").state, "r1", "c3")).toBe("20");
  });

  it("the same contents on both sides, or a write and write-back, is not a conflict", () => {
    expect(land([set("r1", "c3", "10")], [set("r1", "c3", "10")]).ids).toEqual([]);
    const r = land([set("r1", "c3", "10")], [set("r1", "c3", "20"), set("r1", "c3", null)]);
    expect(r.ids).toEqual([]);
    expect(cell(r.state, "r1", "c3")).toBe("10");
  });

  it("one side edits a row the other deleted: conflict, either way round", () => {
    const del: Op = { kind: "delete", sheet: "S", axis: "row", ids: ["r1"] };
    const edit = set("r1", "c3", "10");
    expect(land([del], [edit]).ids).toEqual(["deleted S/row/r1 by theirs"]);
    expect(land([edit], [del]).ids).toEqual(["deleted S/row/r1 by mine"]);
    const kept = land([del], [edit], () => "mine");
    expect(rows(kept.state)).toContain("r1");
    expect(cell(kept.state, "r1", "c3")).toBe("10");
    expect(rows(land([del], [edit]).state)).not.toContain("r1");
  });

  it("moving a row the other deleted counts as editing it", () => {
    const r = land([{ kind: "delete", sheet: "S", axis: "row", ids: ["r1"] }], [{ kind: "move", sheet: "S", axis: "row", after: "r4", ids: ["r1"] }]);
    expect(r.ids).toEqual(["deleted S/row/r1 by theirs"]);
  });

  it("editing a cell in a column the other deleted: conflict", () => {
    expect(land([{ kind: "delete", sheet: "S", axis: "col", ids: ["c3"] }], [set("r1", "c3", "10")]).ids).toEqual(["deleted S/col/c3 by theirs"]);
  });

  it("both delete the same row: not a conflict", () => {
    const del: Op = { kind: "delete", sheet: "S", axis: "row", ids: ["r1"] };
    const r = land([del], [del]);
    expect(r.ids).toEqual([]);
    expect(r.ops).toEqual([]);
  });

  it("both insert after the same anchor: no conflict, the earlier-landed side goes first", () => {
    const ins = (after: string, ids: string[]): Op => ({ kind: "insert", sheet: "S", axis: "row", after, ids });
    const r = land([ins("r1", ["t1", "t2"]), ins("t2", ["t3"])], [ins("r1", ["m1"]), ins("m1", ["m2"])]);
    expect(r.ids).toEqual([]);
    expect(rows(r.state)).toEqual(["r1", "t1", "t2", "t3", "m1", "m2", "r2", "r3", "r4"]);
  });

  it("inserting after a row the other deleted: no conflict, the tombstone still anchors it", () => {
    const r = land([{ kind: "delete", sheet: "S", axis: "row", ids: ["r2"] }], [{ kind: "insert", sheet: "S", axis: "row", after: "r2", ids: ["m1"] }]);
    expect(r.ids).toEqual([]);
    expect(rows(r.state)).toEqual(["r1", "m1", "r3", "r4"]);
  });

  it("inserting after a row the other moved: no conflict, the rows stay put", () => {
    const r = land([{ kind: "move", sheet: "S", axis: "row", after: "r4", ids: ["r2"] }], [{ kind: "insert", sheet: "S", axis: "row", after: "r2", ids: ["m1"] }]);
    expect(r.ids).toEqual([]);
    expect(rows(r.state)).toEqual(["r1", "m1", "r3", "r4", "r2"]);
  });

  it("columns inserted concurrently never land before A and B", () => {
    const r = land([{ kind: "insert", sheet: "S", axis: "col", after: B, ids: ["tc"] }], [{ kind: "insert", sheet: "S", axis: "col", after: B, ids: ["mc"] }]);
    expect(r.state.sheets.get("S")!.cols.order).toEqual([A, B, "tc", "mc", "c1", "c2", "c3"]);
  });

  it("valid alone but invalid together (duplicate ID): not a conflict, left to validation", () => {
    const ins = (id: string): Op[] => [{ kind: "insert", sheet: "S", axis: "row", after: "r4", ids: [id] }, set(id, B, "spear")];
    const r = land(ins("t1"), ins("m1"));
    expect(r.ids).toEqual([]);
    expect([cell(r.state, "t1", B), cell(r.state, "m1", B)]).toEqual(["spear", "spear"]);
  });

  it("formatting the same cell: last write wins, no conflict", () => {
    const fmt = (bold: boolean): Op => ({ kind: "setFormat", sheet: "S", row: "r1", col: "c1", format: { bold } });
    const r = land([fmt(true)], [fmt(false)]);
    expect(r.ids).toEqual([]);
    expect(r.state.sheets.get("S")!.formats.get("r1|c1")).toEqual({ bold: false });
  });

  it("both move the same row to different places: conflict; to the same place: not", () => {
    const mv = (after: string): Op => ({ kind: "move", sheet: "S", axis: "row", after, ids: ["r1"] });
    expect(land([mv("r3")], [mv("r4")]).ids).toEqual(["move S/row/r1"]);
    expect(land([mv("r3")], [mv("r3")]).ids).toEqual([]);
  });
});

describe("sheets, packs and layouts", () => {
  it("renames are last-write-wins", () => {
    const r = land([{ kind: "renameSheet", sheet: "S", name: "Guns" }], [{ kind: "renameSheet", sheet: "S", name: "Weapons" }]);
    expect(r.ids).toEqual([]);
    expect(r.state.sheets.get("S")!.name).toBe("Weapons");
  });

  it("an op that no longer applies is dropped and reported", () => {
    const create = (id: string): Op => ({ kind: "createSheet", sheet: id, name: "Notes", pack: "root", sheetKind: "scratch" });
    const r = land([create("sx")], [create("sy"), { kind: "insert", sheet: "sy", axis: "row", after: null, ids: ["y1"] }]);
    expect(r.conflicts).toMatchObject([{ kind: "op", op: create("sy"), message: expect.stringMatching(/already a sheet called Notes/) }]);
    expect([...r.state.sheets.keys()]).toEqual(["S", "T", "sx"]);
  });
});

describe("revert", () => {
  it("a commit's inverse rebases over later commits and removes only its own change", () => {
    const b = base();
    const c1: Op[] = [{ kind: "insert", sheet: "S", axis: "row", after: "r1", ids: ["n1"] }, set("n1", B, "spear"), set("r2", "c3", "5")];
    const s1 = cloneDoc(b);
    const inverse = applyOps(s1, c1);
    const c2: Op[] = [set("r3", "c3", "7"), { kind: "insert", sheet: "S", axis: "row", after: "n1", ids: ["n2"] }];
    const r = rebase(s1, c2, inverse);
    expect(r.conflicts).toEqual([]);
    expect(rows(r.state)).toEqual(["r1", "n2", "r2", "r3", "r4"]); // n2 survives, anchored where n1 was
    expect([cell(r.state, "r2", "c3"), cell(r.state, "r3", "c3")]).toEqual(["", "7"]);
  });
});

describe("two tasks on KRBSG", () => {
  const fixture = (f: string) => readFileSync(new URL(`../../fixtures/krbsg/${f}`, import.meta.url), "utf8");

  it("each adds a weapon and edits through the project API; the second rebases onto the first and validates", () => {
    const start = loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;
    const base = cloneDoc(start.doc);
    const task = (salt: string) => {
      const p = Project.fromDoc(cloneDoc(base));
      p.wb.idSalt = salt; // concurrent writers never mint the same row ID
      return p;
    };
    const t = task("t"), m = task("m");
    const weapons = t.sheetId("Weapons");
    const theirs = [
      t.setRows(weapons, [["Weapon", "Laser", '["BlasterBolt"]', "laser.lua", "0.2", "3"]], 3),
      t.set(t.sheetId("Sprites"), "E2", "48"),
    ].flatMap((e) => e.ops);
    const mine = [
      m.setRows(weapons, [["Weapon", "Cannon", '["BlasterBolt"]', "cannon.lua", "1", "10"]], 3),
      m.renameId("BlasterBolt", "Pellet"),
      m.set(m.sheetId("Sprites"), "F2", "48"),
    ].flatMap((e) => e.ops);

    const r = rebase(base, theirs, mine);
    expect(r.conflicts).toEqual([]);
    const head = Project.fromDoc(r.state);
    expect(validate(head).issues).toEqual([]);
    const root = JSON.parse(exportJson(head).find((f) => f.path === "root.json")!.content);
    expect(Object.keys(root.types.Weapon)).toEqual(["Blaster", "Cannon", "Laser"]);
    // Mine's rename was re-run on the head, so it reached theirs' new weapon too.
    expect(root.types.Weapon.Laser.projectiles).toEqual([{ type: "Projectile", id: "Pellet" }]);
    expect(root.types.Sprite.spr_ship).toMatchObject({ width: 48, height: 48 });
    // Both rows were appended after row 2: theirs landed first, so it comes first.
    expect([head.engine.get(weapons, "B3"), head.engine.get(weapons, "B4")]).toEqual(["Laser", "Cannon"]);
  });
});

void emptyDoc;
