// Deleting and ordering sheets and packs: undo brings back exactly what was there, formulas
// that read a sheet stop its deletion, and a rebase settles a sheet one side deleted and the
// other changed as a conflict.

import { describe, expect, it } from "vitest";
import { canonDoc, cloneDoc, type Doc } from "../ops/doc.ts";
import { checkOps } from "../ops/check.ts";
import { reconcile } from "../ops/reconcile.ts";
import { rebase, type Conflict } from "../ops/rebase.ts";
import { ApiError, Sapwood } from "./sapwood.ts";

const SCHEMA = `
types:
  Ammo: { fields: { speed: float } }
  Gun: { fields: { ammo: "ref<Ammo>", dps: float } }
`;
const load = () =>
  Sapwood.load(SCHEMA, {
    packs: [{ name: "dlc" }, { name: "extra", parent: "dlc" }],
    sheets: [
      { name: "Ammo", rows: [["Ammo", "a1", 900], ["Ammo", "a2", 600], ["# a note"]] },
      { name: "Guns", rows: [["Gun", "g1", "a1", "=2*3"], ["Gun", "g2", "a2", 5]] },
      { name: "Notes", kind: "scratch", rows: [["anything", 1]] },
      { name: "DLC Ammo", pack: "dlc", rows: [["Ammo", "d1", 50]] },
      { name: "Extra", pack: "extra", rows: [["Ammo", "x1", 7]] },
    ],
  });
const names = (s: Sapwood, pack = "root") => [...s.project.wb.sheets.values()].filter((x) => x.pack === s.project.wb.packs.get(pack)?.id || s.project.wb.packName(x.pack) === pack).map((x) => x.name);
const fails = (code: string, fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe(code);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("deleting a sheet", () => {
  it("takes everything on it; undo brings it all back, in its place", () => {
    const s = load();
    // Some of everything: a format, a commented-out row, a flag, a deleted row, a layout.
    const ammo = s.project.sheetId("Ammo");
    s.project.wb.sheet(ammo);
    s.set("a1", { $keepHere: true });
    s.commentOut("a2");
    const before = canonDoc(cloneDoc(s.project.doc));
    const ref = s.validate().issues.length;
    s.deleteSheet("Ammo");
    expect(names(s)).toEqual(["Guns", "Notes"]);
    expect(() => s.get("a1")).toThrow();
    // Guns refer to the ammo that's gone.
    expect(s.validate().issues.length).toBeGreaterThan(ref);
    s.undo();
    expect(canonDoc(s.project.doc)).toEqual(before);
    expect(names(s)).toEqual(["Ammo", "Guns", "Notes"]);
    expect(s.get("a1")).toMatchObject({ speed: 900 });
    expect(s.validate().issues.length).toBe(ref);
    s.redo();
    expect(names(s)).toEqual(["Guns", "Notes"]);
  });

  it("is refused while formulas on other sheets read it, naming them", () => {
    const s = load();
    s.set("g2", { dps: { $formula: "=Ammo!C1/100" } });
    expect(fails("in-use", () => s.deleteSheet("Ammo"))).toMatch(/Guns!D2/);
    // A formula on the sheet itself is no obstacle; nor one reading a sheet that stays.
    expect(() => s.deleteSheet("Guns")).not.toThrow();
  });

  it("a scratch sheet too; the ops survive being stored as JSON", () => {
    const s = load();
    const c = s.deleteSheet("Notes");
    const back = checkOps(JSON.parse(JSON.stringify(c.inverse)));
    expect(back).toEqual(c.inverse);
    s.project.apply(back);
    expect(names(s)).toEqual(["Ammo", "Guns", "Notes"]);
  });
});

describe("deleting a pack", () => {
  it("takes its sheets and packs; undo brings them back", () => {
    const s = load();
    const before = canonDoc(cloneDoc(s.project.doc));
    s.deletePack("dlc");
    expect([...s.project.wb.packs.values()].map((p) => p.name)).toEqual(["root"]);
    expect(() => s.get("x1")).toThrow();
    s.undo();
    expect(canonDoc(s.project.doc)).toEqual(before);
    expect(s.get("x1")).toMatchObject({ $pack: "extra", speed: 7 });
    fails("bad-value", () => s.deletePack("root"));
  });

  it("formulas inside it go with it (outside it, none can read it: packs read only up the tree)", () => {
    const s = load();
    s.set("x1", { speed: { $formula: "='DLC Ammo'!C1*2" } });
    expect(s.get("x1").speed).toMatchObject({ $value: 100 });
    expect(() => s.deletePack("dlc")).not.toThrow();
    // A sheet read from a pack below it can't be deleted on its own, though.
    s.undo();
    expect(fails("in-use", () => s.deleteSheet("DLC Ammo"))).toMatch(/Extra!C1/);
  });
});

describe("ordering sheets and packs", () => {
  it("puts a sheet after another of its pack, or first; undo puts it back", () => {
    const s = load();
    s.orderSheet("Ammo", "Notes");
    expect(names(s)).toEqual(["Guns", "Notes", "Ammo"]);
    s.orderSheet("Notes", null);
    expect(names(s)).toEqual(["Notes", "Guns", "Ammo"]);
    s.undo();
    s.undo();
    expect(names(s)).toEqual(["Ammo", "Guns", "Notes"]);
    expect(s.orderSheet("Ammo", null).ops).toEqual([]); // first already
    fails("not-found", () => s.orderSheet("Ammo", "DLC Ammo")); // another pack's
  });

  it("puts a pack after another with the same parent", () => {
    const s = load();
    s.createPack("season");
    const packs = () => [...s.project.wb.packs.values()].filter((p) => p.parent === s.project.wb.root).map((p) => p.name);
    expect(packs()).toEqual(["dlc", "season"]);
    s.orderPack("season", null);
    expect(packs()).toEqual(["season", "dlc"]);
    fails("bad-value", () => s.orderPack("extra", "season"));
    s.undo();
    expect(packs()).toEqual(["dlc", "season"]);
    // The order is part of the document: a copy built from it keeps it.
    s.orderPack("season", null);
    expect([...Sapwood.fromDoc(cloneDoc(s.project.doc)).project.wb.packs.values()].filter((p) => p.parent === "root").map((p) => p.name)).toEqual(["season", "dlc"]);
  });

  it("reconcile puts two documents' sheets and packs in the same order", () => {
    const a = load();
    const b = Sapwood.fromDoc(cloneDoc(a.project.doc));
    b.orderSheet("Ammo", "Notes");
    b.createPack("season");
    a.createPack("season");
    a.orderPack("season", null);
    const ops = reconcile(a.project.doc, b.project.doc)!;
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.kind === "orderPack" || o.kind === "orderSheet")).toBe(true);
    a.project.apply(ops);
    expect(canonDoc(a.project.doc)).toEqual(canonDoc(b.project.doc));
  });
});

describe("a sheet deleted on one side and changed on the other", () => {
  /** Both sides from one base: theirs lands first; mine is rebased onto it. */
  const sides = (theirs: (s: Sapwood) => void, mine: (s: Sapwood) => void) => {
    const base = load().project.doc;
    const run = (f: (s: Sapwood) => void) => {
      const s = Sapwood.fromDoc(cloneDoc(base));
      const done = s.project.doc;
      const ops: import("../ops/ops.ts").Op[] = [];
      const orig = s.project.apply.bind(s.project);
      s.project.apply = (o) => (ops.push(...o), orig(o));
      f(s);
      void done;
      return ops;
    };
    return { base, theirs: run(theirs), mine: run(mine) };
  };
  const after = (base: Doc, theirs: import("../ops/ops.ts").Op[], mine: import("../ops/ops.ts").Op[], pick: (c: Conflict) => "mine" | "theirs") => {
    const r = rebase(base, theirs, mine, pick);
    return { r, s: Sapwood.fromDoc(cloneDoc(r.state)) };
  };

  it("deleted on the branch, changed by me: a conflict; theirs drops my change, mine brings the sheet back with it", () => {
    const { base, theirs, mine } = sides((s) => s.deleteSheet("Ammo"), (s) => s.set("a1", { speed: 1000 }));
    const seen: Conflict[] = [];
    const t = after(base, theirs, mine, (c) => (seen.push(c), "theirs"));
    expect(seen).toEqual([{ kind: "sheetDeleted", sheet: expect.any(String), name: "Ammo", deletedBy: "theirs" }]);
    expect(names(t.s)).toEqual(["Guns", "Notes"]);
    expect(t.r.conflicts.filter((c) => c.kind === "op")).toEqual([]);
    const m = after(base, theirs, mine, () => "mine");
    expect(names(m.s)).toEqual(["Ammo", "Guns", "Notes"]);
    expect(m.s.get("a1")).toMatchObject({ speed: 1000 });
    expect(m.s.get("a2")).toMatchObject({ speed: 600 });
  });

  it("deleted by me, changed on the branch: a conflict; theirs keeps the sheet with their change, mine deletes it", () => {
    const { base, theirs, mine } = sides((s) => s.set("a2", { speed: 1 }), (s) => s.deleteSheet("Ammo"));
    const t = after(base, theirs, mine, () => "theirs");
    expect(t.r.conflicts.map((c) => c.kind)).toEqual(["sheetDeleted"]);
    expect(t.s.get("a2")).toMatchObject({ speed: 1 });
    const m = after(base, theirs, mine, () => "mine");
    expect(names(m.s)).toEqual(["Guns", "Notes"]);
  });

  it("no conflict when the other side didn't change it, or deleted it too", () => {
    const one = sides((s) => s.set("g2", { dps: 9 }), (s) => s.deleteSheet("Ammo"));
    expect(after(one.base, one.theirs, one.mine, () => "theirs").r.conflicts).toEqual([]);
    const both = sides((s) => s.deleteSheet("Ammo"), (s) => s.deleteSheet("Ammo"));
    const b = after(both.base, both.theirs, both.mine, () => "theirs");
    expect(b.r.conflicts).toEqual([]);
    expect(names(b.s)).toEqual(["Guns", "Notes"]);
  });

  it("a formula the branch added that reads a sheet I deleted shows #REF!, not a crash", () => {
    const { base, theirs, mine } = sides((s) => s.set("g2", { dps: { $formula: "=Ammo!C1" } }), (s) => s.deleteSheet("Ammo"));
    const m = after(base, theirs, mine, () => "mine");
    expect(names(m.s)).toEqual(["Guns", "Notes"]);
    expect(m.s.get("g2").dps).toMatchObject({ $formula: "=#REF!" });
  });

  it("ordered differently on each side: the one landing last wins, without a conflict", () => {
    const { base, theirs, mine } = sides((s) => s.orderSheet("Ammo", "Guns"), (s) => s.orderSheet("Ammo", "Notes"));
    const r = after(base, theirs, mine, () => "theirs");
    expect(r.r.conflicts).toEqual([]);
    expect(names(r.s)).toEqual(["Guns", "Notes", "Ammo"]);
  });
});

describe("the schema's order", () => {
  const base = () => load().project.doc;
  const run = (doc: import("../ops/doc.ts").Doc, f: (s: Sapwood) => void) => {
    const s = Sapwood.fromDoc(cloneDoc(doc));
    const ops: import("../ops/ops.ts").Op[] = [];
    const orig = s.project.apply.bind(s.project);
    s.project.apply = (o) => (ops.push(...o), orig(o));
    f(s);
    return ops;
  };
  const typeNames = (d: import("../ops/doc.ts").Doc) => d.schema.types.map((t) => t.name);
  /** The schema's YAML with the Gun type moved above Ammo. */
  const gunFirst = (s: Sapwood) => {
    const y = s.schemaYaml();
    const i = y.indexOf("  Ammo:");
    const j = y.indexOf("  Gun:");
    return y.slice(0, i) + y.slice(j) + y.slice(i, j);
  };

  it("a reorder in the YAML is a moveSchema op; undo puts it back", () => {
    const s = load();
    const c = s.applySchema(gunFirst(s));
    expect(c.ops.filter((o) => o.kind === "moveSchema")).toHaveLength(1);
    expect(typeNames(s.project.doc)).toEqual(["Gun", "Ammo"]);
    expect(s.get("g1")).toMatchObject({ ammo: "a1" });
    s.undo();
    expect(typeNames(s.project.doc)).toEqual(["Ammo", "Gun"]);
  });

  it("moved on one side, changed on the other: both kept; moved differently: the later one wins", () => {
    const b = base();
    const theirs = run(b, (s) => s.applySchema(s.schemaYaml().replace("dps: { id: f", "dps: { min: 0, id: f")));
    const mine = run(b, (s) => s.applySchema(gunFirst(s)));
    const r = rebase(b, theirs, mine, () => "theirs");
    expect(r.conflicts).toEqual([]);
    expect(typeNames(r.state)).toEqual(["Gun", "Ammo"]);
    // Both moved it: mine lands later and wins.
    const back = run(b, (s) => {
      s.applySchema(gunFirst(s));
      s.applySchema(s.schemaYaml().replace(/(  Gun:[\s\S]*?)(  Ammo:[\s\S]*?)(\n\n|$)/, "$2$1$3"));
    });
    expect(typeNames(rebase(b, mine, back, () => "theirs").state)).toEqual(["Ammo", "Gun"]);
  });

  it("reconcile puts two schemas' nodes in the same order", () => {
    const a = load();
    const b = Sapwood.fromDoc(cloneDoc(a.project.doc));
    b.applySchema(gunFirst(b));
    const ops = reconcile(a.project.doc, b.project.doc)!;
    expect(ops.map((o) => o.kind)).toContain("moveSchema");
    a.project.apply(ops);
    expect(canonDoc(a.project.doc)).toEqual(canonDoc(b.project.doc));
  });
});
